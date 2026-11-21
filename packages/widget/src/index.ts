import { parseHostConfig } from './host.js';
export * from './host.js';

// Minimal structural DOM types: the loader needs no DOM lib and tests use a fake.
export interface WidgetElement {
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, listener: () => void): void;
  textContent: string | null;
}
export interface WidgetDocument {
  createElement(tag: string): WidgetElement;
  querySelector(selector: string): WidgetElement | null;
  body: { appendChild(el: WidgetElement): unknown } | null;
}

export const DEFAULT_LABEL = 'Open chat';
const LAUNCHER_SELECTOR = '[data-pilgrim-launcher]';
const BUNDLE_SELECTOR = 'script[data-pilgrim-bundle]';

function httpUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Mounts the launcher; returns it, or null when config is invalid (fails closed, never throws). */
export function initWidget(doc: WidgetDocument, script: WidgetElement | null): WidgetElement | null {
  try {
    if (!script || !doc.body) return null;
    const tenant = script.getAttribute('data-tenant')?.trim() ?? '';
    const bundleUrl = httpUrl(script.getAttribute('data-bundle-url'));
    const rawApi = script.getAttribute('data-api-url');
    const apiUrl = rawApi === null ? null : httpUrl(rawApi);
    if (!/^[A-Za-z0-9_-]+$/.test(tenant) || !bundleUrl || (rawApi !== null && !apiUrl)) return null;

    // Optional host config: when any is present, all must validate together (fail closed).
    const host = (['site-id', 'version', 'allowed-origins'] as const).map((n) => script.getAttribute(`data-${n}`));
    if (host.some((v) => v !== null) && !parseHostConfig({ tenant, siteId: host[0], apiUrl: rawApi, version: host[1], allowedOrigins: host[2] })) return null;

    const existing = doc.querySelector(LAUNCHER_SELECTOR);
    if (existing) return existing;

    const button = doc.createElement('button');
    button.setAttribute('type', 'button');
    button.setAttribute('data-pilgrim-launcher', '');
    button.setAttribute('aria-label', DEFAULT_LABEL);
    button.setAttribute('aria-expanded', 'false');
    button.textContent = DEFAULT_LABEL;
    button.addEventListener('click', () => {
      try {
        if (doc.querySelector(BUNDLE_SELECTOR)) return;
        const bundle = doc.createElement('script');
        bundle.setAttribute('src', bundleUrl);
        bundle.setAttribute('async', '');
        bundle.setAttribute('data-pilgrim-bundle', '');
        bundle.setAttribute('data-tenant', tenant);
        if (apiUrl) bundle.setAttribute('data-api-url', apiUrl);
        (['site-id', 'version', 'allowed-origins'] as const).forEach((n, i) => host[i] !== null && bundle.setAttribute(`data-${n}`, host[i]!));
        doc.body?.appendChild(bundle);
        button.setAttribute('aria-expanded', 'true');
      } catch {
        // fail closed: launcher stays closed
      }
    });
    doc.body.appendChild(button);
    return button;
  } catch {
    return null;
  }
}

// Auto-run in a browser; no-op elsewhere (SSR/tests).
const g = globalThis as { document?: WidgetDocument & { currentScript?: WidgetElement | null } };
if (g.document) initWidget(g.document, g.document.currentScript ?? null);
