import { describe, expect, it } from 'vitest';
import { createTenantDataStore, DEFAULT_RETENTION, deleteSelf, exportSelf, exportTenant, planTenantDeletion, resolveTenantContext } from '../src/index.js';
import { clock, ctxFor, DAY, HOUR, makeFixture, T0, userCtx } from './helpers.js';

const sys = { system: 'resolve_context' } as const;
const purge = { system: 'purge_expired' } as const;
const sess = (fx: ReturnType<typeof makeFixture>, id: string) => fx.directory.getSession(sys, id);

describe('retention', () => {
  it('defaults are constants: 24h anonymous, 30d authenticated, bounded max lifetime', () => {
    expect(DEFAULT_RETENTION.anonymousTtlMs).toBe(DAY);
    expect(DEFAULT_RETENTION.authenticatedTtlMs).toBe(30 * DAY);
    expect(DEFAULT_RETENTION.anonymousMaxLifetimeMs).toBeGreaterThanOrEqual(DAY);
    expect(DEFAULT_RETENTION.authenticatedMaxLifetimeMs).toBeGreaterThanOrEqual(30 * DAY);
  });
  it('touching slides expiry but never past max lifetime', () => {
    const fx = makeFixture();
    const ctx = ctxFor(fx, { purpose: 'chat' });
    const cur = fx.store.getSession(ctx, 'sess-anon-a')!;
    clock.now = T0 + 20 * HOUR;
    expect(fx.store.putSession(ctx, cur)).toMatchObject({ ok: true });
    expect(sess(fx, 'sess-anon-a')).toMatchObject({ lastSeenAt: T0 + 20 * HOUR, expiresAt: T0 + 44 * HOUR, createdAt: T0 });
  });
  it('max lifetime caps the sliding window', () => {
    const fx = makeFixture({ policy: { ...DEFAULT_RETENTION, anonymousMaxLifetimeMs: 30 * HOUR } });
    const ctx = ctxFor(fx, { purpose: 'chat' });
    clock.now = T0 + 20 * HOUR;
    fx.store.putSession(ctx, fx.store.getSession(ctx, 'sess-anon-a')!);
    expect(sess(fx, 'sess-anon-a')!.expiresAt).toBe(T0 + 30 * HOUR); // not now+24h
    clock.now = T0 + 29 * HOUR;
    fx.store.putSession(ctx, fx.store.getSession(ctx, 'sess-anon-a')!);
    expect(sess(fx, 'sess-anon-a')!.expiresAt).toBe(T0 + 30 * HOUR);
  });
  it('expired sessions are unreadable, append-rejected and not extended', () => {
    const fx = makeFixture();
    const ctx = ctxFor(fx, { purpose: 'chat' });
    const cur = fx.store.getSession(ctx, 'sess-anon-a')!;
    clock.now = T0 + DAY; // exactly expiry
    expect(fx.store.getSession(ctx, 'sess-anon-a')).toBeNull();
    expect(fx.store.putSession(ctx, cur)).toMatchObject({ ok: false, code: 'session_expired' });
    expect(sess(fx, 'sess-anon-a')).toMatchObject({ expiresAt: T0 + DAY, lastSeenAt: T0 });
    expect(resolveTenantContext({ tenantId: 't-a', siteId: 's-a', origin: 'https://a.example', sessionId: 'sess-anon-a', purpose: 'chat' }, { directory: fx.directory, clock: () => clock.now })).toMatchObject({ code: 'session_expired' });
  });
  it('purgeExpired removes expired sessions deterministically', () => {
    const fx = makeFixture();
    expect(fx.purgeExpired(purge)).toBe(1); // sess-old
    expect(sess(fx, 'sess-old')).toBeNull();
    expect(fx.purgeExpired(purge)).toBe(0);
    clock.now = T0 + 2 * DAY;
    expect(fx.purgeExpired(purge)).toBe(3); // anon a, anon b, revoked
    expect(sess(fx, 'sess-owner')).not.toBeNull();
  });
});

interface Rec { id: string; tenantId: string; userId?: string; text: string }

describe('export', () => {
  const setup = () => {
    const fx = makeFixture();
    const data = createTenantDataStore<Rec>();
    const op = userCtx(fx, 'u-op', 'ingest');
    data.put(op, { id: 'z', tenantId: 't-a', text: 'zed' });
    data.put(op, { id: 'a', tenantId: 't-a', userId: 'u-mem', text: 'mine' });
    data.put(op, { id: 'b', tenantId: 't-a', userId: 'u-view', text: 'theirs' });
    return { fx, data };
  };
  it('self export is scoped to the caller, deterministic and versioned', () => {
    const { fx, data } = setup();
    const ctx = userCtx(fx, 'u-mem', 'export');
    const r1 = exportSelf(ctx, { identity: fx, data: { notes: data } });
    const r2 = exportSelf(ctx, { identity: fx, data: { notes: data } });
    expect(r1).toEqual(r2);
    if (!r1.ok) throw new Error();
    expect(r1.envelope).toMatchObject({ version: 1, scope: 'self', tenantId: 't-a', userId: 'u-mem', generatedAt: clock.now });
    expect(r1.envelope.data.notes.map((r) => r.id)).toEqual(['a']);
    expect(r1.envelope.identity.memberships.map((m) => m.userId)).toEqual(['u-mem']);
    expect(r1.envelope.identity.sessions.every((s) => s.userId === 'u-mem')).toBe(true);
  });
  it('tenant export is owner/admin only, sorted and read-only', () => {
    const { fx, data } = setup();
    expect(exportTenant(userCtx(fx, 'u-op', 'export'), { identity: fx, data: { notes: data } })).toMatchObject({ ok: false, code: 'role_denied' });
    const admin = userCtx(fx, 'u-admin', 'export');
    const r = exportTenant(admin, { identity: fx, data: { notes: data } });
    if (!r.ok) throw new Error();
    expect(r.envelope.data.notes.map((x) => x.id)).toEqual(['a', 'b', 'z']);
    const ids = r.envelope.identity.sessions.map((s) => s.id);
    expect(ids).toEqual([...ids].sort());
    expect(exportTenant(admin, { identity: fx, data: { notes: data } })).toEqual(r);
  });
  it('anonymous context cannot export (resolver denies)', () => {
    const fx = makeFixture();
    expect(resolveTenantContext({ tenantId: 't-a', siteId: 's-a', origin: 'https://a.example', sessionId: 'sess-anon-a', purpose: 'export' }, { directory: fx.directory, clock: () => clock.now })).toMatchObject({ ok: false });
  });
});

