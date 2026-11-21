import { authorize, type DenyCode } from './authorization.js';
import { isIssuedContext, type ResolverDirectory, type SystemOperation, type TenantContext } from './context.js';
import { isOpaqueId, parseMembership, parseSession, parseSite, parseTenant, parseUser, ROLE_RANK } from './model.js';
import type { Membership, Session, Site, Tenant, User } from './model.js';
import { DEFAULT_RETENTION, isExpired, sessionExpiry, type RetentionPolicy } from './retention.js';

export type Result<T extends object = {}> = ({ ok: true } & T) | { ok: false; code: DenyCode | 'session_expired' | 'session_invalid' | 'not_found' | 'invalid_record' | 'confirmation_required' | 'deletion_blocked' };
const fail = (code: Exclude<Result, { ok: true }>['code']): { ok: false; code: typeof code } => ({ ok: false, code });

/** Tenant-scoped identity access: every method requires a resolved TenantContext; there is no unscoped listing. */
export interface IdentityStore {
  getUser(ctx: TenantContext, userId: string): User | null;
  getTenant(ctx: TenantContext, tenantId: string): Tenant | null;
  getSite(ctx: TenantContext, siteId: string): Site | null;
  getMembership(ctx: TenantContext, userId: string, tenantId: string): Membership | null;
  getSession(ctx: TenantContext, sessionId: string): Session | null;
  /** Touch/create the caller's own session; expiry is server-computed (injected clock + retention policy). */
  putSession(ctx: TenantContext, session: Session): Result;
  revokeSession(ctx: TenantContext, sessionId: string): Result;
}

export interface AuditEntry { action: 'delete_self'; tenantId: string; actor: string; outcome: 'ok'; code: 'ok'; at: number }
/** Fixture-internal state; only the lifecycle (export/delete) functions touch it. */
export interface FixtureState {
  users: Map<string, User>; tenants: Map<string, Tenant>; sites: Map<string, Site>;
  memberships: Map<string, Membership>; sessions: Map<string, Session>; audit: AuditEntry[];
  holds: { users: Set<string>; tenants: Set<string> }; clock: () => number;
}
export interface IdentityFixture {
  store: IdentityStore; directory: ResolverDirectory; state: FixtureState;
  readonly audit: readonly AuditEntry[];
  purgeExpired(op: SystemOperation): number;
}
export interface FixtureSeed { users?: unknown[]; tenants?: unknown[]; sites?: unknown[]; memberships?: unknown[]; sessions?: unknown[] }
export interface FixtureOptions { clock: () => number; policy?: RetentionPolicy; legalHolds?: { users?: string[]; tenants?: string[] } }

export const membershipKey = (userId: string, tenantId: string) => `${userId}|${tenantId}`;
const need = <T>(v: T | null, what: string): T => { if (v === null) throw new Error(`invalid ${what} seed`); return v; };
const copy = <T extends object>(v: T | undefined): T | null => (v ? { ...v } : null);

