import { createHash } from 'node:crypto';
import type { StagingDiffResult } from './staging-diff.js';

export type ReviewStatus = 'pending' | 'approved' | 'rejected';
export interface VersionManifest {
  version: string;
  parentVersion?: string;
  source: StagingDiffResult['sources']['candidate'];
  snapshotDigest: string;
  status: 'staging';
  recommenderReady: false;
}
export interface VersionReview {
  status: ReviewStatus;
  approved: boolean;
  reviewer?: string;
  reviewedAt?: string;
  reason?: string;
  snapshotDigest?: string;
}
export interface VersionLifecycle {
  manifest: VersionManifest;
  review: VersionReview;
  diff: StagingDiffResult['diff'];
}
export interface ReviewRequest {
  status: 'approved' | 'rejected';
  reviewer: string;
  reviewedAt: string;
  reason?: string;
  snapshotDigest?: string;
  expectedSnapshotDigest?: string;
}
export interface PublishPlan {
  version: string;
  expectedActiveVersion?: string;
  upserts: Array<{ entity: VersionedEntity; id: string }>;
  cache: { bump: true };
}
export interface RollbackRequest {
  activeVersion: string;
  targetVersion: string;
  previouslyPublished: readonly string[];
}
export interface RollbackPlan {
  targetVersion: string;
  expectedActiveVersion: string;
  cache: { bump: true };
  historyMutation: false;
}
export type VersionedEntity = 'hotels' | 'rooms' | 'rates' | 'periods' | 'blankCells';

export class VersionLifecycleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'VersionLifecycleError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function serialize(value: unknown): string { return JSON.stringify(canonical(value)); }
function digest(value: unknown): string { return createHash('sha256').update(serialize(value)).digest('hex'); }
function lifecycleContentDigest(lifecycle: Pick<VersionLifecycle, 'manifest' | 'diff'>): string {
  return digest({ source: lifecycle.manifest.source, diff: lifecycle.diff });
}
function copy<T>(value: T): T { return structuredClone(value); }
function requireVersion(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new VersionLifecycleError('INVALID_VERSION', `${label} must be a non-empty opaque version`);
  return value;
}
function requireLifecycle(value: unknown): asserts value is VersionLifecycle {
  if (!isRecord(value) || !isRecord(value.manifest) || !isRecord(value.review) || !isRecord(value.diff)) throw new VersionLifecycleError('INVALID_LIFECYCLE', 'lifecycle must be a version lifecycle');
  requireVersion(value.manifest.version, 'version');
  if (value.manifest.parentVersion !== undefined) requireVersion(value.manifest.parentVersion, 'parentVersion');
  if (value.manifest.status !== 'staging' || value.manifest.recommenderReady !== false) throw new VersionLifecycleError('INVALID_MANIFEST', 'manifest must remain staging and recommender-disabled');
}

export function createVersionLifecycle(result: StagingDiffResult): VersionLifecycle {
  if (!isRecord(result) || !isRecord(result.version) || !isRecord(result.sources) || !isRecord(result.review) || !isRecord(result.diff)) throw new VersionLifecycleError('INVALID_DIFF', 'a staging diff result is required');
  const version = requireVersion(result.version.candidateVersion, 'candidateVersion');
  const parentVersion = result.version.parentVersion === undefined ? undefined : requireVersion(result.version.parentVersion, 'parentVersion');
  if (!isRecord(result.sources.candidate)) throw new VersionLifecycleError('INVALID_SOURCE', 'candidate source is required');
  if (result.review.status !== 'pending' || result.review.approved !== false) throw new VersionLifecycleError('INVALID_DIFF', 'only a pending, unapproved staging diff may enter the lifecycle');
  const snapshotDigest = digest({ source: result.sources.candidate, diff: result.diff });
  return {
    manifest: {
      version,
      ...(parentVersion === undefined ? {} : { parentVersion }),
      source: copy(result.sources.candidate),
      snapshotDigest,
      status: 'staging',
      recommenderReady: false,
    },
    review: { status: 'pending', approved: false },
    diff: copy(result.diff),
  };
}

