import { describe, expect, it } from 'vitest';
import { recommend, type Catalog, type RecommendationRequest } from '../src/recommender.js';
import { selectFollowUp } from '../src/follow-up.js';

const catalog: Catalog = { hotels: [
  { id: 'near', name: 'Near', city: 'Makkah', stars: 4, distance_m: 100, rooms: [{ id: 'near-room', room_type: 'double', capacity: 2, rates: [{ price: 100, valid_from: '2099-01-01', valid_to: '2099-01-31' }] }] },
  { id: 'far', name: 'Far', city: 'Makkah', stars: 4, distance_m: 1000, rooms: [{ id: 'far-room', room_type: 'double', capacity: 2, rates: [{ price: 80, valid_from: '2099-01-01', valid_to: '2099-01-31' }] }] },
] };
const request: RecommendationRequest = { travelers: 2, start_date: '2099-01-10', leg_nights: { Makkah: 1 }, result_count: 3 };

describe('bounded follow-up selection', () => {
  it('selects the largest unexplored top-three impact deterministically', () => {
    const result = selectFollowUp({ catalog, request, explored_dimensions: ['total_price'] });
    expect(result?.attribute).toBe('distance_m');
    expect(result?.baseline_ids).toHaveLength(2);
    expect(result?.counterfactual_ids).toHaveLength(2);
  });

  it('suppresses explored dimensions and returns null when no dimension changes the top three', () => {
    const same: Catalog = { hotels: [{ ...catalog.hotels[0], distance_m: 100 }, { ...catalog.hotels[1], distance_m: 100 }] };
    expect(selectFollowUp({ catalog: same, request, explored_dimensions: ['total_price', 'distance_m', 'stars', 'room_count'] })).toBeNull();
  });

  it('fails closed when the baseline recommender rejects input', () => {
    expect(() => selectFollowUp({ catalog, request: { ...request, travelers: 0 } })).toThrow();
  });

  it('intersects caller filters with preference constraints for the baseline', () => {
    expect(() => selectFollowUp({
      catalog,
      request: { ...request, filters: { min_stars: 5 } },
      preference_state: {
        weights: { total_price: 1, distance_m: 0, stars: 0, room_count: 0 },
        constraints: { max_stars: 4 },
      },
      explored_dimensions: ['distance_m', 'stars', 'room_count'],
    })).toThrow();
  });

  it('does not report exact zero impact when only a non-top-three tail changes', () => {
    const three: Catalog = { hotels: Array.from({ length: 4 }, (_, index) => ({
      id: `hotel-${index}`,
      name: `Hotel ${index}`,
      city: 'Makkah',
      stars: 5,
      distance_m: 100,
      rooms: [{ id: `room-${index}`, room_type: 'double', capacity: 2, rates: [{ price: 100 + index, valid_from: '2099-01-01', valid_to: '2099-01-31' }] }],
    })) };
    expect(selectFollowUp({ catalog: three, request, explored_dimensions: ['total_price'] })).toBeNull();
  });
});
