import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitFormalAttempt } from '@/capabilities/practice/server/assessment/attempt';
import { issueAssessment } from '@/capabilities/practice/server/assessment/issue';
import { loadNativeFailureContext } from '@/capabilities/practice/server/failure-learning-native';
import { event, knowledge, question } from '@/db/schema';
import { seedFrozenCompositeSolveQuestion } from '../../../tests/fixtures/assessment-solve';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { resolveVerdictsForNativeAttempts } from './assessment-verdict';
import { getCurrentFailureAttempts } from './failure-attempts';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe('native issued learning scope (YUK-1047)', () => {
  it.each([false, true])(
    'retains legal root KC and excludes unissued B including root union=%s',
    async (rootUnion) => {
      const db = testDb();
      const f = await seedFrozenCompositeSolveQuestion(db);
      await db.insert(knowledge).values(
        ['kc_root', 'kc_a', 'kc_b'].map((id) => ({
          id,
          name: id,
          domain: 'math',
          created_at: new Date(),
          updated_at: new Date(),
        })),
      );
      await db
        .update(question)
        .set({ knowledge_ids: rootUnion ? ['kc_root', 'kc_a', 'kc_b'] : ['kc_root'] })
        .where(eq(question.id, f.id));
      await db
        .update(question)
        .set({ knowledge_ids: ['kc_a'] })
        .where(eq(question.id, `${f.id}_part0`));
      await db
        .update(question)
        .set({ knowledge_ids: ['kc_b'] })
        .where(eq(question.id, `${f.id}_part1`));
      const issued = await issueAssessment(db, { group_id: f.id, part_ids: [`${f.id}_part0`] });
      if (issued.status !== 'issued') throw new Error(issued.status);
      const result = await commitFormalAttempt(db, 'solo_submit', `${f.id}_part0`, {
        issuance_id: issued.issuance.issuance_id,
        evaluation_group_id: 'scope_group',
        idempotency_key: 'scope_submit',
        response_set: { entries: f.responseSet(0).entries.slice(0, 1) },
      });
      expect(result.status).toBe('effective');
      // All four physical parts are in the frozen submission receipt; only A was issued.
      const [receipt] = await db
        .select()
        .from(event)
        .where(eq(event.subject_id, result.submission.submission_id));
      expect(JSON.stringify(receipt.payload.learning_scope)).toContain('kc_b');
      await db
        .update(question)
        .set({ knowledge_ids: ['kc_b'], prompt_md: 'CHANGED LIVE' })
        .where(eq(question.id, `${f.id}_part0`));
      const [anchor] = await db.select().from(event).where(eq(event.id, result.attempt_id));
      const verdict = (await resolveVerdictsForNativeAttempts(db, [anchor])).get(anchor.id);
      expect(verdict?.knowledge_ids.toSorted()).toEqual(['kc_a', 'kc_root']);
      const failures = await getCurrentFailureAttempts(db, {
        questionIds: [`${f.id}_part0`],
        limit: 1,
      });
      expect(failures[0]?.referenced_knowledge_ids.toSorted()).toEqual(['kc_a', 'kc_root']);
      const context = await loadNativeFailureContext(db, anchor.id);
      expect(context?.knowledge_ids.toSorted()).toEqual(['kc_a', 'kc_root']);
      expect(context?.prompt_md).not.toContain('CHANGED LIVE');
      const settlements = await db
        .select()
        .from(event)
        .where(eq(event.action, 'experimental:assessment_settlement'));
      const observations = settlements.flatMap((row) => row.payload.kc_observations ?? []);
      expect(observations).toEqual([expect.objectContaining({ kc_id: 'kc_a', bit: 0 })]);
    },
  );
});
