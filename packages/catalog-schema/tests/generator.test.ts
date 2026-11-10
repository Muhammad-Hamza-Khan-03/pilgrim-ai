import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compilePack, type Pack } from '@pilgrim/engine';
import { CatalogSchemaError, generateCatalogSchema } from '../src/index.js';

function loadPack(path: string): Pack {
  return compilePack(readFileSync(new URL(path, import.meta.url), 'utf8'));
}

function toyPack(catalog: string): Pack {
  return compilePack(`
pack: toy
version: 2
locale: { default: en, supported: [en] }
persona: { tone: plain, currency: USD }
catalog:
${catalog}
slots: { request: { type: text } }
rules: []
bundle: { pick: item }
objectives: { score: { direction: min, weight: 1 } }
results: { count: 1, diversity: 0 }
`);
}

describe('generateCatalogSchema', () => {
  it('generates a deterministic generic schema for nested catalog entities', () => {
    const pack = loadPack('../../../packs/umrah-stays/pack.yaml');
    const artifact = generateCatalogSchema(pack);

    expect(artifact.pack).toBe('umrah-stays');
    expect(artifact.packVersion).toBe(1);
    expect(artifact.tables.map((table) => table.name)).toEqual(['catalog_versions', 'hotel', 'rate', 'room']);
    expect(artifact.tables.find((table) => table.name === 'hotel')?.columns).toEqual([
      { name: 'id', type: 'TEXT', nullable: false, primaryKey: true },
      { name: 'dataset_version', type: 'INTEGER', nullable: false, primaryKey: false },
      { name: 'city', type: 'TEXT', nullable: true, primaryKey: false },
      { name: 'distance_m', type: 'INTEGER', nullable: true, primaryKey: false },
      { name: 'name', type: 'TEXT', nullable: true, primaryKey: false },
      { name: 'stars', type: 'INTEGER', nullable: true, primaryKey: false },
    ]);
    expect(artifact.tables.find((table) => table.name === 'room')?.foreignKeys).toEqual([
      { columns: ['parent_id'], referencedTable: 'hotel', referencedColumns: ['id'] },
    ]);
    expect(artifact.upSql).toContain('CREATE TABLE IF NOT EXISTS "hotel"');
    expect(artifact.downSql.indexOf('DROP TABLE IF EXISTS "rate"')).toBeLessThan(artifact.downSql.indexOf('DROP TABLE IF EXISTS "hotel"'));
  });

  it('supports arbitrary entities and every validated attribute type', () => {
    const pack = toyPack(`  item:
    attributes:
      text_value: { type: text }
      enum_value: { type: enum }
      date_value: { type: date }
      map_value: { type: map }
      int_value: { type: int }
      bool_value: { type: boolean }
      number_value: { type: number }
      money_value: { type: money }
`);
    const table = generateCatalogSchema(pack).tables.find(({ name }) => name === 'item');
    expect(table?.columns.map(({ name, type }) => [name, type])).toEqual([
      ['id', 'TEXT'], ['dataset_version', 'INTEGER'], ['bool_value', 'INTEGER'], ['date_value', 'TEXT'],
      ['enum_value', 'TEXT'], ['int_value', 'INTEGER'], ['map_value', 'TEXT'], ['money_value', 'REAL'],
      ['number_value', 'REAL'], ['text_value', 'TEXT'],
    ]);
  });

  it('generates a distinct schema for the car-rental catalog without domain-specific logic', () => {
    const artifact = generateCatalogSchema(loadPack('../../../packs/car-rental/pack.yaml'));
    expect(artifact.tables.map(({ name }) => name)).toEqual(['car', 'catalog_versions']);
    expect(artifact.tables.find(({ name }) => name === 'car')?.columns.map(({ name, type }) => [name, type])).toEqual([
      ['id', 'TEXT'], ['dataset_version', 'INTEGER'], ['daily_rate', 'REAL'], ['name', 'TEXT'], ['seats', 'INTEGER'],
    ]);
  });

  it('is byte-for-byte deterministic when catalog input order changes', () => {
    const first = toyPack(`  zeta: { attributes: { value: text } }
  alpha: { attributes: { value: int } }
`);
    const second = toyPack(`  alpha: { attributes: { value: int } }
  zeta: { attributes: { value: text } }
`);
    expect(generateCatalogSchema(first)).toEqual(generateCatalogSchema(second));
  });

  it.each([
    ['rejects invalid identifiers', `  item-name: { attributes: { value: text } }`, /identifier/i],
    ['rejects unknown child entities', `  item: { attributes: { value: text }, children: missing }`, /unknown child/i],
    ['rejects duplicate normalized names', `  item: { attributes: { value: text } }
  ITEM: { attributes: { value: text } }`, /duplicate/i],
  ])('%s', (_name, catalog, message) => {
    expect(() => generateCatalogSchema(toyPack(catalog))).toThrow(CatalogSchemaError);
    expect(() => generateCatalogSchema(toyPack(catalog))).toThrow(message);
  });

  it('rejects relationship cycles', () => {
    const pack = toyPack(`  alpha: { attributes: { value: text }, children: beta }
  beta: { attributes: { value: text }, children: alpha }
`);
    expect(() => generateCatalogSchema(pack)).toThrow(/cycle/i);
  });

  it.each([
    ['id', `  item: { attributes: { ID: text } }`, /item.*ID/i],
    ['dataset_version', `  item: { attributes: { DATASET_VERSION: int } }`, /item.*DATASET_VERSION/i],
    ['parent_id', `  parent: { attributes: { value: text }, children: child }
  child: { attributes: { PARENT_ID: text } }`, /child.*PARENT_ID/i],
  ])('rejects generator-owned attribute collision with %s', (_name, catalog, message) => {
    expect(() => generateCatalogSchema(toyPack(catalog))).toThrow(CatalogSchemaError);
    expect(() => generateCatalogSchema(toyPack(catalog))).toThrow(message);
  });

  it.each(['catalog_versions', 'CATALOG_VERSIONS', 'Catalog_Versions'])('rejects entity table collision with generator-owned catalog_versions table: %s', (rawName) => {
    expect(() => generateCatalogSchema(toyPack(`  ${rawName}: { attributes: { value: text } }`))).toThrow(
      new RegExp(`catalog entity ${rawName}.*catalog_versions.*generator-owned`, 'i'),
    );
  });

  it('drops populated foreign-key tables in dependency order independent of names', () => {
    const artifact = generateCatalogSchema(toyPack(`  zparent: { attributes: { value: text }, children: achild }
  achild: { attributes: { value: text }, children: bgrand }
  bgrand: { attributes: { value: text } }
  yparent: { attributes: { value: text }, children: cchild }
  cchild: { attributes: { value: text } }
`));
    const python = `
import sqlite3
connection = sqlite3.connect(':memory:')
connection.execute('PRAGMA foreign_keys = ON')
connection.executescript(${JSON.stringify(artifact.upSql)})
connection.executescript("""
INSERT INTO "catalog_versions" VALUES (1, 'toy', 2);
INSERT INTO "zparent" VALUES ('z1', 1, 'z');
INSERT INTO "achild" VALUES ('a1', 1, 'z1', 'a');
INSERT INTO "bgrand" VALUES ('b1', 1, 'a1', 'b');
INSERT INTO "yparent" VALUES ('y1', 1, 'y');
INSERT INTO "cchild" VALUES ('c1', 1, 'y1', 'c');
""")
connection.executescript(${JSON.stringify(artifact.downSql)})
assert connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall() == []
`;
    expect(() => execFileSync('python3', ['-c', python], { encoding: 'utf8' })).not.toThrow();
    expect(artifact.downSql.indexOf('DROP TABLE IF EXISTS "bgrand"')).toBeLessThan(artifact.downSql.indexOf('DROP TABLE IF EXISTS "achild"'));
    expect(artifact.downSql.indexOf('DROP TABLE IF EXISTS "achild"')).toBeLessThan(artifact.downSql.indexOf('DROP TABLE IF EXISTS "zparent"'));
  });
});
