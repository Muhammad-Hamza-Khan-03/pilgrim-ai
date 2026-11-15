import { describe, expect, it } from 'vitest';
import { ChatClientError, createChatClient, type FetchLike } from '../src/chat.js';

const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const good = (sessionId = 'session-1', reply = 'hi') => ({
  contractVersion: 1, sessionId, reply, history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: reply }], summary: '',
});
function mk(responses: unknown[]) {
  const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return r as never;
  };
  return { calls, client: createChatClient({ apiUrl: 'https://api.test/', fetch }) };
}

describe('chat client', () => {
  it('posts {message} without sessionId first, then retains sessionId', async () => {
    const { client, calls } = mk([ok(good()), ok(good('session-1', 'again'))]);
    const r = await client.send('hello');
    expect(r.reply).toBe('hi');
    expect(calls[0]!.url).toBe('https://api.test/chat');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ message: 'hello' });
    expect(client.sessionId).toBe('session-1');
    await client.send('more');
    expect(JSON.parse(calls[1]!.init.body)).toEqual({ message: 'more', sessionId: 'session-1' });
  });

  it('can resume from an initial sessionId', async () => {
    const fetch: FetchLike = async (_u, init) => {
      expect(JSON.parse(init.body).sessionId).toBe('session-9');
      return ok(good('session-9')) as never;
    };
    await createChatClient({ apiUrl: 'https://api.test', fetch, sessionId: 'session-9' }).send('x');
  });

  it('rejects malformed responses and keeps prior sessionId', async () => {
    const bads = [
      null, [], { ...good(), contractVersion: 2 }, { ...good(), sessionId: '' }, { ...good(), reply: 1 },
      { ...good(), history: [{ role: 'system', content: 'x' }] }, { ...good(), history: 'no' }, { ...good(), summary: null },
    ];
    for (const b of bads) {
      const { client } = mk([ok(good()), ok(b)]);
      await client.send('a');
      await expect(client.send('b')).rejects.toMatchObject({ code: 'invalid_response' });
      expect(client.sessionId).toBe('session-1');
    }
  });

  it('types http failures, network failures, and non-JSON bodies', async () => {
    const { client } = mk([
      ok({ error: { code: 'unknown_session' } }, 404), new Error('down'),
      { ok: true, status: 200, json: async () => { throw new Error('x'); } }, ok({}, 500),
    ]);
    const err = await client.send('a').catch((e) => e);
    expect(err).toBeInstanceOf(ChatClientError);
    expect(err).toMatchObject({ code: 'http_error', status: 404 });
    await expect(client.send('a')).rejects.toMatchObject({ code: 'network_error' });
    await expect(client.send('a')).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(client.send('a')).rejects.toMatchObject({ code: 'http_error', status: 500 });
  });

  it('rejects apiUrl with query or fragment as invalid_config', () => {
    const fetch: FetchLike = async () => { throw new Error('should not call'); };
    for (const apiUrl of ['https://a.test/x?q=1', 'https://a.test/x#frag', 'https://a.test/x?', 'https://a.test/x#']) {
      expect(() => createChatClient({ apiUrl, fetch })).toThrowError(expect.objectContaining({ code: 'invalid_config' }));
    }
  });

  it('fails closed on bad config or empty message without calling fetch', async () => {
    const fetch: FetchLike = async () => { throw new Error('should not call'); };
    expect(() => createChatClient({ apiUrl: 'javascript:1', fetch })).toThrow(ChatClientError);
    expect(() => createChatClient({ apiUrl: '', fetch })).toThrow(ChatClientError);
    const c = createChatClient({ apiUrl: 'https://api.test', fetch });
    await expect(c.send('   ')).rejects.toMatchObject({ code: 'invalid_message' });
  });
});
