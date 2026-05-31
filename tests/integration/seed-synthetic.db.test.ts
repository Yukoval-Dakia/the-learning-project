// Station 1 — synthetic seed DB integration test (YUK-184).
//
// Spec: docs/superpowers/specs/2026-06-01-station1-synthetic-seed-design.md §Test plan.
//
// Runs the seed pipeline against the testcontainer DB and asserts the five
// non-brief Layer-8 slices light up, then runs --reset and asserts the synthetic
// rows are gone while a pre-seeded sentinel non-synthetic row survives.
//
// `*.db.test.ts` under tests/** lands in the db partition (allTestInclude minus
// fastTestInclude); it imports the testDb helper, so it must NOT be a unit test.

import { event, knowledge, material_fsrs_state, proposal_signals, question } from '@/db/schema';
import { PROPOSAL_FEEDBACK_BUDGET, PROPOSAL_GATE_BIAS_CONFIG } from '@/server/ai/tools/budgets';
import { listActiveSubjectsSinceRefresh } from '@/server/memory/active-subjects';
import { resolveEdgeGateBump } from '@/server/proposals/adaptive-bias';
import { getProposalAcceptanceRates } from '@/server/proposals/signals';
import { eq, like, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  L2_DISMISS_RELATION,
  printReport,
  runReset,
  runSeed,
  runStubbedNightly,
} from '../../scripts/seed-synthetic';
import { resetDb, testDb } from '../helpers/db';

// A non-synthetic sentinel row: must SURVIVE --reset (hard gate). We use a
// knowledge node + an attempt event that carry NO synthetic markers.
const SENTINEL_KNOWLEDGE_ID = 'k-real-sentinel';
const SENTINEL_QUESTION_ID = 'q-real-sentinel';
const SENTINEL_EVENT_ID = 'evt-real-sentinel';

