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

  it.each([['Jeddah', 'jeddah'], ['Atlantis', 'unknown']])('does not silently map an unsupported city to Makkah (%s)', async (city, expectedCity) => {
    const t = await runDemoTurn(`Hotels in ${city} for 2 people, 3 nights`);
    expect(t.result.status).toBe('insufficient_evidence');
    expect(t.result.slots.city).toBe(expectedCity);
    expect(t.result.claims).toEqual([]);
    expect(t.result.cards).toEqual([]);
    expect(t.result.recommendations).toEqual([]);
    expect(JSON.stringify(t)).not.toContain('Makkah');
  });

  it('enforces a sub-300 SAR budget without showing over-budget options', async () => {
    const t = await runDemoTurn('Hotels in Makkah for 2 people, 3 nights under 300 SAR');
    expect(t.result.status).toBe('grounded');
    expect(t.result.slots.budget).toBe(300);
    expect(t.result.claims.length).toBeGreaterThan(0);
    for (const claim of t.result.claims) {
      const total = Number(claim.text.match(/(\d+) total/)?.[1]);
      expect(total).toBeLessThanOrEqual(300);
    }
    expect(t.result.recommendations.length).toBeGreaterThan(0);
  });

  it.each([1, 3, 5, 7])('has a deterministic grounded fixture outcome for %s travelers', async (travelers) => {
    const t = await runDemoTurn(`Hotels in Madinah for ${travelers} people, 2 nights`);
    expect(t.result.status).toBe('grounded');
    expect(t.result.cards.length).toBeGreaterThan(0);
    expect(t.result.recommendations.length).toBeGreaterThan(0);
    for (const claim of t.result.claims) for (const citation of claim.citations) expect(t.evidence[citation.evidence_id]).toBeDefined();
  });

  it('preserves Madinah context for a cheaper follow-up and keeps grounded cards/citations', async () => {
    const first = await runDemoTurn('Hotels in Madinah for 2 people, 4 nights');
    expect(first.result.status).toBe('grounded');
    const next = await runDemoTurn('Can you find a cheaper option?', { context: first.context });
    expect(next.result.status).toBe('grounded');
    expect(next.result.slots.city).toBe('madinah');
    expect(next.result.slots.priority).toBe('total_price');
    expect(next.result.cards.length).toBeGreaterThan(0);
    expect(next.result.claims.every((claim) => claim.citations.length > 0)).toBe(true);
    expect(next.result.recommendations.every((rec) => rec.citations.length > 0)).toBe(true);
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
