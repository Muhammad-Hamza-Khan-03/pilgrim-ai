import { describe, expect, it } from 'vitest';
import { mountPanel, type BookingAction, type PanelCard, type PanelEvent, type PanelNode } from '../src/panel.js';
import {
  MAX_MESSAGES, MAX_SNAPSHOT_BYTES, createMemorySessionStore, createSessionId, parseSnapshot, serializeSnapshot, utf8Length,
  type PanelSnapshot, type SessionStore,
} from '../src/session.js';

class N implements PanelNode {
  attrs = new Map<string, string>();
  kids: N[] = [];
  handlers = new Map<string, Array<(e: PanelEvent) => void>>();
  textContent: string | null = null;
  hidden = false;
  disabled = false;
  value = '';
  shadow: N | null = null;
  constructor(public tag: string) {}
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  addEventListener(t: string, fn: (e: PanelEvent) => void) { this.handlers.set(t, [...(this.handlers.get(t) ?? []), fn]); }
  appendChild(c: PanelNode) { this.kids.push(c as N); }
  attachShadow() { return (this.shadow = new N('#shadow')); }
  focus() {}
  fire(t: string) { this.handlers.get(t)?.forEach((f) => f({ preventDefault() {} })); }
  find(pred: (n: N) => boolean): N[] { return [...(pred(this) ? [this] : []), ...this.kids.flatMap((k) => k.find(pred))]; }
}

const cards: PanelCard[] = [
  { id: 'a', title: 'Alpha', description: 'd', priceLabel: '$1', chips: [{ id: 'c1', label: 'Near Haram' }] },
  { id: 'b', title: 'Beta', description: 'e', priceLabel: '$2' },
];
const tick = () => new Promise((r) => setTimeout(r, 0));

function mount(store: SessionStore | undefined, extra: { sessionId?: string; fixtures?: { cards: PanelCard[] } } = {}) {
  const actions: BookingAction[] = [];
  const p = mountPanel({ createElement: (t) => new N(t), body: new N('body') }, {
    client: { send: async (m) => ({ contractVersion: 1 as const, sessionId: 's', reply: `re:${m}`, history: [], summary: '' }) },
    fixtures: extra.fixtures ?? { cards },
    onBookingAction: (a) => { actions.push(a); },
    ...(store ? { session: { store, ...(extra.sessionId ? { sessionId: extra.sessionId } : {}) } } : {}),
  });
  const root = (p.host as N).shadow!;
  const q = (pred: (n: N) => boolean) => root.find(pred)[0]!;
  return {
    p, root, actions, q,
    input: q((n) => n.tag === 'textarea'), form: q((n) => n.tag === 'form'), dialog: q((n) => n.attrs.get('role') === 'dialog'),
    btn: (text: string) => q((n) => n.tag === 'button' && n.textContent === text),
    msgs: () => root.find((n) => n.attrs.get('role') === 'article').map((n) => [n.attrs.get('aria-label'), n.textContent]),
  };
}
const send = async (t: ReturnType<typeof mount>, text: string) => { t.input.value = text; t.form.fire('submit'); await tick(); };
const valid = (): PanelSnapshot => ({ version: 1, sessionId: 'abc', messages: [{ role: 'user', text: 'hi' }], cards: [{ id: 'a', title: 'A', description: '', priceLabel: '', chips: [] }], selectedCardId: null, confirmedCardIds: [], open: true, draft: '' });

describe('snapshot contract', () => {
  it('round-trips a valid snapshot and returns a fresh copy', () => {
    const s = valid();
    const back = parseSnapshot(serializeSnapshot(s));
    expect(back).toEqual(s);
    expect(back).not.toBe(s);
    expect(parseSnapshot(s)).toEqual(s);
  });
  it('fails closed on invalid input', () => {
    const bad: unknown[] = [
      null, 5, '', '{', '[]', { ...valid(), version: 2 }, { ...valid(), extra: 1 }, { ...valid(), sessionId: 'bad id!' },
      { ...valid(), open: 'yes' }, { ...valid(), messages: [{ role: 'system', text: 'x' }] }, { ...valid(), messages: [{ role: 'user', text: 1 }] },
      { ...valid(), selectedCardId: 'zzz' }, { ...valid(), confirmedCardIds: ['zzz'] }, { ...valid(), confirmedCardIds: ['a', 'a'] },
      { ...valid(), selectedCardId: 'a', confirmedCardIds: ['a'] },
      { ...valid(), cards: [valid().cards[0], valid().cards[0]] }, { ...valid(), cards: [{ ...valid().cards[0], title: '' }] },
      { ...valid(), cards: [{ ...valid().cards[0], chips: [{ id: '', label: 'x' }] }] },
    ];
    for (const b of bad) expect(parseSnapshot(b)).toBeNull();
  });
  it('enforces size bounds', () => {
    const many = { ...valid(), messages: Array.from({ length: MAX_MESSAGES + 1 }, () => ({ role: 'user' as const, text: 'x' })) };
    expect(parseSnapshot(many)).toBeNull();
    const big = { ...valid(), messages: Array.from({ length: MAX_MESSAGES }, () => ({ role: 'user' as const, text: 'é'.repeat(4000) })) };
    expect(utf8Length(JSON.stringify(big))).toBeGreaterThan(MAX_SNAPSHOT_BYTES);
    expect(parseSnapshot(big)).toBeNull();
    expect(() => serializeSnapshot(big)).toThrow();
    expect(parseSnapshot({ ...valid(), draft: 'x'.repeat(2001) })).toBeNull();
  });
  it('makes valid, deterministic-injectable session ids', () => {
    expect(createSessionId(() => 0)).toBe('s' + '0'.repeat(20));
    expect(parseSnapshot({ ...valid(), sessionId: createSessionId() })).not.toBeNull();
  });
});

