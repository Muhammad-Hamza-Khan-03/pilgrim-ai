import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTenantDataStore, exportTenant, resolveTenantContext } from '../src/index.js';
import { clock, ctxFor, makeFixture, userCtx } from './helpers.js';

interface Rec { id: string; tenantId?: string; siteId?: string; userId?: string; datasetVersion: string; text: string }
const rec = (id: string, tenantId: string, datasetVersion = 'v1', extra: Partial<Rec> = {}): Rec => ({ id, tenantId, datasetVersion, text: `${tenantId}:${id}`, ...extra });

function stores() {
  const fx = makeFixture();
  const data = createTenantDataStore<Rec>({ initial: [{ id: 'legacy', datasetVersion: 'v1', text: 'unscoped' } as Rec] });
  const opA = userCtx(fx, 'u-op', 'ingest');
  const opB = userCtx(fx, 'u-b', 'ingest', 'b');
  expect(data.put(opA, rec('r1', 't-a')).ok).toBe(true);
  expect(data.put(opA, rec('r2', 't-a', 'v2')).ok).toBe(true);
  expect(data.put(opB, rec('r1', 't-b')).ok).toBe(true); // same id, other tenant: no collision
  expect(data.put(opB, rec('rb', 't-b')).ok).toBe(true);
  return { fx, data };
}

describe('cross-tenant isolation', () => {
  it('same record id lives independently per tenant', () => {
    const { fx, data } = stores();
    expect(data.get(userCtx(fx, 'u-mem', 'retrieval'), 'r1')?.text).toBe('t-a:r1');
    expect(data.get(userCtx(fx, 'u-b', 'retrieval', 'b'), 'r1')?.text).toBe('t-b:r1');
    expect(data.get(userCtx(fx, 'u-mem', 'retrieval'), 'rb')).toBeNull();
  });
  it('unscoped records are never returned', () => {
    const { fx, data } = stores();
    const c = userCtx(fx, 'u-mem', 'retrieval');
    expect(data.get(c, 'legacy')).toBeNull();
    expect(data.list(c).map((r) => r.id)).toEqual(['r1', 'r2']);
  });
  it('a caller-supplied foreign tenantId in a query cannot widen scope', () => {
    const { fx, data } = stores();
    expect(data.list(userCtx(fx, 'u-mem', 'retrieval'), { tenantId: 't-b' })).toEqual([]);
  });
  it('retrieval filters tenant AND dataset version', () => {
    const { fx, data } = stores();
    const out = data.list(ctxFor(fx, { purpose: 'retrieval' }), { filter: (r) => r.datasetVersion === 'v1' });
    expect(out.map((r) => r.text)).toEqual(['t-a:r1']);
  });
  it('writes with a foreign owner or a weak role are denied and write nothing', () => {
    const { fx, data } = stores();
    const before = JSON.stringify(data.list(userCtx(fx, 'u-op', 'retrieval')));
    expect(data.put(userCtx(fx, 'u-op', 'ingest'), rec('x', 't-b'))).toMatchObject({ ok: false, code: 'tenant_mismatch' });
    expect(data.put(userCtx(fx, 'u-op', 'ingest'), rec('x', 'unset' as never, 'v1', { tenantId: undefined }))).toMatchObject({ ok: false });
    expect(data.put(ctxFor(fx, { purpose: 'ingest', principal: { userId: 'u-view' }, sessionId: 'v', newSession: true }), rec('y', 't-a'))).toMatchObject({ ok: false, code: 'role_denied' });
    expect(data.delete(userCtx(fx, 'u-op', 'ingest'), 'rb')).toMatchObject({ ok: false }); // foreign id: nothing deleted
    expect(JSON.stringify(data.list(userCtx(fx, 'u-op', 'retrieval')))).toBe(before);
    expect(data.get(userCtx(fx, 'u-b', 'retrieval', 'b'), 'rb')).not.toBeNull();
  });
  it('anonymous sessions cannot reach ingest/control-plane/export/delete', () => {
    const fx = makeFixture();
    for (const purpose of ['ingest', 'control_plane', 'export', 'delete'] as const) {
      const r = resolveTenantContext({ tenantId: 't-a', siteId: 's-a', origin: 'https://a.example', sessionId: 'sess-anon-a', purpose }, { directory: fx.directory, clock: () => clock.now });
      expect(r).toMatchObject({ ok: false, code: 'unauthenticated' });
    }
  });
  it('identity store reads are tenant-scoped', () => {
    const fx = makeFixture();
    const c = userCtx(fx, 'u-mem', 'chat');
    expect(fx.store.getTenant(c, 't-a')?.id).toBe('t-a');
    expect(fx.store.getTenant(c, 't-b')).toBeNull();
    expect(fx.store.getSite(c, 's-a')?.id).toBe('s-a');
    expect(fx.store.getSite(c, 's-b')).toBeNull();
    expect(fx.store.getSession(c, 'sess-anon-b')).toBeNull();
    expect(fx.store.getMembership(c, 'u-mem', 't-b')).toBeNull();
    expect(fx.store.getMembership(c, 'u-owner', 't-a')).toBeNull(); // plain members cannot read others
    expect(fx.store.getUser(c, 'u-b')).toBeNull();
  });
  it('tenant export contains no foreign ids', () => {
    const { fx, data } = stores();
    const r = exportTenant(userCtx(fx, 'u-admin', 'export'), { identity: fx, data: { sources: data } });
    expect(r.ok).toBe(true);
    const text = JSON.stringify(r);
    for (const foreign of ['t-b', 's-b', 'sess-anon-b', 'u-b', 'rb', 'legacy']) expect(text).not.toContain(`"${foreign}"`);
    expect(text).not.toContain('t-b:');
  });
  it('failed authorization causes no side effects', () => {
    const { fx, data } = stores();
    const admin = userCtx(fx, 'u-admin', 'export');
    const snap = () => JSON.stringify([exportTenant(admin, { identity: fx, data: { d: data } }), fx.audit]);
    const before = snap();
    const anon = ctxFor(fx, { purpose: 'chat' });
    clock.now += 1000;
    expect(fx.store.putSession(anon, { id: 'sess-anon-b', tenantId: 't-b', siteId: 's-b', status: 'active', createdAt: 0, lastSeenAt: 0, expiresAt: 5 })).toMatchObject({ ok: false });
    expect(fx.store.revokeSession(anon, 'sess-anon-b')).toMatchObject({ ok: false });
    expect(fx.store.revokeSession(anon, 'sess-owner')).toMatchObject({ ok: false }); // not own session, not admin
    expect(data.put(anon, rec('z', 't-a'))).toMatchObject({ ok: false });
    expect(fx.directory.getSession({ system: 'resolve_context' }, 'sess-anon-b')).toMatchObject({ status: 'active', expiresAt: expect.any(Number) });
    expect(snap().replace(/"generatedAt":\d+/, '')).toBe(before.replace(/"generatedAt":\d+/, ''));
  });
});

