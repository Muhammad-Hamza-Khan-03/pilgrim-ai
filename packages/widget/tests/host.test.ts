import { describe, expect, it } from 'vitest';
import { runGroundedTurn } from '../../engine/src/grounded-turn.js';
import { extractor, goodScript, retrieverFor, scriptedComposer, umrahEvidence } from '../../engine/tests/fixtures/grounded-turn.js';
import {
  createMemorySessionStore, createWidgetHost, parseHostConfig, parseSnapshot, type HostConfig, type HostNode, type HostOptions,
} from '../src/host.js';
import { initWidget } from '../src/index.js';

class N implements HostNode {
  attrs = new Map<string, string>();
  kids: N[] = [];
  listeners: Array<() => void> = [];
  textContent: string | null = null;
  shadow: N | null = null;
  constructor(public tag: string) {}
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  addEventListener(_t: string, fn: () => void) { this.listeners.push(fn); }
  appendChild(c: HostNode) { this.kids.push(c as N); }
  click() { this.listeners.forEach((f) => f()); }
  all(): N[] { return this.kids.flatMap((k) => [k, ...k.all()]); }
  find(tag: string) { return this.all().filter((n) => n.tag === tag); }
  text(): string { return [this.textContent ?? '', ...this.kids.map((k) => k.text())].join(' '); }
}
class ShadowMount extends N {
  attachShadow() { this.shadow = new N('#shadow'); return this.shadow; }
}
const doc = { createElement: (t: string) => new N(t) };
const ORIGIN = 'https://shop.example.com';
const cfg: HostConfig = { tenant: 'acme', siteId: 's1', allowedOrigins: [ORIGIN] };
const mk = (over: Partial<HostOptions> = {}, mount: N = new ShadowMount('div')) => {
  const host = createWidgetHost({ doc, mount, config: cfg, pageOrigin: ORIGIN, ...over });
  return { host, mount, root: (mount.shadow ?? mount) as N };
};
const turn = (message: string) =>
  runGroundedTurn({ message, extract: extractor, retrieve: retrieverFor(umrahEvidence), compose: scriptedComposer(goodScript) });

describe('config + origin', () => {
  const ok = { tenant: 'acme', siteId: 's1', apiUrl: 'https://api.test', version: '1.0.0', allowedOrigins: `${ORIGIN}, http://localhost:8080` };
  it('parses public config', () => {
    expect(parseHostConfig(ok)).toEqual({ tenant: 'acme', siteId: 's1', apiUrl: 'https://api.test/', version: '1.0.0', allowedOrigins: [ORIGIN, 'http://localhost:8080'] });
  });
  it.each([
    ['bad tenant', { tenant: 'a b' }], ['bad site', { siteId: 'x/y' }], ['bad api', { apiUrl: 'ftp://x' }], ['api query', { apiUrl: 'https://a.test/?k=1' }],
    ['bad version', { version: '<1>' }], ['no origins', { allowedOrigins: '' }], ['wildcard origin', { allowedOrigins: '*' }],
    ['origin with path', { allowedOrigins: 'https://a.test/x' }], ['origin trailing slash', { allowedOrigins: 'https://a.test/' }], ['js origin', { allowedOrigins: 'javascript:alert(1)' }],
  ])('rejects %s', (_n, over) => expect(parseHostConfig({ ...ok, ...over })).toBeNull());
  it('host refuses unlisted or empty page origin and renders nothing', () => {
    const m = new ShadowMount('div');
    expect(createWidgetHost({ doc, mount: m, config: cfg, pageOrigin: 'https://evil.example', })).toBeNull();
    expect(createWidgetHost({ doc, mount: m, config: cfg, pageOrigin: '' })).toBeNull();
    expect(m.shadow).toBeNull();
  });
  it('refuses a hand-built invalid config', () => {
    expect(createWidgetHost({ doc, mount: new N('div'), config: { tenant: 'a b', allowedOrigins: [ORIGIN] }, pageOrigin: ORIGIN })).toBeNull();
  });
});

