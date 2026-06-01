// Station 3 — Layer-8 flywheel end-to-end validation (YUK-188).
//
// Spec: docs/superpowers/specs/2026-06-01-station3-e2e-validation-plan.md.
//
// Stations 1 / 2A / 2B each wired ONE seam of the Layer-8 flywheel and tested it
// in isolation. Station 3 is the FIRST time the whole flywheel runs together on
// one shared synthetic dataset: brief regen (global + subject) → goal cron →
// accept → dreaming → coach → edge-propose, all reading each other's writes
// through the production read seams.
//
// ONE DB test. All LLM calls STUBBED (zero token) via deps-injected runTaskFn /
// runAgentTaskFn. The goal seam drives the FULL live chain (real acceptAiProposal
// → real listActiveGoals → Coach / Dreaming / Review default readers), so we
// prove the real join, not a re-stubbed fixture.
//
// Risk honouring (plan §Integration-risk list):
//  - Risk 1: the goal stub cites REAL seeded synthetic:wenyan:* node ids
//    (NODES.xuci / NODES.jushi) so scope_knowledge_ids survive scope.ts:92 and
//    every downstream consumer is non-empty.
//  - Risk 2: each of the 5 stubbed LLM outputs reuses the exact canned helper
//    shape from the proven per-layer tests (no hand-drifted JSON).
//  - Risk 5: Slice H (active-subject detection) is asserted BEFORE the
//    subject:wenyan brief regen raises wenyan's refreshed_at floor (ordering is
//    load-bearing).
//  - Risk 6: the goal scope intersects SOME (xuci/jushi) but not ALL overdue
//    nodes (shici/changshi), so rerankOverdueByGoals has both a relevant and a
//    non-relevant overdue item and does not early-return.
//
// `*.db.test.ts` under tests/** lands in the db partition (allTestInclude minus
// fastTestInclude); it imports the testDb helper, so it must NOT be a unit test.

import { material_fsrs_state } from '@/db/schema';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { PROPOSAL_FEEDBACK_BUDGET, PROPOSAL_GATE_BIAS_CONFIG } from '@/server/ai/tools/budgets';
import { executeMemoryBrief } from '@/server/ai/tools/context-readers';
import type { ToolContext } from '@/server/ai/tools/types';
import { runCoach } from '@/server/boss/handlers/coach_daily';
import { runDreamingNightly } from '@/server/boss/handlers/dreaming_nightly';
import { runGoalScopeProposeNightly } from '@/server/boss/handlers/goal_scope_propose_nightly';
import type { ActiveGoal } from '@/server/goals/queries';
import { listActiveGoals } from '@/server/goals/queries';
import { listActiveSubjectsSinceRefresh } from '@/server/memory/active-subjects';
import { regenerateMemoryBrief } from '@/server/memory/brief';
import { buildBriefGenerator } from '@/server/memory/brief-writer';
import { acceptAiProposal } from '@/server/proposals/actions';
import { resolveEdgeGateBump } from '@/server/proposals/adaptive-bias';
import { getProposalAcceptanceRates } from '@/server/proposals/signals';
import { handleReviewDue } from '@/server/review/due-list';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  L2_DISMISS_RELATION,
  NODES,
  runSeed,
  runStubbedNightly,
} from '../../scripts/seed-synthetic';
import { resetDb, testDb } from '../helpers/db';

// Single shared clock threaded into every `now: () => NOW` so freshness /
// due-windows / 24h cluster windows all agree (plan §Execution order).
const NOW = new Date('2026-06-01T03:00:00.000Z');

// ── Brief stub (Slice A / A') — reuse cannedDraft + makeStub shape verbatim from
// brief-writer.db.test.ts:45-66. Cites two seeded event ids that fall inside the
// loaded window so the D3 filter keeps them and the P5.3 freshness scorer
// resolves them (knownCount>0 → non-null). Risk 8: asserts the writer threaded
// the 3A `now` ISO field into the input. ──
function cannedDraft(longTermIds: string[]): string {
  return JSON.stringify({
    recent_week_md: '## Recent week\n- attempted a few questions',
    recent_months_md: '## Recent months\n- working through the basics',
    long_term_md: '## Long term\n- recurring weak spot on 虚词 / 句式',
    recent_week_evidence_ids: longTermIds.slice(0, 1),
    recent_months_evidence_ids: [],
    long_term_evidence_ids: longTermIds,
  });
}

