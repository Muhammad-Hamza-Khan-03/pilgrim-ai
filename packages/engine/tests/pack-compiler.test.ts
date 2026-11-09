import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compilePack, PackCompileError } from '../src/pack-compiler.js';

const carRentalYaml = `
pack: car-rental
version: 1
locale:
  default: en
  supported: [en]
persona:
  tone: practical
  currency: USD
catalog:
  car:
    attributes:
      name: { type: text }
      seats: { type: int, role: capacity }
      daily_rate: { type: money, role: unit_price, per: day }
slots:
  pickup_date: { type: date, required: true, describe: pickup date }
  rental_days: { type: int, min: 1, required: true, describe: number of rental days }
rules:
  - check: rental_days >= 1
bundle:
  pick: car
  price: rental_days * car.daily_rate
objectives:
  total_price: { direction: min, weight: 1 }
results: { count: 3, diversity: 0.2 }
`;

it('compiles the checked-in car-rental fixture', () => {
  const source = readFileSync(new URL('../../../packs/car-rental/pack.yaml', import.meta.url), 'utf8');

  expect(compilePack(source).pack).toBe('car-rental');
});
it('compiles a generic toy pack from YAML into validated JSON', () => {
  const compiled = compilePack(carRentalYaml);

  expect(compiled.pack).toBe('car-rental');
  expect(compiled.version).toBe(1);
  expect(compiled.catalog.car.attributes.daily_rate).toEqual(expect.objectContaining({ role: 'unit_price' }));
  expect(compiled.bundle.price).toBe('rental_days * car.daily_rate');
});

it('rejects a pack missing required top-level sections', () => {
  expect(() => compilePack('pack: car-rental\nversion: 1\n')).toThrow(PackCompileError);
  expect(() => compilePack('pack: car-rental\nversion: 1\n')).toThrow(/locale/i);
});

it('rejects invalid objective directions instead of accepting arbitrary config', () => {
  const invalid = carRentalYaml.replace('direction: min', 'direction: sideways');

  expect(() => compilePack(invalid)).toThrow(PackCompileError);
  expect(() => compilePack(invalid)).toThrow(/direction/i);
});

it('reports malformed YAML as a pack compilation error', () => {
  expect(() => compilePack('pack: [car-rental')).toThrow(PackCompileError);
  expect(() => compilePack('pack: [car-rental')).toThrow(/YAML/i);
});
