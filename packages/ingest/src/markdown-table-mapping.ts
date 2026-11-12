import type { Pack } from '../../engine/src/index.js';
import type { CatalogSchemaArtifact } from '../../catalog-schema/src/types.js';
import type { MarkdownTable } from './markdown-table-extraction.js';

export type MarkdownTableAliasMap = Record<string, Record<string, string>>;
export type MarkdownTableMapping = {
  source: string;
  normalized: string;
  attribute: string;
};
export type MarkdownTableProvenance = {
  tableId: string;
  sourceId: string;
  blockId: string;
  headingPath: string[];
  startLine: number;
  endLine: number;
  headerRowNumber: number;
};
export type MarkdownTableReviewCode =
  | 'NO_ENTITY_MATCH'
  | 'AMBIGUOUS_ENTITY'
  | 'UNKNOWN_HEADER'
  | 'MISSING_SEMANTIC_HEADER'
  | 'NORMALIZED_HEADER_COLLISION'
  | 'PARENT_CONTEXT_REQUIRED'
  | 'ROW_WIDTH_MISMATCH';
export type MarkdownTableReviewReason = {
  code: MarkdownTableReviewCode;
  candidates?: string[];
  unknown?: string[];
  message?: string;
};
export type MarkdownTableMappingRequest = {
  table: MarkdownTable;
  pack: Pack;
  schema: CatalogSchemaArtifact;
  aliases?: MarkdownTableAliasMap;
};
export type MappedMarkdownTable = {
  status: 'mapped';
  entity: string;
  headers: MarkdownTableMapping[];
  rows: Array<{ order: number; rowNumber: number; values: Record<string, string> }>;
  provenance: MarkdownTableProvenance;
};
export type MarkdownTableNeedsReview = {
  status: 'needs_review';
  reasons: MarkdownTableReviewReason[];
  provenance: MarkdownTableProvenance;
};
export type MarkdownTableClassification = MappedMarkdownTable | MarkdownTableNeedsReview;

type EntityCandidate = {
  name: string;
  attributes: string[];
  generated: Set<string>;
  aliases: Map<string, string>;
  parentRequired: boolean;
};

type AttributeMatch = { attribute: string; semantic: boolean };

const normalizeHeader = (value: string): string => value.trim().toLowerCase().replace(/[\s_-]+/g, '_');
const provenanceOf = (table: MarkdownTable): MarkdownTableProvenance => ({
  tableId: table.tableId,
  sourceId: table.sourceId,
  blockId: table.blockId,
  headingPath: [...table.headingPath],
  startLine: table.startLine,
  endLine: table.endLine,
  headerRowNumber: table.headerRowNumber,
});

function candidatesOf(pack: Pack, schema: CatalogSchemaArtifact, aliases: MarkdownTableAliasMap | undefined): EntityCandidate[] {
  const catalog = pack.catalog as Record<string, { attributes: Record<string, unknown>; children?: string }>;
  const tables = new Map(schema.tables.map((table) => [normalizeHeader(table.name), table]));
  return Object.entries(catalog).flatMap(([rawName, entity]) => {
    const name = normalizeHeader(rawName);
    const table = tables.get(name);
    if (!table) return [];
    const attributes = Object.keys(entity.attributes).map(normalizeHeader);
    const columns = new Set(table.columns.map((column) => normalizeHeader(column.name)));
    const usable = [...columns].filter((column) => column === 'id' || column === 'dataset_version' || column === 'parent_id' || attributes.includes(column));
    const aliasMap = new Map<string, string>();
    for (const [rawAlias, rawTarget] of Object.entries(aliases?.[rawName] ?? aliases?.[name] ?? {})) {
      const alias = normalizeHeader(rawAlias);
      const target = normalizeHeader(rawTarget);
      if (attributes.includes(target) && columns.has(target)) aliasMap.set(alias, target);
    }
    return [{
      name,
      attributes,
      generated: new Set(usable.filter((column) => !attributes.includes(column))),
      aliases: aliasMap,
      parentRequired: table.foreignKeys.some((foreignKey) => foreignKey.columns.map(normalizeHeader).includes('parent_id')),
    }];
  });
}

