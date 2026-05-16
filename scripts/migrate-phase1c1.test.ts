// Phase 1c.1 Step 3 migration — unit tests per migrate fn.
//
// Each test pre-seeds a legacy fixture (mistake / review_event / dreaming_proposal /
// ingestion_session) and asserts the migrate function produces the expected
// event / learning_session / material_fsrs_state rows. Every constructed event
// must pass `parseEvent` (verified inside the migrate fn) — this guards against
// silent drift from Lane B's locked KnownEvent contract.

import { question, mistake, event, review_event, material_fsrs_state, dreaming_proposal, ingestion_session, learning_session } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../tests/helpers/db';
import { migrateMistakes } from './migrate-phase1c1';

const QUESTION_ID = 'q_test_001';

async function seedQuestion(id: string = QUESTION_ID) {
  const db = testDb();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: 'test prompt',
    source: 'manual',
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  });
}

describe('migrateMistakes — no-cause path (3.A)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedQuestion();
  });

  it('emits 1 attempt event for a mistake with no cause', async () => {
    const db = testDb();
    const mistakeId = 'm_no_cause_001';
    const now = new Date('2026-02-01T12:00:00Z');
    await db.insert(mistake).values({
      id: mistakeId,
      question_id: QUESTION_ID,
      wrong_answer_md: 'my wrong answer',
      wrong_answer_image_refs: ['img1', 'img2'],
      source: 'manual',
      knowledge_ids: ['k1', 'k2'],
      cause: null,
      fsrs_state: null,
      created_at: now,
      updated_at: now,
    });

    await migrateMistakes(db);

    const events = await db.select().from(event);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.id).toBe(`evt_mistake_${mistakeId}`);
    expect(ev.action).toBe('attempt');
    expect(ev.subject_kind).toBe('question');
    expect(ev.subject_id).toBe(QUESTION_ID);
    expect(ev.outcome).toBe('failure');
    expect(ev.actor_kind).toBe('user');
    expect(ev.actor_ref).toBe('self');
    expect(ev.session_id).toBeNull();
    expect(ev.caused_by_event_id).toBeNull();
    expect(ev.payload).toEqual({
      answer_md: 'my wrong answer',
      answer_image_refs: ['img1', 'img2'],
      referenced_knowledge_ids: ['k1', 'k2'],
    });
  });

  it('coalesces null wrong_answer_md / knowledge_ids defaults', async () => {
    const db = testDb();
    const mistakeId = 'm_null_fields_001';
    const now = new Date('2026-02-02T12:00:00Z');
    await db.insert(mistake).values({
      id: mistakeId,
      question_id: QUESTION_ID,
      wrong_answer_md: null,
      source: 'quiz_answer',
      cause: null,
      fsrs_state: null,
      created_at: now,
      updated_at: now,
    });

    await migrateMistakes(db);

    const events = await db.select().from(event).where(eq(event.id, `evt_mistake_${mistakeId}`));
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({
      answer_md: null,
      answer_image_refs: [],
      referenced_knowledge_ids: [],
    });
  });
});

