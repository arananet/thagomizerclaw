# Spec 0009 — Secrets Management Policy

## Status
✅ Approved / ✅ Implemented — commit `0091155`

## Problem

API keys, bot tokens, and signing secrets are the most sensitive data in ThagomizerClaw. They grant full access to external services (Claude API, Telegram, Discord, Slack). A leaked secret means:
- Attackers can impersonate the assistant
- Unlimited API cost accrual
- Message content exposure

Traditional approaches (`.env` files, environment variables on VPS, CI/CD secrets) all have failure modes where secrets touch developer machines, git history, or server filesystems. ThagomizerClaw's enterprise posture requires a provably stronger model.

## Constraints

- Secrets MUST NEVER appear in: source code, git history, `.env` files checked into git, `wrangler.toml`, logs, error messages, HTTP responses
- Secrets MUST be managed exclusively via `wrangler secret put` (Cloudflare Secrets Store)
- Local development MUST use `.dev.vars` (gitignored) — never the production secret store
- The `.dev.vars.example` template MUST contain only placeholder values, never real secrets
- Secret rotation MUST be possible without code changes or redeployment

## Behavior Specification

### Secret Store

All secrets MUST be stored in Cloudflare Secrets Store, accessible only to:
1. The Cloudflare account owner (via dashboard or CLI)
2. The Worker at runtime via env bindings

Secrets MUST be encrypted at rest by Cloudflare. ThagomizerClaw has no responsibility for the encryption — it is provided by the platform.

### Secret Access Pattern

Secrets MUST be accessed only via `env.*` bindings in Worker handlers:

```typescript
// ✅ Correct
const response = await callClaudeAPI(env.ANTHROPIC_API_KEY, request);

// ❌ Wrong — never read from process.env, files, or external sources
const key = process.env.ANTHROPIC_API_KEY;
const key = fs.readFileSync('.env');
```

### Secret Logging Policy

Secrets MUST NEVER be logged, even partially (first N chars, last N chars, hash). If a secret must be referenced in a log, use a placeholder:

```typescript
// ✅ Correct
console.log(`Using API key: [REDACTED]`);

// ❌ Wrong
console.log(`Using API key: ${env.ANTHROPIC_API_KEY.slice(0, 8)}...`);
```

### Secret Rotation

Rotating a secret MUST NOT require:
- Code changes
- Redeployment
- Worker restart

Running `wrangler secret put ANTHROPIC_API_KEY` (then entering the new value) MUST be sufficient. The new value takes effect on the next Worker invocation.

### Local Development

For `wrangler dev`, secrets go in `.dev.vars` (gitignored). The `.gitignore` MUST contain:

```
.dev.vars
```

The `.dev.vars.example` file MUST be committed to git with placeholder values only. It serves as documentation of required secrets, not a template for real values.

### Secret Inventory

| Secret | Service | Minimum Permission Required |
|--------|---------|----------------------------|
| `ANTHROPIC_API_KEY` | Anthropic Claude API | Messages API (create) |
| `WEBHOOK_SECRET` | Internal | n/a — generated value |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API | Send/receive messages |
| `DISCORD_BOT_TOKEN` | Discord API | Send messages |
| `DISCORD_PUBLIC_KEY` | Discord (verification only) | Read-only |
| `SLACK_BOT_TOKEN` | Slack Web API | `chat:write`, `channels:read` |
| `SLACK_SIGNING_SECRET` | Slack (verification only) | Read-only |

### Principle of Least Privilege

Each secret SHOULD have the minimum permissions required. Where possible:
- Anthropic API key SHOULD be restricted to the Messages API
- Telegram token SHOULD be a dedicated bot (not a user account)
- Discord bot SHOULD have only the permissions required for message send/receive
- Slack bot SHOULD have scoped OAuth tokens (`chat:write`, not `admin`)

## Interface Contract

No code interface. This spec governs process and policy.

The `.dev.vars.example` file is the canonical reference for required secret names.

## Security Considerations

### Secret Exposure via Error Messages
Code MUST NOT include secret values in error messages. All API call wrappers MUST catch errors and re-throw with generic messages:

```typescript
// ✅ Correct
throw new Error(`Anthropic API error ${response.status}`);

// ❌ Wrong
throw new Error(`API call failed with key ${env.ANTHROPIC_API_KEY}`);
```

### Secret in Logs
All log statements that touch request/response data MUST be reviewed to ensure they cannot include secret values. Webhook bodies SHOULD be logged only at DEBUG level and MUST be scrubbed of Authorization headers.

### Secret Compromise Response
If a secret is believed compromised:
1. Run `wrangler secret put <NAME>` with a new value immediately
2. Rotate the secret at the source (Anthropic console, Telegram BotFather, etc.)
3. Review recent logs for unauthorized usage
4. File an incident report if external data may have been accessed

## Test Cases

1. **`.dev.vars` in gitignore**: `git check-ignore .dev.vars` → ignored
2. **No secrets in wrangler.toml**: `grep -i "sk-ant\|token\|secret" wrangler.toml` → no matches
3. **No secrets in source**: `grep -rn "sk-ant" worker/src/` → no matches
4. **`.dev.vars.example` has only placeholders**: all secret values are descriptive strings, not real keys
5. **Secret rotation**: update `WEBHOOK_SECRET`, verify admin API rejects old token on next request

## Open Questions

None — implemented.
