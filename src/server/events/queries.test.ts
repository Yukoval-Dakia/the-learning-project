// Phase 1c.1 Step 4 — events queries module (ADR-0005 single-owner read API).
//
// Per spec §"New module: src/server/events/queries.ts" — all event reads/writes
// must funnel through this module. Tests seed `event` table directly with
// hand-built KnownEvent-shaped rows; no Step 3 migration in test fixtures.

import { deterministicId, newId } from '@/core/ids';
import type { EventT } from '@/core/schema/event';
import { event, material_fsrs_state } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  getEventById,
  getEventChain,
  getEvents,
  getFailureAttempts,
  getJudgeForAttempt,
  getRecentReviewEvents,
  writeEvent,
} from './queries';

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

async function seedReviewEvent(opts: {
  id?: string;
  question_id: string;
  rating?: 'again' | 'hard' | 'good';
  created_at?: Date;
}): Promise<string> {
  const db = testDb();
  const id = opts.id ?? newId();
  const rating = opts.rating ?? 'good';
  const outcome = rating === 'again' ? ('failure' as const) : ('success' as const);
  await db.insert(event).values({
    id,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'review',
    subject_kind: 'question',
    subject_id: opts.question_id,
    outcome,
    payload: {
      fsrs_rating: rating,
      fsrs_state_after: {
        due: new Date('2026-06-01T00:00:00Z').toISOString(),
        stability: 2,
        difficulty: 5,
        elapsed_days: 1,
        scheduled_days: 3,
        learning_steps: 0,
        reps: 1,
        lapses: 0,
        state: 'review',
        last_review: new Date('2026-05-15T00:00:00Z').toISOString(),
      },
      user_response_md: null,
      referenced_knowledge_ids: [],
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: opts.created_at ?? new Date(),
  });
  return id;
}

describe('getRecentReviewEvents', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns review events on a question ordered desc by created_at', async () => {
    const db = testDb();
    const baseTime = new Date('2026-05-01T12:00:00Z');
    await seedReviewEvent({
      question_id: 'q1',
      rating: 'again',
      created_at: new Date(baseTime.getTime() + 0),
    });
    await seedReviewEvent({
      question_id: 'q1',
      rating: 'hard',
      created_at: new Date(baseTime.getTime() + 60_000),
    });
    await seedReviewEvent({
      question_id: 'q1',
      rating: 'good',
      created_at: new Date(baseTime.getTime() + 120_000),
    });

    const results = await getRecentReviewEvents(db, { questionIds: ['q1'] });
    expect(results).toHaveLength(3);
    // desc order — newest (good) first
    expect(results[0].fsrs_rating).toBe('good');
    expect(results[1].fsrs_rating).toBe('hard');
    expect(results[2].fsrs_rating).toBe('again');
  });

  it('honours limit (default 100)', async () => {
    const db = testDb();
    for (let i = 0; i < 5; i++) {
      await seedReviewEvent({
        question_id: 'q1',
        rating: 'good',
        created_at: new Date(Date.now() + i * 1000),
      });
    }
    const results = await getRecentReviewEvents(db, { limit: 2 });
    expect(results).toHaveLength(2);
  });

  it('filters by since', async () => {
    const db = testDb();
    const cutoff = new Date('2026-05-10T00:00:00Z');
    await seedReviewEvent({
      question_id: 'q1',
      rating: 'good',
      created_at: new Date('2026-05-09T00:00:00Z'),
    });
    await seedReviewEvent({
      question_id: 'q1',
      rating: 'hard',
      created_at: new Date('2026-05-11T00:00:00Z'),
    });
    const results = await getRecentReviewEvents(db, { since: cutoff });
    expect(results).toHaveLength(1);
    expect(results[0].fsrs_rating).toBe('hard');
  });
});

