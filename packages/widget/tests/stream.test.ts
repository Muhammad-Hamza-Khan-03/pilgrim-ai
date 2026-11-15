import { describe, expect, it } from 'vitest';
import { ChatClientError } from '../src/chat.js';
import { createSseParser, streamChat, type StreamOpen, type StreamTimer } from '../src/stream.js';

const ev = (e: string, d: string) => `event: ${e}\ndata: ${d}\n\n`;
const chunk = (t: string) => ev('chunk', JSON.stringify({ text: t }));
const DONE = ev('done', '{}');
async function* gen(...pieces: string[]) { for (const p of pieces) yield p; }
const src = (...pieces: string[]): StreamOpen => async () => gen(...pieces);
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e as ChatClientError).code);
// Manual timer: fire() runs the pending timeout.
function fakeTimer() {
  const fns = new Map<number, () => void>();
  let n = 0;
  const timer: StreamTimer = { set: (f) => { fns.set(++n, f); return n; }, clear: (h) => { fns.delete(h as number); } };
  return { timer, fire: () => [...fns.values()].forEach((f) => f()), pending: () => fns.size };
}
const never = <T>() => new Promise<T>(() => {});

describe('createSseParser', () => {
  it('parses split pieces, CRLF/CR, comments, multi-line data and ignores unknown fields', () => {
    const p = createSseParser();
    const out = [
      ...p.push(': hi\r\nevent: chunk\r\nda'), ...p.push('ta: a\r'), ...p.push('\ndata:b\nid: 7\n\r'),
      ...p.push('\nevent: done\rdata: x\r\r'),
    ];
    expect(out).toEqual([{ event: 'chunk', data: 'a\nb' }, { event: 'done', data: 'x' }]);
  });
  it('rejects oversized lines', () => {
    expect(() => createSseParser().push('data: ' + 'x'.repeat(200_000))).toThrow(ChatClientError);
  });
});

describe('streamChat', () => {
  it('accumulates chunks in order and completes on done, ignoring input after done', async () => {
    const got: string[] = [];
    const full = await streamChat(src(chunk('Hel'), chunk('lo'), DONE, 'garbage'), 'q', { onChunk: (t) => got.push(t) });
    expect([full, got]).toEqual(['Hello', ['Hel', 'lo']]);
  });
  it.each([
    ['unknown event', ev('weird', '{}')],
    ['non-JSON', ev('chunk', 'nope')],
    ['wrong shape', ev('chunk', '{"text":1}')],
    ['truncated (no done)', chunk('a')],
  ])('malformed: %s', async (_n, piece) => {
    expect(await code(streamChat(src(piece), 'q', { onChunk() {} }))).toBe('malformed_stream');
  });
  it('is not retried when malformed', async () => {
    let opens = 0;
    const open: StreamOpen = async () => { opens++; return gen(ev('x', '')); };
    await code(streamChat(open, 'q', { onChunk() {}, retries: 3 }));
    expect(opens).toBe(1);
  });
  it('aborts: pre-aborted, and mid-stream closes the iterator and signals the source', async () => {
    const pre = new AbortController(); pre.abort();
    expect(await code(streamChat(src(DONE), 'q', { onChunk() {}, signal: pre.signal }))).toBe('aborted');
    const ac = new AbortController();
    let closed = false; let srcSignal!: AbortSignal;
    const open: StreamOpen = async ({ signal }) => {
      srcSignal = signal;
      return { [Symbol.asyncIterator]: () => ({ next: () => never<IteratorResult<string>>(), return: async () => { closed = true; return { done: true as const, value: undefined }; } }) };
    };
    const p = code(streamChat(open, 'q', { onChunk() {}, signal: ac.signal, retries: 2 }));
    await Promise.resolve(); await Promise.resolve();
    ac.abort();
    expect(await p).toBe('aborted');
    expect([closed, srcSignal.aborted]).toEqual([true, true]);
  });
  it('aborting synchronously from onChunk rejects the next stalled wait as aborted, not timeout', async () => {
    const ac = new AbortController();
    const t = fakeTimer();
    let closed = false;
    const open: StreamOpen = async () => {
      let i = 0;
      return { [Symbol.asyncIterator]: () => ({
        next: () => (i++ === 0 ? Promise.resolve({ done: false as const, value: chunk('a') }) : never<IteratorResult<string>>()),
        return: async () => { closed = true; return { done: true as const, value: undefined }; },
      }) };
    };
    const p = code(streamChat(open, 'q', { onChunk: () => ac.abort(), signal: ac.signal, timer: t.timer, retries: 2 }));
    expect(await p).toBe('aborted'); // timer never fired
    expect([closed, t.pending()]).toEqual([true, 0]);
  });
  it('times out a stalled wait, clears timers on success', async () => {
    const t = fakeTimer();
    const stalled: StreamOpen = async () => ({ [Symbol.asyncIterator]: () => ({ next: () => never<IteratorResult<string>>() }) });
    const p = code(streamChat(stalled, 'q', { onChunk() {}, timer: t.timer }));
    await Promise.resolve(); await Promise.resolve();
    t.fire();
    expect(await p).toBe('timeout');
    const t2 = fakeTimer();
    await streamChat(src(DONE), 'q', { onChunk() {}, timer: t2.timer });
    expect(t2.pending()).toBe(0);
  });
  it('maps source failures to network_error without leaking the message', async () => {
    const open: StreamOpen = async () => { throw new Error('secret-host down'); };
    const e = (await streamChat(open, 'q', { onChunk() {} }).catch((x) => x)) as ChatClientError;
    expect([e.code, e.message.includes('secret')]).toEqual(['network_error', false]);
  });
  it('retries network errors before any chunk, up to the limit', async () => {
    let opens = 0;
    const open: StreamOpen = async () => { if (++opens < 3) throw new Error('x'); return gen(chunk('ok'), DONE); };
    expect(await streamChat(open, 'q', { onChunk() {}, retries: 2 })).toBe('ok');
    expect(opens).toBe(3);
    opens = -5;
    expect(await code(streamChat(open, 'q', { onChunk() {}, retries: 1 }))).toBe('network_error');
  });
  it('does not retry after a chunk was delivered', async () => {
    let opens = 0;
    const open: StreamOpen = async () => { opens++; return (async function* () { yield chunk('a'); throw new Error('drop'); })(); };
    const got: string[] = [];
    expect(await code(streamChat(open, 'q', { onChunk: (t) => got.push(t), retries: 3 }))).toBe('network_error');
    expect([opens, got]).toEqual([1, ['a']]);
  });
});
