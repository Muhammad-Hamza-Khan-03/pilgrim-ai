import { describe, expect, it } from 'vitest';
import { isOpaqueId, normalizeOrigin, parseMembership, parseSession, parseSite, parseTenant, parseUser, ROLES } from '../src/index.js';

describe('model validation', () => {
  it('roles are exactly the five tenant roles, no global role', () => {
    expect([...ROLES]).toEqual(['owner', 'admin', 'operator', 'viewer', 'member']);
  });
  it('opaque ids', () => {
    for (const ok of ['a', 'u-1', 'tenant_A.1:x']) expect(isOpaqueId(ok)).toBe(true);
    for (const bad of ['', ' ', 'a b', 'a|b', 'x'.repeat(129), 'a@b.com', 1, null, undefined, {}]) expect(isOpaqueId(bad)).toBe(false);
  });
  it('origin normalisation is exact', () => {
    expect(normalizeOrigin('https://A.example')).toBe('https://a.example');
    for (const bad of ['https://a.example/', 'https://a.example/x', 'ftp://a.example', '*', 'https://u:p@a.example', '', 'nope', null]) expect(normalizeOrigin(bad as never)).toBeNull();
  });
  it('parseUser/Tenant', () => {
    expect(parseUser({ id: 'u', status: 'active', createdAt: 1 })).toEqual({ id: 'u', status: 'active', createdAt: 1 });
    expect(parseUser({ id: 'u', status: 'root', createdAt: 1 })).toBeNull();
    expect(parseUser({ id: 'u', status: 'active', createdAt: 1.5 })).toBeNull();
    expect(parseUser({ id: 'u', status: 'active', createdAt: 1, role: 'owner' })).toBeNull(); // no global role
    expect(parseTenant({ id: 't', status: 'suspended', createdAt: 1 })).not.toBeNull();
    expect(parseTenant({ id: 't', status: 'x', createdAt: 1 })).toBeNull();
    expect(parseTenant(null)).toBeNull();
  });
  it('parseSite normalises origin and requires tenant', () => {
    expect(parseSite({ id: 's', tenantId: 't', origin: 'https://A.example', status: 'active' })?.origin).toBe('https://a.example');
    expect(parseSite({ id: 's', origin: 'https://a.example', status: 'active' })).toBeNull();
    expect(parseSite({ id: 's', tenantId: 't', origin: 'https://a.example/p', status: 'active' })).toBeNull();
  });
  it('parseMembership', () => {
    expect(parseMembership({ userId: 'u', tenantId: 't', role: 'admin', status: 'active', createdAt: 1 })).not.toBeNull();
    expect(parseMembership({ userId: 'u', tenantId: 't', role: 'superuser', status: 'active', createdAt: 1 })).toBeNull();
    expect(parseMembership({ userId: 'u', tenantId: 't', role: 'admin', status: 'bogus', createdAt: 1 })).toBeNull();
  });
  it('parseSession', () => {
    const s = { id: 'x', tenantId: 't', siteId: 's', status: 'active', createdAt: 1, lastSeenAt: 1, expiresAt: 2 };
    expect(parseSession(s)).not.toBeNull();
    expect(parseSession({ ...s, userId: 'u' })?.userId).toBe('u');
    expect(parseSession({ ...s, userId: '' })).toBeNull();
    expect(parseSession({ ...s, expiresAt: 0 })).toBeNull(); // expiry before creation
    expect(parseSession({ ...s, tenantId: undefined })).toBeNull();
    expect(parseSession({ ...s, status: 'zombie' })).toBeNull();
  });
});
