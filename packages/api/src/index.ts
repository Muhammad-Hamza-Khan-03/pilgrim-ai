import { Hono } from 'hono';

export const app = new Hono();

app.get('/health', (c) =>
  c.json({ status: 'ok', service: 'pilgrim-api', contractVersion: 1 }),
);

const LOCAL_SESSION_ID = 'local-session';

// Seam for a future provider: deterministic, derived only from the message.
const localReply = (message: string) => `Local placeholder reply: ${message.trim()}`;

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
  return c.json({
    contractVersion: 1,
    sessionId: sessionId ?? LOCAL_SESSION_ID,
    reply: localReply(message),
  });
});

export default app;
