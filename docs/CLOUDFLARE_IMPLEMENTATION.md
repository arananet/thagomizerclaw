# ThagomizerClaw — Cloudflare Workers Implementation Guide

A step-by-step guide to understanding, running, extending, and debugging the Cloudflare Workers implementation.

*Eduardo Arana & Soda 🥤*

---

## Understanding the Codebase

### Entry Point: `worker/src/index.ts`

The Worker exports three handlers:

```typescript
export default {
  fetch(request, env, ctx)    // HTTP requests: webhooks + admin API
  queue(batch, env)           // Queue consumer: agent execution
  scheduled(event, env, ctx)  // Cron: scheduled tasks + cleanup
}
```

Everything flows through these three handlers. Start here when debugging.

### Request Lifecycle (Webhook)

Trace a Telegram message end-to-end:

```
1. Telegram POSTs to /webhook/telegram/{WEBHOOK_SECRET}
   └→ worker/src/index.ts: fetch() routes to handleTelegramWebhook()

2. verifyTelegramWebhook(pathSecret, env)
   └→ worker/src/channels/telegram.ts: compares path to WEBHOOK_SECRET
   └→ returns 401 if mismatch

3. parseTelegramWebhook(update)
   └→ worker/src/channels/telegram.ts: extracts text, sender, chatId
   └→ returns ParsedWebhookEvent { chatJid: "tg:123456", message: {...} }

4. storeChatMetadata(DB, chatJid, ...)    → D1 write
   storeMessage(DB, message, ...)         → D1 write

5. getAllRegisteredGroups(DB)             → D1 read
   if group found: MESSAGE_QUEUE.send()  → Queue write

6. return json({ ok: true })             → 200 to Telegram
```

### Request Lifecycle (Queue Consumer)

```
7. Cloudflare delivers queue message to queue() handler
   └→ handleQueueMessage(message, env)

8. getAllRegisteredGroups(DB)             → D1 read (find group config)

9. getCursor(KV, chatJid)               → KV read (last timestamp)
   getMessagesSince(DB, chatJid, ...)    → D1 read (pending messages)

10. shouldProcess(messages, group, assistantName)
    └→ worker/src/router.ts: checks trigger pattern

11. setCursor(KV, chatJid, newTimestamp) → KV write (advance cursor)

12. getGroupClaudeMd(STORAGE, folder)    → R2 read (CLAUDE.md)
    getSessionId(KV, folder)             → KV read (session ID)
    formatMessages(messages)             → XML string

13. runAgent({ prompt, sessionId, ... }, env)
    └→ worker/src/agent.ts
    └→ callClaudeAPI(env.ANTHROPIC_API_KEY, request)
    └→ or: callWorkersAI(env.AI, model, system, user)

14. setSessionId(KV, ...) + setSession(DB, ...) → persist session
    writeAgentLog(STORAGE, ...)                   → R2 write

15. sendTelegramMessage(chatId, result, env)      → Telegram Bot API
    └→ worker/src/channels/telegram.ts

16. message.ack()  (or message.retry() on error)
```

---

## Local Development

### Prerequisites

```bash
# Install Wrangler
npm install -g wrangler

# Authenticate
wrangler login

# Install worker dependencies
cd worker && npm install
```

### Setting Up `.dev.vars`

```bash
# Copy the template
cp .dev.vars.example .dev.vars

# Edit .dev.vars with real values:
ANTHROPIC_API_KEY=sk-ant-...
WEBHOOK_SECRET=my-random-secret
TELEGRAM_BOT_TOKEN=123456:ABC-...   # if testing Telegram
```

**Never commit `.dev.vars`** — it's gitignored.

### Creating Local D1 and KV

```bash
# Apply D1 schema locally
cd worker && npm run db:migrate:local

# Wrangler dev creates local KV and R2 automatically
```

### Running the Dev Server

```bash
cd worker && npm run dev
# → Worker available at http://localhost:8787
# → Uses local D1, KV, R2 (persistent across restarts)
# → Reads secrets from .dev.vars
```

