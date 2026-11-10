export type Rate = { price: number; valid_from: string; valid_to: string };
export type Room = { id: string; room_type: string; capacity: number; rates: readonly Rate[] };
export type Hotel = { id: string; name: string; city: string; stars: number; distance_m: number; rooms: readonly Room[] };
export type Catalog = { hotels: readonly Hotel[] };
export type RecommenderFilters = { cities?: readonly string[]; max_distance_m?: number; min_distance_m?: number; min_stars?: number; max_stars?: number; room_types?: readonly string[]; max_total_price?: number; min_total_price?: number; max_room_count?: number; min_room_count?: number };
export type ObjectiveName = 'total_price' | 'distance_m' | 'stars' | 'room_count';
export type RecommendationRequest = {
  travelers: number;
  start_date: string;
  leg_nights: Record<string, number>;
  filters?: RecommenderFilters;
  objectives?: Partial<Record<ObjectiveName, number>>;
  directions?: Partial<Record<ObjectiveName, 'min' | 'max'>>;
  result_count?: number;
  diversity?: number;
};
export type ExplanationFact =
  | { kind: 'objective_winner'; objective: ObjectiveName; value: number }
  | { kind: 'comparison'; objective: ObjectiveName; difference: number; versus: string };
export type Allocation = { room_id: string; room_type: string; quantity: number; capacity: number; price_per_night: number; total_price: number };
export type RecommendationOption = {
  id: string;
  hotel_ids: string[];
  hotel_names: string[];
  cities: string[];
  allocation: Allocation[];
  total_price: number;
  room_count: number;
  distance_m: number;
  stars: number;
  score: number;
  explanation_facts: ExplanationFact[];
};
export type RecommendationResult = { options: RecommendationOption[] };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const OBJECTIVES: readonly ObjectiveName[] = ['total_price', 'distance_m', 'stars', 'room_count'];
/** Hard bounds required by the phase-1 Umrah recommender contract. */
export const MAX_CANDIDATES_PER_LEG = 30;
export const MAX_BUNDLE_EXPANSIONS = MAX_CANDIDATES_PER_LEG * MAX_CANDIDATES_PER_LEG;

