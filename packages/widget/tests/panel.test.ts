import { describe, expect, it } from 'vitest';
import { ChatClientError } from '../src/chat.js';
import { mountPanel, type PanelStream, type PanelCard, type BookingAction, type PanelClient, type PanelDocument, type PanelEvent, type PanelNode } from '../src/panel.js';

class N implements PanelNode {
  attrs = new Map<string, string>();
  kids: N[] = [];
  handlers = new Map<string, Array<(e: PanelEvent) => void>>();
  textContent: string | null = null;
  hidden = false;
  disabled = false;
  value = '';
  shadow: N | null = null;
  focused = false;
  constructor(public tag: string) {}
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  addEventListener(t: string, fn: (e: PanelEvent) => void) { this.handlers.set(t, [...(this.handlers.get(t) ?? []), fn]); }
  appendChild(c: PanelNode) { this.kids.push(c as N); }
  attachShadow() { return (this.shadow = new N('#shadow')); }
  focus() { this.focused = true; }
  fire(t: string, e: Partial<PanelEvent> = {}) {
    let prevented = false;
    this.handlers.get(t)?.forEach((f) => f({ preventDefault: () => { prevented = true; }, ...e }));
    return prevented;
  }
  find(pred: (n: N) => boolean): N[] { return [...(pred(this) ? [this] : []), ...this.kids.flatMap((k) => k.find(pred))]; }
}