### Testing Webhooks Locally

Use [ngrok](https://ngrok.com) or [cloudflared tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) to expose local port:

```bash
# With ngrok
ngrok http 8787
# → https://xxxx.ngrok.io → http://localhost:8787

# Register Telegram webhook to ngrok URL
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://xxxx.ngrok.io/webhook/telegram/${WEBHOOK_SECRET}"
```

### Testing Without Webhooks

Use curl to simulate:

```bash
# Simulate Telegram message (skip signature for dev)
curl -X POST http://localhost:8787/webhook/telegram/${WEBHOOK_SECRET} \
  -H "Content-Type: application/json" \
  -d '{
    "update_id": 123,
    "message": {
      "message_id": 1,
      "from": {"id": 111, "first_name": "Test"},
      "chat": {"id": -1001234567890, "type": "supergroup", "title": "Test Group"},
      "date": 1700000000,
      "text": "@Andy hello!"
    }
  }'

# Check health
curl http://localhost:8787/health

# Admin health (requires auth)
curl -H "Authorization: Bearer ${WEBHOOK_SECRET}" \
  http://localhost:8787/admin/health
```

---

## Production Deployment

### First-Time Setup

**Step 1: Create Cloudflare resources**

```bash
# D1 database
wrangler d1 create thagomizer-claw-db
# → Copy database_id to wrangler.toml

# R2 bucket
wrangler r2 bucket create thagomizer-claw-storage

# KV namespace
wrangler kv namespace create STATE
# → Copy id to wrangler.toml

# Queues (create both — main + dead letter)
wrangler queues create thagomizer-messages
wrangler queues create thagomizer-messages-dlq
```

**Step 2: Update `wrangler.toml`**

```toml
[[d1_databases]]
database_id = "YOUR_D1_ID_HERE"   # ← paste from step 1

[[kv_namespaces]]
id = "YOUR_KV_ID_HERE"            # ← paste from step 1
```

**Step 3: Apply database schema**

```bash
cd worker && npm run db:migrate:remote
```

**Step 4: Set secrets**

```bash
# Mandatory
wrangler secret put ANTHROPIC_API_KEY    # → paste key, press Enter
wrangler secret put WEBHOOK_SECRET       # → paste random secret

# Telegram (if using)
wrangler secret put TELEGRAM_BOT_TOKEN

# Discord (if using)
wrangler secret put DISCORD_BOT_TOKEN
wrangler secret put DISCORD_PUBLIC_KEY

# Slack (if using)
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put SLACK_SIGNING_SECRET
```

**Step 5: Deploy**

```bash
cd worker && npm run deploy
# → Worker available at https://thagomizer-claw.{account}.workers.dev
```

**Step 6: Register webhook with platforms**

```bash
WORKER_URL="https://thagomizer-claw.YOUR_SUBDOMAIN.workers.dev"
WEBHOOK_SECRET="your-secret-here"

# Telegram
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\": \"${WORKER_URL}/webhook/telegram/${WEBHOOK_SECRET}\"}"

# Slack: set in app dashboard under "Event Subscriptions"
# → Request URL: ${WORKER_URL}/webhook/slack

# Discord: set in app dashboard under "General Information"
# → Interactions Endpoint URL: ${WORKER_URL}/webhook/discord
```

**Step 7: Register your first group**

```bash
# Register main group (replace JID with your actual chat ID)
curl -X POST "${WORKER_URL}/admin/groups" \
  -H "Authorization: Bearer ${WEBHOOK_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "jid": "tg:-1001234567890",
    "group": {
      "name": "Main Control",
      "folder": "main",
      "trigger": "@Andy",
      "added_at": "2026-03-18T00:00:00Z",
      "isMain": true,
      "requiresTrigger": false
    }
  }'
```

### Subsequent Deployments

```bash
cd worker && npm run deploy
# Zero-downtime deployment — Cloudflare handles it
```

### Rollback

```bash
# List recent deployments
wrangler deployments list

# Roll back to previous
wrangler rollback
```

---

## Adding a New Channel

Follow the SDD process: write a spec in `docs/specs/01XX-{channel}-channel.md` first.

**Implementation checklist:**

1. **Create `worker/src/channels/{name}.ts`**

   ```typescript
   // JID format: xx:{platformId}
   export function buildXxxJid(id: string): string { return `xx:${id}`; }
   export function ownsXxxJid(jid: string): boolean { return jid.startsWith('xx:'); }

   // Webhook verification (cryptographic — no exceptions)
   export async function verifyXxxWebhook(req, body, env): Promise<boolean> { ... }

   // Parse platform payload → ParsedWebhookEvent
   export function parseXxxWebhook(payload): ParsedWebhookEvent | null { ... }

   // Send message back to platform
   export async function sendXxxMessage(channelId, text, env): Promise<void> { ... }
   ```

2. **Add webhook route in `worker/src/index.ts`**

   ```typescript
   if (pathname === '/webhook/xxx') {
     return handleXxxWebhook(request, env);
   }
   ```

3. **Add send routing in `sendMessage()` in `worker/src/index.ts`**

   ```typescript
   } else if (ownsXxxJid(jid)) {
     const channelId = parseXxxChannelFromJid(jid);
     if (channelId) await sendXxxMessage(channelId, formatted, env);
   }
   ```

4. **Add secret references to `wrangler.toml`** (comment only — values via `wrangler secret put`)

5. **Add to `Env` interface in `worker/src/types.ts`**

6. **Update `docs/CLOUDFLARE_SETUP.md`** with webhook registration steps

7. **Update spec to `Implemented` status**

---

## Working with D1

### Running Queries Locally

```bash
# Execute SQL against local D1
wrangler d1 execute thagomizer-claw-db --local \
  --command "SELECT * FROM registered_groups"

# Run a SQL file
wrangler d1 execute thagomizer-claw-db --local \
  --file=migrations/0001_initial.sql
```

### Running Queries in Production

```bash
# Query production D1 (read-only recommended)
wrangler d1 execute thagomizer-claw-db \
  --command "SELECT jid, name, folder FROM registered_groups"

# Check recent messages
wrangler d1 execute thagomizer-claw-db \
  --command "SELECT * FROM messages ORDER BY timestamp DESC LIMIT 10"
```

### Adding a Migration

```bash
# Create new migration file (increment the number)
# migrations/0002_add_agent_config.sql

# Apply locally
cd worker && npm run db:migrate:local

# Apply to production
cd worker && npm run db:migrate:remote
```

---

## Working with R2

```bash
# List objects in R2 bucket
wrangler r2 object list thagomizer-claw-storage

# Read a CLAUDE.md file
wrangler r2 object get thagomizer-claw-storage groups/main/CLAUDE.md

# Upload a CLAUDE.md file
wrangler r2 object put thagomizer-claw-storage groups/main/CLAUDE.md \
  --file groups/main/CLAUDE.md
```

---

## Monitoring and Debugging

### Live Log Tailing

```bash
cd worker && npm run tail
# → Streams real-time Worker logs to your terminal
# → Shows: requests, queue messages, cron runs, errors
```

### Cloudflare Dashboard

1. [dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages → thagomizer-claw
2. **Analytics**: request counts, error rates, CPU time
3. **Logs**: real-time and historical (requires Logpush or Workers Logs)
4. **Queues**: message counts, DLQ monitoring
5. **D1**: query console, metrics

### Health Check

```bash
# Basic (no auth)
curl https://thagomizer-claw.YOUR_SUBDOMAIN.workers.dev/health

# Detailed (requires auth)
curl -H "Authorization: Bearer ${WEBHOOK_SECRET}" \
  https://thagomizer-claw.YOUR_SUBDOMAIN.workers.dev/admin/health
```

### Common Issues and Fixes

#### Webhook returns 401
- Telegram: `WEBHOOK_SECRET` in URL doesn't match `env.WEBHOOK_SECRET`
- Discord: `DISCORD_PUBLIC_KEY` in Cloudflare Secrets doesn't match app's public key
- Slack: `SLACK_SIGNING_SECRET` is wrong, or request timestamp > 5 minutes old

```bash
# Verify secrets are set
wrangler secret list

# Re-set if needed
wrangler secret put DISCORD_PUBLIC_KEY
```

#### Messages stored but agent never responds
- Check queue: Cloudflare dashboard → Queues → thagomizer-messages → message count
- Check DLQ: `thagomizer-messages-dlq` for failed messages
- Check group is registered: `GET /admin/groups`
- Tail logs: `npm run tail` and send a test message

#### "Unknown D1 database" on deploy
- `database_id` in `wrangler.toml` is wrong or missing
- Run `wrangler d1 list` and copy the correct ID

#### KV namespace not found
- `id` in `wrangler.toml [[kv_namespaces]]` is wrong
- Run `wrangler kv namespace list` and copy the correct ID

#### Agent responds with fallback prefix `[Fallback via Workers AI]`
- Claude API is unavailable or `ANTHROPIC_API_KEY` is invalid
- Check key: `wrangler secret list` confirms it's set
- Test key: `curl -H "x-api-key: $(wrangler secret get ANTHROPIC_API_KEY)" https://api.anthropic.com/v1/models`

#### High cost / unexpected usage
- Check per-group `maxTokens` in `agentConfig`
- Set `useWorkersAI: true` in `agentConfig` for less critical groups
- Check R2 logs (`groups/{folder}/logs/`) for unusually long agent runs

---

## Understanding Durable Objects

### Accessing a GroupSession DO

From within the Worker:

```typescript
// Get the DO instance for a specific group
const id = env.GROUP_SESSION.idFromName(groupFolder);
const stub = env.GROUP_SESSION.get(id);

// Check state
const state = await stub.fetch('http://do/get-state').then(r => r.json());

// Enqueue messages
await stub.fetch('http://do/enqueue', {
  method: 'POST',
  body: JSON.stringify({ messages })
});
```

### DO Debugging

DOs don't show in standard Worker logs. Use `wrangler tail` and look for alarm events:

```bash
wrangler tail --format json | grep "GroupSessionDO"
```

Or add temporary console.log statements in the DO and redeploy.

---

## TypeScript and Build

### Type Checking

```bash
cd worker && npx tsc --noEmit
```

### Generating Cloudflare Types

When Cloudflare updates their bindings types:

```bash
cd worker && npm run cf-typegen
# → Updates worker-configuration.d.ts with current binding types
```

### `wrangler.toml` Changes

After changing `wrangler.toml` bindings, run `cf-typegen` to update TypeScript types, then update `worker/src/types.ts` `Env` interface to match.

---

## Cost Optimization

### Cloudflare Workers Pricing (as of 2026)

- **Workers**: $0 / 100k requests/day (free tier), then $0.50/million
- **D1**: $0 / 5M reads, 100k writes/day (free tier), then $0.001/million
- **R2**: $0 / 10 GB storage (free tier), then $0.015/GB
- **KV**: $0 / 100k reads/day (free tier), then $0.50/million
- **Queues**: $0 / 1M operations/month (free tier)
- **Workers AI**: pay per token (varies by model)

### Tips

1. **Use Workers AI for non-critical groups** — set `agentConfig.useWorkersAI: true`
2. **Set `maxTokens` per group** — default 4096 is generous; 1024 may suffice for simple groups
3. **KV caching** — `getCursor()` and `getSessionId()` already use KV (fast + cheap)
4. **R2 logs** — auto-expire after 30 days (set in `writeAgentLog()`), no manual cleanup needed
5. **D1 message cleanup** — consider a cron to archive old messages: `DELETE FROM messages WHERE timestamp < ?`

---

*ThagomizerClaw Implementation Guide v1.0*
*Eduardo Arana & Soda 🥤*
