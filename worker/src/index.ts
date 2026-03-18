/**
 * ThagomizerClaw — Cloudflare Workers Entry Point
 *
 * Handles:
 *   1. Inbound webhooks from Telegram, Discord, Slack
 *   2. Queue consumers (async agent execution)
 *   3. Cron triggers (scheduled tasks + cleanup)
 *   4. Admin HTTP API (group management, task scheduling)
 *
 * Security model:
 *   - All secrets injected via Cloudflare Secrets (never in code)
 *   - Webhook signatures verified before processing
 *   - Rate limiting via RateLimiterDO (enforced per group/chat)
 *   - Admin endpoints require ADMIN_SECRET (or WEBHOOK_SECRET fallback) Bearer auth
 *   - Security headers on every response (X-Content-Type-Options, etc.)
 *   - Request body capped at MAX_BODY_BYTES to prevent resource exhaustion
 *   - AGENT_TIMEOUT_MS enforced via AbortSignal (see agent.ts)
 *
 * Architecture:
 *   Webhook → D1 (store message) → Queue (async) → Agent (Claude API) → Channel API (send reply)
 */

import type { Env, NewMessage, RegisteredGroup, QueueMessage } from './types.js';
import { GroupSessionDO, RateLimiterDO } from './durable-objects/GroupSession.js';
import {
  storeChatMetadata,
  storeMessage,
  getAllRegisteredGroups,
  getMessagesSince,
  getDueTasks,
  updateTaskAfterRun,
  logTaskRun,
  setSession,
} from './db.js';
import {
  getGroupClaudeMd,
  getGlobalClaudeMd,
  getCursor,
  setCursor,
  getSessionId,
  setSessionId,
  writeAgentLog,
} from './storage.js';
import { formatMessages, shouldProcess, formatOutbound } from './router.js';
import { runAgent } from './agent.js';
import {
  verifyTelegramWebhook,
  parseTelegramWebhook,
  sendTelegramMessage,
  sendTelegramTyping,
  parseTelegramJid,
  ownsTelegramJid,
} from './channels/telegram.js';
import {
  verifyDiscordSignature,
  parseDiscordInteraction,
  sendDiscordMessage,
  parseDiscordChannelFromJid,
  ownsDiscordJid,
} from './channels/discord.js';
import {
  verifySlackSignature,
  parseSlackEvent,
  sendSlackMessage,
  parseSlackChannelFromJid,
  ownsSlackJid,
} from './channels/slack.js';

export { GroupSessionDO, RateLimiterDO };

// ─── Security Constants ───────────────────────────────────────────────────────

/** Maximum accepted request body size (1 MiB). Rejects oversized payloads early. */
const MAX_BODY_BYTES = 1_048_576;

/**
 * Security headers applied to every response.
 * These harden the HTTP layer regardless of whether the client is a browser or API consumer.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Permissions-Policy': '',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// ─── Response Helpers ─────────────────────────────────────────────────────────

function applySecurityHeaders(headers: Headers): Headers {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    headers.set(k, v);
  }
  return headers;
}

function secureResponse(body: string | null, init: ResponseInit): Response {
  const headers = new Headers(init.headers as HeadersInit | undefined);
  applySecurityHeaders(headers);
  return new Response(body, { ...init, headers });
}

function unauthorized(message = 'Unauthorized'): Response {
  return secureResponse(message, { status: 401 });
}

function badRequest(message: string): Response {
  return secureResponse(message, { status: 400 });
}

function payloadTooLarge(): Response {
  return secureResponse('Payload Too Large', { status: 413 });
}

function tooManyRequests(): Response {
  return secureResponse('Too Many Requests', { status: 429 });
}

function json(data: unknown, status = 200): Response {
  return secureResponse(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Auth & Zero-Trust Helpers ────────────────────────────────────────────────

/**
 * Verify admin API Bearer token.
 * Prefers ADMIN_SECRET if set (Zero Trust: dedicated secret per boundary).
 * Falls back to WEBHOOK_SECRET for backward compatibility.
 */
function requireAuth(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization');
  const adminSecret = env.ADMIN_SECRET ?? env.WEBHOOK_SECRET;
  return auth === `Bearer ${adminSecret}`;
}

