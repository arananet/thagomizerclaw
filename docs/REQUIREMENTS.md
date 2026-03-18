# ThagomizerClaw Requirements

*Forked from NanoClaw by Eduardo Arana & Soda 🥤*

This document captures the foundational requirements and design decisions. For the specification process, see [SDD.md](SDD.md). For governing principles, see [CONSTITUTION.md](../CONSTITUTION.md).

---

## Why This Fork Exists

NanoClaw provides an excellent minimal architecture for a personal Claude assistant. ThagomizerClaw takes that architecture and makes it enterprise-grade by migrating it to Cloudflare Workers.

The specific problems this fork solves:

1. **Infrastructure burden** — NanoClaw requires an always-on Mac or VPS. ThagomizerClaw requires no servers. `wrangler deploy` is the full deployment.
2. **Secret exposure** — NanoClaw reads secrets from `.env` files on disk. ThagomizerClaw reads secrets from Cloudflare Secrets Store, which is encrypted at rest and never accessible from the filesystem.
3. **Single-region** — NanoClaw runs in one location. ThagomizerClaw runs at Cloudflare's edge (300+ locations), globally.
4. **Container startup latency** — NanoClaw spawns a Docker container per agent invocation (2–5s overhead). ThagomizerClaw calls the Anthropic API directly from the Worker (~0ms overhead for startup).
5. **Polling loops** — NanoClaw has a 2s polling loop for messages. ThagomizerClaw is fully event-driven via webhooks and Queues.

---

## Core Requirements

### R1 — Serverless First
The system MUST run entirely within Cloudflare's infrastructure. No VPS, no always-on server, no container runtime required from the user.

### R2 — Zero-Secret-in-Code
No secret value MUST ever appear in source code, configuration files committed to git, or Cloudflare environment variables (only Cloudflare Secrets).

### R3 — Cryptographic Webhook Verification
Every channel webhook MUST be verified using the platform's standard mechanism before any processing occurs:
- Telegram: URL path secret token
- Discord: Ed25519 signature
- Slack: HMAC-SHA256 + timestamp

### R4 — Per-Group Isolation
Groups MUST be isolated from each other. One group's messages, session, cursor, and CLAUDE.md MUST NOT be accessible to another group's agent execution.

Implemented via:
- Durable Objects keyed by `groupFolder`
- D1 queries scoped by `chat_jid` or `group_folder`
- R2 paths scoped by `groups/{folder}/`
- KV keys scoped by `session:{folder}` and `cursor:{jid}`

### R5 — Async Agent Execution
Agent execution MUST be decoupled from webhook response. Webhooks MUST respond within 3 seconds (platform requirement). Agent execution MAY take up to `AGENT_TIMEOUT_MS` (default 120s).

Implemented via Cloudflare Queues: webhook handler enqueues, queue consumer executes.

### R6 — Graceful Degradation
If the Claude API is unavailable, the system SHOULD fall back to Workers AI (Llama/Mistral). If Workers AI is also unavailable, the system MUST return an error to the user rather than silently dropping the message.

### R7 — Cursor-Based Message Deduplication
The system MUST track the last-processed message timestamp per group (`cursor:{chatJid}` in KV). On agent error, the cursor MUST be rolled back so the message is reprocessed on the next attempt. On success, the cursor MUST advance.

### R8 — Spec-Driven Development
Every non-trivial change MUST be preceded by a specification document in `docs/specs/`. See [SDD.md](SDD.md).

---

## Architecture Decisions

### Decision: Cloudflare Workers over VPS/Lambda

**Alternatives considered:**
- AWS Lambda + DynamoDB + S3
- Fly.io persistent VMs
- Railway/Render always-on Node.js

**Decision rationale:**
Cloudflare's primitive set (D1, R2, KV, Queues, Durable Objects, Workers AI, Secrets) maps almost exactly to ThagomizerClaw's needs. The platform handles scaling, global distribution, and secret encryption. No infrastructure management required.

### Decision: Direct Anthropic API over Agent SDK

**Alternatives considered:**
- Running Claude Agent SDK in Workers (not possible — requires Node.js filesystem APIs)
- External container execution (breaks the serverless requirement)