describe('isolation', () => {
  it('uses a closed shadow root with scoped style when available', () => {
    const { host, mount, root } = mk();
    expect(host!.isolation).toBe('shadow');
    expect(mount.kids).toHaveLength(0);
    expect(root.find('style')).toHaveLength(1);
    expect(mount.getAttribute('style')).toContain('all:initial');
  });
  it('falls back to the mount without injecting a stylesheet', () => {
    const { host, mount } = mk({}, new N('div'));
    expect(host!.isolation).toBe('fallback');
    expect(mount.find('style')).toHaveLength(0);
    expect(mount.find('section')).toHaveLength(1);
    expect(mount.getAttribute('style')).toContain('all:initial');
  });
});

describe('rendering', () => {
  it('renders real engine output: accessible log, claims, cards, chips, advisory', async () => {
    const { host, root } = mk();
    expect(host!.render(await turn('hotel for 3 nights'))).toBe(true);
    const region = root.find('section')[0]!;
    expect(region.getAttribute('aria-label')).toBe('Pilgrim AI chat');
    expect(root.find('div').find((d) => d.getAttribute('role') === 'log')!.getAttribute('aria-live')).toBe('polite');
    const text = root.text();
    expect(text).toContain('Hotel Zamzam costs 120 SAR per night.');
    expect(root.find('h3').map((h) => h.textContent).sort()).toEqual(['Hotel Zamzam 150 m', 'Rate 120 SAR'].sort());
    expect(root.find('span').some((s) => s.textContent === 'catalog/hotels')).toBe(true);
    expect(root.find('button')).toHaveLength(1);
  });
  it('citation links only for http(s) hrefs, with safe rel', async () => {
    const hrefs: Record<string, string> = { 'faq/umrah-visa': 'https://docs.example/visa', x: 'javascript:alert(1)' };
    const { host, root } = mk({ citationHref: (c) => hrefs[c.source] });
    host!.render(await turn('visa'));
    const a = root.find('a');
    expect(a).toHaveLength(1);
    expect(a[0]!.getAttribute('href')).toBe('https://docs.example/visa');
    expect(a[0]!.getAttribute('rel')).toBe('noopener noreferrer');
    const bad = mk({ citationHref: () => 'javascript:alert(1)' });
    bad.host!.render(await turn('visa'));
    expect(bad.root.find('a')).toHaveLength(0);
    expect(bad.root.find('span').length).toBeGreaterThan(0);
  });
  it('renders hostile text as text, never markup', () => {
    const { host, root } = mk();
    host!.render({ schema_version: 'grounded-turn/v1', status: 'grounded', claims: [{ id: 'c', text: '<img src=x onerror=alert(1)>', citations: [] }], cards: [], recommendations: [] });
    expect(root.find('img')).toHaveLength(0);
    expect(root.text()).toContain('<img src=x onerror=alert(1)>');
  });
  it('insufficient_evidence shows a status notice', async () => {
    const { host, root } = mk();
    host!.render(await runGroundedTurn({ message: 'flight?', extract: extractor, retrieve: retrieverFor(umrahEvidence), compose: scriptedComposer(goodScript) }));
    expect(root.text()).toContain('Not enough verified information');
  });
  it.each([null, 'x', {}, { schema_version: 'grounded-turn/v2' }, { schema_version: 'grounded-turn/v1', status: 'grounded', claims: [{ id: 1 }], cards: [], recommendations: [] }])(
    'fails closed on invalid result %#', (bad) => {
      const { host, root } = mk();
      expect(host!.render(bad)).toBe(false);
      expect(root.find('p').map((p) => p.getAttribute('role'))).toEqual(['alert']);
    });
});

