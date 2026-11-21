import { describe, expect, it } from 'vitest';
import { clock, DAY, ev, lead, T0, world } from './helpers.js';

const code = (r: any) => (r.ok ? 'ok' : r.code);

describe('tenant context gate', () => {
  it('rejects missing / forged / wrong-purpose contexts on every operation', () => {
    const w = world();
    const real = w.widget();
    const forged = { ...real };
    for (const bad of [undefined, null, forged, { tenantId: 't-a' }] as any[]) {
      expect(code(w.store.createLead(bad, lead()))).toBe('no_context');
      expect(code(w.store.recordEvent(bad, ev()))).toBe('no_context');
      expect(code(w.store.aggregate(bad))).toBe('no_context');
      expect(code(w.store.deleteLead(bad, 'l1'))).not.toBe('ok');
      expect(w.store.listLeads(bad)).toEqual([]);
      expect(w.store.getLead(bad, 'l1')).toBeNull();
      expect(code(w.store.planDelete(bad))).toBe('no_context');
      expect(code(w.store.eraseTenant(bad, { confirm: true }))).toBe('no_context');
    }
    expect(code(w.store.aggregate(real))).toBe('purpose_mismatch'); // widget cannot read analytics
    expect(code(w.store.createLead(w.op(), lead()))).toBe('purpose_mismatch');
  });
  it('viewers cannot read or mutate leads; anonymous operator-purpose is impossible', () => {
    const w = world();
    expect(code(w.store.aggregate(w.viewer()))).toBe('role_denied');
    expect(w.store.listLeads(w.viewer())).toEqual([]);
  });
  it('rejects foreign tenant/site/session attribution in the payload', () => {
    const w = world();
    const c = w.widget();
    expect(code(w.store.createLead(c, lead({ tenantId: 't-b' })))).toBe('tenant_mismatch');
    expect(code(w.store.createLead(c, lead({ siteId: 's-a2' })))).toBe('site_mismatch');
    expect(code(w.store.createLead(c, lead({ sessionId: 'sa2' })))).toBe('session_mismatch');
    expect(w.store.listLeads(w.op())).toEqual([]);
  });
});

describe('lead contract', () => {
  it('creates a minimal lead and returns deep clones', () => {
    const w = world();
    const r: any = w.store.createLead(w.widget(), lead());
    expect(r.ok && !r.replay).toBe(true);
    expect(Object.keys(r.lead).sort()).toEqual(['consent', 'createdAt', 'followUp', 'handoff', 'id', 'recommendationId', 'retention', 'sessionId', 'siteId', 'source', 'tenantId', 'updatedAt']);
    r.lead.consent = 'withdrawn'; r.lead.retention.retainUntil = 0;
    const g: any = w.store.getLead(w.op(), 'l1');
    expect(g.consent).toBe('granted');
    g.handoff = 'completed';
    expect((w.store.getLead(w.op(), 'l1') as any).handoff).toBe('none');
  });
  it.each([
    ['email', { email: 'a@b.co' }], ['phone', { phone: '+15551234567' }], ['raw text', { text: 'I want a cheap hotel' }],
    ['metadata', { metadata: { a: 1 } }], ['credential', { apiKey: 'sk_live_x' }], ['__proto__', JSON.parse('{"__proto__":{"x":1}}')],
  ])('rejects unknown field: %s', (_n, extra) => {
    const w = world();
    expect(code(w.store.createLead(w.widget(), { ...lead(), ...extra }))).toBe('invalid_input');
  });
  it.each([
    [{ recommendationId: 'I recommend the Hilton hotel' }], [{ recommendationId: 'a@b.co' }], [{ source: 'email' }], [{ leadId: '' }], [{ requestId: 7 }], [{ consent: true }],
  ])('fails closed on malformed %j', (o) => {
    const w = world();
    expect(code(w.store.createLead(w.widget(), lead(o)))).not.toBe('ok');
  });
  it('non-object inputs fail closed', () => {
    const w = world();
    for (const x of [null, undefined, 'x', 5, [], new Map()]) expect(code(w.store.createLead(w.widget(), x))).toBe('invalid_input');
  });
  it('requires explicit granted consent to create', () => {
    const w = world();
    for (const consent of [undefined, 'withdrawn', 'pending', 'yes']) expect(code(w.store.createLead(w.widget(), lead({ consent })))).toBe('consent_required');
  });
});

