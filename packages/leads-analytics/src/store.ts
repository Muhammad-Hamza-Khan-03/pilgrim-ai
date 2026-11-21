import { createHash } from 'node:crypto';
import { authorize, type Action, type DenyCode, type SystemOperation, type TenantContext } from '@pilgrim/identity';
import {
  EVENT_NAMES, FOLLOW_UP_STATES, HANDOFF_STATES, LEAD_SOURCES, clone, isId, isOpaqueId, onlyKeys, oneOf, parseEventData, snap, stable,
  type AnalyticsEvent, type EventName, type Lead,
} from './model.js';

export type Code = DenyCode | 'invalid_input' | 'consent_required' | 'idempotency_conflict' | 'not_found' | 'deleted' | 'already_exists' | 'deletion_blocked' | 'confirmation_required' | 'session_mismatch';
export type Res<T extends object = {}> = ({ ok: true } & T) | { ok: false; code: Code };
const no = (code: Code): { ok: false; code: Code } => ({ ok: false, code });

export const MIN_SAMPLE = 5;
export interface Metric { value: number | null; label: 'observed' | 'derived' | 'not_enough_data' }
export interface Aggregate { version: 1; tenantId: string; siteId: string; generatedAt: number; counts: Record<EventName, Metric>; derived: { answerPerQuestion: Metric; leadPerOpen: Metric } }
export interface RetentionConfig { leadMs: number; eventMs: number }
export interface Options { clock: () => number; retention?: RetentionConfig; legalHolds?: { tenants?: string[]; leads?: Array<{ tenantId: string; leadId: string }> } }

const DAY = 86_400_000;
const DEFAULT_RETENTION: RetentionConfig = { leadMs: 90 * DAY, eventMs: 30 * DAY };