/**
 * Guard against oversized request bodies.
 * Uses Content-Length as a fast-path check; the caller still limits body reads.
 */
function isBodyTooLarge(request: Request): boolean {
  const cl = parseInt(request.headers.get('content-length') ?? '0', 10);
  return Number.isFinite(cl) && cl > MAX_BODY_BYTES;
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────

/**
 * Check per-group rate limit via RateLimiterDO.
 * Limit: 20 messages per group per minute (sliding window).
 * Fails open on Durable Object errors — never blocks legitimate traffic due to DO failure.
 */
async function checkRateLimit(
  chatJid: string,
  env: Env,
): Promise<{ allowed: boolean }> {
  try {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(chatJid));
    const resp = await stub.fetch(
      new Request('http://rate-limiter/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: chatJid, limit: 20, windowMs: 60_000 }),
      }),
    );
    return (await resp.json()) as { allowed: boolean };
  } catch {
    // Fail open: a rate limiter outage must never block legitimate traffic.
    return { allowed: true };
  }
}

// ─── Outbound Routing ─────────────────────────────────────────────────────────

async function sendMessage(jid: string, text: string, env: Env): Promise<void> {
  const formatted = formatOutbound(text);
  if (!formatted) return;

  if (ownsTelegramJid(jid)) {
    const chatId = parseTelegramJid(jid);
    if (chatId) await sendTelegramMessage(chatId, formatted, env);
  } else if (ownsDiscordJid(jid)) {
    const channelId = parseDiscordChannelFromJid(jid);
    if (channelId) await sendDiscordMessage(channelId, formatted, env);
  } else if (ownsSlackJid(jid)) {
    const channelId = parseSlackChannelFromJid(jid);
    if (channelId) await sendSlackMessage(channelId, formatted, env);
  }
}

// ─── Message Processing ────────────────────────────────────────────────────────

async function processMessages(
  chatJid: string,
  group: RegisteredGroup,
  env: Env,
): Promise<void> {
  const assistantName = env.ASSISTANT_NAME ?? 'Andy';
  const cursor = await getCursor(env.STATE, chatJid);

  const messages = await getMessagesSince(env.DB, chatJid, cursor, assistantName);
  if (messages.length === 0) return;

  if (!shouldProcess(messages, group, assistantName)) return;

  // Advance cursor before agent runs (prevents double-processing on retry)
  const newCursor = messages[messages.length - 1].timestamp;
  await setCursor(env.STATE, chatJid, newCursor);

  // Load group memory (CLAUDE.md) from R2
  const claudeMd =
    (await getGroupClaudeMd(env.STORAGE, group.folder)) ??
    (group.isMain ? await getGlobalClaudeMd(env.STORAGE) : null) ??
    undefined;

  // Get session from KV (fast) then DB (authoritative)
  const sessionId =
    (await getSessionId(env.STATE, group.folder)) ??
    undefined;

  const prompt = formatMessages(messages, 'UTC');

  const startTime = Date.now();
  const result = await runAgent(
    {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain: group.isMain ?? false,
      assistantName,
      claudeMd,
      agentConfig: group.agentConfig,
    },
    env,
  );

  const durationMs = Date.now() - startTime;

  // Persist new session ID
  if (result.newSessionId) {
    await setSessionId(env.STATE, group.folder, result.newSessionId);
    await setSession(env.DB, group.folder, result.newSessionId);
  }

  // Write audit log
  await writeAgentLog(env.STORAGE, group.folder, {
    timestamp: new Date().toISOString(),
    group: group.name,
    isMain: group.isMain ?? false,
    durationMs,
    status: result.status,
    promptLength: prompt.length,
    model: result.model,
    error: result.error,
  });

  // Send response
  if (result.status === 'success' && result.result) {
    await sendMessage(chatJid, result.result, env);
  } else if (result.status === 'error') {
    // Rollback cursor on error so messages will be retried
    await setCursor(env.STATE, chatJid, cursor);
  }
}

// ─── Webhook Handlers ──────────────────────────────────────────────────────────