describe('idempotency', () => {
  it('replay is a same-result no-op; conflict fails closed', () => {
    const w = world();
    const c = w.widget();
    const a: any = w.store.createLead(c, lead());
    clock.now += 1000;
    const b: any = w.store.createLead(c, lead());
    expect(b.replay).toBe(true);
    expect(b.lead).toEqual(a.lead);
    expect(code(w.store.createLead(c, lead({ source: 'handoff' })))).toBe('idempotency_conflict');
    expect(code(w.store.createLead(c, lead({ leadId: 'l2' })))).toBe('idempotency_conflict');
    expect(code(w.store.createLead(c, lead({ requestId: 'r2' })))).toBe('already_exists');
    expect(w.store.listLeads(w.op())).toHaveLength(1);
  });
  it('requestId cannot be reused across operations', () => {
    const w = world();
    w.store.createLead(w.widget(), lead());
    expect(code(w.store.recordEvent(w.widget(), ev({ requestId: 'r1' })))).toBe('idempotency_conflict');
    expect(code(w.store.updateLead(w.op(), { requestId: 'r1', leadId: 'l1', handoff: 'requested' }))).toBe('idempotency_conflict');
  });
  it('updates replay without re-applying and conflict on changed payload', () => {
    const w = world();
    w.store.createLead(w.widget(), lead());
    const u = { requestId: 'u1', leadId: 'l1', handoff: 'requested', followUp: 'pending' };
    const a: any = w.store.updateLead(w.op(), u);
    clock.now += 5;
    const b: any = w.store.updateLead(w.op(), u);
    expect(b.replay && b.lead.updatedAt === a.lead.updatedAt).toBe(true);
    expect(code(w.store.updateLead(w.op(), { ...u, handoff: 'completed' }))).toBe('idempotency_conflict');
  });
  it('events replay once; counts do not double', () => {
    const w = world();
    expect((w.store.recordEvent(w.widget(), ev()) as any).replay).toBe(false);
    expect((w.store.recordEvent(w.widget(), ev()) as any).replay).toBe(true);
    expect(code(w.store.recordEvent(w.widget(), ev({ data: { returning: true } })))).toBe('idempotency_conflict');
    expect((w.store.aggregate(w.op()) as any).aggregate.counts.widget_opened.value).toBe(1);
  });
});

describe('lead updates and consent', () => {
  it('only operators update; viewers and widgets cannot', () => {
    const w = world();
    w.store.createLead(w.widget(), lead());
    const u = { requestId: 'u1', leadId: 'l1', handoff: 'requested' };
    expect(code(w.store.updateLead(w.viewer(), u))).toBe('role_denied');
    expect(code(w.store.updateLead(w.widget(), u))).toBe('purpose_mismatch');
    expect(code(w.store.updateLead(w.op(), { requestId: 'u2', leadId: 'l1' }))).toBe('invalid_input');
    expect(code(w.store.updateLead(w.op(), { requestId: 'u3', leadId: 'l1', handoff: 'weird' }))).toBe('invalid_input');
    expect(code(w.store.updateLead(w.op(), { requestId: 'u4', leadId: 'l1', consent: 'granted', handoff: 'none' }))).toBe('invalid_input');
    expect(code(w.store.updateLead(w.op(), u))).toBe('ok');
  });
  it('withdrawn consent blocks updates and analytics; only own session can withdraw', () => {
    const w = world();
    w.store.createLead(w.widget(), lead());
    expect(code(w.store.withdrawConsent(w.widget({ sessionId: 'sa2' }), { requestId: 'w0', leadId: 'l1' }))).toBe('not_found');
    expect(code(w.store.withdrawConsent(w.widget(), { requestId: 'w1', leadId: 'l1' }))).toBe('ok');
    expect(code(w.store.withdrawConsent(w.widget(), { requestId: 'w1', leadId: 'l1' }))).toBe('ok');
    expect(code(w.store.updateLead(w.op(), { requestId: 'u1', leadId: 'l1', handoff: 'requested' }))).toBe('consent_required');
    expect(code(w.store.recordEvent(w.widget(), ev()))).toBe('consent_required');
    expect(code(w.store.recordEvent(w.widget({ sessionId: 'sa2' }), ev({ requestId: 'e9' })))).toBe('ok'); // other session unaffected
    expect((w.store.getLead(w.op(), 'l1') as any).consent).toBe('withdrawn');
  });
  it('re-create after withdrawal cannot flip consent back', () => {
    const w = world();
    w.store.createLead(w.widget(), lead());
    w.store.withdrawConsent(w.widget(), { requestId: 'w1', leadId: 'l1' });
    expect(code(w.store.createLead(w.widget(), lead({ requestId: 'r2' })))).toBe('already_exists');
  });
});

