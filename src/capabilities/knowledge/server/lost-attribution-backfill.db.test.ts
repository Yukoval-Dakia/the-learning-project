// YUK-379 (B1) — census + backfill for silently-lost attribution.

import { question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { censusLostAttributions, runLostAttributionBackfill } from './lost-attribution-backfill';

const BASE = new Date('2026-07-01T00:00:00.000Z');
// Floor comfortably after every seeded attempt (all at BASE + ≤4_000ms), so the
// createdBefore race-guard (#1) never excludes the fixtures in the shared cases.
const AFTER_ALL = new Date(BASE.getTime() + 10_000);

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
    const census = await censusLostAttributions(testDb(), { limit: 25, createdBefore: AFTER_ALL });
    // att_lost (no judge) + att_pending (placeholder only); NOT att_healthy, NOT att_success.
    expect(census.attemptIds).toEqual(['att_lost', 'att_pending']);
  });

  it('respects the per-run limit cap', async () => {
    await seedFourAttempts();
    const census = await censusLostAttributions(testDb(), { limit: 1, createdBefore: AFTER_ALL });
    expect(census.attemptIds).toEqual(['att_lost']);
  });

  it('dry-run reports the census and enqueues nothing (send never called)', async () => {
    await seedFourAttempts();
    const send = vi.fn(async () => {});
    const result = await runLostAttributionBackfill({
      db: testDb(),
      dryRun: true,
      limit: 25,
      createdBefore: AFTER_ALL,
      send,
    });
    expect(result.mode).toBe('dry-run');
    expect(result.found).toBe(2);
    expect(result.enqueued).toBe(0);
    expect(result.errors).toEqual([]);
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
      createdBefore: AFTER_ALL,
      send,
    });
    expect(result.mode).toBe('apply');
    expect(result.found).toBe(2);
    expect(result.enqueued).toBe(2);
    expect(result.errors).toEqual([]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((c) => c[0])).toEqual(['att_lost', 'att_pending']);
  });

  it('apply mode without a send fn throws', async () => {
    await expect(
      runLostAttributionBackfill({
        db: testDb(),
        dryRun: false,
        limit: 25,
        createdBefore: AFTER_ALL,
      }),
    ).rejects.toThrow(/send/);
  });

  // OCR #1 — createdBefore race guard: an attempt whose original
  // attribution_followup job may still be in flight (created after the floor)
  // must NOT be re-enqueued, or the read-then-write idempotency can double-judge.
  it('excludes attempts newer than the createdBefore floor', async () => {
    await seedQuestion('q1');
    await seedFailureAttempt('att_old', 'q1', 1_000); // before floor → lost & eligible
    await seedFailureAttempt('att_fresh', 'q1', 20_000); // after floor → excluded (may be in flight)
    const census = await censusLostAttributions(testDb(), {
      limit: 25,
      createdBefore: AFTER_ALL,
    });
    expect(census.attemptIds).toEqual(['att_old']);
  });

  // OCR #5 — a non-positive limit is an operator error: 0 silently returns empty,
  // a negative value makes Postgres throw an opaque error. Fail loudly instead.
  it('throws on a non-positive limit', async () => {
    await expect(
      censusLostAttributions(testDb(), { limit: 0, createdBefore: AFTER_ALL }),
    ).rejects.toThrow(/limit/);
    await expect(
      censusLostAttributions(testDb(), { limit: -3, createdBefore: AFTER_ALL }),
    ).rejects.toThrow(/limit/);
  });

  // OCR #3/#4 — a per-item send failure must not abort the whole run or lose the
  // enqueued count: the loop continues, accumulates the error, and returns a
  // partial result the CLI layer prints (and exits non-zero on).
  it('apply accumulates per-item send errors and returns a partial result', async () => {
    await seedFourAttempts();
    const send = vi.fn(async (id: string) => {
      if (id === 'att_lost') throw new Error('boss down');
    });
    const result = await runLostAttributionBackfill({
      db: testDb(),
      dryRun: false,
      limit: 25,
      createdBefore: AFTER_ALL,
      send,
    });
    // Both lost attempts are attempted despite the first throwing.
    expect(send).toHaveBeenCalledTimes(2);
    expect(result.found).toBe(2);
    expect(result.enqueued).toBe(1); // only att_pending succeeded
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].attemptEventId).toBe('att_lost');
    expect(result.errors[0].message).toMatch(/boss down/);
  });
});
