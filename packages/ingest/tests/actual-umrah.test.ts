import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createSourceArtifact,
} from '../src/index.js';
import {
  ACTUAL_UMRAH_HEADERS,
  parseActualUmrahRates,
} from '../src/index.js';

const fixturePath = new URL('./fixtures/actual-umrah-hotel-rates.csv', import.meta.url);
const fixtureBytes = readFileSync(fixturePath);
const fixtureText = fixtureBytes.toString('utf8');
const fixtureArtifact = createSourceArtifact(new Uint8Array(fixtureBytes));

const expectedHash = '446525946a9f98ece33c6c0fab3bef97aa0cb397a3856887827def95a616622e';

describe('actual Umrah source fixture', () => {
  it('preserves the supplied bytes and provenance while parsing the exact source rows', () => {
    expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe(expectedHash);
    expect(fixtureArtifact.sourceId).toBe(expectedHash);
    expect(fixtureText.split(/\r\n|\n/)[0]).toBe(ACTUAL_UMRAH_HEADERS.join(','));

    const result = parseActualUmrahRates(fixtureArtifact);

    expect(result.sourceId).toBe(expectedHash);
    expect(result.headers).toEqual(ACTUAL_UMRAH_HEADERS);
    expect(result.rows).toHaveLength(24);
    expect(result.rawBytes).toEqual(new Uint8Array(fixtureBytes));
    expect(result.rows[0]).toMatchObject({
      rowNumber: 2,
      rawValues: ['Makkah Mukarramah', 'Marwa Rotana', '01/09/2025', '15/12/2025', '750', '900', '1100', '1350', 'Breakfast', '5'],
      city: 'Makkah Mukarramah',
      hotelName: 'Marwa Rotana',
      periodFrom: { raw: '01/09/2025', iso: '2025-09-01' },
      periodTo: { raw: '15/12/2025', iso: '2025-12-15' },
      occupancyValues: { DBL: 750, TRP: 900, QUAD: 1100, 'Suite for 5 Persons': 1350 },
      mealPlan: 'Breakfast',
      category: 5,
    });
    expect(result.rows[19].occupancyValues.QUAD).toBeNull();
    expect(result.rows[19].rawValues[6]).toBe('');
    expect(result.rows[15].city).toBe('Madinah Munawarrah');
    expect(result.rows[16].city).toBe('Madinah Munawwarrah');
  });

  it('rejects tampered metadata, renamed or reordered headers, and malformed rows', () => {
    const tampered = { ...fixtureArtifact, sha256: '0'.repeat(64) };
    expect(() => parseActualUmrahRates(tampered)).toThrowError(expect.objectContaining({ code: 'SOURCE_PROVENANCE_MISMATCH' }));

    const mutate = (line: string) => createSourceArtifact(new TextEncoder().encode(`${line}\n${fixtureText.split(/\r?\n/).slice(1).join('\n')}`));
    expect(() => parseActualUmrahRates(mutate('City,Hotel Name,Period To,Period From,DBL(for 2 persons),TRP (for 3 persons),QUAD (for 4 persons),Suite for 5 Persons,Meal Plan,Category')))
      .toThrowError(expect.objectContaining({ code: 'ACTUAL_UMRAH_HEADER_MISMATCH' }));
    expect(() => parseActualUmrahRates(mutate('City,Hotel Name,Period From,Period To,DBL(for 2 persons),TRP (for 3 persons),QUAD,Suite for 5 Persons,Meal Plan,Category')))
      .toThrowError(expect.objectContaining({ code: 'ACTUAL_UMRAH_HEADER_MISMATCH' }));

    const badDate = fixtureText.replace('01/09/2025,15/12/2025', '31/02/2025,15/12/2025');
    expect(() => parseActualUmrahRates(createSourceArtifact(new TextEncoder().encode(badDate))))
      .toThrowError(expect.objectContaining({ code: 'ACTUAL_UMRAH_INVALID' }));
    const badNumber = fixtureText.replace(',750,900,1100,1350,', ',not-a-number,900,1100,1350,');
    expect(() => parseActualUmrahRates(createSourceArtifact(new TextEncoder().encode(badNumber))))
      .toThrowError(expect.objectContaining({ code: 'ACTUAL_UMRAH_INVALID' }));
    const badWidth = fixtureText.replace(',Breakfast,5', ',Breakfast');
    expect(() => parseActualUmrahRates(createSourceArtifact(new TextEncoder().encode(badWidth))))
      .toThrowError(expect.objectContaining({ code: 'ACTUAL_UMRAH_INVALID' }));
  });

  it('does not silently drop a blank data row', () => {
    const withBlank = fixtureText.replace('Makkah Mukarramah,Anjum Hotel,16/12/2025', '\nMakkah Mukarramah,Anjum Hotel,16/12/2025');
    expect(() => parseActualUmrahRates(createSourceArtifact(new TextEncoder().encode(withBlank))))
      .toThrowError(expect.objectContaining({ code: 'ACTUAL_UMRAH_INVALID' }));
  });
});