describe('analytics events', () => {
  it('accepts every allowlisted event with its exact shape', () => {
    const w = world();
    const good: Array<[string, object]> = [
      ['widget_opened', { returning: true }], ['question_submitted', { charCount: 40, turnIndex: 1 }],
      ['answer_shown', { citationCount: 2, cardCount: 1, grounded: true, latencyMs: 900 }], ['citation_interaction', { action: 'open', citationIndex: 0 }],
      ['card_interaction', { action: 'click', cardId: 'card-1' }], ['handoff', { channel: 'whatsapp', outcome: 'requested' }],
      ['lead_submitted', { consentGiven: true }], ['error', { code: 'upstream_timeout' }], ['degraded_mode', { reason: 'no_llm', active: true }],
    ];
    good.forEach(([name, data], i) => expect(code(w.store.recordEvent(w.widget(), ev({ requestId: `g${i}`, name, data })))).toBe('ok'));
    const a: any = w.store.aggregate(w.op());
    expect(Object.values(a.aggregate.counts).every((m: any) => m.value === 1 && m.label === 'observed')).toBe(true);
  });
  it.each([
    ['unknown name', { name: 'page_view' }], ['raw text field', { name: 'question_submitted', data: { charCount: 3, turnIndex: 1, text: 'hello world' } }],
    ['text in code', { name: 'error', data: { code: 'Hello, my email is a@b.co' } }], ['email in code', { name: 'error', data: { code: 'a@b.co' } }],
    ['credential in code', { name: 'error', data: { code: 'bearer_abc' } }], ['secret key', { name: 'error', data: { code: 'sk_live_abc' } }],
    ['missing field', { name: 'answer_shown', data: { citationCount: 1 } }], ['wrong type', { name: 'question_submitted', data: { charCount: '40', turnIndex: 1 } }],
    ['negative', { name: 'question_submitted', data: { charCount: -1, turnIndex: 1 } }], ['float', { name: 'question_submitted', data: { charCount: 1.5, turnIndex: 1 } }],
    ['huge', { name: 'question_submitted', data: { charCount: 1e12, turnIndex: 1 } }], ['bad enum', { name: 'citation_interaction', data: { action: 'hover', citationIndex: 0 } }],
    ['extra top-level', { sessionId: 'sa2' }], ['extra top-level email', { email: 'a@b.co' }], ['no data', { data: undefined }], ['array data', { data: [] }],
    ['raw sentence as cardId', { name: 'card_interaction', data: { action: 'view', cardId: 'two nights in Makkah' } }],
  ])('rejects %s', (_n, o) => {
    const w = world();
    expect(code(w.store.recordEvent(w.widget(), ev(o)))).toBe('invalid_input');
    expect((w.store.aggregate(w.op()) as any).aggregate.counts.widget_opened.value).toBe(0);
  });
  it('requires explicit consent', () => {
    const w = world();
    for (const consent of [undefined, 'withdrawn', true, 'denied']) expect(code(w.store.recordEvent(w.widget(), ev({ consent })))).toBe('consent_required');
  });
  it('leadId must belong to the caller session and tenant', () => {
    const w = world();
    w.store.createLead(w.widget(), lead());
    expect(code(w.store.recordEvent(w.widget({ sessionId: 'sa2' }), ev({ leadId: 'l1' })))).toBe('not_found');
    expect(code(w.store.recordEvent(w.widget({ tenantId: 't-b' }), ev({ leadId: 'l1' })))).toBe('not_found');
    expect(code(w.store.recordEvent(w.widget(), ev({ leadId: 'l1' })))).toBe('ok');
  });
  it('the stored event is caller-context attributed and not mutable via returned values', () => {
    const w = world();
    w.store.recordEvent(w.widget(), ev());
    const a: any = w.store.aggregate(w.op());
    a.aggregate.counts.widget_opened.value = 99;
    expect((w.store.aggregate(w.op()) as any).aggregate.counts.widget_opened.value).toBe(1);
  });
});