export function createIdentityFixture(seed: FixtureSeed, opts: FixtureOptions): IdentityFixture {
  const policy = opts.policy ?? DEFAULT_RETENTION;
  const st: FixtureState = {
    users: new Map(), tenants: new Map(), sites: new Map(), memberships: new Map(), sessions: new Map(), audit: [],
    holds: { users: new Set(opts.legalHolds?.users), tenants: new Set(opts.legalHolds?.tenants) }, clock: opts.clock,
  };
  for (const v of seed.users ?? []) { const u = need(parseUser(v), 'user'); st.users.set(u.id, u); }
  for (const v of seed.tenants ?? []) { const t = need(parseTenant(v), 'tenant'); st.tenants.set(t.id, t); }
  for (const v of seed.sites ?? []) { const s = need(parseSite(v), 'site'); st.sites.set(s.id, s); }
  for (const v of seed.memberships ?? []) { const m = need(parseMembership(v), 'membership'); st.memberships.set(membershipKey(m.userId, m.tenantId), m); }
  for (const v of seed.sessions ?? []) { const s = need(parseSession(v), 'session'); st.sessions.set(s.id, s); }

  const sysOk = (op: SystemOperation, want: SystemOperation['system']) => op?.system === want;
  const directory: ResolverDirectory = {
    getUser: (op, id) => (sysOk(op, 'resolve_context') ? copy(st.users.get(id)) : null),
    getTenant: (op, id) => (sysOk(op, 'resolve_context') ? copy(st.tenants.get(id)) : null),
    getSite: (op, id) => (sysOk(op, 'resolve_context') ? copy(st.sites.get(id)) : null),
    getMembership: (op, u, t) => (sysOk(op, 'resolve_context') ? copy(st.memberships.get(membershipKey(u, t))) : null),
    getSession: (op, id) => (sysOk(op, 'resolve_context') ? copy(st.sessions.get(id)) : null),
    issueSession(op, s) {
      if (!sysOk(op, 'resolve_context') || st.sessions.has(s.id)) throw new Error('session not issued');
      const now = st.clock();
      st.sessions.set(s.id, { ...s, status: 'active', createdAt: now, lastSeenAt: now, expiresAt: sessionExpiry({ userId: s.userId, createdAt: now }, now, policy) });
    },
  };

  const rank = (c: TenantContext) => (c.role === null ? -1 : ROLE_RANK[c.role]);
  const scoped = (c: TenantContext, s: Session | undefined) => (s && s.tenantId === c.tenantId && s.siteId === c.siteId ? s : undefined);
  const store: IdentityStore = {
    getUser(c, id) {
      if (!isIssuedContext(c) || !(id === c.userId || rank(c) >= ROLE_RANK.admin) || !st.memberships.has(membershipKey(id, c.tenantId))) return null;
      return copy(st.users.get(id));
    },
    getTenant: (c, id) => (isIssuedContext(c) && id === c.tenantId ? copy(st.tenants.get(id)) : null),
    getSite(c, id) { const s = st.sites.get(id); return isIssuedContext(c) && s && s.tenantId === c.tenantId ? { ...s } : null; },
    getMembership(c, u, t) {
      if (!isIssuedContext(c) || t !== c.tenantId || !(u === c.userId || rank(c) >= ROLE_RANK.admin)) return null;
      return copy(st.memberships.get(membershipKey(u, t)));
    },
    getSession(c, id) {
      const s = scoped(c, st.sessions.get(id));
      if (!isIssuedContext(c) || !s || s.status !== 'active' || isExpired(s, st.clock()) || !(id === c.sessionId || rank(c) >= ROLE_RANK.admin)) return null;
      return { ...s };
    },
    putSession(c, incoming) {
      const a = authorize(c, 'chat_append', { tenantId: c?.tenantId, siteId: c?.siteId });
      if (!a.allowed) return fail(a.code);
      const p = parseSession(incoming);
      if (!p) return fail('invalid_record');
      if (p.tenantId !== c.tenantId) return fail('tenant_mismatch');
      if (p.siteId !== c.siteId) return fail('site_mismatch');
      if (p.id !== c.sessionId || (p.userId ?? null) !== c.userId) return fail('session_invalid');
      const cur = st.sessions.get(p.id);
      const now = st.clock();
      if (cur) {
        if (!scoped(c, cur) || (cur.userId ?? null) !== c.userId || cur.status !== 'active') return fail('session_invalid');
        if (isExpired(cur, now)) return fail('session_expired');
      }
      const base = cur ?? { ...p, createdAt: now, status: 'active' as const };
      st.sessions.set(p.id, { ...base, lastSeenAt: now, expiresAt: sessionExpiry(base, now, policy) });
      return { ok: true };
    },
    revokeSession(c, id) {
      if (!isIssuedContext(c)) return fail('no_context');
      const s = scoped(c, st.sessions.get(id));
      if (!s) return fail('not_found');
      if (id !== c.sessionId && rank(c) < ROLE_RANK.admin) return fail('role_denied');
      st.sessions.set(id, { ...s, status: 'revoked' });
      return { ok: true };
    },
  };

  return {
    store, directory, state: st,
    get audit() { return st.audit.map((e) => ({ ...e })); },
    purgeExpired(op) {
      if (!sysOk(op, 'purge_expired')) return 0;
      let n = 0;
      for (const [id, s] of st.sessions) if (isExpired(s, st.clock())) { st.sessions.delete(id); n++; }
      return n;
    },
  };
}

