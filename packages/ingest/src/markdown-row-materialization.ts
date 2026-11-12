import type { Pack } from '../../engine/src/index.js';
import type { CatalogSchemaArtifact } from '../../catalog-schema/src/types.js';
import type { MappedMarkdownTable, MarkdownTableMapping } from './markdown-table-mapping.js';

export type MarkdownRowRejectionCode =
  | 'MISSING_ID' | 'REQUIRED_VALUE' | 'INVALID_VALUE' | 'OUT_OF_RANGE' | 'DATE_ORDER'
  | 'DUPLICATE_ID' | 'PARENT_REQUIRED' | 'PARENT_NOT_ALLOWED' | 'RESERVED_FIELD'
  | 'UNSUPPORTED_ATTRIBUTE_TYPE';

export type MarkdownRowDiagnosticProvenance = {
  tableId: string;
  sourceId: string;
  blockId: string;
  headingPath: string[];
  startLine: number;
  endLine: number;
  headerRowNumber: number;
  rowNumber: number;
  order: number;
  rawValues: string[];
  sourceHeaders: string[];
  mapping: MarkdownTableMapping[];
};

export type MaterializedMarkdownRow = {
  entity: string;
  values: Record<string, unknown>;
  rawValues: string[];
  sourceHeaders: string[];
  mapping: MarkdownTableMapping[];
  provenance: MarkdownRowDiagnosticProvenance;
};

export type RejectedMarkdownRow = {
  entity: string;
  code: MarkdownRowRejectionCode;
  message: string;
  rawValues: string[];
  sourceHeaders: string[];
  mapping: MarkdownTableMapping[];
  provenance: MarkdownRowDiagnosticProvenance;
};

export type MarkdownRowMaterializationRequest = {
  mapped: MappedMarkdownTable;
  pack: Pack;
  schema: CatalogSchemaArtifact;
  datasetVersion: number;
  parentId?: string;
};

export type MarkdownRowMaterializationResult = {
  publishable: boolean;
  accepted: MaterializedMarkdownRow[];
  rejected: RejectedMarkdownRow[];
};

type AttributeDefinition = string | {
  type: string;
  min?: number;
  max?: number;
  required?: boolean;
  values_from?: string;
};

const SUPPORTED = new Set(['text', 'enum', 'date', 'int', 'number', 'money', 'boolean', 'map']);
const normalize = (value: string): string => value.trim().toLowerCase().replace(/[\s_-]+/g, '_');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function definitionFor(pack: Pack, entity: string, attribute: string): AttributeDefinition | undefined {
  const config = (pack.catalog as Record<string, { attributes: Record<string, AttributeDefinition> }>)[entity];
  if (!config) return undefined;
  const raw = Object.keys(config.attributes).find((name) => normalize(name) === attribute);
  return raw === undefined ? undefined : config.attributes[raw];
}

function childEntities(pack: Pack): Set<string> {
  return new Set(Object.values(pack.catalog as Record<string, { children?: string }>).flatMap((entity) => entity.children ? [normalize(entity.children)] : []));
}

function typed(value: string, definition: AttributeDefinition, attribute: string): unknown {
  const type = typeof definition === 'string' ? definition : definition.type;
  if (!SUPPORTED.has(type) || (type === 'enum' && typeof definition !== 'string' && definition.values_from !== undefined && definition.values_from !== 'data')) {
    throw { code: 'UNSUPPORTED_ATTRIBUTE_TYPE' as const, message: `unsupported attribute type for ${attribute}` };
  }
  if (value.trim() === '') throw { code: typeof definition !== 'string' && definition.required ? 'REQUIRED_VALUE' as const : 'INVALID_VALUE' as const, message: `${attribute} must not be blank` };
  if (type === 'text' || type === 'enum') return value;
  if (type === 'date') {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) throw { code: 'INVALID_VALUE' as const, message: `invalid date for ${attribute}` };
    return value;
  }
  if (type === 'int') {
    if (!/^[+-]?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw { code: 'INVALID_VALUE' as const, message: `invalid integer for ${attribute}` };
    return Number(value);
  }
  if (type === 'number' || type === 'money') {
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value) || !Number.isFinite(Number(value))) throw { code: 'INVALID_VALUE' as const, message: `invalid number for ${attribute}` };
    return Number(value);
  }
  if (type === 'boolean') {
    if (/^(true|1|yes)$/i.test(value)) return true;
    if (/^(false|0|no)$/i.test(value)) return false;
    throw { code: 'INVALID_VALUE' as const, message: `invalid boolean for ${attribute}` };
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) throw new Error('map must be an object');
    return parsed;
  } catch {
    throw { code: 'INVALID_VALUE' as const, message: `invalid map JSON for ${attribute}` };
  }
}