function setup(client: PanelClient | null) {
  const body = new N('body');
  const doc: PanelDocument = { createElement: (t) => new N(t), body };
  let closed = 0;
  const { host } = mountPanel(doc, { client, onClose: () => { closed++; } });
  const h = host as N;
  const root = h.shadow!;
  const q = (pred: (n: N) => boolean) => root.find(pred)[0]!;
  return {
    body, h, root, closed: () => closed,
    dialog: q((n) => n.attrs.get('role') === 'dialog'),
    log: q((n) => n.attrs.get('role') === 'log'),
    status: q((n) => n.attrs.get('role') === 'status'),
    alert: q((n) => n.attrs.get('role') === 'alert'),
    input: q((n) => n.tag === 'textarea'),
    form: q((n) => n.tag === 'form'),
    send: q((n) => n.attrs.get('type') === 'submit'),
    close: q((n) => n.attrs.get('aria-label') === 'Close chat'),
    retry: q((n) => n.textContent === 'Retry'),
    msgs: () => root.find((n) => n.attrs.get('role') === 'article').map((n) => [n.attrs.get('aria-label'), n.textContent]),
  };
}
const reply = (r: string) => ({ contractVersion: 1 as const, sessionId: 's', reply: r, history: [], summary: '' });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('chat panel', () => {
  it('mounts isolated in a shadow root with accessible semantics and no client call', () => {
    const calls: string[] = [];
    const t = setup({ send: async (m) => { calls.push(m); return reply('x'); } });
    expect(t.body.kids).toEqual([t.h]);
    expect(t.h.kids).toEqual([]); // content lives only in the shadow root
    expect(t.root.find((n) => n.tag === 'style')).toHaveLength(1);
    expect(t.dialog.attrs.get('aria-label')).toBe('Chat');
    expect(t.log.attrs.get('aria-live')).toBe('polite');
    expect(t.status.attrs.get('aria-live')).toBe('polite');
    expect(t.input.attrs.get('aria-label')).toBe('Message');
    expect(t.root.find((n) => n.tag === 'label' && n.attrs.get('for') === t.input.attrs.get('id'))).toHaveLength(1);
    expect(t.close.tag).toBe('button');
    expect(t.close.attrs.get('type')).toBe('button');
    expect(t.input.focused).toBe(true);
    expect(calls).toEqual([]);
  });

  it('submits on Enter (not Shift+Enter), renders text-only messages with loading state', async () => {
    let resolve!: (v: ReturnType<typeof reply>) => void;
    const sent: string[] = [];
    const t = setup({ send: (m) => { sent.push(m); return new Promise((r) => { resolve = r; }); } });
    t.input.value = '<img src=x onerror=alert(1)>';
    expect(t.input.fire('keydown', { key: 'Enter', shiftKey: true })).toBe(false);
    expect(sent).toEqual([]);
    expect(t.input.fire('keydown', { key: 'Enter' })).toBe(true);
    expect(sent).toEqual(['<img src=x onerror=alert(1)>']);
    expect(t.status.textContent).toBe('Sending…');
    expect(t.send.disabled).toBe(true);
    expect(t.log.attrs.get('aria-busy')).toBe('true');
    resolve(reply('<b>hi</b>'));
    await tick();
    expect(t.msgs()).toEqual([['You', '<img src=x onerror=alert(1)>'], ['Assistant', '<b>hi</b>']]);
    expect(t.root.find((n) => n.tag === 'img' || n.tag === 'b')).toEqual([]);
    expect(t.status.textContent).toBe('');
    expect(t.send.disabled).toBe(false);
    expect(t.input.value).toBe('');
  });

  it('form submit works and ignores blank input', async () => {
    const sent: string[] = [];
    const t = setup({ send: async (m) => { sent.push(m); return reply('ok'); } });
    t.input.value = '   ';
    expect(t.form.fire('submit')).toBe(true);
    expect(sent).toEqual([]);
    t.input.value = 'hello';
    t.form.fire('submit');
    await tick();
    expect(sent).toEqual(['hello']);
  });

  it('surfaces typed errors without throwing and retries without duplicating the user turn', async () => {
    const results: Array<() => Promise<unknown>> = [
      async () => { throw new ChatClientError('http_error', 'x', 500); },
      async () => ({ reply: 42 }),
      async () => reply('finally'),
    ];
    const t = setup({ send: () => results.shift()!() as never });
    t.input.value = 'q';
    t.form.fire('submit');
    await tick();
    expect(t.alert.textContent).toBe('The chat service returned an error.');
    expect(t.retry.hidden).toBe(false);
    t.retry.fire('click');
    await tick();
    expect(t.alert.textContent).toBe('The chat service sent an unreadable reply.');
    t.retry.fire('click');
    await tick();
    expect(t.alert.textContent).toBe('');
    expect(t.retry.hidden).toBe(true);
    expect(t.msgs()).toEqual([['You', 'q'], ['Assistant', 'finally']]);
  });

  it('shows an error (no retry) when no client is configured, and treats foreign throws as network errors', async () => {
    const none = setup(null);
    none.input.value = 'hi';
    none.form.fire('submit');
    await tick();
    expect(none.alert.textContent).toBe('Chat is not configured.');
    expect(none.retry.hidden).toBe(true);
    const boom = setup({ send: async () => { throw new TypeError('x'); } });
    boom.input.value = 'hi';
    boom.form.fire('submit');
    await tick();
    expect(boom.alert.textContent).toBe('Could not reach the chat service.');
  });

  it('closes via button and Escape, hiding the dialog and notifying the host', () => {
    const t = setup(null);
    t.close.fire('click');
    expect([t.dialog.hidden, t.dialog.attrs.get('aria-hidden'), t.closed()]).toEqual([true, 'true', 1]);
    const u = setup(null);
    u.dialog.fire('keydown', { key: 'Escape' });
    expect([u.dialog.hidden, u.closed()]).toEqual([true, 1]);
    u.dialog.fire('keydown', { key: 'a' });
    expect(u.closed()).toBe(1);
  });

  it('reopens after Escape/Close via open/toggle, keeping the launcher state in sync', () => {
    const body = new N('body');
    const doc: PanelDocument = { createElement: (t) => new N(t), body };
    const expanded: boolean[] = [];
    const p = mountPanel(doc, { client: null, onClose: () => expanded.push(false), onOpen: () => expanded.push(true) });
    const dialog = (p.host as N).shadow!.find((n) => n.attrs.get('role') === 'dialog')[0]!;
    const input = (p.host as N).shadow!.find((n) => n.tag === 'textarea')[0]!;
    expect(dialog.hidden).toBe(false);
    dialog.fire('keydown', { key: 'Escape' });
    expect(dialog.hidden).toBe(true);
    input.focused = false;
    p.toggle(); // launcher click after close
    expect(dialog.hidden).toBe(false);
    expect(dialog.attrs.get('aria-hidden')).toBe('false');
    expect(input.focused).toBe(true);
    p.toggle(); // click while open closes
    expect(dialog.hidden).toBe(true);
    p.open();
    expect(dialog.hidden).toBe(false);
    expect(expanded).toEqual([false, true, false, true]);
    expect(body.kids).toEqual([p.host]); // reused, not remounted
  });

  describe('streaming', () => {
    function streamed(stream: PanelStream) {
      const body = new N('body');
      const p = mountPanel({ createElement: (t) => new N(t), body }, { client: null, stream });
      const root = (p.host as N).shadow!;
      const q = (f: (n: N) => boolean) => root.find(f)[0]!;
      return {
        p, root, input: q((n) => n.tag === 'textarea'), form: q((n) => n.tag === 'form'), alert: q((n) => n.attrs.get('role') === 'alert'),
        retry: q((n) => n.textContent === 'Retry'), send: q((n) => n.attrs.get('type') === 'submit'), dialog: q((n) => n.attrs.get('role') === 'dialog'),
        msgs: () => root.find((n) => n.attrs.get('role') === 'article').map((n) => [n.attrs.get('aria-label'), n.textContent]),
      };
    }
    it('grows one assistant message per chunk as text, and re-enables send', async () => {
      let push!: (t: string) => void; let end!: () => void;
      const t = streamed((_m, on) => new Promise<void>((r) => { push = on; end = r; }));
      t.input.value = '<i>q</i>';
      t.form.fire('submit');
      expect(t.send.disabled).toBe(true);
      push('<b>He'); push('llo');
      expect(t.msgs()).toEqual([['You', '<i>q</i>'], ['Assistant', '<b>Hello']]);
      end(); await tick();
      expect(t.send.disabled).toBe(false);
      expect(t.root.find((n) => n.tag === 'b')).toEqual([]);
    });
    it('shows typed error, keeps partial, and retry resets it without duplicating the user turn', async () => {
      const runs: Array<(on: (t: string) => void) => Promise<void>> = [
        async (on) => { on('par'); throw new ChatClientError('timeout', 'x'); },
        async (on) => { on('full'); },
      ];
      const t = streamed((_m, on) => runs.shift()!(on));
      t.input.value = 'q';
      t.form.fire('submit'); await tick();
      expect(t.alert.textContent).toBe('The chat service took too long to respond.');
      expect(t.msgs()[1]).toEqual(['Assistant', 'par']);
      t.retry.fire('click'); await tick();
      expect(t.msgs()).toEqual([['You', 'q'], ['Assistant', 'full']]);
      expect([t.alert.textContent, t.retry.hidden]).toEqual(['', true]);
    });
    it('aborts the in-flight stream on close with no error UI', async () => {
      let sig!: AbortSignal;
      const t = streamed((_m, _on, s) => new Promise((_r, rej) => { sig = s; s.addEventListener('abort', () => rej(new ChatClientError('aborted', 'x'))); }));
      t.input.value = 'q';
      t.form.fire('submit');
      t.dialog.fire('keydown', { key: 'Escape' });
      await tick();
      expect([sig.aborted, t.alert.textContent, t.send.disabled]).toEqual([true, '', false]);
    });
  });
});

