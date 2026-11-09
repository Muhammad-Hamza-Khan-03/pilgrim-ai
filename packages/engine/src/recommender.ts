export type Rate = { price: number; valid_from: string; valid_to: string };
export type Room = { id: string; room_type: string; capacity: number; rates: readonly Rate[] };
export type Hotel = { id: string; name: string; city: string; stars: number; distance_m: number; rooms: readonly Room[] };
export type Catalog = { hotels: readonly Hotel[] };
export type RecommenderFilters = { cities?: readonly string[]; max_distance_m?: number; min_stars?: number; room_types?: readonly string[] };
export type ObjectiveName = 'total_price' | 'distance_m' | 'stars' | 'room_count';
export type RecommendationRequest = {
  travelers: number;
  start_date: string;
  leg_nights: Record<string, number>;
  filters?: RecommenderFilters;
  objectives?: Partial<Record<ObjectiveName, number>>;
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
  if (request.objectives) for (const [name, weight] of Object.entries(request.objectives)) { if (!OBJECTIVES.includes(name as ObjectiveName) || typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) fail(`Invalid objective ${name}`, 'REQUEST_INVALID'); }
  const filters = request.filters;
  if (filters && (!record(filters) || (filters.max_distance_m !== undefined && (typeof filters.max_distance_m !== 'number' || filters.max_distance_m < 0)) || (filters.min_stars !== undefined && (typeof filters.min_stars !== 'number' || filters.min_stars < 0)) || (filters.cities !== undefined && (!Array.isArray(filters.cities) || filters.cities.some((city) => typeof city !== 'string'))) || (filters.room_types !== undefined && (!Array.isArray(filters.room_types) || filters.room_types.some((type) => typeof type !== 'string'))))) fail('Invalid filters', 'REQUEST_INVALID');
}
function nightlyPrice(room: Room, start: string, nights: number): number | undefined {
  let total = 0;
  for (let i = 0; i < nights; i++) {
    const day = addDays(start, i); const valid = room.rates.filter((rate) => rate.valid_from <= day && day <= rate.valid_to);
    if (!valid.length) return undefined;
    total += Math.min(...valid.map((rate) => rate.price));
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
function weights(request: RecommendationRequest): Record<ObjectiveName, number> { const raw = Object.fromEntries(OBJECTIVES.map((name) => [name, request.objectives?.[name] ?? ({ total_price: 0.4, distance_m: 0.3, stars: 0.2, room_count: 0.1 }[name])])); const sum = Object.values(raw).reduce((a, b) => a + b, 0); if (sum <= 0) fail('Objective weights must have a positive sum', 'REQUEST_INVALID'); return Object.fromEntries(OBJECTIVES.map((name) => [name, raw[name] / sum])) as Record<ObjectiveName, number>; }
function distance(a: RecommendationOption, b: RecommendationOption): number { return a.hotel_ids.some((id) => !b.hotel_ids.includes(id)) || a.allocation.some((x) => !b.allocation.some((y) => y.room_type === x.room_type)) ? 1 : 0; }

export function recommend(catalog: Catalog, request: RecommendationRequest): RecommendationResult {
  validateCatalog(catalog); validateRequest(request); const weightsByObjective = weights(request); const hotelsByCity = new Map<string, Hotel[]>();
  for (const hotel of catalog.hotels) { if (request.filters?.cities && !request.filters.cities.includes(hotel.city)) continue; if (request.filters?.max_distance_m !== undefined && hotel.distance_m > request.filters.max_distance_m) continue; if (request.filters?.min_stars !== undefined && hotel.stars < request.filters.min_stars) continue; hotelsByCity.set(hotel.city, [...(hotelsByCity.get(hotel.city) ?? []), hotel]); }
  const legs = Object.entries(request.leg_nights); const perLeg: LegOption[][] = [];
  for (let legIndex = 0, elapsed = 0; legIndex < legs.length; legIndex++) { const [city, nights] = legs[legIndex]; const candidates: LegOption[] = []; for (const hotel of hotelsByCity.get(city) ?? []) for (const allocation of allocations(hotel, request.travelers, addDays(request.start_date, elapsed), nights, request.filters)) candidates.push({ city, hotel, allocation, total: allocation.reduce((sum, room) => sum + room.total_price * room.quantity, 0) }); elapsed += nights; const front = pareto(candidates); if (!front.length) fail(`No exact-capacity candidate for ${city}`, 'NO_CANDIDATES'); perLeg.push(front); }
  let bundles: RecommendationOption[] = [{ id: '', hotel_ids: [], hotel_names: [], cities: [], allocation: [], total_price: 0, room_count: 0, distance_m: 0, stars: 0, score: 0, explanation_facts: [] }];
  for (const legOptions of perLeg) { const next: RecommendationOption[] = []; for (const bundle of bundles) for (const leg of legOptions) next.push({ id: bundle.id ? `${bundle.id}|${leg.hotel.id}:${leg.allocation.map((r) => r.room_id).join('+')}` : `${leg.hotel.id}:${leg.allocation.map((r) => r.room_id).join('+')}`, hotel_ids: [...bundle.hotel_ids, leg.hotel.id], hotel_names: [...bundle.hotel_names, leg.hotel.name], cities: [...bundle.cities, leg.city], allocation: [...bundle.allocation, ...leg.allocation], total_price: bundle.total_price + leg.total, room_count: bundle.room_count + leg.allocation.reduce((sum, room) => sum + room.quantity, 0), distance_m: bundle.distance_m + leg.hotel.distance_m, stars: bundle.stars + leg.hotel.stars, score: 0, explanation_facts: [] }); bundles = next; }
  const ranges: Record<ObjectiveName, { min: number; max: number }> = Object.fromEntries(OBJECTIVES.map((objective) => { const values = bundles.map((b) => b[objective]); return [objective, { min: Math.min(...values), max: Math.max(...values) }]; })) as Record<ObjectiveName, { min: number; max: number }>;
  for (const bundle of bundles) { bundle.score = OBJECTIVES.reduce((score, objective) => { const range = ranges[objective]; const normalized = range.max === range.min ? 1 : (objective === 'stars' ? (bundle[objective] - range.min) / (range.max - range.min) : (range.max - bundle[objective]) / (range.max - range.min)); return score + weightsByObjective[objective] * normalized; }, 0); }
  bundles.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)); const selected: RecommendationOption[] = []; const limit = request.result_count ?? 3; const diversity = request.diversity ?? 0.3;
  while (selected.length < limit && bundles.length) { const choice = bundles.map((candidate) => ({ candidate, mmr: candidate.score - (selected.length ? (1 - diversity) * Math.max(...selected.map((chosen) => distance(candidate, chosen))) : 0) })).sort((a, b) => b.mmr - a.mmr || a.candidate.id.localeCompare(b.candidate.id))[0].candidate; bundles = bundles.filter((candidate) => candidate !== choice); selected.push(choice); }
  for (const option of selected) { option.explanation_facts = OBJECTIVES.filter((objective) => weightsByObjective[objective] > 0 && option[objective] === (objective === 'stars' ? ranges[objective].max : ranges[objective].min)).map((objective) => ({ kind: 'objective_winner', objective, value: option[objective] })); }
  return { options: selected };
}
