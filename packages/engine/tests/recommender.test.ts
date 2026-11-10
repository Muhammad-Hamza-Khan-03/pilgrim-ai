import { describe, expect, it } from 'vitest';
import { MAX_BUNDLE_EXPANSIONS, MAX_CANDIDATES_PER_LEG, recommend, RecommenderError, type Catalog, type RecommendationRequest } from '../src/recommender.js';

const catalog: Catalog = {
  hotels: [
    { id: 'makkah-near', name: 'Near Makkah', city: 'Makkah', stars: 5, distance_m: 200, rooms: [
      { id: 'double', room_type: 'double', capacity: 2, rates: [{ price: 100, valid_from: '2099-01-01', valid_to: '2099-01-31' }] },
      { id: 'triple', room_type: 'triple', capacity: 3, rates: [{ price: 130, valid_from: '2099-01-01', valid_to: '2099-01-31' }] },
    ] },
    { id: 'makkah-far', name: 'Far Makkah', city: 'Makkah', stars: 4, distance_m: 800, rooms: [
      { id: 'five', room_type: 'five', capacity: 5, rates: [{ price: 50, valid_from: '2099-01-01', valid_to: '2099-01-31' }] },
    ] },
  ],
};

const request: RecommendationRequest = {
  travelers: 5,
  start_date: '2099-01-10',
  leg_nights: { Makkah: 2 },
  result_count: 2,
};

describe('bounded in-memory recommender', () => {
  it('prices exact room allocation per night and uses inclusive rate validity', () => {
    const result = recommend({ ...catalog, hotels: [{ ...catalog.hotels[0], rooms: [{ ...catalog.hotels[0].rooms[0], rates: [{ price: 10, valid_from: '2099-01-10', valid_to: '2099-01-11' }] }, { ...catalog.hotels[0].rooms[1], rates: [{ price: 20, valid_from: '2099-01-10', valid_to: '2099-01-11' }] }] }] }, request);
    expect(result.options.some((option) => option.total_price === 60 && option.room_count === 2 && option.allocation.every((room) => room.quantity === 1))).toBe(true);
  });

  it('filters candidates, prunes dominated bundles, and ranks deterministically', () => {
    const result = recommend(catalog, { ...request, filters: { max_distance_m: 300 } });
    expect(result.options).toHaveLength(1);
    expect(result.options[0].hotel_ids).toEqual(['makkah-near']);
    expect(result.options[0].explanation_facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'objective_winner', objective: 'distance_m' }),
    ]));
  });

  it('allocates exact capacity and fails closed for invalid input or uncovered nights', () => {
    expect(() => recommend(catalog, { ...request, travelers: 1 })).toThrow(RecommenderError);
    expect(() => recommend(catalog, { ...request, start_date: '2099-02-01' })).toThrow(RecommenderError);
    expect(() => recommend(catalog, { ...request, leg_nights: { Unknown: 1 } })).toThrow(RecommenderError);
  });

  it('normalizes weighted objectives and selects diverse results deterministically', () => {
    const result = recommend(catalog, { ...request, result_count: 2, diversity: 0.8, objectives: { total_price: 0.5, distance_m: 0.5 } });
    expect(result.options.map((option) => option.id)).toEqual(['makkah-near:double+triple', 'makkah-far:five']);
    expect(result.options.every((option) => option.score >= 0 && option.score <= 1)).toBe(true);
  });

  it('applies inclusive bundle-level price and room-count bounds', () => {
    const result = recommend(catalog, { ...request, filters: { min_total_price: 100, max_total_price: 100, min_room_count: 1, max_room_count: 1 } });
    expect(result.options).toHaveLength(1);
    expect(result.options[0].total_price).toBe(100);
    expect(result.options[0].room_count).toBe(1);
  });

  it('returns an exact bounded score for a single option', () => {
    const oneHotel: Catalog = { hotels: [catalog.hotels[0]] };
    const result = recommend(oneHotel, request);
    expect(result.options).toHaveLength(1);
    expect(result.options[0].score).toBe(1);
  });

  it('rejects non-finite score intermediates with a typed error', () => {
    const overflowing: Catalog = {
      hotels: [
        { ...catalog.hotels[0], city: 'Makkah', rooms: [{ ...catalog.hotels[0].rooms[0], rates: [{ price: Number.MAX_VALUE, valid_from: '2099-01-01', valid_to: '2099-01-31' }] }] },
        { ...catalog.hotels[1], city: 'Madinah', rooms: [{ ...catalog.hotels[1].rooms[0], rates: [{ price: Number.MAX_VALUE, valid_from: '2099-01-01', valid_to: '2099-01-31' }] }] },
      ],
    };
    expect(() => recommend(overflowing, { ...request, leg_nights: { Makkah: 1, Madinah: 1 } })).toThrow(RecommenderError);
  });

  it.each([
    ['travelers', { travelers: Number.NaN }],
    ['max_distance_m', { filters: { max_distance_m: Number.POSITIVE_INFINITY } }],
    ['min_stars', { filters: { min_stars: '5' } }],
    ['weight', { objectives: { total_price: Number.NaN } }],
    ['leg_nights', { leg_nights: { Makkah: Number.POSITIVE_INFINITY } }],
  ])('rejects non-finite or wrongly typed %s before search', (_field, update) => {
    expect(() => recommend(catalog, { ...request, ...update } as RecommendationRequest)).toThrow(RecommenderError);
  });

  it('keeps at most thirty ranked candidates independently per leg', () => {
    const hotels = Array.from({ length: MAX_CANDIDATES_PER_LEG + 5 }, (_, index) => ({
      id: `m-${index.toString().padStart(2, '0')}`,
      name: `Makkah ${index}`,
      city: 'Makkah',
      stars: 5,
      distance_m: index + 1,
      rooms: [{ id: `room-${index}`, room_type: 'five', capacity: 5, rates: [{ price: 40 - index, valid_from: '2099-01-01', valid_to: '2099-01-31' }] }],
    }));
    const result = recommend({ hotels: hotels }, request);
    expect(result.options.length).toBeLessThanOrEqual(MAX_CANDIDATES_PER_LEG);
    expect(result.options[0].hotel_ids).toEqual(['m-34']);
  });

  it('fails before producing partial results when named bundle expansion bound is exceeded', () => {
    const makeLeg = (city: string) => Array.from({ length: 30 }, (_, index) => ({
      id: `${city}-${index}`,
      name: `${city} ${index}`,
      city,
      stars: 5,
      distance_m: index + 1,
      rooms: [{ id: `${city}-room-${index}`, room_type: 'five', capacity: 5, rates: [{ price: 40 - index, valid_from: '2099-01-01', valid_to: '2099-01-31' }] }],
    }));
    expect(MAX_BUNDLE_EXPANSIONS).toBeLessThan(30 * 30 * 30);
    expect(() => recommend({ hotels: [...makeLeg('Makkah'), ...makeLeg('Madinah'), ...makeLeg('Taif')] }, { ...request, leg_nights: { Makkah: 1, Madinah: 1, Taif: 1 } })).toThrow(RecommenderError);
  });
});