function briefStub(longTermIds: string[]): TaskTextRunFn {
  return vi.fn(async (kind, input) => {
    if (kind !== 'MemoryBriefTask') {
      throw new Error(`no-live-LLM guard: unexpected task kind ${kind}`);
    }
    // Risk 8 — the writer stamps its own bucket-anchor ISO `now` into the input.
    expect(typeof (input as { now?: unknown }).now).toBe('string');
    return { text: cannedDraft(longTermIds), cost_usd: 0 };
  });
}

// ── Goal stub (Slice B / D / E) — reuse the fakeRunTask shape from
// scope.test.ts:75-81. Risk 1 + Risk 6: cite REAL seeded synthetic:wenyan node
// ids that intersect SOME (not all) overdue questions. The seed's overdue subset
// (questions.slice(0,4)) references shici / xuci / jushi / changshi; scoping to
// [xuci, jushi] makes the xuci+jushi overdue items goal-relevant and the
// shici+changshi overdue items NOT — both groups non-empty so the review rerank
// runs (does not early-return at due-list.ts:431). ──
const GOAL_SCOPE_IDS = [NODES.xuci, NODES.jushi];
function goalStub(): TaskTextRunFn {
  return vi.fn(async (kind) => {
    if (kind !== 'GoalScopeTask') {
      throw new Error(`no-live-LLM guard: unexpected task kind ${kind}`);
    }
    return {
      text: JSON.stringify({
        scope_knowledge_ids: GOAL_SCOPE_IDS,
        sequence_hint: 1,
        reasoning: '夜间巩固薄弱区：虚词与句式概念边界',
      }),
    };
  });
}

function toolCtx(): ToolContext {
  return { db: testDb(), taskRunId: 'e2e', callerActor: { kind: 'system', ref: 'test' } };
}

