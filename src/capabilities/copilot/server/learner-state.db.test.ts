// YUK-574 — db test for the learner-state header IO layer. Runs in the db vitest
// config (real Postgres testcontainer) because it exercises writeEvent + parseEvent
// (the cache event must be a valid ExperimentalEvent), the grouped watermark query,
// the cache round-trip, and the resolver's real watermark-driven invalidation.

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { event, goal, knowledge } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { resetDb } from '../../../../tests/helpers/db';
import {
  LEARNER_STATE_HEADER_ACTION,
  type LearnerStateProjection,
  readLatestLearnerStateHeaderCache,
  readLearnerStateProjection,
  readLearnerStateWatermarks,
  resolveLearnerStateHeader,
  writeLearnerStateHeaderCache,
} from './learner-state';

beforeEach(async () => {
  await resetDb();
});

const COLD_PROJECTION: LearnerStateProjection = {
  reviewDueCount: 0,
  activeGoalTitle: null,
  topCauseCategories: [],
  masterySummary: null,
  meanTheta: null,
  overnightSentence: null,
};

async function writeAttempt(at: Date): Promise<void> {
  await writeEvent(db, {
    id: `attempt_${createId()}`,
    actor_kind: 'user',
    actor_ref: 'user:self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: `q_${createId()}`,
    outcome: 'success',
    payload: { answer_md: 'a', answer_image_refs: [], referenced_knowledge_ids: [] },
    created_at: at,
  });
}

async function writeRate(at: Date): Promise<void> {
  await writeEvent(db, {
    id: `rate_${createId()}`,
    actor_kind: 'user',
    actor_ref: 'user:self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: `evt_${createId()}`,
    outcome: 'success',
    payload: { rating: 'accept' },
    created_at: at,
  });
}

async function writeDreamingScan(at: Date): Promise<void> {
  await writeEvent(db, {
    id: `dreaming_scan_${createId()}`,
    actor_kind: 'agent',
    actor_ref: 'dreaming',
    action: 'experimental:dreaming_scan',
    subject_kind: 'query',
    subject_id: `trigger_${createId()}`,
    outcome: 'success',
    payload: { proposals_created: 0, pending_after: 0 },
    created_at: at,
  });
}

// Review-lane fixture (review-verdict fix #1) — the FSRS review-queue clearing
// write (src/capabilities/practice/api/submit.ts) uses a DISTINCT action='review',
// not 'attempt'. A pure-review session (no fresh 'attempt' rows) must still
// invalidate the header, since it directly moves review_due_count.
async function writeReview(at: Date): Promise<void> {
  await writeEvent(db, {
    id: `review_${createId()}`,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'review',
    subject_kind: 'question',
    subject_id: `q_${createId()}`,
    outcome: 'success',
    payload: {
      fsrs_rating: 'good',
      fsrs_state_after: {
        state: 'review',
        due: at.toISOString(),
        stability: 1,
        difficulty: 1,
        elapsed_days: 0,
        scheduled_days: 1,
        learning_steps: 0,
        reps: 1,
        lapses: 0,
        last_review: at.toISOString(),
      },
      user_response_md: null,
      referenced_knowledge_ids: [],
    },
    created_at: at,
  });
}

async function cacheRowCount(sessionId: string): Promise<number> {
  const rows = await db
    .select({ id: event.id })
    .from(event)
    .where(and(eq(event.session_id, sessionId), eq(event.action, LEARNER_STATE_HEADER_ACTION)));
  return rows.length;
}

