import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compilePack } from '../src/pack-compiler.js';
import { applySlotUpdates, nextAction, SlotPolicyError } from '../src/slot-policy.js';

const source = readFileSync(new URL('../../../packs/umrah-stays/pack.yaml', import.meta.url), 'utf8');

function compileUmrahPack() {
  return compilePack(source);
}

describe('umrah-stays v1 pack integration', () => {
  it('compiles the bounded v1 fixture with explicit catalog and pricing semantics', () => {
    const pack = compileUmrahPack();

    expect(pack.pack).toBe('umrah-stays');
    expect(pack.version).toBe(1);
    expect(pack.locale).toEqual({ default: 'en', supported: ['en'] });
    expect(pack.persona.currency).toBe('SAR');
    expect(pack.persona).toEqual(expect.objectContaining({ price_basis: 'per room per night', provisional: true }));
    expect(pack.catalog.hotel.children).toBe('room');
    expect(pack.catalog.room.children).toBe('rate');
    expect(pack.catalog.rate.attributes.price).toEqual(expect.objectContaining({ type: 'money', role: 'unit_price', per: 'night' }));
    expect(Object.keys(pack.slots)).toEqual(['travelers', 'start_date', 'total_nights', 'leg_nights', 'budget_total']);
    expect(pack.bundle).toEqual(expect.objectContaining({
      legs: { group_by: 'hotel.city' },
      allocation: expect.objectContaining({ demand: 'slot.travelers', supply: 'room.capacity' }),
      price: 'sum(legs, sum(allocation, sum(nights, rate.price)))',
    }));
    expect(pack.objectives).toEqual({
      total_price: { direction: 'min', weight: 0.4 },
      distance_m: { direction: 'min', weight: 0.3 },
      stars: { direction: 'max', weight: 0.2 },
      room_count: { direction: 'min', weight: 0.1 },
    });
    expect(pack.results).toEqual(expect.objectContaining({ count: 3, diversity: 0.3 }));
  });

  it('derives the missing Umrah leg from runtime map keys without mutating input', () => {
    const pack = compileUmrahPack();
    const before = { travelers: 2, total_nights: 7, leg_nights: { Makkah: 4 } };

    const result = applySlotUpdates(pack, before, {}, { mapKeys: { leg_nights: ['Makkah', 'Madinah'] } });

    expect(result.slots.leg_nights).toEqual({ Makkah: 4, Madinah: 3 });
    expect(before).toEqual({ travelers: 2, total_nights: 7, leg_nights: { Makkah: 4 } });
    expect(result.derived).toEqual(['leg_nights[Madinah]']);
  });

  it('rejects failed checks, unknown slots, and invalid updates atomically', () => {
    const pack = compileUmrahPack();
    const before = { travelers: 2, total_nights: 7, leg_nights: { Makkah: 4, Madinah: 3 } };

    expect(() => applySlotUpdates(pack, before, { leg_nights: { Makkah: 4, Madinah: 4 } }, { mapKeys: { leg_nights: ['Makkah', 'Madinah'] } })).toThrow(SlotPolicyError);
    expect(() => applySlotUpdates(pack, before, { unknown: true })).toThrow(/unknown slot/i);
    expect(() => applySlotUpdates(pack, before, { travelers: 0 })).toThrow(/minimum/i);
    expect(before).toEqual({ travelers: 2, total_nights: 7, leg_nights: { Makkah: 4, Madinah: 3 } });
  });

  it('returns deterministic at-most-two follow-up slots and searches when complete', () => {
    const pack = compileUmrahPack();
    const incomplete = { travelers: 2, total_nights: 7 };
    const first = nextAction(pack, incomplete);
    const second = nextAction(pack, structuredClone(incomplete));

    expect(first).toEqual(second);
    expect(first.type).toBe('ask');
    if (first.type !== 'ask') throw new Error('expected an ask action');
    expect(first.slots).toHaveLength(2);

    expect(nextAction(pack, {
      travelers: 2,
      start_date: '2099-01-10',
      total_nights: 7,
      leg_nights: { Makkah: 4, Madinah: 3 },
    })).toEqual({ type: 'search' });
  });
});