export function materializeMarkdownRows(request: MarkdownRowMaterializationRequest): MarkdownRowMaterializationResult {
  const { mapped } = request;
  const sourceHeaders = mapped.headers.map((header) => header.source);
  const mapping = mapped.headers.map((header) => ({ ...header }));
  const children = childEntities(request.pack);
  const isChild = children.has(normalize(mapped.entity));
  const base = (row: { order: number; rowNumber: number; values: Record<string, string> }): MarkdownRowDiagnosticProvenance => ({
    ...mapped.provenance, headingPath: [...mapped.provenance.headingPath], rowNumber: row.rowNumber, order: row.order,
    rawValues: mapped.headers.map((header) => row.values[header.attribute] ?? ''), sourceHeaders: [...sourceHeaders], mapping: mapping.map((header) => ({ ...header })),
  });
  const rejected: RejectedMarkdownRow[] = [];
  const accepted: MaterializedMarkdownRow[] = [];
  const seen = new Set<string>();
  const reserved = new Set(['dataset_version', 'parent_id']);
  const parentValid = typeof request.parentId === 'string' && request.parentId.trim() !== '';

  for (const row of mapped.rows) {
    const provenance = base(row);
    const rawValues = [...provenance.rawValues];
    const reject = (code: MarkdownRowRejectionCode, message: string): void => { rejected.push({ entity: mapped.entity, code, message, rawValues, sourceHeaders: [...sourceHeaders], mapping: mapping.map((header) => ({ ...header })), provenance }); };
    const id = (row.values.id ?? '').trim();
    if (!id) { reject('MISSING_ID', 'id is required and must not be blank'); continue; }
    if (mapping.some((header) => reserved.has(normalize(header.attribute)))) { reject('RESERVED_FIELD', 'dataset_version and parent_id are system-owned fields'); continue; }
    if (isChild && !parentValid) { reject('PARENT_REQUIRED', 'child entity requires a valid parentId'); continue; }
    if (!isChild && request.parentId !== undefined) { reject('PARENT_NOT_ALLOWED', 'parentId is only allowed for child entities'); continue; }
    const key = `${normalize(mapped.entity)}\u0000${id}`;
    if (seen.has(key)) { reject('DUPLICATE_ID', `duplicate id ${id}`); continue; }
    try {
      const values: Record<string, unknown> = { id, dataset_version: request.datasetVersion };
      if (isChild) values.parent_id = request.parentId;
      for (const header of mapping) {
        const attribute = normalize(header.attribute);
        if (attribute === 'id') continue;
        const definition = definitionFor(request.pack, normalize(mapped.entity), attribute);
        if (definition === undefined) continue;
        values[attribute] = typed(row.values[header.attribute] ?? '', definition, attribute);
        const limits = typeof definition === 'string' ? undefined : definition;
        const candidate = values[attribute];
        if (limits && typeof candidate === 'number' && ((limits.min !== undefined && candidate < limits.min) || (limits.max !== undefined && candidate > limits.max))) throw { code: 'OUT_OF_RANGE' as const, message: `${attribute} is outside its allowed range` };
      }
      const from = values.valid_from;
      const to = values.valid_to;
      if (typeof from === 'string' && typeof to === 'string' && from > to) throw { code: 'DATE_ORDER' as const, message: 'valid_from must not be after valid_to' };
      accepted.push({ entity: mapped.entity, values, rawValues, sourceHeaders: [...sourceHeaders], mapping: mapping.map((header) => ({ ...header })), provenance });
      seen.add(key);
    } catch (error) {
      const issue = error as { code?: MarkdownRowRejectionCode; message?: string };
      reject(issue.code ?? 'INVALID_VALUE', issue.message ?? 'invalid value');
    }
  }
  return { publishable: rejected.length === 0, accepted, rejected };
}
