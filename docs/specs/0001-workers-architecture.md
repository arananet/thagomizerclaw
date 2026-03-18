# Spec 0001 — Cloudflare Workers Architecture

## Status
✅ Approved / ✅ Implemented — commit `0091155`

## Problem

The original NanoClaw runs as a single Node.js process on a user's Mac or VPS, using Docker containers for agent isolation. This works for personal use but has enterprise-grade limitations:

- Requires always-on server infrastructure
- Secrets live in `.env` files on disk
- No global distribution — single region
- No built-in scaling — one process handles everything
- Container startup is 2–5 seconds per agent invocation
- Cold start recovery requires manual intervention

ThagomizerClaw must be deployable as an enterprise system: globally distributed, zero-infrastructure-management, secrets never touching a developer machine, and autoscaling by default.

## Constraints

- MUST run entirely within Cloudflare's infrastructure (no external VPS required)
- MUST NOT require any server management from the user after initial deployment
- MUST keep secrets out of code, git history, and environment files
- MUST be deployable with `wrangler deploy` from any machine with `wrangler login`
- MUST respond to webhooks in under 3 seconds (platform requirement for Discord, Slack)
- MUST preserve the core domain model: groups, sessions, messages, scheduled tasks
- MUST support the same channel abstractions as the Node.js implementation

## Behavior Specification

### Worker Entry Point

The Worker MUST handle four event types:

1. **`fetch`** — HTTP requests (webhooks + admin API)
2. **`queue`** — Queue consumer (async message processing)
3. **`scheduled`** — Cron triggers (due task execution + cleanup)

### Webhook Handling

For each registered channel, the Worker MUST:
1. Verify the request's authenticity cryptographically before any processing
2. Parse the request into a normalized `NewMessage`
3. Store the message in D1 (`storeMessage()`)
4. Enqueue processing via `MESSAGE_QUEUE.send()` for async execution
5. Return an HTTP 200 response within the platform's timeout (≤3s)

The Worker MUST NOT invoke the agent synchronously in the fetch handler.

### Queue Consumer

The queue consumer MUST:
1. Retrieve the registered group configuration from D1
2. Load pending messages since the last processed cursor
3. Check if the message set should trigger the agent (trigger pattern, group config)
4. Invoke the agent via the Anthropic API
5. Send the response via the appropriate channel API
6. Update the cursor and session ID in KV and D1

On agent failure, the consumer MUST roll back the cursor and retry (Cloudflare handles retries up to `max_retries` in wrangler.toml).

### Cron Triggers

The `* * * * *` cron MUST:
1. Query D1 for scheduled tasks where `status = 'active'` and `next_run <= NOW()`
2. Enqueue each due task as a `scheduled_task` queue message
3. Update `next_run` for interval/cron tasks, or set `status = 'completed'` for once tasks

### Admin API

All admin endpoints MUST require `Authorization: Bearer {WEBHOOK_SECRET}`.

The health endpoint (`GET /admin/health`) MUST return the D1 connectivity status, not just HTTP 200.

## Interface Contract

### Env Bindings (TypeScript)

```typescript
interface Env {
  DB: D1Database;           // D1 — primary data store
  STORAGE: R2Bucket;        // R2 — file storage (CLAUDE.md, logs)
  STATE: KVNamespace;       // KV — hot state (cursors, sessions)
  MESSAGE_QUEUE: Queue;     // Cloudflare Queue — async processing
  AI: Ai;                   // Workers AI — fallback inference
  GROUP_SESSION: DurableObjectNamespace;  // per-group state
  RATE_LIMITER: DurableObjectNamespace;   // rate limiting

  // Non-secret vars (wrangler.toml [vars])
  ASSISTANT_NAME: string;
  ENVIRONMENT: string;

  // Secrets (wrangler secret put)
  ANTHROPIC_API_KEY: string;
  WEBHOOK_SECRET: string;
  TELEGRAM_BOT_TOKEN?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_PUBLIC_KEY?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
}
```

### Worker Export

```typescript
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
  queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void>;
  scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void>;
} satisfies ExportedHandler<Env>;
```

### Queue Message Types

```typescript
type QueueMessage =
  | { type: 'inbound_message'; chatJid: string; messages: NewMessage[]; timestamp: string }
  | { type: 'scheduled_task'; taskId: string; groupFolder: string; chatJid: string; prompt: string };
```

## Security Considerations

### Webhook Authentication
Every channel MUST have cryptographic request verification. No channel MAY process an unverified request. The verification functions MUST be called before any parsing or database access.

### Secret Injection
Secrets MUST flow: `Cloudflare Secrets Store → Worker env bindings → API calls`. They MUST NOT flow through: git, `.env` files, logs, error messages, or user-visible responses.

### Admin API Authorization
The admin API MUST check `Authorization: Bearer {WEBHOOK_SECRET}` on every request. There is no session mechanism; each request is independently authenticated.

### Queue Message Trust
Queue messages are produced internally by the Worker. They MUST NOT be trusted if produced externally. The `WEBHOOK_SECRET` is not used to authenticate queue messages; Cloudflare's queue infrastructure is the trust boundary.

## Test Cases

1. **Happy path**: POST `/webhook/telegram/{WEBHOOK_SECRET}` with valid update → 200, message stored in D1, job in queue
2. **Invalid webhook secret**: POST `/webhook/telegram/wrong-secret` → 401
3. **Discord PING**: POST `/webhook/discord` with `type: 1` → `{"type": 1}` (PONG)
4. **Queue processing**: Queue message → agent called → response sent → cursor updated
5. **Admin unauthorized**: GET `/admin/groups` without auth header → 401
6. **Admin authorized**: GET `/admin/groups` with correct Bearer → 200 with group list
7. **Cron due task**: D1 has active task with `next_run` in the past → task enqueued → `next_run` updated
8. **Unknown route**: GET `/foo` → 404

## Open Questions

None — implemented.

## Implementation Notes

File: `worker/src/index.ts`
Config: `wrangler.toml`
