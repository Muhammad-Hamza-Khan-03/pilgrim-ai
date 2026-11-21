export const GROUNDED_TURN_SCHEMA_VERSION = 'grounded-turn/v1' as const;

export type EvidenceItem = { id: string; source: string; topics: string[]; text: string };
export type IntentSlots = { intent: string; slots: Record<string, string | number> };
/** Intent/slot extraction: separate from answer composition, sees only the user message. */
export type IntentExtractor = (message: string) => IntentSlots;
export type EvidenceRetriever = (intent: string, slots: Record<string, string | number>) => EvidenceItem[];
export type ComposeInput = { intent: string; slots: Record<string, string | number>; evidence: EvidenceItem[] };
/** Provider-neutral composer; its output is untrusted and validated before use. */
export type AnswerComposer = (input: ComposeInput) => unknown | Promise<unknown>;

export type Citation = { evidence_id: string; source: string };
export type GroundedClaim = { id: string; text: string; citations: Citation[] };
export type GroundedCard = { id: string; kind: string; title: string; citations: Citation[] };
/** Advisory only: never an executed action. */
export type GroundedRecommendation = { id: string; advisory: true; rank: number; title: string; rationale: string; citations: Citation[] };
export type GroundedTurnStatus = 'grounded' | 'insufficient_evidence' | 'degraded';
export type GroundedDiagnosticCode =
  | 'provider_failure' | 'malformed_output' | 'uncited_claim' | 'unknown_citation'
  | 'ungrounded_number' | 'ungrounded_name' | 'prohibited_claim' | 'injection_detected_as_data';

export type GroundedTurnResult = {
  schema_version: typeof GROUNDED_TURN_SCHEMA_VERSION;
  status: GroundedTurnStatus;
  intent: string;
  slots: Record<string, string | number>;
  claims: GroundedClaim[];
  cards: GroundedCard[];
  recommendations: GroundedRecommendation[];
  diagnostics: { codes: GroundedDiagnosticCode[]; input_masked: string };
};

export type GroundedTurnRequest = { message: string; extract: IntentExtractor; retrieve: EvidenceRetriever; compose: AnswerComposer };

const MAX_DIAGNOSTIC_CHARS = 2000;
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+/g;
// shortcut: mirrors @pilgrim/api maskPii (engine cannot import api); emails/phones only, dedupe when a shared package exists.
const PHONE_RE = /(?!\d{4}-\d{2}-\d{2}\b)\+?\(?\d(?:(?:[\s.-]?\(?|\)[\s.-]?)\d){6,14}/g;
const INJECTION_RE = /ignore (?:all )?(?:previous|prior) instructions|system prompt/i;
const PROHIBITED_RE = /\b(?:guarantee[sd]?|100% (?:safe|refund)|risk[- ]free|visa (?:is )?approved|full refund)\b/i;

const maskPii = (t: string): string => t.replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[phone]').slice(0, MAX_DIAGNOSTIC_CHARS);

function stableId(prefix: string, parts: unknown): string {
  let h = 0x811c9dc5; // FNV-1a 32-bit
  for (const c of JSON.stringify(parts)) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return `${prefix}_${h.toString(16).padStart(8, '0')}`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

type RawItem = { text: string; citations: string[] };

/** Returns null when malformed. */
function parseOutput(out: unknown) {
  if (!isObj(out) || !Array.isArray(out.claims)) return null;
  const cards = out.cards ?? [];
  const recs = out.recommendations ?? [];
  if (!Array.isArray(cards) || !Array.isArray(recs)) return null;
  const claims: RawItem[] = [];
  for (const c of out.claims) {
    if (!isObj(c) || typeof c.text !== 'string' || !isStrArr(c.citations)) return null;
    claims.push({ text: c.text, citations: c.citations });
  }
  const pcards: Array<RawItem & { kind: string }> = [];
  for (const c of cards) {
    if (!isObj(c) || typeof c.kind !== 'string' || typeof c.title !== 'string' || !isStrArr(c.citations)) return null;
    pcards.push({ kind: c.kind, text: c.title, citations: c.citations });
  }
  const precs: Array<RawItem & { rationale: string }> = [];
  for (const r of recs) {
    if (!isObj(r) || typeof r.title !== 'string' || typeof r.rationale !== 'string' || !isStrArr(r.citations)) return null;
    precs.push({ text: r.title, rationale: r.rationale, citations: r.citations });
  }
  return { claims, cards: pcards, recs: precs };
}

const words = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9]+/g) ?? []);

