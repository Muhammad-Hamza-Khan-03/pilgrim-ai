export type SqliteAffinity = 'TEXT' | 'INTEGER' | 'REAL';

export interface CatalogColumn {
  name: string;
  type: SqliteAffinity;
  nullable: boolean;
  primaryKey: boolean;
}

export interface CatalogForeignKey {
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
}

export interface CatalogIndex {
  name: string;
  columns: string[];
}

export interface CatalogTable {
  name: string;
  columns: CatalogColumn[];
  foreignKeys: CatalogForeignKey[];
  indexes: CatalogIndex[];
}

export interface CatalogSchemaArtifact {
  pack: string;
  packVersion: number;
  upSql: string;
  downSql: string;
  tables: CatalogTable[];
}
