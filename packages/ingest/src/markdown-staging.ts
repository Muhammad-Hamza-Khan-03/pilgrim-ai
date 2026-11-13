import type {
  MarkdownRowDiagnosticProvenance,
  MarkdownRowMaterializationResult,
  MaterializedMarkdownRow,
  RejectedMarkdownRow,
} from './markdown-row-materialization.js';

export type MarkdownStagingSourceMetadata = { sourceId: string };
export type MarkdownStagingTableMetadata = Omit<MarkdownRowDiagnosticProvenance, 'rowNumber' | 'order' | 'rawValues' | 'sourceHeaders' | 'mapping'>;

export type MarkdownStagingRequest = {
  datasetVersion: number;
  results: MarkdownRowMaterializationResult[];
};

export type MarkdownStagingRejectedRow = RejectedMarkdownRow & {
  code: RejectedMarkdownRow['code'] | 'DUPLICATE_ID';
};

export type MarkdownStagingBatch = {
  status: 'staging';
  recommenderReady: false;
  datasetVersion: number;
  accepted: MaterializedMarkdownRow[];
  rejected: MarkdownStagingRejectedRow[];
  sources: MarkdownStagingSourceMetadata[];
  tables: MarkdownStagingTableMetadata[];
};

const clone = <T>(value: T): T => structuredClone(value);
const compare = (left: string, right: string): number => left.localeCompare(right);

function provenanceKey(provenance: MarkdownRowDiagnosticProvenance): string {
  return [provenance.sourceId, provenance.tableId, provenance.blockId, provenance.rowNumber, provenance.order].map(String).join('\u0000');
}

function rowKey(row: MaterializedMarkdownRow): string {
  const id = row.values.id;
  return `${row.entity}\u0000${typeof id === 'string' ? id : String(id)}`;
}

function rowCompare(left: MaterializedMarkdownRow, right: MaterializedMarkdownRow): number {
  return compare(rowKey(left), rowKey(right)) || compare(provenanceKey(left.provenance), provenanceKey(right.provenance));
}

function rejectedCompare(left: RejectedMarkdownRow, right: RejectedMarkdownRow): number {
  return compare(`${left.entity}\u0000${left.code}\u0000${left.message}`, `${right.entity}\u0000${right.code}\u0000${right.message}`)
    || compare(provenanceKey(left.provenance), provenanceKey(right.provenance));
}

function tableMetadata(provenance: MarkdownRowDiagnosticProvenance): MarkdownStagingTableMetadata {
  return {
    tableId: provenance.tableId,
    sourceId: provenance.sourceId,
    blockId: provenance.blockId,
    headingPath: clone(provenance.headingPath),
    startLine: provenance.startLine,
    endLine: provenance.endLine,
    headerRowNumber: provenance.headerRowNumber,
  };
}

export function stageMarkdownRows(request: MarkdownStagingRequest): MarkdownStagingBatch {
  const accepted = request.results.flatMap((result) => result.accepted).map(clone).sort(rowCompare);
  const propagatedRejected = request.results.flatMap((result) => result.rejected).map(clone);
  const rejected: MarkdownStagingRejectedRow[] = propagatedRejected;
  const unique: MaterializedMarkdownRow[] = [];
  const seen = new Set<string>();

  for (const row of accepted) {
    const key = rowKey(row);
    if (seen.has(key)) {
      rejected.push({
        entity: row.entity,
        code: 'DUPLICATE_ID',
        message: `duplicate entity/id ${row.entity}:${String(row.values.id)}`,
        rawValues: clone(row.rawValues),
        sourceHeaders: clone(row.sourceHeaders),
        mapping: clone(row.mapping),
        provenance: clone(row.provenance),
      });
      continue;
    }
    seen.add(key);
    unique.push(row);
  }

  const allProvenance = [...unique.map((row) => row.provenance), ...rejected.map((row) => row.provenance)];
  const sourceIds = [...new Set(allProvenance.map((provenance) => provenance.sourceId))].sort(compare);
  const tables = [...new Map(allProvenance.map((provenance) => [provenance.tableId, tableMetadata(provenance)])).values()]
    .sort((left, right) => compare(left.tableId, right.tableId));

  return {
    status: 'staging',
    recommenderReady: false,
    datasetVersion: request.datasetVersion,
    accepted: clone(unique),
    rejected: clone(rejected.sort(rejectedCompare)),
    sources: sourceIds.map((sourceId) => ({ sourceId })),
    tables: clone(tables),
  };
}
