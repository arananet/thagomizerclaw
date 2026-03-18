# Spec 0008 — Agent Execution: Claude API + Workers AI

## Status
✅ Approved / ✅ Implemented — commit `0091155`

## Problem

The Node.js implementation runs agents inside Docker containers using the Claude Agent SDK, which gives agents full tool access (Bash, filesystem, web) inside an isolated container. Cloudflare Workers have no filesystem, no shell, and CPU time limits — the container model is incompatible.

ThagomizerClaw Workers must call Claude directly via the Anthropic Messages API, with group context injected as a system prompt. Workers AI (Llama/Mistral) provides an on-device fallback for cost control or API unavailability.

## Constraints

- MUST call the Anthropic Messages API directly (no Agent SDK in Workers)
- MUST NOT exceed Cloudflare Worker CPU time limits (~30s per invocation)
- MUST provide a fallback to Workers AI when Claude API fails
- MUST inject group memory (CLAUDE.md from R2) as system context
- MUST persist session IDs to KV and D1 for conversation continuity
- MUST support per-group model configuration via `agentConfig`
- Response MUST NOT include the raw API key in any output

## Behavior Specification

### Primary Path: Anthropic Claude API

The agent MUST call `https://api.anthropic.com/v1/messages` with:
- `model`: from `agentConfig.model` or default `claude-opus-4-6`
- `max_tokens`: from `agentConfig.maxTokens` or default `4096`
- `system`: constructed system prompt (see below)
- `messages`: `[{ role: 'user', content: formattedPrompt }]`
- Auth: `x-api-key: {ANTHROPIC_API_KEY}`, `anthropic-version: 2023-06-01`

### System Prompt Construction

The system prompt MUST be built from these components in order:
1. Identity statement: `You are {assistantName}, a helpful AI assistant.`
2. Context statement about group chat and brevity
3. Current timestamp (ISO 8601)
4. If `isMain`: elevated privileges notice
5. If `claudeMd` is non-null: `## Group Context (CLAUDE.md)\n{claudeMd}`

### Workers AI Fallback Path

If `agentConfig.useWorkersAI === true`, the agent MUST use Workers AI directly (skipping Claude API).

If the Claude API call fails (any error), the agent SHOULD attempt a Workers AI fallback using `env.AI.run()` with the model from `env.WORKER_AI_MODEL`.

The fallback response MUST be prefixed with `[Fallback via Workers AI]` to indicate to the user that Claude was unavailable.

If both Claude API and Workers AI fail, the agent MUST return `{ status: 'error', result: null, error: <message> }`.

### Session Continuity

Session IDs from previous conversations are stored in KV (`session:{groupFolder}`) and D1 (`sessions` table).

Current implementation: session IDs are stored and retrieved but the Messages API is stateless — each call is independent. True conversation continuity via session IDs requires the Anthropic API beta feature when available. The current implementation passes `sessionId` in the `AgentInput` for future use.

### Response Processing

The agent MUST:
1. Extract all `content` blocks where `type === 'text'`
2. Concatenate their `.text` values
3. Return `{ status: 'success', result: text, model: response.model, usage: response.usage }`

Empty responses (no text content) MUST return `{ status: 'success', result: null }`.

## Interface Contract

```typescript
// worker/src/agent.ts

interface AgentInput {
  prompt: string;           // XML-formatted message context
  sessionId?: string;       // Prior session ID (for continuity when API supports it)
  groupFolder: string;      // e.g., "main", "family-chat"
  chatJid: string;          // Platform JID
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;   // Defaults to env.ASSISTANT_NAME
  claudeMd?: string;        // Group CLAUDE.md content from R2
  agentConfig?: {
    model?: string;         // Anthropic model ID (default: claude-opus-4-6)
    maxTokens?: number;     // Default: 4096
    timeout?: number;       // Not currently enforced at API level
    useWorkersAI?: boolean; // Skip Claude, use Workers AI directly
  };
}

interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;    // null on error or empty response
  newSessionId?: string;    // Reserved for future session API support
  error?: string;           // Present only when status === 'error'
  model?: string;           // Model used (for logging/audit)
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export function runAgent(input: AgentInput, env: Env): Promise<AgentOutput>;
```

## Security Considerations

### API Key Protection
`env.ANTHROPIC_API_KEY` MUST be passed only to the `x-api-key` header of the Anthropic API call. It MUST NOT be:
- Logged
- Included in error messages
- Returned in agent output
- Passed to Workers AI (it uses `env.AI` binding, no API key needed)

### Prompt Injection
User messages are formatted as XML and placed inside a `<messages>` block. The system prompt is constructed from trusted sources (group config, CLAUDE.md from R2). However, message content could contain XML-like structures. The `escapeXml()` function in `router.ts` MUST be applied to all user-provided content before injection into the prompt.

### Cost Controls
`maxTokens` defaults to 4096 to prevent runaway costs from adversarial prompts. Groups SHOULD use `agentConfig.maxTokens` to set lower limits for non-critical groups. The Workers AI fallback uses 2048 max tokens regardless of `agentConfig`.

## Test Cases

1. **Happy path**: valid prompt + API key → success response with text
2. **Claude API error**: 401 from Anthropic → Workers AI fallback attempted → prefixed response
3. **Both fail**: Claude + Workers AI both error → `{ status: 'error' }`
4. **Main group**: `isMain: true` → system prompt contains elevated privileges notice
5. **Custom model**: `agentConfig.model = 'claude-haiku-4-5'` → API called with that model
6. **CLAUDE.md injection**: `claudeMd` present → system prompt contains group context section
7. **Empty API response**: no text content blocks → `{ status: 'success', result: null }`
8. **Workers AI direct**: `useWorkersAI: true` → `env.AI.run()` called, Claude API not called

## Open Questions

- Session continuity via the Messages API: Anthropic's API is stateless. True multi-turn continuity requires either passing prior messages (context window approach) or the beta session/conversation API when available.

## Implementation Notes

File: `worker/src/agent.ts`

The Workers AI `env.AI.run()` call uses `never` type cast due to incomplete `@cloudflare/workers-types` typing for the messages format. This is a known issue with the types package; the runtime behavior is correct.
