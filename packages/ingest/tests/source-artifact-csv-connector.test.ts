import { describe, expect, it } from 'vitest';
import {
  MAX_SOURCE_ARTIFACT_BYTES,
  SourceArtifactError,
  createInMemorySourceArtifactStore,
  createSourceArtifact,
  ingestCsvSource,
  sourceArtifactKey,
} from '../src/index.js';

const bytes = new TextEncoder().encode('id,name,note\r\ncar-1,"A, B","line 1\r\nline 2"\r\n');

it('creates an exact, isolated content-addressed source artifact', () => {
  const artifact = createSourceArtifact(bytes, { kind: 'csv', filename: 'cars.csv' });
  expect(artifact.bytes).toEqual(bytes);
  expect(artifact.byteLength).toBe(bytes.byteLength);
  expect(artifact.key).toBe(sourceArtifactKey(artifact.sha256));
  expect(artifact.sourceId).toBe(artifact.sha256);
  expect(artifact.kind).toBe('csv');
  expect(artifact.filename).toBe('cars.csv');
  bytes[0] = 0;
  expect(artifact.bytes[0]).not.toBe(0);
  bytes[0] = 105;
});

it('rejects empty and oversized artifacts and unsafe key hashes', () => {
  expect(() => createSourceArtifact(new Uint8Array())).toThrowError(expect.objectContaining({ code: 'EMPTY_ARTIFACT' }));
  expect(() => createSourceArtifact(new Uint8Array(MAX_SOURCE_ARTIFACT_BYTES + 1))).toThrowError(expect.objectContaining({ code: 'ARTIFACT_TOO_LARGE' }));
  expect(() => sourceArtifactKey('../bad')).toThrowError(expect.objectContaining({ code: 'INVALID_HASH' }));
});

describe('in-memory source artifact adapter', () => {
  it('is idempotent for identical content and conflicts for a reused key', async () => {
    const store = createInMemorySourceArtifactStore();
    const first = createSourceArtifact(new TextEncoder().encode('same'));
    const second = createSourceArtifact(new TextEncoder().encode('same'));
    expect(await store.putIfAbsent(first)).toEqual({ status: 'stored', key: first.key });
    expect(await store.putIfAbsent(second)).toEqual({ status: 'exists', key: first.key });
    const different = { ...createSourceArtifact(new TextEncoder().encode('other')), key: first.key, sourceId: first.sourceId, sha256: first.sha256 };
    await expect(store.putIfAbsent(different)).rejects.toThrowError(expect.objectContaining({ code: 'KEY_CONTENT_CONFLICT' }));
    expect(await store.head(first.key)).toMatchObject({ key: first.key, byteLength: 4, sha256: first.sha256 });
    expect(await store.get(first.key)).toMatchObject({ key: first.key, bytes: new TextEncoder().encode('same') });
  });

  it('does not leave partial state after adapter failure', async () => {
    const store = createInMemorySourceArtifactStore({ fail: true });
    const artifact = createSourceArtifact(new TextEncoder().encode('failure'));
    await expect(store.putIfAbsent(artifact)).rejects.toThrowError(expect.objectContaining({ code: 'STORAGE_FAILURE' }));
    expect(await store.head(artifact.key)).toBeUndefined();
  });
});

describe('CSV connector', () => {
  it('stores, rereads, verifies, and returns a manifest usable by parseCsv', async () => {
    const store = createInMemorySourceArtifactStore();
    const result = await ingestCsvSource({ store, bytes, filename: 'cars.csv' });
    expect(result.manifest).toMatchObject({
      sourceId: result.artifact.sourceId,
      sha256: result.artifact.sha256,
      byteLength: bytes.byteLength,
      key: `sources/sha256/${result.artifact.sha256}`,
      kind: 'csv',
      filename: 'cars.csv',
    });
    expect(result.artifact.bytes).toEqual(bytes);
    expect(result.parsed.headers).toEqual(['id', 'name', 'note']);
    expect(result.parsed.rows[0]).toMatchObject({ rowNumber: 2, raw: 'car-1,"A, B","line 1\r\nline 2"', values: ['car-1', 'A, B', 'line 1\r\nline 2'] });
    expect(result.manifest.sources).toEqual({ cars: result.artifact });
  });

  it('rejects typed verification failures before returning a manifest', async () => {
    const store = createInMemorySourceArtifactStore();
    const artifact = createSourceArtifact(bytes);
    await store.putIfAbsent(artifact);
    const original = store.get.bind(store);
    store.get = async () => ({ ...(await original(artifact.key))!, bytes: new TextEncoder().encode('tampered') });
    await expect(ingestCsvSource({ store, bytes })).rejects.toThrowError(expect.objectContaining({ code: 'SOURCE_PROVENANCE_MISMATCH' }));
  });

  it('rejects malformed metadata and preserves connector genericity', async () => {
    const store = createInMemorySourceArtifactStore();
    await expect(ingestCsvSource({ store, bytes, kind: 'text' })).rejects.toThrowError(SourceArtifactError);
  });
});
