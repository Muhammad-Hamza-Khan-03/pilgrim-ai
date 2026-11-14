import { Hono } from 'hono';
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
// - history keeps only the newest MAX_HISTORY messages; at most MAX_SESSIONS sessions
//   (503 session_limit_reached beyond that).
// shortcut: no expiry/reset endpoint, upgrade when real clients need cleanup.
export const MAX_HISTORY = 20;
export const MAX_SESSIONS = 100;
type Turn = { role: 'user' | 'assistant'; content: string };
const sessions = new Map<string, Turn[]>();
let counter = 0;
let llmChain: LlmChain = localMockLlm;

/** Test seam: replace the chain used by POST /chat (restored by resetSessions). */
export const setLlmChain = (chain: LlmChain) => {
  llmChain = chain;
};

/** Test/local helper: drop all sessions and restart ids at session-1. */
export const resetSessions = () => {
  sessions.clear();
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
  let id: string | undefined;
  let prior: Turn[] = [];
  if (sessionId === undefined) {
    if (sessions.size >= MAX_SESSIONS) {
      return c.json(bad('session_limit_reached', 'Too many active sessions.'), 503);
    }
  } else if (sessions.has(sessionId)) {
    id = sessionId;
    prior = sessions.get(id)!;
  } else {
    return c.json(bad('unknown_session', 'sessionId does not match an existing session.'), 404);
  }
  // Call the chain before touching session state so failures leave no trace.
  const userTurn = { role: 'user' as const, content: message.trim() };
  let reply: string;
  try {
    reply = (await invokeLlm(llmChain, { messages: [...prior, userTurn] })).text;
  } catch {
    return c.json(bad('llm_unavailable', 'Language model is unavailable.'), 503);
  }
  id ??= `session-${++counter}`;
  const history = [
    ...prior,
    userTurn,
    { role: 'assistant' as const, content: reply },
  ].slice(-MAX_HISTORY);
  sessions.set(id, history);
  return c.json({ contractVersion: 1, sessionId: id, reply, history });
});

export default app;
