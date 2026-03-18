# Spec-Driven Development (SDD) Guide

ThagomizerClaw is built using Spec-Driven Development. This document explains what that means, why we do it, and how to follow the process.

---

## Why Spec-Driven Development?

Code is ambiguous. A spec is not.

When you write code first, you make assumptions about what the system should do. Those assumptions live in your head. When a bug appears, or someone else needs to extend the feature, the assumptions are invisible. The code becomes the spec — and code is a terrible spec.

When you write the spec first:
- The behavior is explicit before any implementation choices are made
- Reviewers can challenge the design before it's baked into code
- Tests can be written against the spec, not reverse-engineered from behavior
- The spec survives when the code changes

For a security-sensitive system like ThagomizerClaw, running on shared infrastructure with encrypted secrets, **spec-first is not optional**. It is how we prove our security properties hold.

---

## The SDD Process

### Step 1 — Problem Statement

Before writing anything, answer in one paragraph:

> What problem does this solve? Who has it? What happens today without this change?

If you cannot answer this, stop. The feature is not ready.

### Step 2 — Specification Document

Create or update a spec document in `docs/specs/` before writing a line of code.

**Spec document structure:**

```markdown
# Spec: [Feature Name]

## Status
[ ] Draft | [ ] Review | [ ] Approved | [ ] Implemented | [ ] Deprecated

## Problem
One paragraph. What is broken or missing?

## Constraints
Non-negotiable limits (security, performance, compatibility).

## Behavior Specification
Precise description of what the system MUST do.
Use "MUST", "MUST NOT", "SHOULD", "MAY" (RFC 2119).

## Interface Contract
What changes for callers? New functions, endpoints, types, database columns?
Show the TypeScript signature or SQL schema change.

## Security Considerations
What attack surface does this change? What is the mitigation?
If "none", explain why.

## Test Cases
Minimum: one happy path, one error path, one security boundary case.

## Open Questions
Things that need resolution before implementation begins.

## Implementation Notes
Optional: hints, gotchas, relevant prior art. Not instructions.
```

### Step 3 — Review

The spec is reviewed against the [Constitution](../CONSTITUTION.md) before implementation starts:

- Does it align with the Six Principles?
- Is the security analysis honest?
- Are the test cases meaningful (not just happy paths)?
- Is the scope minimal?

Specs are reviewed in pull requests as markdown files. Code reviewers review specs differently from code — they look for missing cases, unstated assumptions, and security gaps.

### Step 4 — Implementation

Implementation follows the approved spec. The implementation **must not** diverge from the spec without updating the spec first.

If you discover during implementation that the spec is wrong or incomplete:
1. Stop coding
2. Update the spec
3. Get the updated spec reviewed
4. Then continue

**A "we'll fix the spec later" attitude is how you get undocumented behavior.**

### Step 5 — Tests Against the Spec

Tests are written against the spec, not the implementation. The difference matters:

```typescript
// ❌ Test against implementation (brittle)
expect(verifySlackSignature(req, body, env)).resolves.toBe(true);

// ✅ Test against spec ("MUST reject requests older than 5 minutes")
const oldTimestamp = String(Math.floor(Date.now() / 1000) - 400);
const req = makeRequest({ 'X-Slack-Request-Timestamp': oldTimestamp });
expect(verifySlackSignature(req, body, env)).resolves.toBe(false);
```

Each spec test case becomes a test. If the spec says "MUST reject", the test proves it rejects.

### Step 6 — Spec Update on Completion

When the implementation is merged, update the spec's `Status` field to `Implemented` and add the commit/PR reference.

---

## Spec File Conventions

```
docs/specs/
├── 0001-initial-workers-architecture.md   # approved, implemented
├── 0002-telegram-channel.md               # approved, implemented
├── 0003-discord-channel.md                # approved, implemented
├── 0004-slack-channel.md                  # approved, implemented
├── 0005-durable-objects-group-session.md  # approved, implemented
├── 0006-workers-ai-fallback.md            # draft
└── 0007-rate-limiting.md                  # review
```

