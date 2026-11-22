// Local-only deterministic hotel/policy evidence. Invented fixtures; no provider or live inventory.
import type { Catalog, EvidenceItem } from '@pilgrim/engine';

export const SOURCE_CATALOG = 'Demo hotel list (fixture)';
export const SOURCE_POLICY = 'Demo policy notes (fixture)';
export const START_DATE = '2026-12-01';
const rate = (price: number) => [{ price, valid_from: '2026-11-01', valid_to: '2027-03-01' }];
const room = (id: string, price: number) => ({ id, room_type: 'double', capacity: 2, rates: rate(price) });
const single = (id: string, price: number) => ({ id, room_type: 'single', capacity: 1, rates: rate(price) });

export const CATALOG: Catalog = { hotels: [
  { id: 'h1', name: 'Zamzam Court', city: 'makkah', stars: 5, distance_m: 150, rooms: [room('h1r', 220), single('h1s', 120)] },
  { id: 'h2', name: 'Safa Residence', city: 'makkah', stars: 4, distance_m: 600, rooms: [room('h2r', 120), single('h2s', 70)] },
  { id: 'h3', name: 'Ajyad Budget Inn', city: 'makkah', stars: 3, distance_m: 1400, rooms: [room('h3r', 70), single('h3s', 45)] },
  { id: 'h4', name: 'Quba Garden', city: 'madinah', stars: 4, distance_m: 300, rooms: [room('h4r', 130), single('h4s', 75)] },
  { id: 'h5', name: 'Baqi Lodge', city: 'madinah', stars: 3, distance_m: 900, rooms: [room('h5r', 80), single('h5s', 45)] },
] };
export const POLICY: EvidenceItem[] = [
  { id: 'policy-cancel', source: SOURCE_POLICY, topics: ['cancel'], text: 'Demo note: cancellation terms differ per hotel and are confirmed by an advisor before booking.' },
  { id: 'policy-visa', source: SOURCE_POLICY, topics: ['visa'], text: 'Demo note: visa support is arranged with an advisor and nothing here confirms a visa.' },
];
