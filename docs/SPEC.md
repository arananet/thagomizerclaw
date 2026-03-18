# ThagomizerClaw Specification

Enterprise Claude assistant on Cloudflare Workers. Multi-channel, globally distributed, zero-infrastructure.

*Forked from NanoClaw — Eduardo Arana & Soda 🥤*

For the spec-driven development process, see [SDD.md](SDD.md).
For governing principles, see [CONSTITUTION.md](../CONSTITUTION.md).

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Cloudflare Bindings](#cloudflare-bindings)
3. [Data Model](#data-model)
4. [Channel System](#channel-system)
5. [Message Flow](#message-flow)
6. [Agent Execution](#agent-execution)
7. [Memory System](#memory-system)
8. [Session Management](#session-management)
9. [Scheduled Tasks](#scheduled-tasks)
10. [Group Management](#group-management)
11. [Admin API](#admin-api)
12. [Durable Objects](#durable-objects)
13. [Security Model](#security-model)
14. [Deployment](#deployment)
15. [Node.js Reference Mode](#nodejs-reference-mode)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Cloudflare Network Edge                          │
│                                                                      │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────────────┐  │
│  │   Telegram   │  │    Discord    │  │         Slack            │  │
│  │   Webhook    │  │    Webhook    │  │        Webhook           │  │
│  │  (URL token) │  │   (Ed25519)   │  │      (HMAC-SHA256)       │  │
│  └──────┬───────┘  └───────┬───────┘  └────────────┬─────────────┘  │
│         └──────────────────▼──────────────────────-─┘               │
│                             │                                        │
│                 ┌───────────▼──────────┐                             │
│                 │   Worker fetch()     │  ← verify sig               │
│                 │   worker/src/index   │  ← store message to D1      │
│                 └───────────┬──────────┘  ← enqueue to Queue         │
│                             │                                        │
│                 ┌───────────▼──────────┐                             │
│                 │   Cloudflare Queue   │  (async, retryable)         │
│                 └───────────┬──────────┘                             │
│                             │                                        │
│                 ┌───────────▼──────────┐                             │
│                 │   Worker queue()     │  ← load group config        │
│                 │   consumer           │  ← load CLAUDE.md from R2   │
│                 └───────────┬──────────┘  ← call Claude / Workers AI │
│                             │             ← send reply via channel   │
│  ┌──────────────────────────▼─────────────────────────────────────┐  │
│  │                  Cloudflare Primitives                          │  │
│  │  D1 (SQLite)  │  R2 (objects)  │  KV (hot state)               │  │
│  │  Durable Objects (group state) │  Workers AI (LLM fallback)    │  │
│  │  Cron Triggers (scheduled tasks, every minute)                  │  │
│  └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Concern | Cloudflare Primitive | Notes |
|---------|---------------------|-------|
| Code execution | Workers (V8 isolate) | Serverless, ~0ms cold start |
| Primary database | D1 (SQLite) | Global replication |
| Object storage | R2 | CLAUDE.md files, logs |
| Hot state | KV | Cursors, sessions (sub-ms reads) |
| Async processing | Queues | Webhook → agent decoupling |
| Stateful coordination | Durable Objects | Per-group lock + queue |
| Rate limiting | Durable Objects | Sliding window per group |
| LLM inference | Workers AI | Llama/Mistral fallback |
| Secrets | Cloudflare Secrets | Encrypted at rest, never in code |
| Scheduling | Cron Triggers | `* * * * *` for task processing |

---

## Cloudflare Bindings

Defined in `wrangler.toml`. Accessed via `env.*` in Worker code.

```typescript
interface Env {
  // Data
  DB: D1Database;
  STORAGE: R2Bucket;
  STATE: KVNamespace;

  // Compute
  MESSAGE_QUEUE: Queue<QueueMessage>;
  AI: Ai;
  GROUP_SESSION: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;

  // Non-secret config (wrangler.toml [vars])
  ASSISTANT_NAME: string;       // Trigger name, default "Andy"
  ENVIRONMENT: string;
  LOG_LEVEL: string;
  MAX_CONCURRENT_AGENTS: string;
  AGENT_TIMEOUT_MS: string;
  WORKER_AI_MODEL: string;      // Workers AI fallback model

  // Secrets (wrangler secret put — NEVER in code)
  ANTHROPIC_API_KEY: string;
  WEBHOOK_SECRET: string;       // Telegram URL path + admin API auth
  TELEGRAM_BOT_TOKEN?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_PUBLIC_KEY?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
}
```

---

## Data Model

### D1 Tables (see `migrations/0001_initial.sql`)

```sql
-- Chat/group metadata
chats (jid PK, name, last_message_time, channel, is_group)

-- All inbound messages
messages (id + chat_jid PK, sender, sender_name, content, timestamp,
          is_from_me, is_bot_message)

-- Registered groups (groups the agent responds in)
registered_groups (jid PK, name, folder UNIQUE, trigger_pattern, added_at,
                   agent_config JSON, requires_trigger, is_main)

-- Per-group Claude session IDs
sessions (group_folder PK, session_id, updated_at)

-- Scheduled tasks
scheduled_tasks (id PK, group_folder, chat_jid, prompt,
                 schedule_type, schedule_value, context_mode,
                 next_run, last_run, last_result, status, created_at)

-- Task execution history
task_run_logs (id AUTOINCREMENT, task_id FK, run_at, duration_ms,
               status, result, error)
```

### R2 Key Space

```
groups/{folder}/CLAUDE.md           Group memory (writable by agent)
groups/{folder}/logs/{ts}.json      Agent run logs (auto-expire 30d)
groups/global/CLAUDE.md             Global memory (read-only for non-main)
sessions/{folder}/.claude/settings.json  Claude settings per group
config/sender-allowlist.json        Optional sender filtering config
```

### KV Key Space

```
cursor:{chatJid}         Last processed message timestamp (string ISO)
session:{groupFolder}    Session ID (TTL 7 days)
router_state:{key}       General router state (string values)
```

---

## Channel System

### Supported Channels

| Channel | JID Format | Webhook Path | Verification |
|---------|-----------|--------------|-------------|
| Telegram | `tg:{chatId}` | `/webhook/telegram/{WEBHOOK_SECRET}` | URL path token |
| Discord | `dc:{guildId}:{channelId}` | `/webhook/discord` | Ed25519 signature |
| Slack | `sl:{teamId}:{channelId}` | `/webhook/slack` | HMAC-SHA256 |

### Adding a Channel

Each channel is implemented in `worker/src/channels/{name}.ts` and MUST provide:

```typescript
// JID utilities
buildXxxJid(id: string): string       // → "xx:{id}"
ownsXxxJid(jid: string): boolean      // → jid.startsWith('xx:')

// Verification
verifyXxxWebhook(req, body, env): Promise<boolean>

// Parsing
parseXxxWebhook(payload): ParsedWebhookEvent | null

// Sending
sendXxxMessage(channelId, text, env): Promise<void>
```

The Worker's `sendMessage(jid, text, env)` function MUST be updated to route to the new channel's send function.

### ParsedWebhookEvent

```typescript
interface ParsedWebhookEvent {
  chatJid: string;
  message: NewMessage;
  channel: 'telegram' | 'discord' | 'slack';
  sendTyping?: () => Promise<void>;
}
```

---

## Message Flow

### 1. Inbound (Webhook → Queue)

```
Platform sends HTTP POST to /webhook/{channel}/[secret]
   │
   ▼ verify signature (Ed25519 / HMAC-SHA256 / URL token)
   │ reject if invalid → 401
   ▼ parse payload → ParsedWebhookEvent
   │ ignore unknown event types → 200
   ▼ storeChatMetadata(DB, ...)
   ▼ storeMessage(DB, message, assistantName)
   ▼ getAllRegisteredGroups(DB) → check if chatJid is registered
   │ if not registered → 200 (no processing)
   ▼ MESSAGE_QUEUE.send({ type: 'inbound_message', chatJid, messages, timestamp })
   ▼ return 200 immediately
```

### 2. Processing (Queue Consumer)

```
Queue delivers message batch
   │
   ▼ for each message in batch:
   │
   ▼ getAllRegisteredGroups(DB) → find group config
   │ if not found → ack (stale message)
   ▼ getCursor(KV, chatJid) → lastTimestamp
   ▼ getMessagesSince(DB, chatJid, lastTimestamp, assistantName)
   │ if empty → ack
   ▼ shouldProcess(messages, group, assistantName)
   │ if false (no trigger) → ack
   ▼ setCursor(KV, chatJid, newTimestamp)   ← advance before agent runs
   ▼ getGroupClaudeMd(R2, group.folder)
   ▼ getSessionId(KV, group.folder)
   ▼ formatMessages(messages) → XML prompt
   ▼ runAgent({ prompt, sessionId, groupFolder, chatJid, isMain, claudeMd }, env)
   ▼ if agent.newSessionId → setSessionId(KV, ...) + setSession(DB, ...)
   ▼ writeAgentLog(R2, ...)
   ▼ if success: sendMessage(chatJid, result, env)
   │ if error: setCursor(KV, chatJid, previousTimestamp)  ← rollback
   ▼ ack (success) or retry (error, up to max_retries)
```

### 3. Trigger Detection

For **non-main groups** with `requiresTrigger !== false`:
```
hasTrigger = messages.some(m =>
  !m.is_bot_message &&
  /^@{ASSISTANT_NAME}\b/i.test(m.content.trim())
)
```

For **main groups** (`isMain: true`) and groups with `requiresTrigger: false`:
- All messages are processed without trigger check.

### 4. Message XML Format

```xml
<context timezone="UTC" />
<messages>
  <message sender="Alice" time="03/18/2026 10:00:00 AM">Hello!</message>
  <message sender="Bob" time="03/18/2026 10:01:00 AM">@Andy what is 2+2?</message>
</messages>
```

All user-provided content is XML-escaped (`escapeXml()` in `worker/src/router.ts`).

---

## Agent Execution

See [specs/0008-agent-execution.md](specs/0008-agent-execution.md) for full specification.

### Primary: Anthropic Messages API

```
POST https://api.anthropic.com/v1/messages
Authorization: x-api-key {ANTHROPIC_API_KEY}

{
  "model": "claude-opus-4-6",
  "max_tokens": 4096,
  "system": "<system prompt>",
  "messages": [{ "role": "user", "content": "<XML prompt>" }]
}
```

### Fallback: Workers AI

Used when:
1. `agentConfig.useWorkersAI === true` (explicit)
2. Claude API call fails (automatic fallback)

Default model: `@cf/meta/llama-3.1-8b-instruct` (configurable via `WORKER_AI_MODEL`).

### System Prompt Structure

```
You are {assistantName}, a helpful AI assistant.
You are responding in a group chat. Be concise and helpful.
Current time: {ISO timestamp}

[if isMain:]
You have elevated admin privileges as the main control group assistant.
You can manage groups, schedule tasks, and control the assistant system.

[if claudeMd:]
## Group Context (CLAUDE.md)
{claudeMd}
```

---

## Memory System

### CLAUDE.md Hierarchy

| Level | R2 Path | Writable By | Read By |
|-------|---------|-------------|---------|
| Global | `groups/global/CLAUDE.md` | Main group only | All groups |
| Per-group | `groups/{folder}/CLAUDE.md` | That group's agent | That group |

Memory is injected into the agent as part of the system prompt (Workers mode), not as a file the agent reads directly (that's the Node.js container mode where CLAUDE.md is mounted as a file).

### Writing Memory

In Workers mode, agents can request memory updates by including structured instructions in their response. The Worker MUST implement a memory-write API (future spec) to allow agents to update their group's CLAUDE.md in R2.

Current status: CLAUDE.md is read on each request from R2. Write support is a future feature.

---

## Session Management

Session IDs are stored in:
- **KV** (`session:{groupFolder}`) — fast reads, 7-day TTL
- **D1** (`sessions` table) — authoritative, no TTL

The Anthropic Messages API is stateless. Session IDs are preserved for future use when the API adds conversation continuation support. Current behavior: each agent invocation is independent; conversation history is provided via the message context window.

---

## Scheduled Tasks

### Schedule Types

| Type | `schedule_value` | Behavior |
|------|-----------------|----------|
| `cron` | Cron expression (e.g. `0 9 * * 1`) | Runs on schedule, recurs |
| `interval` | Milliseconds (e.g. `3600000`) | Runs every N ms |
| `once` | ISO timestamp | Runs once, then `status = 'completed'` |

### Processing (Cron Trigger `* * * * *`)

1. Query D1: `SELECT * FROM scheduled_tasks WHERE status='active' AND next_run <= NOW()`
2. For each due task: `MESSAGE_QUEUE.send({ type: 'scheduled_task', ... })`
3. Update `next_run` (interval/cron) or set `status = 'completed'` (once)

### Queue Consumer for Tasks

Runs the agent with `isScheduledTask: true` and sends the response to the group's channel.

---

## Group Management

Groups are registered via the Admin API (`POST /admin/groups`). Each group has:

```typescript
interface RegisteredGroup {
  name: string;          // Display name
  folder: string;        // R2/KV key prefix (e.g., "main", "family-chat")
  trigger: string;       // Trigger text (e.g., "@Andy")
  added_at: string;      // ISO timestamp
  requiresTrigger?: boolean;  // Default: true
  isMain?: boolean;           // One group per Worker deployment
  agentConfig?: {
    model?: string;
    maxTokens?: number;
    timeout?: number;
    useWorkersAI?: boolean;
  };
}
```

**Main group** (`isMain: true`):
- No trigger required (processes all messages)
- Can schedule tasks for any group
- Receives admin notifications

---

## Admin API

All endpoints require `Authorization: Bearer {WEBHOOK_SECRET}`.

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/admin/health` | — | DB status, version, timestamp |
| GET | `/admin/groups` | — | All registered groups |
| POST | `/admin/groups` | `{ jid, group }` | `{ ok: true }` |
| GET | `/admin/tasks` | — | All scheduled tasks |
| POST | `/admin/send` | `{ jid, text }` | `{ ok: true }` |

---

## Durable Objects

### GroupSessionDO

One instance per registered group, keyed by `groupFolder`.

**State stored:**

```typescript
interface GroupSessionState {
  sessionId?: string;           // Last known Claude session ID
  lastAgentTimestamp?: string;  // Message cursor (ISO)
  isProcessing: boolean;        // Processing lock
  queuedMessages: NewMessage[]; // Pending messages
  lastActivity: string;         // Last activity ISO timestamp
}
```

**Endpoints:**

| Path | Purpose |
|------|---------|
| `POST /enqueue` | Add messages to queue, set alarm if idle |
| `GET /get-state` | Read current state |
| `POST /set-session` | Update session ID |
| `POST /set-cursor` | Update message cursor |
| `POST /mark-processing` | Acquire processing lock (returns `{ok: false}` if locked) |
| `POST /mark-done` | Release lock, optionally update session + cursor |
| `GET /dequeue` | Get queued messages + session + cursor |

**Alarm:** Triggered 100ms after message enqueue if not processing. Sends queued messages to `MESSAGE_QUEUE`.

### RateLimiterDO

Sliding window rate limiter keyed by `groupFolder`.

**Endpoint:** `POST /check` with `{ key, limit, windowMs }` → `{ allowed, remaining, resetAt }`

---

## Security Model

### Layered Security

```
Layer 1: Cloudflare network (DDoS protection, IP filtering)
Layer 2: Webhook signature verification (per-channel cryptographic)
Layer 3: Admin API Bearer token authentication
Layer 4: Per-group Durable Object isolation (no cross-group access)
Layer 5: Cloudflare Secrets (API keys never in code or logs)
Layer 6: D1/R2/KV access scoped by JID and folder
```

### Threat Model

| Threat | Mitigation |
|--------|-----------|
| Spoofed webhook | Cryptographic verification (Ed25519/HMAC-SHA256/URL token) |
| Leaked API key | Cloudflare Secrets (never in files or git) |
| Cross-group data access | DO isolation + D1 queries scoped by JID/folder |
| Prompt injection via message content | XML escaping; agent has no tool access in Workers mode |
| Unauthorized admin access | Bearer token on every admin request |
| Replay attacks (Slack) | Timestamp check (reject requests >5 minutes old) |
| Rate abuse / cost explosion | RateLimiterDO per group; `maxTokens` cap per group |

### What Workers Mode Gives Up (vs Node.js mode)

- **No shell access for agents** — Workers have no shell. This is a security improvement, not a regression.
- **No filesystem access** — Agents can't read/write files. CLAUDE.md is injected as context.
- **No browser automation** — No Chromium in Workers.

---

## Deployment

See [CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md) for the step-by-step guide.

### Quick Reference

```bash
# Create infrastructure
wrangler d1 create thagomizer-claw-db
wrangler r2 bucket create thagomizer-claw-storage
wrangler kv namespace create STATE
wrangler queues create thagomizer-messages

# Update wrangler.toml with the IDs from above

# Apply DB schema
cd worker && npm run db:migrate:remote

# Set secrets
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put WEBHOOK_SECRET

# Deploy
cd worker && npm run deploy
```

---

## Node.js Reference Mode

The original NanoClaw architecture is preserved in `src/`. It is frozen — new features go into Workers mode only.

Key differences:
- Docker containers run the Claude Agent SDK with full tool access
- `better-sqlite3` (sync) instead of D1 (async)
- Filesystem `groups/`, `data/` instead of R2/KV
- `.env` file (gitignored) for secrets
- Container image: `thagomizer-agent:latest`
- Output markers: `THAGOMIZER_OUTPUT_START/END`

For setup: `npm run dev` or `./container/build.sh` + `/setup` in Claude Code.

---

*ThagomizerClaw Specification v1.0*
*Eduardo Arana & Soda 🥤*
