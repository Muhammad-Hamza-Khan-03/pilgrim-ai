import { describe, expect, it } from 'vitest';
import { resolveTenantContext, type ResolveInput } from '../src/index.js';
import { clock, DAY, makeFixture, T0 } from './helpers.js';

const base: ResolveInput = { tenantId: 't-a', siteId: 's-a', origin: 'https://a.example', sessionId: 'sess-anon-a', purpose: 'chat' };
const run = (o: Partial<ResolveInput>, fx = makeFixture()) => resolveTenantContext({ ...base, ...o } as ResolveInput, { directory: fx.directory, clock: () => clock.now });
const code = (o: Partial<ResolveInput>) => { const r = run(o); return r.ok ? 'ALLOWED' : r.code; };

describe('resolveTenantContext', () => {
  it('resolves anonymous session into a frozen context', () => {
    const r = run({});
    expect(r.ok && r.context).toEqual({ tenantId: 't-a', siteId: 's-a', userId: null, sessionId: 'sess-anon-a', role: null, origin: 'https://a.example', purpose: 'chat' });
    expect(Object.isFrozen(r.ok && r.context)).toBe(true);
  });
  it('resolves member role from membership only', () => {
    const r = run({ principal: { userId: 'u-op' }, sessionId: 'n1', newSession: true, purpose: 'ingest' });
    expect(r.ok && r.context.role).toBe('operator');
  });
  it('derives site from session when siteId omitted', () => {
    const r = run({ siteId: undefined });
    expect(r.ok && r.context.siteId).toBe('s-a');
  });
  it('typed denial taxonomy', () => {
    expect(code({ tenantId: undefined })).toBe('invalid_context');
    expect(code({ siteId: undefined, sessionId: undefined })).toBe('invalid_context');
    expect(code({ sessionId: undefined })).toBe('invalid_context');
    expect(code({ tenantId: 'bad id' })).toBe('invalid_context');
    expect(code({ origin: 'nope' })).toBe('invalid_context');
    expect(code({ purpose: 'bogus' as never })).toBe('invalid_context');
    expect(code({ tenantId: 't-zzz' })).toBe('tenant_not_found');
    expect(code({ tenantId: 't-sus', siteId: 's-sus', sessionId: 'x', newSession: true, origin: 'https://sus.example' })).toBe('tenant_suspended');
    expect(code({ siteId: 's-b', origin: 'https://b.example' })).toBe('site_mismatch'); // B site under tenant A
    expect(code({ siteId: 's-a-off', origin: 'https://off.a.example' })).toBe('site_mismatch'); // disabled
    expect(code({ siteId: 's-unknown' })).toBe('site_mismatch');
    expect(code({ origin: 'https://evil.example' })).toBe('origin_denied');
    expect(code({ purpose: 'ingest' })).toBe('unauthenticated');
    expect(code({ principal: { userId: 'u-unknown' }, sessionId: 'n', newSession: true })).toBe('unauthenticated');
    expect(code({ principal: { userId: 'u-gone' }, sessionId: 'n', newSession: true })).toBe('unauthenticated');
    expect(code({ principal: { userId: 'u-b' }, sessionId: 'n', newSession: true })).toBe('membership_required');
    expect(code({ sessionId: 'sess-nope' })).toBe('session_invalid');
    expect(code({ sessionId: 'sess-revoked' })).toBe('session_invalid');
    expect(code({ sessionId: 'sess-anon-b' })).toBe('session_invalid'); // not portable across tenants
    expect(code({ sessionId: 'sess-old' })).toBe('session_expired');
    expect(code({ sessionId: 'sess-owner' })).toBe('session_invalid'); // authenticated session needs matching principal
    expect(code({ principal: { userId: 'u-admin' }, sessionId: 'sess-owner' })).toBe('session_invalid');
  });
  it('revoked membership denies', () => {
    expect(code({ principal: { userId: 'u-rev' }, sessionId: 'n', newSession: true })).toBe('membership_revoked');
  });
  it('expiry is evaluated at the injected clock', () => {
    const fx = makeFixture();
    clock.now = T0 + DAY; // exactly expiresAt -> expired
    expect(run({}, fx)).toMatchObject({ ok: false, code: 'session_expired' });
  });
  it('newSession issues a bounded anonymous session only after all checks pass; denial writes nothing', () => {
    const fx = makeFixture();
    expect(code({ sessionId: 'fresh', newSession: true, origin: 'https://evil.example' })).toBe('origin_denied');
    expect(fx.directory.getSession({ system: 'resolve_context' }, 'fresh')).toBeNull();
    const r = run({ sessionId: 'fresh', newSession: true }, fx);
    expect(r.ok).toBe(true);
    expect(fx.directory.getSession({ system: 'resolve_context' }, 'fresh')).toMatchObject({ tenantId: 't-a', siteId: 's-a', expiresAt: T0 + DAY, status: 'active' });
    expect(run({ sessionId: 'fresh', newSession: true }, fx)).toMatchObject({ ok: false, code: 'invalid_context' }); // id already taken
  });
  it('adapter errors fail closed', () => {
    const fx = makeFixture();
    const bad = { ...fx.directory, getSite: () => { throw new Error('boom'); } };
    expect(resolveTenantContext(base, { directory: bad, clock: () => clock.now })).toMatchObject({ ok: false });
  });
  it('request body tenant is never sufficient: user of A cannot resolve B', () => {
    expect(code({ principal: { userId: 'u-op' }, tenantId: 't-b', siteId: 's-b', origin: 'https://b.example', sessionId: 'n', newSession: true })).toBe('membership_required');
  });
});
