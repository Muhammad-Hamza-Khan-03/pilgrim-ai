// Chat panel seam: isolated (Shadow DOM) accessible dialog over an injected chat client.
// Structural DOM types keep the bundle DOM-lib free; tests use a fake. No network, storage or globals here.
import { ChatClientError, type ChatResponse } from './chat.js';

export interface PanelEvent { key?: string; shiftKey?: boolean; isComposing?: boolean; preventDefault(): void }
export interface PanelNode {
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: (e: PanelEvent) => void): void;
  appendChild(child: PanelNode): unknown;
  textContent: string | null;
  hidden?: boolean;
  disabled?: boolean;
  value?: string;
  focus?(): void;
  attachShadow?(init: { mode: 'open' }): PanelNode;
}
export interface PanelDocument { createElement(tag: string): PanelNode; body: { appendChild(el: PanelNode): unknown } | null }
export interface PanelClient { send(message: string): Promise<ChatResponse> }

const STYLE =
  ':host{all:initial;position:fixed;right:1rem;bottom:4rem;z-index:2147483647;font:14px/1.4 system-ui,sans-serif}' +
  '[role=dialog]{display:flex;flex-direction:column;width:min(22rem,calc(100vw - 2rem));max-height:70vh;background:#fff;color:#111;border:1px solid #888;border-radius:8px;padding:.5rem}' +
  '[hidden]{display:none!important}[role=log]{overflow:auto;flex:1;min-height:6rem}' +
  '[data-role=user]{text-align:right}p{margin:.25rem 0;white-space:pre-wrap}button:focus-visible,textarea:focus-visible{outline:2px solid #05c;outline-offset:2px}';

const ERRORS: Record<string, string> = {
  invalid_config: 'Chat is not configured.',
  invalid_message: 'Please enter a message.',
  network_error: 'Could not reach the chat service.',
  http_error: 'The chat service returned an error.',
  invalid_response: 'The chat service sent an unreadable reply.',
  malformed_stream: 'The chat service sent an unreadable reply.',
  timeout: 'The chat service took too long to respond.',
};

export type PanelStream = (message: string, onChunk: (text: string) => void, signal: AbortSignal) => Promise<unknown>;

export interface PanelChip { id: string; label: string }
export interface PanelCard { id: string; title: string; description: string; priceLabel: string; chips?: PanelChip[] }
export type BookingAction =
  | { type: 'select_card'; cardId: string }
  | { type: 'confirm_booking'; cardId: string }
  | { type: 'cancel_booking'; cardId: string };

