// P5.4 / YUK-143 — DB-partition coverage for validateProposalQuality.
// One test per gate class (agent rejections), the user-edited structural-only
// branch (RB-3), the §4.2 evidence window (RB-5), and the §4.3 relation
// predicates. Imports tests/helpers/db → DB partition (not in fastTestInclude).

import type { AiProposalPayloadT } from '@/core/schema/proposal';
import { parseAiProposalPayload } from '@/core/schema/proposal';
import { knowledge, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  RUBRIC_EVIDENCE_WINDOW_DAYS,
  type RubricGate,
  validateProposalQuality,
} from './rubric-validator';

const DAY_MS = 24 * 60 * 60 * 1000;

function edgePayload(
  fromId: string,
  toId: string,
  relation: string,
  opts: { reasoning?: string; evidenceEventIds?: string[] } = {},
): AiProposalPayloadT {
  return parseAiProposalPayload({
    kind: 'knowledge_edge',
    target: { subject_kind: 'knowledge_edge', subject_id: null },
    reason_md:
      opts.reasoning ?? 'attempt e_concrete 显示用户在 k_zhi 上反复失败，judge cause 为 concept。',
    evidence_refs: (opts.evidenceEventIds ?? []).map((id) => ({ kind: 'event', id })),
    proposed_change: {
      from_knowledge_id: fromId,
      to_knowledge_id: toId,
      relation_type: relation,
      weight: 1,
    },
  });
}

async function seedGraph(): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(knowledge)
    .values([
      { id: 'k_wenyan', name: '文言文', domain: 'wenyan', created_at: now, updated_at: now },
      {
        id: 'k_zhi',
        name: '之的用法',
        domain: null,
        parent_id: 'k_wenyan',
        created_at: now,
        updated_at: now,
      },
      {
        id: 'k_er',
        name: '而的用法',
        domain: null,
        parent_id: 'k_wenyan',
        created_at: now,
        updated_at: now,
      },
      { id: 'k_math', name: '数学', domain: 'math', created_at: now, updated_at: now },
    ]);
}

// A recent judge-backed failure referencing the given knowledge ids. The judge
// cause `primary_category` defaults to 'concept' but can be overridden so tests
// can construct "same pattern" vs "unrelated" evidence pairs (§4.2 strong).
async function seedEvidence(
  attemptId: string,
  knowledgeIds: string[],
  ageDays: number,
  causeCategory = 'concept',
): Promise<void> {
  const db = testDb();
  const questionId = `q_${attemptId}`;
  const createdAt = new Date(Date.now() - ageDays * DAY_MS);
  await db.insert(question).values({
    id: questionId,
    kind: 'short_answer',
    prompt_md: 'p',
    reference_md: 'r',
    knowledge_ids: knowledgeIds,
    source: 'manual',
    difficulty: 3,
    created_at: createdAt,
    updated_at: createdAt,
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
      answer_md: 'wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: knowledgeIds,
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
        primary_category: causeCategory,
        secondary_categories: [],
        analysis_md: '用户混淆两个用法。',
        confidence: 0.9,
      },
      referenced_knowledge_ids: knowledgeIds,
    },
    caused_by_event_id: attemptId,
    created_at: new Date(createdAt.getTime() + 500),
  });
}

// A recent failure attempt whose cause comes from a user_cause event (NOT an
// agent judge). The user_cause carries a non-empty `user_notes` so it counts as
// the §4.2 "1 failure + explicit user note" strong path. No judge event is
// written, so `hasExplicitJudgeAnalysis` is false — this isolates the user-note
// axis of the two-event relaxation.
async function seedUserCauseFailure(
  attemptId: string,
  knowledgeIds: string[],
  ageDays: number,
  userNotes: string,
  causeCategory = 'concept',
): Promise<void> {
  const db = testDb();
  const questionId = `q_${attemptId}`;
  const createdAt = new Date(Date.now() - ageDays * DAY_MS);
  await db.insert(question).values({
    id: questionId,
    kind: 'short_answer',
    prompt_md: 'p',
    reference_md: 'r',
    knowledge_ids: knowledgeIds,
    source: 'manual',
    difficulty: 3,
    created_at: createdAt,
    updated_at: createdAt,
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
      answer_md: 'wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: knowledgeIds,
    },
    created_at: createdAt,
  });
  await writeEvent(db, {
    id: `uc_${attemptId}`,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:user_cause',
    subject_kind: 'event',
    subject_id: attemptId,
    outcome: 'success',
    payload: {
      primary_category: causeCategory,
      secondary_categories: [],
      user_notes: userNotes,
    },
    caused_by_event_id: attemptId,
    created_at: new Date(createdAt.getTime() + 500),
  });
}

// A recent judge-backed failure whose judge cause carries an EMPTY analysis_md
// and NO user_cause — i.e. the category is tagged but there is no explicit
// analysis prose. `effectiveCauseForFailureAttempt` still returns non-null (the
// failure is judge-backed → counts toward the §4.2 level), but
// `hasExplicitJudgeAnalysis` is false. This is the §4.3 "PLAIN single failure"
// case: a single such event is medium and must STILL be rejected for
// prerequisite / contrasts_with (no explicit-analysis rescue).
async function seedPlainJudgeFailure(
  attemptId: string,
  knowledgeIds: string[],
  ageDays: number,
  causeCategory = 'concept',
): Promise<void> {
  const db = testDb();
  const questionId = `q_${attemptId}`;
  const createdAt = new Date(Date.now() - ageDays * DAY_MS);
  await db.insert(question).values({
    id: questionId,
    kind: 'short_answer',
    prompt_md: 'p',
    reference_md: 'r',
    knowledge_ids: knowledgeIds,
    source: 'manual',
    difficulty: 3,
    created_at: createdAt,
    updated_at: createdAt,
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
      answer_md: 'wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: knowledgeIds,
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
        primary_category: causeCategory,
        secondary_categories: [],
        analysis_md: '', // empty → judge-backed but NOT explicit analysis
        confidence: 0.9,
      },
      referenced_knowledge_ids: knowledgeIds,
    },
    caused_by_event_id: attemptId,
    created_at: new Date(createdAt.getTime() + 500),
  });
}

