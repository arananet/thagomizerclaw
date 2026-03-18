# ThagomizerClaw 🦕

<p align="center">
  <strong>Enterprise Claude assistant on Cloudflare Workers.</strong><br>
  Globally distributed. Zero infrastructure. Secrets never touch your machine.
</p>

<p align="center">
  Built by <strong>Eduardo Arana</strong> &amp; <strong>Soda 🥤</strong><br>
  Forked from <a href="https://github.com/qwibitai/nanoclaw">NanoClaw</a> by qwibitai
</p>

<p align="center">
  <a href="CONSTITUTION.md">Constitution</a> &nbsp;•&nbsp;
  <a href="docs/SPEC.md">Spec</a> &nbsp;•&nbsp;
  <a href="docs/SDD.md">SDD Guide</a> &nbsp;•&nbsp;
  <a href="docs/CLOUDFLARE_SETUP.md">Deploy</a> &nbsp;•&nbsp;
  <a href="docs/CLOUDFLARE_IMPLEMENTATION.md">Implementation Guide</a>
</p>

---

## What Is ThagomizerClaw?

ThagomizerClaw is a Claude-powered assistant that runs on Cloudflare Workers — no server, no Docker, no `.env` files on disk. It responds to messages from Telegram, Discord, and Slack, processes them with Claude (or Workers AI as a fallback), and sends replies back. Everything is serverless, globally distributed, and secured by Cloudflare's infrastructure.