describe('migrateMistakes — cause bridge (3.B)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedQuestion();
  });

  it('emits attempt + chained judge for mistake with full legacy cause', async () => {
    const db = testDb();
    const mistakeId = 'm_with_cause_001';
    const created = new Date('2026-02-01T10:00:00Z');
    const updated = new Date('2026-02-01T11:00:00Z'); // judge timestamp
    await db.insert(mistake).values({
      id: mistakeId,
      question_id: QUESTION_ID,
      wrong_answer_md: 'wrong',
      wrong_answer_image_refs: [],
      source: 'manual',
      knowledge_ids: ['k_concept_a'],
      // Full legacy Cause shape from business.ts
      cause: {
        primary_category: 'concept',
        secondary_categories: ['knowledge_gap'],
        ai_analysis_md: '错因分析正文',
        user_notes: 'user wrote this',
        partial: false,
        confidence: 0.85,
        user_edited: true,
      },
      fsrs_state: null,
      created_at: created,
      updated_at: updated,
    });

    await migrateMistakes(db);

    const events = await db.select().from(event);
    expect(events).toHaveLength(2);

    const attempt = events.find((e) => e.action === 'attempt');
    const judge = events.find((e) => e.action === 'judge');
    expect(attempt).toBeDefined();
    expect(judge).toBeDefined();
    if (!attempt || !judge) return;

    // judge chains on attempt
    expect(judge.caused_by_event_id).toBe(attempt.id);
    expect(judge.subject_kind).toBe('event');
    expect(judge.subject_id).toBe(attempt.id);
    expect(judge.actor_kind).toBe('agent');
    expect(judge.actor_ref).toBe('legacy_attribution');
    expect(judge.outcome).toBe('success');
    expect(judge.created_at).toEqual(updated); // best-proxy: mistake.updated_at

    // Cause bridge: ai_analysis_md → analysis_md; user_notes/partial/user_edited dropped
    expect(judge.payload).toEqual({
      cause: {
        primary_category: 'concept',
        secondary_categories: ['knowledge_gap'],
        analysis_md: '错因分析正文',
        confidence: 0.85,
      },
      referenced_knowledge_ids: ['k_concept_a'],
    });
  });

  it('defaults confidence=0.5 when legacy confidence is null', async () => {
    const db = testDb();
    const mistakeId = 'm_null_conf_001';
    const now = new Date('2026-02-03T00:00:00Z');
    await db.insert(mistake).values({
      id: mistakeId,
      question_id: QUESTION_ID,
      source: 'manual',
      // Legacy jsonb shape — cast through unknown since some legacy rows
      // omit secondary_categories / confidence (Zod default fills them at parse).
      cause: {
        primary_category: 'carelessness',
        ai_analysis_md: 'forgot to check',
        user_edited: false,
        // secondary_categories + confidence missing — exercise bridge defaults
      } as unknown as NonNullable<typeof mistake.$inferInsert.cause>,
      fsrs_state: null,
      created_at: now,
      updated_at: now,
    });

    await migrateMistakes(db);

    const judge = (await db.select().from(event)).find((e) => e.action === 'judge');
    expect(judge).toBeDefined();
    const payload = judge?.payload as { cause: { confidence: number; secondary_categories: string[] } };
    expect(payload.cause.confidence).toBe(0.5);
    expect(payload.cause.secondary_categories).toEqual([]);
  });
});

describe('migrateReviewEvents — review events + FSRS projection (3.C)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedQuestion();
  });

  function buildFsrsState(due: Date, reps: number) {
    return {
      due,
      stability: 1.5,
      difficulty: 5.0,
      elapsed_days: 1,
      scheduled_days: 2,
      learning_steps: 0,
      reps,
      lapses: 0,
      state: 'review' as const,
      last_review: new Date('2026-03-01T00:00:00Z'),
    };
  }

  it('emits 3 review events + 1 material_fsrs_state with latest state', async () => {
    const db = testDb();
    const mistakeId = 'm_with_reviews';
    const baseTime = new Date('2026-03-01T00:00:00Z');
    await db.insert(mistake).values({
      id: mistakeId,
      question_id: QUESTION_ID,
      source: 'manual',
      knowledge_ids: ['k_topic_a'],
      cause: null,
      fsrs_state: null,
      created_at: baseTime,
      updated_at: baseTime,
    });

    const reviews = [
      { id: 're_001', rating: 'good', day: 1 },
      { id: 're_002', rating: 'hard', day: 2 },
      { id: 're_003', rating: 'again', day: 3 },
    ] as const;

    for (const r of reviews) {
      const at = new Date(baseTime.getTime() + r.day * 86400000);
      const due = new Date(at.getTime() + 86400000);
      await db.insert(review_event).values({
        id: r.id,
        mistake_id: mistakeId,
        rating: r.rating,
        response_md: `response ${r.id}`,
        latency_ms: 5000,
        fsrs_state_before: buildFsrsState(at, r.day - 1),
        fsrs_state_after: buildFsrsState(due, r.day),
        due_at_before: at,
        due_at_next: due,
        created_at: at,
      });
    }

    const { migrateReviewEvents } = await import('./migrate-phase1c1');
    await migrateReviewEvents(db);

    const reviewEvents = await db.select().from(event);
    expect(reviewEvents).toHaveLength(3);
    for (const re of reviewEvents) {
      expect(re.action).toBe('review');
      expect(re.subject_kind).toBe('question');
      expect(re.subject_id).toBe(QUESTION_ID);
      const payload = re.payload as { fsrs_rating: string; user_response_md: string | null; referenced_knowledge_ids: string[] };
      expect(payload.referenced_knowledge_ids).toEqual(['k_topic_a']);
      expect(payload.user_response_md).toMatch(/^response /);
      // outcome invariant: again→failure, hard/good→success
      const expectedOutcome = payload.fsrs_rating === 'again' ? 'failure' : 'success';
      expect(re.outcome).toBe(expectedOutcome);
    }

    // material_fsrs_state: 1 row keyed at question grain, state from latest review
    const fsrsStates = await db.select().from(material_fsrs_state);
    expect(fsrsStates).toHaveLength(1);
    expect(fsrsStates[0].subject_kind).toBe('question');
    expect(fsrsStates[0].subject_id).toBe(QUESTION_ID);
    expect(fsrsStates[0].last_review_event_id).toBe(deterministicIdHelper('evt_review', 're_003'));
    // due_at = latest state.due (day 4)
    expect(fsrsStates[0].due_at).toEqual(new Date(baseTime.getTime() + 4 * 86400000));
  });

  it('fallback: mistake.fsrs_state with ZERO review_events → material_fsrs_state from mistake', async () => {
    const db = testDb();
    const mistakeId = 'm_fsrs_only';
    const created = new Date('2026-03-05T00:00:00Z');
    const due = new Date('2026-03-06T00:00:00Z');
    await db.insert(mistake).values({
      id: mistakeId,
      question_id: QUESTION_ID,
      source: 'manual',
      knowledge_ids: [],
      cause: null,
      fsrs_state: buildFsrsState(due, 0),
      created_at: created,
      updated_at: created,
    });

    const { migrateReviewEvents } = await import('./migrate-phase1c1');
    await migrateReviewEvents(db);

    // No review events emitted (no review_events to migrate)
    const reviewEvents = await db.select().from(event);
    expect(reviewEvents).toHaveLength(0);

    // Fallback FSRS state written from mistake.fsrs_state
    const fsrsStates = await db.select().from(material_fsrs_state);
    expect(fsrsStates).toHaveLength(1);
    expect(fsrsStates[0].subject_id).toBe(QUESTION_ID);
    expect(fsrsStates[0].last_review_event_id).toBeNull();
    expect(fsrsStates[0].due_at).toEqual(due);
  });
});

