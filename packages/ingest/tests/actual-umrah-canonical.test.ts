import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createSourceArtifact,
  mapActualUmrahRatesToCanonical,
  parseActualUmrahRates,
} from '../src/index.js';

const fixtureBytes = readFileSync(new URL('./fixtures/actual-umrah-hotel-rates.csv', import.meta.url));
const source = parseActualUmrahRates(createSourceArtifact(new Uint8Array(fixtureBytes)));

 describe('bounded actual Umrah canonical mapper', () => {
  it('maps the source into a deterministic staging-only hotel-room-rate hierarchy', () => {
    const result = mapActualUmrahRatesToCanonical(source);

    expect(result.status).toBe('staging');
    expect(result.recommenderReady).toBe(false);
    expect(result.semantics).toEqual({ currency: 'SAR', priceBasis: 'per room per night', provisional: true });
    expect(result.source).toEqual(expect.objectContaining({
      sourceId: '446525946a9f98ece33c6c0fab3bef97aa0cb397a3856887827def95a616622e',
      sha256: '446525946a9f98ece33c6c0fab3bef97aa0cb397a3856887827def95a616622e',
      byteLength: 2191,
      rowCount: 24,
    }));
    expect(result.hotels).toHaveLength(8);
    expect(result.periods).toHaveLength(3);
    expect(result.rates).toHaveLength(93);
    expect(result.blankCells).toHaveLength(3);

    const hotel = result.hotels.find((item) => item.name === 'Darul Taqwa');
    expect(hotel).toMatchObject({ city: 'Madinah', cityRaw: 'Madinah Munawwarrah' });
    expect(result.rates.find((rate) => rate.roomType === 'quad' && rate.hotelId === hotel?.id)).toBeUndefined();

    const firstRate = result.rates[0];
    expect(firstRate).toMatchObject({
      hotelId: result.hotels[0].id,
      roomType: 'dbl',
      capacity: 2,
      price: 750,
      currency: 'SAR',
      priceBasis: 'per room per night',
      provisional: true,
      mealPlan: 'Breakfast',
      validFrom: '2025-09-01',
      validTo: '2025-12-15',
      validFromRaw: '01/09/2025',
      validToRaw: '15/12/2025',
      source: expect.objectContaining({
        sourceId: source.sourceId,
        sha256: source.sha256,
        rowNumber: 2,
        rawValues: source.rows[0].rawValues,
      }),
    });
  });

  it('uses explicit aliases only and keeps raw source spellings and blank-cell provenance', () => {
    const result = mapActualUmrahRatesToCanonical(source);
    const madinahHotels = result.hotels.filter((hotel) => hotel.city === 'Madinah');

    expect(madinahHotels.map((hotel) => hotel.cityRaw)).toEqual(['Madinah Munawarrah', 'Madinah Munawarrah', 'Madinah Munawwarrah', 'Madinah Munawwarrah']);
    expect(result.blankCells).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rowNumber: 20,
        column: 'QUAD',
        rawValue: '',
        sourceId: source.sourceId,
        sha256: source.sha256,
        rawValues: source.rows[18].rawValues,
      }),
    ]));
    expect(result.blankCells.every((cell) => cell.reason === 'unavailable')).toBe(true);
  });

  it('is invariant to source row permutation while preserving each row provenance', () => {
    const expected = mapActualUmrahRatesToCanonical(source);
    const reverse = { ...source, rows: [...source.rows].reverse() };
    const shuffled = { ...source, rows: [...source.rows].sort((left, right) => left.raw.localeCompare(right.raw)) };

    expect(mapActualUmrahRatesToCanonical(reverse)).toEqual(expected);
    expect(mapActualUmrahRatesToCanonical(shuffled)).toEqual(expected);
  });

  it('assigns unique deterministic IDs to duplicate semantic rates', () => {
    const duplicate = { ...source.rows[0], rowNumber: 26 };
    const withDuplicate = { ...source, rows: [...source.rows, duplicate] };
    const result = mapActualUmrahRatesToCanonical(withDuplicate);
    const reversed = mapActualUmrahRatesToCanonical({ ...withDuplicate, rows: [...withDuplicate.rows].reverse() });
    const rateIds = result.rates.map((rate) => rate.id);

    expect(new Set(rateIds).size).toBe(rateIds.length);
    expect(reversed).toEqual(result);
  });

  it('is byte-for-byte deterministic for repeated mapping', () => {
    expect(mapActualUmrahRatesToCanonical(source)).toEqual(mapActualUmrahRatesToCanonical(source));
  });
});