describe('aggregate honesty and isolation', () => {
  it('labels derived ratios not_enough_data below the sample floor, then derived', () => {
    const w = world();
    const q = (i: number, name: string, data: object) => w.store.recordEvent(w.widget(), ev({ requestId: `x${name}${i}`, name, data }));
    for (let i = 0; i < 4; i++) q(i, 'question_submitted', { charCount: 5, turnIndex: i });
    let a: any = (w.store.aggregate(w.op()) as any).aggregate;
    expect(a.derived.answerPerQuestion).toEqual({ value: null, label: 'not_enough_data' });
    q(4, 'question_submitted', { charCount: 5, turnIndex: 4 });
    for (let i = 0; i < 4; i++) q(i, 'answer_shown', { citationCount: 0, cardCount: 0, grounded: false, latencyMs: 1 });
    a = (w.store.aggregate(w.op()) as any).aggregate;
    expect(a.derived.answerPerQuestion).toEqual({ value: 0.8, label: 'derived' });
    expect(a.derived.leadPerOpen.label).toBe('not_enough_data');
    expect(a.counts.question_submitted).toEqual({ value: 5, label: 'observed' });
  });
  it('never mixes tenants or sites; identical requestIds in two tenants do not collide', () => {
    const w = world();
    w.store.recordEvent(w.widget(), ev());
    w.store.recordEvent(w.widget({ tenantId: 't-b' }), ev());
    w.store.recordEvent(w.widget({ tenantId: 't-b' }), ev({ requestId: 'e2' }));
    w.store.recordEvent(w.widget({ siteId: 's-a2', origin: 'https://a2.example', sessionId: 'sa-site2' }), ev({ requestId: 'e3' }));
    expect((w.store.aggregate(w.op('a')) as any).aggregate.counts.widget_opened.value).toBe(1);
    expect((w.store.aggregate(w.op('b')) as any).aggregate.counts.widget_opened.value).toBe(2);
    w.store.createLead(w.widget({ tenantId: 't-b' }), lead({ tenantId: 't-b', siteId: 's-b', sessionId: 'sb1' }));
    expect(w.store.getLead(w.op('a'), 'l1')).toBeNull();
    expect(w.store.listLeads(w.op('a'))).toEqual([]);
    expect(w.store.listLeads(w.op('b'))).toHaveLength(1);
    expect(code(w.store.deleteLead(w.op('a'), 'l1'))).toBe('not_found');
    expect(code(w.store.updateLead(w.op('a'), { requestId: 'zz', leadId: 'l1', handoff: 'requested' }))).toBe('not_found');
  });
  it('aggregate output contains no ids of leads/sessions', () => {
    const w = world();
    w.store.createLead(w.widget(), lead());
    w.store.recordEvent(w.widget(), ev({ leadId: 'l1' }));
    const s = JSON.stringify(w.store.aggregate(w.op()));
    expect(s).not.toMatch(/l1|sa1|rec-1/);
  });
});

describe('deletion', () => {
  const seed = (w: ReturnType<typeof world>) => {
    w.store.createLead(w.widget(), lead());
    w.store.recordEvent(w.widget(), ev({ requestId: 'e1', leadId: 'l1' }));
    w.store.recordEvent(w.widget(), ev({ requestId: 'e2' })); // same session, no leadId
    w.store.recordEvent(w.widget({ sessionId: 'sa2' }), ev({ requestId: 'e3' }));
  };
  it('deletes lead + events by lead id or session; others survive; idempotent', () => {
    const w = world();
    seed(w);
    expect(w.store.deleteLead(w.widget(), 'l1')).toEqual({ ok: true, deleted: true, events: 2 });
    expect(w.store.deleteLead(w.widget(), 'l1')).toEqual({ ok: true, deleted: false, events: 0 });
    expect(w.store.getLead(w.op(), 'l1')).toBeNull();
    expect(w.store.listLeads(w.op())).toEqual([]);
    expect((w.store.aggregate(w.op()) as any).aggregate.counts.widget_opened.value).toBe(1);
  });
  it('deleted data cannot reappear via replay, re-create, or new events', () => {
    const w = world();
    seed(w);
    w.store.deleteLead(w.op(), 'l1');
    expect(code(w.store.createLead(w.widget(), lead()))).toBe('deleted');
    expect(code(w.store.createLead(w.widget(), lead({ requestId: 'r9' })))).toBe('deleted');
    expect(code(w.store.recordEvent(w.widget(), ev({ requestId: 'e1', leadId: 'l1' })))).toBe('deleted');
    expect(code(w.store.recordEvent(w.widget(), ev({ requestId: 'e1', leadId: 'l1', data: { returning: true } })))).toBe('idempotency_conflict');
    expect(code(w.store.recordEvent(w.widget(), ev({ requestId: 'e7' })))).toBe('deleted');
    expect(w.store.listLeads(w.op())).toEqual([]);
    expect((w.store.aggregate(w.op()) as any).aggregate.counts.widget_opened.value).toBe(1);
    expect(code(w.store.updateLead(w.op(), { requestId: 'u1', leadId: 'l1', handoff: 'requested' }))).toBe('deleted');
  });
  it('another session cannot delete; unknown ids are not_found; viewers denied', () => {
    const w = world();
    seed(w);
    expect(code(w.store.deleteLead(w.widget({ sessionId: 'sa2' }), 'l1'))).toBe('not_found');
    expect(code(w.store.deleteLead(w.widget(), 'nope'))).toBe('not_found');
    expect(code(w.store.deleteLead(w.viewer(), 'l1'))).toBe('role_denied');
    expect(w.store.listLeads(w.op())).toHaveLength(1);
  });
  it('legal hold blocks deletion and purge', () => {
    const w = world({ legalHolds: { leads: [{ tenantId: 't-a', leadId: 'l1' }] } });
    seed(w);
    expect(code(w.store.deleteLead(w.widget(), 'l1'))).toBe('deletion_blocked');
    clock.now += 1000 * DAY;
    expect(w.store.purgeExpired({ system: 'purge_expired' })).toEqual({ leads: 0, events: 1 }); // only unheld session's event
    expect(w.store.listLeads(w.op())).toHaveLength(1);
  });
});