describe('readLearnerStateWatermarks', () => {
  it('reads latest created_at per category; null when the category is empty', async () => {
    expect(await readLearnerStateWatermarks(db)).toEqual({
      attempt_at: null,
      dreaming_at: null,
      proposal_decision_at: null,
    });

    await writeAttempt(new Date('2026-07-06T08:00:00.000Z'));
    await writeAttempt(new Date('2026-07-06T09:00:00.000Z')); // newest attempt
    await writeDreamingScan(new Date('2026-07-06T03:00:00.000Z'));
    await writeRate(new Date('2026-07-06T07:00:00.000Z'));

    const wm = await readLearnerStateWatermarks(db);
    expect(wm.attempt_at).toBe('2026-07-06T09:00:00.000Z');
    expect(wm.dreaming_at).toBe('2026-07-06T03:00:00.000Z');
    expect(wm.proposal_decision_at).toBe('2026-07-06T07:00:00.000Z');
  });

  // Review-verdict fix #1 (MAJOR) — FSRS review-queue clearing writes a DISTINCT
  // action='review' (practice/api/submit.ts), not 'attempt'. A pure-review
  // session (no 'attempt' rows) must still advance attempt_at, since 'review'
  // directly moves review_due_count — otherwise "今日待复习" headline goes stale
  // until some OTHER trigger fires.
  it('folds a newer `review` event into attempt_at (pure-review session counts as new activity)', async () => {
    await writeAttempt(new Date('2026-07-06T08:00:00.000Z'));
    await writeReview(new Date('2026-07-06T09:30:00.000Z')); // newer than the attempt

    const wm = await readLearnerStateWatermarks(db);
    expect(wm.attempt_at).toBe('2026-07-06T09:30:00.000Z');
  });

  it('folds attempt_at from `review` alone when there is no `attempt` row at all', async () => {
    await writeReview(new Date('2026-07-06T09:30:00.000Z'));
    const wm = await readLearnerStateWatermarks(db);
    expect(wm.attempt_at).toBe('2026-07-06T09:30:00.000Z');
  });

  it('keeps the newer `attempt` when it postdates `review` (fold takes the max, not review-always-wins)', async () => {
    await writeReview(new Date('2026-07-06T08:00:00.000Z'));
    await writeAttempt(new Date('2026-07-06T09:30:00.000Z'));
    const wm = await readLearnerStateWatermarks(db);
    expect(wm.attempt_at).toBe('2026-07-06T09:30:00.000Z');
  });
});

