import { beforeEach, describe, expect, it } from 'vitest';
import { app, maskPii, resetSessions, setLlmChain } from '../src/index.js';

beforeEach(resetSessions);
const post = (o: object) =>
  app.request('/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });

describe('maskPii', () => {
  it('masks emails and phones, repeatably', () => {
    const t = 'mail a.b+c@ex-ample.co.uk or call +92 300 1234567 / (021) 555-0123';
    const m = maskPii(t);
    expect(m).toBe('mail [email] or call [phone] / [phone]');
    expect(maskPii(t)).toBe(m);
    expect(maskPii(m)).toBe(m);
  });
  it('leaves non-PII text unchanged', () => {
    const t = 'Book 2 rooms for 14 nights near Haram, budget 5000.';
    expect(maskPii(t)).toBe(t);
  });
  it('is bounded and non-throwing', () => {
    expect(maskPii('a@b.co'.repeat(5000)).length).toBeLessThanOrEqual(8000);
    expect(() => maskPii('1'.repeat(8000))).not.toThrow();
  });
});

describe('POST /chat masking', () => {
  it('never sends PII (messages or summary) to the chain but keeps raw history/response', async () => {
    const seen: string[] = [];
    setLlmChain((r) => (seen.push(JSON.stringify(r)), { text: 'ok' }));
    const raw = 'me@x.com 0300 1234567';
    let b: any = await (await post({ message: raw })).json();
    expect(b.history[0].content).toBe(raw); // raw history preserved
    // 1 + 7 turns: eviction first occurs on turn 7, so turn 8 is the first chain call to receive the summary
    for (let i = 0; i < 7; i++) b = await (await post({ sessionId: 'session-1', message: `m${i}` })).json();
    expect(b.summary).toContain(raw); // raw summary preserved in API response
    expect(seen.join('')).not.toMatch(/me@x\.com|1234567/);
    expect(seen[0]).toContain('[email] [phone]');
    expect(seen.some((s) => s.includes('"summary":"user: [email] [phone]'))).toBe(true);
  });
});