// A recent judge-backed failure where the ATTEMPT's referenced_knowledge_ids and
// the JUDGE's referenced_knowledge_ids DIVERGE — the attempt's own refs are
// `attemptKnowledgeIds` (e.g. empty / stale user selection) while the judge
// references `judgeKnowledgeIds` at grading time. Used to prove the codex r4 P2
// #3 fix: the endpoint / confusion / same-pattern checks read the UNION
// (attempt ∪ judge), so a judge-referenced endpoint counts as evidence even when
// the attempt's refs miss it. Non-empty `analysis_md` → judge-backed + explicit.
async function seedDivergentRefsFailure(
  attemptId: string,
  attemptKnowledgeIds: string[],
  judgeKnowledgeIds: string[],
  ageDays: number,
  causeCategory = 'concept',
): Promise<void> {
  const db = testDb();
  const questionId = `q_${attemptId}`;
  const createdAt = new Date(Date.now() - ageDays * DAY_MS);
  await db.insert(question).values({
    id: questionId,
    kind: 'short_answer',
    prompt_md: 'p',
    reference_md: 'r',
    knowledge_ids: attemptKnowledgeIds,
    source: 'manual',
    difficulty: 3,
    created_at: createdAt,
    updated_at: createdAt,
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
      answer_md: 'wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: attemptKnowledgeIds,
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
        primary_category: causeCategory,
        secondary_categories: [],
        analysis_md: '判官在评分时指向了端点节点。',
        confidence: 0.9,
      },
      referenced_knowledge_ids: judgeKnowledgeIds,
    },
    caused_by_event_id: attemptId,
    created_at: new Date(createdAt.getTime() + 500),
  });
}

const AGENT = { isAgent: true, actorRef: 'agent:maintenance' };

describe('validateProposalQuality — structural class (G1–G6)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedGraph();
  });

  it('G1 self_edge', async () => {
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_zhi', 'related_to'),
      testDb(),
      AGENT,
    );
    expect(v).toEqual({ ok: false, gate: 'self_edge', reason: expect.any(String) });
  });

  it('G2 unknown_node (missing endpoint)', async () => {
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_ghost', 'related_to'),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.gate).toBe('unknown_node');
  });

  it('G3 cross_subject', async () => {
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_math', 'related_to'),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.gate).toBe('cross_subject');
  });

  it('G6 parent_semantic_duplicate (restates tree ancestry)', async () => {
    // k_zhi.parent_id === k_wenyan → an edge between them only restates the tree.
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_wenyan', 'related_to', {
        evidenceEventIds: ['e_dup'],
      }),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.gate).toBe('parent_semantic_duplicate');
  });
});

// FIX 2 / §3.1 + §3.3 — the G6 tree-ancestry rejection is SCOPED to relations
// whose semantics are merely hierarchy (related_to + derived_from). It must NOT
// reject valid hierarchy-aligned prerequisite / applied_in edges (their §4.3
// gates handle them); and it must STILL reject derived_from + related_to that
// only restate tree parentage.
describe('validateProposalQuality — G6 scope (FIX 2)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedGraph();
  });

  it('prerequisite parent→child with strong order evidence is NOT G6-rejected → {ok:true}', async () => {
    // k_wenyan is the direct parent of k_zhi. A prerequisite parent→child edge
    // is exactly the §3.3-endorsed "prerequisite concept → narrower task" shape.
    // Two in-window judge-backed failures reference an endpoint (k_zhi) → strong
    // floor + order evidence → must PASS, NOT trip parent_semantic_duplicate.
    await seedEvidence('e_pre_1', ['k_zhi'], 1);
    await seedEvidence('e_pre_2', ['k_zhi'], 2);
    const v = await validateProposalQuality(
      edgePayload('k_wenyan', 'k_zhi', 'prerequisite', {
        reasoning: 'attempt e_pre judge cause concept：先掌握 k_wenyan 才能学 k_zhi。',
        evidenceEventIds: ['e_pre_1', 'e_pre_2'],
      }),
      testDb(),
      AGENT,
    );
    expect(v).toEqual({ ok: true });
  });

  it('applied_in between tree-adjacent nodes with role evidence is NOT G6-rejected → {ok:true}', async () => {
    // applied_in from parent concept k_wenyan to child application k_zhi: a
    // valid role direction. Endpoint-referencing strong evidence → passes; the
    // G6 ancestry check must not fire for applied_in.
    await seedEvidence('e_app_1', ['k_zhi'], 1);
    await seedEvidence('e_app_2', ['k_zhi'], 2);
    const v = await validateProposalQuality(
      edgePayload('k_wenyan', 'k_zhi', 'applied_in', {
        reasoning: 'attempt e_app judge cause method：k_wenyan 的方法应用在 k_zhi 上。',
        evidenceEventIds: ['e_app_1', 'e_app_2'],
      }),
      testDb(),
      AGENT,
    );
    expect(v).toEqual({ ok: true });
  });

  it('derived_from between tree ancestor/descendant IS still G6-rejected', async () => {
    // derived_from overlaps tree parentage (§3.1) → G6 still applies.
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_wenyan', 'derived_from', {
        reasoning: 'attempt e_df 显示派生关系',
        evidenceEventIds: ['e_df'],
      }),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.gate).toBe('parent_semantic_duplicate');
  });

  it('related_to parent→child restatement IS still G6-rejected (confirm)', async () => {
    // The pre-P5.4 related_to-only behavior is preserved.
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_wenyan', 'related_to', {
        evidenceEventIds: ['e_rt_dup'],
      }),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.gate).toBe('parent_semantic_duplicate');
  });
});

