import { createIdentityFixture, resolveTenantContext, type Role, type TenantContext, type Purpose, type ResolveInput, type RetentionPolicy } from '../src/index.js';

export const T0 = 1_000_000_000;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const clock = { now: T0 };

const roles: Array<[string, Role]> = [['u-owner', 'owner'], ['u-admin', 'admin'], ['u-op', 'operator'], ['u-view', 'viewer'], ['u-mem', 'member']];

export function makeFixture(extra: { policy?: RetentionPolicy; legalHolds?: { users?: string[]; tenants?: string[] } } = {}) {
  clock.now = T0;
  return createIdentityFixture(
    {
      users: [...roles.map(([id]) => id), 'u-b', 'u-multi', 'u-gone', 'u-rev'].map((id) => ({ id, status: id === 'u-gone' ? 'deleted' as const : 'active' as const, createdAt: 1 })),
      tenants: [
        { id: 't-a', status: 'active', createdAt: 1 },
        { id: 't-b', status: 'active', createdAt: 1 },
        { id: 't-sus', status: 'suspended', createdAt: 1 },
      ],
      sites: [
        { id: 's-a', tenantId: 't-a', origin: 'https://a.example', status: 'active' },
        { id: 's-a-off', tenantId: 't-a', origin: 'https://off.a.example', status: 'disabled' },
        { id: 's-b', tenantId: 't-b', origin: 'https://b.example', status: 'active' },
        { id: 's-sus', tenantId: 't-sus', origin: 'https://sus.example', status: 'active' },
      ],
      memberships: [
        ...roles.map(([userId, role]) => ({ userId, tenantId: 't-a', role, status: 'active' as const, createdAt: 1 })),
        { userId: 'u-b', tenantId: 't-b', role: 'owner' as const, status: 'active' as const, createdAt: 1 },
        { userId: 'u-multi', tenantId: 't-a', role: 'member' as const, status: 'active' as const, createdAt: 1 },
        { userId: 'u-multi', tenantId: 't-b', role: 'member' as const, status: 'active' as const, createdAt: 1 },
        { userId: 'u-gone', tenantId: 't-a', role: 'member' as const, status: 'revoked' as const, createdAt: 1, revokedAt: 2 },
        { userId: 'u-rev', tenantId: 't-a', role: 'member' as const, status: 'revoked' as const, createdAt: 1, revokedAt: 2 },
      ],
      sessions: [
        { id: 'sess-anon-a', tenantId: 't-a', siteId: 's-a', status: 'active', createdAt: T0, lastSeenAt: T0, expiresAt: T0 + DAY },
        { id: 'sess-anon-b', tenantId: 't-b', siteId: 's-b', status: 'active', createdAt: T0, lastSeenAt: T0, expiresAt: T0 + DAY },
        { id: 'sess-owner', tenantId: 't-a', siteId: 's-a', userId: 'u-owner', status: 'active', createdAt: T0, lastSeenAt: T0, expiresAt: T0 + 30 * DAY },
        { id: 'sess-revoked', tenantId: 't-a', siteId: 's-a', status: 'revoked', createdAt: T0, lastSeenAt: T0, expiresAt: T0 + DAY },
        { id: 'sess-old', tenantId: 't-a', siteId: 's-a', status: 'active', createdAt: T0 - 2 * DAY, lastSeenAt: T0 - 2 * DAY, expiresAt: T0 - DAY },
      ],
    },
    { clock: () => clock.now, ...extra },
  );
}

export function ctxFor(fx: ReturnType<typeof makeFixture>, o: Partial<ResolveInput> & { purpose: Purpose }): TenantContext {
  const r = resolveTenantContext({ tenantId: 't-a', siteId: 's-a', origin: 'https://a.example', sessionId: 'sess-anon-a', ...o }, { directory: fx.directory, clock: () => clock.now });
  if (!r.ok) throw new Error(`unexpected denial ${r.code}`);
  return r.context;
}

/** Fresh authenticated context for a fixture user (issues a new session each call). */
let n = 0;
export function userCtx(fx: ReturnType<typeof makeFixture>, userId: string, purpose: Purpose, tenant: 'a' | 'b' = 'a') {
  const o = tenant === 'a' ? {} : { tenantId: 't-b', siteId: 's-b', origin: 'https://b.example' };
  return ctxFor(fx, { ...o, principal: { userId }, sessionId: `uc-${n++}`, newSession: true, purpose });
}
