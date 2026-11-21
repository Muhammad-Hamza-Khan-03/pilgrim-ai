// Provider-neutral identity value types. Opaque ids, epoch-ms integers (no ambient clock), no global role.
export const ROLES = ['owner', 'admin', 'operator', 'viewer', 'member'] as const;
export type Role = (typeof ROLES)[number];
/** Higher = more privileged. owner > admin > operator > viewer > member. */
export const ROLE_RANK: Record<Role, number> = { owner: 4, admin: 3, operator: 2, viewer: 1, member: 0 };

export interface User { id: string; status: 'active' | 'disabled' | 'deleted'; createdAt: number; deletedAt?: number }
export interface Tenant { id: string; status: 'active' | 'suspended' | 'deleted'; createdAt: number; deletedAt?: number }
export interface Site { id: string; tenantId: string; origin: string; status: 'active' | 'disabled' | 'deleted' }
export interface Membership { userId: string; tenantId: string; role: Role; status: 'active' | 'revoked'; createdAt: number; revokedAt?: number }
export interface Session {
  id: string; tenantId: string; siteId: string; userId?: string;
  status: 'active' | 'revoked' | 'expired' | 'deleted';
  createdAt: number; lastSeenAt: number; expiresAt: number; deletedAt?: number;
}

const ID = /^[A-Za-z0-9._:-]{1,128}$/; // no '|' (used as an internal key separator), no '@' (email is not an identity key)
export const isOpaqueId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const isTime = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, set: readonly T[]): v is T => typeof v === 'string' && (set as readonly string[]).includes(v);
const optTime = (v: unknown) => v === undefined || isTime(v);
const onlyKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));

/** Exact http(s) origin (no path/query/wildcard/credentials), lower-cased; otherwise null. Mirrors the widget origin rule. */
export function normalizeOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw.trim());
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin !== raw.trim().toLowerCase() || u.origin === 'null') return null;
    return u.origin;
  } catch { return null; }
}

export function parseUser(v: unknown): User | null {
  if (!isRec(v) || !onlyKeys(v, ['id', 'status', 'createdAt', 'deletedAt'])) return null;
  if (!isOpaqueId(v.id) || !oneOf(v.status, ['active', 'disabled', 'deleted'] as const) || !isTime(v.createdAt) || !optTime(v.deletedAt)) return null;
  return { ...(v as unknown as User) };
}
export function parseTenant(v: unknown): Tenant | null {
  if (!isRec(v) || !onlyKeys(v, ['id', 'status', 'createdAt', 'deletedAt'])) return null;
  if (!isOpaqueId(v.id) || !oneOf(v.status, ['active', 'suspended', 'deleted'] as const) || !isTime(v.createdAt) || !optTime(v.deletedAt)) return null;
  return { ...(v as unknown as Tenant) };
}
export function parseSite(v: unknown): Site | null {
  if (!isRec(v) || !onlyKeys(v, ['id', 'tenantId', 'origin', 'status'])) return null;
  const origin = normalizeOrigin(v.origin);
  if (!isOpaqueId(v.id) || !isOpaqueId(v.tenantId) || !origin || !oneOf(v.status, ['active', 'disabled', 'deleted'] as const)) return null;
  return { id: v.id, tenantId: v.tenantId, origin, status: v.status };
}
export function parseMembership(v: unknown): Membership | null {
  if (!isRec(v) || !onlyKeys(v, ['userId', 'tenantId', 'role', 'status', 'createdAt', 'revokedAt'])) return null;
  if (!isOpaqueId(v.userId) || !isOpaqueId(v.tenantId) || !oneOf(v.role, ROLES) || !oneOf(v.status, ['active', 'revoked'] as const) || !isTime(v.createdAt) || !optTime(v.revokedAt)) return null;
  return { ...(v as unknown as Membership) };
}
export function parseSession(v: unknown): Session | null {
  if (!isRec(v) || !onlyKeys(v, ['id', 'tenantId', 'siteId', 'userId', 'status', 'createdAt', 'lastSeenAt', 'expiresAt', 'deletedAt'])) return null;
  if (!isOpaqueId(v.id) || !isOpaqueId(v.tenantId) || !isOpaqueId(v.siteId) || (v.userId !== undefined && !isOpaqueId(v.userId))) return null;
  if (!oneOf(v.status, ['active', 'revoked', 'expired', 'deleted'] as const) || !isTime(v.createdAt) || !isTime(v.lastSeenAt) || !isTime(v.expiresAt) || !optTime(v.deletedAt)) return null;
  if (v.expiresAt <= v.createdAt) return null;
  return { ...(v as unknown as Session) };
}