describe('panel resume', () => {
  it('round-trips transcript, cards/chips, booking state and identity through an injected store', async () => {
    const store = createMemorySessionStore();
    const a = mount(store);
    await send(a, 'hello');
    a.btn('Book Alpha').fire('click');
    a.btn('Book Beta').fire('click'); // switches selection
    a.q((n) => n.attrs.get('data-card') === 'b').find((n) => n.textContent === 'Confirm booking')[0]!.fire('click');
    a.btn('Book Alpha').fire('click');
    a.input.value = 'draft text';
    a.p.close();
    const id = a.p.sessionId;

    const b = mount(store, { fixtures: { cards: [] } }); // cards come from the snapshot
    expect(b.p.sessionId).toBe(id);
    expect(b.msgs()).toEqual([['You', 'hello'], ['Assistant', 're:hello']]);
    expect(b.root.find((n) => n.attrs.get('data-chip') === 'c1').map((n) => n.textContent)).toEqual(['Near Haram']);
    expect(b.btn('Book Alpha').attrs.get('aria-pressed')).toBe('true');
    expect(b.btn('Book Beta').hidden).toBe(true); // confirmed
    expect(b.dialog.hidden).toBe(true);
    expect(b.dialog.attrs.get('aria-hidden')).toBe('true');
    expect(b.input.value).toBe('draft text');
    expect(b.p.snapshot()).toEqual({ ...a.p.snapshot(), open: false });
  });
  it('restoring booking state has no side effects: no actions, no extra store writes', () => {
    const store = createMemorySessionStore();
    const a = mount(store);
    a.btn('Book Alpha').fire('click');
    let saves = 0;
    const counting: SessionStore = { load: () => store.load(), save: (s) => { saves++; store.save(s); } };
    const b = mount(counting);
    expect(b.actions).toEqual([]);
    expect(saves).toBeLessThanOrEqual(1); // only the mount-time open-state sync
    expect(b.btn('Confirm booking').hidden).toBe(false);
  });
  it('ignores invalid or mismatched stored data and starts fresh', () => {
    const fresh = mount(createMemorySessionStore('{"nope":1}'));
    expect(fresh.msgs()).toEqual([]);
    expect(fresh.p.snapshot().cards.map((c) => c.id)).toEqual(['a', 'b']);
    const store = createMemorySessionStore(serializeSnapshot(valid()));
    const other = mount(store, { sessionId: 'different' });
    expect(other.p.sessionId).toBe('different');
    expect(other.msgs()).toEqual([]);
    const throwing = mount({ load: () => { throw new Error('x'); }, save: () => { throw new Error('y'); } });
    expect(throwing.p.sessionId).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it('without a session option nothing is persisted and ids are still stable', async () => {
    const a = mount(undefined);
    await send(a, 'x');
    expect(a.p.snapshot().sessionId).toBe(a.p.sessionId);
    const keys = Object.keys(globalThis as object);
    expect(keys.includes('localStorage')).toBe(false);
  });
  it('keeps accessibility semantics after restore', async () => {
    const store = createMemorySessionStore();
    await send(mount(store), 'hi');
    const b = mount(store);
    const log = b.q((n) => n.attrs.get('role') === 'log');
    expect(log.attrs.get('aria-live')).toBe('polite');
    expect(b.dialog.attrs.get('aria-modal')).toBe('false');
    expect(b.root.find((n) => n.attrs.get('role') === 'article').every((n) => n.attrs.has('aria-label'))).toBe(true);
    expect(b.root.find((n) => n.attrs.get('aria-label') === 'Recommendations')).toHaveLength(1);
  });
});