Specs are numbered sequentially and never deleted. Deprecated specs are marked `Deprecated` with a note pointing to the replacement.

---

## Spec Numbering

| Range | Category |
|-------|----------|
| 0001–0099 | Core architecture |
| 0100–0199 | Channels |
| 0200–0299 | Security |
| 0300–0399 | Data layer |
| 0400–0499 | Agent execution |
| 0500–0599 | Scheduled tasks |
| 0600–0699 | Admin API |
| 0700–0799 | Skills |
| 0800+ | Experimental |

---

## Levels of Specification

Not everything needs the full treatment. Use judgment:

| Change Type | Required |
|-------------|----------|
| Bug fix (behavior clearly wrong per existing spec) | Comment in PR explaining which spec is violated |
| Small refactor (no behavior change) | None |
| New function in existing module | Add to existing spec or inline jsdoc |
| New module | New spec doc |
| New channel | New spec doc (0100+ range) |
| Security change | New spec doc (0200+ range), always |
| Database schema change | New spec doc (0300+ range), always |
| New Cloudflare binding | New spec doc, always |

**When in doubt, write a spec.** The cost is low. The benefit is permanent.

---

## Active Specs

| ID | Title | Status |
|----|-------|--------|
| [0001](specs/0001-workers-architecture.md) | Cloudflare Workers Architecture | Approved / Implemented |
| [0002](specs/0002-d1-database.md) | D1 Database Adapter | Approved / Implemented |
| [0003](specs/0003-r2-kv-storage.md) | R2 and KV Storage Adapter | Approved / Implemented |
| [0004](specs/0004-telegram-channel.md) | Telegram Channel | Approved / Implemented |
| [0005](specs/0005-discord-channel.md) | Discord Channel | Approved / Implemented |
| [0006](specs/0006-slack-channel.md) | Slack Channel | Approved / Implemented |
| [0007](specs/0007-durable-objects.md) | Durable Objects: GroupSession + RateLimiter | Approved / Implemented |
| [0008](specs/0008-agent-execution.md) | Agent Execution: Claude API + Workers AI | Approved / Implemented |
| [0009](specs/0009-cloudflare-secrets.md) | Secrets Management Policy | Approved / Implemented |
| [0010](specs/0010-admin-api.md) | Admin HTTP API | Approved / Implemented |

---

## The Spec as Living Documentation

The spec is not a document you write once and forget. It is the authoritative description of how the system behaves. When behavior changes, the spec changes. When a security property is strengthened, the spec is updated to reflect it.

**If the code does something the spec doesn't describe, that's a bug in the spec.**
**If the spec describes something the code doesn't do, that's a bug in the code.**

Both are bugs. Both get fixed.

---

## Example: Writing a New Channel Spec

Say you want to add WhatsApp as a channel to the Workers implementation.

**Bad approach:**
> "I'll just write the code, it's basically the same as Telegram."

**SDD approach:**

1. Create `docs/specs/0101-whatsapp-channel.md`
2. Write:
   - Problem: users want WhatsApp support in Workers mode
   - Constraints: WhatsApp Business API only (no Baileys in Workers — no filesystem)
   - Behavior: webhook verification, message parsing, send, JID format `wa:{phoneNumber}`
   - Interface: `verifyWhatsAppWebhook()`, `parseWhatsAppWebhook()`, `sendWhatsAppMessage()`
   - Security: HMAC-SHA256 verification of Meta webhook signature
   - Test cases: valid/invalid signature, message with media (should be ignored), text message
3. Get spec reviewed
4. Write the code to spec
5. Write tests against the spec test cases
6. Update spec status to Implemented

The result: anyone reading the spec knows exactly what WhatsApp support does and doesn't do, what its security properties are, and how to use it — without reading the code.

---

*ThagomizerClaw SDD Guide v1.0*
*Eduardo Arana & Soda 🥤*
