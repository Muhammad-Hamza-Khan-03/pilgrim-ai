import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
// @ts-expect-error plain .mjs build script, no types
import { build } from '../scripts/build.mjs';

const committed = new URL('../../../wp-plugin/pilgrim-ai/assets/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, committed), 'utf8');

class El {
  attrs = new Map<string, string>();
  listeners = new Map<string, Array<(e?: unknown) => void>>();
  textContent: string | null = null;
  constructor(public tag: string) {}
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  addEventListener(t: string, fn: () => void) { this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]); }
  click() { this.listeners.get('click')?.forEach((f) => f()); }
}

function runLoader(attrs: Record<string, string>) {
  const children: El[] = [];
  const script = new El('script');
  for (const [k, v] of Object.entries(attrs)) script.setAttribute(k, v);
  const document = {
    currentScript: script,
    createElement: (t: string) => new El(t),
    querySelector: (s: string) =>
      children.find((c) => (s === '[data-pilgrim-launcher]' ? c.attrs.has('data-pilgrim-launcher') : c.attrs.has('data-pilgrim-bundle'))) ?? null,
    body: { appendChild: (e: El) => children.push(e) },
  };
  const fetchCalls: unknown[] = [];
  const sandbox = { URL, document, fetch: (...a: unknown[]) => { fetchCalls.push(a); throw new Error('network'); } };
  runInNewContext(read('loader.js'), sandbox);
  return { children, fetchCalls };
}

describe('local bundle artifacts', () => {
  it('rebuilds byte-identically to the committed artifacts, with metadata', async () => {
    const out = mkdtempSync(join(tmpdir(), 'pilgrim-build-'));
    await build(out);
    for (const f of ['loader.js', 'chat.js', 'build-meta.json']) {
      expect(readFileSync(join(out, f), 'utf8'), f).toBe(read(f));
    }
    const meta = JSON.parse(read('build-meta.json'));
    expect(Object.keys(meta.files).sort()).toEqual(['chat.js', 'loader.js']);
    expect(meta.files['loader.js']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('emits browser-safe IIFEs with no module syntax and no implicit network', () => {
    for (const f of ['loader.js', 'chat.js']) {
      const src = read(f);
      expect(src, f).not.toMatch(/^\s*(import|export)\b|\bimport\s*\(|\brequire\(|process\.env/m);
      expect(src, f).not.toMatch(/(?<![.\w])fetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/);
      expect(src.trimStart().startsWith('"use strict"') || /^\(\(\)\s*=>\s*\{|^\(function/.test(src.trimStart()), f).toBe(true);
    }
  });

  it('loader.js mounts an accessible keyboard-operable button and loads the chat bundle only on activation', () => {
    const { children, fetchCalls } = runLoader({ 'data-tenant': 'acme', 'data-bundle-url': 'https://x.test/chat.js' });
    expect(children).toHaveLength(1);
    const btn = children[0]!;
    // native <button type=button>: Enter/Space activation arrives as click, no custom key handling needed
    expect([btn.tag, btn.getAttribute('type')]).toEqual(['button', 'button']);
    expect(btn.getAttribute('aria-label')).toBe('Open chat');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.listeners.has('keydown')).toBe(false);
    btn.click();
    btn.click();
    expect(children.map((c) => c.tag)).toEqual(['button', 'script']);
    expect(children[1]!.getAttribute('src')).toBe('https://x.test/chat.js');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(fetchCalls).toEqual([]);
  });

  it.each([
    [{ 'data-bundle-url': 'https://x.test/chat.js' }],
    [{ 'data-tenant': 'a b', 'data-bundle-url': 'https://x.test/chat.js' }],
    [{ 'data-tenant': 'acme', 'data-bundle-url': 'javascript:alert(1)' }],
    [{ 'data-tenant': 'acme' }],
    [{ 'data-tenant': 'acme', 'data-bundle-url': 'https://x.test/chat.js', 'data-api-url': 'ftp://x' }],
  ])('loader.js fails closed on bad config %#', (attrs) => {
    expect(runLoader(attrs).children).toEqual([]);
  });

  it('chat.js exposes the chat client with injected fetch only', async () => {
    const sandbox: Record<string, unknown> = { URL, Error, JSON, fetch: () => { throw new Error('global fetch used'); } };
    runInNewContext(read('chat.js'), sandbox);
    const api = sandbox.PilgrimChat as { createChatClient: Function; ChatClientError: Function };
    expect(typeof api.createChatClient).toBe('function');
    expect(() => api.createChatClient({ apiUrl: 'javascript:x', fetch: () => {} })).toThrow();
    const calls: string[] = [];
    const client = api.createChatClient({
      apiUrl: 'https://api.test',
      fetch: async (url: string) => {
        calls.push(url);
        return { ok: true, status: 200, json: async () => ({ contractVersion: 1, sessionId: 's', reply: 'hi', history: [], summary: '' }) };
      },
    });
    expect((await client.send('yo')).reply).toBe('hi');
    expect(calls).toEqual(['https://api.test/chat']);
  });
});
