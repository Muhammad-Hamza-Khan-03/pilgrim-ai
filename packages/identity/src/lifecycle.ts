import { authorize } from './authorization.js';
import type { TenantContext } from './context.js';
import type { Membership, Session, Site, Tenant, User } from './model.js';
import { isExpired } from './retention.js';
import type { AuditEntry, IdentityFixture, Result, TenantDataStore, TenantRecord } from './store.js';

export interface LifecycleDeps { identity: IdentityFixture; data?: Record<string, TenantDataStore<TenantRecord>> }
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const names = (d: LifecycleDeps) => Object.keys(d.data ?? {}).sort();

const liveSessions = (d: LifecycleDeps, tenantId: string, userId?: string): Session[] => {
  const { sessions, clock } = d.identity.state;
  return [...sessions.values()].filter((s) => s.tenantId === tenantId && s.status !== 'deleted' && !isExpired(s, clock()) && (userId === undefined || s.userId === userId)).sort((a, b) => cmp(a.id, b.id));
};

export interface SelfExport { version: 1; scope: 'self'; tenantId: string; userId: string; generatedAt: number; identity: { user: User | null; memberships: Membership[]; sessions: Session[] }; data: Record<string, TenantRecord[]> }
export interface TenantExport { version: 1; scope: 'tenant'; tenantId: string; generatedAt: number; identity: { tenant: Tenant | null; sites: Site[]; memberships: Membership[]; sessions: Session[] }; data: Record<string, TenantRecord[]>; audit: AuditEntry[] }

function collect(ctx: TenantContext, d: LifecycleDeps, scope: 'self' | 'tenant') {
  const data: Record<string, TenantRecord[]> = {};
  for (const n of names(d)) {
    const r = d.data![n]!.export(ctx, scope);
    if (!r.ok) return r;
    data[n] = r.records;
  }
  return { ok: true as const, data };
}

/** Read-only, deterministic. Export is not audited (keeps it idempotent); see the Phase 4 limitations. */
export function exportSelf(ctx: TenantContext, d: LifecycleDeps): Result<{ envelope: SelfExport }> {
  const a = authorize(ctx, 'export_self', { tenantId: ctx?.tenantId, siteId: ctx?.siteId, ...(ctx?.userId ? { userId: ctx.userId } : {}) });
  if (!a.allowed) return { ok: false, code: a.code };
  const st = d.identity.state;
  const c = collect(ctx, d, 'self');
  if (!c.ok) return c;
  const userId = ctx.userId!;
  const m = st.memberships.get(`${userId}|${ctx.tenantId}`);
  return { ok: true, envelope: { version: 1, scope: 'self', tenantId: ctx.tenantId, userId, generatedAt: st.clock(), identity: { user: st.users.get(userId) ? { ...st.users.get(userId)! } : null, memberships: m ? [{ ...m }] : [], sessions: liveSessions(d, ctx.tenantId, userId).map((s) => ({ ...s })) }, data: c.data } };
}

export function exportTenant(ctx: TenantContext, d: LifecycleDeps): Result<{ envelope: TenantExport }> {
  const a = authorize(ctx, 'export_tenant', { tenantId: ctx?.tenantId, siteId: ctx?.siteId });
  if (!a.allowed) return { ok: false, code: a.code };
  const st = d.identity.state;
  const c = collect(ctx, d, 'tenant');
  if (!c.ok) return c;
  const t = st.tenants.get(ctx.tenantId);
  return {
    ok: true,
    envelope: {
      version: 1, scope: 'tenant', tenantId: ctx.tenantId, generatedAt: st.clock(),
      identity: {
        tenant: t ? { ...t } : null,
        sites: [...st.sites.values()].filter((s) => s.tenantId === ctx.tenantId).sort((x, y) => cmp(x.id, y.id)).map((s) => ({ ...s })),
        memberships: [...st.memberships.values()].filter((m) => m.tenantId === ctx.tenantId).sort((x, y) => cmp(x.userId, y.userId)).map((m) => ({ ...m })),
        sessions: liveSessions(d, ctx.tenantId).map((s) => ({ ...s })),
      },
      data: c.data,
      audit: st.audit.filter((e) => e.tenantId === ctx.tenantId).map((e) => ({ ...e })),
    },
  };
}

