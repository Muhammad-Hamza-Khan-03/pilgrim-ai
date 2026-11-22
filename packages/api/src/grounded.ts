import { recommend, runGroundedTurn, type EvidenceItem, type GroundedTurnResult, type ObjectiveName } from '@pilgrim/engine';
import { CATALOG, POLICY, SOURCE_CATALOG, START_DATE } from './grounded-fixtures.js';

export type FollowUp = { label: string; message: string };
export type LocalGroundedResponse = {
  groundedTurn: GroundedTurnResult;
  followUps: FollowUp[];
  status: GroundedTurnResult['status'];
  reply: string;
};

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const clamp = (v: string | undefined, fallback: number, max: number) => Math.min(max, Math.max(1, v ? Number(v) : fallback));
const priorities: Array<[RegExp, ObjectiveName]> = [[/cheap|price|budget|afford/, 'total_price'], [/close|near|distance|walk/, 'distance_m'], [/star|luxur/, 'stars']];
const labels: Record<ObjectiveName, string> = { total_price: 'Cheapest', distance_m: 'Closest to the Haram', stars: 'Highest star rating', room_count: 'Fewest rooms' };

export async function runLocalGroundedTurn(message: string, opts: { simulateFailure?: boolean } = {}): Promise<LocalGroundedResponse> {
  const hotels = new Map<string, string>();
  const result = await runGroundedTurn({
    message,
    extract: (raw) => {
      const t = raw.toLowerCase();
      const hotel = /hotel|stay|room|makkah|mecca|madinah|medina|near|cheap|budget/.test(t);
      const intent = /cancel|refund|visa/.test(t) ? 'policy' : hotel ? 'hotel_search' : 'unknown';
      const slots: Record<string, string | number> = {};
      if (intent === 'hotel_search') {
        const cityMatch = t.match(/\b(makkah|mecca|madinah|medina)\b/);
        slots.city = cityMatch?.[1] === 'mecca' ? 'makkah' : cityMatch?.[1] === 'medina' ? 'madinah' : cityMatch?.[1] ?? 'unknown';
        slots.travelers = clamp(t.match(/(\d+)\s*(?:people|persons|travell?ers|pilgrims|adults)/)?.[1], 2, 8);
        slots.nights = clamp(t.match(/(\d+)\s*nights?/)?.[1], 3, 14);
        const p = priorities.find(([re]) => re.test(t));
        if (p) slots.priority = p[1];
      }
      if (intent === 'policy') slots.topic = /visa/.test(t) ? 'visa' : 'cancel';
      return { intent, slots };
    },
    retrieve: (intent, slots) => {
      if (intent === 'policy') return POLICY.filter((item) => item.topics.includes(String(slots.topic)));
      if (intent !== 'hotel_search' || !['makkah', 'madinah'].includes(String(slots.city))) return [];
      const city = String(slots.city);
      const nights = Number(slots.nights);
      const priority = slots.priority as ObjectiveName | undefined;
      let options;
      try {
        options = recommend(CATALOG, { travelers: Number(slots.travelers), start_date: START_DATE, leg_nights: { [city]: nights }, result_count: 3, ...(priority ? { objectives: { total_price: 0.1, distance_m: 0.1, stars: 0.1, room_count: 0.1, [priority]: 0.7 } } : {}) }).options;
      } catch { return []; }
      return options.map((option) => {
        const id = `hotel-${option.id}`;
        hotels.set(id, option.hotel_names[0]!);
        return { id, source: SOURCE_CATALOG, topics: [city], text: `${option.hotel_names[0]}, ${option.stars} stars, ${option.distance_m} m from the Haram, ${option.total_price} total for ${nights} nights in ${cap(city)}.` };
      });
    },
    compose: ({ evidence, slots }) => {
      if (opts.simulateFailure) throw new Error('local adapter unavailable');
      const hotelEvidence = evidence.filter((item) => hotels.has(item.id));
      return {
        claims: evidence.map((item) => ({ text: item.text, citations: [item.id] })),
        cards: hotelEvidence.map((item) => ({ kind: 'hotel', title: hotels.get(item.id)!, citations: [item.id] })),
        recommendations: hotelEvidence.map((item) => ({ title: hotels.get(item.id)!, rationale: `${slots.priority ? labels[slots.priority as ObjectiveName] : 'Balanced pick'}: ${item.text}`, citations: [item.id] })),
      };
    },
  });
  const city = typeof result.slots.city === 'string' ? cap(result.slots.city) : '';
  const nights = typeof result.slots.nights === 'number' ? result.slots.nights : 3;
  const followUps: FollowUp[] = result.status === 'grounded' && result.intent === 'hotel_search' ? [
    { label: 'Cheaper options', message: `Hotels in ${city} for ${result.slots.travelers ?? 2} people, ${nights} nights, cheaper` },
    { label: 'Cancellation policy', message: 'What is the cancellation policy?' },
  ] : [];
  const reply = result.status === 'grounded'
    ? 'I found fixture-backed guidance for your stay.'
    : result.status === 'insufficient_evidence' ? 'I do not have enough verified fixture evidence to answer that.' : 'The local grounded adapter is unavailable right now.';
  return { groundedTurn: result, followUps, status: result.status, reply };
}