// ---- tenant-scoped record store -------------------------------------------------------------------------------
export interface TenantRecord { id: string; tenantId?: string; siteId?: string; userId?: string }
export interface TenantDataStore<T extends TenantRecord> {
  list(ctx: TenantContext, query?: { tenantId?: string; filter?: (r: T) => boolean }): T[];
  get(ctx: TenantContext, id: string): T | null;
  put(ctx: TenantContext, record: T): Result;
  delete(ctx: TenantContext, id: string): Result;
  export(ctx: TenantContext, scope: 'self' | 'tenant'): Result<{ records: T[] }>;
  /** Self-delete support: removes the caller's own records in the caller's tenant. */
  eraseOwned(ctx: TenantContext): Result<{ count: number }>;
  /** Dry-run support: ids that a tenant deletion would remove. */
  planDelete(ctx: TenantContext): Result<{ ids: string[] }>;
}

/** Records are partitioned by tenant in the key itself; records without a tenantId are never returned. */
export function createTenantDataStore<T extends TenantRecord>(opts: { initial?: T[] } = {}): TenantDataStore<T> {
  const rows = new Map<string, T>();
  const key = (tenantId: string | undefined, id: string) => `${tenantId ?? ''}|${id}`;
  for (const r of opts.initial ?? []) rows.set(key(r.tenantId, r.id), { ...r });
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const mine = (c: TenantContext, allSites = false) =>
    [...rows.values()].filter((r) => r.tenantId === c.tenantId && (allSites || r.siteId === undefined || r.siteId === c.siteId));
  const gate = (c: TenantContext, action: Parameters<typeof authorize>[1], userId?: string) =>
    authorize(c, action, { tenantId: c?.tenantId, siteId: c?.siteId, ...(userId !== undefined ? { userId } : {}) });

  return {
    list(c, q) {
      if (!gate(c, 'retrieve').allowed || (q?.tenantId !== undefined && q.tenantId !== c.tenantId)) return [];
      return mine(c).filter((r) => (q?.filter ? q.filter(r) : true)).sort(byId).map((r) => ({ ...r }));
    },
    get(c, id) {
      if (!gate(c, 'retrieve').allowed) return null;
      const r = rows.get(key(c.tenantId, id));
      return r && (r.siteId === undefined || r.siteId === c.siteId) ? { ...r } : null;
    },
    put(c, r) {
      const a = gate(c, 'ingest_stage');
      if (!a.allowed) return fail(a.code);
      if (!isOpaqueId(r?.id)) return fail('invalid_record');
      if (r.tenantId !== c.tenantId) return fail('tenant_mismatch');
      if (r.siteId !== undefined && r.siteId !== c.siteId) return fail('site_mismatch');
      rows.set(key(c.tenantId, r.id), { ...r });
      return { ok: true };
    },
    delete(c, id) {
      const a = gate(c, 'ingest_stage');
      if (!a.allowed) return fail(a.code);
      const r = rows.get(key(c.tenantId, id));
      if (!r || (r.siteId !== undefined && r.siteId !== c.siteId)) return fail('not_found');
      rows.delete(key(c.tenantId, id));
      return { ok: true };
    },
    export(c, scope) {
      const a = scope === 'self' ? gate(c, 'export_self', c?.userId ?? undefined) : scope === 'tenant' ? gate(c, 'export_tenant') : { allowed: false as const, code: 'unknown_action' as const };
      if (!a.allowed) return fail(a.code);
      const all = mine(c, scope === 'tenant');
      return { ok: true, records: (scope === 'self' ? all.filter((r) => r.userId === c.userId) : all).sort(byId).map((r) => ({ ...r })) };
    },
    eraseOwned(c) {
      const a = gate(c, 'delete_self', c?.userId ?? undefined);
      if (!a.allowed) return fail(a.code);
      const own = mine(c, true).filter((r) => r.userId === c.userId);
      for (const r of own) rows.delete(key(c.tenantId, r.id));
      return { ok: true, count: own.length };
    },
    planDelete(c) {
      const a = gate(c, 'delete_tenant');
      if (!a.allowed) return fail(a.code);
      return { ok: true, ids: mine(c, true).map((r) => r.id).sort() };
    },
  };
}
