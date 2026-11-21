// Local, provider-neutral widget host. No network, storage or globals: DOM, session store and handoff are injected.
import type { ChatTurn } from './chat.js';

// ---- structural DOM (no DOM lib; tests use a fake) ----
export interface HostNode {
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, listener: () => void): void;
  appendChild(child: HostNode): unknown;
  textContent: string | null;
  attachShadow?(init: { mode: 'open' | 'closed' }): { appendChild(child: HostNode): unknown };
}
export interface HostDocument { createElement(tag: string): HostNode }

// ---- typed public config ----
export interface HostConfig { tenant: string; siteId?: string; apiUrl?: string; version?: string; allowedOrigins: string[] }
export type HostConfigInput = Partial<Record<'tenant' | 'siteId' | 'apiUrl' | 'version' | 'allowedOrigins', string | null | undefined>>;

const ID_RE = /^[A-Za-z0-9_-]+$/;
const VERSION_RE = /^[A-Za-z0-9._-]{1,32}$/;

function httpUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Exact http(s) origin or null (paths, queries, wildcards and credentials are rejected). */
export function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin !== raw.trim() || u.origin === 'null') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Fails closed: any present-but-invalid value, a missing tenant, or an empty origin list yields null. */
export function parseHostConfig(input: HostConfigInput): HostConfig | null {
  const tenant = input.tenant?.trim() ?? '';
  if (!ID_RE.test(tenant)) return null;
  const cfg: HostConfig = { tenant, allowedOrigins: [] };
  if (input.siteId != null) {
    if (!ID_RE.test(input.siteId.trim())) return null;
    cfg.siteId = input.siteId.trim();
  }
  if (input.apiUrl != null) {
    const u = httpUrl(input.apiUrl);
    if (!u || /[?#]/.test(input.apiUrl)) return null;
    cfg.apiUrl = u;
  }
  if (input.version != null) {
    if (!VERSION_RE.test(input.version.trim())) return null;
    cfg.version = input.version.trim();
  }
  const origins = (input.allowedOrigins ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  const norm = origins.map(normalizeOrigin);
  if (!norm.length || norm.includes(null)) return null;
  cfg.allowedOrigins = [...new Set(norm as string[])];
  return cfg;
}

/** Origin binding contract: the embedding page origin must be listed exactly. */
export const isOriginAllowed = (cfg: HostConfig, pageOrigin: string): boolean => cfg.allowedOrigins.includes(pageOrigin);

// ---- session resume (storage-neutral) ----
export const SESSION_SNAPSHOT_VERSION = 1 as const;
export interface SessionSnapshot { version: 1; tenant: string; siteId: string | null; origin: string; sessionId: string; history: ChatTurn[] }
export interface SessionStore { load(key: string): unknown; save(key: string, snapshot: SessionSnapshot): void }
export function createMemorySessionStore(): SessionStore {
  const m = new Map<string, SessionSnapshot>();
  return { load: (k) => m.get(k), save: (k, s) => void m.set(k, structuredClone(s)) };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const sessionKey = (cfg: HostConfig, origin: string) => `pilgrim:${cfg.tenant}:${cfg.siteId ?? '-'}:${origin}`;

/** Returns the snapshot only if well-formed AND bound to this tenant/site/origin; otherwise null. */
export function parseSnapshot(raw: unknown, cfg: HostConfig, origin: string): SessionSnapshot | null {
  if (!isObj(raw) || raw.version !== SESSION_SNAPSHOT_VERSION) return null;
  if (raw.tenant !== cfg.tenant || raw.siteId !== (cfg.siteId ?? null) || raw.origin !== origin) return null;
  if (!isStr(raw.sessionId) || raw.sessionId === '' || !Array.isArray(raw.history)) return null;
  for (const t of raw.history) {
    if (!isObj(t) || (t.role !== 'user' && t.role !== 'assistant') || !isStr(t.content)) return null;
  }
  return raw as unknown as SessionSnapshot;
}

// ---- grounded turn view (structural mirror of @pilgrim/engine GroundedTurnResult grounded-turn/v1) ----
export interface ViewCitation { evidence_id: string; source: string }
export interface GroundedTurnView {
  schema_version: 'grounded-turn/v1';
  status: 'grounded' | 'insufficient_evidence' | 'degraded';
  claims: Array<{ id: string; text: string; citations: ViewCitation[] }>;
  cards: Array<{ id: string; kind: string; title: string; citations: ViewCitation[] }>;
  recommendations: Array<{ id: string; advisory: true; rank: number; title: string; rationale: string; citations: ViewCitation[] }>;
}

const cites = (v: unknown): v is ViewCitation[] => Array.isArray(v) && v.every((c) => isObj(c) && isStr(c.evidence_id) && isStr(c.source));
const listOf = (v: unknown, ok: (x: Record<string, unknown>) => boolean) => Array.isArray(v) && v.every((x) => isObj(x) && isStr(x.id) && cites(x.citations) && ok(x));

export function parseGroundedTurn(raw: unknown): GroundedTurnView | null {
  if (!isObj(raw) || raw.schema_version !== 'grounded-turn/v1') return null;
  if (raw.status !== 'grounded' && raw.status !== 'insufficient_evidence' && raw.status !== 'degraded') return null;
  if (!listOf(raw.claims, (c) => isStr(c.text))) return null;
  if (!listOf(raw.cards, (c) => isStr(c.kind) && isStr(c.title))) return null;
  if (!listOf(raw.recommendations, (r) => r.advisory === true && typeof r.rank === 'number' && isStr(r.title) && isStr(r.rationale))) return null;
  return raw as unknown as GroundedTurnView;
}

// ---- host ----
export interface HandoffRequest { advisory: true; recommendationId: string; title: string }
export interface HostOptions {
  doc: HostDocument;
  mount: HostNode; // host-page element we own; nothing outside it is touched
  config: HostConfig;
  pageOrigin: string;
  sessionStore?: SessionStore;
  /** Local callback seam only: the host performs no delivery, network call or navigation. */
  onHandoff?: (req: HandoffRequest) => void;
  /** Maps a citation to a link target; non-http(s) results are ignored (rendered as plain chip). */
  citationHref?: (c: ViewCitation) => string | undefined;
}
export interface WidgetHost {
  readonly isolation: 'shadow' | 'fallback';
  readonly resumed: SessionSnapshot | null;
  render(result: unknown): boolean;
  addUserMessage(text: string): void;
  saveSession(sessionId: string, history: ChatTurn[]): boolean;
  destroy(): void;
}

const STYLE =
  ':host{all:initial}.p{font:14px/1.4 system-ui,sans-serif;color:#111;background:#fff;border:1px solid #ccc;border-radius:8px;padding:8px;display:block}' +
  '.chip{display:inline-block;border:1px solid #888;border-radius:12px;padding:0 8px;margin:2px;font-size:12px;color:#111}a.chip{text-decoration:underline;color:#0645ad}';

/** Returns null (fail closed) when config is invalid for this origin. */
export function createWidgetHost(opts: HostOptions): WidgetHost | null {
  try {
    const { doc, mount, config, pageOrigin } = opts;
    if (!parseHostConfig({ ...config, allowedOrigins: config.allowedOrigins.join(',') }) || !isOriginAllowed(config, pageOrigin)) return null;

    const shadow = mount.attachShadow?.({ mode: 'closed' }) ?? null;
    const root: { appendChild(c: HostNode): unknown } = shadow ?? mount;
    // Fallback (no ShadowRoot): inline reset only; no shared stylesheet is injected, so nothing leaks to the page.
    mount.setAttribute('style', 'all:initial;display:block');
    if (shadow) {
      const style = doc.createElement('style');
      style.textContent = STYLE;
      root.appendChild(style);
    }
    const region = doc.createElement('section');
    region.setAttribute('class', 'p');
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', 'Pilgrim AI chat');
    const log = doc.createElement('div');
    log.setAttribute('role', 'log');
    log.setAttribute('aria-live', 'polite');
    region.appendChild(log);
    root.appendChild(region);

    let alive = true;
    const el = (tag: string, text?: string, attrs: Record<string, string> = {}) => {
      const e = doc.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      if (text !== undefined) e.textContent = text; // text only; never innerHTML
      return e;
    };
    const add = (parent: HostNode, child: HostNode) => (parent.appendChild(child), child);
    const chip = (c: ViewCitation) => {
      const raw = opts.citationHref?.(c);
      const href = raw && httpUrl(raw);
      return href
        ? el('a', c.source, { class: 'chip', href, rel: 'noopener noreferrer', target: '_blank' })
        : el('span', c.source, { class: 'chip' });
    };
    const chips = (parent: HostNode, cs: ViewCitation[]) => {
      if (cs.length) { const row = add(parent, el('div', undefined, { 'aria-label': 'Sources' })); cs.forEach((c) => add(row, chip(c))); }
    };
    const turn = (who: 'user' | 'assistant') => add(log, el('article', undefined, { 'data-role': who }));

    const store = opts.sessionStore;
    const key = sessionKey(config, pageOrigin);
    const resumed = store ? parseSnapshot(store.load(key), config, pageOrigin) : null;
    if (resumed) resumed.history.forEach((t) => add(turn(t.role), el('p', t.content)));

    return {
      isolation: shadow ? 'shadow' : 'fallback',
      resumed,
      addUserMessage(text) {
        if (alive) add(turn('user'), el('p', text));
      },
      render(result) {
        if (!alive) return false;
        const g = parseGroundedTurn(result);
        const t = turn('assistant');
        if (!g) { add(t, el('p', 'This response could not be displayed.', { role: 'alert' })); return false; }
        if (g.status !== 'grounded') add(t, el('p', g.status === 'degraded' ? 'Answer unavailable right now.' : 'Not enough verified information to answer.', { role: 'status' }));
        for (const c of g.claims) { const p = add(t, el('p', c.text)); chips(p, c.citations); }
        for (const c of g.cards) {
          const card = add(t, el('article', undefined, { 'data-kind': c.kind }));
          add(card, el('h3', c.title));
          chips(card, c.citations);
        }
        for (const r of [...g.recommendations].sort((a, b) => a.rank - b.rank)) {
          const rec = add(t, el('div', undefined, { 'data-advisory': 'true' }));
          add(rec, el('strong', r.title));
          add(rec, el('p', r.rationale));
          chips(rec, r.citations);
          const btn = add(rec, el('button', 'Talk to an agent', { type: 'button' }));
          if (!opts.onHandoff) btn.setAttribute('disabled', '');
          btn.addEventListener('click', () => {
            try { if (alive) opts.onHandoff?.({ advisory: true, recommendationId: r.id, title: r.title }); } catch { /* callback errors never break the host */ }
          });
        }
        return true;
      },
      saveSession(sessionId, history) {
        if (!store || !alive) return false;
        const snap: SessionSnapshot = { version: 1, tenant: config.tenant, siteId: config.siteId ?? null, origin: pageOrigin, sessionId, history };
        if (!parseSnapshot(snap, config, pageOrigin)) return false;
        store.save(key, snap);
        return true;
      },
      destroy() { alive = false; },
    };
  } catch {
    return null;
  }
}
