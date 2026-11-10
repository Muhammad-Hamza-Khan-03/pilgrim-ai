import type { ObjectiveName, RecommenderFilters } from './recommender.js';

export type PreferenceDirection = 'min' | 'max';
export type PreferenceConstraints = RecommenderFilters;
export type PreferenceWeights = Record<ObjectiveName, number>;
export type PreferenceDirections = Partial<Record<ObjectiveName, PreferenceDirection>>;
export type PreferenceState = { weights: PreferenceWeights; constraints: PreferenceConstraints; directions?: PreferenceDirections };
export type PreferenceDelta = { attribute: ObjectiveName; direction: PreferenceDirection; strength: number; hard_value?: number };

const OBJECTIVES: readonly ObjectiveName[] = ['total_price', 'distance_m', 'stars', 'room_count'];
const DEFAULT_WEIGHTS: PreferenceWeights = { total_price: 0.4, distance_m: 0.3, stars: 0.2, room_count: 0.1 };
const DEFAULT_DIRECTIONS: Record<ObjectiveName, PreferenceDirection> = { total_price: 'min', distance_m: 'min', stars: 'max', room_count: 'min' };
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
  const constraintKeys = new Set(Object.values(CONSTRAINT_KEY).flatMap((keys) => [keys.min, keys.max]));
  for (const [key, value] of Object.entries(constraints)) {
    if (key === 'cities' || key === 'room_types') {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) fail(`Constraint ${key} must be a string array`);
    } else if (!constraintKeys.has(key as keyof PreferenceConstraints) || !finite(value)) fail(`Constraint ${key} must be finite`);
  }
  for (const bounds of Object.values(CONSTRAINT_KEY)) {
    const low = constraints[bounds.min] as number | undefined;
    const high = constraints[bounds.max] as number | undefined;
    if (low !== undefined && high !== undefined && low > high) fail(`${bounds.min} must not exceed ${bounds.max}`);
  }
  const directions = { ...DEFAULT_DIRECTIONS, ...(state?.directions ?? {}) } as Record<ObjectiveName, PreferenceDirection>;
  if (Object.keys(directions).some((key) => !OBJECTIVES.includes(key as ObjectiveName) || (directions[key as ObjectiveName] !== 'min' && directions[key as ObjectiveName] !== 'max'))) fail('Preference directions are invalid');
  return { weights, constraints, directions };
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
  return normalizePreferenceState({ weights, constraints, directions: { ...current.directions, [delta.attribute]: delta.direction } });
}

export { DEFAULT_WEIGHTS };
