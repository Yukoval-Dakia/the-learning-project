// P5.5 Phase 1 — Tool-eval fixtures (4 core wenyan scenarios).
// Spec: docs/superpowers/specs/2026-05-31-p5.5-tool-eval-fixtures-design.md
//
// A Layer-8 fixture-gating DB test layer: it proves the DomainTool suite's
// outputs are *intelligible to an agent*, end-to-end through their real chains,
// not merely that SQL returns rows. Each scenario calls the REAL tool
// `execute(ctx, input)`, threads stage N's output into stage N+1's input, and
// routes every output through the reusable `assertAgentReadable` contract (§3),
// plus scenario-specific assertions.
//
// NO production code is touched. Every tool is already registered
// (bootstrap.ts) and every seed helper / table already exists.
//
// Partition: DB (vitest.db.config.ts) — this file imports tests/helpers/db,
// live tool modules, and drizzle, so it MUST live in the DB partition
// (F-7 / AC-7). The pure-logic helper checks are FOLDED in here (M7), so there
// is NO separate fixtures-assert.test.ts and NO vitest.shared.ts edit.

import { completion_evidence, event, knowledge, learning_item, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { seedAttempt, seedUserCause } from '../../../../tests/helpers/event-seed';
import { getLearningItemContextTool } from './context-readers';
import { assertAgentReadable, assertCostLabel, resolvePath } from './fixtures-assert';
import { getAttemptContextTool } from './get-attempt-context';
import {
  attributeMistakeTool,
  proposeKnowledgeEdgeTool,
  proposeLearningItemCompletionTool,
  proposeVariantTool,
} from './proposal-tools';
import { queryMistakesTool } from './query-mistakes';
import type { DomainTool, ToolContext } from './types';

// BLOCKER 2 — the LLM is ALWAYS stubbed at the module level. There is NO
// per-call injection point on `tool.execute()`: the fixture calls the real
// tool, which calls the real runner. We mirror proposal-tools.test.ts:34–56:
// `vi.mock('@/server/ai/runner')` + `vi.mock('@anthropic-ai/claude-agent-sdk')`
// (so the SDK import never spawns Claude), then set a fresh result PER STAGE
// with `mockRunner.runTask.mockResolvedValueOnce(...)` before each LLM-backed
// execute(). Read-only tools touch no LLM and need no per-call mock, but the
// module mocks must still be declared.
const mockRunner = vi.hoisted(() => ({ runTask: vi.fn() }));

vi.mock('@/server/ai/runner', () => ({
  runTask: mockRunner.runTask,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((opts: unknown) => ({ type: 'sdk', instance: opts })),
  tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: unknown) => ({
    name,
    handler,
  })),
}));

// `ctx()` per read-tools-m2.test.ts:38 — an agent caller (matches
// proposal-tools.test.ts:60), so the P5.4 rubric (isAgent:true) governs any
// agent-gated propose. proposal-tools need an agent caller.
function ctx(): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'tr_p5_5_fixtures',
    callerActor: { kind: 'agent', ref: 'agent:copilot' },
  };
}

// Recent base for non-rubric seeds. Rubric-gated confusion evidence (scenario
// iii) uses Date.now()-relative dates separately (B1 / PR #219 fix).
const BASE = new Date(Date.now() - 60_000);

// --- seed primitives (§5.2) — reuse the read-tools-m2.test.ts seedGraph shape
// and event-seed.ts seedAttempt/seedUserCause; no new helpers. ---

/** One wenyan knowledge node `k_zhi` under a wenyan root (the §5.2 shape). */
async function seedZhiNode(): Promise<void> {
  const db = testDb();
  await db.insert(knowledge).values([
    { id: 'k_root', name: '文言虚词', domain: 'wenyan', created_at: BASE, updated_at: BASE },
    {
      id: 'k_zhi',
      name: '之的用法',
      domain: null,
      parent_id: 'k_root',
      created_at: BASE,
      updated_at: BASE,
    },
  ]);
}

/** Two wenyan endpoints `k_zhi`/`k_er` under a wenyan root, NO edge between
 *  them (so a contrasts_with propose is novel). */
