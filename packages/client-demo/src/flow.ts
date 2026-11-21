// Deterministic demo flow built only on existing engine / identity / leads-analytics contracts.
import { recommend, runGroundedTurn, selectFollowUp } from '@pilgrim/engine';
import type { EvidenceItem, GroundedTurnResult, ObjectiveName } from '@pilgrim/engine';
import { createIdentityFixture, resolveTenantContext } from '@pilgrim/identity';
import { createLeadAnalyticsStore } from '@pilgrim/leads-analytics';
import { CATALOG, POLICY, SOURCE_CATALOG, START_DATE } from './fixture.js';

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const clampInt = (v: string | undefined, d: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v ? parseInt(v, 10) : d));
const PRIORITY: Array<[RegExp, ObjectiveName]> = [[/cheap|price|budget|afford/, 'total_price'], [/close|near|distance|walk/, 'distance_m'], [/star|luxur/, 'stars'], [/fewest|rooms?\b.*fewer/, 'room_count']];
const PHRASE: Record<ObjectiveName, string> = { total_price: 'cheapest', distance_m: 'closest to the Haram', stars: 'highest rated', room_count: 'fewest rooms' };
const LABEL: Record<ObjectiveName, string> = { total_price: 'Lowest price', distance_m: 'Closest to the Haram', stars: 'Highest star rating', room_count: 'Fewest rooms' };

export type Chip = { label: string; q: string };
export type DemoContext = { city: string; travelers: number; nights: number; budget?: number };
export type DemoTurn = { message: string; result: GroundedTurnResult; evidence: Record<string, EvidenceItem>; chips: Chip[]; simulated: boolean; context?: DemoContext };

export async function runDemoTurn(message: string, opts: { simulateProviderFailure?: boolean; context?: DemoContext } = {}): Promise<DemoTurn> {
  const evidence: Record<string, EvidenceItem> = {};
  const prior = opts.context;
  const contextMatch = (message.match(/\b(?:cheaper|cheap|lower price|more affordable)\b/i) || prior) !== null;
  const hotelOf: Record<string, string> = {};
  let followUp: Chip[] = [];
  const result = await runGroundedTurn({
    message,
    extract: (m) => {
      const t = m.toLowerCase();
      const hotelIntent = /hotel|stay|room|makkah|mecca|madinah|medina|jeddah|near|cheap|budget/.test(t);
      const intent = /cancel|refund|visa/.test(t) ? 'policy' : hotelIntent || contextMatch ? 'hotel_search' : 'unknown';
      const slots: Record<string, string | number> = {};
      if (intent === 'hotel_search') {
        const cityMatch = t.match(/\b(makkah|mecca|madinah|medina|jeddah)\b/);
        const city = cityMatch?.[1] === 'mecca' ? 'makkah' : cityMatch?.[1] === 'medina' ? 'madinah' : cityMatch?.[1] ?? prior?.city ?? 'unknown';
        slots.city = city;
        slots.travelers = clampInt(t.match(/(\d+)\s*(?:people|persons|travell?ers|pilgrims|adults)/)?.[1], prior?.travelers ?? 2, 1, 8);
        slots.nights = clampInt(t.match(/(\d+)\s*nights?/)?.[1], prior?.nights ?? 3, 1, 14);
        const budget = t.match(/(?:under|less than|up to|max(?:imum)?(?: budget)?)[^\d]{0,10}(\d+)\s*(?:sar|riyals?)?|(?:\b(\d+)\s*(?:sar|riyals?))/i);
        if (budget) slots.budget = Number(budget[1] ?? budget[2]);
        else if (prior?.budget !== undefined) slots.budget = prior.budget;
        const p = PRIORITY.find(([re]) => re.test(t));
        if (p) slots.priority = p[1];
        else if (/\b(?:cheaper|cheap|lower price|more affordable)\b/.test(t)) slots.priority = 'total_price';
      }
      if (intent === 'policy') slots.topic = /visa/.test(t) ? 'visa' : 'cancel';
      return { intent, slots };
    },
    retrieve: (intent, s) => {
      let items: EvidenceItem[] = [];
      if (intent === 'policy') items = POLICY.filter((p) => p.topics.includes(String(s.topic)));
      if (intent === 'hotel_search') {
        const city = String(s.city), nights = Number(s.nights), pr = s.priority as ObjectiveName | undefined;
        if (!['makkah', 'madinah'].includes(city)) return [];
        const request = { travelers: Number(s.travelers), start_date: START_DATE, leg_nights: { [city]: nights }, result_count: 3, ...(s.budget !== undefined ? { filters: { max_total_price: Number(s.budget) } } : {}), ...(pr ? { objectives: { total_price: 0.1, distance_m: 0.1, stars: 0.1, room_count: 0.1, [pr]: 0.7 } } : {}) };
        let options;
        try { options = recommend(CATALOG, request).options; } catch { return []; }
        items = options.map((o) => {
          const id = `hotel-${o.id}`;
          hotelOf[id] = o.hotel_names[0]!;
          return { id, source: SOURCE_CATALOG, topics: [city], text: `${o.hotel_names[0]}, ${o.stars} stars, ${o.distance_m} m from the Haram, ${o.total_price} total for ${nights} nights in ${cap(city)}.` };
        });
        const next = items.length ? selectFollowUp({ catalog: CATALOG, request, explored_dimensions: pr ? [pr] : [] }) : null;
        const base = `Hotels in ${cap(city)} for ${s.travelers} people, ${nights} nights`;
        if (next) followUp.push({ label: LABEL[next.attribute], q: `${base}, ${PHRASE[next.attribute]}` });
        followUp.push({ label: 'Cancellation policy', q: 'What is the cancellation policy?' });
      }
      for (const e of items) evidence[e.id] = e;
      return items;
    },
    // Local rule composer standing in for a model: quotes evidence verbatim, so it cannot invent facts.
    compose: ({ evidence: ev, slots }) => {
      if (opts.simulateProviderFailure) throw new Error('simulated provider outage');
      const hotels = ev.filter((e) => hotelOf[e.id]);
      return {
        claims: ev.map((e) => ({ text: e.text, citations: [e.id] })),
        cards: hotels.map((e) => ({ kind: 'hotel', title: hotelOf[e.id], citations: [e.id] })),
        recommendations: hotels.map((e) => ({ title: hotelOf[e.id], rationale: `${slots.priority ? LABEL[slots.priority as ObjectiveName] : 'Balanced pick'}: ${e.text}`, citations: [e.id] })),
      };
    },
  });
  if (result.status !== 'grounded') followUp = [];
  const context: DemoContext | undefined = result.intent === 'hotel_search' && typeof result.slots.city === 'string' && typeof result.slots.travelers === 'number' && typeof result.slots.nights === 'number'
    ? { city: result.slots.city, travelers: result.slots.travelers, nights: result.slots.nights, ...(typeof result.slots.budget === 'number' ? { budget: result.slots.budget } : {}) }
    : undefined;
  return { message, result, evidence: result.status === 'grounded' ? evidence : {}, chips: followUp, simulated: !!opts.simulateProviderFailure, context };
}

