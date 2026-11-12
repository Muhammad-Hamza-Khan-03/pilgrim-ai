import { createHash } from 'node:crypto';

export const MAX_SOURCE_ARTIFACT_BYTES = 10 * 1024 * 1024;
export const SOURCE_ARTIFACT_PREFIX = 'sources/sha256/';
export type SourceArtifactKind = 'csv' | 'markdown' | 'text';

export class SourceArtifactError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SourceArtifactError';
    this.code = code;
  }
}

export interface SourceArtifactOptions {
  kind?: SourceArtifactKind;
  filename?: string;
}

export interface SourceArtifact {
  sourceId: string;
  sha256: string;
  byteLength: number;
  key: string;
  kind: SourceArtifactKind;
  filename?: string;
  bytes: Uint8Array;
}

export interface SourceArtifactHead {
  sourceId: string;
  sha256: string;
  byteLength: number;
  key: string;
  kind: SourceArtifactKind;
  filename?: string;
}

export type PutIfAbsentResult = { status: 'stored' | 'exists'; key: string };

export interface SourceArtifactStore {
  putIfAbsent(artifact: SourceArtifact): Promise<PutIfAbsentResult>;
  get(key: string): Promise<SourceArtifact | undefined>;
  head(key: string): Promise<SourceArtifactHead | undefined>;
}

function assertHash(hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new SourceArtifactError('INVALID_HASH', 'source hash must be a lowercase SHA-256 hex digest');
}

export function sourceArtifactKey(sha256: string): string {
  assertHash(sha256);
  return `${SOURCE_ARTIFACT_PREFIX}${sha256}`;
}

function cloneArtifact(artifact: SourceArtifact): SourceArtifact {
  return { ...artifact, bytes: new Uint8Array(artifact.bytes) };
}

export function verifySourceArtifact(artifact: SourceArtifact): void {
  const hash = createHash('sha256').update(artifact.bytes).digest('hex');
  if (
    artifact.sourceId !== hash ||
    artifact.sha256 !== hash ||
    artifact.byteLength !== artifact.bytes.byteLength ||
    artifact.key !== sourceArtifactKey(hash)
  ) {
    throw new SourceArtifactError('SOURCE_PROVENANCE_MISMATCH', 'source artifact metadata does not match its exact bytes');
  }
  if (artifact.bytes.byteLength === 0) throw new SourceArtifactError('EMPTY_ARTIFACT', 'source artifact must not be empty');
  if (artifact.bytes.byteLength > MAX_SOURCE_ARTIFACT_BYTES) throw new SourceArtifactError('ARTIFACT_TOO_LARGE', 'source artifact exceeds the 10 MiB limit');
}

export function createSourceArtifact(bytes: Uint8Array, options: SourceArtifactOptions = {}): SourceArtifact {
  const copy = new Uint8Array(bytes);
  if (copy.byteLength === 0) throw new SourceArtifactError('EMPTY_ARTIFACT', 'source artifact must not be empty');
  if (copy.byteLength > MAX_SOURCE_ARTIFACT_BYTES) throw new SourceArtifactError('ARTIFACT_TOO_LARGE', 'source artifact exceeds the 10 MiB limit');
  const sha256 = createHash('sha256').update(copy).digest('hex');
  const artifact: SourceArtifact = {
    sourceId: sha256,
    sha256,
    byteLength: copy.byteLength,
    key: sourceArtifactKey(sha256),
    kind: options.kind ?? 'text',
    ...(options.filename === undefined ? {} : { filename: options.filename }),
    bytes: copy,
  };
  verifySourceArtifact(artifact);
  return artifact;
}

export interface InMemorySourceArtifactStoreOptions { fail?: boolean; }

export function createInMemorySourceArtifactStore(options: InMemorySourceArtifactStoreOptions = {}): SourceArtifactStore {
  const objects = new Map<string, SourceArtifact>();
  return {
    async putIfAbsent(input) {
      if (options.fail) throw new SourceArtifactError('STORAGE_FAILURE', 'source artifact storage failed');
      const existing = objects.get(input.key);
      if (existing) {
        if (existing.byteLength !== input.bytes.byteLength || !Buffer.from(existing.bytes).equals(Buffer.from(input.bytes))) {
          throw new SourceArtifactError('KEY_CONTENT_CONFLICT', 'source object key already contains different bytes');
        }
        verifySourceArtifact(input);
        return { status: 'exists', key: input.key };
      }
      verifySourceArtifact(input);
      const artifact = cloneArtifact(input);
      objects.set(artifact.key, artifact);
      return { status: 'stored', key: artifact.key };
    },
    async get(key) {
      const artifact = objects.get(key);
      return artifact ? cloneArtifact(artifact) : undefined;
    },
    async head(key) {
      const artifact = objects.get(key);
      if (!artifact) return undefined;
      const { bytes: _bytes, ...head } = cloneArtifact(artifact);
      return head;
    },
  };
}