describe('getEventById', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns the event when present', async () => {
    const db = testDb();
    const id = await seedAttemptEvent({ question_id: 'q1' });
    const evt = await getEventById(db, id);
    expect(evt).not.toBeNull();
    // EventT is a union (KnownEvent | ToolUseExperimental | ExperimentalEvent).
    // For a fresh seed-and-fetch on an attempt event we expect the KnownEvent
    // AttemptOnQuestion branch; narrow via property access on `as` cast.
    const narrowed = evt as Extract<typeof evt, { action: 'attempt' }>;
    expect(narrowed.action).toBe('attempt');
    expect(narrowed.subject_kind).toBe('question');
    expect(narrowed.subject_id).toBe('q1');
  });

  it('returns null when absent', async () => {
    const db = testDb();
    const evt = await getEventById(db, 'nope_no_such_id');
    expect(evt).toBeNull();
  });
});

describe('writeEvent', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('parses + inserts a valid attempt event; returns the id', async () => {
    const db = testDb();
    const id = newId();
    const created_at = new Date();
    const returnedId = await writeEvent(db, {
      id,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'failure',
      payload: {
        answer_md: 'wrong',
        answer_image_refs: [],
        referenced_knowledge_ids: [],
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at,
    });
    expect(returnedId).toBe(id);
    const rows = await db.select().from(event).where(eq(event.id, id));
    expect(rows).toHaveLength(1);
  });

  it('throws on invalid event payload (parseEvent guard)', async () => {
    const db = testDb();
    await expect(
      writeEvent(db, {
        id: newId(),
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q1',
        // INVALID — outcome 'bogus' not in enum
        outcome: 'bogus',
        payload: {
          answer_md: 'x',
          answer_image_refs: [],
          referenced_knowledge_ids: [],
        },
        created_at: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('is idempotent under duplicate id (returns existing id, no second row)', async () => {
    const db = testDb();
    const id = deterministicId('evt_test', 'fixed1');
    const base = {
      id,
      session_id: null,
      actor_kind: 'user' as const,
      actor_ref: 'self',
      action: 'attempt' as const,
      subject_kind: 'question' as const,
      subject_id: 'q1',
      outcome: 'failure' as const,
      payload: {
        answer_md: 'wrong',
        answer_image_refs: [],
        referenced_knowledge_ids: [],
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date('2026-05-01T00:00:00Z'),
    };
    const id1 = await writeEvent(db, base);
    const id2 = await writeEvent(db, {
      ...base,
      payload: { ...base.payload, answer_md: 'different' },
    });
    expect(id1).toBe(id);
    expect(id2).toBe(id);
    const rows = await db.select().from(event).where(eq(event.id, id));
    expect(rows).toHaveLength(1);
    // First write wins (no overwrite on conflict)
    const payload = rows[0].payload as { answer_md: string };
    expect(payload.answer_md).toBe('wrong');
  });
});

// ============================================================================
// getEvents — Phase 1c.1 Step 6: raw event log filter API.
//
// Output validation via parseEvent — guards schema drift on the way OUT.
// Filters AND-combined: action, subject_kind, actor_kind, actor_ref, since.
// Default limit 50, max 200.
// ============================================================================

describe('getEvents', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns events ordered desc by created_at', async () => {
    const db = testDb();
    const baseTime = new Date('2026-05-01T12:00:00Z');
    await seedAttemptEvent({
      question_id: 'q1',
      created_at: new Date(baseTime.getTime() + 0),
    });
    await seedAttemptEvent({
      question_id: 'q2',
      created_at: new Date(baseTime.getTime() + 60_000),
    });
    await seedAttemptEvent({
      question_id: 'q3',
      created_at: new Date(baseTime.getTime() + 120_000),
    });
    const results = (await getEvents(db)) as Array<Extract<EventT, { action: 'attempt' }>>;
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.subject_id)).toEqual(['q3', 'q2', 'q1']);
  });

  it('filters by action', async () => {
    const db = testDb();
    const a = await seedAttemptEvent({ question_id: 'q1' });
    await seedJudgeEvent({ attempt_event_id: a });
    const results = await getEvents(db, { action: 'judge' });
    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('judge');
  });

  it('filters by subject_kind', async () => {
    const db = testDb();
    const a = await seedAttemptEvent({ question_id: 'q1' });
    await seedJudgeEvent({ attempt_event_id: a });
    const results = (await getEvents(db, { subject_kind: 'question' })) as Array<
      Extract<EventT, { action: 'attempt' }>
    >;
    expect(results).toHaveLength(1);
    expect(results[0].subject_kind).toBe('question');
  });

  it('filters by actor_kind and actor_ref', async () => {
    const db = testDb();
    const a = await seedAttemptEvent({ question_id: 'q1' });
    await seedJudgeEvent({ attempt_event_id: a });
    const userOnly = (await getEvents(db, { actor_kind: 'user' })) as Array<
      Extract<EventT, { action: 'attempt' }>
    >;
    expect(userOnly).toHaveLength(1);
    expect(userOnly[0].actor_kind).toBe('user');
    const agentAttrib = (await getEvents(db, {
      actor_kind: 'agent',
      actor_ref: 'attribution',
    })) as Array<Extract<EventT, { action: 'judge' }>>;
    expect(agentAttrib).toHaveLength(1);
    expect(agentAttrib[0].actor_ref).toBe('attribution');
  });

  it('filters by since', async () => {
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
    const results = (await getEvents(db, { since: cutoff })) as Array<
      Extract<EventT, { action: 'attempt' }>
    >;
    expect(results.map((r) => r.subject_id)).toEqual(['q_new']);
  });

  it('honours limit (default 50)', async () => {
    const db = testDb();
    for (let i = 0; i < 4; i++) {
      await seedAttemptEvent({
        question_id: `q${i}`,
        created_at: new Date(Date.now() + i * 1000),
      });
    }
    const results = await getEvents(db, { limit: 2 });
    expect(results).toHaveLength(2);
  });

  it('combines filters with AND', async () => {
    const db = testDb();
    const a1 = await seedAttemptEvent({
      question_id: 'q1',
      outcome: 'failure',
    });
    await seedAttemptEvent({ question_id: 'q2', outcome: 'success' });
    await seedJudgeEvent({ attempt_event_id: a1 });
    const results = await getEvents(db, {
      action: 'attempt',
      subject_kind: 'question',
    });
    expect(results).toHaveLength(2);
  });

  it('parses output via parseEvent — throws on corrupted row', async () => {
    const db = testDb();
    // Seed a row with payload missing required fields for AttemptOnQuestion
    await db.insert(event).values({
      id: 'evt_corrupt',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'failure',
      // missing answer_md / answer_image_refs
      payload: { not_a_known_shape: true },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(),
    });
    await expect(getEvents(db)).rejects.toThrow();
  });
});

// ============================================================================
// getEventChain — Phase 1c.1 Step 6: caused_by chain navigation.
// Forward (caused_by) + backward (reverse via event_caused_by_idx).
// ============================================================================

describe('getEventChain', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns judge chained to an attempt as caused_events', async () => {
    const db = testDb();
    const attemptId = await seedAttemptEvent({ question_id: 'q1' });
    await seedJudgeEvent({ attempt_event_id: attemptId });
    const chain = await getEventChain(db, attemptId);
    expect(chain.caused_by).toBeNull();
    expect(chain.caused_events).toHaveLength(1);
    expect(chain.caused_events[0].action).toBe('judge');
  });

  it('returns caused_by populated for a judge event (focal=judge → caused_by=attempt)', async () => {
    const db = testDb();
    const attemptId = await seedAttemptEvent({ question_id: 'q1' });
    const judgeId = await seedJudgeEvent({ attempt_event_id: attemptId });
    const chain = await getEventChain(db, judgeId);
    expect(chain.caused_by).not.toBeNull();
    expect(chain.caused_by?.action).toBe('attempt');
    expect(chain.caused_events).toHaveLength(0);
  });

  it('throws when focal event not found', async () => {
    const db = testDb();
    await expect(getEventChain(db, 'no_such_id')).rejects.toThrow();
  });

  it('returns empty caused_events for an attempt with no judge', async () => {
    const db = testDb();
    const attemptId = await seedAttemptEvent({ question_id: 'q1' });
    const chain = await getEventChain(db, attemptId);
    expect(chain.caused_by).toBeNull();
    expect(chain.caused_events).toEqual([]);
  });
});
