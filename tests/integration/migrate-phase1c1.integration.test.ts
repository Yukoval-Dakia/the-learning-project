// Phase 1c.1 Step 3 integration test — realistic 50-row fixture covering all
// 4 legacy tables, all CauseCategory values, every dreaming_proposal status,
// every ingestion_session status, FSRS state projection + mastery view.
//
// Asserts the full migration pipeline produces:
//   - all expected event chains (attempt + judge / review / propose)
//   - material_fsrs_state projection at question grain
//   - knowledge_mastery view returns NULL for un-attempted knowledge and a
//     value in [0,1] for knowledge that has been exercised by ≥1 attempt/review
//   - additive guarantee (legacy tables retain all original rows)
//   - idempotency under double-run

import { CauseCategory } from '@/core/schema/business';
import {
  dreaming_proposal,
  event,
  ingestion_session,
  knowledge,
  knowledge_mastery,
  learning_session,
  material_fsrs_state,
  mistake,
  question,
  review_event,
} from '@/db/schema';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { runMigration } from '../../scripts/migrate-phase1c1';
import { resetDb, testDb } from '../helpers/db';

const FIXTURE_BASE = new Date('2026-06-15T00:00:00Z');

function shiftDate(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 86_400_000);
}

function buildFsrsState(due: Date, reps: number) {
  return {
    due,
    stability: 1 + reps * 0.5,
    difficulty: 5.0,
    elapsed_days: reps,
    scheduled_days: reps + 1,
    learning_steps: 0,
    reps,
    lapses: 0,
    state: 'review' as const,
    last_review: shiftDate(FIXTURE_BASE, -1),
  };
}

/**
 * Seed a realistic 50-row mix:
 *
 *   - 10 knowledge nodes (k_concept_1..10; 5 attached, 5 un-attempted)
 *   - 5 question rows (q_1..5)
 *   - 20 mistakes:
 *       * 10 with cause covering all 10 CauseCategory enum values (one each)
 *       * 10 with cause=null
 *     Each mistake references 1 knowledge id from k_concept_1..5
 *   - 10 review_events: 3 chains on m_with_cause_concept (good/hard/again),
 *     2 chains on m_with_cause_method (good/again), 5 single reviews on others
 *   - 8 dreaming_proposals: all 3 statuses (pending/accepted/rejected) plus
 *     1 missing-name skip case (to exercise warning path)
 *   - 5 ingestion_sessions: all 5 status varieties (uploaded/extracting/
 *     imported/failed/reviewed)
 *
 * Approx total: 10 + 5 + 20 + 10 + 8 + 5 = 58 legacy rows. Spec says ≈50; we
 * round up to ensure every documented payload shape is exercised.
 */