describe('Layer-8 flywheel end-to-end (DB, all LLM stubbed)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('runs the whole flywheel on one synthetic dataset; slices A-H all light up', async () => {
    const db = testDb();

    // 2. Seed: synthetic:wenyan:* nodes + questions + attempts/reviews/signals.
    await runSeed(db, NOW);

    // ── Slice H (active-subject detection) — asserted BEFORE step 4's
    // subject:wenyan brief regen (Risk 5, ordering load-bearing). The seeded
    // attempts are <= NOW; once a subject:wenyan brief raises wenyan's floor to
    // NOW, newest-event-strictly-after-floor would flip false. With no subject
    // brief yet, wenyan floors at NOW-30d so it is detected active. ──
    const activeSubs = await listActiveSubjectsSinceRefresh(db, { now: NOW });
    expect(activeSubs.some((a) => a.subjectId === 'wenyan')).toBe(true);

    // 3. Brief regen — GLOBAL scope. Cite two seeded cluster attempt events that
    //    fall in the 24h window so they survive the D3 filter + resolve freshness.
    const e1 = 'synthetic_evt_cluster_att_0';
    const e2 = 'synthetic_evt_cluster_att_1';
    const briefStubGlobal = briefStub([e1, e2]);
    await regenerateMemoryBrief({
      db: testDb(),
      scopeKey: 'global',
      searchFacts: async () => [],
      generate: buildBriefGenerator({ db: testDb(), runTaskFn: briefStubGlobal }),
      now: () => NOW,
    });

    // ── Slice A — Brief write→read round-trip + P5.3 freshness (global). ──
    const out = await executeMemoryBrief(toolCtx(), { scopeKey: 'global', includeEvidence: true });
    expect(out.note).not.toBeNull();
    expect(out.note?.recent_week_md).toContain('Recent week');
    expect(out.note?.long_term_md).toContain('recurring weak spot');
    expect(out.note?.long_term_freshness_score).not.toBeNull(); // P5.3 non-null (knownCount>0)
    expect(out.evidence?.long_term_ids.length ?? 0).toBeGreaterThan(0);

    // 4. Brief regen — SUBJECT scope 'subject:wenyan'. SAME literal scope key on
    //    write + read (Risk 4). NOTE: this raises wenyan's refreshed_at floor —
    //    Slice H is already asserted above.
    const briefStubSubject = briefStub([e1, e2]);
    await regenerateMemoryBrief({
      db: testDb(),
      scopeKey: 'subject:wenyan',
      searchFacts: async () => [],
      generate: buildBriefGenerator({ db: testDb(), runTaskFn: briefStubSubject }),
      now: () => NOW,
    });

    // ── Slice A' — subject-scope brief is independently readable + distinct
    // row from global (different scope_key). ──
    const subjOut = await executeMemoryBrief(toolCtx(), { scopeKey: 'subject:wenyan' });
    expect(subjOut.note).not.toBeNull();
    expect(subjOut.note?.scope_key).toBe('subject:wenyan');
    expect(subjOut.note?.subject_id).toBe('wenyan');
    expect(subjOut.note?.scope_key).not.toBe(out.note?.scope_key);

    // 5. Goal cron — real selector picks the most-weak KNOWN domain (wenyan), the
    //    goal stub cites real seeded ids (Risk 1).
    const goalRunStub = goalStub();
    const goalRes = await runGoalScopeProposeNightly(db, { runTaskFn: goalRunStub });

    // ── Slice B — goal materialized → listActiveGoals join. ──
    expect(goalRes.considered).toBe(1);
    expect(goalRes.proposed).toBe(1);
    expect(goalRes.proposal_id).toBeTruthy();
    if (!goalRes.proposal_id) throw new Error('expected goal proposal id');

    // 6. Accept — full live chain (real acceptAiProposal, no stub).
    const accepted = await acceptAiProposal(db, goalRes.proposal_id);
    expect(accepted.kind).toBe('goal_scope');
    const goalId = (accepted as { goal_id: string }).goal_id;

    const active = await listActiveGoals(db);
    const g = active.find((a) => a.id === goalId);
    expect(g).toBeTruthy();
    if (!g) throw new Error('expected materialized goal');
    expect(g.subject_id).toBe('wenyan'); // picked domain == subject_id
    expect(g.scope_knowledge_ids.length).toBeGreaterThan(0); // real synthetic ids survived
    expect(g.scope_knowledge_ids).toEqual(GOAL_SCOPE_IDS);

    // 7. Dreaming — inject runAgentTaskFn that CAPTURES the input (input-echo
    //    proof, Slice D) and returns a minimal valid agent-task result. Do NOT
    //    inject listActiveGoalsFn — the real default reader feeds the goal (the
    //    whole point of Station 3). buildMcpServerFn stubbed so no live MCP boot.
    const dreamingStub = vi.fn(async (_kind: string, _input: unknown, _ctx: unknown) => ({
      task_run_id: 'd1',
      text: '{}',
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 1 },
      cost_usd: 0,
    }));
    await runDreamingNightly(db, {
      runAgentTaskFn: dreamingStub,
      buildMcpServerFn: () => ({ name: 'fake-loom' }) as never,
      now: () => NOW,
    });

    // ── Slice D — Dreaming receives the goal scope (input echo). The tagged-
    // proposal half is out of scope (needs a live MCP bridge, plan §Slice D). ──
    const dreamingInput = dreamingStub.mock.calls[0]?.[1] as unknown as {
      active_goals: Array<{ id: string; scope_knowledge_ids: string[] }>;
    };
    expect(dreamingInput.active_goals.map((x) => x.id)).toContain(goalId);
    const dreamGoal = dreamingInput.active_goals.find((x) => x.id === goalId);
    expect(dreamGoal?.scope_knowledge_ids).toEqual(g.scope_knowledge_ids);

    // 8. Coach — inject the coachWithGoalStrand stub (reuse the
    //    coach_daily.northstar.test.ts:130-154 shape verbatim) + a capturing
    //    writeEventFn for the experimental:coach_scan payload. Real default
    //    listActiveGoals feeds the goal (no injection).
    type CoachScanPayload = {
      today_plan?: {
        goal_ids?: string[];
        goal_strand?: Array<{ serves_goal_id: string; knowledge_ids: string[] }>;
      };
    };
    let scanPayload: CoachScanPayload | null = null;
    const coachStub = vi.fn(coachWithGoalStrand(active));
    await runCoach(db, 'daily', {
      runAgentTaskFn: coachStub,
      buildMcpServerFn: () => ({ name: 'fake-loom' }) as never,
      writeEventFn: async (_db, input) => {
        if (input.action === 'experimental:coach_scan') {
          scanPayload = input.payload as unknown as CoachScanPayload;
        }
        return input.id;
      },
      now: () => NOW,
    });

    // ── Slice C — Coach receives + biases on the goal. ──
    // (1) the goal REACHED the model (buildCoachInput → coach_daily.ts:143-149):
    const coachInput = coachStub.mock.calls[0]?.[1] as unknown as {
      active_goals: Array<{ id: string }>;
    };
    expect(coachInput.active_goals.map((x) => x.id)).toContain(goalId);
    // (2) bias is ACTIVE in the persisted plan:
    expect(scanPayload).not.toBeNull();
    const plan = (scanPayload as CoachScanPayload | null)?.today_plan;
    expect(plan?.goal_strand?.length ?? 0).toBeGreaterThan(0);
    expect(plan?.goal_strand?.[0]?.serves_goal_id).toBe(goalId);
    expect(plan?.goal_ids).toContain(goalId);

    // 9. Edge-propose nightly — wraps runKnowledgeEdgeProposeNightly with the
    //    canned EdgeProposeOutput (Risk 2, reuse seed-synthetic.ts:848-870).
    await runStubbedNightly(db);

    // ── Slice E — Review due-list goal-bias reorder (pure deterministic rerank,
    // no LLM). handleReviewDue reads goals via its DEFAULT listActiveGoals (bound
    // to the real testcontainer db), so the materialized goal drives the reorder.
    // The goal scope is [xuci, jushi]; the seeded overdue questions reference
    // shici (idx0) / xuci (idx1) / jushi (idx2) / changshi (idx3). ──
    const dueRes = await handleReviewDue(
      new Request('http://localhost/api/review/due?limit=50'),
      {},
    );
    const dueJson = (await dueRes.json()) as {
      rows: Array<{ id: string; knowledge_ids: string[]; fsrs_state: unknown }>;
    };
    const rows = dueJson.rows;
    // Restrict to the OVERDUE segment (fsrs_state !== null) — the only segment
    // rerankOverdueByGoals touches. Both a goal-relevant and a non-relevant
    // overdue item must exist (else the rerank early-returns at due-list.ts:431),
    // and EVERY goal-relevant overdue item must precede EVERY non-relevant one
    // (the stable-partition contract — a genuine reorder, not first-vs-first).
    const scopeSet = new Set(GOAL_SCOPE_IDS as string[]);
    const overdue = rows.filter((r) => r.fsrs_state !== null);
    const relevantIdx = overdue
      .map((r, i) => (r.knowledge_ids.some((k) => scopeSet.has(k)) ? i : -1))
      .filter((i) => i >= 0);
    const otherIdx = overdue
      .map((r, i) => (r.knowledge_ids.some((k) => scopeSet.has(k)) ? -1 : i))
      .filter((i) => i >= 0);
    expect(relevantIdx.length).toBeGreaterThan(0);
    expect(otherIdx.length).toBeGreaterThan(0);
    // The last goal-relevant overdue index is before the first non-relevant one.
    expect(Math.max(...relevantIdx)).toBeLessThan(Math.min(...otherIdx));

    // ── Slice F — proposal_signals digest + L2 gate bump (seed-provided). ──
    const rates = await getProposalAcceptanceRates(db);
    expect(rates.length).toBeGreaterThan(0);
    expect(rates.every((r) => r.total > 0)).toBe(true);
    const bump = await resolveEdgeGateBump(
      db,
      L2_DISMISS_RELATION,
      PROPOSAL_FEEDBACK_BUDGET,
      PROPOSAL_GATE_BIAS_CONFIG,
    );
    expect(bump.tightenMediumToStrong).toBe(true); // L2_DISMISS_RELATION='related_to'

    // ── Slice G — FSRS due > 0 (seed-provided). ──
    const dueFsrs = await db
      .select({ id: material_fsrs_state.subject_id })
      .from(material_fsrs_state)
      .where(
        and(
          eq(material_fsrs_state.subject_kind, 'question'),
          sql`${material_fsrs_state.due_at} <= ${NOW.toISOString()}::timestamptz`,
          sql`${material_fsrs_state.subject_id} LIKE 'synthetic:q:%'`,
        ),
      );
    expect(dueFsrs.length).toBeGreaterThan(0);
  });
});

// CoachTask stub that emits a goal-oriented strand referencing the active goal —
// reused verbatim from coach_daily.northstar.test.ts:130-154 (Risk 2).
function coachWithGoalStrand(activeGoals: ActiveGoal[]) {
  const g = activeGoals[0];
  return async (_kind: string, _input: unknown, _ctx: unknown) => ({
    task_run_id: 'task_coach_goal',
    text: JSON.stringify({
      daily_focus: '今天先复盘，再朝目标推进',
      review_session_proposal: { count: 12, estimated_minutes: 20 },
      plan_adjustments: [],
      maintenance_proposals: [],
      goal_ids: g ? [g.id] : [],
      goal_strand: g
        ? [
            {
              serves_goal_id: g.id,
              knowledge_ids: g.scope_knowledge_ids,
              focus: '推进目标覆盖的薄弱节点',
            },
          ]
        : [],
    }),
    finishReason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 2 },
    cost_usd: 0.001,
  });
}

afterAll(() => {
  vi.restoreAllMocks();
});
