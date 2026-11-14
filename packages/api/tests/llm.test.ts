import { beforeEach, describe, expect, it } from 'vitest';
import {
  LlmError,
  app,
  invokeLlm,
  localMockLlm,
  resetSessions,
  setLlmChain,
  type LlmChain,
} from '../src/index.js';

beforeEach(resetSessions);

const u = (content: string) => ({ role: 'user' as const, content });
const post = (body: object) =>
  app.request('/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const code = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as LlmError).code;
const j = async (p: Response | Promise<Response>) => (await p).json() as Promise<any>;

describe('llm boundary', () => {
  it('mock is deterministic and trims', async () => {
    expect(await localMockLlm({ messages: [u('a'), { role: 'assistant', content: 'x' }, u('  hi  ')] })).toEqual({
      text: 'Local placeholder reply: hi',
    });
  });

  it.each([
    ['empty', []],
    ['too many', Array(65).fill(u('a'))],
    ['ends in assistant', [u('a'), { role: 'assistant', content: 'b' }]],
    ['bad role', [{ role: 'system', content: 'a' }]],
    ['non-string', [{ role: 'user', content: 1 }]],
    ['too long', [u('a'.repeat(8001))]],
  ])('rejects %s', async (_n, messages) => {
    expect(await code(invokeLlm(localMockLlm, { messages } as any))).toBe('invalid_request');
  });

  it('accepts the bounds', async () => {
    const r = await invokeLlm(() => ({ text: 'b'.repeat(8000) }), { messages: Array(64).fill(u('a'.repeat(8000))) });
    expect(r.text).toHaveLength(8000);
  });

  it('rejects malformed or oversized responses and wraps throws', async () => {
    for (const bad of [null, {}, { text: 1 }, { text: 'a'.repeat(8001) }]) {
      expect(await code(invokeLlm((() => bad) as any, { messages: [u('a')] }))).toBe('llm_unavailable');
    }
    const boom: LlmChain = () => {
      throw new Error('secret');
    };
    const e: any = await invokeLlm(boom, { messages: [u('a')] }).catch((x) => x);
    expect(e).toBeInstanceOf(LlmError);
    expect(e.message).not.toContain('secret');
  });
});

describe('POST /chat with chain', () => {
  it('passes history plus new user turn and uses the reply', async () => {
    const seen: unknown[] = [];
    setLlmChain((r) => (seen.push(r.messages), { text: 'R' + r.messages.length }));
    const a = await j(post({ message: 'one' }));
    expect(a.reply).toBe('R1');
    const b = await j(post({ message: ' two ', sessionId: a.sessionId }));
    expect(b.history).toEqual([u('one'), { role: 'assistant', content: 'R1' }, u('two'), { role: 'assistant', content: 'R3' }]);
    expect(seen[1]).toEqual([u('one'), { role: 'assistant', content: 'R1' }, u('two')]);
  });

  it.each([
    ['throw', () => { throw new Error('secret'); }],
    ['malformed', () => ({ text: 5 })],
    ['oversized', () => ({ text: 'a'.repeat(8001) })],
  ])('maps %s to 503 without side effects', async (_n, chain) => {
    setLlmChain(chain as any);
    const res = await post({ message: 'x' });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"error":{"code":"llm_unavailable","message":"Language model is unavailable."}}');
    setLlmChain(localMockLlm);
    expect((await j(post({ message: 'y' }))).sessionId).toBe('session-1');
  });

  it('keeps existing session history on failure', async () => {
    const a = await j(post({ message: 'one' }));
    setLlmChain(() => { throw new Error('x'); });
    expect((await post({ message: 'two', sessionId: a.sessionId })).status).toBe(503);
    setLlmChain(localMockLlm);
    const c = await j(post({ message: 'three', sessionId: a.sessionId }));
    expect(c.history).toHaveLength(4);
  });

  it('resetSessions restores the default mock', async () => {
    setLlmChain(() => ({ text: 'custom' }));
    resetSessions();
    expect((await j(post({ message: 'hi' }))).reply).toBe('Local placeholder reply: hi');
  });
});
