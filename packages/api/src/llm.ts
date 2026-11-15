export const LLM_MAX_MESSAGES = 64;
export const LLM_MAX_CONTENT_CHARS = 8000;

export type LlmMessage = { readonly role: 'user' | 'assistant'; readonly content: string };
export type LlmRequest = { readonly messages: readonly LlmMessage[]; readonly summary?: string };
export type LlmResponse = { readonly text: string };
export type LlmChain = (request: LlmRequest) => LlmResponse | Promise<LlmResponse>;

export type LlmErrorCode = 'invalid_request' | 'llm_unavailable';
export class LlmError extends Error {
  constructor(readonly code: LlmErrorCode, message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function validateLlmRequest(request: unknown): asserts request is LlmRequest {
  const bad = (m: string): never => {
    throw new LlmError('invalid_request', m);
  };
  const messages = isObj(request) ? request.messages : undefined;
  const summary = isObj(request) ? request.summary : undefined;
  if (summary !== undefined && (typeof summary !== 'string' || summary.length > LLM_MAX_CONTENT_CHARS)) {
    return bad('summary must be a string of bounded length.');
  }
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > LLM_MAX_MESSAGES) {
    return bad(`messages must have 1-${LLM_MAX_MESSAGES} entries.`);
  }
  for (const m of messages) {
    if (!isObj(m) || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      return bad('Each message needs a user|assistant role and string content.');
    }
    if (m.content.length > LLM_MAX_CONTENT_CHARS) return bad('Message content is too long.');
  }
  if (messages[messages.length - 1].role !== 'user') return bad('Last message must be from user.');
}

/** Deterministic local mock: no network, no provider. */
export const localMockLlm: LlmChain = ({ messages }) => {
  validateLlmRequest({ messages });
  return { text: `Local placeholder reply: ${messages[messages.length - 1].content.trim()}` };
};

/** Validates the request, calls the chain, validates the response; any failure is an LlmError. */
export async function invokeLlm(chain: LlmChain, request: LlmRequest): Promise<LlmResponse> {
  validateLlmRequest(request);
  let res: unknown;
  try {
    res = await chain(request);
  } catch (e) {
    if (e instanceof LlmError) throw e;
    throw new LlmError('llm_unavailable', 'Language model is unavailable.');
  }
  if (!isObj(res) || typeof res.text !== 'string' || res.text.length > LLM_MAX_CONTENT_CHARS) {
    throw new LlmError('llm_unavailable', 'Language model is unavailable.');
  }
  return { text: res.text };
}

const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+/g;
// shortcut: phone-like = 7-15 digits with optional separators and leading +; no names/NER, upgrade with a real PII detector.
const PHONE_RE = /(?!\d{4}-\d{2}-\d{2}\b)\+?\(?\d(?:(?:[\s.-]?\(?|\)[\s.-]?)\d){6,14}/g;

/** Pure, deterministic, non-throwing masking of emails and phone-like numbers; output capped at LLM_MAX_CONTENT_CHARS. */
export function maskPii(text: string): string {
  if (typeof text !== 'string') return '';
  return text.replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[phone]').slice(0, LLM_MAX_CONTENT_CHARS);
}

/** Deep copy of a request with all message contents and the summary masked. */
export function maskLlmRequest(request: LlmRequest): LlmRequest {
  return {
    messages: request.messages.map((m) => ({ role: m.role, content: maskPii(m.content) })),
    ...(request.summary !== undefined && { summary: maskPii(request.summary) }),
  };
}
