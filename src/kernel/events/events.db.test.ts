// Phase 1c.1 Step 4 — events queries module (ADR-0005 single-owner read API).
//
// Per spec §"New module: src/server/events/queries.ts" — all event reads/writes
// must funnel through this module. Tests seed `event` table directly with
// hand-built KnownEvent-shaped rows; no Step 3 migration in test fixtures.

import { deterministicId, newId } from '@/core/ids';
import type { EventT } from '@/core/schema/event';
import { event } from '@/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { getEventById, getEventChain, getEvents, writeEvent, writeEvents } from './index';

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

async function seedUserCauseEvent(opts: {
  id?: string;
  attempt_event_id: string;
  primary_category?: string;
  user_notes?: string | null;
  created_at?: Date;
}): Promise<string> {
  const db = testDb();
  const id = opts.id ?? newId();
  await db.insert(event).values({
    id,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:user_cause',
    subject_kind: 'event',
    subject_id: opts.attempt_event_id,
    outcome: null,
    payload: {
      primary_category: opts.primary_category ?? 'carelessness',
      user_notes: opts.user_notes ?? null,
    },
    caused_by_event_id: opts.attempt_event_id,
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

async function seedCorrectionEvent(opts: {
  id?: string;
  target_event_id: string;
  correction_kind?: 'supersede' | 'retract' | 'mark_wrong' | 'restore';
  replacement_event_id?: string;
  caused_by_event_id?: string | null;
  created_at?: Date;
}): Promise<string> {
  const db = testDb();
  const id = opts.id ?? newId();
  await db.insert(event).values({
    id,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'correct',
    subject_kind: 'event',
    subject_id: opts.target_event_id,
    outcome: 'success',
    payload: {
      correction_kind: opts.correction_kind ?? 'retract',
      replacement_event_id: opts.replacement_event_id,
      reason_md: 'manual correction',
      affected_refs: [{ kind: 'question', id: 'q1' }],
    },
    caused_by_event_id: opts.caused_by_event_id ?? null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: opts.created_at ?? new Date(),
  });
  return id;
}

describe('getEventById', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns the event when present', async () => {
    const db = testDb();
    const id = await seedAttemptEvent({ question_id: 'q1' });
    const evt = await getEventById(db, id);
    expect(evt).not.toBeNull();
    // EventT is a union (KnownEvent | experimental schemas | ExperimentalEvent).
    // For a fresh seed-and-fetch on an attempt event we expect the KnownEvent
    // AttemptOnQuestion branch; narrow via property access on `as` cast.
    const narrowed = evt as Extract<typeof evt, { action: 'attempt' }>;
    expect(narrowed.action).toBe('attempt');
    expect(narrowed.subject_kind).toBe('question');
    expect(narrowed.subject_id).toBe('q1');
    expect(evt?.correction_status).toEqual({
      state: 'active',
      correction_event_id: null,
      replacement_event_id: null,
    });
  });

  it('returns null when absent', async () => {
    const db = testDb();
    const evt = await getEventById(db, 'nope_no_such_id');
    expect(evt).toBeNull();
  });

  it('returns correction_status for corrected events', async () => {
    const db = testDb();
    const id = await seedAttemptEvent({ question_id: 'q1' });
    const correctionId = await seedCorrectionEvent({
      target_event_id: id,
      correction_kind: 'supersede',
      replacement_event_id: 'evt_replacement',
    });

    const evt = await getEventById(db, id);

    expect(evt?.correction_status).toEqual({
      state: 'superseded',
      correction_event_id: correctionId,
      replacement_event_id: 'evt_replacement',
    });
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
    expect(rows[0].affected_scopes).toEqual(['global']);
  });

  it('writes explicit affected scopes when provided', async () => {
    const db = testDb();
    const id = newId();

    await writeEvent(db, {
      id,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'failure',
      payload: {
        answer_md: 'wrong',
        answer_image_refs: [],
        referenced_knowledge_ids: ['k1'],
      },
      affected_scopes: ['global', 'topic:k1'],
      created_at: new Date(),
    });

    const rows = await db.select().from(event).where(eq(event.id, id));
    expect(rows[0].affected_scopes).toEqual(['global', 'topic:k1']);
  });

  it('validates and inserts a batch while preserving per-row outbox scope semantics', async () => {
    const db = testDb();
    const now = new Date('2026-07-19T14:00:00.000Z');
    const ids = ['evt-batch-1', 'evt-batch-2'];

    const returned = await writeEvents(db, [
      {
        id: ids[0],
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q1',
        outcome: 'failure',
        payload: {
          answer_md: 'wrong',
          answer_image_refs: [],
          referenced_knowledge_ids: ['k1'],
        },
        created_at: now,
      },
      {
        id: ids[1],
        actor_kind: 'system',
        actor_ref: 'test',
        action: 'experimental:test_batch',
        subject_kind: 'query',
        subject_id: 'batch',
        outcome: 'success',
        payload: {},
        ingest_at: now,
        created_at: now,
      },
    ]);

    expect(returned).toEqual(ids);
    const rows = await db.select().from(event).where(inArray(event.id, ids));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === ids[0])?.affected_scopes).toEqual(['global', 'topic:k1']);
    expect(rows.find((row) => row.id === ids[1])?.affected_scopes).toEqual([]);
  });

  it('rejects an invalid batch before inserting any valid prefix', async () => {
    const db = testDb();
    const ids = ['evt-batch-valid-prefix', 'evt-batch-invalid-tail'];
    await expect(
      writeEvents(db, [
        {
          id: ids[0],
          actor_kind: 'system',
          actor_ref: 'test',
          action: 'experimental:test_batch',
          subject_kind: 'query',
          subject_id: 'batch',
          outcome: 'success',
          payload: {},
        },
        {
          id: ids[1],
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'attempt',
          subject_kind: 'question',
          subject_id: 'q-invalid',
          outcome: 'bogus',
          payload: {
            answer_md: 'x',
            answer_image_refs: [],
            referenced_knowledge_ids: [],
          },
        },
      ]),
    ).rejects.toThrow();
    expect(await db.select().from(event).where(inArray(event.id, ids))).toHaveLength(0);
  });

  it('keeps first-write-wins when duplicate ids appear inside one batch', async () => {
    const db = testDb();
    const id = 'evt-batch-duplicate';
    const base = {
      id,
      actor_kind: 'system',
      actor_ref: 'test',
      action: 'experimental:test_batch',
      subject_kind: 'query',
      subject_id: 'batch',
      outcome: 'success',
    } as const;
    await writeEvents(db, [
      { ...base, payload: { ordinal: 1 } },
      { ...base, payload: { ordinal: 2 } },
    ]);

    const rows = await db.select().from(event).where(eq(event.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ ordinal: 1 });
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

  // ADR-0021 outbox contract: writeEvent is INSERT-only — it must NOT enqueue
  // memory ingest synchronously. The new row's `ingest_at` column starts
  // NULL (pending); the per-minute outbox poll handler in
  // `src/server/memory/triggers.ts` picks pending rows with
  // SELECT...FOR UPDATE SKIP LOCKED, enqueues `memory_event_ingest`, and
  // stamps `ingest_at = now()`. Integration tests for the full poller path
  // live in `src/server/memory/triggers.outbox.test.ts` (Phase E).
  it('leaves ingest_at NULL after writeEvent (outbox pending state)', async () => {
    const db = testDb();
    const id = newId();
    await writeEvent(db, {
      id,
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
      created_at: new Date(),
    });
    const rows = await db.select().from(event).where(eq(event.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].ingest_at).toBeNull();
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

  it('returns correction_status on each event envelope', async () => {
    const db = testDb();
    const targetId = await seedAttemptEvent({ question_id: 'q1' });
    const correctionId = await seedCorrectionEvent({
      target_event_id: targetId,
      correction_kind: 'retract',
    });

    const results = await getEvents(db, { action: 'attempt' });

    expect(results).toHaveLength(1);
    expect(results[0].correction_status).toEqual({
      state: 'retracted',
      correction_event_id: correctionId,
      replacement_event_id: null,
    });
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

  it('clamps nonpositive limits to one event', async () => {
    const db = testDb();
    await seedAttemptEvent({ question_id: 'q1' });
    await seedAttemptEvent({ question_id: 'q2' });

    await expect(getEvents(db, { limit: 0 })).resolves.toHaveLength(1);
    await expect(getEvents(db, { limit: -1 })).resolves.toHaveLength(1);
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
    expect(chain.caused_events[0].correction_status.state).toBe('active');
    expect(chain.corrections).toEqual([]);
  });

  it('returns caused_by populated for a judge event (focal=judge → caused_by=attempt)', async () => {
    const db = testDb();
    const attemptId = await seedAttemptEvent({ question_id: 'q1' });
    const judgeId = await seedJudgeEvent({ attempt_event_id: attemptId });
    const chain = await getEventChain(db, judgeId);
    expect(chain.caused_by).not.toBeNull();
    expect(chain.caused_by?.action).toBe('attempt');
    expect(chain.caused_by?.correction_status.state).toBe('active');
    expect(chain.caused_events).toHaveLength(0);
  });

  it('returns correction events targeting the focal event', async () => {
    const db = testDb();
    const attemptId = await seedAttemptEvent({ question_id: 'q1' });
    const correctionId = await seedCorrectionEvent({
      target_event_id: attemptId,
      correction_kind: 'retract',
      caused_by_event_id: attemptId,
    });

    const chain = await getEventChain(db, attemptId);

    expect(chain.caused_events.map((e) => e.id)).not.toContain(correctionId);
    expect(chain.corrections).toHaveLength(1);
    expect(chain.corrections[0].id).toBe(correctionId);
    expect(chain.corrections[0].action).toBe('correct');
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
    expect(chain.corrections).toEqual([]);
  });
});
