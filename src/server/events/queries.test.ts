// Phase 1c.1 Step 4 — events queries module (ADR-0005 single-owner read API).
//
// Per spec §"New module: src/server/events/queries.ts" — all event reads/writes
// must funnel through this module. Tests seed `event` table directly with
// hand-built KnownEvent-shaped rows; no Step 3 migration in test fixtures.

import { deterministicId, newId } from '@/core/ids';
import { event, material_fsrs_state } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { getFailureAttempts, getJudgeForAttempt } from './queries';

async function seedAttemptEvent(opts: {
  id?: string;
  question_id: string;
  outcome?: 'failure' | 'success' | 'partial';
  answer_md?: string;
  answer_image_refs?: string[];
  referenced_knowledge_ids?: string[];
  created_at?: Date;
}): Promise<string> {
  const db = testDb();
  const id = opts.id ?? newId();
  await db.insert(event).values({
    id,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: opts.question_id,
    outcome: opts.outcome ?? 'failure',
    payload: {
      answer_md: opts.answer_md ?? 'wrong',
      answer_image_refs: opts.answer_image_refs ?? [],
      referenced_knowledge_ids: opts.referenced_knowledge_ids ?? [],
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: opts.created_at ?? new Date(),
  });
  return id;
}

async function seedJudgeEvent(opts: {
  id?: string;
  attempt_event_id: string;
  primary_category?: string;
  analysis_md?: string;
  confidence?: number;
  referenced_knowledge_ids?: string[];
  created_at?: Date;
}): Promise<string> {
  const db = testDb();
  const id = opts.id ?? newId();
  await db.insert(event).values({
    id,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'attribution',
    action: 'judge',
    subject_kind: 'event',
    subject_id: opts.attempt_event_id,
    outcome: 'success',
    payload: {
      cause: {
        primary_category: opts.primary_category ?? 'concept',
        secondary_categories: [],
        analysis_md: opts.analysis_md ?? 'cause analysis',
        confidence: opts.confidence ?? 0.8,
      },
      referenced_knowledge_ids: opts.referenced_knowledge_ids ?? [],
    },
    caused_by_event_id: opts.attempt_event_id,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: opts.created_at ?? new Date(),
  });
  return id;
}

describe('getFailureAttempts', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns failure attempts with chained judge populated (mixed: 1 with judge, 1 without)', async () => {
    const db = testDb();
    const baseTime = new Date('2026-05-01T12:00:00Z');

    // Row 1: attempt + judge
    const a1Id = await seedAttemptEvent({
      question_id: 'q1',
      answer_md: 'wrong answer 1',
      answer_image_refs: ['asset_1'],
      referenced_knowledge_ids: ['k1', 'k2'],
      created_at: baseTime,
    });
    await seedJudgeEvent({
      attempt_event_id: a1Id,
      primary_category: 'concept',
      analysis_md: 'concept confusion',
      confidence: 0.9,
      referenced_knowledge_ids: ['k1'],
      created_at: new Date(baseTime.getTime() + 60_000),
    });

    // Row 2: attempt without judge
    await seedAttemptEvent({
      question_id: 'q2',
      answer_md: 'wrong 2',
      referenced_knowledge_ids: ['k3'],
      created_at: new Date(baseTime.getTime() + 120_000),
    });

    const results = await getFailureAttempts(db);
    expect(results).toHaveLength(2);
    // Default ordering desc by created_at — row 2 first
    expect(results[0].question_id).toBe('q2');
    expect(results[0].judge).toBeUndefined();
    expect(results[1].question_id).toBe('q1');
    expect(results[1].judge).toBeDefined();
    expect(results[1].judge?.cause.primary_category).toBe('concept');
    expect(results[1].judge?.cause.analysis_md).toBe('concept confusion');
    expect(results[1].answer_md).toBe('wrong answer 1');
    expect(results[1].referenced_knowledge_ids).toEqual(['k1', 'k2']);
  });

  it('filters by questionIds when provided', async () => {
    const db = testDb();
    await seedAttemptEvent({ question_id: 'q1' });
    await seedAttemptEvent({ question_id: 'q2' });
    await seedAttemptEvent({ question_id: 'q3' });

    const results = await getFailureAttempts(db, { questionIds: ['q1', 'q3'] });
    expect(results).toHaveLength(2);
    const qIds = results.map((r) => r.question_id).sort();
    expect(qIds).toEqual(['q1', 'q3']);
  });

  it('filters by since when provided', async () => {
    const db = testDb();
    const cutoff = new Date('2026-05-10T00:00:00Z');
    await seedAttemptEvent({
      question_id: 'q_old',
      created_at: new Date('2026-05-09T00:00:00Z'),
    });
    await seedAttemptEvent({
      question_id: 'q_new',
      created_at: new Date('2026-05-11T00:00:00Z'),
    });
    const results = await getFailureAttempts(db, { since: cutoff });
    expect(results.map((r) => r.question_id)).toEqual(['q_new']);
  });

  it('honours limit (default 100)', async () => {
    const db = testDb();
    for (let i = 0; i < 5; i++) {
      await seedAttemptEvent({
        question_id: `q${i}`,
        created_at: new Date(Date.now() + i * 1000),
      });
    }
    const results = await getFailureAttempts(db, { limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('excludes non-failure attempts', async () => {
    const db = testDb();
    await seedAttemptEvent({ question_id: 'q_fail', outcome: 'failure' });
    await seedAttemptEvent({ question_id: 'q_success', outcome: 'success' });
    await seedAttemptEvent({ question_id: 'q_partial', outcome: 'partial' });
    const results = await getFailureAttempts(db);
    expect(results.map((r) => r.question_id)).toEqual(['q_fail']);
  });
});

describe('getJudgeForAttempt', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns judge event when present', async () => {
    const db = testDb();
    const attemptId = await seedAttemptEvent({ question_id: 'q1' });
    const judgeId = await seedJudgeEvent({
      attempt_event_id: attemptId,
      analysis_md: 'my analysis',
    });
    const judge = await getJudgeForAttempt(db, attemptId);
    expect(judge).not.toBeNull();
    expect(judge?.judge_event_id).toBe(judgeId);
    expect(judge?.cause.analysis_md).toBe('my analysis');
  });

  it('returns null when no judge chained to attempt', async () => {
    const db = testDb();
    const attemptId = await seedAttemptEvent({ question_id: 'q1' });
    const judge = await getJudgeForAttempt(db, attemptId);
    expect(judge).toBeNull();
  });

  // suppress unused-import lint for helpers
  void deterministicId;
  void material_fsrs_state;
  void eq;
});