describe('retention purge', () => {
  it('is deterministic with the injected clock and needs the purge system op', () => {
    const w = world({ retention: { leadMs: 10 * DAY, eventMs: 5 * DAY } });
    w.store.createLead(w.widget(), lead());
    w.store.recordEvent(w.widget({ sessionId: 'sa2' }), ev());
    expect(w.store.purgeExpired({ system: 'resolve_context' } as any)).toEqual({ leads: 0, events: 0 });
    clock.now = T0 + 5 * DAY - 1;
    expect(w.store.purgeExpired({ system: 'purge_expired' })).toEqual({ leads: 0, events: 0 });
    clock.now = T0 + 5 * DAY;
    expect(w.store.purgeExpired({ system: 'purge_expired' })).toEqual({ leads: 0, events: 1 });
    clock.now = T0 + 10 * DAY;
    expect(w.store.purgeExpired({ system: 'purge_expired' })).toEqual({ leads: 1, events: 0 });
    expect(w.store.purgeExpired({ system: 'purge_expired' })).toEqual({ leads: 0, events: 0 });
    expect(w.store.listLeads(w.op())).toEqual([]);
    expect(code(w.store.createLead(w.widget(), lead({ requestId: 'r5' })))).toBe('deleted');
  });
});

describe('tenant deletion', () => {
  it('requires admin + delete purpose, confirmation, and respects holds; plan is a dry run', () => {
    const w = world();
    w.store.createLead(w.widget(), lead());
    w.store.recordEvent(w.widget(), ev());
    w.store.createLead(w.widget({ tenantId: 't-b' }), lead({ requestId: 'rb', leadId: 'lb', tenantId: 't-b', siteId: 's-b', sessionId: 'sb1' }));
    expect(code(w.store.planDelete(w.op()))).toBe('purpose_mismatch');
    expect(code(w.store.planDelete(w.widget()))).toBe('purpose_mismatch');
    expect(w.store.planDelete(w.admin())).toEqual({ ok: true, leads: ['l1'], events: ['e1'] });
    expect(w.store.listLeads(w.op())).toHaveLength(1);
    expect(code(w.store.eraseTenant(w.admin()))).toBe('confirmation_required');
    expect(w.store.eraseTenant(w.admin(), { confirm: true })).toEqual({ ok: true, leads: 1, events: 1 });
    expect(w.store.listLeads(w.op())).toEqual([]);
    expect(w.store.listLeads(w.op('b'))).toHaveLength(1);
    expect(w.store.eraseTenant(w.admin(), { confirm: true })).toEqual({ ok: true, leads: 0, events: 0 });
  });
  it('legal hold blocks tenant erase', () => {
    const w = world({ legalHolds: { tenants: ['t-a'] } });
    expect(code(w.store.planDelete(w.admin()))).toBe('deletion_blocked');
    expect(code(w.store.eraseTenant(w.admin(), { confirm: true }))).toBe('deletion_blocked');
  });
});

describe('QA hardening', () => {
  it('lead-level hold blocks tenant plan and erase; held lead and event survive', () => {
    const w = world({ legalHolds: { leads: [{ tenantId: 't-a', leadId: 'l1' }] } });
    w.store.createLead(w.widget(), lead());
    w.store.recordEvent(w.widget(), ev({ leadId: 'l1' }));
    w.store.createLead(w.widget(), lead({ requestId: 'r2', leadId: 'l2', sessionId: 'sa1' }));
    expect(code(w.store.planDelete(w.admin()))).toBe('deletion_blocked');
    expect(code(w.store.eraseTenant(w.admin(), { confirm: true }))).toBe('deletion_blocked');
    expect(w.store.getLead(w.op(), 'l1')).not.toBeNull();
    expect((w.store.aggregate(w.op()) as any).aggregate.counts.widget_opened.value).toBe(1);
  });
  it('idempotency is bound to site and session', () => {
    const w = world();
    expect((w.store.recordEvent(w.widget(), ev()) as any).replay).toBe(false);
    const other = w.widget({ sessionId: 'sa2' });
    expect(code(w.store.recordEvent(other, ev()))).toBe('idempotency_conflict');
    const site2 = w.widget({ siteId: 's-a2', origin: 'https://a2.example', sessionId: 'sa-site2' });
    expect(code(w.store.recordEvent(site2, ev()))).toBe('idempotency_conflict');
    expect((w.store.aggregate(w.op()) as any).aggregate.counts.widget_opened.value).toBe(1);
    expect((w.store.recordEvent(w.widget(), ev()) as any).replay).toBe(true);
  });
  it('rejects secret/PII-like identifiers', () => {
    const w = world();
    const bad = ['a@b.co', 'sk_live_abc123', 'token-abc', '+1 555 123 4567', '5551234567', '555-123-4567'];
    for (const v of bad) {
      expect(code(w.store.createLead(w.widget(), lead({ leadId: v })))).toBe('invalid_input');
      expect(code(w.store.createLead(w.widget(), lead({ recommendationId: v })))).toBe('invalid_input');
      expect(code(w.store.createLead(w.widget(), lead({ requestId: v })))).toBe('invalid_input');
      expect(code(w.store.recordEvent(w.widget(), ev({ requestId: v })))).toBe('invalid_input');
    }
    w.store.createLead(w.widget(), lead());
    expect(code(w.store.updateLead(w.op(), { requestId: 'u1', leadId: 'l1', recommendationId: 'a@b.co' }))).toBe('invalid_input');
    expect(w.store.createLead(w.widget(), lead({ requestId: 'r9', leadId: 'lead_9f2c-ab12', recommendationId: 'rec:v2.7' })).ok).toBe(true);
  });
});