// Hoisted helper for the tests' deterministic ID matcher (matches src/core/ids.ts)
function deterministicIdHelper(prefix: string, sourceId: string): string {
  return `${prefix}_${sourceId}`;
}

describe('migrateDreamingProposals — propose event (3.D)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function seedKnowledge(id: string) {
    const db = testDb();
    await db.insert(question).values({
      id: `q_unused_${id}`,
      kind: 'short_answer',
      prompt_md: 'x',
      source: 'manual',
      created_at: new Date(),
      updated_at: new Date(),
    });
  }

  it('pending → outcome=partial; accepted → success; rejected → partial + reasoning prefix', async () => {
    const db = testDb();
    const proposedAt = new Date('2026-04-01T00:00:00Z');

    const fixtures = [
      { id: 'dp_pending', status: 'pending', expectedOutcome: 'partial', expectReasoningPrefix: false },
      { id: 'dp_accepted', status: 'accepted', expectedOutcome: 'success', expectReasoningPrefix: false },
      { id: 'dp_rejected', status: 'rejected', expectedOutcome: 'partial', expectReasoningPrefix: true },
    ] as const;

    for (const f of fixtures) {
      await db.insert(dreaming_proposal).values({
        id: f.id,
        kind: 'knowledge',
        payload: {
          proposed_knowledge: { name: `node_${f.id}`, parent_id: 'k_parent_x' },
        },
        reasoning: `legacy reasoning for ${f.id}`,
        status: f.status,
        proposed_at: proposedAt,
        decided_at: f.status === 'pending' ? null : new Date('2026-04-02T00:00:00Z'),
      });
    }

    const { migrateDreamingProposals } = await import('./migrate-phase1c1');
    await migrateDreamingProposals(db);

    const events = await db.select().from(event);
    expect(events).toHaveLength(3);
    for (const f of fixtures) {
      const ev = events.find((e) => e.id === `evt_propose_${f.id}`);
      expect(ev, `event for ${f.id} should exist`).toBeDefined();
      if (!ev) continue;
      expect(ev.action).toBe('propose');
      expect(ev.subject_kind).toBe('knowledge');
      expect(ev.actor_kind).toBe('agent');
      expect(ev.actor_ref).toBe('dreaming');
      expect(ev.outcome).toBe(f.expectedOutcome);
      const p = ev.payload as { name: string; parent_id: string; reasoning: string };
      expect(p.name).toBe(`node_${f.id}`);
      expect(p.parent_id).toBe('k_parent_x');
      if (f.expectReasoningPrefix) {
        expect(p.reasoning.startsWith('[legacy rejected] ')).toBe(true);
      } else {
        expect(p.reasoning.startsWith('[legacy rejected] ')).toBe(false);
      }
    }
  });

  it('skips proposals missing name or parent_id + emits a stable warn marker', async () => {
    const db = testDb();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: unknown) => {
      if (typeof msg === 'string') warnings.push(msg);
    };
    try {
      await db.insert(dreaming_proposal).values({
        id: 'dp_no_name',
        kind: 'knowledge',
        payload: { proposed_knowledge: { parent_id: 'k_parent_x' } }, // name missing
        reasoning: 'reasoning',
        status: 'pending',
        proposed_at: new Date('2026-04-03T00:00:00Z'),
      });
      await db.insert(dreaming_proposal).values({
        id: 'dp_no_parent',
        kind: 'knowledge',
        payload: { proposed_knowledge: { name: 'orphan_node' } }, // parent_id missing
        reasoning: 'reasoning',
        status: 'pending',
        proposed_at: new Date('2026-04-03T00:00:00Z'),
      });

      const { migrateDreamingProposals } = await import('./migrate-phase1c1');
      await migrateDreamingProposals(db);

      const events = await db.select().from(event);
      expect(events).toHaveLength(0);
      // Both should have logged a warning with the stable prefix
      const hits = warnings.filter((w) => w.startsWith('[migrate-phase1c1] skip propose'));
      expect(hits).toHaveLength(2);
      expect(hits.some((w) => w.includes('dp_no_name'))).toBe(true);
      expect(hits.some((w) => w.includes('dp_no_parent'))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('assertJudgmentEmpty — data-assumptions §O2 precheck (3.F)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns ok=true when judgment table is absent (dropped at Step 1.4) — production state", async () => {
    const db = testDb();
    const { assertJudgmentEmpty } = await import('./migrate-phase1c1');
    const result = await assertJudgmentEmpty(db);
    expect(result.ok).toBe(true);
    // Discriminated union narrowed; no error field on ok=true branch.
  });

  it("returns ok=true when judgment table exists but is empty", async () => {
    const db = testDb();
    const { sql } = await import('drizzle-orm');
    // Temporarily recreate the table (it was DROPped at Step 1.4) to exercise
    // the "empty table" path. Schema is minimal — we only need the table to
    // exist so SELECT COUNT(*) succeeds with 0 rows.
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS "judgment" (id text PRIMARY KEY)`));
    try {
      const { assertJudgmentEmpty } = await import('./migrate-phase1c1');
      const result = await assertJudgmentEmpty(db);
      expect(result.ok).toBe(true);
    } finally {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS "judgment"`));
    }
  });

  it("returns ok=false with stable error marker when judgment has rows (data-assumptions §O2 violation)", async () => {
    const db = testDb();
    const { sql } = await import('drizzle-orm');
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS "judgment" (id text PRIMARY KEY)`));
    try {
      await db.execute(sql.raw(`INSERT INTO "judgment" (id) VALUES ('j_unexpected_001')`));
      const { assertJudgmentEmpty } = await import('./migrate-phase1c1');
      const result = await assertJudgmentEmpty(db);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      // Stable marker for caller-side detection
      expect(result.error).toMatch(/judgment table/i);
      expect(result.error).toMatch(/1 row/);
    } finally {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS "judgment"`));
    }
  });
});

