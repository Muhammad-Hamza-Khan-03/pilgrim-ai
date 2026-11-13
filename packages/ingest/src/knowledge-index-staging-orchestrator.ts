import { stageKnowledgeIndex } from './knowledge-index-staging-pipeline.js';
import type {
  KnowledgeIndexStagingPipelineRequest,
  KnowledgeIndexStagingPipelineResult,
} from './knowledge-index-staging-pipeline.js';

export type KnowledgeIndexStagingOrchestratorOptions = {
  readonly maxWriteAttempts?: number;
  readonly maxCleanupAttempts?: number;
};

export type KnowledgeIndexStagingOrchestratorResult = {
  readonly status: 'staged';
  readonly indexed: false;
  readonly datasetVersion: number;
  readonly pipeline: KnowledgeIndexStagingPipelineResult;
  readonly writeAttempts: number;
  readonly cleanupAttempts: number;
  readonly replay: boolean;
};

export const KNOWLEDGE_INDEX_STAGING_ORCHESTRATION_ERROR_CODES = [
  'WRITE_FAILED',
  'CLEANUP_FAILED',
  'RETRY_EXHAUSTED',
  'DATASET_CONFLICT',
] as const;

export type KnowledgeIndexStagingOrchestrationErrorCode =
  typeof KNOWLEDGE_INDEX_STAGING_ORCHESTRATION_ERROR_CODES[number];

export class KnowledgeIndexStagingOrchestrationError extends Error {
  readonly code: KnowledgeIndexStagingOrchestrationErrorCode;
  readonly datasetVersion: number;
  readonly writeAttempts: number;
  readonly cleanupAttempts: number;
  readonly cause: unknown;

  constructor(
    code: KnowledgeIndexStagingOrchestrationErrorCode,
    message: string,
    details: {
      datasetVersion: number;
      writeAttempts: number;
      cleanupAttempts: number;
      cause: unknown;
    },
  ) {
    super(message);
    this.name = 'KnowledgeIndexStagingOrchestrationError';
    this.code = code;
    this.datasetVersion = details.datasetVersion;
    this.writeAttempts = details.writeAttempts;
    this.cleanupAttempts = details.cleanupAttempts;
    this.cause = details.cause;
  }
}

const MAX_REASONABLE_ATTEMPTS = 100;

function validateAttempts(value: number | undefined, name: string, defaultValue: number): number {
  const attempts = value ?? defaultValue;
  if (!Number.isInteger(attempts) || attempts <= 0 || attempts > MAX_REASONABLE_ATTEMPTS) {
    throw new RangeError(`${name} must be a positive integer no greater than ${MAX_REASONABLE_ATTEMPTS}`);
  }
  return attempts;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined;
}

function orchestrationCode(error: unknown): KnowledgeIndexStagingOrchestrationErrorCode {
  return errorCode(error) === 'DATASET_CONFLICT' || errorCode(error) === 'VERSION_CONFLICT'
    ? 'DATASET_CONFLICT' : 'WRITE_FAILED';
}

function makeError(
  code: KnowledgeIndexStagingOrchestrationErrorCode,
  datasetVersion: number,
  writeAttempts: number,
  cleanupAttempts: number,
  cause: unknown,
): KnowledgeIndexStagingOrchestrationError {
  return new KnowledgeIndexStagingOrchestrationError(
    code,
    `${code} while staging dataset version ${datasetVersion}`,
    { datasetVersion, writeAttempts, cleanupAttempts, cause },
  );
}

/**
 * Coordinates complete, dataset-scoped staging writes without activating or publishing them.
 * A failed write makes both stores suspect; cleanup must finish before any replay.
 */
export function orchestrateKnowledgeIndexStaging(
  request: KnowledgeIndexStagingPipelineRequest,
  options: KnowledgeIndexStagingOrchestratorOptions = {},
): Promise<KnowledgeIndexStagingOrchestratorResult> {
  const maxWriteAttempts = validateAttempts(options.maxWriteAttempts, 'maxWriteAttempts', 3);
  const maxCleanupAttempts = validateAttempts(options.maxCleanupAttempts, 'maxCleanupAttempts', 2);
  const datasetVersion = request.staging.datasetVersion;

  return (async () => {
    let writeAttempts = 0;
    let cleanupAttempts = 0;
    let lastWriteError: unknown;

    while (writeAttempts < maxWriteAttempts) {
      writeAttempts++;
      let writeStarted = false;
      const pipelineRequest: KnowledgeIndexStagingPipelineRequest = {
        ...request,
        fts: {
          ...request.fts,
          upsertStaging: async (batch) => {
            writeStarted = true;
            return request.fts.upsertStaging(batch);
          },
        },
        vectors: {
          ...request.vectors,
          upsertStaging: async (batch) => {
            writeStarted = true;
            return request.vectors.upsertStaging(batch);
          },
        },
      };
      try {
        const pipeline = await stageKnowledgeIndex(pipelineRequest);
        return {
          status: 'staged' as const,
          indexed: false as const,
          datasetVersion,
          pipeline,
          writeAttempts,
          cleanupAttempts,
          replay: writeAttempts > 1,
        };
      } catch (error) {
        if (!writeStarted) throw error;
        lastWriteError = error;
        let cleanupError: unknown;
        let cleaned = false;
        while (cleanupAttempts < maxCleanupAttempts) {
          cleanupAttempts++;
          const cleanupResults = await Promise.allSettled([
            request.fts.removeStagingDataset(datasetVersion),
            request.vectors.removeStagingDataset(datasetVersion),
          ]);
          const rejected = cleanupResults.find((result): result is PromiseRejectedResult => result.status === 'rejected');
          if (!rejected) {
            cleaned = true;
            break;
          }
          cleanupError = rejected.reason;
        }
        if (!cleaned) {
          throw makeError('CLEANUP_FAILED', datasetVersion, writeAttempts, cleanupAttempts, cleanupError ?? lastWriteError);
        }
        if (writeAttempts >= maxWriteAttempts) {
          throw makeError('RETRY_EXHAUSTED', datasetVersion, writeAttempts, cleanupAttempts, lastWriteError);
        }
        if (orchestrationCode(lastWriteError) === 'DATASET_CONFLICT') {
          throw makeError('DATASET_CONFLICT', datasetVersion, writeAttempts, cleanupAttempts, lastWriteError);
        }
      }
    }

    throw makeError('RETRY_EXHAUSTED', datasetVersion, writeAttempts, cleanupAttempts, lastWriteError);
  })();
}