describe('QA follow-up: credential shapes, idempotency digest, shared sessions', () => {
  const CREDS = [
    'sk-abcdefghijklmnopqrstuvwxyz', 'sk_live_abcdefghijklmnop', 'sk-ant-api03-abcdefghijklmnop', 'sk-proj-abcdefghijklmnopqrstuv',
    'ghp_abcdefghijklmnopqrstuvwxyz0123', 'github_pat_11ABCDEFG0abcdefghijkl', 'AKIAIOSFODNN7EXAMPLE',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abcDEF-_ghi', 'xoxb-abcdefghijkl', 'AIzaSyabcdefghijklmnop', 'glpat-abcdefghijklmnop', 'hf_abcdefghijklmnop',
  ];
  it.each(CREDS)('rejects credential-shaped id %s everywhere and stores nothing', (cred) => {
    const w = world();
    const c = w.widget();
    expect(code(w.store.createLead(c, lead({ requestId: cred })))).toBe('invalid_input');
    expect(code(w.store.createLead(c, lead({ leadId: cred })))).toBe('invalid_input');
    expect(code(w.store.createLead(c, lead({ recommendationId: cred })))).toBe('invalid_input');
    expect(code(w.store.recordEvent(c, ev({ requestId: cred })))).toBe('invalid_input');
    expect(code(w.store.recordEvent(c, ev({ leadId: cred })))).toBe('invalid_input');
    expect(code(w.store.recordEvent(c, ev({ name: 'card_interaction', data: { action: 'view', cardId: cred } })))).toBe('invalid_input');
    expect(code(w.store.updateLead(w.op(), { requestId: 'u1', leadId: 'l1', recommendationId: cred }))).toBe('invalid_input');
    expect(w.store.listLeads(w.op())).toEqual([]);
    expect(JSON.stringify(w.store.aggregate(w.op()))).not.toContain(cred);
  });
  it('still accepts ordinary opaque ids', () => {
    const w = world();
    for (const id of ['lead-1', 'ask_9', 'ska-1', 'req:abc.def', 'eyJ-not-a-jwt']) expect(code(w.store.createLead(w.widget(), lead({ requestId: `r-${id}`, leadId: id })))).toBe('ok');
  });

  it('retains no raw identifiers or payload in idempotency/tombstone state after deletion', () => {
    const live = new Map<object, Set<string>>();
    const oSet = Map.prototype.set, oDel = Map.prototype.delete, oAdd = Set.prototype.add, oSDel = Set.prototype.delete;
    const oGet = Map.prototype.get;
    const bag = (o: object) => oGet.call(live, o) ?? (oSet.call(live, o, new Set<string>()), oGet.call(live, o)) as Set<string>;
    const rec = (o: object, s: string) => oAdd.call(bag(o), s);
    const drop = (o: object, f: (s: string) => boolean) => { const b = bag(o); for (const s of [...b]) if (f(s)) oSDel.call(b, s); };
    Map.prototype.set = function (this: Map<unknown, unknown>, key: unknown, v: unknown) { rec(this, JSON.stringify([key, v])); rec(this, `k:${String(key)}`); return oSet.call(this, key, v); };
    Map.prototype.delete = function (this: Map<unknown, unknown>, key: unknown) { drop(this, (s) => s === `k:${String(key)}` || s.startsWith(`${JSON.stringify([key]).slice(0, -1)},`)); return oDel.call(this, key); };
    Set.prototype.add = function (this: Set<unknown>, v: unknown) { rec(this, String(v)); return oAdd.call(this, v); };
    Set.prototype.delete = function (this: Set<unknown>, v: unknown) { drop(this, (s) => s === String(v)); return oSDel.call(this, v); };
    try {
      const w = world();
      const c = w.widget();
      expect(code(w.store.createLead(c, lead({ requestId: 'req-zz-1', leadId: 'lead-zz', recommendationId: 'rec-zz' })))).toBe('ok');
      expect(code(w.store.recordEvent(c, ev({ requestId: 'ev-req-zz', name: 'card_interaction', data: { action: 'view', cardId: 'card-zz' }, leadId: 'lead-zz' })))).toBe('ok');
      expect(code(w.store.deleteLead(c, 'lead-zz'))).toBe('ok');
      const state = [...live.values()].flatMap((s) => [...s]).join('\n');
      for (const raw of ['req-zz-1', 'ev-req-zz', 'lead-zz', 'rec-zz', 'card-zz', 'createLead', 'recordEvent']) expect(state).not.toContain(raw);
      // replay/conflict semantics survive via digests
      expect(code(w.store.createLead(c, lead({ requestId: 'req-zz-1', leadId: 'lead-zz', recommendationId: 'rec-zz' })))).toBe('deleted');
      expect(code(w.store.createLead(c, lead({ requestId: 'req-zz-1', leadId: 'lead-other' })))).toBe('idempotency_conflict');
      expect(code(w.store.recordEvent(c, ev({ requestId: 'ev-req-zz' })))).toBe('idempotency_conflict');
    } finally {
      Map.prototype.set = oSet; Map.prototype.delete = oDel; Set.prototype.add = oAdd; Set.prototype.delete = oSDel;
    }
  });

  it('deleting one lead never deletes events of a held lead sharing the session', () => {
    const w = world({ legalHolds: { leads: [{ tenantId: 't-a', leadId: 'held' }] } });
    const c = w.widget();
    expect(code(w.store.createLead(c, lead({ requestId: 'r-h', leadId: 'held' })))).toBe('ok');
    expect(code(w.store.createLead(c, lead({ requestId: 'r-d', leadId: 'doomed' })))).toBe('ok');
    expect(code(w.store.recordEvent(c, ev({ requestId: 'e-held', leadId: 'held' })))).toBe('ok');
    expect(code(w.store.recordEvent(c, ev({ requestId: 'e-doomed', leadId: 'doomed' })))).toBe('ok');
    expect(code(w.store.recordEvent(c, ev({ requestId: 'e-anon' })))).toBe('ok');
    const r: any = w.store.deleteLead(c, 'doomed');
    expect(r).toMatchObject({ ok: true, deleted: true, events: 1 });
    expect(w.store.getLead(w.op(), 'held')).not.toBeNull();
    expect((w.store.aggregate(w.op()) as any).aggregate.counts.widget_opened.value).toBe(2); // held + anonymous survive
    expect(code(w.store.recordEvent(c, ev({ requestId: 'e-more', leadId: 'held' })))).toBe('ok'); // session not tombstoned
    clock.now = T0 + 400 * DAY;
    w.store.purgeExpired({ system: 'purge_expired' } as any);
    expect(w.store.getLead(w.op(), 'held')).not.toBeNull();
  });
});