// Mock handoff: real tenant/consent/lead contracts, in-memory fixture only. No contact data is collected or sent.
const T0 = 1_000_000_000;
export function createDemoHandoff() {
  let n = 0;
  const clock = () => T0 + n;
  const ids = { tenantId: 'demo-tenant', siteId: 'demo-site', sessionId: 'demo-session' };
  const fx = createIdentityFixture({
    users: [{ id: 'demo-advisor', status: 'active', createdAt: 1 }],
    tenants: [{ id: ids.tenantId, status: 'active', createdAt: 1 }],
    sites: [{ id: ids.siteId, tenantId: ids.tenantId, origin: 'http://127.0.0.1', status: 'active' }],
    memberships: [{ userId: 'demo-advisor', tenantId: ids.tenantId, role: 'operator', status: 'active', createdAt: 1 }],
    sessions: [{ id: ids.sessionId, ...{ tenantId: ids.tenantId, siteId: ids.siteId }, status: 'active', createdAt: T0, lastSeenAt: T0, expiresAt: T0 + 86_400_000 }],
  }, { clock });
  const store = createLeadAnalyticsStore({ clock });
  const ctx = (purpose: 'chat' | 'control_plane', principal?: { userId: string }) => {
    // operator contexts need their own session bound to the user; issued fresh per call
    const op = principal ? { principal, sessionId: `advisor-${n}`, newSession: true } : {};
    const r = resolveTenantContext({ ...ids, origin: 'http://127.0.0.1', purpose, ...op }, { directory: fx.directory, clock });
    if (!r.ok) throw new Error(r.code);
    return r.context;
  };
  return {
    /** Consent is mandatory; fails closed with the store's code. recommendationId must be an opaque id. */
    submit(consent: boolean, recommendationId: string | null): { ok: true; handoff: string; followUp: string } | { ok: false; code: string } {
      n++;
      const created = store.createLead(ctx('chat'), { requestId: `req-${n}`, leadId: `lead-${n}`, ...ids, consent: consent ? 'granted' : 'withheld', source: 'handoff', recommendationId });
      if (!created.ok) return created;
      const updated = store.updateLead(ctx('control_plane', { userId: 'demo-advisor' }), { requestId: `upd-${n}`, leadId: `lead-${n}`, handoff: 'requested', followUp: 'pending' });
      return updated.ok ? { ok: true, handoff: updated.lead.handoff, followUp: updated.lead.followUp } : updated;
    },
  };
}