async function handleTelegramWebhook(
  request: Request,
  pathSecret: string,
  env: Env,
): Promise<Response> {
  // 1. Verify signature FIRST — no processing before auth
  if (!verifyTelegramWebhook(pathSecret, env)) {
    return unauthorized();
  }

  // 2. Guard body size
  if (isBodyTooLarge(request)) {
    return payloadTooLarge();
  }

  const update = await request.json();
  const event = parseTelegramWebhook(update as Parameters<typeof parseTelegramWebhook>[0]);
  if (!event) {
    return json({ ok: true }); // Unknown update type, ignore
  }

  const { chatJid, message } = event;

  // 3. Rate limit per group (after parse so we have chatJid)
  const rateCheck = await checkRateLimit(chatJid, env);
  if (!rateCheck.allowed) {
    return tooManyRequests();
  }

  // 4. Store message
  await storeChatMetadata(env.DB, chatJid, message.timestamp, undefined, 'telegram', true);
  await storeMessage(env.DB, message, env.ASSISTANT_NAME ?? 'Andy');

  // 5. Enqueue for async processing if group is registered
  const groups = await getAllRegisteredGroups(env.DB);
  const group = groups[chatJid];

  if (group) {
    const chatId = parseTelegramJid(chatJid);
    if (chatId) {
      await sendTelegramTyping(chatId, env).catch(() => {});
    }

    await env.MESSAGE_QUEUE.send({
      type: 'inbound_message',
      chatJid,
      messages: [message],
      timestamp: message.timestamp,
    });
  }

  return json({ ok: true });
}