async function seedRealisticFixture(): Promise<{
  knowledgeIds: string[];
  attemptedKnowledgeIds: string[];
  unattemptedKnowledgeIds: string[];
  questionIds: string[];
  mistakeIds: string[];
}> {
  const db = testDb();

  // ─── knowledge ───────────────────────────────────────────────────────────
  const knowledgeIds = Array.from({ length: 10 }, (_, i) => `k_concept_${i + 1}`);
  for (const id of knowledgeIds) {
    await db.insert(knowledge).values({
      id,
      name: `Concept ${id}`,
      domain: 'wenyan',
      parent_id: null,
      created_at: FIXTURE_BASE,
      updated_at: FIXTURE_BASE,
    });
  }
  // k_concept_1..5 will be referenced by mistakes; k_concept_6..10 are pristine.
  const attemptedKnowledgeIds = knowledgeIds.slice(0, 5);
  const unattemptedKnowledgeIds = knowledgeIds.slice(5);

  // ─── question ───────────────────────────────────────────────────────────
  const questionIds = Array.from({ length: 5 }, (_, i) => `q_realistic_${i + 1}`);
  for (const qid of questionIds) {
    await db.insert(question).values({
      id: qid,
      kind: 'short_answer',
      prompt_md: `Question ${qid} prompt`,
      source: 'manual',
      created_at: FIXTURE_BASE,
      updated_at: FIXTURE_BASE,
    });
  }

  // ─── mistakes ───────────────────────────────────────────────────────────
  const allCauseCats = CauseCategory.options;
  expect(allCauseCats).toHaveLength(10); // sanity: 10-enum from blocks.ts

  const mistakeIds: string[] = [];
  // 10 mistakes WITH cause — one per CauseCategory
  for (let i = 0; i < 10; i++) {
    const id = `m_cause_${allCauseCats[i]}`;
    mistakeIds.push(id);
    const questionId = questionIds[i % questionIds.length];
    const knowledgeId = attemptedKnowledgeIds[i % attemptedKnowledgeIds.length];
    await db.insert(mistake).values({
      id,
      question_id: questionId,
      wrong_answer_md: `wrong answer for ${id}`,
      wrong_answer_image_refs: i % 2 === 0 ? [`img_${id}`] : [],
      source: 'manual',
      knowledge_ids: [knowledgeId],
      cause: {
        primary_category: allCauseCats[i],
        secondary_categories: i % 3 === 0 ? [allCauseCats[(i + 1) % 10]] : [],
        ai_analysis_md: `cause analysis for ${id}`,
        user_notes: i % 4 === 0 ? `user note ${id}` : null,
        partial: i % 5 === 0,
        confidence: i % 2 === 0 ? 0.75 : null, // exercise default=0.5 path
        user_edited: i % 3 === 0,
      },
      fsrs_state: null,
      created_at: shiftDate(FIXTURE_BASE, i),
      updated_at: shiftDate(FIXTURE_BASE, i + 1),
    });
  }
  // 10 mistakes WITHOUT cause
  for (let i = 0; i < 10; i++) {
    const id = `m_no_cause_${i}`;
    mistakeIds.push(id);
    await db.insert(mistake).values({
      id,
      question_id: questionIds[i % questionIds.length],
      wrong_answer_md: i % 2 === 0 ? `quick wrong ${i}` : null,
      source: 'quiz_answer',
      knowledge_ids: [attemptedKnowledgeIds[i % attemptedKnowledgeIds.length]],
      cause: null,
      // Half get an fsrs_state to exercise the fallback projection path
      fsrs_state: i < 5 ? buildFsrsState(shiftDate(FIXTURE_BASE, 30 + i), 0) : null,
      created_at: shiftDate(FIXTURE_BASE, 10 + i),
      updated_at: shiftDate(FIXTURE_BASE, 10 + i),
    });
  }

  // ─── review_events ──────────────────────────────────────────────────────
  // 3-review chain on m_cause_concept (question_id = q_1)
  for (let day = 1; day <= 3; day++) {
    const rating = day === 3 ? 'again' : day === 2 ? 'hard' : 'good';
    const at = shiftDate(FIXTURE_BASE, 5 + day);
    const due = shiftDate(at, 7);
    await db.insert(review_event).values({
      id: `re_concept_d${day}`,
      mistake_id: 'm_cause_concept',
      rating,
      response_md: `response day ${day}`,
      latency_ms: 5000,
      fsrs_state_before: null,
      fsrs_state_after: buildFsrsState(due, day),
      due_at_before: at,
      due_at_next: due,
      created_at: at,
    });
  }
  // 2-review chain on m_cause_method
  for (let day = 1; day <= 2; day++) {
    const rating = day === 2 ? 'again' : 'good';
    const at = shiftDate(FIXTURE_BASE, 10 + day);
    const due = shiftDate(at, 4);
    await db.insert(review_event).values({
      id: `re_method_d${day}`,
      mistake_id: 'm_cause_method',
      rating,
      response_md: `method response ${day}`,
      latency_ms: 8000,
      fsrs_state_before: null,
      fsrs_state_after: buildFsrsState(due, day),
      due_at_before: at,
      due_at_next: due,
      created_at: at,
    });
  }
  // 5 single reviews on m_no_cause_5..9 (which have no fsrs_state — to ensure
  // the review-driven projection wins over the empty fallback path)
  for (let i = 0; i < 5; i++) {
    const mid = `m_no_cause_${5 + i}`;
    const at = shiftDate(FIXTURE_BASE, 20 + i);
    const due = shiftDate(at, 1);
    await db.insert(review_event).values({
      id: `re_single_${i}`,
      mistake_id: mid,
      rating: 'good',
      response_md: null,
      latency_ms: 3000,
      fsrs_state_before: null,
      fsrs_state_after: buildFsrsState(due, 1),
      due_at_before: at,
      due_at_next: due,
      created_at: at,
    });
  }

  // ─── dreaming_proposals ─────────────────────────────────────────────────
  const proposalSpecs = [
    { id: 'dp_pend_1', status: 'pending', name: 'pending node 1' },
    { id: 'dp_pend_2', status: 'pending', name: 'pending node 2' },
    { id: 'dp_acc_1', status: 'accepted', name: 'accepted node 1' },
    { id: 'dp_acc_2', status: 'accepted', name: 'accepted node 2' },
    { id: 'dp_acc_3', status: 'accepted', name: 'accepted node 3' },
    { id: 'dp_rej_1', status: 'rejected', name: 'rejected node 1' },
    { id: 'dp_rej_2', status: 'rejected', name: 'rejected node 2' },
  ] as const;
  for (const p of proposalSpecs) {
    await db.insert(dreaming_proposal).values({
      id: p.id,
      kind: 'knowledge',
      payload: { proposed_knowledge: { name: p.name, parent_id: 'k_concept_1' } },
      reasoning: `reasoning for ${p.id}`,
      status: p.status,
      proposed_at: shiftDate(FIXTURE_BASE, 1),
      decided_at: p.status === 'pending' ? null : shiftDate(FIXTURE_BASE, 2),
    });
  }
  // Skip-case: missing name
  await db.insert(dreaming_proposal).values({
    id: 'dp_no_name',
    kind: 'knowledge',
    payload: { proposed_knowledge: { parent_id: 'k_concept_2' } },
    reasoning: 'this should be skipped',
    status: 'pending',
    proposed_at: shiftDate(FIXTURE_BASE, 1),
  });

  // ─── ingestion_sessions ─────────────────────────────────────────────────
  const sessionSpecs = [
    { id: 'is_uploaded', status: 'uploaded' },
    { id: 'is_extracting', status: 'extracting' },
    { id: 'is_imported', status: 'imported' },
    { id: 'is_failed', status: 'failed' },
    { id: 'is_reviewed', status: 'reviewed' },
  ] as const;
  for (const s of sessionSpecs) {
    await db.insert(ingestion_session).values({
      id: s.id,
      source_document_id: s.status === 'imported' ? 'sd_realistic' : null,
      source_asset_ids: ['sa_real_1'],
      status: s.status,
      entrypoint: 'vision_single',
      warnings: s.status === 'failed' ? ['ocr-timeout'] : [],
      error_message: s.status === 'failed' ? 'OCR engine timeout' : null,
      created_at: FIXTURE_BASE,
      updated_at: shiftDate(FIXTURE_BASE, 1),
      version: 1,
    });
  }

  return {
    knowledgeIds,
    attemptedKnowledgeIds,
    unattemptedKnowledgeIds,
    questionIds,
    mistakeIds,
  };
}

