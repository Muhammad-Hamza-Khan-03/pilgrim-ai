export type KnowledgeRetrievalProvenance = Readonly<{
  datasetVersion: number;
  sourceId: string;
  chunkId: string;
  blockId: string;
  startLine: number;
  endLine: number;
}>;

export type KnowledgeRetrievalHit = Readonly<{
  recordId: string;
  score: number;
  text?: string;
  provenance: KnowledgeRetrievalProvenance;
}>;

export type KnowledgeRetrievalRecord = Readonly<{
  recordId: string;
  text?: string;
  vector?: readonly number[];
  provenance: KnowledgeRetrievalProvenance;
}>;

export type KnowledgeKeywordSearchRequest = Readonly<{
  datasetVersion: number;
  query: string;
  limit: number;
}>;

export type KnowledgeVectorSearchRequest = Readonly<{
  datasetVersion: number;
  query: readonly number[];
  limit: number;
}>;

export type KnowledgeRetrievalAvailableResult = Readonly<{
  status: 'available';
  datasetVersion: number;
  results: readonly KnowledgeRetrievalHit[];
}>;

export type KnowledgeRetrievalUnavailableResult = Readonly<{
  status: 'unavailable';
  reason: 'index-unavailable';
  results: readonly [];
}>;

export type KnowledgeRetrievalResult = KnowledgeRetrievalAvailableResult | KnowledgeRetrievalUnavailableResult;

export interface KnowledgeKeywordRetriever {
  search(request: KnowledgeKeywordSearchRequest): KnowledgeRetrievalResult;
}

export interface KnowledgeVectorRetriever {
  search(request: KnowledgeVectorSearchRequest): KnowledgeRetrievalResult;
}