**Decision rationale:**
The Agent SDK requires a Node.js environment with filesystem access for session storage. Workers are V8 isolates with no filesystem. The Messages API is the correct integration point for Workers.

Trade-off: Workers mode agents do not have tool access (Bash, file operations). The agent is Claude responding to messages, not Claude Code running commands. For users who need tool access, the Node.js reference implementation is available.

### Decision: D1 over KV-only or Postgres

**Alternatives considered:**
- Pure KV storage (no relational queries)
- Cloudflare Hyperdrive + Postgres (requires external database)

**Decision rationale:**
D1 is SQLite-compatible, requires no external infrastructure, and supports the relational queries needed (messages by JID and timestamp range, tasks by status and next_run). The existing SQLite schema migrates with minimal changes.

### Decision: Durable Objects for Group State

**Alternatives considered:**
- KV for all state (no consistency guarantees)
- D1 for locking (complex advisory lock pattern)
- External Redis (breaks serverless requirement)

**Decision rationale:**
Durable Objects provide strong consistency (single-instance globally) and the Alarm API for deferred processing. They are the correct Cloudflare primitive for per-entity stateful coordination.

### Decision: Queues for Async Decoupling

**Alternatives considered:**
- Synchronous agent execution in fetch handler (violates 3s timeout)
- Scheduled polling (adds latency, wastes resources)
- Durable Object alarms only (no retry/DLQ support)

**Decision rationale:**
Queues provide: decoupling of webhook from execution, automatic retry with configurable max_retries, dead-letter queue for debugging, and batching for efficiency.

### Decision: R2 for Group Files, KV for Hot State

**Alternatives considered:**
- D1 for all storage (BLOBs in SQLite — works but suboptimal)
- KV for everything (no TTL control, expensive for large values)

**Decision rationale:**
R2 is designed for object storage and is cost-effective for CLAUDE.md files and logs. KV provides sub-millisecond read latency for frequently-accessed state (session IDs, cursors) that doesn't need SQL queries.

---

## Preserved from NanoClaw

These design decisions from the original NanoClaw are preserved unchanged:

- **JID-based group identification** — each chat is identified by a platform-specific JID
- **CLAUDE.md hierarchy** — global CLAUDE.md (shared, read-only for non-main) and per-group CLAUDE.md
- **Main group privileges** — one group has elevated access (admin, task management for all groups)
- **Trigger pattern** — `@{ASSISTANT_NAME}` prefix required to activate agent (configurable)
- **Skills architecture** — capabilities added via Claude Code skills, not core commits
- **XML message format** — `<messages><message sender="..." time="...">content</message></messages>`
- **Database schema** — same tables (chats, messages, registered_groups, sessions, scheduled_tasks, task_run_logs)

---

## What Changed from NanoClaw

| NanoClaw | ThagomizerClaw |
|----------|---------------|
| Docker containers | Workers AI + Anthropic API |
| better-sqlite3 (sync) | D1 (async) |
| `groups/`, `data/` filesystem | R2 + KV |
| `.env` file secrets | Cloudflare Secrets |
| Polling loop (2s) | Webhooks + Queues |
| Scheduler loop (60s) | Cron Triggers (1 min) |
| IPC via filesystem | Durable Objects |
| Credential proxy server | Native env binding |
| Single-region Node.js | Global edge Workers |
| `~/.config/nanoclaw/` | `wrangler.toml [vars]` + Secrets |
| Container image: `nanoclaw-agent` | No container (direct API) |

---

## Out of Scope

The following are explicitly out of scope for the Workers implementation:

- **Bash/shell access for agents** — Workers have no shell. Users who need agent tool access should use the Node.js reference implementation.
- **Browser automation** — No Chromium in Workers. This is a fundamental constraint of the platform.
- **WhatsApp via Baileys** — Baileys requires a persistent WebSocket connection and filesystem. Workers are stateless. WhatsApp Business API (webhook-based) could be added as a skill.
- **Per-group agent customization** — No agent-runner src copying. Each group uses the same agent configuration.

---

*ThagomizerClaw Requirements v1.0*
*Eduardo Arana & Soda 🥤*
