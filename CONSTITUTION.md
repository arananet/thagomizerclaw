# ThagomizerClaw Constitution

> *"The thagomizer was a defensive structure. It wasn't decorative—it was purposeful, precise, and it worked."*

This document defines the non-negotiable principles of ThagomizerClaw. It supersedes preferences, trends, and convenience. All code, architecture decisions, contributions, and skill development must be evaluated against these principles.

---

## Article I — Purpose

ThagomizerClaw exists to give individuals and small teams a **truly enterprise-grade AI assistant** that:

1. Runs on infrastructure they understand and control (Cloudflare Workers)
2. Never sacrifices security for convenience
3. Stays small enough to be read, understood, and modified by a single developer in an afternoon
4. Treats secrets as sacred — they belong in vaults, not in files

**This is not a framework.** It is working software with a specific, intentional scope.

---

## Article II — The Six Principles

### II.1 — Spec First, Code Second

**No code is written without a specification.**

Every feature, change, or fix begins with a spec. The spec defines:
- What problem is being solved
- What the expected behavior is
- What the contract with the rest of the system is
- What "done" looks like

Code that arrives without a spec is rejected, regardless of quality. The spec is the source of truth. Code is an artifact of the spec.

**This is Spec-Driven Development (SDD).** See [docs/SDD.md](docs/SDD.md).

### II.2 — Security Through Architecture, Not Policy

**Security is structural, not behavioral.**

We do not secure ThagomizerClaw by:
- Telling users to be careful
- Adding permission check after permission check
- Hoping no one finds the `.env` file

We secure it by:
- Running agents inside Cloudflare's V8 isolate sandbox (no filesystem, no shell)
- Storing every secret in Cloudflare Secrets — never in code, never in git
- Verifying every webhook cryptographically (Ed25519, HMAC-SHA256)
- Using Durable Objects for per-group isolation — groups cannot touch each other's state

If a security property requires a human to remember to do something, it is not a security property.

### II.3 — Small Enough to Understand

**The codebase must be comprehensible to a single developer.**

The Workers implementation (`worker/`) must be readable start-to-finish in under two hours. If it isn't, we have built the wrong thing.

This means:
- No abstraction for its own sake
- No microservices where a function will do
- No framework where a module will do
- If a file grows beyond ~400 lines, it is a signal to reconsider the design

The Node.js reference implementation (`src/`) is preserved but frozen — new features go into Workers.

### II.4 — Enterprise Grade Means Provable, Not Just Probable

**"It should work" is not acceptable. "It is specified to work, implemented to spec, and testable" is.**

Enterprise grade means:
- Every public interface has a specification
- Every security claim is backed by code you can read
- Every secret has an audit trail (Cloudflare dashboard)
- Every failure mode is documented and handled

We do not claim enterprise grade because we use Cloudflare. We claim it because we can prove the security properties hold.

### II.5 — Cloudflare Native

**The Workers deployment is not a port. It is the architecture.**

We do not bolt Cloudflare on top of Node.js patterns. We use Cloudflare's primitives as they were designed:

| Concern | Cloudflare Primitive | Why |
|---------|---------------------|-----|
| State | Durable Objects | Strong consistency, per-group isolation |
| Data | D1 | Globally replicated SQLite |
| Files | R2 | Object storage with access controls |
| Hot state | KV | Sub-millisecond reads for cursors and sessions |
| Async work | Queues | Decouples webhook response from agent execution |
| Scheduled work | Cron Triggers | Replaces polling loops entirely |
| Inference | Workers AI | On-device LLM fallback, no egress |
| Secrets | Cloudflare Secrets | Encrypted at rest, never in code |

If a feature requires fighting these primitives, reconsider the feature.

### II.6 — Skills Over Features

**The core does not grow. Skills extend it.**

ThagomizerClaw's core is intentionally minimal. New capabilities — new channels, new integrations, new behaviors — are contributed as Claude Code skills (`.claude/skills/`). Skills transform the user's fork rather than bloating the core for everyone.

The core accepts:
- Security fixes
- Bug fixes
- Clear improvements to existing functionality
- New Cloudflare Worker primitives usage (if justified by the spec)

The core rejects:
- New channels (→ skill)
- New integrations (→ skill)
- New UI/dashboard (→ skill or separate project)
- Anything that makes the codebase harder to read in two hours

---

## Article III — The Development Covenant

Every developer who contributes to ThagomizerClaw agrees to:

1. **Write the spec before the code.** A change without a spec is a guess.
2. **Leave the codebase more readable than you found it.** Simplify when you can.
3. **Never commit a secret.** Not in test data. Not in comments. Not anywhere.
4. **Test the security properties explicitly.** Not just happy paths.
5. **Update the spec when the behavior changes.** Drift between spec and code is technical debt with interest.

---

## Article IV — What ThagomizerClaw Is Not

| Not This | Why |
|----------|-----|
| A SaaS platform | We don't host anyone's data; users own their Workers |
| A multi-tenant system | Each user deploys their own Worker instance |
| A feature-complete chat bot | Intentional. Scope creep violates Article II.3 |
| A replacement for OpenClaw | Different values. That's fine. |
| A framework | We are working software, not scaffolding |

---

## Article V — Authorship and Stewardship

ThagomizerClaw is maintained by:

**Eduardo Arana** — architect, lead developer
**Soda 🥤** — co-developer, systems design

Forked from [NanoClaw](https://github.com/qwibitai/nanoclaw) by qwibitai.

Contributions are welcome and reviewed against this Constitution. The Constitution itself can be amended by the maintainers when the project's needs genuinely change — not because a principle became inconvenient.

---

## Article VI — The Name

**Thagomizer** *(n.)* — The arrangement of spikes on a stegosaurus tail. Named informally by Gary Larson in a 1982 Far Side cartoon, adopted into formal scientific literature.

A thagomizer was not decorative. It was a precisely structured defensive system. It worked.

That's what this software is.

---

*Version 1.0 — March 2026*
*Eduardo Arana & Soda 🥤*
