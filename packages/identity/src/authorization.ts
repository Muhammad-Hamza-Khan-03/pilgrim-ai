import type { Role } from './model.js';
import { ROLE_RANK, ROLES } from './model.js';
import type { TenantContext } from './context.js';
import { isIssuedContext } from './context.js';

export const ACTIONS = ['chat_append', 'retrieve', 'ingest_stage', 'publish', 'rollback', 'widget_disable', 'manage_memberships', 'export_self', 'export_tenant', 'delete_self', 'delete_tenant'] as const;
export type Action = (typeof ACTIONS)[number];

type Rule = { purpose: TenantContext['purpose']; anonymous?: true; min?: Role; self?: true };
const RULES: Record<Action, Rule> = {
  chat_append: { purpose: 'chat', anonymous: true },
  retrieve: { purpose: 'retrieval', anonymous: true },
  ingest_stage: { purpose: 'ingest', min: 'operator' },
  publish: { purpose: 'control_plane', min: 'operator' },
  rollback: { purpose: 'control_plane', min: 'operator' },
  widget_disable: { purpose: 'control_plane', min: 'admin' },
  manage_memberships: { purpose: 'control_plane', min: 'admin' },
  export_self: { purpose: 'export', min: 'member', self: true },
  export_tenant: { purpose: 'export', min: 'admin' },
  delete_self: { purpose: 'delete', min: 'member', self: true },
  delete_tenant: { purpose: 'delete', min: 'admin' },
};

export interface Resource { tenantId: string; siteId?: string; userId?: string }
export type DenyCode = 'no_context' | 'unknown_action' | 'invalid_resource' | 'purpose_mismatch' | 'tenant_mismatch' | 'site_mismatch' | 'role_denied' | 'self_required' | 'authorization_error';
export type AuthzResult = { allowed: true } | { allowed: false; code: DenyCode };
const deny = (code: DenyCode): AuthzResult => ({ allowed: false, code });

/** The single gate for tenant-owned operations. Never throws; anything unexpected denies. */
export function authorize(context: TenantContext, action: Action, resource: Resource): AuthzResult {
  try {
    if (!isIssuedContext(context)) return deny('no_context');
    const rule = Object.hasOwn(RULES, action) ? RULES[action] : undefined;
    if (!rule) return deny('unknown_action');
    if (typeof resource !== 'object' || resource === null || typeof resource.tenantId !== 'string') return deny('invalid_resource');
    if (context.purpose !== rule.purpose) return deny('purpose_mismatch');
    if (resource.tenantId !== context.tenantId) return deny('tenant_mismatch');
    if (resource.siteId !== undefined && resource.siteId !== context.siteId) return deny('site_mismatch');
    if (context.role === null) return rule.anonymous ? { allowed: true } : deny('role_denied');
    if (!ROLES.includes(context.role)) return deny('role_denied');
    if (rule.self && (context.userId === null || resource.userId !== context.userId)) return deny('self_required');
    if (!rule.anonymous && ROLE_RANK[context.role] < ROLE_RANK[rule.min!]) return deny('role_denied');
    return { allowed: true };
  } catch { return deny('authorization_error'); }
}
