import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_HISTORY, MAX_SESSIONS, app, resetSessions } from '../src/index.js';

beforeEach(resetSessions);

const post = (body: string) =>
  app.request('/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body });

const turns = (...m: string[]) =>
  m.flatMap((x) => [
    { role: 'user', content: x },
    { role: 'assistant', content: `Local placeholder reply: ${x}` },
  ]);
const ok = (sessionId: string, ...m: string[]) =>
  JSON.stringify({
    contractVersion: 1,
    sessionId,
    reply: `Local placeholder reply: ${m[m.length - 1]}`,
    history: turns(...m),
  });
const json = (r: Response) => r.json() as Promise<any>;

describe('POST /chat sessions', () => {
  it('creates deterministic session ids when none is given', async () => {
    const res = await post('{"message":"Salam"}');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe(ok('session-1', 'Salam'));
    expect((await json(await post('{"message":"  Hi  "}'))).sessionId).toBe('session-2');
  });

  it('accumulates history on a known session', async () => {
    await post('{"message":"a"}');
    const res = await post('{"sessionId":"session-1","message":" b "}');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ok('session-1', 'a', 'b'));
  });

  it('keeps sessions isolated', async () => {
    await post('{"message":"a"}');
    await post('{"message":"b"}');
    expect((await json(await post('{"sessionId":"session-2","message":"c"}'))).history).toEqual(turns('b', 'c'));
  });

  it('rejects unknown sessionIds with 404', async () => {
    const res = await post('{"sessionId":"abc","message":"x"}');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(
      '{"error":{"code":"unknown_session","message":"sessionId does not match an existing session."}}',
    );
  });

  it('bounds history to the newest MAX_HISTORY messages', async () => {
    await post('{"message":"m0"}');
    let last: any;
    for (let i = 1; i <= MAX_HISTORY; i++) {
      last = await json(await post(`{"sessionId":"session-1","message":"m${i}"}`));
    }
    expect(last.history).toHaveLength(MAX_HISTORY);
    expect(last.history[0].content).toBe(`m${MAX_HISTORY / 2 + 1}`);
    expect(last.history.at(-1).content).toBe(`Local placeholder reply: m${MAX_HISTORY}`);
  });

  it('caps the number of sessions, existing ones keep working', async () => {
    for (let i = 0; i < MAX_SESSIONS; i++) await post('{"message":"x"}');
    const res = await post('{"message":"x"}');
    expect(res.status).toBe(503);
    expect((await json(res)).error.code).toBe('session_limit_reached');
    expect((await post('{"sessionId":"session-1","message":"y"}')).status).toBe(200);
  });

  it('resetSessions restarts ids and forgets sessions', async () => {
    await post('{"message":"x"}');
    resetSessions();
    expect((await post('{"sessionId":"session-1","message":"x"}')).status).toBe(404);
    expect((await json(await post('{"message":"x"}'))).sessionId).toBe('session-1');
  });
});

describe('POST /chat validation', () => {
  const err = (code: string, message: string) => `{"error":{"code":"${code}","message":"${message}"}}`;

  it.each([
    ['{bad', 'invalid_json', 'Request body must be valid JSON.'],
    ['', 'invalid_json', 'Request body must be valid JSON.'],
    ['null', 'invalid_request', 'Request body must be a JSON object.'],
    ['[]', 'invalid_request', 'Request body must be a JSON object.'],
    ['"hi"', 'invalid_request', 'Request body must be a JSON object.'],
    ['{}', 'invalid_message', 'message must be a non-empty string.'],
    ['{"message":""}', 'invalid_message', 'message must be a non-empty string.'],
    ['{"message":"   "}', 'invalid_message', 'message must be a non-empty string.'],
    ['{"message":5}', 'invalid_message', 'message must be a non-empty string.'],
    ['{"message":"a","sessionId":""}', 'invalid_session_id', 'sessionId must be a non-empty string.'],
    ['{"message":"a","sessionId":" "}', 'invalid_session_id', 'sessionId must be a non-empty string.'],
    ['{"message":"a","sessionId":1}', 'invalid_session_id', 'sessionId must be a non-empty string.'],
    ['{"message":"a","sessionId":null}', 'invalid_session_id', 'sessionId must be a non-empty string.'],
    ['{"message":"a","extra":1}', 'unknown_field', 'Unknown field: extra.'],
  ])('rejects %s', async (body, code, message) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe(err(code, message));
  });
});

describe('/chat routing', () => {
  it.each(['GET', 'PUT', 'PATCH', 'DELETE'])('%s returns 404', async (method) => {
    expect((await app.request('/chat', { method })).status).toBe(404);
  });

  it('leaves /health unchanged', async () => {
    expect(await (await app.request('/health')).text()).toBe(
      '{"status":"ok","service":"pilgrim-api","contractVersion":1}',
    );
  });
});
