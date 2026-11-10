import type { Pack } from '@pilgrim/engine';
import type { CatalogColumn, CatalogForeignKey, CatalogIndex, CatalogSchemaArtifact, CatalogTable, SqliteAffinity } from './types.js';

export type { CatalogColumn, CatalogForeignKey, CatalogIndex, CatalogSchemaArtifact, CatalogTable, SqliteAffinity } from './types.js';

export class CatalogSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogSchemaError';
  }
}

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const typeMap: Record<string, SqliteAffinity> = {
  text: 'TEXT', enum: 'TEXT', date: 'TEXT', map: 'TEXT',
  int: 'INTEGER', boolean: 'INTEGER', number: 'REAL', money: 'REAL',
};

function normalizedIdentifier(value: string, context: string): string {
  if (!identifierPattern.test(value)) {
    throw new CatalogSchemaError(`invalid identifier for ${context}: ${value}`);
  }
  return value.toLowerCase();
}

function quote(value: string): string {
  return `"${value}"`;
}

function attributeType(attribute: unknown, context: string): SqliteAffinity {
  const type = typeof attribute === 'string' ? attribute : (attribute as { type?: unknown } | null)?.type;
  if (typeof type !== 'string' || !(type in typeMap)) {
    throw new CatalogSchemaError(`unknown attribute type for ${context}`);
  }
  return typeMap[type];
}

function sqlForTable(table: CatalogTable): string {
  const columns = table.columns.map((column) => `${quote(column.name)} ${column.type}${column.primaryKey ? ' PRIMARY KEY' : ''}${column.nullable ? '' : ' NOT NULL'}`);
  const foreignKeys = table.foreignKeys.map((foreignKey) => `FOREIGN KEY (${foreignKey.columns.map(quote).join(', ')}) REFERENCES ${quote(foreignKey.referencedTable)} (${foreignKey.referencedColumns.map(quote).join(', ')})`);
  return `CREATE TABLE IF NOT EXISTS ${quote(table.name)} (${[...columns, ...foreignKeys].join(', ')});`;
}

function assertUnique(values: string[], context: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new CatalogSchemaError(`duplicate ${context}: ${value}`);
    seen.add(value);
  }
}

export function generateCatalogSchema(pack: Pack): CatalogSchemaArtifact {
  const entityEntries = Object.entries(pack.catalog).map(([rawName, entity]) => ({
    rawName,
    name: normalizedIdentifier(rawName, 'catalog entity'),
    entity,
  }));
  assertUnique(entityEntries.map(({ name }) => name), 'catalog entity');
  const entityNames = new Set(entityEntries.map(({ name }) => name));

  const relationships = new Map<string, string>();
  for (const { rawName, name, entity } of entityEntries) {
    if (entity.children !== undefined) {
      const child = normalizedIdentifier(entity.children, `child of ${rawName}`);
      if (!entityNames.has(child)) throw new CatalogSchemaError(`unknown child entity: ${entity.children}`);
      if (relationships.has(child)) throw new CatalogSchemaError(`duplicate parent relationship for child: ${child}`);
      relationships.set(child, name);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visiting.has(name)) throw new CatalogSchemaError(`catalog relationship cycle involving: ${name}`);
    if (visited.has(name)) return;
    visiting.add(name);
    const parent = relationships.get(name);
    if (parent !== undefined) visit(parent);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of entityNames) visit(name);

  const tables: CatalogTable[] = [{
    name: 'catalog_versions',
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
      { name: 'pack', type: 'TEXT', nullable: false, primaryKey: false },
      { name: 'pack_version', type: 'INTEGER', nullable: false, primaryKey: false },
    ],
    foreignKeys: [],
    indexes: [],
  }];

  for (const { name, entity } of entityEntries) {
    const rawAttributes = Object.keys(entity.attributes).map((rawName) => ({ rawName, name: normalizedIdentifier(rawName, `attribute of ${name}`) })).sort((left, right) => left.name.localeCompare(right.name));
    assertUnique(rawAttributes.map(({ name: attributeName }) => attributeName), `attribute of ${name}`);
    const columns: CatalogColumn[] = [
      { name: 'id', type: 'TEXT', nullable: false, primaryKey: true },
      { name: 'dataset_version', type: 'INTEGER', nullable: false, primaryKey: false },
    ];
    if (relationships.has(name)) columns.push({ name: 'parent_id', type: 'TEXT', nullable: false, primaryKey: false });
    columns.push(...rawAttributes.map(({ rawName, name: attributeName }) => ({
      name: attributeName,
      type: attributeType(entity.attributes[rawName], `${name}.${rawName}`),
      nullable: true,
      primaryKey: false,
    })));
    const foreignKeys = relationships.has(name) ? [{ columns: ['parent_id'], referencedTable: relationships.get(name)!, referencedColumns: ['id'] }] : [];
    const indexes: CatalogIndex[] = [{ name: `${name}_dataset_version_idx`, columns: ['dataset_version'] }];
    if (foreignKeys.length > 0) indexes.push({ name: `${name}_parent_id_idx`, columns: ['parent_id'] });
    tables.push({ name, columns, foreignKeys, indexes });
  }

  tables.sort((left, right) => left.name.localeCompare(right.name));
  const upStatements = tables.flatMap((table) => [sqlForTable(table), ...table.indexes.map((index) => `CREATE INDEX IF NOT EXISTS ${quote(index.name)} ON ${quote(table.name)} (${index.columns.map(quote).join(', ')});`)]);
  const downStatements = [...tables].reverse().map((table) => `DROP TABLE IF EXISTS ${quote(table.name)};`);
  return {
    pack: pack.pack,
    packVersion: pack.version,
    upSql: `${upStatements.join('\n')}\n`,
    downSql: `${downStatements.join('\n')}\n`,
    tables,
  };
}
