import { describe, expect, it } from 'vitest';
import { confirmationPhrase, createControlPlane, createFixtureState, renderPreviewHtml } from '../src/index.js';
import type { ActionRequest, ControlAction } from '../src/index.js';

const req = (action: ControlAction, requestId: string, confirm = confirmationPhrase(action)): ActionRequest => ({ ...action, requestId, confirm });
const approve: ControlAction = { type: 'approve_staged', version: 'v2', reviewer: 'op' };
const publish: ControlAction = { type: 'publish_version', version: 'v2' };

describe('read-only projection', () => {
  it('covers every Phase 3 surface from the fixture, deterministically', () => {
    const v = createControlPlane().snapshot();
    expect(v.pack).toMatchObject({ activeVersion: 'v1', retrievalVersion: 'v1', disabled: false });
    expect(v.sources.items).toHaveLength(2);
    expect(v.staging.items[0]).toMatchObject({ version: 'v2', parentVersion: 'v1', review: 'pending' });
    expect(v.publications.items).toEqual([{ version: 'v1', active: true }]);
    expect(v.rollbackCandidates.state).toBe('empty');
    expect(v.failedJobs.items[0]).toMatchObject({ code: 'EMPTY_ARTIFACT' });
    expect(v.sessions.items[0]).toMatchObject({ turns: 2, degraded: 1, codes: ['uncited_claim'] });
    expect(v.widget).toMatchObject({ state: 'ready', config: { tenant: 'demo' } });
    expect(v.rail.map((r) => r.status)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(JSON.stringify(createControlPlane().snapshot())).toBe(JSON.stringify(v));
  });

  it('shows empty, unavailable and invalid-config states', () => {
    const v = createControlPlane(createFixtureState({ staged: false, failedJobs: false, sessions: null, widget: { tenant: 'bad tenant' } })).snapshot();
    expect(v.staging.state).toBe('empty');
    expect(v.failedJobs.state).toBe('empty');
    expect(v.sessions.state).toBe('unavailable');
    expect(v.widget).toMatchObject({ state: 'unavailable', config: null });
    expect(v.widget.message).toContain('invalid_config');
    expect(v.rail.at(-1)?.status).toBe('current');
  });

  it('returns a copy: mutating a snapshot cannot change state', () => {
    const cp = createControlPlane();
    cp.snapshot().publications.items.length = 0;
    expect(cp.snapshot().publications.items).toHaveLength(1);
  });
});

describe('confirmed, audited, atomic actions', () => {
  it('requires the exact confirmation phrase and changes nothing otherwise', () => {
    const cp = createControlPlane();
    const before = JSON.stringify({ ...cp.snapshot(), audit: [] });
    for (const confirm of ['', 'yes', 'approve_staged v1']) expect(cp.act(req(approve, 'r1', confirm))).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED' });
    expect(JSON.stringify({ ...cp.snapshot(), audit: [] })).toBe(before);
    expect(cp.snapshot().audit.every((a) => a.outcome === 'rejected')).toBe(true);
  });

  it('keeps staged content out of retrieval until approved AND published', () => {
    const cp = createControlPlane();
    expect(cp.act(req(publish, 'p0'))).toMatchObject({ ok: false, code: 'REVIEW_NOT_APPROVED' });
    expect(cp.act(req(approve, 'a1'))).toMatchObject({ ok: true, status: 'applied' });
    expect(cp.snapshot().pack.retrievalVersion).toBe('v1');
    expect(cp.act(req(publish, 'p1'))).toMatchObject({ ok: true, status: 'applied' });
    const v = cp.snapshot();
    expect(v.pack.retrievalVersion).toBe('v2');
    expect(v.publications.items.map((p) => p.version)).toEqual(['v1', 'v2']);
    expect(v.rollbackCandidates.items).toEqual([{ version: 'v1' }]);
    expect(v.staging.state).toBe('empty');
  });

  it('rolls back to a published version only, without rewriting history', () => {
    const cp = createControlPlane();
    cp.act(req(approve, 'a1')); cp.act(req(publish, 'p1'));
    expect(cp.act(req({ type: 'rollback_version', version: 'v9' }, 'x'))).toMatchObject({ ok: false });
    expect(cp.act(req({ type: 'rollback_version', version: 'v1' }, 'rb'))).toMatchObject({ ok: true, status: 'applied' });
    const v = cp.snapshot();
    expect(v.pack.activeVersion).toBe('v1');
    expect(v.publications.items.map((p) => p.version)).toEqual(['v1', 'v2']);
  });

  it('is idempotent: replay returns the recorded result, and a reused id for another action is rejected', () => {
    const cp = createControlPlane();
    const first = cp.act(req(approve, 'a1'));
    const audit = cp.snapshot().audit.length;
    expect(cp.act(req(approve, 'a1'))).toEqual(first);
    expect(cp.snapshot().audit).toHaveLength(audit);
    expect(cp.act(req(approve, 'a2'))).toMatchObject({ ok: true, status: 'no_op' });
    expect(cp.act(req(publish, 'a1'))).toMatchObject({ ok: false, code: 'REQUEST_ID_REUSED' });
    cp.act(req(publish, 'p1'));
    expect(cp.act(req(publish, 'p2'))).toMatchObject({ ok: true, status: 'no_op' });
  });

  it('disables the pack (locks changes, stops retrieval) and the widget', () => {
    const cp = createControlPlane();
    expect(cp.act(req({ type: 'disable_widget' }, 'w'))).toMatchObject({ ok: true, status: 'applied' });
    expect(cp.snapshot().widget).toMatchObject({ state: 'locked', disabled: true });
    expect(cp.act(req({ type: 'disable_pack' }, 'k'))).toMatchObject({ ok: true });
    const v = cp.snapshot();
    expect(v.pack.retrievalVersion).toBeNull();
    expect(v.staging.state).toBe('locked');
    expect(v.actions.filter((a) => a.enabled)).toHaveLength(0);
    expect(cp.act(req(approve, 'a'))).toMatchObject({ ok: false, code: 'PACK_DISABLED' });
  });

  it('every attempt is audited in order with the outcome', () => {
    const cp = createControlPlane();
    cp.act(req(approve, 'a1', 'nope')); cp.act(req(approve, 'a2')); cp.act(req(publish, 'a3'));
    expect(cp.snapshot().audit.map((a) => [a.seq, a.action, a.outcome])).toEqual([
      [1, 'approve_staged v2', 'rejected'], [2, 'approve_staged v2', 'applied'], [3, 'publish_version v2', 'applied'],
    ]);
  });
});

describe('static preview', () => {
  it('renders every section with escaped data, no script and no network-capable markup', () => {
    const html = renderPreviewHtml(createControlPlane(createFixtureState({ widget: { tenant: '<b>x' } })).snapshot());
    for (const id of ['pack', 'sources', 'staging', 'publications', 'rollback', 'failed', 'sessions', 'widget', 'actions', 'audit']) expect(html).toContain(`id="${id}"`);
    expect(html).not.toMatch(/<script|<form|<a |<img|<link|src=|href=|fetch\(|XMLHttpRequest/i);
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain('<b>x');
    expect(html).toMatch(/<button disabled>/);
  });
});
