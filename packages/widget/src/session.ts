// Session resume seam: pure, provider/storage-neutral snapshot contract for the chat panel.
// No globals, network or browser storage: persistence only goes through an injected SessionStore.
export const SNAPSHOT_VERSION = 1;
export const MAX_SNAPSHOT_BYTES = 65536;
export const MAX_MESSAGES = 100;
export const MAX_MESSAGE_CHARS = 4000;
export const MAX_DRAFT_CHARS = 2000;
export const MAX_CARDS = 20;
export const MAX_CHIPS = 10;
export const MAX_FIELD_CHARS = 500;

export interface SnapshotChip { id: string; label: string }
export interface SnapshotCard { id: string; title: string; description: string; priceLabel: string; chips: SnapshotChip[] }
export interface PanelSnapshot {
  version: 1;
  sessionId: string;
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  cards: SnapshotCard[];
  /** Mock booking state only; restoring it never triggers any side effect. */
  selectedCardId: string | null;
  confirmedCardIds: string[];
  open: boolean;
  draft: string;
}
/** Injected persistence; the widget never reaches for localStorage & co. itself. */
export interface SessionStore { load(): string | null; save(serialized: string): void }

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const isSessionId = (s: unknown): s is string => typeof s === 'string' && ID_RE.test(s);

/** New stable id; `rand` is injectable for determinism. */
export function createSessionId(rand: () => number = Math.random): string {
  let s = 's';
  while (s.length < 21) s += Math.floor(rand() * 36).toString(36);
  return s;
}

export function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) { const c = ch.codePointAt(0)!; n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  return n;
}

export function createMemorySessionStore(initial: string | null = null): SessionStore {
  let data = initial;
  return { load: () => data, save: (s) => { data = s; } };
}

type Rec = Record<string, unknown>;
const rec = (v: unknown, keys: string[]): Rec | null => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const k = Object.keys(v);
  return k.length === keys.length && keys.every((x) => k.includes(x)) ? (v as Rec) : null;
};
const str = (v: unknown, max: number, nonEmpty = false): v is string =>
  typeof v === 'string' && v.length <= max && (!nonEmpty || v !== '');

function parseCard(v: unknown): SnapshotCard | null {
  const c = rec(v, ['id', 'title', 'description', 'priceLabel', 'chips']);
  if (!c || !str(c.id, MAX_FIELD_CHARS, true) || !str(c.title, MAX_FIELD_CHARS, true) || !str(c.description, MAX_FIELD_CHARS) ||
    !str(c.priceLabel, MAX_FIELD_CHARS) || !Array.isArray(c.chips) || c.chips.length > MAX_CHIPS) return null;
  const chips: SnapshotChip[] = [];
  for (const x of c.chips) {
    const ch = rec(x, ['id', 'label']);
    if (!ch || !str(ch.id, MAX_FIELD_CHARS, true) || !str(ch.label, MAX_FIELD_CHARS, true)) return null;
    chips.push({ id: ch.id, label: ch.label });
  }
  return { id: c.id, title: c.title, description: c.description, priceLabel: c.priceLabel, chips };
}

/** Strictly validates a JSON string or object; returns a fresh sanitized copy, or null (fail closed). */
export function parseSnapshot(raw: unknown): PanelSnapshot | null {
  try {
    let text: string;
    if (typeof raw === 'string') text = raw;
    else if (typeof raw === 'object' && raw !== null) text = JSON.stringify(raw);
    else return null;
    if (utf8Length(text) > MAX_SNAPSHOT_BYTES) return null;
    const s = rec(JSON.parse(text), ['version', 'sessionId', 'messages', 'cards', 'selectedCardId', 'confirmedCardIds', 'open', 'draft']);
    if (!s || s.version !== SNAPSHOT_VERSION || !isSessionId(s.sessionId) || typeof s.open !== 'boolean' || !str(s.draft, MAX_DRAFT_CHARS)) return null;
    if (!Array.isArray(s.messages) || s.messages.length > MAX_MESSAGES || !Array.isArray(s.cards) || s.cards.length > MAX_CARDS ||
      !Array.isArray(s.confirmedCardIds)) return null;
    const messages: PanelSnapshot['messages'] = [];
    for (const m of s.messages) {
      const x = rec(m, ['role', 'text']);
      if (!x || (x.role !== 'user' && x.role !== 'assistant') || !str(x.text, MAX_MESSAGE_CHARS)) return null;
      messages.push({ role: x.role, text: x.text });
    }
    const cards: SnapshotCard[] = [];
    for (const c of s.cards) { const p = parseCard(c); if (!p || cards.some((o) => o.id === p.id)) return null; cards.push(p); }
    const known = new Set(cards.map((c) => c.id));
    const confirmed = s.confirmedCardIds as unknown[];
    if (!confirmed.every((id): id is string => typeof id === 'string' && known.has(id)) || new Set(confirmed).size !== confirmed.length) return null;
    const sel = s.selectedCardId;
    if (sel !== null && (typeof sel !== 'string' || !known.has(sel) || confirmed.includes(sel))) return null;
    return { version: 1, sessionId: s.sessionId, messages, cards, selectedCardId: sel, confirmedCardIds: confirmed as string[], open: s.open, draft: s.draft };
  } catch {
    return null;
  }
}

/** Serializes after validating; throws if the snapshot is invalid or over the size bound. */
export function serializeSnapshot(snap: PanelSnapshot): string {
  const text = JSON.stringify(snap);
  if (parseSnapshot(text) === null) throw new Error('invalid or oversized session snapshot');
  return text;
}
