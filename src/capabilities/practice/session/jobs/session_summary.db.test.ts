import type { Job } from 'pg-boss';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { learning_session } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { type SessionSummaryJobData, buildSessionSummaryHandler } from './session_summary';

type SendOptions = { id?: string; startAfter?: Date };
const boss = vi.hoisted(() => ({
  send: vi.fn(async (_name: string, _data: unknown, _options?: SendOptions) => 'job-id'),
}));
vi.mock('@/server/boss/client', () => ({ getStartedBoss: async () => boss }));
vi.mock('@/kernel/background-job-enqueue', () => ({ shouldEnqueueBackgroundJobs: () => true }));

/** A closed review session whose single wrong answer still awaits a real cause,
 *  so every delivery schedules a delayed follow-up instead of writing. */
async function seedAttributionPendingSession(): Promise<string> {
  const db = testDb();
  const now = new Date();
  const sessionId = 'sess_reopened';
  await db.insert(learning_session).values({
    id: sessionId,
    type: 'review',
    status: 'completed',
    started_at: now,
    ended_at: now,
    created_at: now,
    updated_at: now,
  });
  await writeEvent(db, {
    id: 'attempt_pending',
    session_id: sessionId,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q_pending',
    outcome: 'failure',
    payload: { answer_md: 'x', answer_image_refs: [], referenced_knowledge_ids: [] },
  });
  await writeEvent(db, {
    id: 'judge_pending',
    session_id: sessionId,
    actor_kind: 'agent',
    actor_ref: 'judge',
    action: 'judge',
    subject_kind: 'event',
    subject_id: 'attempt_pending',
    outcome: 'success',
    payload: {
      cause: {
        primary_category: 'other',
        secondary_categories: [],
        analysis_md: '待归因',
        confidence: 0.5,
      },
      referenced_knowledge_ids: [],
      coarse_outcome: 'incorrect',
      attribution_pending: true,
    },
  });
  return sessionId;
}

function jobFor(sessionId: string, closeVersion: number): Job<SessionSummaryJobData> {
  return {
    id: `delivery_${closeVersion}`,
    name: 'session_summary',
    data: { session_id: sessionId, close_version: closeVersion },
  } as Job<SessionSummaryJobData>;
}

describe('session_summary follow-up job ids', () => {
  beforeEach(async () => {
    boss.send.mockClear();
    await resetDb();
  });

  /**
   * @invariant concurrency: each close of a reopened session gets its own delayed
   *   follow-up job id, while replaying one close reuses that close's id.
   * @fails-if the follow-up id keys only on session + wait step, so pg-boss keeps
   *   the first close's completed job and silently drops the second close's send —
   *   that close then never writes a summary, with no error and no DLQ entry.
   */
  it('gives each close of a reopened session its own follow-up job', async () => {
    const handler = buildSessionSummaryHandler(testDb(), {
      runTaskFn: async () => {
        throw new Error('a pending delivery must not call the model');
      },
    });
    const sessionId = await seedAttributionPendingSession();

    await handler([jobFor(sessionId, 1)]);
    await handler([jobFor(sessionId, 1)]);
    await handler([jobFor(sessionId, 2)]);

    const ids = boss.send.mock.calls.map((call) => call[2]?.id);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBeDefined();
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });
});
