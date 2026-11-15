// Streaming seam: safe SSE parsing + injected, deterministic stream transport. No globals, no network.
import { ChatClientError } from './chat.js';

export interface SseEvent { event: string; data: string }
export type StreamOpen = (req: { message: string; signal: AbortSignal }) => Promise<AsyncIterable<string>>;
export interface StreamTimer { set(fn: () => void, ms: number): unknown; clear(h: unknown): void }

const MAX_EVENT = 64 * 1024;
const MAX_TOTAL = 1024 * 1024;
const bad = (m: string) => new ChatClientError('malformed_stream', m);

export function createSseParser() {
  let buf = '';
  let skipLF = false;
  let event = '';
  let data: string[] = [];
  return {
    push(piece: string): SseEvent[] {
      if (skipLF && piece[0] === '\n') piece = piece.slice(1);
      skipLF = piece !== '' ? piece.endsWith('\r') : skipLF; // a "\r" at a piece edge may be half of "\r\n"
      buf += piece;
      if (buf.length > MAX_EVENT * 2) throw bad('Stream line too long.');
      const out: SseEvent[] = [];
      const lines = buf.split(/\r\n|\r|\n/);
      buf = lines.pop()!;
      for (const line of lines) {
        if (line === '') {
          if (data.length) out.push({ event, data: data.join('\n') });
          event = ''; data = [];
        } else if (line[0] !== ':') {
          const i = line.indexOf(':');
          const name = i < 0 ? line : line.slice(0, i);
          const v = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
          if (name === 'event') event = v;
          else if (name === 'data') { data.push(v); if (data.join('\n').length > MAX_EVENT) throw bad('Stream event too large.'); }
        }
      }
      return out;
    },
  };
}

function decode(ev: SseEvent): { done: true } | { text: string } {
  if (ev.event === 'done') return { done: true };
  if (ev.event !== 'chunk') throw bad('Unknown stream event.');
  let j: unknown;
  try { j = JSON.parse(ev.data); } catch { throw bad('Stream event is not JSON.'); }
  const t = (j as { text?: unknown } | null)?.text;
  if (typeof t !== 'string') throw bad('Stream chunk has no text.');
  return { text: t };
}

export interface StreamOptions {
  onChunk(text: string): void;
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
  timer?: StreamTimer;
}

async function attempt(open: StreamOpen, message: string, o: StreamOptions, state: { sent: boolean }): Promise<string> {
  const ctl = new AbortController();
  const timer = o.timer ?? { set: (f, ms) => setTimeout(f, ms), clear: (h) => clearTimeout(h as never) };
  if (o.signal?.aborted) throw new ChatClientError('aborted', 'Chat request aborted.');
  // Races p against the timeout and the caller's abort; either aborts the attempt.
  const guard = <T>(p: Promise<T>) => new Promise<T>((res, rej) => {
    const fail = (e: ChatClientError) => { ctl.abort(); rej(e); };
    const h = timer.set(() => fail(new ChatClientError('timeout', 'Chat request timed out.')), o.timeoutMs ?? 30000);
    const ab = () => fail(new ChatClientError('aborted', 'Chat request aborted.'));
    o.signal?.addEventListener('abort', ab);
    const end = () => { timer.clear(h); o.signal?.removeEventListener('abort', ab); };
    p.then((v) => { end(); res(v); }, () => { end(); rej(new ChatClientError('network_error', 'Chat stream failed.')); });
  });
  let it: AsyncIterator<string> | undefined;
  try {
    it = (await guard(open({ message, signal: ctl.signal })))[Symbol.asyncIterator]();
    const parser = createSseParser();
    let full = '';
    for (;;) {
      const r = await guard(it.next());
      if (r.done) throw bad('Stream ended before completion.');
      for (const ev of parser.push(r.value)) {
        const d = decode(ev);
        if ('done' in d) return full;
        full += d.text;
        if (full.length > MAX_TOTAL) throw bad('Stream too large.');
        state.sent = true;
        o.onChunk(d.text);
      }
    }
  } finally {
    void Promise.resolve(it?.return?.()).catch(() => {});
  }
}

/** Streams one reply; resolves to the full text on `done`. Retries only pre-chunk network/timeout failures. */
export async function streamChat(open: StreamOpen, message: string, o: StreamOptions): Promise<string> {
  for (let left = o.retries ?? 0; ; left--) {
    const state = { sent: false };
    try {
      return await attempt(open, message, o, state);
    } catch (e) {
      const retryable = e instanceof ChatClientError && (e.code === 'network_error' || e.code === 'timeout');
      if (!retryable || state.sent || left <= 0) throw e;
    }
  }
}