function matchHeader(candidate: EntityCandidate, normalized: string): AttributeMatch | undefined {
  if (candidate.attributes.includes(normalized)) return { attribute: normalized, semantic: true };
  if (candidate.generated.has(normalized)) return { attribute: normalized, semantic: false };
  const alias = candidate.aliases.get(normalized);
  return alias ? { attribute: alias, semantic: true } : undefined;
}

function reason(code: MarkdownTableReviewCode, extras: Omit<MarkdownTableReviewReason, 'code'> = {}): MarkdownTableReviewReason {
  return { code, ...extras };
}

export function classifyMarkdownTable(request: MarkdownTableMappingRequest): MarkdownTableClassification {
  const { table } = request;
  const provenance = provenanceOf(table);
  const normalizedHeaders = table.headers.map(normalizeHeader);
  const collisionNames = [...new Set(normalizedHeaders.filter((header, index) => normalizedHeaders.indexOf(header) !== index))].sort();
  if (collisionNames.length > 0) {
    return { status: 'needs_review', reasons: [reason('NORMALIZED_HEADER_COLLISION', { unknown: collisionNames, message: `headers normalize ambiguously: ${collisionNames.join(', ')}` })], provenance };
  }

  const candidates = candidatesOf(request.pack, request.schema, request.aliases);
  const matches = candidates.map((candidate) => ({
    candidate,
    headers: normalizedHeaders.map((header) => matchHeader(candidate, header)),
  }));
  const viable = matches.filter(({ headers }) => headers.every(Boolean) && headers.some((header) => header?.semantic));
  const unknown = normalizedHeaders.filter((header) => !matches.some(({ headers }) => headers[normalizedHeaders.indexOf(header)] !== undefined));
  const reasons: MarkdownTableReviewReason[] = [];

  if (viable.length === 0) {
    if (unknown.length === 0 && !normalizedHeaders.some((header) => candidates.some((candidate) => candidate.attributes.includes(header)))) {
      reasons.push(reason('MISSING_SEMANTIC_HEADER', { message: 'table has no pack-defined semantic header' }));
    }
    reasons.push(reason('NO_ENTITY_MATCH', { candidates: candidates.map((candidate) => candidate.name).sort() }));
    const unknownHeaders = [...new Set(unknown)].sort();
    if (unknownHeaders.length > 0) reasons.push(reason('UNKNOWN_HEADER', { unknown: unknownHeaders }));
    return { status: 'needs_review', reasons, provenance };
  }
  if (viable.length > 1) {
    return { status: 'needs_review', reasons: [reason('AMBIGUOUS_ENTITY', { candidates: viable.map(({ candidate }) => candidate.name).sort() })], provenance };
  }

  const [{ candidate, headers }] = viable;
  const mappedAttributes = headers.map((match) => match!.attribute);
  const canonicalCollisionNames = [...new Set(mappedAttributes.filter((attribute, index) => mappedAttributes.indexOf(attribute) !== index))].sort();
  if (canonicalCollisionNames.length > 0) {
    return {
      status: 'needs_review',
      reasons: [reason('NORMALIZED_HEADER_COLLISION', {
        unknown: canonicalCollisionNames,
        message: `headers map ambiguously to the same canonical attribute: ${canonicalCollisionNames.join(', ')}`,
      })],
      provenance,
    };
  }
  const headerMappings = headers.map((match, index) => ({ source: table.headers[index], normalized: normalizedHeaders[index], attribute: match!.attribute }));
  const widthMismatch = table.rows.some((row) => row.values.length !== table.headers.length);
  if (widthMismatch) {
    reasons.push(reason('ROW_WIDTH_MISMATCH', { message: `one or more rows do not have ${table.headers.length} values` }));
  }
  if (candidate.parentRequired) reasons.push(reason('PARENT_CONTEXT_REQUIRED', { candidates: [candidate.name], message: 'child entity mapping requires explicit parent context' }));
  if (reasons.length > 0) return { status: 'needs_review', reasons, provenance };

  return {
    status: 'mapped',
    entity: candidate.name,
    headers: headerMappings,
    rows: table.rows.map((row, order) => ({
      order,
      rowNumber: row.rowNumber,
      values: Object.fromEntries(headerMappings.map((header, index) => [header.attribute, row.values[index]])),
    })),
    provenance,
  };
}

export { normalizeHeader as normalizeMarkdownTableHeader };
