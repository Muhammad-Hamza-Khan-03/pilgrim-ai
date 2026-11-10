import { recommend, type Catalog, type ObjectiveName, type RecommendationRequest, type RecommendationOption } from './recommender.js';
import { applyPreferenceDelta, normalizePreferenceState, type PreferenceState } from './preferences.js';

export type FollowUpRequest = { catalog: Catalog; request: RecommendationRequest; preference_state?: PreferenceState; explored_dimensions?: readonly ObjectiveName[] };
export type FollowUpChoice = { attribute: ObjectiveName; impact: number; baseline_ids: string[]; counterfactual_ids: string[] };
const OBJECTIVES: readonly ObjectiveName[] = ['total_price', 'distance_m', 'stars', 'room_count'];
const TOP = 20;
const TOP_THREE = 3;

function options(request: RecommendationRequest, catalog: Catalog, state: PreferenceState): RecommendationOption[] {
  return recommend(catalog, { ...request, result_count: TOP, objectives: state.weights, directions: state.directions, filters: intersectFilters(request.filters, state.constraints) }).options;
}
function intersectFilters(caller: RecommendationRequest['filters'], preferences: PreferenceState['constraints']): RecommendationRequest['filters'] {
  const result = { ...(caller ?? {}) } as Record<string, unknown>;
  for (const key of ['cities', 'room_types'] as const) {
    const left = caller?.[key]; const right = preferences[key];
    if (left !== undefined && right !== undefined) result[key] = left.filter((value) => right.includes(value));
    else if (right !== undefined) result[key] = [...right];
  }
  for (const objective of ['total_price', 'distance_m', 'stars', 'room_count'] as const) {
    const min = `min_${objective}` as keyof PreferenceState['constraints']; const max = `max_${objective}` as keyof PreferenceState['constraints'];
    if (preferences[min] !== undefined) result[min] = Math.max((caller?.[min] as number | undefined) ?? -Infinity, preferences[min] as number);
    if (preferences[max] !== undefined) result[max] = Math.min((caller?.[max] as number | undefined) ?? Infinity, preferences[max] as number);
  }
  return result as RecommendationRequest['filters'];
}
function spread(items: RecommendationOption[], attribute: ObjectiveName): number {
  if (!items.length) return 0;
  const values = items.slice(0, TOP_THREE).map((item) => item[attribute]);
  return Math.max(...values) - Math.min(...values);
}
function impact(base: RecommendationOption[], counterfactual: RecommendationOption[], attribute: ObjectiveName): number {
  const left = base.slice(0, TOP_THREE);
  const right = counterfactual.slice(0, TOP_THREE);
  const positional = left.reduce((sum, option, index) => sum + (right[index]?.id === option.id ? 0 : 1), 0) / TOP_THREE;
  const leftIds = new Set(left.map((option) => option.id));
  const rightIds = new Set(right.map((option) => option.id));
  const identity = (left.filter((option) => !rightIds.has(option.id)).length + right.filter((option) => !leftIds.has(option.id)).length) / TOP_THREE;
  const baselineSpread = spread(base, attribute);
  const spreadDelta = Math.abs(spread(counterfactual, attribute) - baselineSpread);
  const value = positional + identity + Math.min(1, spreadDelta);
  return Number.isFinite(value) ? value : 0;
}

export function selectFollowUp(input: FollowUpRequest): FollowUpChoice | null {
  const state = normalizePreferenceState(input.preference_state);
  const explored = new Set(input.explored_dimensions ?? []);
  const base = options(input.request, input.catalog, state);
  const candidates = OBJECTIVES.filter((attribute) => !explored.has(attribute)).map((attribute) => {
    const counterfactual = options(input.request, input.catalog, applyPreferenceDelta(state, { attribute, direction: attribute === 'stars' ? 'max' : 'min', strength: 1 }));
    return { attribute, counterfactual, impact: impact(base, counterfactual, attribute) };
  }).filter((candidate) => candidate.impact > 0);
  candidates.sort((a, b) => b.impact - a.impact || OBJECTIVES.indexOf(a.attribute) - OBJECTIVES.indexOf(b.attribute));
  const winner = candidates[0];
  if (!winner) return null;
  return { attribute: winner.attribute, impact: winner.impact, baseline_ids: base.slice(0, TOP_THREE).map((option) => option.id), counterfactual_ids: winner.counterfactual.slice(0, TOP_THREE).map((option) => option.id) };
}