async function seedZhiErNodes(): Promise<void> {
  const db = testDb();
  await db.insert(knowledge).values([
    { id: 'k_root', name: '文言虚词', domain: 'wenyan', created_at: BASE, updated_at: BASE },
    {
      id: 'k_zhi',
      name: '之的用法',
      domain: null,
      parent_id: 'k_root',
      created_at: BASE,
      updated_at: BASE,
    },
    {
      id: 'k_er',
      name: '而的用法',
      domain: null,
      parent_id: 'k_root',
      created_at: BASE,
      updated_at: BASE,
    },
  ]);
}

/**
 * A recent, judge-backed failure attempt that references BOTH k_zhi and k_er —
 * the "same answer confuses two usages" §4.3 confusion evidence the
 * contrasts_with predicate requires (mirrors proposal-tools.test.ts:160–209).
 *
 * BLOCKER 1 / PR #219 fix — `createdAt` MUST be Date.now()-relative (recency is
 * measured against Date.now() + the 30d window in rubric-validator.ts:520–523).
 * Fixed dates expire past the window and turn CI red after ~30 days.
 */
async function seedConfusionEvidence(attemptId: string, createdAt: Date): Promise<void> {
  const db = testDb();
  const questionId = `q_${attemptId}`;
  await db.insert(question).values({
    id: questionId,
    kind: 'short_answer',
    prompt_md: '辨析「之」与「而」在句中的用法',
    reference_md: '「之」结构助词；「而」连词。',
    knowledge_ids: ['k_zhi', 'k_er'],
    source: 'manual',
    difficulty: 3,
    created_at: BASE,
    updated_at: BASE,
  });
  await writeEvent(db, {
    id: attemptId,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: questionId,
    outcome: 'failure',
    payload: {
      answer_md: '都当代词用',
      answer_image_refs: [],
      referenced_knowledge_ids: ['k_zhi', 'k_er'],
    },
    created_at: createdAt,
  });
  await writeEvent(db, {
    id: `judge_${attemptId}`,
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
        analysis_md: '用户把「之」「而」两个虚词的用法相互混淆。',
        confidence: 0.9,
      },
      referenced_knowledge_ids: ['k_zhi', 'k_er'],
    },
    caused_by_event_id: attemptId,
    created_at: new Date(createdAt.getTime() + 500),
  });
}

const ATTRIBUTION_TASK_RESULT = {
  task_run_id: 'tr_attr_model',
  text: JSON.stringify({
    primary_category: 'concept',
    secondary_categories: ['method'],
    analysis_md: '把结构助词「之」误判成代词。',
    confidence: 0.91,
  }),
  finishReason: 'stop' as const,
  usage: { inputTokens: 10, outputTokens: 20 },
  cost_usd: 0,
};

const VARIANT_GEN_TASK_RESULT = {
  task_run_id: 'tr_variant_model',
  text: JSON.stringify({
    prompt_md: '解释「之」在新句中的用法。',
    reference_md: '结构助词。',
    difficulty: 3,
    reasoning: '同一错因变式。',
  }),
  finishReason: 'stop' as const,
  usage: { inputTokens: 10, outputTokens: 20 },
  cost_usd: 0,
};

