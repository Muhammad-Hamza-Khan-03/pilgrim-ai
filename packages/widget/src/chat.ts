// Chat bundle seam: provider-neutral client for the API's POST /chat JSON contract (contractVersion 1).
// Fetch is injected; nothing here touches globals or the network on its own.
export interface ChatTurn { role: 'user' | 'assistant'; content: string }
export interface ChatResponse { contractVersion: 1; sessionId: string; reply: string; history: ChatTurn[]; summary: string }
export interface FetchResponseLike { ok: boolean; status: number; json(): Promise<unknown> }
export type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<FetchResponseLike>;

export type ChatErrorCode = 'invalid_config' | 'invalid_message' | 'network_error' | 'http_error' | 'invalid_response' | 'malformed_stream' | 'timeout' | 'aborted';
export class ChatClientError extends Error {
  constructor(readonly code: ChatErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = 'ChatClientError';
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string';

function parse(body: unknown): ChatResponse | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.contractVersion !== 1 || !isStr(b.sessionId) || b.sessionId === '' || !isStr(b.reply) || !isStr(b.summary)) return null;
  if (!Array.isArray(b.history)) return null;
  for (const t of b.history) {
    const r = t as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || (r.role !== 'user' && r.role !== 'assistant') || !isStr(r.content)) return null;
  }
  return b as unknown as ChatResponse;
}

export function createChatClient(opts: { apiUrl: string; fetch: FetchLike; sessionId?: string }) {
  let endpoint: string;
  try {
    const u = new URL(opts.apiUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
    if (/[?#]/.test(opts.apiUrl)) throw new Error(); // query/fragment would corrupt the appended /chat path
    endpoint = `${u.href.replace(/\/+$/, '')}/chat`;
  } catch {
    throw new ChatClientError('invalid_config', 'apiUrl must be an http(s) URL.');
  }
  let sessionId = opts.sessionId;
  return {
    get sessionId() { return sessionId; },
    async send(message: string): Promise<ChatResponse> {
      const text = message.trim();
      if (!text) throw new ChatClientError('invalid_message', 'message must be non-empty.');
      let res: FetchResponseLike;
      try {
        res = await opts.fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(sessionId ? { message: text, sessionId } : { message: text }),
        });
      } catch {
        throw new ChatClientError('network_error', 'Chat request failed.');
      }
      if (!res.ok) throw new ChatClientError('http_error', `Chat request failed with status ${res.status}.`, res.status);
      let parsed: ChatResponse | null;
      try {
        parsed = parse(await res.json());
      } catch {
        parsed = null;
      }
      if (!parsed) throw new ChatClientError('invalid_response', 'Malformed chat response.');
      sessionId = parsed.sessionId;
      return parsed;
    },
  };
}

// Browser auto-run: the loader injects this script on launcher activation; mount the panel then.
// The page's fetch is injected here at the edge; the panel itself never touches globals.
import { mountPanel, type PanelDocument } from './panel.js';
export { mountPanel };
interface ScriptLike { getAttribute(n: string): string | null }
const g = globalThis as { document?: PanelDocument & { currentScript?: ScriptLike | null; querySelector(s: string): { setAttribute(n: string, v: string): void; addEventListener(t: string, l: () => void): void } | null }; fetch?: FetchLike };
const cur = g.document?.currentScript;
if (g.document && cur && cur.getAttribute('data-pilgrim-bundle') !== null) {
  const doc = g.document;
  let client: ReturnType<typeof createChatClient> | null = null;
  try {
    const api = cur.getAttribute('data-api-url');
    if (api && g.fetch) client = createChatClient({ apiUrl: api, fetch: g.fetch.bind(globalThis) as FetchLike });
  } catch { /* invalid config: panel shows a typed error on submit */ }
  const launcher = doc.querySelector('[data-pilgrim-launcher]');
  const expanded = (v: boolean) => launcher?.setAttribute('aria-expanded', String(v));
  const panel = mountPanel(doc, { client, onClose: () => expanded(false), onOpen: () => expanded(true) });
  // The loader ignores clicks once this bundle exists, so the bundle owns reopen/toggle.
  launcher?.addEventListener('click', panel.toggle);
}