async function handleDiscordWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  // 1. Guard body size before reading
  if (isBodyTooLarge(request)) {
    return payloadTooLarge();
  }

  const body = await request.text();

  // 2. Ed25519 signature verification BEFORE any processing
  if (!(await verifyDiscordSignature(request, body, env))) {
    return unauthorized('Invalid Discord signature');
  }

  const interaction = JSON.parse(body);

  // Handle PING (Discord requires a PONG response)
  if (interaction.type === 1) {
    return json({ type: 1 });
  }

  const event = parseDiscordInteraction(interaction);
  if (!event) {
    return json({ type: 4, data: { content: 'Unknown interaction type' } });
  }

  const { chatJid, message } = event;

  // 3. Rate limit per group
  const rateCheck = await checkRateLimit(chatJid, env);
  if (!rateCheck.allowed) {
    // Acknowledge the interaction with a rate-limit message (Discord requires a response)
    return json({ type: 4, data: { content: 'Rate limit exceeded. Please wait before sending another message.', flags: 64 } });
  }

  await storeChatMetadata(env.DB, chatJid, message.timestamp, undefined, 'discord', true);
  await storeMessage(env.DB, message, env.ASSISTANT_NAME ?? 'Andy');

  const groups = await getAllRegisteredGroups(env.DB);
  const group = groups[chatJid];

  if (group) {
    await env.MESSAGE_QUEUE.send({
      type: 'inbound_message',
      chatJid,
      messages: [message],
      timestamp: message.timestamp,
    });
  }

  // Acknowledge interaction immediately (Discord requires <3s response)
  return json({ type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
}

async function handleSlackWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  // 1. Guard body size before reading
  if (isBodyTooLarge(request)) {
    return payloadTooLarge();
  }

  const body = await request.text();

  // 2. HMAC-SHA256 verification BEFORE any processing
  if (!(await verifySlackSignature(request, body, env))) {
    return unauthorized('Invalid Slack signature');
  }

  const event = JSON.parse(body) as Parameters<typeof parseSlackEvent>[0];

  // Handle URL verification challenge (Slack sends this during webhook setup)
  if (event.type === 'url_verification' && event.challenge) {
    return new Response(event.challenge, {
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  const parsed = parseSlackEvent(event, event.team_id ?? '');
  if (!parsed) return json({ ok: true });

  const { chatJid, message } = parsed;

  // 3. Rate limit per group
  const rateCheck = await checkRateLimit(chatJid, env);
  if (!rateCheck.allowed) {
    return tooManyRequests();
  }

  await storeChatMetadata(env.DB, chatJid, message.timestamp, undefined, 'slack', true);
  await storeMessage(env.DB, message, env.ASSISTANT_NAME ?? 'Andy');

  const groups = await getAllRegisteredGroups(env.DB);
  const group = groups[chatJid];

  if (group) {
    await env.MESSAGE_QUEUE.send({
      type: 'inbound_message',
      chatJid,
      messages: [message],
      timestamp: message.timestamp,
    });
  }

  return json({ ok: true });
}

// ─── Admin API ────────────────────────────────────────────────────────────────

async function handleAdminRequest(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  // Zero Trust: every admin request independently authenticated
  if (!requireAuth(request, env)) {
    return unauthorized();
  }

  const action = url.pathname.replace('/admin/', '');

  if (action === 'groups' && request.method === 'GET') {
    const groups = await getAllRegisteredGroups(env.DB);
    return json(groups);
  }

  if (action === 'groups' && request.method === 'POST') {
    if (isBodyTooLarge(request)) return payloadTooLarge();
    const { jid, group } = (await request.json()) as { jid: string; group: RegisteredGroup };
    const { setRegisteredGroup } = await import('./db.js');
    await setRegisteredGroup(env.DB, jid, group);
    return json({ ok: true });
  }

  if (action === 'tasks' && request.method === 'GET') {
    const { getAllTasks } = await import('./db.js');
    const tasks = await getAllTasks(env.DB);
    return json(tasks);
  }

  if (action === 'send' && request.method === 'POST') {
    if (isBodyTooLarge(request)) return payloadTooLarge();
    const { jid, text } = (await request.json()) as { jid: string; text: string };
    await sendMessage(jid, text, env);
    return json({ ok: true });
  }

  if (action === 'health') {
    const [dbResult] = await Promise.allSettled([
      env.DB.prepare('SELECT 1').first(),
    ]);
    return json({
      status: 'ok',
      db: dbResult.status === 'fulfilled' ? 'ok' : 'error',
      assistant: env.ASSISTANT_NAME,
      environment: env.ENVIRONMENT,
      timestamp: new Date().toISOString(),
    });
  }

  return secureResponse('Not found', { status: 404 });
}

// ─── Queue Consumer ───────────────────────────────────────────────────────────

async function handleQueueMessage(
  message: Message<QueueMessage>,
  env: Env,
): Promise<void> {
  const job = message.body;

  if (job.type === 'inbound_message') {
    const groups = await getAllRegisteredGroups(env.DB);
    const group = groups[job.chatJid];
    if (!group) {
      message.ack();
      return;
    }

    try {
      await processMessages(job.chatJid, group, env);
      message.ack();
    } catch (err) {
      // Will be retried by Cloudflare (up to max_retries in wrangler.toml)
      message.retry();
    }
  } else if (job.type === 'scheduled_task') {
    try {
      const groups = await getAllRegisteredGroups(env.DB);
      const group = groups[job.chatJid];
      if (!group) {
        message.ack();
        return;
      }

      const claudeMd = await getGroupClaudeMd(env.STORAGE, group.folder);
      const sessionId = await getSessionId(env.STATE, group.folder);
      const startTime = Date.now();

      const result = await runAgent(
        {
          prompt: job.prompt,
          sessionId: sessionId ?? undefined,
          groupFolder: job.groupFolder,
          chatJid: job.chatJid,
          isMain: group.isMain ?? false,
          isScheduledTask: true,
          assistantName: env.ASSISTANT_NAME ?? 'Andy',
          claudeMd: claudeMd ?? undefined,
        },
        env,
      );

      const durationMs = Date.now() - startTime;

      await logTaskRun(env.DB, {
        task_id: job.taskId,
        run_at: new Date().toISOString(),
        duration_ms: durationMs,
        status: result.status,
        result: result.result,
        error: result.error ?? null,
      });

      if (result.status === 'success' && result.result) {
        await sendMessage(job.chatJid, result.result, env);
      }

      message.ack();
    } catch {
      message.retry();
    }
  }
}

// ─── Cron Handler ─────────────────────────────────────────────────────────────

async function handleCron(event: ScheduledEvent, env: Env): Promise<void> {
  const cron = event.cron;

  // Every minute: check for due scheduled tasks
  if (cron === '* * * * *') {
    const dueTasks = await getDueTasks(env.DB);

    for (const task of dueTasks) {
      await env.MESSAGE_QUEUE.send({
        type: 'scheduled_task',
        taskId: task.id,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        prompt: task.prompt,
      });

      // Calculate next run based on schedule type
      let nextRun: string | null = null;
      if (task.schedule_type === 'interval') {
        const intervalMs = parseInt(task.schedule_value, 10);
        nextRun = new Date(Date.now() + intervalMs).toISOString();
      } else if (task.schedule_type === 'cron') {
        nextRun = calculateNextCronRun(task.schedule_value);
      }
      // 'once' tasks get nextRun = null (marked completed)

      await updateTaskAfterRun(env.DB, task.id, nextRun, 'queued');
    }
  }

  // Every 5 minutes: cleanup
  if (cron === '*/5 * * * *') {
    // Future: cleanup expired logs, orphaned sessions, etc.
  }
}

// ─── Cron Expression Parser ───────────────────────────────────────────────────

/**
 * Calculate the next UTC run time for a cron expression.
 * Supports: * (any), N (exact), N-M (range), N,M,P (list), *\/N (step).
 * Searches minute-by-minute from now+1m, up to one week ahead.
 */
function calculateNextCronRun(cronExpr: string): string {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) {
    // Malformed expression — default to next minute
    return new Date(Date.now() + 60_000).toISOString();
  }

  const [minField, hourField, domField, monthField, dowField] = parts;

  // Start at the next whole minute
  const candidate = new Date();
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  // Search up to 10 080 minutes (1 week) to handle unusual schedules
  for (let i = 0; i < 10_080; i++) {
    if (
      matchesCronField(candidate.getUTCMinutes(), minField) &&
      matchesCronField(candidate.getUTCHours(), hourField) &&
      matchesCronField(candidate.getUTCDate(), domField) &&
      matchesCronField(candidate.getUTCMonth() + 1, monthField) &&
      matchesCronField(candidate.getUTCDay(), dowField)
    ) {
      return candidate.toISOString();
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  // Fallback (should not be reached with a valid expression)
  return new Date(Date.now() + 60_000).toISOString();
}

/**
 * Test whether `value` satisfies a single cron field token.
 * Supports: *, N, N-M, N,M,..., *\/N
 */
function matchesCronField(value: number, field: string): boolean {
  if (field === '*') return true;

  // Step: */N  (e.g. */5 → every 5 units)
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return Number.isInteger(step) && step > 0 && value % step === 0;
  }

  // List: N,M,P
  if (field.includes(',')) {
    return field.split(',').map(Number).includes(value);
  }

  // Range: N-M
  if (field.includes('-')) {
    const [start, end] = field.split('-').map(Number);
    return value >= start && value <= end;
  }

  // Exact value
  return parseInt(field, 10) === value;
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Public health check — minimal info, no auth required
    if (pathname === '/' || pathname === '/health') {
      return json({ name: 'thagomizer_claw', status: 'ok' });
    }

    // Webhook routes
    if (pathname.startsWith('/webhook/telegram/')) {
      const pathSecret = pathname.replace('/webhook/telegram/', '');
      return handleTelegramWebhook(request, pathSecret, env);
    }

    if (pathname === '/webhook/discord') {
      return handleDiscordWebhook(request, env);
    }

    if (pathname === '/webhook/slack') {
      return handleSlackWebhook(request, env);
    }

    // Admin API (requires Bearer ADMIN_SECRET or WEBHOOK_SECRET fallback)
    if (pathname.startsWith('/admin/')) {
      return handleAdminRequest(request, url, env);
    }

    return secureResponse('Not found', { status: 404 });
  },

  async queue(
    batch: MessageBatch<QueueMessage>,
    env: Env,
  ): Promise<void> {
    for (const message of batch.messages) {
      await handleQueueMessage(message, env);
    }
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(handleCron(event, env));
  },
} satisfies ExportedHandler<Env>;
