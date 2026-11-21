// Local, fixture-backed, provider-neutral operator control plane: a read-only projection plus a confirmed, audited action seam.
// No network, storage, clock, credentials or providers: everything is injected or in-memory.
import { createInMemoryPublicationStore, createReview, publishToStore } from '@pilgrim/ingest';
import type { PublicationStoreState, VersionLifecycle } from '@pilgrim/ingest';
import { parseHostConfig } from '@pilgrim/widget';
import type { HostConfig, HostConfigInput } from '@pilgrim/widget';
import { createFixtureState, FIXTURE_TIME } from './fixture.js';
import type { FixtureTurn } from './fixture.js';

export { createFixtureState, FIXTURE_TIME };
export type { FixtureOptions } from './fixture.js';
export { renderPreviewHtml } from './render.js';

// ---- state (all local) ----
export interface SourceRow { sourceId: string; sha256: string; byteLength: number; kind: string; filename?: string; key: string }
export interface FailedJob { jobId: string; filename: string; code: string; message: string; failedAt: string }
export interface SessionRow { sessionId: string; turns: FixtureTurn[] }
export interface AuditEntry { seq: number; at: string; requestId: string; action: string; outcome: 'applied' | 'no_op' | 'rejected'; code?: string }
export interface ControlPlaneState {
  pack: { id: string; name: string };
  store: PublicationStoreState;
  lifecycles: Record<string, VersionLifecycle>;
  sources: SourceRow[];
  failedJobs: FailedJob[];
  sessions: SessionRow[] | null; // null = diagnostics source unavailable
  widget: { input: HostConfigInput; disabled: boolean };
  packDisabled: boolean;
  audit: AuditEntry[];
  receipts: Record<string, { fingerprint: string; result: ActionResult }>;
}

// ---- actions: the only mutations; nothing here can enable unpublished retrieval ----
export type ControlAction =
  | { type: 'approve_staged'; version: string; reviewer: string }
  | { type: 'publish_version'; version: string }
  | { type: 'rollback_version'; version: string }
  | { type: 'disable_pack' }
  | { type: 'disable_widget' };
export type ActionRequest = ControlAction & { requestId: string; confirm: string };
export type ActionResult = { ok: true; status: 'applied' | 'no_op'; message: string } | { ok: false; code: string; message: string };

/** The exact phrase an operator must echo back as `confirm`. */
export const confirmationPhrase = (a: ControlAction): string => ('version' in a ? `${a.type} ${a.version}` : a.type);

export const SAVE_COPY = { applied: 'Saved locally in this fixture preview. Nothing was sent anywhere.', no_op: 'Already up to date. Nothing changed.' } as const;
/** One consistent shape for every failure: what failed, why, and the guarantee. */
export const errorCopy = (code: string, detail: string): string => `Couldn't complete that (${code}). ${detail} Nothing was changed.`;

// ---- view ----
export type SectionState = 'ready' | 'empty' | 'locked' | 'unavailable';
export interface Section<T> { state: SectionState; message: string; items: T[] }
export interface ControlPlaneView {
  pack: { id: string; name: string; disabled: boolean; activeVersion: string | null; retrievalVersion: string | null };
  kpis: Array<{ label: string; value: string }>;
  rail: Array<{ step: string; status: 'done' | 'current' | 'todo' }>;
  sources: Section<SourceRow>;
  staging: Section<{ version: string; parentVersion?: string; review: string; snapshotDigest: string; changes: Record<string, { added: number; removed: number; changed: number }> }>;
  publications: Section<{ version: string; active: boolean }>;
  rollbackCandidates: Section<{ version: string }>;
  failedJobs: Section<FailedJob>;
  sessions: Section<{ sessionId: string; turns: number; degraded: number; codes: string[] }>;
  widget: { state: SectionState; message: string; config: HostConfig | null; disabled: boolean };
  actions: Array<{ action: ControlAction; enabled: boolean; confirm: string; lockedReason?: string }>;
  audit: AuditEntry[];
}

const ENTITIES = ['hotels', 'rooms', 'rates', 'periods', 'blankCells'] as const;
const section = <T>(items: T[], empty: string, ready: string): Section<T> => ({ state: items.length ? 'ready' : 'empty', message: items.length ? ready : empty, items });
const stable = (v: unknown): string => JSON.stringify(v);