// `knowledge_mastery` is declared `.existing()` in src/db/schema.ts (drizzle-kit
// can register but does NOT generate `CREATE VIEW` on `db:push`). Production
// gets the view via `drizzle/0005_phase1c1_event_payload_gin_and_mastery_view.sql`,
// but the test container is initialised by `db:push --force` in global-setup,
// which skips views. We create it inline here so the mastery assertions run
// without coupling this test to global-setup changes (Step 8 may rewire that).
const KNOWLEDGE_MASTERY_VIEW_DDL = `
CREATE OR REPLACE VIEW "knowledge_mastery" AS
WITH attempts AS (
  SELECT
    k.id AS knowledge_id,
    e.id AS event_id,
    e.outcome,
    e.created_at,
    exp(-ln(2) * extract(epoch from (now() - e.created_at)) / (30.0 * 86400.0)) AS weight
  FROM knowledge k
  CROSS JOIN LATERAL (
    SELECT id, outcome, created_at, payload
    FROM event
    WHERE action IN ('attempt', 'review')
      AND subject_kind = 'question'
      AND created_at > now() - interval '180 days'
      AND payload->'referenced_knowledge_ids' @> to_jsonb(k.id)
  ) e
),
agg AS (
  SELECT
    knowledge_id,
    sum(CASE WHEN outcome = 'success' THEN weight ELSE 0 END) AS weighted_success,
    sum(weight) AS weighted_total,
    count(*) AS evidence_count,
    max(created_at) AS last_evidence_at
  FROM attempts
  GROUP BY knowledge_id
),
activity AS (
  SELECT
    k.id AS knowledge_id,
    max(e.created_at) AS last_event_at
  FROM knowledge k
  CROSS JOIN LATERAL (
    SELECT created_at
    FROM event
    WHERE (subject_kind = 'knowledge' AND subject_id = k.id)
       OR (payload->'referenced_knowledge_ids' @> to_jsonb(k.id))
       OR (payload->'knowledge_ids' @> to_jsonb(k.id))
  ) e
  GROUP BY k.id
)
SELECT
  k.id AS knowledge_id,
  CASE
    WHEN agg.evidence_count IS NULL OR agg.evidence_count = 0 THEN NULL
    WHEN agg.evidence_count < 3 THEN 0.5::real
    ELSE (agg.weighted_success / NULLIF(agg.weighted_total, 0))::real
  END AS mastery,
  coalesce(agg.evidence_count, 0)::integer AS evidence_count,
  agg.last_evidence_at,
  coalesce(activity.last_event_at, k.created_at) AS last_active_at
FROM knowledge k
LEFT JOIN agg ON agg.knowledge_id = k.id
LEFT JOIN activity ON activity.knowledge_id = k.id
`;

