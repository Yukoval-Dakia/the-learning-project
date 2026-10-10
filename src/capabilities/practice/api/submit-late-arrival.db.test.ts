// Native ordered replay replaces the retired deferred writer's evidence-only skip.
// Unknown newer projections remain fail-closed; pending originals never pretend to be scores.

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HIERARCHICAL_ELO_ENABLED } from '@/core/theta';
import { event, mastery_state, material_fsrs_state } from '@/db/schema';
import { nativeSoloHttpFixture } from '../../../../tests/fixtures/native-solo-http';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { commitFormalAttempt, prepareFormalAttemptSubmission } from '../server/assessment/attempt';

const OLDER = new Date('2026-10-04T08:00:00.000Z');
const NEWER = new Date('2026-10-04T09:00:00.000Z');
beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());
async function original(ids: string[], at: Date, answer = 'A') {
  const f = await nativeSoloHttpFixture(testDb(), { knowledgeIds: ids });
  const request = { ...f.issued.assessment(answer), now: at };
  return {
    ...f,
    request,
    prepare: () => prepareFormalAttemptSubmission(testDb(), 'solo_submit', f.id, request),
    commit: () => commitFormalAttempt(testDb(), 'solo_submit', f.id, request),
  };
}
async function state() {
  return {
    theta: await testDb().select().from(mastery_state).orderBy(mastery_state.subject_id),
    fsrs: await testDb().select().from(material_fsrs_state).orderBy(material_fsrs_state.subject_id),
  };
}

describe('native late arrival and frozen learning scope', () => {
  it('replays a later sibling on the shared domain without requiring overlapping KC IDs', async () => {
    expect(HIERARCHICAL_ELO_ENABLED).toBe(true);
    const run = async (reverse: boolean) => {
      const first = await original(['k1'], OLDER, 'B');
      const later = await original(['k2'], NEWER, 'A');
      for (const item of reverse ? [later, first] : [first, later])
        expect(await item.commit()).toMatchObject({ activation: { effect: 'applied' } });
      const final = await state();
      return {
        theta: final.theta.map((row) => ({
          kind: row.subject_kind,
          id: row.subject_id,
          theta: row.theta_hat,
          count: row.evidence_count,
          at: row.last_outcome_at,
        })),
        fsrs: final.fsrs.map((row) => ({
          id: row.subject_id,
          reps: row.state.reps,
          at: row.state.last_review,
        })),
      };
    };
    const chronological = await run(false);
    await resetDb();
    expect(await run(true)).toEqual(chronological);
    const receipts = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_settlement'));
    expect(receipts.some((row) => typeof row.payload.replay_of === 'string')).toBe(true);
  });
});