export class RecommenderError extends Error {
  readonly code: string;
  constructor(message: string, code = 'RECOMMENDER_INVALID') { super(message); this.name = 'RecommenderError'; this.code = code; }
}
function fail(message: string, code?: string): never { throw new RecommenderError(message, code); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number); const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d); date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
function addDays(date: string, days: number): string { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function assertFinite(value: unknown, label: string, min = 0): asserts value is number { if (typeof value !== 'number' || !Number.isFinite(value) || value < min) fail(`${label} must be a finite number >= ${min}`, 'CATALOG_INVALID'); }
function validateCatalog(catalog: Catalog): void {
  if (!record(catalog) || !Array.isArray(catalog.hotels) || catalog.hotels.length === 0) fail('Catalog must contain hotels', 'CATALOG_INVALID');
  const hotelIds = new Set<string>();
  for (const hotel of catalog.hotels) {
    if (!record(hotel) || typeof hotel.id !== 'string' || !hotel.id || hotelIds.has(hotel.id) || typeof hotel.name !== 'string' || typeof hotel.city !== 'string') fail('Hotel entity is invalid', 'CATALOG_INVALID');
    hotelIds.add(hotel.id); assertFinite(hotel.stars, `Hotel ${hotel.id} stars`); assertFinite(hotel.distance_m, `Hotel ${hotel.id} distance_m`);
    if (!Array.isArray(hotel.rooms) || hotel.rooms.length === 0) fail(`Hotel ${hotel.id} must contain rooms`, 'CATALOG_INVALID');
    const roomIds = new Set<string>();
    for (const room of hotel.rooms) {
      if (!record(room) || typeof room.id !== 'string' || !room.id || roomIds.has(room.id) || typeof room.room_type !== 'string') fail(`Room in ${hotel.id} is invalid`, 'CATALOG_INVALID');
      roomIds.add(room.id); assertFinite(room.capacity, `Room ${room.id} capacity`, 1);
      if (!Number.isInteger(room.capacity) || !Array.isArray(room.rates) || room.rates.length === 0) fail(`Room ${room.id} is invalid`, 'CATALOG_INVALID');
      for (const rate of room.rates) {
        if (!record(rate)) fail(`Rate in ${room.id} is invalid`, 'CATALOG_INVALID'); assertFinite(rate.price, `Rate ${room.id} price`);
        if (!validDate(rate.valid_from) || !validDate(rate.valid_to) || rate.valid_from > rate.valid_to) fail(`Rate ${room.id} has invalid validity`, 'CATALOG_INVALID');
      }
    }
  }
}
function validateRequest(request: RecommendationRequest): void {
  if (!record(request) || !Number.isInteger(request.travelers) || request.travelers < 1 || !validDate(request.start_date) || !record(request.leg_nights)) fail('Request is invalid', 'REQUEST_INVALID');
  const cities = Object.keys(request.leg_nights);
  if (!cities.length) fail('Request must contain legs', 'REQUEST_INVALID');
  for (const nights of Object.values(request.leg_nights)) if (!Number.isInteger(nights) || nights < 1) fail('Leg nights must be positive integers', 'REQUEST_INVALID');
  if (request.result_count !== undefined && (!Number.isInteger(request.result_count) || request.result_count < 1 || request.result_count > 20)) fail('result_count must be an integer from 1 to 20', 'REQUEST_INVALID');
  if (request.diversity !== undefined && (typeof request.diversity !== 'number' || !Number.isFinite(request.diversity) || request.diversity < 0 || request.diversity > 1)) fail('diversity must be between 0 and 1', 'REQUEST_INVALID');
  if (request.objectives !== undefined) {
    if (!record(request.objectives)) fail('Invalid objectives', 'REQUEST_INVALID');
    for (const [name, weight] of Object.entries(request.objectives)) {
      if (!OBJECTIVES.includes(name as ObjectiveName) || typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) fail(`Invalid objective ${name}`, 'REQUEST_INVALID');
    }
  }
  const filters = request.filters;
  if (filters !== undefined) {
    if (!record(filters)) fail('Invalid filters', 'REQUEST_INVALID');
    for (const key of ['max_distance_m', 'min_distance_m', 'min_stars', 'max_stars', 'max_total_price', 'min_total_price', 'max_room_count', 'min_room_count'] as const) if (filters[key] !== undefined) assertFinite(filters[key], key);
    if (filters.min_distance_m !== undefined && filters.max_distance_m !== undefined && filters.min_distance_m > filters.max_distance_m) fail('Distance constraints have empty intersection', 'REQUEST_INVALID');
    if (filters.min_stars !== undefined && filters.max_stars !== undefined && filters.min_stars > filters.max_stars) fail('Star constraints have empty intersection', 'REQUEST_INVALID');
    if (filters.min_room_count !== undefined && filters.max_room_count !== undefined && filters.min_room_count > filters.max_room_count) fail('Room count constraints have empty intersection', 'REQUEST_INVALID');
    if (filters.min_total_price !== undefined && filters.max_total_price !== undefined && filters.min_total_price > filters.max_total_price) fail('Price constraints have empty intersection', 'REQUEST_INVALID');
    if (filters.cities !== undefined && (!Array.isArray(filters.cities) || filters.cities.some((city) => typeof city !== 'string'))) fail('Invalid filters', 'REQUEST_INVALID');
    if (filters.room_types !== undefined && (!Array.isArray(filters.room_types) || filters.room_types.some((type) => typeof type !== 'string'))) fail('Invalid filters', 'REQUEST_INVALID');
  }
}
function nightlyPrice(room: Room, start: string, nights: number): number | undefined {
  let total = 0;
  for (let i = 0; i < nights; i++) {
    const day = addDays(start, i); const valid = room.rates.filter((rate) => rate.valid_from <= day && day <= rate.valid_to);
    if (!valid.length) return undefined;
    total += Math.min(...valid.map((rate) => rate.price));
    if (!Number.isFinite(total)) fail('Nightly price is non-finite', 'CATALOG_INVALID');
  }
  return total;
}
function allocations(hotel: Hotel, travelers: number, start: string, nights: number, filters?: RecommenderFilters): Allocation[][] {
  const rooms = hotel.rooms.filter((room) => !filters?.room_types || filters.room_types.includes(room.room_type)).map((room) => ({ room, price: nightlyPrice(room, start, nights) })).filter((item): item is { room: Room; price: number } => item.price !== undefined);
  const found: Allocation[][] = [];
  const visit = (index: number, remaining: number, selected: Allocation[]): void => {
    if (remaining === 0) {
      const grouped = new Map<string, Allocation>();
      for (const entry of selected) {
        const existing = grouped.get(entry.room_id);
        if (existing) existing.quantity += 1;
        else grouped.set(entry.room_id, { ...entry });
      }
      found.push(Array.from(grouped.values())); return;
    }
    for (let i = index; i < rooms.length; i++) {
      const item = rooms[i]; if (item.room.capacity > remaining) continue;
      visit(i, remaining - item.room.capacity, [...selected, { room_id: item.room.id, room_type: item.room.room_type, quantity: 1, capacity: item.room.capacity, price_per_night: item.price / nights, total_price: item.price }]);
      if (found.length > 1000) fail('Allocation limit exceeded', 'BOUNDS_EXCEEDED');
    }
  };
  visit(0, travelers, []); return found;
}
type LegOption = { city: string; hotel: Hotel; allocation: Allocation[]; total: number };
function dominates(a: LegOption, b: LegOption): boolean { const noWorse = a.total <= b.total && a.hotel.distance_m <= b.hotel.distance_m && a.hotel.stars >= b.hotel.stars && a.allocation.length <= b.allocation.length; const better = a.total < b.total || a.hotel.distance_m < b.hotel.distance_m || a.hotel.stars > b.hotel.stars || a.allocation.length < b.allocation.length; return noWorse && better; }
function pareto(options: LegOption[]): LegOption[] { return options.filter((option, i) => !options.some((other, j) => i !== j && dominates(other, option))); }
function weights(request: RecommendationRequest): Record<ObjectiveName, number> {
  const raw = Object.fromEntries(OBJECTIVES.map((name) => [name, request.objectives?.[name] ?? ({ total_price: 0.4, distance_m: 0.3, stars: 0.2, room_count: 0.1 }[name])]));
  const sum = Object.values(raw).reduce((a, b) => a + b, 0);
  if (!Number.isFinite(sum) || sum <= 0) fail('Objective weights must have a finite positive sum', 'REQUEST_INVALID');
  const normalized = Object.fromEntries(OBJECTIVES.map((name) => [name, raw[name] / sum])) as Record<ObjectiveName, number>;
  if (Object.values(normalized).some((value) => !Number.isFinite(value))) fail('Objective weights normalize to non-finite values', 'REQUEST_INVALID');
  return normalized;
}
function distance(a: RecommendationOption, b: RecommendationOption): number { return a.hotel_ids.some((id) => !b.hotel_ids.includes(id)) || a.allocation.some((x) => !b.allocation.some((y) => y.room_type === x.room_type)) ? 1 : 0; }

function legId(option: LegOption): string { return `${option.hotel.id}:${option.allocation.map((room) => room.room_id).join('+')}`; }
function roomCount(option: LegOption): number { return option.allocation.reduce((sum, room) => sum + room.quantity, 0); }
function feasibleWithOtherLegs(option: LegOption, legIndex: number, candidatesByLeg: readonly (readonly LegOption[])[], filters?: RecommenderFilters): boolean {
  const other = candidatesByLeg.filter((_, index) => index !== legIndex).flat();
  const minOtherPrice = candidatesByLeg.reduce((sum, candidates, index) => index === legIndex ? sum : sum + Math.min(...candidates.map((candidate) => candidate.total)), 0);
  const maxOtherPrice = candidatesByLeg.reduce((sum, candidates, index) => index === legIndex ? sum : sum + Math.max(...candidates.map((candidate) => candidate.total)), 0);
  const minOtherRooms = candidatesByLeg.reduce((sum, candidates, index) => index === legIndex ? sum : sum + Math.min(...candidates.map(roomCount)), 0);
  const maxOtherRooms = candidatesByLeg.reduce((sum, candidates, index) => index === legIndex ? sum : sum + Math.max(...candidates.map(roomCount)), 0);
  if (!other.length) return (filters?.min_total_price === undefined || option.total >= filters.min_total_price) &&
    (filters?.max_total_price === undefined || option.total <= filters.max_total_price) &&
    (filters?.min_room_count === undefined || roomCount(option) >= filters.min_room_count) &&
    (filters?.max_room_count === undefined || roomCount(option) <= filters.max_room_count);
  return (filters?.min_total_price === undefined || option.total + maxOtherPrice >= filters.min_total_price) &&
    (filters?.max_total_price === undefined || option.total + minOtherPrice <= filters.max_total_price) &&
    (filters?.min_room_count === undefined || roomCount(option) + maxOtherRooms >= filters.min_room_count) &&
    (filters?.max_room_count === undefined || roomCount(option) + minOtherRooms <= filters.max_room_count);
}

export function recommend(catalog: Catalog, request: RecommendationRequest): RecommendationResult {
  validateCatalog(catalog); validateRequest(request); const weightsByObjective = weights(request); const hotelsByCity = new Map<string, Hotel[]>();
  for (const hotel of catalog.hotels) { if (request.filters?.cities && !request.filters.cities.includes(hotel.city)) continue; if (request.filters?.max_distance_m !== undefined && hotel.distance_m > request.filters.max_distance_m) continue; if (request.filters?.min_distance_m !== undefined && hotel.distance_m < request.filters.min_distance_m) continue; if (request.filters?.min_stars !== undefined && hotel.stars < request.filters.min_stars) continue; if (request.filters?.max_stars !== undefined && hotel.stars > request.filters.max_stars) continue; hotelsByCity.set(hotel.city, [...(hotelsByCity.get(hotel.city) ?? []), hotel]); }
  const legs = Object.entries(request.leg_nights); const candidateStreams: LegOption[][] = [];
  for (let legIndex = 0, elapsed = 0; legIndex < legs.length; legIndex++) {
    const [city, nights] = legs[legIndex]; const candidates: LegOption[] = [];
    for (const hotel of hotelsByCity.get(city) ?? []) {
      for (const allocation of allocations(hotel, request.travelers, addDays(request.start_date, elapsed), nights, request.filters)) {
        const total = allocation.reduce((sum, room) => sum + room.total_price * room.quantity, 0);
        if (!Number.isFinite(total)) fail(`Non-finite candidate price for ${city}`, 'RECOMMENDER_INVALID');
        candidates.push({ city, hotel, allocation, total });
      }
    }
    elapsed += nights; candidateStreams.push(candidates);
  }
  const perLeg: LegOption[][] = candidateStreams.map((candidates, legIndex) => {
    const feasible = candidates.filter((candidate) => feasibleWithOtherLegs(candidate, legIndex, candidateStreams, request.filters));
    const front = (request.filters?.min_total_price !== undefined || request.filters?.max_total_price !== undefined || request.filters?.min_room_count !== undefined || request.filters?.max_room_count !== undefined
      ? feasible.sort((a, b) => a.total - b.total || a.hotel.distance_m - b.hotel.distance_m || b.hotel.stars - a.hotel.stars || a.allocation.length - b.allocation.length || legId(a).localeCompare(legId(b)))
      : pareto(feasible).sort((a, b) => a.total - b.total || a.hotel.distance_m - b.hotel.distance_m || b.hotel.stars - a.hotel.stars || a.allocation.length - b.allocation.length || legId(a).localeCompare(legId(b)))).slice(0, MAX_CANDIDATES_PER_LEG);
    if (!front.length) fail(`No exact-capacity candidate for ${candidates[0]?.city ?? legs[legIndex][0]}`, 'NO_CANDIDATES');
    return front;
  });
  let bundles: RecommendationOption[] = [{ id: '', hotel_ids: [], hotel_names: [], cities: [], allocation: [], total_price: 0, room_count: 0, distance_m: 0, stars: 0, score: 0, explanation_facts: [] }];
  for (const legOptions of perLeg) {
    if (bundles.length > Math.floor(MAX_BUNDLE_EXPANSIONS / legOptions.length)) fail('Bundle expansion limit exceeded', 'BOUNDS_EXCEEDED');
    const next: RecommendationOption[] = [];
    for (const bundle of bundles) for (const leg of legOptions) {
      const total_price = bundle.total_price + leg.total;
      const distance_m = bundle.distance_m + leg.hotel.distance_m;
      const stars = bundle.stars + leg.hotel.stars;
      if (![total_price, distance_m, stars].every(Number.isFinite)) fail('Bundle metric is non-finite', 'RECOMMENDER_INVALID');
      next.push({ id: bundle.id ? `${bundle.id}|${legId(leg)}` : legId(leg), hotel_ids: [...bundle.hotel_ids, leg.hotel.id], hotel_names: [...bundle.hotel_names, leg.hotel.name], cities: [...bundle.cities, leg.city], allocation: [...bundle.allocation, ...leg.allocation], total_price, room_count: bundle.room_count + leg.allocation.reduce((sum, room) => sum + room.quantity, 0), distance_m, stars, score: 0, explanation_facts: [] });
    }
    bundles = next;
  }
  if (request.filters) bundles = bundles.filter((bundle) =>
    (request.filters?.min_total_price === undefined || bundle.total_price >= request.filters.min_total_price) &&
    (request.filters?.max_total_price === undefined || bundle.total_price <= request.filters.max_total_price) &&
    (request.filters?.min_room_count === undefined || bundle.room_count >= request.filters.min_room_count) &&
    (request.filters?.max_room_count === undefined || bundle.room_count <= request.filters.max_room_count));
  if (!bundles.length) fail('No bundle satisfies hard constraints', 'NO_CANDIDATES');
  const ranges: Record<ObjectiveName, { min: number; max: number }> = Object.fromEntries(OBJECTIVES.map((objective) => { const values = bundles.map((b) => b[objective]); if (values.some((value) => !Number.isFinite(value))) fail(`Non-finite ${objective} value`, 'RECOMMENDER_INVALID'); return [objective, { min: Math.min(...values), max: Math.max(...values) }]; })) as Record<ObjectiveName, { min: number; max: number }>;
  for (const bundle of bundles) {
    bundle.score = OBJECTIVES.reduce((score, objective) => {
      const range = ranges[objective]; const direction = request.directions?.[objective] ?? (objective === 'stars' ? 'max' : 'min'); const raw = range.max === range.min ? 1 : (direction === 'max' ? (bundle[objective] - range.min) / (range.max - range.min) : (range.max - bundle[objective]) / (range.max - range.min));
      if (!Number.isFinite(raw)) fail(`Non-finite normalized ${objective} score`, 'RECOMMENDER_INVALID');
      const normalized = Math.min(1, Math.max(0, raw)); const contribution = weightsByObjective[objective] * normalized; const nextScore = score + contribution;
      if (!Number.isFinite(contribution) || !Number.isFinite(nextScore)) fail('Non-finite recommendation score', 'RECOMMENDER_INVALID');
      return nextScore;
    }, 0);
    bundle.score = Math.min(1, Math.max(0, bundle.score));
    if (!Number.isFinite(bundle.score)) fail('Non-finite recommendation score', 'RECOMMENDER_INVALID');
  }
  bundles.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)); const selected: RecommendationOption[] = []; const limit = request.result_count ?? 3; const diversity = request.diversity ?? 0.3;
  while (selected.length < limit && bundles.length) { const choice = bundles.map((candidate) => ({ candidate, mmr: candidate.score - (selected.length ? (1 - diversity) * Math.max(...selected.map((chosen) => distance(candidate, chosen))) : 0) })).sort((a, b) => b.mmr - a.mmr || a.candidate.id.localeCompare(b.candidate.id))[0].candidate; bundles = bundles.filter((candidate) => candidate !== choice); selected.push(choice); }
  for (const option of selected) { option.explanation_facts = OBJECTIVES.filter((objective) => weightsByObjective[objective] > 0 && option[objective] === (objective === 'stars' ? ranges[objective].max : ranges[objective].min)).map((objective) => ({ kind: 'objective_winner', objective, value: option[objective] })); }
  return { options: selected };
}