export interface ControlPlane { snapshot(): ControlPlaneView; act(request: ActionRequest): ActionResult }

export function createControlPlane(initial: ControlPlaneState = createFixtureState(), now: () => string = () => FIXTURE_TIME): ControlPlane {
  let state = structuredClone(initial);

  const published = (s: ControlPlaneState) => new Set(Object.keys(s.store.versions));
  const candidates = (s: ControlPlaneState) => s.store.history.filter((v) => v !== s.store.activeVersion);
  const staged = (s: ControlPlaneState) => Object.values(s.lifecycles).filter((l) => !published(s).has(l.manifest.version));

  function snapshot(): ControlPlaneView {
    const s = state;
    const locked = s.packDisabled;
    const widgetCfg = parseHostConfig(s.widget.input);
    const rb = candidates(s);
    const stg = staged(s);
    const sectionOf = <T>(items: T[], empty: string, ready: string): Section<T> => (locked && items.length ? { state: 'locked', message: 'Pack is disabled; changes are locked.', items } : section(items, empty, ready));
    const active = s.store.activeVersion ?? null;
    const actions: ControlPlaneView['actions'] = [];
    const add = (action: ControlAction, enabled: boolean, lockedReason: string) => actions.push({ action, enabled, confirm: confirmationPhrase(action), ...(enabled ? {} : { lockedReason }) });
    for (const l of stg) {
      const v = l.manifest.version;
      add({ type: 'approve_staged', version: v, reviewer: 'operator' }, !locked && l.review.status === 'pending', locked ? 'Pack is disabled.' : 'Only pending staged content can be approved.');
      add({ type: 'publish_version', version: v }, !locked && l.review.approved, locked ? 'Pack is disabled.' : 'Approve this staged version before publishing.');
    }
    for (const v of rb) add({ type: 'rollback_version', version: v }, !locked, 'Pack is disabled.');
    add({ type: 'disable_pack' }, !locked, 'Pack is already disabled.');
    add({ type: 'disable_widget' }, !s.widget.disabled, 'Widget is already disabled.');
    const sessions = s.sessions === null
      ? { state: 'unavailable' as const, message: 'Session diagnostics are unavailable in this preview.', items: [] }
      : section(s.sessions.map((x) => ({ sessionId: x.sessionId, turns: x.turns.length, degraded: x.turns.filter((t) => t.status !== 'grounded').length, codes: [...new Set(x.turns.flatMap((t) => t.codes))].sort() })), 'No sessions recorded yet.', 'Grounding diagnostics per session.');
    const rail: ControlPlaneView['rail'] = ([
      ['Source uploaded', s.sources.length > 0],
      ['Staging diff reviewed', Object.keys(s.lifecycles).length > 0],
      ['Content approved', Object.values(s.lifecycles).some((l) => l.review.approved)],
      ['Version published', active !== null],
      ['Widget ready', widgetCfg !== null && !s.widget.disabled],
    ] as const).map(([step, done]) => ({ step, status: done ? 'done' : 'todo' }));
    const cur = rail.find((r) => r.status === 'todo');
    if (cur) cur.status = 'current';
    return structuredClone({
      pack: { ...s.pack, disabled: s.packDisabled, activeVersion: active, retrievalVersion: s.packDisabled ? null : active },
      kpis: [
        { label: 'Active version', value: active ?? 'none' },
        { label: 'Staged awaiting action', value: String(stg.length) },
        { label: 'Failed ingestion jobs', value: String(s.failedJobs.length) },
        { label: 'Retrieval', value: s.packDisabled ? 'disabled' : active ? `published ${active} only` : 'off' },
      ],
      rail,
      sources: section(s.sources, 'No source files yet. Upload a CSV or Markdown source to begin.', 'Immutable source artifacts.'),
      staging: sectionOf(stg.map((l) => ({
        version: l.manifest.version, ...(l.manifest.parentVersion ? { parentVersion: l.manifest.parentVersion } : {}), review: l.review.status, snapshotDigest: l.manifest.snapshotDigest,
        changes: Object.fromEntries(ENTITIES.map((e) => [e, { added: l.diff[e].added.length, removed: l.diff[e].removed.length, changed: l.diff[e].changed.length }])),
      })), 'Nothing staged. New source files appear here for review.', 'Staged versions are not live until published.'),
      publications: section(s.store.history.map((version) => ({ version, active: version === active })), 'Nothing published yet.', 'Publication history, oldest first.'),
      rollbackCandidates: sectionOf(rb.map((version) => ({ version })), 'No earlier published version to roll back to.', 'Previously published versions.'),
      failedJobs: section(s.failedJobs, 'No failed ingestion jobs.', 'Failed jobs keep their original error code.'),
      sessions,
      widget: widgetCfg
        ? { state: s.widget.disabled ? 'locked' : 'ready', message: s.widget.disabled ? 'Widget is disabled.' : 'Configuration is valid.', config: widgetCfg, disabled: s.widget.disabled }
        : { state: 'unavailable', message: errorCopy('invalid_config', 'The widget configuration is not valid.'), config: null, disabled: s.widget.disabled },
      actions,
      audit: s.audit,
    });
  }

  function apply(s: ControlPlaneState, a: ControlAction): ActionResult {
    const done = (status: 'applied' | 'no_op'): ActionResult => ({ ok: true, status, message: SAVE_COPY[status] });
    const fail = (code: string, detail: string): ActionResult => ({ ok: false, code, message: errorCopy(code, detail) });
    if (a.type === 'disable_widget') { if (s.widget.disabled) return done('no_op'); s.widget.disabled = true; return done('applied'); }
    if (a.type === 'disable_pack') { if (s.packDisabled) return done('no_op'); s.packDisabled = true; return done('applied'); }
    if (s.packDisabled) return fail('PACK_DISABLED', 'The pack is disabled.');
    const lifecycle = s.lifecycles[a.version];
    if (!lifecycle) return fail('UNKNOWN_VERSION', `No version ${a.version} is known.`);
    if (a.type === 'approve_staged') {
      if (published(s).has(a.version) || lifecycle.review.status === 'approved') return done('no_op');
      s.lifecycles[a.version] = createReview(lifecycle, { status: 'approved', reviewer: a.reviewer, reviewedAt: now(), snapshotDigest: lifecycle.manifest.snapshotDigest });
      return done('applied');
    }
    const store = createInMemoryPublicationStore({ initialState: s.store });
    const before = store.state();
    if (a.type === 'publish_version' && published(s).has(a.version)) return before.activeVersion === a.version ? done('no_op') : fail('ALREADY_PUBLISHED', 'That version was published before; use rollback.');
    const next = a.type === 'publish_version'
      ? publishToStore(store, lifecycle, before.activeVersion === undefined ? {} : { activeVersion: before.activeVersion })
      : publishToStore(store, lifecycle, { rollback: { activeVersion: before.activeVersion ?? '', targetVersion: a.version, previouslyPublished: before.history } });
    s.store = next;
    return stable(next) === stable(before) ? done('no_op') : done('applied');
  }

  function act(request: ActionRequest): ActionResult {
    const { requestId, confirm, ...action } = request;
    const record = (outcome: AuditEntry['outcome'], code?: string) => state.audit.push({ seq: state.audit.length + 1, at: now(), requestId: String(requestId), action: confirmationPhrase(action as ControlAction), outcome, ...(code ? { code } : {}) });
    const reject = (code: string, detail: string): ActionResult => { record('rejected', code); return { ok: false, code, message: errorCopy(code, detail) }; };
    if (typeof requestId !== 'string' || requestId === '') return reject('INVALID_REQUEST', 'A requestId is required.');
    if (confirm !== confirmationPhrase(action as ControlAction)) return reject('CONFIRMATION_REQUIRED', `Type "${confirmationPhrase(action as ControlAction)}" to confirm.`);
    const fingerprint = stable(action);
    const prior = state.receipts[requestId];
    if (prior) return prior.fingerprint === fingerprint ? prior.result : reject('REQUEST_ID_REUSED', 'That requestId was used for a different action.');
    const working = structuredClone(state); // atomic: commit only on success
    let result: ActionResult;
    try { result = apply(working, action as ControlAction); } catch (e) {
      const code = e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : 'ACTION_FAILED';
      return reject(code, e instanceof Error ? e.message : 'Unexpected failure.');
    }
    if (!result.ok) { record('rejected', result.code); return result; }
    state = working;
    record(result.status);
    state.receipts[requestId] = { fingerprint, result };
    return result;
  }

  return { snapshot, act };
}
