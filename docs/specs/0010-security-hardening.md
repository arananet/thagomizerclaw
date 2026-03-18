# Spec 0010 — Security Hardening

## Status
✅ Approved / ✅ Implemented — this branch

## Problem

The initial Cloudflare Workers implementation (Spec 0001) established the core security model
(cryptographic webhook auth, Cloudflare Secrets, per-group isolation). However, a security review
identified four gaps between the stated security posture and the actual runtime behavior:

1. **RateLimiterDO was wired but never called.** The Durable Object and binding were configured,
   but no webhook handler invoked it. Any group could flood the worker with unlimited messages,
   exhausting queue capacity and incurring unbounded Claude API costs.

2. **`AGENT_TIMEOUT_MS` was declared but not enforced.** The environment variable was documented
   and wired into `Env`, but no `AbortSignal` was passed to the Anthropic API `fetch()` call. A
   slow or hung response would hold a queue slot indefinitely (up to Cloudflare's 30s CPU limit).

3. **`WEBHOOK_SECRET` served dual purposes.** The same secret was used as the Telegram webhook URL
   path token *and* the admin API Bearer token. Discovering the webhook URL (e.g., from logs or
   a network intercept) implicitly granted admin API access — violating the Zero Trust principle
   of distinct credentials per trust boundary.

4. **Security response headers were absent.** No `X-Content-Type-Options`, `X-Frame-Options`,
   `Cache-Control`, or related headers were set, leaving room for MIME sniffing, framing, and
   response caching by intermediaries.

5. **Request body size was unbounded.** Webhook handlers read bodies with no size guard. An
   attacker could POST multi-megabyte payloads to consume CPU and memory.

6. **`calculateNextCronRun` was a stub.** The function always returned "next minute" regardless
   of the cron expression, causing all cron-type tasks to fire every minute.

---

## Constraints

- Rate limiting MUST fail open (DO errors must not block legitimate traffic).
- Timeout enforcement MUST apply to all Claude API calls, using `AGENT_TIMEOUT_MS`.
- `ADMIN_SECRET` is optional. If unset, system falls back to `WEBHOOK_SECRET` for backward
  compatibility during migration. Operators SHOULD set `ADMIN_SECRET` explicitly.
- Security headers MUST be applied to every response, including 4xx/5xx.
- Body size guard uses `Content-Length` as a fast-path; Cloudflare's runtime provides an
  additional platform-level cap.
- Cron parser MUST support: `*`, `N`, `N-M`, `N,M,P`, `*/N` per field.

---

## Behavior Specification

### Rate Limiting

Every inbound message webhook (Telegram, Discord, Slack) MUST check the `RateLimiterDO` after
signature verification and body parsing, but before D1 writes or queue enqueuing.

Rate limit parameters (defaults, may be adjusted per deploy):
- **Limit**: 20 messages per group per minute
- **Window**: 60 000 ms (sliding)
- **Key**: `chatJid` (per-group, not per-sender)

On rate limit exceeded:
- Telegram: return HTTP 429
- Discord: return HTTP 200 with `{ type: 4, data: { content: "Rate limit exceeded…", flags: 64 } }`
  (Discord requires a response within 3s; HTTP 429 would cause Discord to retry)
- Slack: return HTTP 429

On `RateLimiterDO` error (network, restart): **fail open** — allow the request.

### Agent Timeout

`callClaudeAPI()` MUST pass `AbortSignal.timeout(timeoutMs)` to `fetch()`.

`timeoutMs` resolves in priority order:
1. `input.agentConfig.timeout` (per-group override)
2. `parseInt(env.AGENT_TIMEOUT_MS, 10)` (global env var)
3. 120 000 ms (hard-coded fallback)

On timeout, the fetch throws `AbortError`. The caller's catch block triggers the Workers AI
fallback (if configured) or returns `status: 'error'` to roll back the cursor.

### Admin Secret Separation (Zero Trust)

`requireAuth()` MUST resolve the admin credential in order:
1. `env.ADMIN_SECRET` if set (dedicated admin secret — preferred)
2. `env.WEBHOOK_SECRET` as fallback (backward compatibility only)

Operators MUST set `ADMIN_SECRET` as a separate Cloudflare Secret:
```bash
wrangler secret put ADMIN_SECRET
```

This separates the Telegram webhook trust boundary from the admin API trust boundary. A leaked
Telegram webhook URL no longer grants admin access.

### Security Response Headers

Every HTTP response MUST include:

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Content-Type-Options` | `nosniff` | Prevent MIME sniffing |
| `X-Frame-Options` | `DENY` | Prevent clickjacking |
| `Referrer-Policy` | `no-referrer` | No referrer leakage |
| `Cache-Control` | `no-store` | No proxy/browser caching |
| `Permissions-Policy` | `""` | Disable browser feature APIs |
| `Cross-Origin-Resource-Policy` | `same-origin` | No cross-origin read |

These are applied via a single `applySecurityHeaders(headers)` helper called from all response
factory functions (`json()`, `secureResponse()`, etc.).

### Request Body Size Limit

All handlers that read a request body MUST call `isBodyTooLarge(request)` before reading.

If `Content-Length > MAX_BODY_BYTES (1 048 576)`: return HTTP 413 immediately.

### Cron Expression Evaluation

`calculateNextCronRun(expr)` MUST compute the actual next UTC time that satisfies the expression.

Supported field syntax (per field: minute, hour, day-of-month, month, day-of-week):
- `*` — any value
- `N` — exact match (e.g., `5`)
- `N-M` — inclusive range (e.g., `1-5`)
- `N,M,P` — enumerated values (e.g., `1,15,30`)
- `*/N` — every N units (e.g., `*/5`)

Search strategy: iterate minute-by-minute from `now + 1m`, up to 10 080 minutes (1 week).
Return the first minute satisfying all five fields.

If no match found in 1 week (malformed expression): return `now + 1m` as safe fallback.

### Public Health Endpoint

`GET /` and `GET /health` MUST NOT expose version information (removed `version: '1.0.0'`
to avoid fingerprinting). Detailed health (including DB status) remains at `GET /admin/health`
(requires Bearer auth).

---

## Interface Contract

### New / Changed Types (`types.ts`)

```typescript
interface Env {
  // ... existing fields ...

  /**
   * Optional dedicated admin API secret (Zero Trust: separate from WEBHOOK_SECRET).
   * Set via: wrangler secret put ADMIN_SECRET
   * Falls back to WEBHOOK_SECRET if not set.
   */
  ADMIN_SECRET?: string;
}
```

### New Functions (`index.ts`)

```typescript
// Apply security headers to any Response
function applySecurityHeaders(headers: Headers): Headers;

// Wrap body + init with security headers applied
function secureResponse(body: string | null, init: ResponseInit): Response;

// Fast-path body size check from Content-Length header
function isBodyTooLarge(request: Request): boolean;

// Per-group rate limit check via RateLimiterDO (fails open)
async function checkRateLimit(chatJid: string, env: Env): Promise<{ allowed: boolean }>;

// Compute next UTC run time for a 5-field cron expression
function calculateNextCronRun(cronExpr: string): string;

// Test a single cron field token against a numeric value
function matchesCronField(value: number, field: string): boolean;
```

### Changed Behavior (`agent.ts`)

`callClaudeAPI()` now accepts a `timeoutMs: number` parameter and passes
`AbortSignal.timeout(timeoutMs)` to `fetch()`.

---

## Security Considerations

### Rate Limit Bypass

`checkRateLimit` fails open. An attacker who can trigger RateLimiterDO failures (e.g., by
exhausting DO storage or deliberately causing errors) could bypass rate limiting. This is an
acceptable trade-off: availability > rate limiting. Real cost controls MUST also be implemented
at the Anthropic API account level (usage limits in the Anthropic console).

### Content-Length Spoofing

`isBodyTooLarge` checks `Content-Length`. A client can omit or lie about this header. The check
is a fast-path defence (reject obvious abuse early), not a guarantee. The Worker runtime
provides a platform-level limit. For production hardening, consider using `request.arrayBuffer()`
with a size check after reading.

### Timing Attacks on Admin Auth

`requireAuth` uses string equality (`===`). JavaScript's `===` on strings is not guaranteed
constant-time. Admin secrets are long random strings; timing oracle attacks require many
thousands of requests and sub-millisecond measurement capability, making them impractical
in this deployment. If required, replace with `crypto.subtle.timingSafeEqual`.

### ADMIN_SECRET Fallback

The fallback to `WEBHOOK_SECRET` is a migration convenience. Operators MUST configure
`ADMIN_SECRET` in production to achieve the Zero Trust separation this spec requires.
A future spec may remove the fallback and make `ADMIN_SECRET` required.

---

## Test Cases

1. **Rate limit enforced**: send 21 Telegram messages from the same group in <60s →
   21st returns 429
2. **Rate limit resets**: after 60s window expires, messages are processed again
3. **Agent timeout**: mock Anthropic API to hang; after `AGENT_TIMEOUT_MS`, agent returns
   `status: 'error'`, cursor rolled back
4. **ADMIN_SECRET separate**: set `ADMIN_SECRET=X`, set `WEBHOOK_SECRET=Y`;
   `Authorization: Bearer Y` → 401; `Authorization: Bearer X` → 200
5. **ADMIN_SECRET fallback**: unset `ADMIN_SECRET`; `Authorization: Bearer {WEBHOOK_SECRET}` → 200
6. **Security headers**: any response → headers include `X-Content-Type-Options: nosniff`
7. **Body size limit**: POST 2MB body to `/webhook/telegram/...` → 413
8. **Cron parser — exact**: `30 9 * * 1` (Mon 09:30) → next Monday at 09:30 UTC
9. **Cron parser — step**: `*/15 * * * *` (every 15 min) → next :00, :15, :30, or :45
10. **Public health — no version**: `GET /health` → no `version` field in response

---

## Open Questions

None.