describe('validateProposalQuality — reasoning + evidence floor (G7, §4.2)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedGraph();
  });

  it('G7a reasoning_generic — generic reason with no concrete signal', async () => {
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'related_to', {
        reasoning: '二者相关',
        evidenceEventIds: ['e1'],
      }),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.gate).toBe('reasoning_generic');
  });

  it('evidence_missing — agent edge with no evidence_event_ids', async () => {
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'related_to', {
        reasoning: 'attempt e_x 显示用户在 k_zhi 上失败。',
        evidenceEventIds: [],
      }),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.gate).toBe('evidence_missing');
  });

  it('evidence_level — single in-window judge-backed event is only medium', async () => {
    await seedEvidence('e_solo', ['k_zhi', 'k_er'], 1);
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'related_to', {
        reasoning: 'attempt e_solo judge cause concept。',
        evidenceEventIds: ['e_solo'],
      }),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.gate).toBe('evidence_level');
  });

  it('evidence window — event at WINDOW+1d is rejected, 1d-inside passes', async () => {
    // Two strong (≥2) events but both just outside the window → weak → reject.
    await seedEvidence('e_old_1', ['k_zhi', 'k_er'], RUBRIC_EVIDENCE_WINDOW_DAYS + 1);
    await seedEvidence('e_old_2', ['k_zhi', 'k_er'], RUBRIC_EVIDENCE_WINDOW_DAYS + 2);
    const rejected = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'related_to', {
        reasoning: 'attempt e_old judge cause concept。',
        evidenceEventIds: ['e_old_1', 'e_old_2'],
      }),
      testDb(),
      AGENT,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.gate).toBe('evidence_level');

    // Two events 1 day inside the window → strong → passes the floor.
    await seedEvidence('e_new_1', ['k_zhi', 'k_er'], 1);
    await seedEvidence('e_new_2', ['k_zhi', 'k_er'], 2);
    const passes = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'related_to', {
        reasoning: 'attempt e_new judge cause concept，用户在 k_zhi/k_er 上反复失败。',
        evidenceEventIds: ['e_new_1', 'e_new_2'],
      }),
      testDb(),
      AGENT,
    );
    expect(passes).toEqual({ ok: true });
  });

  // PR #219 review fix (FIX B / §4.2 "strong = 2+ recent failures show SAME
  // pattern"). Pre-fix, `strong` was raw count ≥2, so two UNRELATED judge-backed
  // failures upgraded to strong and passed the relation gate → a low-quality
  // edge. Now the ≥2 events must overlap on cause OR referenced knowledge.
  it('§4.2 strong requires same pattern — 2 SAME-pattern events → strong → passes', async () => {
    // Both reference an endpoint (k_zhi) AND share the 'concept' cause → same
    // pattern on both axes. (Endpoint-referencing keeps the related_to predicate
    // happy; the point here is the strong upgrade itself.)
    await seedEvidence('e_same_1', ['k_zhi'], 1, 'concept');
    await seedEvidence('e_same_2', ['k_zhi'], 2, 'concept');
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'related_to', {
        reasoning: 'attempt e_same_1/e_same_2 的 judge cause 均为 concept，集中在 k_zhi。',
        evidenceEventIds: ['e_same_1', 'e_same_2'],
      }),
      testDb(),
      AGENT,
    );
    expect(v).toEqual({ ok: true });
  });

  it('§4.2 strong requires same pattern — 1 endpoint failure + 1 UNRELATED failure → medium → rejected (evidence_level)', async () => {
    await testDb()
      .insert(knowledge)
      .values([
        {
          id: 'k_unrelated',
          name: '无关',
          domain: null,
          parent_id: 'k_wenyan',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);
    // Event A: references the edge endpoint k_zhi, cause 'concept'.
    await seedEvidence('e_mix_endpoint', ['k_zhi'], 1, 'concept');
    // Event B: a different recent judge-backed failure with NEITHER shared cause
    // NOR shared knowledge (k_unrelated, cause 'careless'). Pre-fix this raw
    // count of 2 upgraded to strong and the proposal passed; now it is medium.
    await seedEvidence('e_mix_unrelated', ['k_unrelated'], 2, 'careless');
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'related_to', {
        reasoning:
          'attempt e_mix_endpoint judge cause concept on k_zhi; e_mix_unrelated 是另一个无关错题。',
        evidenceEventIds: ['e_mix_endpoint', 'e_mix_unrelated'],
      }),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    // Two unrelated judge-backed failures yield at most medium → agent rejected
    // at the evidence floor (RB-4), NOT at a relation predicate.
    if (!v.ok) expect(v.gate).toBe('evidence_level');
  });
});