export interface SelfDeleteCounts { sessions: number; memberships: number; records: number; user: boolean }
/** Scoped to the resolved tenant; the user record is tombstoned only when no active membership remains anywhere. Replay is a no-op. */
export function deleteSelf(ctx: TenantContext, d: LifecycleDeps & { confirm?: boolean }): Result<{ deleted: SelfDeleteCounts }> {
  const a = authorize(ctx, 'delete_self', { tenantId: ctx?.tenantId, siteId: ctx?.siteId, ...(ctx?.userId ? { userId: ctx.userId } : {}) });
  if (!a.allowed) return { ok: false, code: a.code };
  if (d.confirm !== true) return { ok: false, code: 'confirmation_required' };
  const st = d.identity.state;
  const userId = ctx.userId!;
  if (st.holds.users.has(userId)) return { ok: false, code: 'deletion_blocked' };

  let records = 0;
  for (const n of names(d)) { const r = d.data![n]!.eraseOwned(ctx); if (r.ok) records += r.count; }
  let sessions = 0;
  for (const s of [...st.sessions.values()]) if (s.tenantId === ctx.tenantId && s.userId === userId) { st.sessions.delete(s.id); sessions++; }
  const now = st.clock();
  let memberships = 0;
  const m = st.memberships.get(`${userId}|${ctx.tenantId}`);
  if (m && m.status === 'active') { st.memberships.set(`${userId}|${ctx.tenantId}`, { ...m, status: 'revoked', revokedAt: now }); memberships = 1; }
  const u = st.users.get(userId);
  let user = false;
  if (u && u.status !== 'deleted' && ![...st.memberships.values()].some((x) => x.userId === userId && x.status === 'active')) {
    st.users.set(userId, { ...u, status: 'deleted', deletedAt: now });
    user = true;
  }
  if (sessions + memberships + records > 0 || user) st.audit.push({ action: 'delete_self', tenantId: ctx.tenantId, actor: ctx.sessionId, outcome: 'ok', code: 'ok', at: now });
  return { ok: true, deleted: { sessions, memberships, records, user } };
}

export interface TenantDeletionPlan { version: 1; dryRun: true; tenantId: string; sites: string[]; memberships: string[]; sessions: string[]; data: Record<string, string[]> }
/** Dry run only: enumerates tenant-scoped records, deletes nothing. */
export function planTenantDeletion(ctx: TenantContext, d: LifecycleDeps): Result<{ plan: TenantDeletionPlan }> {
  const a = authorize(ctx, 'delete_tenant', { tenantId: ctx?.tenantId, siteId: ctx?.siteId });
  if (!a.allowed) return { ok: false, code: a.code };
  const st = d.identity.state;
  if (st.holds.tenants.has(ctx.tenantId)) return { ok: false, code: 'deletion_blocked' };
  const data: Record<string, string[]> = {};
  for (const n of names(d)) { const r = d.data![n]!.planDelete(ctx); if (!r.ok) return r; data[n] = r.ids; }
  return {
    ok: true,
    plan: {
      version: 1, dryRun: true, tenantId: ctx.tenantId,
      sites: [...st.sites.values()].filter((s) => s.tenantId === ctx.tenantId).map((s) => s.id).sort(),
      memberships: [...st.memberships.values()].filter((m) => m.tenantId === ctx.tenantId).map((m) => m.userId).sort(),
      sessions: [...st.sessions.values()].filter((s) => s.tenantId === ctx.tenantId).map((s) => s.id).sort(),
      data,
    },
  };
}
