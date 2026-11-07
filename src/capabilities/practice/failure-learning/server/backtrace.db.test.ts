import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { event, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { allowedEventIds } from '@/kernel/events/derivation-policy';
import {
  beginTestTransaction,
  rollbackTestTransaction,
  testDb,
} from '../../../../../tests/helpers/db';
import { loadBacktraceInput } from './backtrace-input';
import { currentInsight } from './backtrace-store';

describe('Backtrace derived-source authorization', () => {
  beforeEach(beginTestTransaction);
  afterEach(rollbackTestTransaction);
  // @invariant security: Restricted or retracted evidence must not escape through a cached description.
  // @fails-if A cached insight is returned after its source permission or effective truth changes.
  it('rechecks cached source authorization and retraction at the read boundary', async () => {
    const db = testDb();
    const qid = 'backtrace_security_q';
    const attempt = 'backtrace_security_attempt';
    await db.insert(question).values({
      id: qid,
      kind: 'choice',
      prompt_md: '合成题',
      reference_md: 'B',
      source: 'manual',
      knowledge_ids: [],
      created_at: new Date(),
      updated_at: new Date(),
    });
    await writeEvent(db, {
      id: attempt,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: qid,
      outcome: 'failure',
      payload: { answer_md: 'A', answer_image_refs: [], referenced_knowledge_ids: [] },
    });
    await writeEvent(db, {
      id: 'backtrace_security_judge',
      actor_kind: 'agent',
      actor_ref: 'judge',
      action: 'judge',
      subject_kind: 'event',
      subject_id: attempt,
      caused_by_event_id: attempt,
      outcome: 'success',
      payload: {
        coarse_outcome: 'incorrect',
        referenced_knowledge_ids: [],
        cause: {
          primary_category: 'other',
          secondary_categories: [],
          analysis_md: '合成证据',
          confidence: 0.5,
        },
      },
    });
    const basis = await loadBacktraceInput(db, attempt);
    if (!basis) throw new Error('graded fixture missing');
    await writeEvent(db, {
      id: 'backtrace_security_insight',
      actor_kind: 'agent',
      actor_ref: 'attempt-insight',
      action: 'experimental:attempt_insight',
      subject_kind: 'event',
      subject_id: attempt,
      caused_by_event_id: attempt,
      payload: {
        insight_version: 'attempt-insight-v1',
        question_id: qid,
        input_digest: basis.digest,
        source_event_ids: basis.input.source_event_ids,
        verdict_seen: {
          outcome: 'failure',
          judge_event_id: 'backtrace_security_judge',
          evaluation_id: null,
        },
        user_cause_event_id: null,
        image_status: 'none',
        method: null,
        needed_method: null,
        mechanism: null,
        no_description_reason: '无过程',
      },
    });
    expect(await currentInsight(db, attempt)).not.toBeNull();
    const [judge] = await db.select().from(event).where(eq(event.id, 'backtrace_security_judge'));
    await db
      .update(event)
      .set({ payload: { ...judge.payload, derivation_policy: 'answer_only' } })
      .where(eq(event.id, judge.id));
    expect((await allowedEventIds(db, ['backtrace_security_insight'])).size).toBe(0);
    expect(await currentInsight(db, attempt)).toBeNull();
    await db.update(event).set({ payload: judge.payload }).where(eq(event.id, judge.id));
    await writeEvent(db, {
      id: 'backtrace_security_retract',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: attempt,
      outcome: 'success',
      payload: {
        correction_kind: 'retract',
        reason_md: '撤回合成作答',
        affected_refs: [{ kind: 'question', id: qid }],
      },
    });
    expect(await currentInsight(db, attempt)).toBeNull();
  });
});
