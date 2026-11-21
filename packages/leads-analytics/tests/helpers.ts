import { createIdentityFixture, resolveTenantContext, type Purpose, type ResolveInput } from '@pilgrim/identity';
import { createLeadAnalyticsStore, type Options } from '../src/index.js';

export const T0 = 1_000_000_000;
export const DAY = 86_400_000;
export const clock = { now: T0 };
const sess = (id: string, tenantId: string, siteId: string, userId?: string) => ({ id, tenantId, siteId, ...(userId ? { userId } : {}), status: 'active' as const, createdAt: T0, lastSeenAt: T0, expiresAt: T0 + 400 * DAY });

export function world(extra: Partial<Options> = {}) {
  clock.now = T0;
  const fx = createIdentityFixture({
    users: ['u-op', 'u-admin', 'u-view', 'u-b'].map((id) => ({ id, status: 'active', createdAt: 1 })),
    tenants: [{ id: 't-a', status: 'active', createdAt: 1 }, { id: 't-b', status: 'active', createdAt: 1 }],
    sites: [
      { id: 's-a', tenantId: 't-a', origin: 'https://a.example', status: 'active' },
      { id: 's-a2', tenantId: 't-a', origin: 'https://a2.example', status: 'active' },
      { id: 's-b', tenantId: 't-b', origin: 'https://b.example', status: 'active' },
    ],
    memberships: [
      { userId: 'u-op', tenantId: 't-a', role: 'operator', status: 'active', createdAt: 1 },
      { userId: 'u-admin', tenantId: 't-a', role: 'admin', status: 'active', createdAt: 1 },
      { userId: 'u-view', tenantId: 't-a', role: 'viewer', status: 'active', createdAt: 1 },
      { userId: 'u-b', tenantId: 't-b', role: 'owner', status: 'active', createdAt: 1 },
    ],
    sessions: [sess('sa1', 't-a', 's-a'), sess('sa2', 't-a', 's-a'), sess('sb1', 't-b', 's-b'), sess('sa-site2', 't-a', 's-a2')],
  }, { clock: () => clock.now });
  const store = createLeadAnalyticsStore({ clock: () => clock.now, ...extra });
  let n = 0;
  const ctx = (o: Partial<ResolveInput> & { purpose: Purpose }) => {
    const base = o.tenantId === 't-b' ? { tenantId: 't-b', siteId: 's-b', origin: 'https://b.example', sessionId: 'sb1' } : { tenantId: 't-a', siteId: 's-a', origin: 'https://a.example', sessionId: 'sa1' };
    const r = resolveTenantContext({ ...base, ...(o.principal ? { sessionId: `x${n++}`, newSession: true } : {}), ...o }, { directory: fx.directory, clock: () => clock.now });
    if (!r.ok) throw new Error(r.code);
    return r.context;
  };
  return {
    store, ctx,
    widget: (o: Partial<ResolveInput> = {}) => ctx({ purpose: 'chat', ...o }),
    op: (tenant: 'a' | 'b' = 'a') => (tenant === 'a' ? ctx({ purpose: 'control_plane', principal: { userId: 'u-op' } }) : ctx({ purpose: 'control_plane', tenantId: 't-b', principal: { userId: 'u-b' } })),
    viewer: () => ctx({ purpose: 'control_plane', principal: { userId: 'u-view' } }),
    admin: () => ctx({ purpose: 'delete', principal: { userId: 'u-admin' } }),
  };
}

export const lead = (o: Record<string, unknown> = {}) => ({ requestId: 'r1', leadId: 'l1', tenantId: 't-a', siteId: 's-a', sessionId: 'sa1', consent: 'granted', source: 'widget', recommendationId: 'rec-1', ...o });
export const ev = (o: Record<string, unknown> = {}) => ({ requestId: 'e1', name: 'widget_opened', data: { returning: false }, consent: 'granted', ...o });