describe('QA follow-up 2: code-field redaction and deleted replay', () => {
  it('rejects credential/phone-shaped free-form code fields but accepts normal codes', () => {
    const w = world();
    const bad = ['ghp_abcdefghijklmnop', 'hf_abcdefghijkl', 'whsec_abcdef', 'npm_abcdefghij', 'sk_live_abc', 'github_pat_abc', 'glpat_abc', 'p5551234567', 'x_555_123_4567'];
    let i = 0;
    for (const v of bad) {
      const r = () => `q${i++}`;
      expect(code(w.store.recordEvent(w.widget(), { requestId: r(), name: 'error', data: { code: v }, consent: 'granted' }))).toBe('invalid_input');
      expect(code(w.store.recordEvent(w.widget(), { requestId: r(), name: 'handoff', data: { channel: v, outcome: 'requested' }, consent: 'granted' }))).toBe('invalid_input');
      expect(code(w.store.recordEvent(w.widget(), { requestId: r(), name: 'degraded_mode', data: { reason: v, active: true }, consent: 'granted' }))).toBe('invalid_input');
    }
    expect(w.store.recordEvent(w.widget(), { requestId: 'ok1', name: 'error', data: { code: 'timeout_504' }, consent: 'granted' }).ok).toBe(true);
    expect(w.store.recordEvent(w.widget(), { requestId: 'ok2', name: 'handoff', data: { channel: 'whatsapp', outcome: 'requested' }, consent: 'granted' }).ok).toBe(true);
    expect(w.store.recordEvent(w.widget(), { requestId: 'ok3', name: 'degraded_mode', data: { reason: 'llm_unavailable', active: true }, consent: 'granted' }).ok).toBe(true);
  });
  it('a purged event requestId cannot replay as success', () => {
    const w = world({ retention: { leadMs: 10 * DAY, eventMs: 5 * DAY } });
    const e = ev({ requestId: 'e1' });
    expect(w.store.recordEvent(w.widget(), e).ok).toBe(true);
    clock.now = T0 + 5 * DAY;
    w.store.purgeExpired({ system: 'purge_expired' });
    expect(code(w.store.recordEvent(w.widget(), e))).toBe('deleted');
  });
});

