import { recommend, type Catalog, type ObjectiveName, type RecommendationRequest, type RecommendationOption } from './recommender.js';
import { applyPreferenceDelta, normalizePreferenceState, type PreferenceState } from './preferences.js';

export type FollowUpRequest = { catalog: Catalog; request: RecommendationRequest; preference_state?: PreferenceState; explored_dimensions?: readonly ObjectiveName[] };
export type FollowUpChoice = { attribute: ObjectiveName; impact: number; baseline_ids: string[]; counterfactual_ids: string[] };
const OBJECTIVES: readonly ObjectiveName[] = ['total_price', 'distance_m', 'stars', 'room_count'];
const TOP = 20;
const TOP_THREE = 3;

function options(request: RecommendationRequest, catalog: Catalog, state: PreferenceState): RecommendationOption[] {
  return recommend(catalog, { ...request, result_count: TOP, objectives: state.weights, filters: state.constraints }).options;
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
  const identity = right.reduce((sum, option) => sum + (leftIds.has(option.id) ? 0 : 1), 0) / TOP_THREE;
  const baselineSpread = spread(base, attribute);
  const spreadDelta = baselineSpread / Math.max(1, ...base.slice(0, TOP_THREE).map((item) => Math.abs(item[attribute])));
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