describe('validateProposalQuality — relation predicates (§4.3)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedGraph();
  });

  it('contrasts_with_no_confusion — strong evidence but no failure references both endpoints', async () => {
    // Two strong events, but each references only k_zhi (not both) → confusion
    // predicate fails even though the evidence floor passes.
    await seedEvidence('e_one_1', ['k_zhi'], 1);
    await seedEvidence('e_one_2', ['k_zhi'], 2);
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'contrasts_with', {
        reasoning: 'attempt e_one judge cause concept on k_zhi。',
        evidenceEventIds: ['e_one_1', 'e_one_2'],
      }),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    // prerequisite/contrasts_with require 2 events; both reference an endpoint,
    // so the floor passes, and the confusion predicate (references BOTH) fails.
    if (!v.ok) expect(v.gate).toBe('contrasts_with_no_confusion');
  });

  // FIX 3 (acceptance §7) — applied_in_role_mismatch direct rejecting test.
  it('applied_in_role_mismatch — strong evidence but none references an endpoint', async () => {
    // Two strong in-window judge-backed failures, but they reference an
    // unrelated node only → no application-direction / role evidence touching
    // either endpoint → applied_in role predicate fails (floor passes).
    await testDb()
      .insert(knowledge)
      .values([
        {
          id: 'k_apply_other',
          name: '其它',
          domain: null,
          parent_id: 'k_wenyan',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);
    await seedEvidence('e_apply_1', ['k_apply_other'], 1);
    await seedEvidence('e_apply_2', ['k_apply_other'], 2);
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'applied_in', {
        reasoning: 'attempt e_apply judge cause concept。',
        evidenceEventIds: ['e_apply_1', 'e_apply_2'],
      }),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.gate).toBe('applied_in_role_mismatch');
  });

  // FIX 3 (acceptance §7) — related_to_dumping_ground direct rejecting test.
  it('related_to_dumping_ground — strong evidence but none references an endpoint (no grouping value)', async () => {
    // Strong evidence referencing unrelated nodes → the related_to edge adds no
    // navigation/grouping value beyond co-occurrence → dumping-ground reject.
    await testDb()
      .insert(knowledge)
      .values([
        {
          id: 'k_rel_other',
          name: '无关',
          domain: null,
          parent_id: 'k_wenyan',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);
    await seedEvidence('e_rel_1', ['k_rel_other'], 1);
    await seedEvidence('e_rel_2', ['k_rel_other'], 2);
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'related_to', {
        reasoning: 'attempt e_rel judge cause concept。',
        evidenceEventIds: ['e_rel_1', 'e_rel_2'],
      }),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.gate).toBe('related_to_dumping_ground');
  });

  // Codex re-review FIX 1 (§4.3 default branch) — derived_from fell to the
  // default relation gate, which verified NO endpoint-touching evidence. Combined
  // with the strong-via-shared-cause path, 2 unrelated same-cause failures (neither
  // referencing from/to) passed. Now the default branch requires ≥1 in-window
  // judge-backed failure referencing an endpoint, mirroring the other relations.
  it('derived_from_no_endpoint_evidence — 2 same-cause failures reference neither endpoint', async () => {
    // k_zhi and k_er are siblings (both children of k_wenyan) → NOT tree
    // ancestor/descendant, so G6 does not fire. Both failures reference an
    // unrelated node (k_df_other) with the SAME 'concept' cause → same-pattern →
    // strong floor passes, but neither touches an endpoint → default gate rejects.
    await testDb()
      .insert(knowledge)
      .values([
        {
          id: 'k_df_other',
          name: '无关',
          domain: null,
          parent_id: 'k_wenyan',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);
    await seedEvidence('e_df_unrel_1', ['k_df_other'], 1, 'concept');
    await seedEvidence('e_df_unrel_2', ['k_df_other'], 2, 'concept');
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'derived_from', {
        reasoning: 'attempt e_df_unrel judge cause concept，但都在 k_df_other 上。',
        evidenceEventIds: ['e_df_unrel_1', 'e_df_unrel_2'],
      }),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.gate).toBe('derived_from_no_endpoint_evidence');
  });

  it('derived_from with ≥1 endpoint-referencing in-window judge-backed event passes (G6 ok)', async () => {
    // Same sibling endpoints (no tree ancestry → G6 ok). Two same-pattern
    // failures, at least one referencing an endpoint (k_zhi) → strong floor +
    // endpoint-touching evidence → passes.
    await seedEvidence('e_df_ok_1', ['k_zhi'], 1, 'concept');
    await seedEvidence('e_df_ok_2', ['k_zhi'], 2, 'concept');
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'derived_from', {
        reasoning: 'attempt e_df_ok judge cause concept，集中在 k_zhi，k_er 由其派生。',
        evidenceEventIds: ['e_df_ok_1', 'e_df_ok_2'],
      }),
      testDb(),
      AGENT,
    );
    expect(v).toEqual({ ok: true });
  });

  it('prerequisite_no_order_evidence — no in-window judge-backed failure references an endpoint', async () => {
    // Strong evidence that references unrelated nodes only → no order evidence.
    await testDb()
      .insert(knowledge)
      .values([
        {
          id: 'k_other',
          name: '其它',
          domain: null,
          parent_id: 'k_wenyan',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);
    await seedEvidence('e_unrel_1', ['k_other'], 1);
    await seedEvidence('e_unrel_2', ['k_other'], 2);
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'prerequisite', {
        reasoning: 'attempt e_unrel judge cause concept。',
        evidenceEventIds: ['e_unrel_1', 'e_unrel_2'],
      }),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    // 2 in-window judge-backed events exist (floor ok), but none reference an
    // endpoint → order-evidence predicate fails.
    if (!v.ok) expect(v.gate).toBe('prerequisite_no_order_evidence');
  });
});

