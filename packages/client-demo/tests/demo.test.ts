import { describe, expect, it } from 'vitest';
import { createDemoApp } from '../src/app.js';
import { runDemoTurn } from '../src/flow.js';

const get = (url: string) => createDemoApp()('GET', url);

describe('visitor flow', () => {
  it('shows DEMO label, welcome and accessibility landmarks on the landing page', async () => {
    const { status, html } = await get('/');
    expect(status).toBe(200);
    expect(html).toContain('DEMO — fictional data');
    expect(html).toContain('Welcome');
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toContain('<label for="q"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('@media(max-width:480px)');
    expect(html).not.toMatch(/<script/i);
  });

  it('grounded turn: cited claims, source chips, recommendation cards, follow-up chips', async () => {
    const t = await runDemoTurn('Hotels in Makkah for 2 people, 3 nights');
    expect(t.result.status).toBe('grounded');
    expect(t.result.recommendations.length).toBeGreaterThan(0);
    expect(t.chips.length).toBeGreaterThan(0);
    for (const c of t.result.claims) for (const x of c.citations) expect(t.evidence[x.evidence_id]).toBeDefined();
    const { html } = await get('/?q=' + encodeURIComponent('Hotels in Makkah for 2 people, 3 nights'));
    expect(html).toContain('Recommendations (advisory only)');
    expect(html).toContain('class="chip src"');
    expect(html).toContain('aria-label="Follow-up questions"');
    expect(html).toContain('Zamzam Court');
  });

  it('is deterministic', async () => {
    const q = '/?q=' + encodeURIComponent('cheap hotels in Madinah for 3 people, 2 nights');
    expect(await get(q)).toEqual(await get(q));
  });

  it('insufficient evidence says so, no claims or recommendations', async () => {
    const t = await runDemoTurn('Do you fly to Mars?');
    expect(t.result.status).toBe('insufficient_evidence');
    expect(t.result.claims).toEqual([]);
    expect((await get('/?q=Mars')).html).toContain('have evidence for that');
  });

  it('simulated outage degrades to an alert with no unverified answer', async () => {
    const { html } = await get('/?q=hotels+in+makkah&sim=1');
    expect(html).toContain('role="alert"');
    expect(html).toContain('provider_failure');
    expect(html).not.toContain('Zamzam Court');
  });

  it('escapes and masks hostile input', async () => {
    const { html } = await get('/?q=' + encodeURIComponent('<img src=x onerror=1> mail me a@b.co'));
    expect(html).not.toContain('<img');
    expect(html).not.toContain('a@b.co');
  });
});

describe('mock handoff', () => {
  const post = (app: ReturnType<typeof createDemoApp>, body: string) => app('POST', '/handoff', body);
  it('requires consent and records nothing without it', async () => {
    const r = await post(createDemoApp(), 'rec=rec_0123abcd');
    expect(r.html).toContain('tick the consent box');
  });
  it('with consent creates an in-memory mock lead; repeat submits stay valid', async () => {
    const app = createDemoApp();
    expect((await post(app, 'rec=rec_0123abcd&consent=yes')).html).toContain('Mock handoff requested');
    expect((await post(app, 'consent=yes&rec=bad')).html).toContain('Mock handoff requested');
  });
  it('collects no contact fields', async () => {
    const { html } = await get('/handoff');
    expect(html).not.toMatch(/type="(email|tel|password)"|name="(email|phone|name)"/);
  });
  it('unknown routes 404', async () => {
    expect((await get('/admin')).status).toBe(404);
  });
});