describe('cards and mock booking', () => {
  const cards: PanelCard[] = [
    { id: 'a', title: '<b>Hotel A</b>', description: 'Near the <i>Haram</i>', priceLabel: 'SAR 100', chips: [{ id: 'c1', label: 'Breakfast' }, { id: 'c2', label: '<u>5 min</u>' }] },
    { id: 'b', title: 'Hotel B', description: 'Budget', priceLabel: 'SAR 50' },
  ];
  function carded(fixtures?: { cards: PanelCard[] }, withCb = true) {
    const actions: BookingAction[] = [];
    const p = mountPanel({ createElement: (t) => new N(t), body: new N('body') }, { client: null, fixtures, ...(withCb ? { onBookingAction: (a: BookingAction) => { actions.push(a); } } : {}) });
    const root = (p.host as N).shadow!;
    const btn = (label: string, i = 0) => root.find((n) => n.tag === 'button' && (n.attrs.get('aria-label') ?? n.textContent) === label)[i]!;
    const items = () => root.find((n) => n.attrs.get('role') === 'listitem' && n.attrs.has('data-card'));
    const text = (n: N): string => [n.textContent ?? '', ...n.kids.map(text)].join('|');
    return { root, actions, btn, items, text };
  }

  it('renders nothing without fixtures or with empty fixtures', () => {
    for (const f of [undefined, { cards: [] }]) {
      const t = carded(f);
      expect(t.root.find((n) => n.attrs.has('data-cards'))).toEqual([]);
      expect(t.items()).toEqual([]);
    }
  });

  it('renders ordered cards and chips in a labelled list as text only', () => {
    const t = carded({ cards });
    const list = t.root.find((n) => n.attrs.get('role') === 'list' && n.attrs.has('data-cards'))[0]!;
    expect(list.attrs.get('aria-label')).toBeTruthy();
    expect(t.items().map((n) => n.attrs.get('data-card'))).toEqual(['a', 'b']);
    const a = t.text(t.items()[0]!);
    expect(a).toContain('<b>Hotel A</b>');
    expect(a).toContain('Near the <i>Haram</i>');
    expect(a).toContain('SAR 100');
    expect(a.indexOf('Breakfast')).toBeLessThan(a.indexOf('<u>5 min</u>'));
    expect(t.root.find((n) => ['b', 'i', 'u', 'img', 'a'].includes(n.tag))).toEqual([]);
    expect(t.btn('Book <b>Hotel A</b>').attrs.get('type')).toBe('button');
  });

  it('skips malformed cards/chips and duplicate ids', () => {
    const t = carded({ cards: [{ id: '', title: 'x', description: '', priceLabel: '' }, { id: 'a', title: '', description: '', priceLabel: '' }, { id: 'ok', title: 'Ok', description: 'd', priceLabel: 'p', chips: [{ id: '', label: 'bad' }] }, { id: 'ok', title: 'Dup', description: '', priceLabel: '' }] });
    expect(t.items().map((n) => n.attrs.get('data-card'))).toEqual(['ok']);
    expect(t.text(t.items()[0]!)).not.toContain('bad');
  });

  it('select -> confirm emits once each and ends confirmed with mock-only copy', () => {
    const t = carded({ cards });
    const book = t.btn('Book Hotel B');
    expect(book.attrs.get('aria-pressed')).toBe('false');
    expect(t.btn('Confirm booking', 1).hidden).toBe(true);
    book.fire('click');
    book.fire('click'); // idempotent
    expect(t.actions).toEqual([{ type: 'select_card', cardId: 'b' }]);
    expect(book.attrs.get('aria-pressed')).toBe('true');
    expect(t.btn('Confirm booking', 1).hidden).toBe(false);
    t.btn('Confirm booking', 1).fire('click');
    t.btn('Confirm booking', 1).fire('click');
    expect(t.actions).toEqual([{ type: 'select_card', cardId: 'b' }, { type: 'confirm_booking', cardId: 'b' }]);
    const txt = t.text(t.items()[1]!);
    expect(txt).toContain('Booking request ready for Hotel B.');
    expect(txt).toMatch(/mock/i);
    expect(txt).not.toMatch(/booked|reserved/i);
    expect([book.hidden, t.btn('Confirm booking', 1).hidden, t.btn('Cancel', 1).hidden]).toEqual([true, true, true]);
    book.fire('click');
    t.btn('Cancel', 1).fire('click');
    expect(t.actions).toHaveLength(2);
  });

  it('cancel returns to unselected and emits once; cancel while idle is a no-op', () => {
    const t = carded({ cards });
    t.btn('Cancel').fire('click');
    expect(t.actions).toEqual([]);
    t.btn('Book <b>Hotel A</b>').fire('click');
    t.btn('Cancel').fire('click');
    t.btn('Cancel').fire('click');
    expect(t.actions).toEqual([{ type: 'select_card', cardId: 'a' }, { type: 'cancel_booking', cardId: 'a' }]);
    expect(t.btn('Book <b>Hotel A</b>').attrs.get('aria-pressed')).toBe('false');
    expect(t.btn('Confirm booking').hidden).toBe(true);
    t.btn('Book <b>Hotel A</b>').fire('click'); // can reselect
    expect(t.actions).toHaveLength(3);
  });

  it('selecting another card replaces the previous selection without a cancel notification', () => {
    const t = carded({ cards });
    t.btn('Book <b>Hotel A</b>').fire('click');
    t.btn('Book Hotel B').fire('click');
    expect(t.btn('Book <b>Hotel A</b>').attrs.get('aria-pressed')).toBe('false');
    expect(t.btn('Book Hotel B').attrs.get('aria-pressed')).toBe('true');
    expect(t.btn('Confirm booking', 0).hidden).toBe(true);
    expect(t.btn('Confirm booking', 1).hidden).toBe(false);
    expect(t.actions.map((a) => a.type)).toEqual(['select_card', 'select_card']);
  });

  it('works without a callback and survives a throwing callback', () => {
    const t = carded({ cards }, false);
    t.btn('Book Hotel B').fire('click');
    expect(t.btn('Book Hotel B').attrs.get('aria-pressed')).toBe('true');
    const p = mountPanel({ createElement: (x) => new N(x), body: new N('body') }, { client: null, fixtures: { cards }, onBookingAction: () => { throw new Error('boom'); } });
    const b = (p.host as N).shadow!.find((n) => n.attrs.get('aria-label') === 'Book Hotel B')[0]!;
    expect(() => b.fire('click')).not.toThrow();
    expect(b.attrs.get('aria-pressed')).toBe('true');
  });

  it('introduces no network/storage/timer/random/provider usage in the source', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/panel.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|setTimeout|setInterval|Math\.random|Date\.now|crypto|innerHTML|navigator)\b/);
  });
});
