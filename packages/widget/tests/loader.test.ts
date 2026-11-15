import { describe, expect, it } from 'vitest';
import { initWidget, type WidgetDocument, type WidgetElement } from '../src/index.js';

class El implements WidgetElement {
  attrs = new Map<string, string>();
  listeners: Array<() => void> = [];
  textContent: string | null = null;
  constructor(public tag: string) {}
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  addEventListener(_t: string, fn: () => void) { this.listeners.push(fn); }
  click() { this.listeners.forEach((f) => f()); }
}

function setup(attrs: Record<string, string>) {
  const children: El[] = [];
  const doc: WidgetDocument = {
    createElement: (tag) => new El(tag),
    querySelector: (sel) =>
      children.find((c) =>
        sel === '[data-pilgrim-launcher]'
          ? c.attrs.has('data-pilgrim-launcher')
          : c.tag === 'script' && c.attrs.has('data-pilgrim-bundle'),
      ) ?? null,
    body: { appendChild: (e) => children.push(e as El) },
  };
  const script = new El('script');
  for (const [k, v] of Object.entries(attrs)) script.setAttribute(k, v);
  return { doc, script, children };
}

const good = { 'data-tenant': 'acme', 'data-bundle-url': 'https://cdn.example.com/chat.js' };

describe('widget loader', () => {
  it('renders an accessible launcher with defaults and no bundle', () => {
    const { doc, script, children } = setup(good);
    const btn = initWidget(doc, script) as El;
    expect(children).toEqual([btn]);
    expect(btn.tag).toBe('button');
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.getAttribute('aria-label')).toBe('Open chat');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('lazy-loads the bundle once with config, marking launcher open', () => {
    const { doc, script, children } = setup({ ...good, 'data-api-url': 'https://api.example.com' });
    const btn = initWidget(doc, script) as El;
    btn.click();
    btn.click();
    const bundles = children.filter((c) => c.tag === 'script');
    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.getAttribute('src')).toBe('https://cdn.example.com/chat.js');
    expect(bundles[0]!.getAttribute('data-tenant')).toBe('acme');
    expect(bundles[0]!.getAttribute('data-api-url')).toBe('https://api.example.com/');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });

  it('is idempotent across duplicate loader runs', () => {
    const { doc, script, children } = setup(good);
    const a = initWidget(doc, script);
    const b = initWidget(doc, script);
    expect(b).toBe(a);
    expect(children).toHaveLength(1);
  });

  it.each([
    ['missing tenant', { 'data-bundle-url': good['data-bundle-url'] }],
    ['bad tenant', { ...good, 'data-tenant': 'a b<' }],
    ['missing bundle', { 'data-tenant': 'acme' }],
    ['non-http bundle', { ...good, 'data-bundle-url': 'javascript:alert(1)' }],
    ['invalid api url', { ...good, 'data-api-url': 'nope' }],
  ])('fails closed on %s', (_n, attrs) => {
    const { doc, script, children } = setup(attrs);
    expect(initWidget(doc, script)).toBeNull();
    expect(children).toHaveLength(0);
  });

  it('does not throw without a script, body, or on DOM errors', () => {
    const { doc, script } = setup(good);
    expect(initWidget(doc, null)).toBeNull();
    expect(initWidget({ ...doc, body: null }, script)).toBeNull();
    expect(initWidget({ ...doc, createElement: () => { throw new Error('x'); } }, script)).toBeNull();
  });

  it('does not throw or open if bundle append fails', () => {
    const { doc, script } = setup(good);
    const btn = initWidget(doc, script) as El;
    doc.body = { appendChild: () => { throw new Error('x'); } };
    expect(() => btn.click()).not.toThrow();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });
});