describe('migrateIngestionSessions — ingestion_session → learning_session (3.E)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('preserves id, sets type=ingestion, status passthrough; ended_at on terminal status', async () => {
    const db = testDb();
    const now = new Date('2026-05-01T00:00:00Z');
    const later = new Date('2026-05-01T01:00:00Z');

    // 'imported' is terminal — ended_at = updated_at
    await db.insert(ingestion_session).values({
      id: 'is_imported_001',
      source_document_id: 'sd_1',
      source_asset_ids: ['sa_1'],
      status: 'imported',
      entrypoint: 'vision_single',
      warnings: ['w1'],
      error_message: null,
      created_at: now,
      updated_at: later,
      version: 2,
    });

    // 'failed' is terminal — ended_at = updated_at
    await db.insert(ingestion_session).values({
      id: 'is_failed_001',
      source_document_id: null,
      source_asset_ids: [],
      status: 'failed',
      entrypoint: 'vision_paper',
      warnings: [],
      error_message: 'OCR returned nothing',
      created_at: now,
      updated_at: later,
      version: 0,
    });

    // 'extracting' is mid-flight — ended_at = null
    await db.insert(ingestion_session).values({
      id: 'is_mid_001',
      source_document_id: 'sd_2',
      source_asset_ids: [],
      status: 'extracting',
      entrypoint: 'vision_single',
      warnings: [],
      created_at: now,
      updated_at: later,
      version: 1,
    });

    const { migrateIngestionSessions } = await import('./migrate-phase1c1');
    await migrateIngestionSessions(db);

    const sessions = await db.select().from(learning_session);
    expect(sessions).toHaveLength(3);

    const imported = sessions.find((s) => s.id === 'is_imported_001');
    expect(imported).toBeDefined();
    expect(imported?.type).toBe('ingestion');
    expect(imported?.status).toBe('imported');
    expect(imported?.source_document_id).toBe('sd_1');
    expect(imported?.entrypoint).toBe('vision_single');
    expect(imported?.warnings).toEqual(['w1']);
    expect(imported?.ended_at).toEqual(later);
    expect(imported?.started_at).toEqual(now);
    expect(imported?.summary_md).toBeNull();
    expect(imported?.goal_id).toBeNull();
    expect(imported?.version).toBe(2);

    const failed = sessions.find((s) => s.id === 'is_failed_001');
    expect(failed?.ended_at).toEqual(later);
    expect(failed?.error_message).toBe('OCR returned nothing');

    const mid = sessions.find((s) => s.id === 'is_mid_001');
    expect(mid?.ended_at).toBeNull();
  });
});