export function createReview(lifecycle: VersionLifecycle, request: ReviewRequest): VersionLifecycle {
  requireLifecycle(lifecycle);
  if (lifecycle.review.status !== 'pending') throw new VersionLifecycleError('REVIEW_TERMINAL', 'a review may only be created from pending');
  if (!isRecord(request) || (request.status !== 'approved' && request.status !== 'rejected') || typeof request.reviewer !== 'string' || request.reviewer.trim() === '' || typeof request.reviewedAt !== 'string' || Number.isNaN(Date.parse(request.reviewedAt)) || new Date(request.reviewedAt).toISOString() !== request.reviewedAt) {
    throw new VersionLifecycleError('INVALID_REVIEW', 'review status, non-empty reviewer, and exact ISO timestamp are required');
  }
  if (request.status === 'rejected' && request.reason !== undefined && (typeof request.reason !== 'string' || request.reason.trim() === '')) throw new VersionLifecycleError('INVALID_REVIEW', 'rejection reason must be non-empty when supplied');
  const currentDigest = lifecycleContentDigest(lifecycle);
  const expectedDigest = request.snapshotDigest ?? request.expectedSnapshotDigest;
  if (expectedDigest !== undefined && expectedDigest !== currentDigest) throw new VersionLifecycleError('SNAPSHOT_DIGEST_MISMATCH', 'review digest does not match the lifecycle snapshot');
  return { manifest: copy(lifecycle.manifest), diff: copy(lifecycle.diff), review: { status: request.status, approved: request.status === 'approved', reviewer: request.reviewer.trim(), reviewedAt: request.reviewedAt, ...(request.reason === undefined ? {} : { reason: request.reason.trim() }), snapshotDigest: currentDigest } };
}

export function createPublishPlan(lifecycle: VersionLifecycle, request: { activeVersion?: string } = {}): PublishPlan {
  requireLifecycle(lifecycle);
  if (lifecycle.review.status !== 'approved' || lifecycle.review.approved !== true) throw new VersionLifecycleError('REVIEW_NOT_APPROVED', 'only an approved review may publish');
  if (lifecycle.review.snapshotDigest !== lifecycle.manifest.snapshotDigest || lifecycleContentDigest(lifecycle) !== lifecycle.manifest.snapshotDigest) throw new VersionLifecycleError('SNAPSHOT_DIGEST_MISMATCH', 'approved lifecycle content no longer matches its snapshot digest');
  if (lifecycle.manifest.parentVersion !== undefined && lifecycle.manifest.parentVersion !== request.activeVersion) throw new VersionLifecycleError('ACTIVE_PARENT_MISMATCH', 'active version does not match the manifest parent');
  if (lifecycle.manifest.parentVersion === undefined && request.activeVersion !== undefined) throw new VersionLifecycleError('ACTIVE_PARENT_MISMATCH', 'an initial version cannot replace an active parent');
  const entities: VersionedEntity[] = ['hotels', 'rooms', 'rates', 'periods', 'blankCells'];
  const upserts = entities.flatMap((entity) => {
    const diff = lifecycle.diff[entity];
    return [...diff.added.map(({ id }) => ({ entity, id })), ...diff.changed.map(({ id }) => ({ entity, id }))].sort((a, b) => a.id.localeCompare(b.id));
  });
  return { version: lifecycle.manifest.version, ...(request.activeVersion === undefined ? {} : { expectedActiveVersion: request.activeVersion }), upserts, cache: { bump: true } };
}

export function createRollbackPlan(lifecycle: VersionLifecycle, request: RollbackRequest): RollbackPlan {
  requireLifecycle(lifecycle);
  if (!isRecord(request) || !Array.isArray(request.previouslyPublished)) throw new VersionLifecycleError('INVALID_ROLLBACK', 'rollback requires distinct active and target versions plus publication history');
  const activeVersion = requireVersion(request.activeVersion, 'activeVersion');
  const targetVersion = requireVersion(request.targetVersion, 'targetVersion');
  const previouslyPublished = request.previouslyPublished.map((version) => requireVersion(version, 'previouslyPublished version'));
  if (activeVersion === targetVersion) throw new VersionLifecycleError('INVALID_ROLLBACK', 'rollback active and target versions must differ');
  if (!previouslyPublished.includes(targetVersion)) throw new VersionLifecycleError('NOT_PUBLISHED', 'rollback target was not previously published');
  return { targetVersion, expectedActiveVersion: activeVersion, cache: { bump: true }, historyMutation: false };
}

export function serializeVersionLifecycle(value: VersionLifecycle): string { requireLifecycle(value); return serialize(value); }
