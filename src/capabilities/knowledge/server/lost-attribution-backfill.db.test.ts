// YUK-379 (B1) — census + backfill for silently-lost attribution.

import { question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { censusLostAttributions, runLostAttributionBackfill } from './lost-attribution-backfill';

const BASE = new Date('2026-07-01T00:00:00.000Z');

async function seedQuestion(id: string) {
  await testDb().insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: '解释「之」的用法',
    reference_md: '结构助词。',
    knowledge_ids: [],
    source: 'manual',
    difficulty: 3,
    created_at: BASE,
    updated_at: BASE,
  });
}

async function seedFailureAttempt(id: string, qid: string, atMs: number) {
  await writeEvent(testDb(), {
    id,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: qid,
    outcome: 'failure',
    payload: { answer_md: '代词', answer_image_refs: [], referenced_knowledge_ids: [] },
    created_at: new Date(BASE.getTime() + atMs),
  });
}

async function seedJudge(
  id: string,
  attemptId: string,
  atMs: number,
  opts: { attributionPending?: boolean } = {},
) {
  await writeEvent(testDb(), {
    id,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'attribution',
    action: 'judge',
    subject_kind: 'event',
    subject_id: attemptId,
    outcome: 'success',
    payload: {
      cause: {
        primary_category: 'concept',
        secondary_categories: [],
        analysis_md: '混淆助词和代词。',
        confidence: 0.8,
      },
      referenced_knowledge_ids: [],
      ...(opts.attributionPending ? { attribution_pending: true } : {}),
    },
    caused_by_event_id: attemptId,
    created_at: new Date(BASE.getTime() + atMs),
  });
}

describe('lost-attribution backfill census', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // Seeds four attempts:
  //  - att_lost      : failure, NO judge                       → lost
  //  - att_pending   : failure, only attribution_pending judge → lost (needs real)
  //  - att_healthy   : failure, real judge                     → NOT lost
  //  - att_success   : SUCCESS attempt                         → NOT lost (not a failure)
  async function seedFourAttempts() {
    await seedQuestion('q1');
    await seedFailureAttempt('att_lost', 'q1', 1_000);
    await seedFailureAttempt('att_pending', 'q1', 2_000);
    await seedFailureAttempt('att_healthy', 'q1', 3_000);
    await seedJudge('judge_pending', 'att_pending', 2_500, { attributionPending: true });
    await seedJudge('judge_healthy', 'att_healthy', 3_500);
    // success attempt (outcome != failure) — must never be censused.
    await writeEvent(testDb(), {
      id: 'att_success',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'success',
      payload: { answer_md: '结构助词', answer_image_refs: [], referenced_knowledge_ids: [] },
      created_at: new Date(BASE.getTime() + 4_000),
    });
  }

  it('censuses exactly the failure attempts lacking a real (non-pending) judge, oldest-first', async () => {
    await seedFourAttempts();
    const census = await censusLostAttributions(testDb(), { limit: 25 });
    // att_lost (no judge) + att_pending (placeholder only); NOT att_healthy, NOT att_success.
    expect(census.attemptIds).toEqual(['att_lost', 'att_pending']);
  });

  it('respects the per-run limit cap', async () => {
    await seedFourAttempts();
    const census = await censusLostAttributions(testDb(), { limit: 1 });
    expect(census.attemptIds).toEqual(['att_lost']);
  });

  it('dry-run reports the census and enqueues nothing (send never called)', async () => {
    await seedFourAttempts();
    const send = vi.fn(async () => {});
    const result = await runLostAttributionBackfill({
      db: testDb(),
      dryRun: true,
      limit: 25,
      send,
    });
    expect(result.mode).toBe('dry-run');
    expect(result.found).toBe(2);
    expect(result.enqueued).toBe(0);
    expect(result.attemptIds).toEqual(['att_lost', 'att_pending']);
    expect(send).not.toHaveBeenCalled();
  });

  it('apply enqueues one attribution_followup per lost attempt', async () => {
    await seedFourAttempts();
    const send = vi.fn(async (_id: string) => {});
    const result = await runLostAttributionBackfill({
      db: testDb(),
      dryRun: false,
      limit: 25,
      send,
    });
    expect(result.mode).toBe('apply');
    expect(result.found).toBe(2);
    expect(result.enqueued).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((c) => c[0])).toEqual(['att_lost', 'att_pending']);
  });

  it('apply mode without a send fn throws', async () => {
    await expect(
      runLostAttributionBackfill({ db: testDb(), dryRun: false, limit: 25 }),
    ).rejects.toThrow(/send/);
  });
});