It is a fork of [NanoClaw](https://github.com/qwibitai/nanoclaw), retaining the same core philosophy — **small enough to understand, secure by architecture** — and extending it with enterprise-grade Cloudflare Workers primitives.

> **The name:** A thagomizer was the spiked tail of a stegosaurus — a precisely structured defensive system. It wasn't decorative. It worked.

---

## Architecture at a Glance

```
Telegram / Discord / Slack
        │  (HTTP webhook, cryptographically verified)
        ▼
Cloudflare Worker (worker/src/index.ts)
        │
   ┌────▼──────────┐
   │  D1 Database  │ ← store message (SQLite, globally replicated)
   └────┬──────────┘
        │
        ▼ (async — response to platform < 3s)
Cloudflare Queue
        │
        ▼
runAgent() → Anthropic Claude API (primary) / Workers AI (fallback)
        │
Channel API (Telegram / Discord / Slack) ← send reply
```

**Cloudflare primitives used:**

| What | Primitive |
|------|-----------|
| Messages, groups, tasks | D1 (SQLite) |
| CLAUDE.md files, logs | R2 (object storage) |
| Cursors, sessions | KV (sub-ms reads) |
| Async agent execution | Queues |
| Per-group state + lock | Durable Objects |
| LLM fallback | Workers AI (Llama/Mistral) |
| Secrets | Cloudflare Secrets (never in code) |
| Scheduled tasks | Cron Triggers |

---

## Quick Start (Cloudflare Workers)

**Prerequisites:** Node.js 20+, a Cloudflare account (free tier works), an Anthropic API key.

```bash
# 1. Fork and clone this repo
gh repo fork arananet/thagomizer_claw --clone
cd thagomizer_claw

# 2. Install Wrangler
npm install -g wrangler
wrangler login

# 3. Create Cloudflare resources
wrangler d1 create thagomizer-claw-db         # copy database_id
wrangler kv namespace create STATE             # copy id
wrangler r2 bucket create thagomizer-claw-storage
wrangler queues create thagomizer-messages
wrangler queues create thagomizer-messages-dlq

# 4. Paste the IDs from step 3 into wrangler.toml

# 5. Apply database schema
cd worker && npm install && npm run db:migrate:remote

# 6. Set secrets (never in files — always via wrangler)
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put WEBHOOK_SECRET
wrangler secret put TELEGRAM_BOT_TOKEN   # if using Telegram

# 7. Deploy
npm run deploy

# 8. Register your Telegram webhook
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://thagomizer-claw.YOUR_SUBDOMAIN.workers.dev/webhook/telegram/${WEBHOOK_SECRET}"

# 9. Register your first group
curl -X POST "https://thagomizer-claw.YOUR_SUBDOMAIN.workers.dev/admin/groups" \
  -H "Authorization: Bearer ${WEBHOOK_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"jid":"tg:-1001234567890","group":{"name":"Main","folder":"main","trigger":"@Andy","added_at":"2026-03-18T00:00:00Z","isMain":true,"requiresTrigger":false}}'
```

For the full guide, see [docs/CLOUDFLARE_SETUP.md](docs/CLOUDFLARE_SETUP.md).

---

## What It Supports

- **Multi-channel messaging** — Telegram, Discord, Slack. More via skills.
- **Per-group isolation** — Each group has its own CLAUDE.md memory, session, and cursor. Groups cannot see each other.
- **Main channel** — One admin group with elevated privileges (no trigger required, can manage all groups and tasks)
- **Scheduled tasks** — Recurring jobs that run Claude and can message you back (cron, interval, once)
- **Workers AI fallback** — If Claude API is unavailable, falls back to Llama/Mistral on-device
- **Enterprise secrets** — All credentials via Cloudflare Secrets Store. Nothing on disk.
- **Global distribution** — Runs at Cloudflare's edge (300+ locations)

---

## Talking to the Assistant

Use the trigger word (default: `@Andy`) followed by your message:

```
@Andy what's on my task list for today?
@Andy schedule a Monday 9am briefing about this week's goals
@Andy summarize the conversation from the last hour
```

From the main group (admin channel), you can manage other groups:
```
@Andy register group "Family Chat" as tg:-1001111111111
@Andy list all scheduled tasks
@Andy pause the Monday briefing task
```

---

## Self-Hosted Mode (Node.js)

The original NanoClaw Node.js architecture is preserved in `src/` for users who need:
- Agent tool access (Bash, file system, browser)
- WhatsApp (Baileys-based)
- Long-running stateful containers

See [docs/SPEC.md — Node.js Reference Mode](docs/SPEC.md#nodejs-reference-mode) and the original NanoClaw README sections below.

```bash
npm run dev          # Hot-reload development
./container/build.sh # Build thagomizer-agent:latest Docker image
```

---

## Philosophy

**Spec first, code second.** Every feature begins with a specification. No code without a contract. See [docs/SDD.md](docs/SDD.md).

**Security through architecture, not policy.** Secrets in vaults, not files. Verification cryptographic, not optional. Isolation structural, not behavioral.

**Small enough to understand.** The Workers implementation (`worker/`) can be read start-to-finish in under two hours. If it can't, something has gone wrong.

**Cloudflare native.** D1, R2, KV, Queues, Durable Objects, Workers AI — used as designed, not bolted on top of Node.js patterns.

**Skills over features.** New channels and integrations are Claude Code skills, not core commits. The core stays minimal.

The full governing principles are in [CONSTITUTION.md](CONSTITUTION.md).

---

## Development

### Cloudflare Workers

```bash
# Local dev (reads .dev.vars for secrets)
cp .dev.vars.example .dev.vars  # fill in real values
cd worker && npm install && npm run dev

# Type checking
cd worker && npx tsc --noEmit

# Deploy
cd worker && npm run deploy

# Tail logs
cd worker && npm run tail

# Manage secrets
wrangler secret put ANTHROPIC_API_KEY
wrangler secret list
```

### Node.js Reference

```bash
npm run dev          # tsx watch
npm run build        # tsc
npm test             # vitest
./container/build.sh # Docker image
```

---

## Spec-Driven Development

ThagomizerClaw uses spec-driven development (SDD). Before writing code, write the spec.

```
docs/
├── CONSTITUTION.md          # Governing principles (read this first)
├── SDD.md                   # SDD process guide
├── SPEC.md                  # Full system specification
├── REQUIREMENTS.md          # Requirements and architecture decisions
├── CLOUDFLARE_SETUP.md      # Deployment guide
├── CLOUDFLARE_IMPLEMENTATION.md  # Implementation guide (debugging, extending)
├── CLOUDFLARE_SECRETS.md    # Secrets management
└── specs/
    ├── 0001-workers-architecture.md
    ├── 0008-agent-execution.md
    ├── 0009-cloudflare-secrets.md
    └── ...
```

To contribute:
1. Write a spec in `docs/specs/XXXX-{feature}.md`
2. Get it reviewed via pull request
3. Implement to spec
4. Write tests against spec test cases
5. Update spec status to `Implemented`

---

## FAQ

**Why Cloudflare Workers instead of AWS Lambda / Fly.io / a VPS?**

Cloudflare's primitive set maps almost exactly to what ThagomizerClaw needs (D1, R2, KV, Queues, Durable Objects, Workers AI, Secrets). Zero infrastructure management. Global distribution. Sub-millisecond cold starts. Secrets that never touch the filesystem.

**Why no Docker containers in Workers mode?**

Cloudflare Workers are V8 isolates — no filesystem, no shell. Docker requires both. The trade-off is intentional: Workers mode agents don't get tool access (Bash, file ops), but they also can't do damage. For tool access, use the Node.js reference mode.

**Why no WhatsApp in Workers mode?**

WhatsApp (via Baileys) requires a persistent WebSocket connection and filesystem for session storage. Workers are stateless HTTP handlers. WhatsApp Business API (webhook-based) could be added as a skill — contributions welcome.

**Can I use a different model?**

Yes. Set `agentConfig.model` when registering a group via the Admin API. Any Anthropic model ID works. For non-Anthropic models, set `agentConfig.useWorkersAI: true` and configure `WORKER_AI_MODEL` in `wrangler.toml`.

**Is this secure?**

Secrets are in Cloudflare Secrets Store — encrypted at rest, never in code or git. Webhooks are verified cryptographically (Ed25519, HMAC-SHA256). Groups are isolated via Durable Objects. Workers run in V8 isolates (no filesystem access). See [docs/SPEC.md — Security Model](docs/SPEC.md#security-model) for the full threat model.

**How do I debug issues?**

```bash
cd worker && npm run tail    # live log stream
curl .../admin/health        # health check
wrangler d1 execute thagomizer-claw-db --command "SELECT * FROM messages LIMIT 5"
```

See [docs/CLOUDFLARE_IMPLEMENTATION.md](docs/CLOUDFLARE_IMPLEMENTATION.md) for full debugging guide.

**What's the difference between this and NanoClaw?**

ThagomizerClaw is NanoClaw with Cloudflare Workers as the deployment target. Same domain model (groups, sessions, triggers, CLAUDE.md), different infrastructure. NanoClaw runs on your Mac in Docker. ThagomizerClaw runs on Cloudflare's global edge.

---

## Channels

| Channel | Status | Notes |
|---------|--------|-------|
| Telegram | ✅ Workers | URL token verification |
| Discord | ✅ Workers | Ed25519 signature |
| Slack | ✅ Workers | HMAC-SHA256 + replay protection |
| WhatsApp | ✅ Node.js | Baileys (self-hosted only) |
| Gmail | Via skill | `/add-gmail` skill (Node.js) |

---

## Contributing

Follow the [SDD guide](docs/SDD.md): spec before code, always.

**For new channels:** write a spec in `docs/specs/01XX-{channel}.md`, implement it, write tests against the spec test cases.

**For security changes:** spec required in `docs/specs/02XX-*.md`. Security analysis MUST be honest — describe what the threat is and why the mitigation works.

**The core does not grow.** New capabilities ship as Claude Code skills (`.claude/skills/`). If you're adding a feature that every user must carry, reconsider. If you're adding a skill that users can opt into, welcome.

---

## Project Structure

```
thagomizer_claw/
├── CONSTITUTION.md            # Governing principles — READ FIRST
├── CLAUDE.md                  # AI assistant context
├── README.md                  # This file
├── wrangler.toml              # Cloudflare Workers configuration
├── .dev.vars.example          # Local dev secrets template
│
├── worker/                    # Cloudflare Workers (PRIMARY)
│   ├── src/
│   │   ├── index.ts           # Worker entry (fetch, queue, scheduled)
│   │   ├── types.ts           # Env bindings + domain types
│   │   ├── db.ts              # D1 adapter
│   │   ├── storage.ts         # R2 + KV adapter
│   │   ├── agent.ts           # Claude API + Workers AI
│   │   ├── router.ts          # Message formatting
│   │   ├── channels/
│   │   │   ├── telegram.ts
│   │   │   ├── discord.ts
│   │   │   └── slack.ts
│   │   └── durable-objects/
│   │       └── GroupSession.ts
│   └── package.json
│
├── src/                       # Node.js reference (PRESERVED, FROZEN)
├── container/                 # Docker agent image (Node.js mode)
├── migrations/                # D1 schema
│   └── 0001_initial.sql
│
└── docs/
    ├── SPEC.md                # System specification
    ├── REQUIREMENTS.md        # Requirements + architecture decisions
    ├── SDD.md                 # Spec-driven development guide
    ├── CLOUDFLARE_SETUP.md    # Step-by-step deployment
    ├── CLOUDFLARE_IMPLEMENTATION.md  # Developer guide
    ├── CLOUDFLARE_SECRETS.md  # Secrets management
    └── specs/                 # Individual feature specs
        ├── 0001-workers-architecture.md
        ├── 0008-agent-execution.md
        └── 0009-cloudflare-secrets.md
```

---

## License

MIT

---

*ThagomizerClaw — Eduardo Arana & Soda 🥤*
*Forked from [NanoClaw](https://github.com/qwibitai/nanoclaw) by qwibitai (MIT)*
