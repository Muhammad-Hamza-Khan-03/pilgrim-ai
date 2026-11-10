import { describe, expect, it } from 'vitest';
import {
  PreferenceError,
  applyPreferenceDelta,
  normalizePreferenceState,
  type PreferenceState,
} from '../src/preferences.js';

describe('preference deltas', () => {
  it('applies direction-aware deltas and normalizes weights', () => {
    const state: PreferenceState = { weights: { total_price: 0.4, distance_m: 0.3, stars: 0.2, room_count: 0.1 }, constraints: {} };
    const next = applyPreferenceDelta(state, { attribute: 'distance_m', direction: 'min', strength: 0.5 });
    expect(next.weights.distance_m).toBeGreaterThan(state.weights.distance_m);
    expect(Object.values(next.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it('intersects inclusive hard constraints rather than weakening them', () => {
    const state: PreferenceState = { weights: { total_price: 1, distance_m: 0, stars: 0, room_count: 0 }, constraints: { max_total_price: 1000 } };
    const next = applyPreferenceDelta(state, { attribute: 'total_price', direction: 'min', strength: 0.5, hard_value: 800 });
    expect(next.constraints.max_total_price).toBe(800);
    expect(applyPreferenceDelta(next, { attribute: 'total_price', direction: 'min', strength: 0.5, hard_value: 900 }).constraints.max_total_price).toBe(800);
  });

  it('fails closed for invalid strength and all-zero weights', () => {
    expect(() => applyPreferenceDelta({ weights: { total_price: 0, distance_m: 0, stars: 0, room_count: 0 }, constraints: {} }, { attribute: 'distance_m', direction: 'min', strength: -0.1 })).toThrow(PreferenceError);
    expect(() => normalizePreferenceState({ weights: { total_price: 0, distance_m: 0, stars: 0, room_count: 0 }, constraints: {} })).toThrow(PreferenceError);
    expect(() => applyPreferenceDelta({ weights: { total_price: 1, distance_m: 0, stars: 0, room_count: 0 }, constraints: {} }, { attribute: 'distance_m', direction: 'min', strength: Number.NaN })).toThrow(PreferenceError);
  });

  it('rejects contradictory and malformed existing constraints with PREFERENCE_INVALID', () => {
    expect(() => normalizePreferenceState({ constraints: { min_total_price: 500, max_total_price: 400 } })).toThrowError(expect.objectContaining({ code: 'PREFERENCE_INVALID' }));
    expect(() => normalizePreferenceState({ constraints: { min_stars: Number.NaN } })).toThrowError(expect.objectContaining({ code: 'PREFERENCE_INVALID' }));
    expect(() => normalizePreferenceState({ constraints: { max_room_count: '2' as unknown as number } })).toThrowError(expect.objectContaining({ code: 'PREFERENCE_INVALID' }));
  });

  it('preserves direction and changes ranking behavior for min versus max', () => {
    const state: PreferenceState = { weights: { total_price: 0.4, distance_m: 0.3, stars: 0.2, room_count: 0.1 }, constraints: {} };
    const min = applyPreferenceDelta(state, { attribute: 'total_price', direction: 'min', strength: 0.5 });
    const max = applyPreferenceDelta(state, { attribute: 'total_price', direction: 'max', strength: 0.5 });
    expect(min.directions?.total_price).toBe('min');
    expect(max.directions?.total_price).toBe('max');
    expect(min.directions).not.toEqual(max.directions);
    expect(min.weights).toEqual(max.weights);
  });

  it('defines repeated deltas as last-direction-wins with intersected hard bounds', () => {
    const state: PreferenceState = { weights: { total_price: 1, distance_m: 0, stars: 0, room_count: 0 }, constraints: {} };
    const bounded = applyPreferenceDelta(state, { attribute: 'total_price', direction: 'min', strength: 0.1, hard_value: 100 });
    const changed = applyPreferenceDelta(bounded, { attribute: 'total_price', direction: 'max', strength: 0.1, hard_value: 80 });
    expect(changed.directions?.total_price).toBe('max');
    expect(changed.constraints).toMatchObject({ min_total_price: 80, max_total_price: 100 });
  });
});