// Codex re-review FIX 4 (§4.2 single-event-strong path for the two-event
// relations) — the prerequisite/contrasts_with 2-event relaxation only checked
// AGENT judge analysis, not explicit user_cause.user_notes. computeEvidenceLevel
// already treats "1 failure + explicit user note" as strong, so a user-note-
// backed strong proposal was wrongly rejected by the 2-event gate. The
// relaxation now honors explicit user_notes as an OR with judge analysis.
describe('validateProposalQuality — user-note strong for two-event relations (FIX 4)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedGraph();
  });

  it('prerequisite with 1 failure + explicit user note passes (NOT rejected for <2 events)', async () => {
    // Single in-window failure, no agent judge — its cause is a user_cause with a
    // non-empty user note (§4.2 "1 failure + explicit user note" → strong). The
    // failure references an endpoint (k_zhi) so the order-evidence predicate is
    // satisfied; the two-event relaxation must honor the user note.
    await seedUserCauseFailure('e_un_pre', ['k_zhi'], 1, '我把 k_zhi 当成 k_er 的前置，反复搞混。');
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'prerequisite', {
        reasoning: 'attempt e_un_pre 的 user_cause 说明 k_zhi 是 k_er 的学习前置。',
        evidenceEventIds: ['e_un_pre'],
      }),
      testDb(),
      AGENT,
    );
    expect(v).toEqual({ ok: true });
  });

  it('prerequisite with 1 failure + neither judge analysis nor user note is still rejected', async () => {
    // Single failure whose user_cause carries an EMPTY user_notes and no agent
    // judge analysis → computeEvidenceLevel yields medium (not strong) → rejected
    // at the evidence floor before the relaxation even matters. Confirms the OR
    // does not weaken the floor.
    await seedUserCauseFailure('e_un_empty', ['k_zhi'], 1, '   ');
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'prerequisite', {
        reasoning: 'attempt e_un_empty user_cause 无备注，judge 也没有分析。',
        evidenceEventIds: ['e_un_empty'],
      }),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.gate).toBe('evidence_level');
  });
});

// Codex re-review round 3 (P2, rubric-validator.ts:220) — the §4.3 single-event
// relaxation ("prerequisite / contrasts_with need 2 events UNLESS one has
// explicit judge analysis") was DEAD for a single judge-backed event. A single
// in-window judge-backed failure with non-empty judge analysis_md is `medium`
// per §4.2, so the RB-4 evidence floor rejected it at `evidence_level` BEFORE
// the relaxation could run → every single-judge-event prerequisite /
// contrasts_with proposal was wrongly folded. The fix rescues `medium` → pass
// for these two relations ONLY when an explicit-analysis single event (judge
// analysis_md OR user_cause.user_notes) references an endpoint. It does NOT
// change computeEvidenceLevel's leveling (the event stays medium) and does NOT
// loosen other relations.
describe('validateProposalQuality — single judge-analysis event rescue (codex P2 r3)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedGraph();
  });

  it('(a) prerequisite with 1 judge-analysis (analysis_md) failure referencing an endpoint PASSES', async () => {
    // Single in-window judge-backed failure with explicit judge analysis_md
    // (seedEvidence writes a non-empty analysis_md) referencing endpoint k_zhi.
    // Pre-fix this was medium → rejected at the floor before the relaxation; now
    // the relation-scoped, explicit-analysis-gated rescue lets it through, and
    // the prerequisite order-evidence predicate (references an endpoint) passes.
    await seedEvidence('e_pre_solo', ['k_zhi'], 1);
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'prerequisite', {
        reasoning: 'attempt e_pre_solo 的 judge cause concept 分析 k_zhi 是 k_er 的学习前置。',
        evidenceEventIds: ['e_pre_solo'],
      }),
      testDb(),
      AGENT,
    );
    expect(v).toEqual({ ok: true });
  });

  it('(b) contrasts_with with 1 user-note failure referencing both endpoints PASSES', async () => {
    // 1 failure + explicit user note is §4.2-strong, AND references BOTH
    // endpoints → confusion predicate satisfied. Keeps FIX 4 intact across the
    // floor reorder.
    await seedUserCauseFailure(
      'e_cw_un',
      ['k_zhi', 'k_er'],
      1,
      '我把 k_zhi 和 k_er 的用法搞混，反复在同一题上错。',
    );
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'contrasts_with', {
        reasoning: 'attempt e_cw_un 的 user_cause 说明用户混淆 k_zhi 与 k_er。',
        evidenceEventIds: ['e_cw_un'],
      }),
      testDb(),
      AGENT,
    );
    expect(v).toEqual({ ok: true });
  });

  it('(c) prerequisite with 1 PLAIN failure (no judge analysis, no user note) is STILL rejected', async () => {
    // Single judge-backed failure whose judge cause has an EMPTY analysis_md and
    // no user_cause → medium, no explicit-analysis basis → the rescue does NOT
    // fire → rejected at the evidence floor. Endpoint is referenced, proving the
    // rejection is the floor (not the relation gate).
    await seedPlainJudgeFailure('e_pre_plain', ['k_zhi'], 1);
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'prerequisite', {
        reasoning: 'attempt e_pre_plain judge cause concept，但无分析正文。',
        evidenceEventIds: ['e_pre_plain'],
      }),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.gate).toBe('evidence_level');
  });

  it('(d) related_to with 1 judge-analysis event is STILL rejected (rescue is relation-scoped, no loosening)', async () => {
    // KEY anti-regression test. The SAME single judge-analysis event that
    // rescues prerequisite in (a) must NOT rescue related_to: the relaxation is
    // relation-scoped to prerequisite / contrasts_with. related_to with one judge
    // event stays medium and is rejected at the evidence floor. This proves
    // computeEvidenceLevel was NOT mis-leveled to strong (codex option A) — if it
    // had been, this related_to would wrongly pass.
    await seedEvidence('e_rt_solo', ['k_zhi', 'k_er'], 1);
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'related_to', {
        reasoning: 'attempt e_rt_solo judge cause concept on k_zhi/k_er。',
        evidenceEventIds: ['e_rt_solo'],
      }),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.gate).toBe('evidence_level');
  });

  it('(d-applied_in) applied_in with 1 judge-analysis event is STILL rejected', async () => {
    // Second relation-scope guard: applied_in also keeps rejecting a single
    // judge-analysis event at the floor.
    await seedEvidence('e_ai_solo', ['k_zhi', 'k_er'], 1);
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'applied_in', {
        reasoning: 'attempt e_ai_solo judge cause method on k_zhi/k_er。',
        evidenceEventIds: ['e_ai_solo'],
      }),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.gate).toBe('evidence_level');
  });

  it('(e) 2-same-pattern strong path still passes for related_to (unchanged)', async () => {
    // The strong path is untouched by the floor reorder: two same-pattern
    // (shared cause + shared endpoint) failures → strong → passes for a relation
    // that is NOT prerequisite/contrasts_with.
    await seedEvidence('e_e_1', ['k_zhi'], 1, 'concept');
    await seedEvidence('e_e_2', ['k_zhi'], 2, 'concept');
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'related_to', {
        reasoning: 'attempt e_e_1/e_e_2 judge cause 均为 concept，集中在 k_zhi。',
        evidenceEventIds: ['e_e_1', 'e_e_2'],
      }),
      testDb(),
      AGENT,
    );
    expect(v).toEqual({ ok: true });
  });
});

