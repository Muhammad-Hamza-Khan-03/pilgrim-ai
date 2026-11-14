import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_HISTORY, MAX_HISTORY_TURNS, SUMMARY_MAX_CHARS, app, resetSessions, setLlmChain } from '../src/index.js';

beforeEach(resetSessions);
const post = (o: object) =>
  app.request('/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });

describe('rolling summary', () => {
  it('keeps 6 turns, summarizes evicted ones, and sends the summary to the LLM', async () => {
    expect(MAX_HISTORY).toBe(MAX_HISTORY_TURNS * 2);
    const seen: any[] = [];
    setLlmChain((r) => (seen.push(r), { text: 'R' }));
    let b: any = await (await post({ message: 'm1' })).json();
    expect(b.summary).toBe('');
    for (let i = 2; i <= 8; i++) b = await (await post({ sessionId: 'session-1', message: `m${i}` })).json();
    expect(b.history).toHaveLength(12);
    expect(b.history[0].content).toBe('m3');
    expect(b.summary).toBe('user: m1\nassistant: R\nuser: m2\nassistant: R');
    expect(seen[6].summary).toBeUndefined(); // 7th request: nothing evicted yet
    expect(seen[7].summary).toBe('user: m1\nassistant: R'); // 8th request sees the 7th turn's eviction
  });

  it('bounds the summary to the newest SUMMARY_MAX_CHARS', async () => {
    setLlmChain(() => ({ text: 'R' }));
    await post({ message: 'a' });
    let b: any;
    for (let i = 0; i < 100; i++) b = await (await post({ sessionId: 'session-1', message: 'x'.repeat(500) })).json();
    expect(b.summary.length).toBe(SUMMARY_MAX_CHARS);
  });

  it('failed turn leaves summary and history unchanged', async () => {
    setLlmChain(() => ({ text: 'R' }));
    await post({ message: 'a' });
    let b: any;
    for (let i = 0; i < 7; i++) b = await (await post({ sessionId: 'session-1', message: 'b' })).json();
    setLlmChain(() => {
      throw new Error('x');
    });
    expect((await post({ sessionId: 'session-1', message: 'c' })).status).toBe(503);
    setLlmChain(() => ({ text: 'R' }));
    const n: any = await (await post({ sessionId: 'session-1', message: 'c' })).json();
    expect(n.summary).toBe(`${b.summary}\nuser: ${b.history[0].content}\nassistant: ${b.history[1].content}`);
  });
});