describe('local-only source scan', () => {
  const dir = new URL('../src/', import.meta.url);
  const files = readdirSync(dir).map((f) => [f, readFileSync(new URL(f, dir), 'utf8')] as const);
  const FORBIDDEN: Array<[string, RegExp]> = [
    ['network', /\bfetch\s*\(|XMLHttpRequest|WebSocket|node:(?:http|https|net|dgram|tls|dns|child_process)/],
    ['provider/sdk', /openai|anthropic|auth0|clerk|firebase|supabase|cloudflare|vercel|oidc|oauth/i],
    ['env/credentials', /process\.env|import\.meta\.env|api[_-]?key|password/i],
    ['storage', /localStorage|sessionStorage|indexedDB|document\.cookie|node:fs/],
    ['ambient clock/randomness', /Date\.now|new Date\b|Math\.random|performance\.now|randomUUID|crypto\./],
  ];
  for (const [rule, re] of FORBIDDEN) it(`no ${rule}`, () => { for (const [name, text] of files) expect({ name, hit: text.match(re)?.[0] }).toEqual({ name, hit: undefined }); });
  it('only relative imports', () => { for (const [name, text] of files) for (const m of text.matchAll(/from '([^']+)'/g)) expect([name, m[1]!.startsWith('./')]).toEqual([name, true]); });
});
