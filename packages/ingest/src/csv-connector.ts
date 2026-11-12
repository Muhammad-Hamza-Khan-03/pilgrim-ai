import { createSourceArtifact, type SourceArtifact, type SourceArtifactKind, type SourceArtifactStore, verifySourceArtifact, SourceArtifactError } from './source-artifact.js';
import { parseCsv, type ParsedCsv } from './index.js';

export interface CsvSourceManifest {
  sourceId: string;
  sha256: string;
  byteLength: number;
  key: string;
  kind: 'csv';
  filename?: string;
  sources: Record<string, SourceArtifact>;
}

export interface CsvConnectorRequest {
  store: SourceArtifactStore;
  bytes: Uint8Array | string;
  filename?: string;
  sourceKey?: string;
  kind?: SourceArtifactKind;
}

export interface CsvConnectorResult {
  artifact: SourceArtifact;
  manifest: CsvSourceManifest;
  parsed: ParsedCsv;
}

function defaultSourceKey(filename?: string): string {
  const base = filename?.split(/[\\/]/).at(-1)?.replace(/\.csv$/i, '');
  return base && /^[A-Za-z0-9_-]+$/.test(base) ? base : 'csv';
}

export async function ingestCsvSource(request: CsvConnectorRequest): Promise<CsvConnectorResult> {
  if (request.kind !== undefined && request.kind !== 'csv') {
    throw new SourceArtifactError('INVALID_SOURCE_KIND', 'CSV connector requires source kind csv');
  }
  const bytes = typeof request.bytes === 'string' ? new TextEncoder().encode(request.bytes) : request.bytes;
  const artifact = createSourceArtifact(bytes, { kind: 'csv', filename: request.filename });
  await request.store.putIfAbsent(artifact);
  const stored = await request.store.get(artifact.key);
  if (!stored) throw new SourceArtifactError('STORAGE_MISSING', 'stored source artifact could not be read back');
  verifySourceArtifact(stored);
  if (!Buffer.from(stored.bytes).equals(Buffer.from(artifact.bytes))) {
    throw new SourceArtifactError('SOURCE_PROVENANCE_MISMATCH', 'read-back source bytes differ from the supplied bytes');
  }
  const parsed = parseCsv(stored.bytes);
  const sourceKey = request.sourceKey ?? defaultSourceKey(request.filename);
  const manifest: CsvSourceManifest = {
    sourceId: stored.sourceId,
    sha256: stored.sha256,
    byteLength: stored.byteLength,
    key: stored.key,
    kind: 'csv',
    ...(stored.filename === undefined ? {} : { filename: stored.filename }),
    sources: { [sourceKey]: stored },
  };
  return { artifact: stored, manifest, parsed };
}
