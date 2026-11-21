import type { Session } from './model.js';

export interface RetentionPolicy {
  anonymousTtlMs: number; authenticatedTtlMs: number;
  /** Sliding expiry never extends past createdAt + max lifetime. */
  anonymousMaxLifetimeMs: number; authenticatedMaxLifetimeMs: number;
}
const HOUR = 3_600_000;
export const DEFAULT_RETENTION: RetentionPolicy = {
  anonymousTtlMs: 24 * HOUR, authenticatedTtlMs: 30 * 24 * HOUR,
  anonymousMaxLifetimeMs: 7 * 24 * HOUR, authenticatedMaxLifetimeMs: 90 * 24 * HOUR,
};

/** Server-owned expiry for a session touched at `now`; callers can never choose it. */
export function sessionExpiry(s: Pick<Session, 'userId' | 'createdAt'>, now: number, p: RetentionPolicy): number {
  const auth = s.userId !== undefined;
  return Math.min(now + (auth ? p.authenticatedTtlMs : p.anonymousTtlMs), s.createdAt + (auth ? p.authenticatedMaxLifetimeMs : p.anonymousMaxLifetimeMs));
}
export const isExpired = (s: Pick<Session, 'expiresAt'>, now: number) => now >= s.expiresAt;