async function seedSentinel(db: ReturnType<typeof testDb>, now: Date): Promise<void> {
  await db.insert(knowledge).values({
    id: SENTINEL_KNOWLEDGE_ID,
    name: '真实哨兵节点',
    domain: 'wenyan',
    parent_id: null,
    approval_status: 'approved',
    proposed_by_ai: false,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await db.insert(question).values({
    id: SENTINEL_QUESTION_ID,
    kind: 'single_choice',
    prompt_md: '真实题目',
    reference_md: '答案',
    knowledge_ids: [SENTINEL_KNOWLEDGE_ID],
    difficulty: 2,
    source: 'manual',
    variant_depth: 0,
    figures: [],
    image_refs: [],
    structured: null,
    metadata: { real: true },
    created_at: now,
    updated_at: now,
    version: 0,
  });
  // A real attempt event with NO payload.__synthetic marker.
  await db.insert(event).values({
    id: SENTINEL_EVENT_ID,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: SENTINEL_QUESTION_ID,
    outcome: 'failure',
    payload: {
      answer_md: 'real wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: [SENTINEL_KNOWLEDGE_ID],
    },
    created_at: now,
  });
  // A real proposal_signals row whose cooldown_key is NOT synthetic-prefixed.
  await db.insert(proposal_signals).values({
    id: 'ps-real-sentinel',
    kind: 'knowledge_edge',
    cooldown_key: 'knowledge_edge:k-real-sentinel|k-real-other|related_to',
    accept_count: 1,
    dismiss_count: 0,
    acceptance_rate: 1,
    created_at: now,
    updated_at: now,
  });
}

describe('seed-synthetic (DB integration)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('lights up the five Layer-8 slices, then --reset removes only synthetic rows', async () => {
    const db = testDb();
    const now = new Date();

    await seedSentinel(db, now);
    await runSeed(db, now);
    await runStubbedNightly(db);

    const report = await printReport(db, now);

    // Win 1 — FSRS due list non-empty (overdue slice > 0).
    expect(report.fsrs_due_overdue).toBeGreaterThan(0);

    // Win 2 — proposal_signals rows with total > 0 + an acceptance_rate.
    const rates = await getProposalAcceptanceRates(db);
    expect(rates.length).toBeGreaterThan(0);
    expect(rates.every((r) => r.total > 0)).toBe(true);
    expect(rates.every((r) => typeof r.acceptance_rate === 'number')).toBe(true);

    // Win 3 — ≥1 PASS edge propose AND ≥1 rubric-rejected propose event.
    expect(report.edge_propose_pass).toBeGreaterThanOrEqual(1);
    expect(report.edge_propose_rubric_rejected).toBeGreaterThanOrEqual(1);

    // The PASS propose came from the stubbed nightly (prerequisite, no
    // rubric_verdict). Confirm directly.
    const passRows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM "event"
      WHERE action = 'propose' AND subject_kind = 'knowledge_edge'
        AND (payload->>'relation_type') = 'prerequisite'
        AND (payload->'rubric_verdict') IS NULL
        AND (payload->>'from_knowledge_id') LIKE 'synthetic:%'
    `)) as unknown as Array<{ n: number }>;
    expect(passRows[0]?.n ?? 0).toBeGreaterThanOrEqual(1);

    // Win 4 — resolveEdgeGateBump returns tightenMediumToStrong on the sized
    // dismiss relation.
    const bump = await resolveEdgeGateBump(
      db,
      L2_DISMISS_RELATION,
      PROPOSAL_FEEDBACK_BUDGET,
      PROPOSAL_GATE_BIAS_CONFIG,
    );
    expect(bump.tightenMediumToStrong).toBe(true);
    expect(report.l2_tighten_medium_to_strong).toBe(true);

    // Win 5 — listActiveSubjectsSinceRefresh finds the synthetic subject (wenyan).
    const active = await listActiveSubjectsSinceRefresh(db, { now });
    expect(active.some((a) => a.subjectId === 'wenyan')).toBe(true);
    expect(report.active_subjects_detected).toBeGreaterThan(0);

    // ── --reset: synthetic rows gone; sentinel survives ──
    const counts = await runReset(db);
    expect(counts.event).toBeGreaterThan(0);
    expect(counts.knowledge).toBeGreaterThan(0);
    expect(counts.question).toBeGreaterThan(0);
    expect(counts.material_fsrs_state).toBeGreaterThan(0);
    expect(counts.proposal_signals).toBeGreaterThan(0);

    // No synthetic rows remain.
    const synthKnowledge = await db
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(like(knowledge.id, 'synthetic:%'));
    expect(synthKnowledge.length).toBe(0);
    const synthQuestion = await db.execute(
      sql`SELECT count(*)::int AS n FROM "question" WHERE (metadata->>'synthetic') = 'true'`,
    );
    expect((synthQuestion as unknown as Array<{ n: number }>)[0]?.n ?? 0).toBe(0);
    const synthEvents = await db.execute(
      sql`SELECT count(*)::int AS n FROM "event" WHERE (payload->>'__synthetic') = 'true'`,
    );
    expect((synthEvents as unknown as Array<{ n: number }>)[0]?.n ?? 0).toBe(0);
    // The stubbed-nightly PASS propose is NOT __synthetic-markered (built by the
    // real writeAiProposal path); --reset must still purge it by synthetic
    // endpoint (PR review, major). Assert zero synthetic-edge propose events.
    const synthPropose = await db.execute(
      sql`SELECT count(*)::int AS n FROM "event"
          WHERE action = 'propose' AND subject_kind = 'knowledge_edge'
            AND ( (payload->>'from_knowledge_id') LIKE 'synthetic:%'
                  OR (payload->>'to_knowledge_id') LIKE 'synthetic:%' )`,
    );
    expect((synthPropose as unknown as Array<{ n: number }>)[0]?.n ?? 0).toBe(0);
    const synthFsrs = await db
      .select({ id: material_fsrs_state.subject_id })
      .from(material_fsrs_state)
      .where(like(material_fsrs_state.subject_id, 'synthetic:q:%'));
    expect(synthFsrs.length).toBe(0);
    const synthSignals = await db
      .select({ id: proposal_signals.id })
      .from(proposal_signals)
      .where(like(proposal_signals.cooldown_key, 'knowledge_edge:synthetic:%'));
    expect(synthSignals.length).toBe(0);

    // Sentinel non-synthetic rows SURVIVE (hard gate).
    const sentinelK = await db
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(eq(knowledge.id, SENTINEL_KNOWLEDGE_ID));
    expect(sentinelK.length).toBe(1);
    const sentinelE = await db
      .select({ id: event.id })
      .from(event)
      .where(eq(event.id, SENTINEL_EVENT_ID));
    expect(sentinelE.length).toBe(1);
    const sentinelQ = await db
      .select({ id: question.id })
      .from(question)
      .where(eq(question.id, SENTINEL_QUESTION_ID));
    expect(sentinelQ.length).toBe(1);
    const sentinelPs = await db
      .select({ id: proposal_signals.id })
      .from(proposal_signals)
      .where(eq(proposal_signals.id, 'ps-real-sentinel'));
    expect(sentinelPs.length).toBe(1);
  });

  it('is idempotent — seeding twice produces the same synthetic row counts', async () => {
    const db = testDb();
    const now = new Date();

    await runSeed(db, now);
    const after1 = await synthCounts(db);

    await runSeed(db, now);
    const after2 = await synthCounts(db);

    expect(after2).toEqual(after1);
  });
});

async function synthCounts(db: ReturnType<typeof testDb>): Promise<{
  knowledge: number;
  question: number;
  event: number;
  fsrs: number;
}> {
  const k = (await db.execute(
    sql`SELECT count(*)::int AS n FROM "knowledge" WHERE id LIKE 'synthetic:%'`,
  )) as unknown as Array<{ n: number }>;
  const q = (await db.execute(
    sql`SELECT count(*)::int AS n FROM "question" WHERE (metadata->>'synthetic') = 'true'`,
  )) as unknown as Array<{ n: number }>;
  const e = (await db.execute(
    sql`SELECT count(*)::int AS n FROM "event" WHERE (payload->>'__synthetic') = 'true'`,
  )) as unknown as Array<{ n: number }>;
  const f = (await db.execute(
    sql`SELECT count(*)::int AS n FROM "material_fsrs_state" WHERE subject_id LIKE 'synthetic:q:%'`,
  )) as unknown as Array<{ n: number }>;
  return {
    knowledge: k[0]?.n ?? 0,
    question: q[0]?.n ?? 0,
    event: e[0]?.n ?? 0,
    fsrs: f[0]?.n ?? 0,
  };
}
