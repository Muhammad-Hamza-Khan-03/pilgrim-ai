import { describe, expect, it } from 'vitest';
import { ACTIONS, authorize, type Action, type Purpose, type TenantContext } from '../src/index.js';
import { ctxFor, makeFixture } from './helpers.js';

const PURPOSE: Record<Action, Purpose> = { chat_append: 'chat', retrieve: 'retrieval', ingest_stage: 'ingest', publish: 'control_plane', rollback: 'control_plane', widget_disable: 'control_plane', manage_memberships: 'control_plane', export_self: 'export', export_tenant: 'export', delete_self: 'delete', delete_tenant: 'delete' };
const USERS = { owner: 'u-owner', admin: 'u-admin', operator: 'u-op', viewer: 'u-view', member: 'u-mem' } as const;
// Expected allowed roles per action (null = anonymous session).
const ALLOW: Record<Action, Array<keyof typeof USERS | 'anon'>> = {
  chat_append: ['anon', 'owner', 'admin', 'operator', 'viewer', 'member'],
  retrieve: ['anon', 'owner', 'admin', 'operator', 'viewer', 'member'],
  ingest_stage: ['owner', 'admin', 'operator'],
  publish: ['owner', 'admin', 'operator'],
  rollback: ['owner', 'admin', 'operator'],
  widget_disable: ['owner', 'admin'],
  manage_memberships: ['owner', 'admin'],
  export_self: ['owner', 'admin', 'operator', 'viewer', 'member'],
  export_tenant: ['owner', 'admin'],
  delete_self: ['owner', 'admin', 'operator', 'viewer', 'member'],
  delete_tenant: ['owner', 'admin'],
};

describe('role/action matrix', () => {
  const fx = makeFixture();
  let n = 0;
  const ctxOf = (who: keyof typeof USERS | 'anon', purpose: Purpose) =>
    who === 'anon' ? ctxFor(fx, { purpose, ...(purpose === 'chat' || purpose === 'retrieval' ? {} : {}) }) : ctxFor(fx, { principal: { userId: USERS[who] }, sessionId: `m${n++}`, newSession: true, purpose });

  for (const action of ACTIONS) {
    for (const who of ['anon', 'owner', 'admin', 'operator', 'viewer', 'member'] as const) {
      it(`${action} / ${who} -> ${ALLOW[action].includes(who) ? 'allow' : 'deny'}`, () => {
        const purpose = PURPOSE[action];
        let ctx: TenantContext;
        try { ctx = ctxOf(who, purpose); } catch { // anonymous cannot even resolve for user-only purposes
          expect(who).toBe('anon'); expect(ALLOW[action]).not.toContain('anon'); return;
        }
        const res = authorize(ctx, action, { tenantId: 't-a', siteId: 's-a', userId: ctx.userId ?? undefined });
        expect(res.allowed).toBe(ALLOW[action].includes(who));
      });
    }
  }
});

describe('fail closed', () => {
  const fx = makeFixture();
  const admin = ctxFor(fx, { principal: { userId: 'u-admin' }, sessionId: 'z1', newSession: true, purpose: 'control_plane' });
  const res = { tenantId: 't-a', siteId: 's-a' };
  it('denies absent/forged/unknown', () => {
    expect(authorize(null as never, 'publish', res)).toMatchObject({ allowed: false, code: 'no_context' });
    expect(authorize({ ...admin } as TenantContext, 'publish', res)).toMatchObject({ allowed: false, code: 'no_context' }); // copy was not issued by the resolver
    expect(authorize(admin, 'nuke' as never, res)).toMatchObject({ allowed: false, code: 'unknown_action' });
    expect(authorize(admin, 'publish', undefined as never)).toMatchObject({ allowed: false });
  });
  it('purpose must match the action', () => {
    expect(authorize(admin, 'ingest_stage', res)).toMatchObject({ allowed: false, code: 'purpose_mismatch' });
  });
  it('resource tenant/site mismatch is denied even with a high role', () => {
    expect(authorize(admin, 'publish', { tenantId: 't-b', siteId: 's-b' })).toMatchObject({ allowed: false, code: 'tenant_mismatch' });
    expect(authorize(admin, 'publish', { tenantId: 't-a', siteId: 's-b' })).toMatchObject({ allowed: false, code: 'site_mismatch' });
  });
  it('self actions require the resource user to be the caller', () => {
    const me = ctxFor(fx, { principal: { userId: 'u-mem' }, sessionId: 'z2', newSession: true, purpose: 'export' });
    expect(authorize(me, 'export_self', { ...res, userId: 'u-mem' }).allowed).toBe(true);
    expect(authorize(me, 'export_self', { ...res, userId: 'u-owner' })).toMatchObject({ allowed: false, code: 'self_required' });
    expect(authorize(me, 'export_self', res)).toMatchObject({ allowed: false, code: 'self_required' });
  });
});