describe('deletion', () => {
  it('self delete requires confirmation, then removes the user and is idempotent', () => {
    const fx = makeFixture();
    const data = createTenantDataStore<Rec>();
    data.put(userCtx(fx, 'u-op', 'ingest'), { id: 'a', tenantId: 't-a', userId: 'u-mem', text: 'mine' });
    const ctx = userCtx(fx, 'u-mem', 'delete');
    expect(deleteSelf(ctx, { identity: fx, data: { d: data } })).toMatchObject({ ok: false, code: 'confirmation_required' });
    expect(fx.audit).toEqual([]);
    const r = deleteSelf(ctx, { identity: fx, data: { d: data }, confirm: true });
    expect(r).toMatchObject({ ok: true, deleted: { memberships: 1, records: 1, user: true } });
    expect(r.ok && r.deleted.sessions).toBeGreaterThanOrEqual(1);
    expect(fx.audit).toHaveLength(1);
    expect(fx.audit[0]).toMatchObject({ action: 'delete_self', tenantId: 't-a', outcome: 'ok' });
    expect(JSON.stringify(fx.audit)).not.toContain('mine');
    expect(data.list(userCtx(fx, 'u-op', 'retrieval')).map((x) => x.id)).toEqual([]);
    expect(resolveTenantContext({ tenantId: 't-a', siteId: 's-a', origin: 'https://a.example', principal: { userId: 'u-mem' }, sessionId: 'again', newSession: true, purpose: 'chat' }, { directory: fx.directory, clock: () => clock.now })).toMatchObject({ ok: false, code: 'unauthenticated' });
    expect(deleteSelf(ctx, { identity: fx, data: { d: data }, confirm: true })).toMatchObject({ ok: true, deleted: { sessions: 0, memberships: 0, records: 0, user: false } });
    expect(fx.audit).toHaveLength(1); // replay is a no-op
  });
  it('multi-tenant user: deleting in A leaves tenant B intact', () => {
    const fx = makeFixture();
    expect(deleteSelf(userCtx(fx, 'u-multi', 'delete'), { identity: fx, confirm: true })).toMatchObject({ ok: true, deleted: { memberships: 1, user: false } });
    expect(userCtx(fx, 'u-multi', 'chat', 'b').role).toBe('member');
  });
  it('legal hold blocks without side effects', () => {
    const fx = makeFixture({ legalHolds: { users: ['u-mem'], tenants: ['t-a'] } });
    expect(deleteSelf(userCtx(fx, 'u-mem', 'delete'), { identity: fx, confirm: true })).toMatchObject({ ok: false, code: 'deletion_blocked' });
    expect(fx.audit).toEqual([]);
    expect(userCtx(fx, 'u-mem', 'chat').role).toBe('member');
    expect(planTenantDeletion(userCtx(fx, 'u-owner', 'delete'), { identity: fx })).toMatchObject({ ok: false, code: 'deletion_blocked' });
  });
  it('tenant deletion is a dry-run plan limited to the tenant, owner/admin only', () => {
    const fx = makeFixture();
    const data = createTenantDataStore<Rec>();
    data.put(userCtx(fx, 'u-op', 'ingest'), { id: 'a', tenantId: 't-a', text: 'x' });
    data.put(userCtx(fx, 'u-b', 'ingest', 'b'), { id: 'b', tenantId: 't-b', text: 'y' });
    expect(planTenantDeletion(userCtx(fx, 'u-op', 'delete'), { identity: fx, data: { d: data } })).toMatchObject({ ok: false, code: 'role_denied' });
    const admin = userCtx(fx, 'u-admin', 'export');
    const delCtx = userCtx(fx, 'u-admin', 'delete');
    const before = JSON.stringify(exportTenant(admin, { identity: fx, data: { d: data } }));
    const plan = planTenantDeletion(delCtx, { identity: fx, data: { d: data } });
    if (!plan.ok) throw new Error();
    expect(plan.plan).toMatchObject({ version: 1, dryRun: true, tenantId: 't-a', sites: ['s-a', 's-a-off'], data: { d: ['a'] } });
    expect(JSON.stringify(plan)).not.toMatch(/t-b|s-b|sess-anon-b|"u-b"/);
    expect(JSON.stringify(exportTenant(admin, { identity: fx, data: { d: data } }))).toBe(before);
    expect(fx.audit).toEqual([]);
  });
});