describe('P5.5 Phase 1 tool-eval fixtures', () => {
  beforeEach(async () => {
    await resetDb();
    mockRunner.runTask.mockReset();
  });

  // -------------------------------------------------------------------------
  // Scenario (i) — mistake-confusion chain (CHAIN, LD-5) — §4.1
  // Answers §5 `wenyan-zhi-confusion`.
  // query_mistakes -> get_attempt_context -> attribute_mistake -> propose_variant
  // -------------------------------------------------------------------------
  it('scenario (i): mistake-confusion chain is agent-readable end-to-end (AC-2)', async () => {
    const db = testDb();
    await seedZhiNode();
    await db.insert(question).values({
      id: 'q_zhi',
      kind: 'short_answer',
      prompt_md: '解释「之」在句中的作用',
      reference_md: '结构助词，取消句子独立性。',
      knowledge_ids: ['k_zhi'],
      source: 'manual',
      difficulty: 3,
      created_at: BASE,
      updated_at: BASE,
    });
    // One failure attempt (auto-mirrors learning_record(kind='mistake')).
    await seedAttempt({
      id: 'att_failure',
      question_id: 'q_zhi',
      outcome: 'failure',
      answer_md: '代词',
      knowledge_ids: ['k_zhi'],
      created_at: new Date(BASE.getTime() + 1_000),
    });
    // A user cause so stages 1/2 surface a cause (no pre-seeded judge — stage 3
    // writes it via the stubbed runner).
    await seedUserCause({
      attempt_event_id: 'att_failure',
      primary_category: 'concept',
      created_at: new Date(BASE.getTime() + 1_500),
    });

    // --- Stage 1: query_mistakes ---
    const mistakes = await queryMistakesTool.execute(ctx(), {});
    expect(mistakes.total).toBe(1);
    await assertAgentReadable(db, queryMistakesTool as DomainTool, {}, mistakes, {
      keyInsightFields: [
        'mistakes[].cause',
        'mistakes[].cause.source',
        'mistakes[].cause.primary_category',
        'mistakes[].knowledge_ids',
      ],
      idRefs: [
        { path: 'mistakes[].event_id', table: 'event' },
        { path: 'mistakes[].question_id', table: 'question' },
        { path: 'mistakes[].knowledge_ids[]', table: 'knowledge' },
      ],
    });
    // Hand-off: mistakes[0].event_id -> attemptEventId (asserted non-null first).
    const attemptEventId = mistakes.mistakes[0].event_id;
    expect(attemptEventId).toBeTruthy();

    // --- Stage 2: get_attempt_context ---
    const attemptCtx = await getAttemptContextTool.execute(ctx(), { attemptEventId });
    expect(attemptCtx.cause).not.toBeNull();
    await assertAgentReadable(
      db,
      getAttemptContextTool as DomainTool,
      { attemptEventId },
      attemptCtx,
      {
        keyInsightFields: [
          'attempt',
          'attempt.event_id',
          'cause',
          'cause.source',
          'cause.primary_category',
        ],
        idRefs: [
          { path: 'attempt.event_id', table: 'event' },
          { path: 'timeline[].event_id', table: 'event' },
        ],
      },
    );
    // Hand-off: attempt.event_id -> attribute_mistake.attempt_event_id.
    const attemptId = attemptCtx.attempt.event_id;
    expect(attemptId).toBeTruthy();

    // --- Stage 3: attribute_mistake (LLM-stubbed) ---
    mockRunner.runTask.mockResolvedValueOnce(ATTRIBUTION_TASK_RESULT);
    const attributed = await attributeMistakeTool.execute(ctx(), { attempt_event_id: attemptId });
    expect(attributed.status).toBe('written');
    expect(attributed.judge_event_id).toBeTruthy();
    await assertAgentReadable(
      db,
      attributeMistakeTool as DomainTool,
      { attempt_event_id: attemptId },
      attributed,
      {
        keyInsightFields: [
          'status',
          'judge_event_id',
          'cause.primary_category',
          'cause.confidence',
          'cause.analysis_excerpt',
        ],
        idRefs: [{ path: 'judge_event_id', table: 'event' }],
      },
    );

    // --- Stage 4: propose_variant (LLM-stubbed) ---
    // Hand-off: stage 4 takes the SAME attempt id; stage 3's judge write is the
    // precondition runVariantGen re-reads (judge must exist or no_judge_yet).
    mockRunner.runTask.mockResolvedValueOnce(VARIANT_GEN_TASK_RESULT);
    const variant = await proposeVariantTool.execute(ctx(), { attempt_event_id: attemptId });
    expect(variant.status).toBe('generated');
    // H3 — variant_question_ids is hardcoded [] on success; do NOT assert it
    // non-empty (proposal-tools.ts:879). Assert proposal_ids / mistake_variant_ids.
    expect(variant.proposal_ids).toHaveLength(1);
    expect(variant.mistake_variant_ids).toHaveLength(1);
    await assertAgentReadable(
      db,
      proposeVariantTool as DomainTool,
      { attempt_event_id: attemptId },
      variant,
      {
        keyInsightFields: ['status', 'proposal_ids', 'mistake_variant_ids'],
        idRefs: [{ path: 'proposal_ids[]', table: 'event' }],
      },
    );
  });

  // -------------------------------------------------------------------------
  // Scenario (ii) — zero-result-corrective (ISOLATED, KNOWN ERROR) — §4.2
  // Answers §5 `wenyan-zero-result`.
  // -------------------------------------------------------------------------
  it('scenario (ii): empty query_mistakes is a legitimate success, not a corrective trigger (AC-3)', async () => {
    const db = testDb();
    // Single knowledge node, NO failure attempts, NO questions — the read must
    // legitimately return empty.
    await seedZhiNode();

    // Soft-fail contract (types.ts:60): empty read returns a valid Output, does
    // NOT throw.
    const empty = await queryMistakesTool.execute(ctx(), {});

    // The valid empty shape: present non-null array, total 0, filter_applied set.
    expect(empty.mistakes).toEqual([]);
    expect(empty.total).toBe(0);
    expect(empty.filter_applied).toBeTruthy();

    await assertAgentReadable(db, queryMistakesTool as DomainTool, {}, empty, {
      keyInsightFields: ['mistakes', 'filter_applied'],
      idRefs: [],
      allowEmptyContainers: true,
    });

    // P5.6 tie (the semantic assertion): this is a *success* shape (would map to
    // outcome:'success' via mcp-bridge.ts:287 because there is no errorReason),
    // explicitly NOT an error or a corrective trigger. Note: §5's doc wording
    // ("0 result with corrective query suggestions", knowledge.md:407) predates
    // P5.6 — the current Output has NO suggestions field; this fixture pins the
    // P5.6 empty-success semantics, NOT that phrasing (§9 follow-up).
    expect('suggestions' in empty).toBe(false);
    expect(empty.total).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Scenario (iii) — knowledge-edge proposal + duplicate-edge rejection
  // (KNOWN ERROR, LD-3 / F-6) — §4.3. Answers §5 `edge-duplicate`.
  // -------------------------------------------------------------------------
  it('scenario (iii): rubric-valid edge proposes, then an identical re-propose is duplicate_pending (AC-4)', async () => {
    const db = testDb();
    await seedZhiErNodes();
    // BLOCKER 1 — the first propose must reach 'proposed' (NOT
    // skipped:rubric_rejected). Seed two in-window, judge-backed confusion
    // failures referencing BOTH endpoints (mirrors proposal-tools.test.ts:296–
    // 317). Date.now()-relative so they stay inside the 30d window (PR #219).
    await seedConfusionEvidence('conf_1', new Date(Date.now() - 1 * 86_400_000));
    await seedConfusionEvidence('conf_2', new Date(Date.now() - 2 * 86_400_000));

    const proposeArgs = {
      from_knowledge_id: 'k_zhi',
      to_knowledge_id: 'k_er',
      relation_type: 'contrasts_with' as const,
      weight: 0.7,
      // Concrete-signal reasoning (names the seeded attempt ids + the cause):
      // clears the §4.1 strong floor + §4.2 evidence floor + §4.3 confusion
      // predicate.
      reasoning: 'attempt conf_1 与 conf_2 的 judge cause 均指向用户把「之」「而」用法混淆。',
      evidence_event_ids: ['conf_1', 'conf_2'],
    };

    // --- Stage 1: first propose succeeds (rubric satisfied) ---
    const first = await proposeKnowledgeEdgeTool.execute(ctx(), proposeArgs);
    expect(first.status).toBe('proposed');
    expect(first.proposal_id).toBeTruthy();
    await assertAgentReadable(db, proposeKnowledgeEdgeTool as DomainTool, proposeArgs, first, {
      keyInsightFields: ['status', 'proposal_id'],
      idRefs: [{ path: 'proposal_id', table: 'event' }],
    });

    // --- Stage 2: identical re-propose short-circuits at the cooldown lookup
    // BEFORE the rubric (proposal-tools.ts:322–324 runs ahead of :391), so the
    // duplicate needs no evidence. The dedup is via the pending-proposal
    // cooldown lookup, NOT the knowledge_edge live table (F-6). The
    // duplicate-pending return carries cooldown_key only (no `reason` field),
    // so the agent-visible contract = status + cooldown_key equality.
    const second = await proposeKnowledgeEdgeTool.execute(ctx(), proposeArgs);
    expect(second.status).toBe('skipped:duplicate_pending');
    expect(second.cooldown_key).toBeTruthy();
    expect(second.cooldown_key).toBe(first.cooldown_key);
    expect(second.reason).toBeUndefined();

    // Cost limb still runs for the skip output.
    assertCostLabel(proposeKnowledgeEdgeTool as DomainTool, proposeArgs, second);
  });

  // -------------------------------------------------------------------------
  // Scenario (iv) — learning_item_context + completion proposal (CHAIN, LD-5)
  // §4.4. Answers the brief's 4th core scenario (learning-item lifecycle).
  // get_learning_item_context -> propose_learning_item_completion
  // -------------------------------------------------------------------------
  it('scenario (iv): learning-item context chains into a completion proposal (AC-5)', async () => {
    const db = testDb();
    await seedZhiNode();
    // One in_progress learning_item + one completion_evidence row + a ready
    // primary artifact (the read-tools-m2.test.ts seedLearningObjects shape,
    // trimmed to this scenario's needs).
    await db.insert(learning_item).values({
      id: 'li_zhi',
      source: 'manual',
      title: '学习之的用法',
      content: '先看例句，再做题。',
      status: 'in_progress',
      knowledge_ids: ['k_zhi'],
      created_at: BASE,
      updated_at: BASE,
    });
    await db.insert(completion_evidence).values({
      id: 'ev_complete',
      learning_item_id: 'li_zhi',
      path: 'primary_artifact.ready',
      evidence_json: { summary: 'note ready' },
      user_overrode_low_evidence: false,
      decided_at: new Date(BASE.getTime() + 2_000),
    });

    // --- Stage 1: get_learning_item_context ---
    const itemCtx = await getLearningItemContextTool.execute(ctx(), {
      learningItemId: 'li_zhi',
      include: ['parent', 'children', 'completion_evidence', 'knowledge_context'],
    });
    expect(itemCtx.item?.status).toBe('in_progress');
    expect(itemCtx.evidence?.[0]?.id).toBe('ev_complete');
    await assertAgentReadable(
      db,
      getLearningItemContextTool as DomainTool,
      { learningItemId: 'li_zhi' },
      itemCtx,
      {
        keyInsightFields: [
          'item.status',
          'hierarchy.children',
          'evidence[].id',
          'evidence[].path',
          'evidence[].summary',
          'knowledge_context[].knowledge_id',
        ],
        idRefs: [
          { path: 'item.id', table: 'learning_item' },
          { path: 'evidence[].id', table: 'completion_evidence' },
          { path: 'knowledge_context[].knowledge_id', table: 'knowledge' },
        ],
      },
    );
    // Hand-off: item.id -> propose_learning_item_completion.learning_item_id.
    const itemId = itemCtx.item?.id;
    expect(itemId).toBeTruthy();

    // --- Stage 2: propose_learning_item_completion (no LLM, not rubric-gated) ---
    const evidenceIds = (itemCtx.evidence ?? []).map((e) => e.id);
    const completion = await proposeLearningItemCompletionTool.execute(ctx(), {
      learning_item_id: itemId as string,
      triggering_signals: ['check_all_passed'],
      evidence_event_ids: evidenceIds.length > 0 ? evidenceIds : undefined,
      reasoning: 'primary artifact is ready and completion evidence is recorded.',
    });
    expect(completion.status).toBe('proposed');
    expect(completion.proposal_id).toBeTruthy();
    expect(completion.learning_item_id).toBe(itemId);
    await assertAgentReadable(
      db,
      proposeLearningItemCompletionTool as DomainTool,
      { learning_item_id: itemId },
      completion,
      {
        keyInsightFields: ['status', 'proposal_id', 'learning_item_id'],
        idRefs: [
          { path: 'proposal_id', table: 'event' },
          { path: 'learning_item_id', table: 'learning_item' },
        ],
      },
    );
  });
});

// ===========================================================================
// FOLDED pure-logic helper checks (M7) — these live INSIDE the DB test file,
// NOT a separate fixtures-assert.test.ts, so no vitest.shared.ts /
// fastTestInclude edit is needed (AC-7). They exercise the dotted-path
// resolver, the cost-shape limb, and the negative self-test (a hand-broken
// output fails each limb — AC-1). They do not need the DB and do not seed.
// ===========================================================================
describe('P5.5 fixtures-assert helper (pure-logic, folded — M7)', () => {
  // The limb-b negative self-test relies on no `knowledge` row existing for the
  // dangling id, so reset before each (DB config is singleFork — the container
  // is shared across files; don't assume isolation without resetDb).
  beforeEach(async () => {
    await resetDb();
  });

  it('resolvePath resolves scalars, nested objects, and arrays elementwise', () => {
    const root = {
      total: 0,
      item: { status: 'in_progress', cause: { primary_category: 'concept' } },
      mistakes: [
        { event_id: 'e1', knowledge_ids: ['k1', 'k2'] },
        { event_id: 'e2', knowledge_ids: ['k3'] },
      ],
    };
    expect(resolvePath(root, 'total').map((r) => r.value)).toEqual([0]);
    expect(resolvePath(root, 'item.cause.primary_category').map((r) => r.value)).toEqual([
      'concept',
    ]);
    expect(resolvePath(root, 'mistakes[].event_id').map((r) => r.value)).toEqual(['e1', 'e2']);
    expect(resolvePath(root, 'mistakes[].knowledge_ids[]').map((r) => r.value)).toEqual([
      'k1',
      'k2',
      'k3',
    ]);
  });

  it('resolvePath flags a non-array where a [] segment expects one', () => {
    const root = { mistakes: { not: 'an array' } };
    const resolved = resolvePath(root, 'mistakes[].event_id');
    expect(resolved).toHaveLength(1);
    expect(resolved[0].path).toContain('not-an-array');
    expect(resolved[0].value).toBeUndefined();
  });

  const goodTool = {
    name: 'fake_tool',
    costClass: 'local',
    summarize: () => 'fake · 1 row',
  } as unknown as DomainTool;

  it('assertCostLabel passes a valid costClass + short summarize', () => {
    expect(() => assertCostLabel(goodTool, {}, {})).not.toThrow();
  });

  it('assertCostLabel fails an invalid costClass (negative self-test, limb d)', () => {
    const badCost = { ...goodTool, costClass: 'bogus' } as unknown as DomainTool;
    expect(() => assertCostLabel(badCost, {}, {})).toThrow();
  });

  it('assertCostLabel fails an empty or over-long summarize (negative self-test, limb d)', () => {
    const emptySummary = { ...goodTool, summarize: () => '' } as unknown as DomainTool;
    expect(() => assertCostLabel(emptySummary, {}, {})).toThrow();
    const longSummary = {
      ...goodTool,
      summarize: () => 'x'.repeat(121),
    } as unknown as DomainTool;
    expect(() => assertCostLabel(longSummary, {}, {})).toThrow();
  });

  it('assertAgentReadable fails on a nulled key-insight field (negative self-test, limb a/c)', async () => {
    const db = testDb();
    const output = { item: { status: null } };
    await expect(
      assertAgentReadable(db, goodTool, {}, output, {
        keyInsightFields: ['item.status'],
        idRefs: [],
      }),
    ).rejects.toThrow();
  });

  it('assertAgentReadable fails on a dangling cited id (negative self-test, limb b)', async () => {
    const db = testDb();
    // No knowledge rows are seeded (the beforeEach resetDb already truncated),
    // so a cited knowledge id cannot resolve.
    const output = { knowledge_id: 'k_does_not_exist' };
    await expect(
      assertAgentReadable(db, goodTool, {}, output, {
        keyInsightFields: ['knowledge_id'],
        idRefs: [{ path: 'knowledge_id', table: 'knowledge' }],
      }),
    ).rejects.toThrow();
  });
});