describe('learner-state header cache round-trip', () => {
  it('writes a parseEvent-valid cache event (ingest_at opt-out) and reads it back', async () => {
    const now = new Date('2026-07-06T09:00:00.000Z');
    await writeLearnerStateHeaderCache(
      db,
      {
        session_id: 'ls_db_cache',
        header_md: '今日待复习 5 项',
        proposal_feedback: [
          {
            kind: 'knowledge_edge',
            relation: 'prerequisite',
            acceptance_rate: 0.6,
            top_dismiss_reasons: [],
            top_rubric_gates: [],
          },
        ],
        assembled_at: now.toISOString(),
        day_bucket: '2026-07-06',
        watermarks: {
          attempt_at: '2026-07-06T08:00:00.000Z',
          dreaming_at: null,
          proposal_decision_at: null,
        },
      },
      now,
    );

    const cached = await readLatestLearnerStateHeaderCache(db, 'ls_db_cache');
    expect(cached?.header_md).toBe('今日待复习 5 项');
    expect(cached?.day_bucket).toBe('2026-07-06');
    expect(cached?.proposal_feedback).toEqual([
      {
        kind: 'knowledge_edge',
        relation: 'prerequisite',
        acceptance_rate: 0.6,
        top_dismiss_reasons: [],
        top_rubric_gates: [],
      },
    ]);
    expect(cached?.watermarks.attempt_at).toBe('2026-07-06T08:00:00.000Z');

    // The raw row exists, is the header action, and is opted OUT of the mem0
    // outbox (ADR-0039 red line — a deterministic projection must not feed mem0).
    const rows = await db
      .select({ ingest_at: event.ingest_at, actor_ref: event.actor_ref })
      .from(event)
      .where(
        and(eq(event.session_id, 'ls_db_cache'), eq(event.action, LEARNER_STATE_HEADER_ACTION)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ingest_at).not.toBeNull();
    expect(rows[0]?.actor_ref).toBe('system:copilot_learner_state');
  });

  it('returns the NEWEST cache row for the session (latest wins)', async () => {
    const older = new Date('2026-07-06T08:00:00.000Z');
    const newer = new Date('2026-07-06T09:00:00.000Z');
    const base = {
      session_id: 'ls_db_latest',
      proposal_feedback: [],
      day_bucket: '2026-07-06',
      watermarks: { attempt_at: null, dreaming_at: null, proposal_decision_at: null },
    };
    await writeLearnerStateHeaderCache(
      db,
      { ...base, header_md: 'OLD', assembled_at: older.toISOString() },
      older,
    );
    await writeLearnerStateHeaderCache(
      db,
      { ...base, header_md: 'NEW', assembled_at: newer.toISOString() },
      newer,
    );
    const cached = await readLatestLearnerStateHeaderCache(db, 'ls_db_latest');
    expect(cached?.header_md).toBe('NEW');
  });

  // PR #717 bot review fix #2 (MINOR) — a persisted cache row may predate a
  // schema shift (or be otherwise corrupt); a blind cast to
  // ScopedProposalFeedbackCell[] would let a malformed cell through and crash a
  // downstream `.top_dismiss_reasons.length` read. parseCache must per-cell
  // type-guard and FILTER (not reject the whole payload).
  it('filters malformed proposal_feedback cells but keeps valid ones (no throw)', async () => {
    const sessionId = 'ls_db_malformed';
    const id = `copilot_learner_state_${createId()}`;
    // Written directly (bypassing writeLearnerStateHeaderCache's typed input) to
    // simulate a corrupt / pre-schema-shift persisted row. experimental:* payload
    // is a loose z.record escape hatch, so this passes writeEvent's parseEvent.
    await writeEvent(db, {
      id,
      session_id: sessionId,
      actor_kind: 'system',
      actor_ref: 'system:copilot_learner_state',
      action: LEARNER_STATE_HEADER_ACTION,
      subject_kind: 'query',
      subject_id: id,
      outcome: null,
      payload: {
        session_id: sessionId,
        header_md: '今日待复习 2 项',
        day_bucket: '2026-07-06',
        assembled_at: '2026-07-06T09:00:00.000Z',
        watermarks: { attempt_at: null, dreaming_at: null, proposal_decision_at: null },
        proposal_feedback: [
          {
            kind: 'knowledge_edge',
            relation: 'prerequisite',
            acceptance_rate: 0.5,
            top_dismiss_reasons: [],
            top_rubric_gates: [],
          },
          // Malformed: top_dismiss_reasons is missing (not an array at all) —
          // a blind cast + `.length` read downstream would throw on this cell.
          { kind: 'knowledge_edge', relation: 'related_to', acceptance_rate: 0.2 },
          // Malformed: kind is not a string.
          { kind: 42, relation: null, top_dismiss_reasons: [], top_rubric_gates: [] },
        ],
      },
      ingest_at: new Date('2026-07-06T09:00:00.000Z'),
      created_at: new Date('2026-07-06T09:00:00.000Z'),
    });

    const cached = await readLatestLearnerStateHeaderCache(db, sessionId);
    expect(cached).not.toBeNull();
    expect(cached?.proposal_feedback).toEqual([
      {
        kind: 'knowledge_edge',
        relation: 'prerequisite',
        acceptance_rate: 0.5,
        top_dismiss_reasons: [],
        top_rubric_gates: [],
      },
    ]);
    // The would-be-crashing field access never throws once filtered.
    expect(() => cached?.proposal_feedback.map((c) => c.top_dismiss_reasons.length)).not.toThrow();
  });
});

describe('resolveLearnerStateHeader (real cache IO + watermark-driven invalidation)', () => {
  it('assembles once, reuses the cache, and reassembles when dreaming runs', async () => {
    const now = () => new Date('2026-07-06T09:00:00.000Z');
    let projectionCalls = 0;
    const deps = {
      readProjectionFn: async () => {
        projectionCalls += 1;
        return { ...COLD_PROJECTION, reviewDueCount: projectionCalls };
      },
      loadProposalFeedbackFn: async () => [],
      now,
    };

    // Cold: assembles once, persists exactly one cache row.
    const h1 = await resolveLearnerStateHeader(db, 'ls_db_resolve', deps);
    expect(projectionCalls).toBe(1);
    expect(h1.header_md).toContain('1');
    expect(await cacheRowCount('ls_db_resolve')).toBe(1);

    // Warm, no new events: reuses the cache (NO reassembly), still one row.
    const h2 = await resolveLearnerStateHeader(db, 'ls_db_resolve', deps);
    expect(projectionCalls).toBe(1);
    expect(h2.header_md).toBe(h1.header_md);
    expect(await cacheRowCount('ls_db_resolve')).toBe(1);

    // Dreaming runs → the dreaming watermark advances → reassemble, second row.
    await writeDreamingScan(new Date('2026-07-06T08:59:00.000Z'));
    const h3 = await resolveLearnerStateHeader(db, 'ls_db_resolve', deps);
    expect(projectionCalls).toBe(2);
    expect(h3.header_md).toContain('2');
    expect(await cacheRowCount('ls_db_resolve')).toBe(2);
  });

  // Review-verdict fix #1 (MAJOR) — a PURE-REVIEW session (no 'attempt' events at
  // all) must still invalidate a warm cache, because FSRS review clearing is the
  // exact signal that moves review_due_count (the header's "今日待复习" headline).
  it('a pure-review session (no attempt events) invalidates the cached header', async () => {
    const deps = {
      readProjectionFn: async () => COLD_PROJECTION,
      loadProposalFeedbackFn: async () => [],
      now: () => new Date('2026-07-06T09:00:00.000Z'),
    };

    // Cold assemble + cache.
    await resolveLearnerStateHeader(db, 'ls_db_review', deps);
    expect(await cacheRowCount('ls_db_review')).toBe(1);

    // Warm reuse: still one row (no new events).
    await resolveLearnerStateHeader(db, 'ls_db_review', deps);
    expect(await cacheRowCount('ls_db_review')).toBe(1);

    // A review event lands (FSRS queue clearing) — NO 'attempt' row at all.
    await writeReview(new Date('2026-07-06T08:59:00.000Z'));
    await resolveLearnerStateHeader(db, 'ls_db_review', deps);
    expect(await cacheRowCount('ls_db_review')).toBe(2);
  });
});

describe('readLearnerStateProjection', () => {
  it('returns a cold projection on an empty DB (composition smoke, real readers)', async () => {
    const proj = await readLearnerStateProjection(db);
    expect(proj).toEqual(COLD_PROJECTION);
  });

  // YUK-603 (§8 test 5) — the UN-STUBBED default goal reader: a real subject_live goal row
  // (frozen scope []) flows through listActiveGoalsWithResolvedScope's live subject
  // resolution. This drives the real default (no listActiveGoalsFn injection anywhere in the
  // projection path) so a swap back to the frozen read goes red here.
  it('YUK-603: a subject_live goal surfaces via the real default reader (live-resolved scope path)', async () => {
    const now = new Date();
    await db.insert(knowledge).values([
      {
        id: 'seed:yuwen:root',
        name: '语文',
        domain: 'yuwen',
        parent_id: null,
        created_at: now,
        updated_at: now,
        version: 0,
      },
      {
        id: 'kc_ls',
        name: '虚词',
        domain: null,
        parent_id: 'seed:yuwen:root',
        created_at: now,
        updated_at: now,
        version: 0,
      },
    ]);
    await db.insert(goal).values({
      id: 'g_ls',
      title: '读透《史记》',
      subject_id: 'yuwen',
      scope_knowledge_ids: [], // frozen [] — the goal-strand read must live-resolve
      scope_mode: 'subject_live',
      sequence_hint: 0,
      status: 'active',
      source: 'manual',
      source_ref: null,
      created_at: now,
      updated_at: now,
      version: 0,
    });

    const proj = await readLearnerStateProjection(db);
    expect(proj.activeGoalTitle).toBe('读透《史记》');
    // Live-resolved scope is non-empty ([kc_ls]) so the mastery leg RUNS; with no mastery
    // rows it summarizes to null without throwing — the path itself is what this pins.
    expect(proj.masterySummary).toBeNull();
    expect(proj.meanTheta).toBeNull();
  });
});
