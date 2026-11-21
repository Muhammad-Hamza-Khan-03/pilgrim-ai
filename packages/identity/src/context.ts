import type { Role, Session, Site, Tenant, User, Membership } from './model.js';
import { isOpaqueId, normalizeOrigin } from './model.js';
import { isExpired } from './retention.js';

export type Purpose = 'chat' | 'retrieval' | 'ingest' | 'control_plane' | 'export' | 'delete';
const PURPOSES: readonly Purpose[] = ['chat', 'retrieval', 'ingest', 'control_plane', 'export', 'delete'];
const ANONYMOUS_OK: readonly Purpose[] = ['chat', 'retrieval'];

export interface TenantContext {
  readonly tenantId: string; readonly siteId: string; readonly userId: string | null;
  readonly sessionId: string; readonly role: Role | null; readonly origin: string; readonly purpose: Purpose;
}
/** Explicit, separately typed system operation (resolver lookups only; never a tenant-owned data path). */
export interface SystemOperation { readonly system: 'resolve_context' | 'purge_expired' }
/** Read-only lookups for the resolver, plus bounded anonymous/authenticated session issuance. */
export interface ResolverDirectory {
  getUser(op: SystemOperation, id: string): User | null;
  getTenant(op: SystemOperation, id: string): Tenant | null;
  getSite(op: SystemOperation, id: string): Site | null;
  getMembership(op: SystemOperation, userId: string, tenantId: string): Membership | null;
  getSession(op: SystemOperation, id: string): Session | null;
  issueSession(op: SystemOperation, s: { id: string; tenantId: string; siteId: string; userId?: string }): void;
}
export interface ResolveInput {
  /** Already-authenticated principal supplied by the (future) auth layer; never taken from a request body. */
  principal?: { userId: string } | null;
  tenantId?: string; siteId?: string; sessionId?: string; origin: string; purpose: Purpose;
  /** Issue `sessionId` as a new session after every check passes (id must be unused). */
  newSession?: boolean;
}
export type DenialCode = 'unauthenticated' | 'invalid_context' | 'tenant_not_found' | 'site_mismatch' | 'origin_denied' | 'membership_required' | 'membership_revoked' | 'session_invalid' | 'session_expired' | 'tenant_suspended';
export type ResolveResult = { ok: true; context: TenantContext } | { ok: false; code: DenialCode };

const issued = new WeakSet<object>();
/** True only for contexts produced by resolveTenantContext (copies and hand-built objects are rejected). */
export const isIssuedContext = (c: unknown): c is TenantContext => typeof c === 'object' && c !== null && issued.has(c);

const SYS: SystemOperation = { system: 'resolve_context' };
const no = (code: DenialCode): ResolveResult => ({ ok: false, code });

export function resolveTenantContext(input: ResolveInput, deps: { directory: ResolverDirectory; clock: () => number }): ResolveResult {
  try {
    const { directory: d } = deps;
    const now = deps.clock();
    const origin = normalizeOrigin(input?.origin);
    const uid = input.principal ? input.principal.userId : null;
    if (!origin || !PURPOSES.includes(input.purpose) || !isOpaqueId(input.tenantId) || !isOpaqueId(input.sessionId)
      || (input.siteId !== undefined && !isOpaqueId(input.siteId)) || (uid !== null && !isOpaqueId(uid))
      || (input.siteId === undefined && input.newSession)) return no('invalid_context');
    if (uid === null && !ANONYMOUS_OK.includes(input.purpose)) return no('unauthenticated');

    const tenant = d.getTenant(SYS, input.tenantId);
    if (!tenant || tenant.status === 'deleted') return no('tenant_not_found');
    if (tenant.status !== 'active') return no('tenant_suspended');

    const existing = d.getSession(SYS, input.sessionId);
    if (input.newSession ? existing : false) return no('invalid_context');
    if (!input.newSession && !existing) return no('session_invalid');
    const siteId = input.siteId ?? existing!.siteId;
    const site = d.getSite(SYS, siteId);
    if (!site || site.tenantId !== tenant.id || site.status !== 'active') return no('site_mismatch');
    if (site.origin !== origin) return no('origin_denied');

    let role: Role | null = null;
    if (uid !== null) {
      const user = d.getUser(SYS, uid);
      if (!user || user.status !== 'active') return no('unauthenticated');
      const m = d.getMembership(SYS, uid, tenant.id);
      if (!m) return no('membership_required');
      if (m.status !== 'active') return no('membership_revoked');
      role = m.role;
    }
    if (existing) {
      if (existing.status === 'expired' || (existing.status === 'active' && isExpired(existing, now))) return no('session_expired');
      if (existing.status !== 'active' || existing.tenantId !== tenant.id || existing.siteId !== site.id || (existing.userId ?? null) !== uid) return no('session_invalid');
    } else d.issueSession(SYS, { id: input.sessionId, tenantId: tenant.id, siteId: site.id, ...(uid !== null ? { userId: uid } : {}) });

    const context: TenantContext = Object.freeze({ tenantId: tenant.id, siteId: site.id, userId: uid, sessionId: input.sessionId, role, origin, purpose: input.purpose });
    issued.add(context);
    return { ok: true, context };
  } catch { return no('invalid_context'); }
}