describe('one-shot reads of untrusted inputs (getter/Proxy TOCTOU)', () => {
  // Returns `good` on the first read of the property and `bad` afterwards.
  const flip = (good: unknown, bad: unknown) => { let n = 0; return () => (n++ === 0 ? good : bad); };
  it('event data: getter returns valid first, secret on re-read -> only the snapshot is accepted', async () => {
    const { parseEventData } = await import('../src/model.js');
    const g = (good: unknown, bad: unknown) => Object.defineProperty({}, 'code', { enumerable: true, get: flip(good, bad) });
    expect(parseEventData('error', g('ok_code', 'a@b.com'))).toEqual({ code: 'ok_code' });
    expect(parseEventData('error', g('a@b.com', 'ok_code'))).toBeNull(); // malformed first read is rejected
    const w = world();
    expect(code(w.store.recordEvent(w.widget(), ev({ name: 'error', data: g('ok_code', 'sk-live-secret') })))).toBe('ok');
  });
  it('event data: Proxy get/ownKeys/getPrototypeOf that throw fail closed', () => {
    const w = world();
    const boom = () => { throw new Error('x'); };
    for (const h of [{ get: boom }, { ownKeys: boom }, { getPrototypeOf: boom }, { getOwnPropertyDescriptor: boom }] as ProxyHandler<any>[]) {
      expect(code(w.store.recordEvent(w.widget(), ev({ name: 'error', data: new Proxy({ code: 'ok_code' }, h) })))).toBe('invalid_input');
    }
  });
  it('parseEventData returns the snapshot value', async () => {
    const { parseEventData } = await import('../src/model.js');
    const o = Object.defineProperty({}, 'code', { enumerable: true, get: flip('ok_code', 'a@b.com') });
    expect(parseEventData('error', o)).toEqual({ code: 'ok_code' });
    expect(parseEventData('error', new Proxy({}, { ownKeys() { throw new Error('x'); } }))).toBeNull();
  });
  it('withdrawConsent: ids that change on re-read cannot target another lead / request', () => {
    const w = world();
    w.store.createLead(w.widget(), lead());
    w.store.createLead(w.widget(), lead({ requestId: 'r2', leadId: 'l2' }));
    const input = Object.defineProperties({}, {
      requestId: { enumerable: true, get: flip('w1', 'a@b.com') },
      leadId: { enumerable: true, get: flip('l1', 'l2') },
    });
    const r: any = w.store.withdrawConsent(w.widget(), input);
    expect(r.ok).toBe(true);
    expect(r.lead.id).toBe('l1');
    expect(w.store.getLead(w.op(), 'l2')?.consent).toBe('granted');
    // replaying the same requestId with the snapshot value is an idempotent replay
    expect((w.store.withdrawConsent(w.widget(), { requestId: 'w1', leadId: 'l1' }) as any).replay).toBe(true);
  });
  it('withdrawConsent: throwing Proxy fails closed', () => {
    const w = world();
    w.store.createLead(w.widget(), lead());
    expect(code(w.store.withdrawConsent(w.widget(), new Proxy({ requestId: 'w1', leadId: 'l1' }, { get() { throw new Error('x'); } })))).toBe('invalid_input');
  });
  it('createLead/updateLead/recordEvent: throwing or hostile inputs return invalid_input without mutating; plain controls still work', () => {
    const w = world();
    const boom = () => { throw new Error('x'); };
    const traps = [{ get: boom }, { ownKeys: boom }, { getPrototypeOf: boom }, { getOwnPropertyDescriptor: boom }] as ProxyHandler<any>[];
    for (const h of traps) {
      expect(code(w.store.createLead(w.widget(), new Proxy(lead(), h)))).toBe('invalid_input');
      expect(code(w.store.updateLead(w.op(), new Proxy({ requestId: 'u1', leadId: 'l1', handoff: 'requested' }, h)))).toBe('invalid_input');
      expect(code(w.store.recordEvent(w.widget(), new Proxy(ev(), h)))).toBe('invalid_input');
    }
    const getter = { ...lead(), get source() { throw new Error('x'); } };
    expect(code(w.store.createLead(w.widget(), getter))).toBe('invalid_input');
    expect(w.store.listLeads(w.op())).toEqual([]);
    expect((w.store.aggregate(w.op()) as any).aggregate.counts.widget_opened.value).toBe(0);
    // valid controls
    expect(code(w.store.createLead(w.widget(), lead()))).toBe('ok');
    expect(code(w.store.updateLead(w.op(), { requestId: 'u1', leadId: 'l1', handoff: 'requested' }))).toBe('ok');
    expect(code(w.store.recordEvent(w.widget(), ev()))).toBe('ok');
  });
});
