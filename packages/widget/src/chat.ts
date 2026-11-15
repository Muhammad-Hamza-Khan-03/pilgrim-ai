// Chat bundle seam: provider-neutral client for the API's POST /chat JSON contract (contractVersion 1).
// Fetch is injected; nothing here touches globals or the network on its own.
export interface ChatTurn { role: 'user' | 'assistant'; content: string }
export interface ChatResponse { contractVersion: 1; sessionId: string; reply: string; history: ChatTurn[]; summary: string }
export interface FetchResponseLike { ok: boolean; status: number; json(): Promise<unknown> }
export type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<FetchResponseLike>;

export type ChatErrorCode = 'invalid_config' | 'invalid_message' | 'network_error' | 'http_error' | 'invalid_response';
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