/** Deterministic post-check of one text against its cited evidence. shortcut: capitalised-word heuristic for names/currencies, upgrade with real NER. */
function checkText(text: string, citations: string[], byId: Map<string, EvidenceItem>, texts: string[]): GroundedDiagnosticCode | null {
  if (citations.length === 0) return 'uncited_claim';
  if (citations.some((id) => !byId.has(id))) return 'unknown_citation';
  if (PROHIBITED_RE.test(text)) return 'prohibited_claim';
  const ev = words(citations.map((id) => byId.get(id)!.text).join(' '));
  for (const n of text.match(/\d+/g) ?? []) if (!ev.has(n)) return 'ungrounded_number';
  for (const m of text.matchAll(/\b[A-Z][A-Za-z]*/g)) {
    const start = m.index === 0 || /[.!?]\s+$/.test(text.slice(0, m.index));
    if (!start && !ev.has(m[0].toLowerCase())) return 'ungrounded_name';
  }
  texts.push(text);
  return null;
}

/** Fail-closed grounded turn: extract -> retrieve -> compose (untrusted) -> validate. Never throws. */
export async function runGroundedTurn(req: GroundedTurnRequest): Promise<GroundedTurnResult> {
  const codes = new Set<GroundedDiagnosticCode>();
  const input_masked = maskPii(String(req.message ?? ''));
  let intent = 'unknown';
  let slots: Record<string, string | number> = {};
  const finish = (status: GroundedTurnStatus, body?: Partial<Pick<GroundedTurnResult, 'claims' | 'cards' | 'recommendations'>>): GroundedTurnResult => ({
    schema_version: GROUNDED_TURN_SCHEMA_VERSION,
    status,
    intent,
    slots,
    claims: body?.claims ?? [],
    cards: body?.cards ?? [],
    recommendations: body?.recommendations ?? [],
    diagnostics: { codes: [...codes].sort(), input_masked },
  });
  const degrade = (code: GroundedDiagnosticCode) => { codes.add(code); return finish('degraded'); };

  if (INJECTION_RE.test(String(req.message))) codes.add('injection_detected_as_data');
  let evidence: EvidenceItem[];
  try {
    const x = req.extract(req.message);
    intent = x.intent;
    slots = Object.fromEntries(Object.entries(x.slots).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, typeof v === 'string' ? maskPii(v) : v]));
    evidence = req.retrieve(x.intent, x.slots);
  } catch {
    return degrade('provider_failure');
  }
  if (evidence.length === 0) return finish('insufficient_evidence');
  if (evidence.some((e) => INJECTION_RE.test(e.text))) codes.add('injection_detected_as_data');

  let raw: unknown;
  try {
    raw = await req.compose({ intent, slots, evidence });
  } catch {
    return degrade('provider_failure');
  }
  const out = parseOutput(raw);
  if (!out) return degrade('malformed_output');
  if (out.claims.length === 0) return finish('insufficient_evidence');

  const byId = new Map(evidence.map((e) => [e.id, e]));
  const seen: string[] = [];
  const all: RawItem[] = [...out.claims, ...out.cards, ...out.recs, ...out.recs.map((r) => ({ text: r.rationale, citations: r.citations }))];
  for (const item of all) {
    const bad = checkText(item.text, item.citations, byId, seen);
    if (bad) return degrade(bad);
  }
  const cite = (ids: string[]): Citation[] => ids.map((id) => ({ evidence_id: id, source: byId.get(id)!.source }));
  return finish('grounded', {
    claims: out.claims.map((c) => ({ id: stableId('claim', [c.text, c.citations]), text: c.text, citations: cite(c.citations) })),
    cards: out.cards
      .map((c) => ({ id: stableId('card', [c.kind, c.text, c.citations]), kind: c.kind, title: c.text, citations: cite(c.citations) }))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)),
    recommendations: out.recs.map((r, i) => ({ id: stableId('rec', [r.text, r.rationale, r.citations]), advisory: true as const, rank: i + 1, title: r.text, rationale: r.rationale, citations: cite(r.citations) })),
  });
}