describe('advisory handoff', () => {
  it('only invokes the local callback with advisory payload', async () => {
    const calls: unknown[] = [];
    const { host, root } = mk({ onHandoff: (r) => calls.push(r) });
    host!.render(await turn('hotel'));
    root.find('button')[0]!.click();
    expect(calls).toEqual([{ advisory: true, recommendationId: expect.any(String), title: 'Consider Hotel Zamzam' }]);
  });
  it('is disabled without a callback and survives throwing callbacks / destroy', async () => {
    const a = mk();
    a.host!.render(await turn('hotel'));
    expect(a.root.find('button')[0]!.getAttribute('disabled')).toBe('');
    const b = mk({ onHandoff: () => { throw new Error('x'); } });
    b.host!.render(await turn('hotel'));
    expect(() => b.root.find('button')[0]!.click()).not.toThrow();
    const calls: unknown[] = [];
    const c = mk({ onHandoff: (r) => calls.push(r) });
    c.host!.render(await turn('hotel'));
    c.host!.destroy();
    c.root.find('button')[0]!.click();
    expect(calls).toHaveLength(0);
    expect(c.host!.render(await turn('visa'))).toBe(false);
  });
});

describe('session resume', () => {
  const history = [{ role: 'user' as const, content: 'hi' }, { role: 'assistant' as const, content: 'hello' }];
  it('saves, then resumes and renders history from the injected store', () => {
    const sessionStore = createMemorySessionStore();
    expect(mk({ sessionStore }).host!.saveSession('sess-1', history)).toBe(true);
    const { host, root } = mk({ sessionStore });
    expect(host!.resumed?.sessionId).toBe('sess-1');
    expect(root.text()).toContain('hello');
  });
  it('ignores invalid or foreign snapshots', () => {
    const base = { version: 1, tenant: 'acme', siteId: 's1', origin: ORIGIN, sessionId: 's', history };
    const c = { ...cfg };
    expect(parseSnapshot(base, c, ORIGIN)).not.toBeNull();
    for (const bad of [null, 'x', { ...base, version: 2 }, { ...base, tenant: 'other' }, { ...base, origin: 'https://o.test' }, { ...base, siteId: null },
      { ...base, sessionId: '' }, { ...base, history: [{ role: 'system', content: 'x' }] }, { ...base, history: 'no' }]) {
      expect(parseSnapshot(bad, c, ORIGIN)).toBeNull();
    }
    const store = { load: () => ({ ...base, history: 5 }), save: () => {} };
    expect(mk({ sessionStore: store }).host!.resumed).toBeNull();
  });
  it('no store: resume null and save false', () => {
    const { host } = mk();
    expect(host!.resumed).toBeNull();
    expect(host!.saveSession('s', history)).toBe(false);
  });
});

describe('loader compatibility', () => {
  const base = { 'data-tenant': 'acme', 'data-bundle-url': 'https://cdn.example.com/chat.js' };
  const run = (attrs: Record<string, string>) => {
    const kids: N[] = [];
    const d = { createElement: (t: string) => new N(t), querySelector: (s: string) => kids.find((k) => (s.includes('launcher') ? k.attrs.has('data-pilgrim-launcher') : k.attrs.has('data-pilgrim-bundle'))) ?? null, body: { appendChild: (e: unknown) => kids.push(e as N) } };
    const script = new N('script');
    for (const [k, v] of Object.entries(attrs)) script.setAttribute(k, v);
    const btn = initWidget(d as never, script as never) as N | null;
    return { btn, kids };
  };
  it('legacy attributes still mount; host attrs forward to the bundle', () => {
    expect(run(base).btn).not.toBeNull();
    const r = run({ ...base, 'data-site-id': 's1', 'data-version': '1.0.0', 'data-allowed-origins': ORIGIN });
    r.btn!.click();
    const bundle = r.kids.find((k) => k.tag === 'script')!;
    expect(bundle.getAttribute('data-site-id')).toBe('s1');
    expect(bundle.getAttribute('data-allowed-origins')).toBe(ORIGIN);
  });
  it('invalid host attrs fail closed', () => {
    expect(run({ ...base, 'data-site-id': 's1' }).btn).toBeNull();
    expect(run({ ...base, 'data-site-id': 's1', 'data-allowed-origins': '*' }).btn).toBeNull();
  });
});
