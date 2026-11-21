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

export function mountPanel(doc: PanelDocument, opts: { client: PanelClient | null; stream?: PanelStream; onClose?: () => void; onOpen?: () => void }) {
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
  const dialog = el('section', { role: 'dialog', 'aria-label': 'Chat', 'aria-modal': 'false' }, undefined,
    el('h2', {}, 'Chat'), closeBtn, log, status, errorBox, retryBtn, form);
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
