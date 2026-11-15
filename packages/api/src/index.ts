import { type Context, Hono } from 'hono';
import { type LlmChain, invokeLlm, localMockLlm } from './llm.js';

export * from './llm.js';

export const app = new Hono();

app.get('/health', (c) =>
  c.json({ status: 'ok', service: 'pilgrim-api', contractVersion: 1 }),
);

// Phase 3C session contract (in-memory, per process, no expiry):
// - no sessionId => create `session-N` (N = 1,2,... deterministic counter)
// - known sessionId => append the turn to its history
// - unknown sessionId => 404 unknown_session (clients cannot mint ids)
// - history keeps only the newest MAX_HISTORY_TURNS turns (MAX_HISTORY messages); older messages
//   are folded into a deterministic `summary` (one "role: text" line each, text truncated to
//   SUMMARY_LINE_CHARS, newest SUMMARY_MAX_CHARS kept) that is sent to the LLM as `summary`.
// - at most MAX_SESSIONS sessions
//   (503 session_limit_reached beyond that).
// shortcut: no expiry/reset endpoint, upgrade when real clients need cleanup.
export const MAX_HISTORY_TURNS = 6;
export const MAX_HISTORY = MAX_HISTORY_TURNS * 2;
export const SUMMARY_LINE_CHARS = 120;
export const SUMMARY_MAX_CHARS = 2000;
export const MAX_SESSIONS = 100;
type Turn = { role: 'user' | 'assistant'; content: string };
const sessions = new Map<string, { history: Turn[]; summary: string }>();
let counter = 0;
let reserved = 0; // in-flight new-session creations
const tails = new Map<string, Promise<unknown>>(); // per-session turn queue
let llmChain: LlmChain = localMockLlm;

/** Test seam: replace the chain used by POST /chat (restored by resetSessions). */
export const setLlmChain = (chain: LlmChain) => {
  llmChain = chain;
};

/** Test/local helper: drop all sessions and restart ids at session-1. */
export const resetSessions = () => {
  sessions.clear();
  tails.clear();
  reserved = 0;
  counter = 0;
  llmChain = localMockLlm;
};

const bad = (code: string, message: string) => ({ error: { code, message } });
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

app.post('/chat', async (c) => {
  let body: unknown;
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    return c.json(bad('invalid_json', 'Request body must be valid JSON.'), 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return c.json(bad('invalid_request', 'Request body must be a JSON object.'), 400);
  }
  const { message, sessionId, ...unknown } = body as Record<string, unknown>;
  const extra = Object.keys(unknown);
  if (extra.length > 0) {
    return c.json(bad('unknown_field', `Unknown field: ${extra[0]}.`), 400);
  }
  if (!nonEmpty(message)) {
    return c.json(bad('invalid_message', 'message must be a non-empty string.'), 400);
  }
  if (sessionId !== undefined && !nonEmpty(sessionId)) {
    return c.json(bad('invalid_session_id', 'sessionId must be a non-empty string.'), 400);
  }
  const userTurn = { role: 'user' as const, content: message.trim() };
  // New session: reserve a slot synchronously so concurrent creates cannot exceed MAX_SESSIONS.
  if (sessionId === undefined) {
    if (sessions.size + reserved >= MAX_SESSIONS) {
      return c.json(bad('session_limit_reached', 'Too many active sessions.'), 503);
    }
    reserved++;
    try {
      return await runTurn(c, undefined, userTurn);
    } finally {
      reserved--;
    }
  }
  if (!sessions.has(sessionId)) {
    return c.json(bad('unknown_session', 'sessionId does not match an existing session.'), 404);
  }
  // Serialize turns per session: wait for the previous turn, then read history fresh.
  const prev = tails.get(sessionId) ?? Promise.resolve();
  const run = prev.then(() => runTurn(c, sessionId, userTurn));
  const tail = run.catch(() => undefined);
  tails.set(sessionId, tail);
  try {
    return await run;
  } finally {
    if (tails.get(sessionId) === tail) tails.delete(sessionId);
  }
});

async function runTurn(c: Context, id: string | undefined, userTurn: Turn) {
  const { history: prior, summary: priorSummary } = id === undefined ? { history: [], summary: '' } : sessions.get(id)!;
  // Call the chain before touching session state so failures leave no trace.
  let reply: string;
  try {
    reply = (await invokeLlm(llmChain, { messages: [...prior, userTurn], ...(priorSummary && { summary: priorSummary }) })).text;
  } catch {
    return c.json(bad('llm_unavailable', 'Language model is unavailable.'), 503);
  }
  id ??= `session-${++counter}`;
  const all = [...prior, userTurn, { role: 'assistant' as const, content: reply }];
  const history = all.slice(-MAX_HISTORY);
  const lines = all.slice(0, -MAX_HISTORY).map((t) => `${t.role}: ${t.content.replace(/\s+/g, ' ').slice(0, SUMMARY_LINE_CHARS)}`);
  const summary = [priorSummary, ...lines].filter(Boolean).join('\n').slice(-SUMMARY_MAX_CHARS);
  sessions.set(id, { history, summary });
  return c.json({ contractVersion: 1, sessionId: id, reply, history, summary });
}

export default app;
