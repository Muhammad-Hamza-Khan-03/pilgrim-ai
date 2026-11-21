// Strict, minimal, provider-neutral lead + analytics-event contracts. Validators return fresh objects or null (fail closed).
export const LEAD_SOURCES = ['widget', 'handoff', 'manual'] as const;
export const HANDOFF_STATES = ['none', 'requested', 'completed'] as const;
export const FOLLOW_UP_STATES = ['none', 'pending', 'done'] as const;
export const EVENT_NAMES = ['widget_opened', 'question_submitted', 'answer_shown', 'citation_interaction', 'card_interaction', 'handoff', 'lead_submitted', 'error', 'degraded_mode'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];
export type EventName = (typeof EVENT_NAMES)[number];

export interface Lead {
  id: string; tenantId: string; siteId: string; sessionId: string;
  consent: 'granted' | 'withdrawn'; source: LeadSource; recommendationId: string | null;
  handoff: (typeof HANDOFF_STATES)[number]; followUp: (typeof FOLLOW_UP_STATES)[number];
  retention: { state: 'active'; retainUntil: number };
  createdAt: number; updatedAt: number;
}
export interface AnalyticsEvent {
  id: string; tenantId: string; siteId: string; sessionId: string; leadId: string | null;
  name: EventName; data: Record<string, number | boolean | string>; occurredAt: number;
}

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CODE = /^[a-z][a-z0-9_]{0,39}$/;
// Defence in depth: code-shaped strings that look like secrets are refused.
const SECRETISH = /(secret|token|password|passwd|bearer|apikey|api_key|credential|(^|_)(sk|pk)_)/i;
export const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
export const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
// One-pass snapshot of an untrusted plain object: each key is read exactly once (getters/Proxies cannot change values later); null if not plain or any trap throws.
export const snap = (v: unknown): Record<string, unknown> | null => {
  try {
    if (!isRec(v)) return null;
    const o: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(v)) o[key] = v[key];
    return o;
  } catch { return null; }
};
export const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));
export const oneOf = <T extends string>(v: unknown, set: readonly T[]): v is T => typeof v === 'string' && (set as readonly string[]).includes(v);
export const isTime = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000;
const code = (v: unknown) => typeof v === 'string' && CODE.test(v) && isOpaqueId(v); // same redaction policy as opaque ids
// Redaction policy for caller-supplied opaque ids: no secret-like words, and no phone-like digit runs (email is excluded by ID's charset).
const PHONEISH = /(\d[._:-]?){7,}/;
// Provider credential shapes (sk-/sk_, ghp_/github_pat_, AWS key ids, JWTs, Slack/Google/GitLab/HF tokens) are never valid ids.
const CREDENTIALISH = /^(sk|pk|rk)[-_]|^(gh[pousr]_|github_pat_|xox[a-z]-|AIza|glpat[-_]|hf_|npm_|ya29\.|whsec_)|^(AKIA|ASIA)[A-Z0-9]{16}|eyJ[\w-]{5,}\.[\w-]+\.[\w-]*/;
export const isOpaqueId = (v: unknown): v is string => isId(v) && !SECRETISH.test(v) && !PHONEISH.test(v) && !CREDENTIALISH.test(v);
const id = isOpaqueId;
const bool = (v: unknown) => typeof v === 'boolean';
const en = (...s: string[]) => (v: unknown) => oneOf(v, s);

// Exact allowlist per event: every field required, typed and bounded. No free text anywhere.
const EVENT_SHAPES: Record<EventName, Record<string, (v: unknown) => boolean>> = {
  widget_opened: { returning: bool },
  question_submitted: { charCount: count, turnIndex: count },
  answer_shown: { citationCount: count, cardCount: count, grounded: bool, latencyMs: count },
  citation_interaction: { action: en('open', 'expand'), citationIndex: count },
  card_interaction: { action: en('view', 'click'), cardId: id },
  handoff: { channel: code, outcome: en('requested', 'completed', 'failed') },
  lead_submitted: { consentGiven: bool },
  error: { code },
  degraded_mode: { reason: code, active: bool },
};

export function parseEventData(name: unknown, input: unknown): Record<string, number | boolean | string> | null {
  const data = snap(input);
  if (!oneOf(name, EVENT_NAMES) || !data) return null;
  const shape = EVENT_SHAPES[name];
  const keys = Object.keys(shape);
  if (!onlyKeys(data, keys) || !keys.every((k) => Object.hasOwn(data, k) && shape[k]!(data[k]))) return null;
  return Object.fromEntries(keys.map((k) => [k, data[k] as number | boolean | string]));
}

export const clone = <T>(v: T): T => structuredClone(v);
export const stable = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(stable).join(',')}]` : isRec(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v) ?? 'null';