describe('validateProposalQuality — agent vs user (RB-3)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedGraph();
  });

  it('user-edited proposal passes structural-only; same proposal fails as agent', async () => {
    // An evidence-free related_to edge between two same-subject, non-ancestor
    // nodes: structurally valid (G1–G6) but fails the agent evidence floor.
    const payload = edgePayload('k_zhi', 'k_er', 'related_to', {
      reasoning: '二者相关', // generic, but user path skips reasoning-depth too
      evidenceEventIds: [],
    });

    const asUser = await validateProposalQuality(payload, testDb(), {
      isAgent: false,
      actorRef: 'user:self',
    });
    expect(asUser).toEqual({ ok: true });

    const asAgent = await validateProposalQuality(payload, testDb(), AGENT);
    expect(asAgent.ok).toBe(false);
  });
});

// Codex re-review round 4 (P2 #3, rubric-validator.ts:~238-282) — the endpoint /
// confusion / same-pattern checks read ONLY attempt.referenced_knowledge_ids.
// But the judge exposes its own referenced_knowledge_ids (what it pointed at when
// grading). A prerequisite / contrasts_with / applied_in / derived_from proposal
// whose JUDGE references an endpoint (while the attempt's own refs are empty /
// stale) was wrongly folded as no-endpoint / no-confusion evidence. The fix
// merges attempt ∪ judge refs everywhere those refs are read for evidence
// touching/overlap. Strictly ADDITIVE — the endpoint requirement must still be
// MET, just now also satisfiable via judge refs; leveling / relation-scoping
// unchanged.
describe('validateProposalQuality — judge-referenced endpoints count as evidence (codex r4 P2 #3)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedGraph();
  });

  it('(a) prerequisite whose attempt refs are EMPTY but whose JUDGE references an endpoint now PASSES', async () => {
    // Single in-window judge-backed failure with explicit judge analysis_md →
    // medium + explicit basis → the prerequisite rescue fires. The attempt's own
    // refs are EMPTY, but the judge references endpoint k_zhi. Pre-fix the
    // order-evidence predicate read only the (empty) attempt refs → folded as
    // prerequisite_no_order_evidence; now the effective union counts the judge ref.
    await seedDivergentRefsFailure('e_pre_judge', [], ['k_zhi'], 1);
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'prerequisite', {
        reasoning:
          'attempt e_pre_judge 的 judge 在评分时指向 k_zhi，说明 k_zhi 是 k_er 的学习前置。',
        evidenceEventIds: ['e_pre_judge'],
      }),
      testDb(),
      AGENT,
    );
    expect(v).toEqual({ ok: true });
  });

  it('(b) contrasts_with confusion satisfiable via JUDGE refs touching BOTH endpoints PASSES', async () => {
    // Single failure, judge analysis present (rescue fires for contrasts_with).
    // Attempt refs touch only k_zhi; the JUDGE references BOTH k_zhi and k_er →
    // effective union references both endpoints → confusion predicate satisfied.
    // Pre-fix referencingBoth read only attempt refs (k_zhi only) → folded as
    // contrasts_with_no_confusion.
    await seedDivergentRefsFailure('e_cw_judge', ['k_zhi'], ['k_zhi', 'k_er'], 1);
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'contrasts_with', {
        reasoning: 'attempt e_cw_judge 的 judge 在评分时同时指向 k_zhi 与 k_er，说明二者被混淆。',
        evidenceEventIds: ['e_cw_judge'],
      }),
      testDb(),
      AGENT,
    );
    expect(v).toEqual({ ok: true });
  });

  it('(c) proposal where NEITHER attempt NOR judge refs touch an endpoint is STILL rejected (no loosening)', async () => {
    // Anti-regression: two same-pattern (shared cause) failures whose attempt AND
    // judge refs both reference an unrelated node only (k_other) → strong floor
    // passes, but neither axis touches an endpoint → derived_from default gate
    // still rejects. Proves the union is additive, not a blanket pass.
    await testDb()
      .insert(knowledge)
      .values([
        {
          id: 'k_other',
          name: '其它',
          domain: null,
          parent_id: 'k_wenyan',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);
    await seedDivergentRefsFailure('e_none_1', ['k_other'], ['k_other'], 1, 'concept');
    await seedDivergentRefsFailure('e_none_2', ['k_other'], ['k_other'], 2, 'concept');
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'derived_from', {
        reasoning: 'attempt e_none judge cause concept，但 attempt 与 judge 都只指向 k_other。',
        evidenceEventIds: ['e_none_1', 'e_none_2'],
      }),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.gate).toBe('derived_from_no_endpoint_evidence');
  });
});