export function mountPanel(doc: PanelDocument, opts: {
  client: PanelClient | null; stream?: PanelStream; onClose?: () => void; onOpen?: () => void;
  fixtures?: { cards: PanelCard[] }; onBookingAction?: (action: BookingAction) => void;
}) {
  const el = (tag: string, attrs: Record<string, string> = {}, text?: string, ...kids: PanelNode[]) => {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;
    kids.forEach((k) => n.appendChild(k));
    return n;
  };
  const closeBtn = el('button', { type: 'button', 'aria-label': 'Close chat' }, '×');
  const log = el('div', { role: 'log', 'aria-label': 'Messages', 'aria-live': 'polite' });
  const status = el('div', { role: 'status', 'aria-live': 'polite' });
  const errorBox = el('div', { role: 'alert' });
  const retryBtn = el('button', { type: 'button' }, 'Retry');
  retryBtn.hidden = true;
  const input = el('textarea', { id: 'pilgrim-input', rows: '2', 'aria-label': 'Message' });
  const sendBtn = el('button', { type: 'submit' }, 'Send');
  const form = el('form', {}, undefined, el('label', { for: 'pilgrim-input' }, 'Message'), input, sendBtn);
  // Mock-only booking: state lives in this closure; the callback is a notification and never required.
  const notify = (a: BookingAction) => { try { opts.onBookingAction?.(a); } catch { /* host errors must not break UI */ } };
  const seen = new Set<string>();
  const nonEmpty = (s: unknown): s is string => typeof s === 'string' && s !== '';
  const views: Array<{ id: string; render(selected: boolean): void }> = [];
  let selectedId: string | null = null;
  let confirmedIds = new Set<string>();
  const renderAll = () => views.forEach((v) => v.render(selectedId === v.id));
  const cardItems: PanelNode[] = [];
  for (const c of opts.fixtures?.cards ?? []) {
    if (!c || !nonEmpty(c.id) || !nonEmpty(c.title) || seen.has(c.id)) continue;
    seen.add(c.id);
    const chips = (c.chips ?? []).filter((x) => x && nonEmpty(x.id) && nonEmpty(x.label))
      .map((x) => el('span', { role: 'listitem', 'data-chip': x.id }, x.label));
    const book = el('button', { type: 'button', 'aria-label': `Book ${c.title}`, 'aria-pressed': 'false' }, `Book ${c.title}`);
    const confirm = el('button', { type: 'button' }, 'Confirm booking');
    const cancel = el('button', { type: 'button' }, 'Cancel');
    const done = el('p', {}, `Booking request ready for ${c.title}.`);
    const note = el('p', {}, 'Mock only: no real booking has been made.');
    const controls = el('div', {}, undefined, confirm, cancel);
    const item = el('div', { role: 'listitem', 'data-card': c.id }, undefined,
      el('h3', {}, c.title), el('p', {}, c.description), el('p', {}, c.priceLabel),
      el('div', { role: 'list', 'aria-label': 'Tags' }, undefined, ...chips), book, controls, done, note);
    const id = c.id;
    const render = (selected: boolean) => {
      const isDone = confirmedIds.has(id);
      book.setAttribute('aria-pressed', String(selected));
      book.hidden = isDone;
      controls.hidden = confirm.hidden = cancel.hidden = !selected;
      done.hidden = note.hidden = !isDone;
    };
    views.push({ id, render });
    book.addEventListener('click', () => {
      if (selectedId === id || confirmedIds.has(id)) return;
      selectedId = id;
      renderAll();
      notify({ type: 'select_card', cardId: id });
    });
    confirm.addEventListener('click', () => {
      if (selectedId !== id) return;
      selectedId = null;
      confirmedIds = new Set(confirmedIds).add(id);
      renderAll();
      notify({ type: 'confirm_booking', cardId: id });
    });
    cancel.addEventListener('click', () => {
      if (selectedId !== id) return;
      selectedId = null;
      renderAll();
      notify({ type: 'cancel_booking', cardId: id });
    });
    cardItems.push(item);
  }
  renderAll();
  const cardList = cardItems.length ? [el('div', { role: 'list', 'aria-label': 'Recommendations', 'data-cards': '' }, undefined, ...cardItems)] : [];
  const dialog = el('section', { role: 'dialog', 'aria-label': 'Chat', 'aria-modal': 'false' }, undefined,
    el('h2', {}, 'Chat'), closeBtn, log, ...cardList, status, errorBox, retryBtn, form);
  const host = el('div', { 'data-pilgrim-panel': '' });
  const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  root.appendChild(el('style', {}, STYLE));
  root.appendChild(dialog);

  let busy = false;
  let failed: string | null = null; // text awaiting retry
  let ctl: AbortController | null = null;
  let live: PanelNode | null = null; // assistant message being streamed
  const addMessage = (role: 'user' | 'assistant', text: string) => {
    const m = el('p', { role: 'article', 'data-role': role, 'aria-label': role === 'user' ? 'You' : 'Assistant' }, text);
    log.appendChild(m);
    return m;
  };
  const setBusy = (b: boolean) => {
    busy = b;
    sendBtn.disabled = retryBtn.disabled = b;
    log.setAttribute('aria-busy', String(b));
    status.textContent = b ? 'Sending…' : '';
  };

  async function run(text: string, fresh: boolean) {
    if (busy) return;
    errorBox.textContent = '';
    retryBtn.hidden = true;
    failed = null;
    if (fresh) addMessage('user', text);
    setBusy(true);
    try {
      if (opts.stream) {
        ctl = new AbortController();
        const own = ctl;
        if (live) live.textContent = ''; // retry reuses the partial message
        await opts.stream(text, (c) => { live ??= addMessage('assistant', ''); live.textContent += c; }, own.signal);
        if (own.signal.aborted) throw new ChatClientError('aborted', 'closed');
        live = null;
        setBusy(false);
        return;
      }
      const r = opts.client ? await opts.client.send(text) : null;
      if (!r) throw new ChatClientError('invalid_config', 'no client');
      if (typeof r.reply !== 'string') throw new ChatClientError('invalid_response', 'bad reply');
      addMessage('assistant', r.reply);
    } catch (e) {
      if (e instanceof ChatClientError && e.code === 'aborted') { live = null; setBusy(false); return; } // closed by the user: no error UI
      failed = text;
      errorBox.textContent = ERRORS[e instanceof ChatClientError ? e.code : 'network_error'] ?? ERRORS.network_error!;
      retryBtn.hidden = opts.client === null && !opts.stream;
    }
    setBusy(false);
  }

  function submit() {
    const text = (input.value ?? '').trim();
    if (!text || busy) return;
    input.value = '';
    void run(text, true);
  }
  function setOpen(open: boolean) {
    dialog.hidden = !open;
    dialog.setAttribute('aria-hidden', String(!open));
  }
  function close() {
    ctl?.abort();
    setOpen(false);
    opts.onClose?.();
  }
  function open() {
    setOpen(true);
    opts.onOpen?.();
    input.focus?.();
  }
  const toggle = () => (dialog.hidden ? open() : close());

  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  closeBtn.addEventListener('click', close);
  retryBtn.addEventListener('click', () => { if (failed) void run(failed, false); });

  doc.body?.appendChild(host);
  setOpen(true);
  input.focus?.();
  return { host, close, open, toggle };
}
