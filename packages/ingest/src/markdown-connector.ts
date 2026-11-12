import { createHash } from 'node:crypto';
import {
  createSourceArtifact,
  SourceArtifactError,
  type SourceArtifact,
  type SourceArtifactKind,
  type SourceArtifactStore,
  verifySourceArtifact,
} from './source-artifact.js';

export interface MarkdownBlock {
  blockId: string;
  headingPath: string[];
  text: string;
  startLine: number;
  endLine: number;
}

export interface MarkdownDocument {
  source: string;
  text: string;
  blocks: MarkdownBlock[];
}

export interface MarkdownSourceManifest {
  sourceId: string;
  sha256: string;
  byteLength: number;
  key: string;
  kind: 'markdown';
  filename?: string;
}

export interface MarkdownConnectorRequest {
  store: SourceArtifactStore;
  bytes: Uint8Array | string;
  filename?: string;
  kind?: SourceArtifactKind;
}

export interface MarkdownConnectorResult {
  artifact: SourceArtifact;
  manifest: MarkdownSourceManifest;
  document: MarkdownDocument;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SourceArtifactError('INVALID_TEXT_ENCODING', 'source artifact is not valid UTF-8');
  }
}

function heading(line: string): { level: number; title: string } | undefined {
  const match = /^( {0,3})(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
  if (!match) return undefined;
  const title = (match[3] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim();
  return { level: match[2].length, title };
}

function isFence(line: string): boolean {
  return /^ {0,3}(`{3,}|~{3,})/.test(line);
}

function isFenceClose(line: string): { char: string; length: number } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return match ? { char: match[1][0], length: match[1].length } : undefined;
}

function blockId(normalizedText: string, startLine: number, endLine: number, headingPath: string[], text: string): string {
  return `markdown-${createHash('sha256').update(normalizedText).update('\0').update(String(startLine)).update('\0').update(String(endLine)).update('\0').update(headingPath.join('\0')).update('\0').update(text).digest('hex')}`;
}

function convertMarkdown(sourceId: string, text: string): MarkdownDocument {
  const lines = text.split('\n');
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) { lineStarts.push(offset); offset += line.length + 1; }
  const blocks: MarkdownBlock[] = [];
  const path: string[] = [];
  let pendingStart = 0;
  let inFence = false;
  let fenceChar = '';
  let fenceLength = 0;

  const flush = (endLineIndex: number): void => {
    const segment = text.slice(lineStarts[pendingStart] ?? text.length, lineStarts[endLineIndex] ?? text.length);
    if (segment.trim().length === 0) return;
    const startLine = pendingStart + 1;
    const endLine = endLineIndex;
    blocks.push({
      blockId: blockId(text, startLine, endLine, path, segment),
      headingPath: [...path],
      text: segment,
      startLine,
      endLine,
    });
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (isFence(line)) {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)![1];
      if (!inFence) { inFence = true; fenceChar = marker[0]; fenceLength = marker.length; }
      else {
        const close = isFenceClose(line);
        if (close?.char === fenceChar && close.length >= fenceLength) inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const parsed = heading(line);
    if (!parsed) continue;
    flush(index);
    path.length = Math.min(path.length, parsed.level - 1);
    path.push(parsed.title);
    pendingStart = index + 1;
  }
  flush(lines.length);
  return { source: sourceId, text, blocks };
}

export async function ingestMarkdownSource(request: MarkdownConnectorRequest): Promise<MarkdownConnectorResult> {
  if (request.kind !== undefined && request.kind !== 'markdown') {
    throw new SourceArtifactError('INVALID_SOURCE_KIND', 'Markdown connector requires source kind markdown');
  }
  const bytes = typeof request.bytes === 'string' ? new TextEncoder().encode(request.bytes) : new Uint8Array(request.bytes);
  const artifact = createSourceArtifact(bytes, { kind: 'markdown', filename: request.filename });
  const put = await request.store.putIfAbsent(artifact);
  if (put.key !== artifact.key) throw new SourceArtifactError('SOURCE_PROVENANCE_MISMATCH', 'source store returned a different artifact key');
  const stored = await request.store.get(artifact.key);
  if (!stored) throw new SourceArtifactError('STORAGE_MISSING', 'stored source artifact could not be read back');
  const head = await request.store.head(artifact.key);
  if (!head) throw new SourceArtifactError('STORAGE_MISSING', 'stored source artifact metadata could not be read back');
  if (head.sourceId !== artifact.sourceId || head.sha256 !== artifact.sha256 || head.byteLength !== artifact.byteLength || head.key !== artifact.key || head.kind !== 'markdown') {
    throw new SourceArtifactError('SOURCE_PROVENANCE_MISMATCH', 'read-back source metadata differs from the supplied bytes');
  }
  if (stored.kind !== 'markdown') throw new SourceArtifactError('INVALID_SOURCE_KIND', 'stored source artifact is not markdown');
  try { verifySourceArtifact(stored); } catch (error) {
    if (error instanceof SourceArtifactError) throw error;
    throw new SourceArtifactError('SOURCE_PROVENANCE_MISMATCH', 'stored source artifact metadata is invalid');
  }
  if (stored.byteLength !== artifact.byteLength || stored.sha256 !== artifact.sha256 || stored.sourceId !== artifact.sourceId || stored.key !== artifact.key || !Buffer.from(stored.bytes).equals(Buffer.from(artifact.bytes))) {
    throw new SourceArtifactError('SOURCE_PROVENANCE_MISMATCH', 'read-back source bytes or metadata differ from the supplied bytes');
  }
  const text = decodeUtf8(stored.bytes).replace(/\r\n?/g, '\n');
  const document = convertMarkdown(stored.sourceId, text);
  return {
    artifact: stored,
    manifest: {
      sourceId: stored.sourceId,
      sha256: stored.sha256,
      byteLength: stored.byteLength,
      key: stored.key,
      kind: 'markdown',
      ...(stored.filename === undefined ? {} : { filename: stored.filename }),
    },
    document,
  };
}