// P5.4-L2 / YUK-174 (Facet B / B1) — the OPTIONAL adaptive gate input. The bump
// is tighten-only / never-lock / cold-start no-op (§3.4). It applies ONLY by
// suppressing the §4.2 explicit-single-event rescue for prerequisite /
// contrasts_with when `tightenMediumToStrong === true`.
describe('validateProposalQuality — adaptive gate bump (Facet B / B1)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedGraph();
  });

  const TIGHTEN = {
    tightenMediumToStrong: true as const,
    acceptanceRate: 0.1,
    sampleCount: 12,
    threshold: 0.3,
  };
  const NO_TIGHTEN = { tightenMediumToStrong: false as const };

  it('B1 tighten: a single-judge-analysis prerequisite that PASSES pure L1 now rejects (evidence_level)', async () => {
    // Same fixture as the "single judge-analysis event rescue (a)" pass case:
    // 1 in-window judge-analysis failure referencing endpoint k_zhi → medium +
    // rescue → pure L1 PASSES. With the adaptive bump the rescue is suppressed.
    await seedEvidence('e_b1_pre', ['k_zhi'], 1);
    const payload = edgePayload('k_zhi', 'k_er', 'prerequisite', {
      reasoning: 'attempt e_b1_pre 的 judge cause concept 分析 k_zhi 是 k_er 的学习前置。',
      evidenceEventIds: ['e_b1_pre'],
    });

    // Pure L1 (no adaptive) → passes.
    expect(await validateProposalQuality(payload, testDb(), AGENT)).toEqual({ ok: true });

    // Adaptive tighten → rejects at the evidence floor, gate unchanged.
    const tightened = await validateProposalQuality(payload, testDb(), AGENT, TIGHTEN);
    expect(tightened.ok).toBe(false);
    if (!tightened.ok) {
      expect(tightened.gate).toBe('evidence_level');
      // Traceability (§8 / codex#2): reason cites the carried rate / threshold /
      // sample without re-reading the signal.
      expect(tightened.reason).toContain('adaptive');
      expect(tightened.reason).toContain('0.10');
      expect(tightened.reason).toContain('0.30');
      expect(tightened.reason).toContain('12');
    }
  });

  it('cold-start / no-tighten input behaves exactly like pure L1 (rescue intact)', async () => {
    await seedEvidence('e_nt_pre', ['k_zhi'], 1);
    const payload = edgePayload('k_zhi', 'k_er', 'prerequisite', {
      reasoning: 'attempt e_nt_pre 的 judge cause concept 分析 k_zhi 是 k_er 的学习前置。',
      evidenceEventIds: ['e_nt_pre'],
    });
    // tightenMediumToStrong: false → identical to omitting the arg.
    expect(await validateProposalQuality(payload, testDb(), AGENT, NO_TIGHTEN)).toEqual({
      ok: true,
    });
    expect(await validateProposalQuality(payload, testDb(), AGENT)).toEqual({ ok: true });
  });

  it('never locks: strong evidence still PASSES under tighten (bump cannot block strong)', async () => {
    // Two same-pattern in-window judge-backed failures referencing endpoint
    // k_zhi → strong floor + order evidence → passes. The bump only touches the
    // medium/rescue branch, so strong is unaffected.
    await seedEvidence('e_strong_1', ['k_zhi'], 1, 'concept');
    await seedEvidence('e_strong_2', ['k_zhi'], 2, 'concept');
    const payload = edgePayload('k_zhi', 'k_er', 'prerequisite', {
      reasoning: 'attempt e_strong_1/e_strong_2 judge cause concept，集中在 k_zhi。',
      evidenceEventIds: ['e_strong_1', 'e_strong_2'],
    });
    expect(await validateProposalQuality(payload, testDb(), AGENT, TIGHTEN)).toEqual({ ok: true });
  });

  it('additive invariant: any adaptive input on an L1-reject still rejects the SAME hard gate', async () => {
    // G1 self_edge — a structural reject that the bump never touches.
    const selfEdge = edgePayload('k_zhi', 'k_zhi', 'related_to');
    for (const adaptive of [undefined, NO_TIGHTEN, TIGHTEN]) {
      const v = await validateProposalQuality(selfEdge, testDb(), AGENT, adaptive);
      expect(v).toEqual({ ok: false, gate: 'self_edge', reason: expect.any(String) });
    }

    // evidence_level — a single medium related_to event rejects regardless of the
    // bump (the bump only suppresses the prerequisite/contrasts_with rescue, and
    // related_to has no rescue, so the gate is identical with or without it).
    await seedEvidence('e_inv_solo', ['k_zhi', 'k_er'], 1);
    const mediumRelated = edgePayload('k_zhi', 'k_er', 'related_to', {
      reasoning: 'attempt e_inv_solo judge cause concept on k_zhi/k_er。',
      evidenceEventIds: ['e_inv_solo'],
    });
    for (const adaptive of [undefined, NO_TIGHTEN, TIGHTEN]) {
      const v = await validateProposalQuality(mediumRelated, testDb(), AGENT, adaptive);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.gate).toBe('evidence_level');
    }

    // contrasts_with_no_confusion — a RELATION gate reached only on strong evidence
    // (so the medium/rescue bump never enters its path). Two strong events both
    // referencing only k_zhi pass the floor but fail the confusion predicate; the
    // gate must be identical with or without any adaptive input (widens the invariant
    // beyond structural + floor rejects).
    await seedEvidence('e_inv_conf_1', ['k_zhi'], 1);
    await seedEvidence('e_inv_conf_2', ['k_zhi'], 2);
    const contrastsNoConfusion = edgePayload('k_zhi', 'k_er', 'contrasts_with', {
      reasoning: 'attempt e_inv_conf judge cause concept on k_zhi。',
      evidenceEventIds: ['e_inv_conf_1', 'e_inv_conf_2'],
    });
    for (const adaptive of [undefined, NO_TIGHTEN, TIGHTEN]) {
      const v = await validateProposalQuality(contrastsNoConfusion, testDb(), AGENT, adaptive);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.gate).toBe('contrasts_with_no_confusion');
    }
  });

  it('tighten does not fire on relations without the single-event rescue (related_to stays rejected via floor, no adaptive reason)', async () => {
    // related_to with one medium event was ALREADY rejected by pure L1 (no
    // rescue). The bump must not turn this into an adaptive-annotated reject — it
    // only suppresses the prerequisite/contrasts_with rescue. Gate stays
    // evidence_level; the reason is the plain (non-adaptive) floor message.
    await seedEvidence('e_rel_floor', ['k_zhi', 'k_er'], 1);
    const payload = edgePayload('k_zhi', 'k_er', 'related_to', {
      reasoning: 'attempt e_rel_floor judge cause concept on k_zhi/k_er。',
      evidenceEventIds: ['e_rel_floor'],
    });
    const v = await validateProposalQuality(payload, testDb(), AGENT, TIGHTEN);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.gate).toBe('evidence_level');
      expect(v.reason).not.toContain('adaptive');
    }
  });

  it.each(['prerequisite', 'contrasts_with'] as const)(
    'C5: TWO UNRELATED medium events (one with explicit analysis) do NOT take the single-event rescue (%s rejects at floor)',
    async (relation) => {
      // computeEvidenceLevel returns `medium` for 2+ UNRELATED judge-backed
      // failures (no same-pattern pair). These two diverge on BOTH axes — distinct
      // cause categories (concept vs memory) AND non-overlapping referenced
      // knowledge (k_zhi vs k_er) — so they are medium, not strong. Both carry
      // explicit judge analysis (seedEvidence's non-empty analysis_md), so
      // hasExplicitSingleEventBasis is true. The §4.3 relaxation is a SINGLE-event
      // exception (usable.length === 1); these TWO events must NOT be rescued and
      // must reject at the evidence floor regardless of the adaptive input.
      await seedEvidence('e_c5_a', ['k_zhi'], 1, 'concept');
      await seedEvidence('e_c5_b', ['k_er'], 2, 'memory');
      const payload = edgePayload('k_zhi', 'k_er', relation, {
        reasoning:
          'attempt e_c5_a judge cause concept 指向 k_zhi，attempt e_c5_b judge cause memory 指向 k_er，两者分析都明确但模式不同。',
        evidenceEventIds: ['e_c5_a', 'e_c5_b'],
      });

      // Both pure L1 (no adaptive) and adaptive TIGHTEN must reject at the floor:
      // the rescue never applies (length 2), so the bump has nothing to suppress.
      for (const adaptive of [undefined, TIGHTEN]) {
        const v = await validateProposalQuality(payload, testDb(), AGENT, adaptive);
        expect(v.ok).toBe(false);
        if (!v.ok) {
          expect(v.gate).toBe('evidence_level');
          // Reached the plain floor message — NO adaptive annotation, because the
          // rescue basis was false (length 2), so the bump never removed a rescue.
          expect(v.reason).not.toContain('adaptive');
        }
      }
    },
  );
});

describe('RubricGate type is referenced', () => {
  it('compiles a gate assignment', () => {
    const g: RubricGate = 'evidence_level';
    expect(g).toBe('evidence_level');
  });
});
