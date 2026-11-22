import { describe, expect, it } from 'vitest';
import { runLocalGroundedTurn } from '../src/grounded.js';

describe('fixture-backed grounded adapter', () => {
  it.each([
    ['Madinah', 'Hotels in Madinah for 2 people, 4 nights'],
    ['Makkah', 'Hotels in Makkah for 2 people, 3 nights'],
  ])('grounds %s answers with cards, recommendations, citations and follow-ups', async (_name, message) => {
    const turn = await runLocalGroundedTurn(message);
    expect(turn.status).toBe('grounded');
    expect(turn.groundedTurn.schema_version).toBe('grounded-turn/v1');
    expect(turn.groundedTurn.claims.length).toBeGreaterThan(0);
    expect(turn.groundedTurn.cards.length).toBeGreaterThan(0);
    expect(turn.groundedTurn.recommendations.every((r) => r.advisory === true)).toBe(true);
    expect(turn.groundedTurn.claims[0]?.citations[0]?.source).toContain('fixture');
    expect(turn.followUps.length).toBeGreaterThan(0);
    expect(turn.reply).toContain('fixture-backed guidance');
  });

  it('fails closed for unsupported evidence', async () => {
    const turn = await runLocalGroundedTurn('Do you fly to Mars?');
    expect(turn.status).toBe('insufficient_evidence');
    expect(turn.groundedTurn.claims).toEqual([]);
    expect(turn.groundedTurn.recommendations).toEqual([]);
    expect(turn.followUps).toEqual([]);
  });

  it('returns degraded state without inventing cards when the local adapter is unavailable', async () => {
    const turn = await runLocalGroundedTurn('Hotels in Makkah', { simulateFailure: true });
    expect(turn.status).toBe('degraded');
    expect(turn.groundedTurn.recommendations).toEqual([]);
    expect(turn.reply).toContain('unavailable');
  });
});