describe('runMigration — orchestrator + idempotent re-run (3.G)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedQuestion();
  });

  it('processes mixed fixture: 2 mistakes + 1 review chain + 1 dreaming_proposal + 1 ingestion_session', async () => {
    const db = testDb();
    const baseTime = new Date('2026-06-01T00:00:00Z');

    // 2 mistakes (1 with cause, 1 without)
    await db.insert(mistake).values({
      id: 'm_orch_no_cause',
      question_id: QUESTION_ID,
      wrong_answer_md: 'wrong A',
      source: 'manual',
      knowledge_ids: ['k_orch_a'],
      cause: null,
      fsrs_state: null,
      created_at: baseTime,
      updated_at: baseTime,
    });
    await db.insert(mistake).values({
      id: 'm_orch_with_cause',
      question_id: QUESTION_ID,
      wrong_answer_md: 'wrong B',
      source: 'manual',
      knowledge_ids: ['k_orch_b'],
      cause: {
        primary_category: 'concept',
        secondary_categories: [],
        ai_analysis_md: 'orchestrator-test cause',
        user_edited: false,
        confidence: 0.7,
      },
      fsrs_state: null,
      created_at: baseTime,
      updated_at: new Date(baseTime.getTime() + 1000),
    });

    // 1 review chain on m_orch_no_cause
    await db.insert(review_event).values({
      id: 're_orch_001',
      mistake_id: 'm_orch_no_cause',
      rating: 'good',
      response_md: 'orch review response',
      latency_ms: 4000,
      fsrs_state_before: null,
      fsrs_state_after: {
        due: new Date(baseTime.getTime() + 86400000),
        stability: 1.5,
        difficulty: 5.0,
        elapsed_days: 1,
        scheduled_days: 1,
        learning_steps: 0,
        reps: 1,
        lapses: 0,
        state: 'review',
        last_review: baseTime,
      },
      due_at_before: baseTime,
      due_at_next: new Date(baseTime.getTime() + 86400000),
      created_at: new Date(baseTime.getTime() + 3600000),
    });

    // 1 dreaming_proposal
    await db.insert(dreaming_proposal).values({
      id: 'dp_orch_001',
      kind: 'knowledge',
      payload: { proposed_knowledge: { name: 'orch_node', parent_id: 'k_root' } },
      reasoning: 'orch reasoning',
      status: 'accepted',
      proposed_at: baseTime,
      decided_at: new Date(baseTime.getTime() + 7200000),
    });

    // 1 ingestion_session
    await db.insert(ingestion_session).values({
      id: 'is_orch_001',
      source_document_id: 'sd_orch',
      source_asset_ids: ['sa_orch'],
      status: 'imported',
      entrypoint: 'vision_single',
      warnings: [],
      created_at: baseTime,
      updated_at: new Date(baseTime.getTime() + 3600000),
      version: 1,
    });

    const { runMigration } = await import('./migrate-phase1c1');
    const result = await runMigration(db);
    expect(result.ok).toBe(true);

    // Expected row counts:
    //   event: 2 attempts + 1 judge + 1 review + 1 propose = 5
    //   material_fsrs_state: 1 (from review on m_orch_no_cause)
    //   learning_session: 1 (from ingestion_session)
    const events = await db.select().from(event);
    expect(events).toHaveLength(5);
    expect(events.filter((e) => e.action === 'attempt')).toHaveLength(2);
    expect(events.filter((e) => e.action === 'judge')).toHaveLength(1);
    expect(events.filter((e) => e.action === 'review')).toHaveLength(1);
    expect(events.filter((e) => e.action === 'propose')).toHaveLength(1);

    const fsrsStates = await db.select().from(material_fsrs_state);
    expect(fsrsStates).toHaveLength(1);

    const sessions = await db.select().from(learning_session);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].type).toBe('ingestion');
  });

  it('idempotent: running twice produces the same end-state row counts', async () => {
    const db = testDb();
    const baseTime = new Date('2026-06-02T00:00:00Z');

    await db.insert(mistake).values({
      id: 'm_idem',
      question_id: QUESTION_ID,
      wrong_answer_md: 'idem',
      source: 'manual',
      knowledge_ids: [],
      cause: {
        primary_category: 'method',
        secondary_categories: [],
        ai_analysis_md: 'idem analysis',
        user_edited: false,
        confidence: 0.6,
      },
      fsrs_state: null,
      created_at: baseTime,
      updated_at: baseTime,
    });
    await db.insert(ingestion_session).values({
      id: 'is_idem',
      source_document_id: null,
      source_asset_ids: [],
      status: 'imported',
      entrypoint: 'vision_paper',
      warnings: [],
      created_at: baseTime,
      updated_at: baseTime,
      version: 0,
    });

    const { runMigration } = await import('./migrate-phase1c1');

    const first = await runMigration(db);
    expect(first.ok).toBe(true);
    const evCount1 = (await db.select().from(event)).length;
    const lsCount1 = (await db.select().from(learning_session)).length;
    const mistakeCount1 = (await db.select().from(mistake)).length;
    expect(evCount1).toBe(2); // attempt + judge
    expect(lsCount1).toBe(1);
    expect(mistakeCount1).toBe(1);

    // Second run — onConflictDoNothing + deterministic IDs make this a no-op.
    const second = await runMigration(db);
    expect(second.ok).toBe(true);
    const evCount2 = (await db.select().from(event)).length;
    const lsCount2 = (await db.select().from(learning_session)).length;
    const mistakeCount2 = (await db.select().from(mistake)).length;
    expect(evCount2).toBe(evCount1);
    expect(lsCount2).toBe(lsCount1);
    // Legacy data still present (additive migration)
    expect(mistakeCount2).toBe(mistakeCount1);
  });

  it('aborts when judgment table is non-empty (precheck violation)', async () => {
    const db = testDb();
    const { sql } = await import('drizzle-orm');
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS "judgment" (id text PRIMARY KEY)`));
    try {
      await db.execute(sql.raw(`INSERT INTO "judgment" (id) VALUES ('j_abort_001')`));

      // Seed a mistake — if the orchestrator IGNORED the precheck, it would
      // write events; we assert events table stays empty.
      await db.insert(mistake).values({
        id: 'm_should_not_migrate',
        question_id: QUESTION_ID,
        wrong_answer_md: 'x',
        source: 'manual',
        knowledge_ids: [],
        cause: null,
        fsrs_state: null,
        created_at: new Date('2026-06-03T00:00:00Z'),
        updated_at: new Date('2026-06-03T00:00:00Z'),
      });

      const { runMigration } = await import('./migrate-phase1c1');
      const result = await runMigration(db);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error).toMatch(/judgment table/i);

      const events = await db.select().from(event);
      expect(events).toHaveLength(0); // migration refused to proceed
    } finally {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS "judgment"`));
    }
  });
});
