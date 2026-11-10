import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createSourceArtifact,
  diffStagingSnapshots,
  mapActualUmrahRatesToCanonical,
  parseActualUmrahRates,
  serializeStagingDiff,
  StagingDiffError,
} from '../src/index.js';

const bytes = readFileSync(new URL('./fixtures/actual-umrah-hotel-rates.csv', import.meta.url));
const source = parseActualUmrahRates(createSourceArtifact(new Uint8Array(bytes)));
const snapshot = mapActualUmrahRatesToCanonical(source);
const versions = { parentVersion: 'v1', candidateVersion: 'v2' };

describe('pure versioned staging diff contract', () => {
  it('returns deterministic empty diff with version metadata for identical staging', () => {
    const result = diffStagingSnapshots({ ...versions, parent: snapshot, candidate: structuredClone(snapshot) });

    expect(result.version).toEqual({ parentVersion: 'v1', candidateVersion: 'v2' });
    expect(result.review).toEqual({ status: 'pending', approved: false });
    expect(result.diff).toEqual({ hotels: { added: [], removed: [], changed: [] }, rooms: { added: [], removed: [], changed: [] }, rates: { added: [], removed: [], changed: [] }, periods: { added: [], removed: [], changed: [] }, blankCells: { added: [], removed: [], changed: [] } });
    expect(serializeStagingDiff(result)).toBe(serializeStagingDiff(diffStagingSnapshots({ ...versions, parent: snapshot, candidate: structuredClone(snapshot) })));
  });

  it('reports one changed rate with before and after and a price reason', () => {
    const candidate = structuredClone(snapshot);
    candidate.rates[0].price = 999;
    const result = diffStagingSnapshots({ ...versions, parent: snapshot, candidate });
    const changed = result.diff.rates.changed;

    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ id: snapshot.rates[0].id, before: { price: 750 }, after: { price: 999 }, reasons: ['price'] });
    expect(changed[0].before.source).toEqual(snapshot.rates[0].source);
  });

  it('classifies source-only changes as provenance and is invariant to input order', () => {
    const candidate = structuredClone(snapshot);
    candidate.rates[0].source.raw = `${candidate.rates[0].source.raw} `;
    const expected = diffStagingSnapshots({ ...versions, parent: snapshot, candidate });
    const shuffled = structuredClone(candidate);
    shuffled.rates.reverse();
    shuffled.hotels.reverse();
    shuffled.rooms.reverse();
    shuffled.periods.reverse();
    shuffled.blankCells.reverse();

    expect(expected.diff.rates.changed[0].reasons).toEqual(['provenance']);
    expect(diffStagingSnapshots({ ...versions, parent: snapshot, candidate: shuffled })).toEqual(expected);
  });

  it('reports lifecycle additions and removals with preserved records and reasons', () => {
    const candidate = structuredClone(snapshot);
    const removed = candidate.rates.pop()!;
    const added = { ...structuredClone(snapshot.rates[0]), id: 'rate_added' };
    candidate.rates.push(added);
    const result = diffStagingSnapshots({ ...versions, parent: snapshot, candidate });

    expect(result.diff.rates.removed).toEqual([{ id: removed.id, record: removed, reasons: ['entity lifecycle'] }]);
    expect(result.diff.rates.added).toEqual([{ id: 'rate_added', record: added, reasons: ['entity lifecycle'] }]);
  });

  it('rejects non-staging, recommender-ready, duplicate, and semantic-mismatch snapshots', () => {
    expect(() => diffStagingSnapshots({ ...versions, parent: { ...snapshot, status: 'published' } as never, candidate: snapshot })).toThrow(/NON_STAGING/);
    expect(() => diffStagingSnapshots({ ...versions, parent: { ...snapshot, recommenderReady: true } as never, candidate: snapshot })).toThrow(/RECOMMENDER_READY/);
    expect(() => diffStagingSnapshots({ ...versions, parent: { ...snapshot, rates: [...snapshot.rates, snapshot.rates[0]] }, candidate: snapshot })).toThrow(/DUPLICATE_KEY/);
    expect(() => diffStagingSnapshots({ ...versions, parent: snapshot, candidate: { ...snapshot, semantics: { ...snapshot.semantics, currency: 'USD' } } as never })).toThrow(/SEMANTICS_MISMATCH/);
  });

  it('treats an omitted parent as an initial import with every candidate record added', () => {
    const result = diffStagingSnapshots({ ...versions, candidate: snapshot });

    for (const name of ['hotels', 'rooms', 'rates', 'periods', 'blankCells'] as const) {
      expect(result.diff[name].added).toHaveLength(snapshot[name].length);
      expect(result.diff[name].added.every(({ reasons }) => reasons.includes('entity lifecycle'))).toBe(true);
    }
  });

  it('throws StagingDiffError for malformed parent, candidate, and nested collections', () => {
    const malformed = [
      { ...versions, candidate: undefined },
      { ...versions, parent: null, candidate: snapshot },
      { ...versions, candidate: { ...snapshot, rates: undefined } },
    ];

    for (const request of malformed) {
      try {
        diffStagingSnapshots(request as never);
        throw new Error('expected malformed staging request to be rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(StagingDiffError);
        expect((error as StagingDiffError).code).toBe('INVALID_SNAPSHOT');
      }
    }
  });

  it('serializes reversed nested room and rate arrays deterministically without mutation', () => {
    const candidate = structuredClone(snapshot);
    const before = structuredClone(candidate);
    for (const hotel of candidate.hotels) {
      hotel.rooms.reverse();
      for (const room of hotel.rooms) room.rates.reverse();
    }
    const reversed = structuredClone(candidate);
    const serialized = serializeStagingDiff(diffStagingSnapshots({ ...versions, parent: undefined, candidate }));
    const canonical = serializeStagingDiff(diffStagingSnapshots({ ...versions, parent: undefined, candidate: structuredClone(snapshot) }));

    expect(serialized).toBe(canonical);
    expect(candidate).toEqual(reversed);
    expect(before).not.toEqual(candidate);
  });
});