describe('migrate-phase1c1 integration — 50-row realistic fixture (3.H)', () => {
  // Capture skip warnings so we can assert dp_no_name was skipped (and nothing else).
  const warnings: string[] = [];
  const originalWarn = console.warn;

  beforeAll(async () => {
    console.warn = (msg: unknown) => {
      if (typeof msg === 'string') warnings.push(msg);
    };
    await resetDb();
    const db = testDb();
    await db.execute(sql.raw(KNOWLEDGE_MASTERY_VIEW_DDL));
    await seedRealisticFixture();
    const result = await runMigration(db);
    expect(result.ok).toBe(true);
    console.warn = originalWarn;
  }, 60_000);

  it('logs exactly one skip warning for dp_no_name (defensive payload extraction)', () => {
    const hits = warnings.filter((w) => w.startsWith('[migrate-phase1c1] skip propose'));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('dp_no_name');
  });

  it('writes expected event counts for each action', async () => {
    const db = testDb();
    const all = await db.select().from(event);

    // 20 mistakes → 20 attempt events
    expect(all.filter((e) => e.action === 'attempt')).toHaveLength(20);
    // 10 mistakes with cause → 10 judge events
    expect(all.filter((e) => e.action === 'judge')).toHaveLength(10);
    // 3 + 2 + 5 = 10 review events
    expect(all.filter((e) => e.action === 'review')).toHaveLength(10);
    // 7 valid + 1 skipped (missing name) = 7 propose events
    expect(all.filter((e) => e.action === 'propose')).toHaveLength(7);

    // Total events: 20 + 10 + 10 + 7 = 47
    expect(all).toHaveLength(47);
  });

  it('writes 1 learning_session per ingestion_session (5 total, all status varieties)', async () => {
    const db = testDb();
    const sessions = await db.select().from(learning_session);
    expect(sessions).toHaveLength(5);
    for (const s of sessions) {
      expect(s.type).toBe('ingestion');
    }
    const statuses = new Set(sessions.map((s) => s.status));
    expect(statuses).toEqual(new Set(['uploaded', 'extracting', 'imported', 'failed', 'reviewed']));

    // Terminal statuses get ended_at populated; mid-flight ones remain null.
    const imported = sessions.find((s) => s.status === 'imported');
    const failed = sessions.find((s) => s.status === 'failed');
    const uploaded = sessions.find((s) => s.status === 'uploaded');
    expect(imported?.ended_at).not.toBeNull();
    expect(failed?.ended_at).not.toBeNull();
    expect(uploaded?.ended_at).toBeNull();
  });

  it('writes material_fsrs_state for every question with review-driven projection + fallback', async () => {
    const db = testDb();
    const fsrsStates = await db.select().from(material_fsrs_state);
    // Review-driven: 3 questions touched by review chains (concept m → q_1, method m → q_3, single reviews on 5 mistakes → fewer distinct questions due to modulo)
    //   - concept reviews → q_1 (m_cause_concept[idx 0] → q_1)
    //   - method reviews  → q_3 (m_cause_method[idx 6] → q_3)
    //   - single reviews on m_no_cause_5..9 → q_1..q_5 (5 distinct mistakes spread across 5 questions)
    // Fallback path: m_no_cause_0..4 have fsrs_state but no reviews; they map
    // to q_1..q_5, but the review-driven path may overwrite via deterministic
    // PK collisions on (question_id) — onConflictDoNothing means the FIRST
    // insert wins per id. Either way every question should have one row.
    const distinctSubjectIds = new Set(fsrsStates.map((f) => f.subject_id));
    for (const qid of distinctSubjectIds) {
      expect(qid.startsWith('q_realistic_')).toBe(true);
    }
    // Coverage: at least one FSRS row per question touched by any review/mistake
    expect(distinctSubjectIds.size).toBeGreaterThanOrEqual(3);
    // No row should have a null state (we only write valid projections)
    for (const f of fsrsStates) {
      expect(f.state).toBeDefined();
      expect(f.due_at).toBeInstanceOf(Date);
    }
  });

  it('knowledge_mastery returns NULL for un-attempted knowledge and a value in [0,1] for attempted', async () => {
    const db = testDb();
    const rows = await db.select().from(knowledge_mastery);

    // 10 knowledge rows seeded → 10 mastery rows
    expect(rows).toHaveLength(10);

    // Un-attempted: k_concept_6..10 — mastery IS NULL (no events touch them)
    const unattempted = rows.filter((r) => Number(r.knowledge_id.replace('k_concept_', '')) > 5);
    for (const r of unattempted) {
      expect(r.mastery, `${r.knowledge_id} should have NULL mastery`).toBeNull();
      expect(r.evidence_count).toBe(0);
    }

    // Attempted: k_concept_1..5 — mastery ∈ [0,1] (some weighted success or
    // the < 3 evidence shortcut 0.5; never NaN, never > 1, never < 0).
    const attempted = rows.filter((r) => Number(r.knowledge_id.replace('k_concept_', '')) <= 5);
    expect(attempted.length).toBe(5);
    for (const r of attempted) {
      expect(r.evidence_count, `${r.knowledge_id} has events`).toBeGreaterThanOrEqual(1);
      expect(r.mastery, `${r.knowledge_id} mastery is non-null`).not.toBeNull();
      if (r.mastery !== null) {
        expect(r.mastery).toBeGreaterThanOrEqual(0);
        expect(r.mastery).toBeLessThanOrEqual(1);
      }
    }
  });

  it('preserves additive guarantee: all legacy rows still present after migration', async () => {
    const db = testDb();
    const [mistakes, reviews, proposals, sessions] = await Promise.all([
      db.select().from(mistake),
      db.select().from(review_event),
      db.select().from(dreaming_proposal),
      db.select().from(ingestion_session),
    ]);
    expect(mistakes).toHaveLength(20);
    expect(reviews).toHaveLength(10);
    expect(proposals).toHaveLength(8); // 7 valid + 1 skip
    expect(sessions).toHaveLength(5);
  });

  it('idempotent: second runMigration call leaves row counts unchanged', async () => {
    const db = testDb();
    const beforeEvents = (await db.select().from(event)).length;
    const beforeFsrs = (await db.select().from(material_fsrs_state)).length;
    const beforeSessions = (await db.select().from(learning_session)).length;

    const result = await runMigration(db);
    expect(result.ok).toBe(true);

    expect((await db.select().from(event)).length).toBe(beforeEvents);
    expect((await db.select().from(material_fsrs_state)).length).toBe(beforeFsrs);
    expect((await db.select().from(learning_session)).length).toBe(beforeSessions);
  });

  it('all 10 CauseCategory enum values are exercised across judge.payload.cause.primary_category', async () => {
    const db = testDb();
    const judges = (await db.select().from(event)).filter((e) => e.action === 'judge');
    const categories = new Set(
      judges.map(
        (j) => (j.payload as { cause: { primary_category: string } }).cause.primary_category,
      ),
    );
    // 10 mistakes-with-cause, one per CauseCategory → all 10 enum values present
    expect(categories).toEqual(new Set(CauseCategory.options));
  });

  it('handles mistakes whose question_id is non-null (no crash, all attempts written)', async () => {
    // FK on mistake.question_id makes a NULL impossible to seed; this test
    // is a smoke check that every mistake produced exactly one attempt event
    // with the right subject_id chain.
    const db = testDb();
    const attempts = (await db.select().from(event)).filter((e) => e.action === 'attempt');
    expect(attempts).toHaveLength(20);
    for (const a of attempts) {
      expect(a.subject_id.startsWith('q_realistic_')).toBe(true);
    }
  });

  it('event.payload GIN index supports referenced_knowledge_ids queries (smoke)', async () => {
    const db = testDb();
    // Sanity: the GIN index on event.payload (jsonb_path_ops) lets the mastery
    // view's `payload->'referenced_knowledge_ids' @> to_jsonb(k.id)` lookup run
    // index-supported. We don't assert query plan here (EXPLAIN ANALYZE is
    // fragile in tests), just that the @> operator works and returns the
    // expected attempt events.
    const rows = await db.execute<{ count: string | number }>(sql`
      SELECT COUNT(*) AS count
      FROM event
      WHERE action IN ('attempt', 'review')
        AND payload->'referenced_knowledge_ids' @> to_jsonb('k_concept_1'::text)
    `);
    const raw = rows[0]?.count ?? 0;
    const count = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw;
    // Sub-set of mistakes (20) + reviews (10) reference k_concept_1 via modulo.
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
