import { describe, expect, it } from 'vitest';
import { applySlotUpdates, nextAction, parseDeriveRule, SlotPolicyError } from '../src/slot-policy.js';

const umrahPack = {
  slots: {
    travelers: { type: 'int', required: true, min: 1 },
    total_nights: { type: 'int', required: true, min: 1 },
    leg_nights: { type: 'map', required: true, keys_from: 'bundle.legs' },
    start_date: { type: 'date', required: true, future: true },
  },
  rules: [
    { check: 'sum(leg_nights) == total_nights' },
    { derive: 'leg_nights[missing] = total_nights - sum(leg_nights)' },
  ],
} as const;

describe('slot policy', () => {
  it('validates and applies a complete atomic update', () => {
    const before = { travelers: 2, total_nights: 7 };
    const result = applySlotUpdates(umrahPack, before, { start_date: '2099-01-10', leg_nights: { Makkah: 4, Madinah: 3 } }, { mapKeys: { leg_nights: ['Makkah', 'Madinah'] } });
    expect(result.slots).toEqual({ ...before, start_date: '2099-01-10', leg_nights: { Makkah: 4, Madinah: 3 } });
    expect(result.valid).toBe(true);
    expect(before).toEqual({ travelers: 2, total_nights: 7 });
  });

  it('rejects invalid updates without partially committing any slot', () => {
    const before = { travelers: 2, total_nights: 7 };
    expect(() => applySlotUpdates(umrahPack, before, { travelers: 0, start_date: 'not-a-date' })).toThrow(SlotPolicyError);
    expect(before).toEqual({ travelers: 2, total_nights: 7 });
  });

  it('derives the one missing Umrah leg through the sandboxed evaluator', () => {
    const result = applySlotUpdates(umrahPack, { travelers: 2, total_nights: 7, leg_nights: { Makkah: 4 } }, {}, { mapKeys: { leg_nights: ['Makkah', 'Madinah'] } });
    expect(result.slots.leg_nights).toEqual({ Makkah: 4, Madinah: 3 });
    expect(result.derived).toEqual(['leg_nights[Madinah]']);
  });

  it('checks rules after derivation and rejects inconsistent totals atomically', () => {
    expect(() => applySlotUpdates(umrahPack, { travelers: 2, total_nights: 7, leg_nights: { Makkah: 4, Madinah: 4 } }, {})).toThrow(/check/i);
  });

  it('parses only the approved derive syntax', () => {
    expect(parseDeriveRule('leg_nights[missing] = total_nights - sum(leg_nights)')).toEqual({ target: 'leg_nights', expression: 'total_nights - sum(leg_nights)' });
    for (const source of ['leg_nights = total_nights', 'leg_nights[0] = total_nights', 'x[missing].y = 1', 'leg_nights[missing] = foo();']) {
      expect(() => parseDeriveRule(source)).toThrow(SlotPolicyError);
    }
  });

  it('reports required missing slots and chooses a deterministic next action', () => {
    expect(nextAction(umrahPack, { travelers: 2, total_nights: 7 })).toEqual({ type: 'ask', slots: ['leg_nights', 'start_date'] });
    expect(nextAction(umrahPack, { travelers: 2, total_nights: 7, start_date: '2099-01-10', leg_nights: { Makkah: 4, Madinah: 3 } })).toEqual({ type: 'search' });
  });

  it('bounds repeated derivation attempts', () => {
    const cyclic = { slots: { a: { type: 'map' } }, rules: [{ derive: 'a[missing] = sum(a)' }] } as const;
    expect(() => applySlotUpdates(cyclic, { a: { x: 1 } }, {}, { mapKeys: { a: ['x', 'y'] }, maxDerivations: 0 })).toThrow(/deriv/i);
  });
});
