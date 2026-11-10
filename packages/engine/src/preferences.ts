import type { ObjectiveName, RecommenderFilters } from './recommender.js';

export type PreferenceDirection = 'min' | 'max';
export type PreferenceConstraints = RecommenderFilters;
export type PreferenceWeights = Record<ObjectiveName, number>;
export type PreferenceState = { weights: PreferenceWeights; constraints: PreferenceConstraints };
export type PreferenceDelta = { attribute: ObjectiveName; direction: PreferenceDirection; strength: number; hard_value?: number };

const OBJECTIVES: readonly ObjectiveName[] = ['total_price', 'distance_m', 'stars', 'room_count'];
const DEFAULT_WEIGHTS: PreferenceWeights = { total_price: 0.4, distance_m: 0.3, stars: 0.2, room_count: 0.1 };
const CONSTRAINT_KEY: Record<ObjectiveName, { min: keyof PreferenceConstraints; max: keyof PreferenceConstraints }> = {
  total_price: { min: 'min_total_price', max: 'max_total_price' },
  distance_m: { min: 'min_distance_m', max: 'max_distance_m' },
  stars: { min: 'min_stars', max: 'max_stars' },
  room_count: { min: 'min_room_count', max: 'max_room_count' },
};

export class PreferenceError extends Error {
  readonly code: 'PREFERENCE_INVALID' | 'PREFERENCE_ALL_ZERO';
  constructor(message: string, code: 'PREFERENCE_INVALID' | 'PREFERENCE_ALL_ZERO' = 'PREFERENCE_INVALID') { super(message); this.name = 'PreferenceError'; this.code = code; }
}
function fail(message: string, code?: PreferenceError['code']): never { throw new PreferenceError(message, code); }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }

export function normalizePreferenceState(state?: Partial<PreferenceState>): PreferenceState {
  const raw = { ...DEFAULT_WEIGHTS, ...(state?.weights ?? {}) } as PreferenceWeights;
  if (Object.keys(raw).some((key) => !OBJECTIVES.includes(key as ObjectiveName) || !finite(raw[key as ObjectiveName]) || raw[key as ObjectiveName] < 0)) fail('Preference weights must be finite and non-negative');
  const sum = OBJECTIVES.reduce((total, objective) => total + raw[objective], 0);
  if (!finite(sum) || sum <= 0) fail('Preference weights must have a positive sum', 'PREFERENCE_ALL_ZERO');
  const weights = Object.fromEntries(OBJECTIVES.map((objective) => [objective, raw[objective] / sum])) as PreferenceWeights;
  const constraints = { ...(state?.constraints ?? {}) } as PreferenceConstraints;
  for (const [key, value] of Object.entries(constraints)) if (!['cities', 'room_types'].includes(key) && !finite(value)) fail(`Constraint ${key} must be finite`);
  return { weights, constraints };
}

export function applyPreferenceDelta(state: PreferenceState, delta: PreferenceDelta): PreferenceState {
  const current = normalizePreferenceState(state);
  if (!OBJECTIVES.includes(delta.attribute) || (delta.direction !== 'min' && delta.direction !== 'max') || !finite(delta.strength) || delta.strength < 0 || delta.strength > 1) fail('Preference delta is invalid');
  const weights = { ...current.weights };
  // Strength is an additive preference increment; normalization keeps the vector bounded.
  weights[delta.attribute] += delta.strength;
  const constraints = { ...current.constraints };
  if (delta.hard_value !== undefined) {
    if (!finite(delta.hard_value) || delta.hard_value < 0) fail('Hard preference value is invalid');
    const key = CONSTRAINT_KEY[delta.attribute][delta.direction === 'min' ? 'max' : 'min'];
    const existing = constraints[key] as number | undefined;
    const bounds = CONSTRAINT_KEY[delta.attribute];
    (constraints as Record<string, unknown>)[key] = existing === undefined ? delta.hard_value : (key === bounds.max ? Math.min(existing, delta.hard_value) : Math.max(existing, delta.hard_value));
    const low = constraints[bounds.min] as number | undefined;
    const high = constraints[bounds.max] as number | undefined;
    if (low !== undefined && high !== undefined && low > high) fail('Hard preference constraints have empty intersection');
  }
  return normalizePreferenceState({ weights, constraints });
}

export { DEFAULT_WEIGHTS };
