import { describe, expect, it } from 'vitest';
import {
  MAX_SOURCE_ARTIFACT_BYTES,
  SourceArtifactError,
  createInMemorySourceArtifactStore,
  createSourceArtifact,
  ingestMarkdownSource,
} from '../src/index.js';

const encoder = new TextEncoder();

const fixture = [
  'Preamble *verbatim*',
  '',
  '# Guide',
  'Intro with  two spaces  ',
  '```md',
  '# not a heading',
  '```',
  '',
  '## Details',
  'Detail line',
  '### Empty',
  '#### Deep',
  'Deep line',
  '',
  '## Second',
  'Second line',
].join('\r\n');

describe('Markdown connector', () => {
  it('stores exact UTF-8 bytes and returns deterministic source-preserving blocks', async () => {
    const store = createInMemorySourceArtifactStore();
    const bytes = encoder.encode(fixture);
    const first = await ingestMarkdownSource({ store, bytes, filename: 'guide.md' });
    const second = await ingestMarkdownSource({ store, bytes, filename: 'guide.md' });

    expect(first.artifact).toMatchObject({ kind: 'markdown', filename: 'guide.md', byteLength: bytes.byteLength });
    expect(first.artifact.bytes).toEqual(bytes);
    expect(first.document.source).toBe(first.artifact.sourceId);
    expect(first.document.text).toBe(fixture.replaceAll('\r\n', '\n'));
    expect(first.document.blocks).toEqual([
      { blockId: expect.any(String), headingPath: [], text: 'Preamble *verbatim*\n\n', startLine: 1, endLine: 2 },
      { blockId: expect.any(String), headingPath: ['Guide'], text: 'Intro with  two spaces  \n```md\n# not a heading\n```\n\n', startLine: 4, endLine: 8 },
      { blockId: expect.any(String), headingPath: ['Guide', 'Details'], text: 'Detail line\n', startLine: 10, endLine: 10 },
      { blockId: expect.any(String), headingPath: ['Guide', 'Details', 'Empty', 'Deep'], text: 'Deep line\n\n', startLine: 13, endLine: 14 },
      { blockId: expect.any(String), headingPath: ['Guide', 'Second'], text: 'Second line', startLine: 16, endLine: 16 },
    ]);
    expect(first.document.blocks).toEqual(second.document.blocks);
    expect(first.manifest).toMatchObject({
      sourceId: first.artifact.sourceId,
      sha256: first.artifact.sha256,
      byteLength: bytes.byteLength,
      key: first.artifact.key,
      kind: 'markdown',
    });
  });

  it('supports string input, ATX levels one through six, and omits empty blocks', async () => {
    const result = await ingestMarkdownSource({
      store: createInMemorySourceArtifactStore(),
      bytes: '###### Six\ncontent\n####### not heading\n#\n# Closing ###\nlast',
    });
    expect(result.document.blocks).toEqual([
      { blockId: expect.any(String), headingPath: ['Six'], text: 'content\n####### not heading\n', startLine: 2, endLine: 3 },
      { blockId: expect.any(String), headingPath: ['Closing'], text: 'last', startLine: 6, endLine: 6 },
    ]);
  });

  it('rejects wrong kind, invalid UTF-8, empty, and oversized input', async () => {
    const store = createInMemorySourceArtifactStore();
    await expect(ingestMarkdownSource({ store, bytes: encoder.encode('ok'), kind: 'text' })).rejects.toThrowError(expect.objectContaining({ code: 'INVALID_SOURCE_KIND' }));
    await expect(ingestMarkdownSource({ store, bytes: new Uint8Array([0xc3, 0x28]) })).rejects.toThrowError(expect.objectContaining({ code: 'INVALID_TEXT_ENCODING' }));
    await expect(ingestMarkdownSource({ store, bytes: new Uint8Array() })).rejects.toThrowError(expect.objectContaining({ code: 'EMPTY_ARTIFACT' }));
    await expect(ingestMarkdownSource({ store, bytes: new Uint8Array(MAX_SOURCE_ARTIFACT_BYTES + 1) })).rejects.toThrowError(expect.objectContaining({ code: 'ARTIFACT_TOO_LARGE' }));
  });

  it('rejects missing, tampered, forged metadata, and forged key on read-back', async () => {
    const bytes = encoder.encode('# Title\nbody');
    const artifact = createSourceArtifact(bytes, { kind: 'markdown' });
    const missing: import('../src/index.js').SourceArtifactStore = {
      putIfAbsent: async () => ({ status: 'stored', key: artifact.key }), get: async () => undefined, head: async () => undefined,
    };
    await expect(ingestMarkdownSource({ store: missing, bytes })).rejects.toThrowError(expect.objectContaining({ code: 'STORAGE_MISSING' }));

    for (const mutate of [
      (a: import('../src/index.js').SourceArtifact) => ({ ...a, bytes: encoder.encode('tampered') }),
      (a: import('../src/index.js').SourceArtifact) => ({ ...a, byteLength: a.byteLength + 1 }),
      (a: import('../src/index.js').SourceArtifact) => ({ ...a, key: 'sources/sha256/' + '0'.repeat(64) }),
      (a: import('../src/index.js').SourceArtifact) => ({ ...a, kind: 'text' as const }),
    ]) {
      const store = createInMemorySourceArtifactStore();
      await store.putIfAbsent(artifact);
      const original = store.get.bind(store);
      store.get = async () => mutate((await original(artifact.key))!);
      await expect(ingestMarkdownSource({ store, bytes })).rejects.toThrowError(SourceArtifactError);
    }
  });

  it('does not mutate caller-owned input or publish catalog rows', async () => {
    const bytes = encoder.encode('# Title\nbody');
    const before = new Uint8Array(bytes);
    const result = await ingestMarkdownSource({ store: createInMemorySourceArtifactStore(), bytes });
    expect(bytes).toEqual(before);
    expect(result).not.toHaveProperty('rows');
    expect(result).not.toHaveProperty('catalog');
  });
});
