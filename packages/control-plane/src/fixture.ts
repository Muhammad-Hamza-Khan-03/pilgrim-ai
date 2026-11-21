// Deterministic, local-only fixture. Built through the real ingest lifecycle/publication contracts.
import type { GroundedTurnResult } from '@pilgrim/engine';
import { createInMemoryPublicationStore, createReview, createSourceArtifact, createVersionLifecycle, publishToStore, SourceArtifactError } from '@pilgrim/ingest';
import type { StagingDiffResult, VersionLifecycle } from '@pilgrim/ingest';
import type { HostConfigInput } from '@pilgrim/widget';
import type { ControlPlaneState, SessionRow } from './index.js';

export const FIXTURE_TIME = '2026-11-21T00:00:00.000Z';

const bytes = (s: string) => new TextEncoder().encode(s);
const none = { added: [], removed: [], changed: [] };
function stagingDiff(version: string, parent: string | undefined, file: string): StagingDiffResult {
  const a = createSourceArtifact(bytes(`${file}\n${version}`), { kind: 'csv', filename: file });
  const diff = {
    hotels: { added: [{ id: `hotel-${version}`, record: { id: `hotel-${version}` } as never, reasons: ['entity lifecycle' as const] }], removed: [], changed: [] },
    rooms: none,
    rates: { added: [], removed: [], changed: [{ id: `rate-${version}`, before: { id: 'r' } as never, after: { id: 'r' } as never, reasons: ['price' as const] }] },
    periods: none,
    blankCells: none,
  };
  return { version: { parentVersion: parent as string, candidateVersion: version }, sources: { candidate: { sourceId: a.sourceId, sha256: a.sha256, byteLength: a.byteLength, rowCount: 2 } as never }, review: { status: 'pending', approved: false }, diff };
}

export interface FixtureOptions { sessions?: SessionRow[] | null; widget?: HostConfigInput; failedJobs?: boolean; staged?: boolean }
export type FixtureTurn = Pick<GroundedTurnResult, 'status' | 'intent'> & { codes: GroundedTurnResult['diagnostics']['codes']; inputMasked: string };

export function createFixtureState(o: FixtureOptions = {}): ControlPlaneState {
  const lifecycles: Record<string, VersionLifecycle> = {};
  const v1 = createReview(createVersionLifecycle(stagingDiff('v1', undefined, 'umrah-2026-q1.csv')), { status: 'approved', reviewer: 'fixture-reviewer', reviewedAt: FIXTURE_TIME });
  lifecycles.v1 = v1;
  const store = createInMemoryPublicationStore();
  publishToStore(store, v1);
  if (o.staged !== false) lifecycles.v2 = createVersionLifecycle(stagingDiff('v2', 'v1', 'umrah-2026-q2.csv'));
  let failedJobs: ControlPlaneState['failedJobs'] = [];
  if (o.failedJobs !== false) {
    try { createSourceArtifact(new Uint8Array(0), { kind: 'csv', filename: 'umrah-empty.csv' }); } catch (e) {
      if (e instanceof SourceArtifactError) failedJobs = [{ jobId: 'job-1', filename: 'umrah-empty.csv', code: e.code, message: e.message, failedAt: FIXTURE_TIME }];
    }
  }
  const art = (file: string, version: string) => { const x = createSourceArtifact(bytes(`${file}\n${version}`), { kind: 'csv', filename: file }); return { sourceId: x.sourceId, sha256: x.sha256, byteLength: x.byteLength, kind: x.kind, filename: file, key: x.key }; };
  return {
    pack: { id: 'actual-umrah', name: 'Umrah hotel pack' },
    store: store.state(),
    lifecycles,
    sources: [art('umrah-2026-q1.csv', 'v1'), ...(o.staged === false ? [] : [art('umrah-2026-q2.csv', 'v2')])],
    failedJobs,
    sessions: o.sessions === undefined ? [{ sessionId: 's-1', turns: [
      { status: 'grounded', intent: 'hotel_search', codes: [], inputMasked: 'hotels near haram' },
      { status: 'degraded', intent: 'hotel_search', codes: ['uncited_claim'], inputMasked: 'contact [email]' },
    ] }] : o.sessions,
    widget: { input: o.widget ?? { tenant: 'demo', siteId: 'site1', apiUrl: 'http://localhost:8787', version: 'v1', allowedOrigins: 'http://localhost:5173' }, disabled: false },
    packDisabled: false,
    audit: [],
    receipts: {},
  };
}
