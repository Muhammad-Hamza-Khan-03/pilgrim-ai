import { describe, expect, it } from 'vitest';
import type {
  KnowledgeKeywordSearchRequest,
  KnowledgeRetrievalHit,
  KnowledgeRetrievalProvenance,
  KnowledgeRetrievalResult,
  KnowledgeKeywordRetriever,
} from '../src/knowledge-retrieval.js';

describe('Phase 2U knowledge retrieval contracts', () => {
  it('exposes storage-neutral keyword request, hit, and result shapes', () => {
    const provenance: KnowledgeRetrievalProvenance = {
      datasetVersion: 4, sourceId: 'source-1', chunkId: 'chunk-1', blockId: 'block-1', startLine: 2, endLine: 3,
    };
    const request: KnowledgeKeywordSearchRequest = { datasetVersion: 4, query: 'umrah', limit: 2 };
    const hit: KnowledgeRetrievalHit = { recordId: 'record-1', score: 1, text: 'Umrah guide', provenance };
    const result: KnowledgeRetrievalResult = { status: 'available', datasetVersion: request.datasetVersion, results: [hit] };
    const retriever: KnowledgeKeywordRetriever = { search: () => result };
    expect(retriever.search(request)).toEqual(result);
  });
});
