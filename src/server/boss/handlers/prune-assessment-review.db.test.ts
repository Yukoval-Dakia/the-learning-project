import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ASSESSMENT_REVIEW_POLICY,
  assessmentReviewOperationId,
} from '@/capabilities/ingestion/server/assessment-review-evidence';
import { job_events } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runPruneJobEvents } from './prune_job_events';

beforeEach(resetDb);

describe('assessment review receipt retention', () => {
  it('retains every paid-fence event, including unknown and terminal outcomes, without payload markers', async () => {
    const old = new Date('2026-01-01T00:00:00Z');
    const chain = [
      'operation.accepted',
      'operation.idempotency_bound',
      'operation.queued',
      'operation.running',
      'operation.review_started',
      'operation.review_invocation',
      'operation.review_result',
      'operation.completed',
      'operation.failed',
    ];
    const db = testDb();
    const operationId = assessmentReviewOperationId({
      session_id: 'session',
      block_id: 'block',
      block_version: 1,
      question_id: 'question',
      question_version: 1,
      group_id: 'question',
      revision_id: 'revision',
      revision_digest: 'digest',
      admission_generation: 1,
      policy_id: ASSESSMENT_REVIEW_POLICY,
    });
    for (const eventType of chain) {
      await db.insert(job_events).values({
        business_table: 'ingestion_operation',
        business_id: operationId,
        event_type: eventType,
        payload: { state: 'unknown_result' },
        occurred_at: old,
      });
    }
    const terminalStates = ['admitted', 'withheld', 'superseded', 'unknown_result'];
    for (const state of terminalStates)
      await db.insert(job_events).values({
        business_table: 'ingestion_operation',
        business_id: operationId,
        event_type: 'operation.completed',
        payload: { result: { status: state } },
        occurred_at: old,
      });
    await db.insert(job_events).values([
      {
        business_table: 'another_table',
        business_id: operationId,
        event_type: 'operation.accepted',
        payload: {},
        occurred_at: old,
      },
      {
        business_table: 'ingestion_operation',
        business_id: 'ingop_old',
        event_type: 'operation.accepted',
        payload: { operation_kind: 'assessment_review' },
        occurred_at: old,
      },
      {
        business_table: 'ingestion_operation',
        business_id: 'ordinary_missing_marker',
        event_type: 'operation.running',
        payload: {},
        occurred_at: old,
      },
      {
        business_table: 'ingestion_operation',
        business_id: 'ingreviewXv1_lookalike',
        event_type: 'operation.review_started',
        payload: {},
        occurred_at: old,
      },
      {
        business_table: 'another_table',
        business_id: 'recent',
        event_type: 'running',
        payload: {},
        occurred_at: new Date('2026-02-02T00:00:00Z'),
      },
    ]);
    expect((await runPruneJobEvents(db, new Date('2026-02-01T00:00:00Z'))).deleted).toBe(4);
    const retained = await db.select().from(job_events);
    expect(retained).toHaveLength(chain.length + terminalStates.length + 1);
    expect(
      retained
        .filter((row) => row.business_id === operationId)
        .map((row) => row.event_type)
        .sort(),
    ).toEqual([...chain, ...terminalStates.map(() => 'operation.completed')].sort());
    expect(
      await db.select().from(job_events).where(eq(job_events.business_id, 'ingop_old')),
    ).toEqual([]);
  });
});
