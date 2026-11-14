import { describe, expect, it } from 'vitest';
import { app } from '../src/index.js';

const post = (body: string) =>
  app.request('/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body });

const ok = (sessionId: string, reply: string) =>
  `{"contractVersion":1,"sessionId":"${sessionId}","reply":"${reply}"}`;

describe('POST /chat success', () => {
  it('uses the local placeholder sessionId when none is given', async () => {
    const res = await post('{"message":"Salam"}');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe(ok('local-session', 'Local placeholder reply: Salam'));
  });

  it('echoes a provided sessionId', async () => {
    const res = await post('{"sessionId":"abc","message":"  Hi  "}');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ok('abc', 'Local placeholder reply: Hi'));
  });

  it('is repeatable and does not retain state between calls', async () => {
    const a = await (await post('{"message":"x","sessionId":"s"}')).text();
    await post('{"message":"other","sessionId":"s"}');
    const b = await (await post('{"message":"x","sessionId":"s"}')).text();
    expect(b).toBe(a);
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