export function createLeadAnalyticsStore(opts: Options) {
  const retention = opts.retention ?? DEFAULT_RETENTION;
  const leads = new Map<string, Lead>();
  const events = new Map<string, AnalyticsEvent>();
  const requests = new Map<string, string>(); // tenant|digest(requestId) -> digest(fingerprint); no raw ids or payload retained
  const goneLeads = new Set<string>(); // tombstones: ids/sessions only, so deleted data can never be re-created or re-attributed
  const goneSessions = new Set<string>();
  const heldTenants = new Set(opts.legalHolds?.tenants);
  const heldLeads = new Set((opts.legalHolds?.leads ?? []).map((h) => `${h.tenantId}|${h.leadId}`));
  const k = (t: string, id: string) => `${t}|${id}`;
  const dg = (s: string) => createHash('sha256').update(s).digest('hex');
  const hk = (t: string, id: string) => k(t, dg(id)); // digest key for idempotency state and tombstones

  const gate = (c: TenantContext, action: Action): Code | null => {
    const a = authorize(c, action, { tenantId: c?.tenantId, siteId: c?.siteId });
    return a.allowed ? null : a.code;
  };
  const chat = (c: TenantContext) => gate(c, 'chat_append'); // widget session writes
  const operator = (c: TenantContext) => gate(c, 'publish'); // operator-or-higher control-plane access

  /** Returns 'new' | 'replay' | conflict code. Fingerprint binds the operation, so a reused requestId never crosses operations. */
  const idem = (c: TenantContext, requestId: string, fp: string): 'new' | 'replay' | 'idempotency_conflict' => {
    const prev = requests.get(hk(c.tenantId, requestId));
    return prev === undefined ? 'new' : prev === dg(fp) ? 'replay' : 'idempotency_conflict';
  };
  const mineLead = (c: TenantContext, id: unknown) => {
    const l = isId(id) ? leads.get(k(c.tenantId, id)) : undefined;
    return l && l.siteId === c.siteId ? l : undefined;
  };
  const removeLead = (l: Lead): number => {
    leads.delete(k(l.tenantId, l.id));
    goneLeads.add(hk(l.tenantId, l.id));
    const shares = (f: (o: Lead) => boolean) => [...leads.values()].some((o) => o.tenantId === l.tenantId && o.sessionId === l.sessionId && f(o));
    if (!shares(() => true)) goneSessions.add(hk(l.tenantId, l.sessionId)); // a surviving lead keeps the session usable
    const anonToo = !shares(isHeld);
    let n = 0;
    for (const [key, e] of events) if (e.tenantId === l.tenantId && (e.leadId === l.id || (anonToo && e.leadId === null && e.sessionId === l.sessionId))) { events.delete(key); n++; }
    return n;
  };
  const isHeld = (l: Lead) => heldTenants.has(l.tenantId) || heldLeads.has(k(l.tenantId, l.id));

  return {
    createLead(c: TenantContext, input: unknown): Res<{ lead: Lead; replay: boolean }> {
      const d = chat(c);
      if (d) return no(d);
      const i = snap(input);
      if (!i || !onlyKeys(i, ['requestId', 'leadId', 'tenantId', 'siteId', 'sessionId', 'consent', 'source', 'recommendationId'])) return no('invalid_input');
      const { requestId, leadId, tenantId, siteId, sessionId, consent, source, recommendationId = null } = i;
      if (!isOpaqueId(requestId) || !isOpaqueId(leadId) || !isId(tenantId) || !isId(siteId) || !isId(sessionId) || !oneOf(source, LEAD_SOURCES) || (recommendationId !== null && !isOpaqueId(recommendationId))) return no('invalid_input');
      if (tenantId !== c.tenantId) return no('tenant_mismatch');
      if (siteId !== c.siteId) return no('site_mismatch');
      if (sessionId !== c.sessionId) return no('session_mismatch');
      if (consent !== 'granted') return no('consent_required');
      const fp = stable([c.siteId, c.sessionId, 'createLead', leadId, tenantId, siteId, sessionId, consent, source, recommendationId]);
      const st = idem(c, requestId, fp);
      if (st === 'idempotency_conflict') return no(st);
      const cur = leads.get(k(c.tenantId, leadId));
      if (st === 'replay') return cur ? { ok: true, lead: clone(cur), replay: true } : no('deleted');
      if (goneLeads.has(hk(c.tenantId, leadId)) || goneSessions.has(hk(c.tenantId, sessionId))) return no('deleted');
      if (cur) return no('already_exists');
      const now = opts.clock();
      const lead: Lead = { id: leadId, tenantId, siteId, sessionId, consent: 'granted', source, recommendationId, handoff: 'none', followUp: 'none', retention: { state: 'active', retainUntil: now + retention.leadMs }, createdAt: now, updatedAt: now };
      leads.set(k(c.tenantId, leadId), lead);
      requests.set(hk(c.tenantId, requestId), dg(fp));
      return { ok: true, lead: clone(lead), replay: false };
    },

    /** Operator-only status/recommendation update; requires the lead's consent to still be granted. */
    updateLead(c: TenantContext, input: unknown): Res<{ lead: Lead; replay: boolean }> {
      const d = operator(c);
      if (d) return no(d);
      const i = snap(input);
      if (!i || !onlyKeys(i, ['requestId', 'leadId', 'handoff', 'followUp', 'recommendationId'])) return no('invalid_input');
      const { requestId, leadId, handoff, followUp, recommendationId } = i;
      if (!isOpaqueId(requestId) || !isOpaqueId(leadId) || (handoff === undefined && followUp === undefined && recommendationId === undefined)) return no('invalid_input');
      if ((handoff !== undefined && !oneOf(handoff, HANDOFF_STATES)) || (followUp !== undefined && !oneOf(followUp, FOLLOW_UP_STATES)) || (recommendationId !== undefined && recommendationId !== null && !isOpaqueId(recommendationId))) return no('invalid_input');
      const fp = stable([c.siteId, 'updateLead', leadId, handoff ?? null, followUp ?? null, recommendationId === undefined ? '-' : recommendationId]);
      const st = idem(c, requestId, fp);
      if (st === 'idempotency_conflict') return no(st);
      const l = mineLead(c, leadId);
      if (!l) return no(goneLeads.has(hk(c.tenantId, leadId as string)) ? 'deleted' : 'not_found');
      if (st === 'replay') return { ok: true, lead: clone(l), replay: true };
      if (l.consent !== 'granted') return no('consent_required');
      const next: Lead = { ...l, ...(handoff !== undefined ? { handoff } : {}), ...(followUp !== undefined ? { followUp } : {}), ...(recommendationId !== undefined ? { recommendationId } : {}), updatedAt: opts.clock() };
      leads.set(k(c.tenantId, l.id), next);
      requests.set(hk(c.tenantId, requestId), dg(fp));
      return { ok: true, lead: clone(next), replay: false };
    },

    /** The lead's own session withdraws consent; afterwards updates and analytics for the session fail closed. */
    withdrawConsent(c: TenantContext, input: unknown): Res<{ lead: Lead; replay: boolean }> {
      const d = chat(c);
      if (d) return no(d);
      const i = snap(input);
      if (!i || !onlyKeys(i, ['requestId', 'leadId']) || !isOpaqueId(i.requestId) || !isOpaqueId(i.leadId)) return no('invalid_input');
      const { requestId, leadId } = i;
      const fp = stable([c.siteId, c.sessionId, 'withdrawConsent', leadId]);
      const st = idem(c, requestId, fp);
      if (st === 'idempotency_conflict') return no(st);
      const l = mineLead(c, leadId);
      if (!l || l.sessionId !== c.sessionId) return no(goneLeads.has(hk(c.tenantId, leadId)) ? 'deleted' : 'not_found');
      if (st === 'replay') return { ok: true, lead: clone(l), replay: true };
      const next: Lead = { ...l, consent: 'withdrawn', updatedAt: opts.clock() };
      leads.set(k(c.tenantId, l.id), next);
      requests.set(hk(c.tenantId, requestId), dg(fp));
      return { ok: true, lead: clone(next), replay: false };
    },

    getLead(c: TenantContext, leadId: string): Lead | null {
      if (operator(c)) return null;
      const l = mineLead(c, leadId);
      return l ? clone(l) : null;
    },
    listLeads(c: TenantContext): Lead[] {
      if (operator(c)) return [];
      return [...leads.values()].filter((l) => l.tenantId === c.tenantId && l.siteId === c.siteId).sort((a, b) => (a.id < b.id ? -1 : 1)).map(clone);
    },

    /** Idempotent. Allowed for the lead's own session or an operator; removes the lead and all events by its id or session. */
    deleteLead(c: TenantContext, leadId: string): Res<{ deleted: boolean; events: number }> {
      const chatOk = chat(c) === null;
      const d = chatOk ? null : operator(c);
      if (!chatOk && d) return no(d);
      if (!isId(leadId)) return no('invalid_input');
      const l = mineLead(c, leadId);
      if (!l) return goneLeads.has(hk(c.tenantId, leadId)) ? { ok: true, deleted: false, events: 0 } : no('not_found');
      if (chatOk && l.sessionId !== c.sessionId) return no('not_found');
      if (isHeld(l)) return no('deletion_blocked');
      return { ok: true, deleted: true, events: removeLead(l) };
    },

    recordEvent(c: TenantContext, input: unknown): Res<{ eventId: string; replay: boolean }> {
      const d = chat(c);
      if (d) return no(d);
      const i = snap(input);
      if (!i || !onlyKeys(i, ['requestId', 'name', 'data', 'consent', 'leadId'])) return no('invalid_input');
      const { requestId, name, consent, leadId = null } = i;
      const data = parseEventData(name, i.data);
      if (!isOpaqueId(requestId) || !data || (leadId !== null && !isOpaqueId(leadId))) return no('invalid_input');
      if (consent !== 'granted') return no('consent_required');
      const fp = stable([c.siteId, c.sessionId, 'recordEvent', name, data, leadId]);
      const st = idem(c, requestId, fp);
      if (st === 'idempotency_conflict') return no(st);
      if (goneSessions.has(hk(c.tenantId, c.sessionId)) || (leadId !== null && goneLeads.has(hk(c.tenantId, leadId)))) return no('deleted');
      if (st === 'replay') return events.has(k(c.tenantId, requestId)) ? { ok: true, eventId: requestId, replay: true } : no('deleted'); // purged event is not a success
      if ([...leads.values()].some((l) => l.tenantId === c.tenantId && l.sessionId === c.sessionId && l.consent !== 'granted')) return no('consent_required');
      if (leadId !== null) {
        const l = mineLead(c, leadId);
        if (!l || l.sessionId !== c.sessionId) return no('not_found');
      }
      events.set(k(c.tenantId, requestId), { id: requestId, tenantId: c.tenantId, siteId: c.siteId, sessionId: c.sessionId, leadId, name: name as EventName, data, occurredAt: opts.clock() });
      requests.set(hk(c.tenantId, requestId), dg(fp));
      return { ok: true, eventId: requestId, replay: false };
    },

    /** Site-scoped to the caller's context; derived ratios need MIN_SAMPLE denominators. */
    aggregate(c: TenantContext): Res<{ aggregate: Aggregate }> {
      const d = operator(c);
      if (d) return no(d);
      const n = Object.fromEntries(EVENT_NAMES.map((e) => [e, 0])) as Record<EventName, number>;
      for (const e of events.values()) if (e.tenantId === c.tenantId && e.siteId === c.siteId) n[e.name]++;
      const ratio = (num: number, den: number): Metric => (den < MIN_SAMPLE ? { value: null, label: 'not_enough_data' } : { value: Math.round((num / den) * 1e4) / 1e4, label: 'derived' });
      return {
        ok: true,
        aggregate: {
          version: 1, tenantId: c.tenantId, siteId: c.siteId, generatedAt: opts.clock(),
          counts: Object.fromEntries(EVENT_NAMES.map((e) => [e, { value: n[e], label: 'observed' as const }])) as Record<EventName, Metric>,
          derived: { answerPerQuestion: ratio(n.answer_shown, n.question_submitted), leadPerOpen: ratio(n.lead_submitted, n.widget_opened) },
        },
      };
    },

    /** Deterministic via the injected clock; legal-held leads/tenants (and their events) are skipped. */
    purgeExpired(op: SystemOperation): { leads: number; events: number } {
      if (op?.system !== 'purge_expired') return { leads: 0, events: 0 };
      const now = opts.clock();
      const held = new Set<string>();
      for (const l of leads.values()) if (isHeld(l)) held.add(k(l.tenantId, l.sessionId));
      let nl = 0, ne = 0;
      for (const l of [...leads.values()]) if (l.retention.retainUntil <= now && !isHeld(l)) { ne += removeLead(l); nl++; }
      for (const [key, e] of [...events]) if (e.occurredAt + retention.eventMs <= now && !heldTenants.has(e.tenantId) && !held.has(k(e.tenantId, e.sessionId))) { events.delete(key); ne++; }
      return { leads: nl, events: ne };
    },

    /** Dry run (admin, purpose 'delete'): ids a tenant erase would remove, across all sites of the caller's tenant. */
    planDelete(c: TenantContext): Res<{ leads: string[]; events: string[] }> {
      const d = gate(c, 'delete_tenant');
      if (d) return no(d);
      if (heldTenants.has(c.tenantId) || [...leads.values()].some((l) => l.tenantId === c.tenantId && isHeld(l))) return no('deletion_blocked');
      const ids = <T extends { tenantId: string; id: string }>(m: Map<string, T>) => [...m.values()].filter((r) => r.tenantId === c.tenantId).map((r) => r.id).sort();
      return { ok: true, leads: ids(leads), events: ids(events) };
    },
    eraseTenant(c: TenantContext, o: { confirm?: boolean } = {}): Res<{ leads: number; events: number }> {
      const d = gate(c, 'delete_tenant');
      if (d) return no(d);
      if (o?.confirm !== true) return no('confirmation_required');
      if (heldTenants.has(c.tenantId) || [...leads.values()].some((l) => l.tenantId === c.tenantId && isHeld(l))) return no('deletion_blocked');
      const own = (m: Map<string, unknown>) => { let n = 0; for (const key of [...m.keys()]) if (key.startsWith(`${c.tenantId}|`)) { m.delete(key); n++; } return n; };
      const r = { leads: own(leads), events: own(events) };
      own(requests);
      for (const s of [goneLeads, goneSessions]) for (const key of [...s]) if (key.startsWith(`${c.tenantId}|`)) s.delete(key);
      return { ok: true, ...r };
    },
  };
}
export type LeadAnalyticsStore = ReturnType<typeof createLeadAnalyticsStore>;
