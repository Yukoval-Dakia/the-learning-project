// YUK-1053 — 学习结算集成 DB 测试（db 分区；testcontainer + resetDb）。
//
// 覆盖 acceptance criteria 的可执行面：
//   - D13：全对/全错 ⇒ per-KC obs + 恰好一次共享 θ̂ update；partial/mixed ⇒
//     abstain；blank_marked_zero 不当全部 KC failure；总分只读 aggregate 一次；
//   - D14：三等级评级落 FSRS（correct→good / partial→hard / incorrect→again；
//     unsupported ⇒ 不结算）；
//   - D15：manual/self_report ⇒ 只写 FSRS，不写 θ̂（无 self-report θ̂）；
//   - D16：assisted ⇒ FSRS 评级保留，θ̂/calibration 排除；
//   - regrade 不算额外练习：替换 activation revert 原结算后再落位，
//     evidence_count 不凭空 +1；
//   - 有序 replay：更晚到的早期证据 revert 重叠结算 → 本结算落位 → 原
//     occurrence 顺序重放；非结算 writer 的更晚痕迹 ⇒ replay_required；
//   - 用户评级守卫：manual provenance 的评级不被 judge 纠正在本层覆盖；
//   - advisory lock：per-KC `fsrs:knowledge:<id>` 与 `mastery:ability_global:
//     <domain>` xact 锁在同事务内可观测。

import { and, eq, inArray, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  evaluation_group,
  event,
  knowledge,
  mastery_state,
  material_fsrs_state,
  question,
} from '@/db/schema';
import {
  type NormalizableQuestionRow,
  type PartRow,
  normalizeQuestionGroupToContract,
  normalizeQuestionRowToContract,
} from '@/server/questions/contract-normalizer';
import { publishQuestionGroup } from '@/server/questions/publisher';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { activateEvaluation, insertInitialEvaluationHead } from './activate';
import { ASSESSMENT_SETTLEMENT_ACTION, learningSettlement } from './settle';

const NOW = new Date('2026-09-26T00:00:00Z');
const ADMITTED_EVIDENCE = {
  marking_provenance: 'official' as const,
  verification: { structural_check_passed: true, independent_verification: null },
  model_slice: null,
};

async function seedKnowledge(id: string, opts: { parentId?: string; domain?: string } = {}) {
  const db = testDb();
  await db.insert(knowledge).values({
    id,
    name: id,
    domain: opts.parentId ? null : (opts.domain ?? null),
    parent_id: opts.parentId ?? null,
    approval_status: 'approved',
    proposed_by_ai: false,
    created_at: NOW,
    updated_at: NOW,
    version: 0,
  });
}

interface SeedQuestionOpts {
  kcs?: string[];
  difficulty?: number;
}

async function seedQuestionRow(id: string, opts: SeedQuestionOpts & { parentId?: string } = {}) {
  const db = testDb();
  await db.insert(question).values({
    id,
    kind: 'choice',
    prompt_md: `题面 ${id}`,
    reference_md: 'B',
    knowledge_ids: opts.kcs ?? [],
    difficulty: opts.difficulty ?? 3,
    source: 'web_sourced',
    variant_depth: 0,
    choices_md: ['甲', '乙', '丙'],
    ...(opts.parentId ? { parent_question_id: opts.parentId, part_index: 0 } : {}),
    created_at: NOW,
    updated_at: NOW,
    version: 0,
  });
}

async function publishAdmittedForGroup(qid: string) {
  const db = testDb();
  const [row] = await db.select().from(question).where(eq(question.id, qid)).limit(1);
  const n = normalizeQuestionRowToContract(row as NormalizableQuestionRow);
  const result = await publishQuestionGroup(db, {
    group_id: n.group_id,
    contract: {
      structure: n.structure,
      response_spec: n.response_spec,
      scoring_basis: n.scoring_basis,
      execution_plan: n.execution_plan,
      integrity_digest: n.integrity_digest,
    },
    expectedCurrentRevision: null,
    expectedAdmissionGeneration: null,
    availability: 'general_pool',
    admission: { state: 'admitted', evidence: ADMITTED_EVIDENCE },
    actorRef: 'test:publish',
    now: NOW,
  });
  if (result.status !== 'published') throw new Error(`seed publish: ${result.status}`);
  return { revisionId: result.revision_id };
}

interface SeedIds {
  qid: string;
  revisionId: string;
  issuanceId: string;
  groupId: string;
  submissionId: string;
}

/** 单 submission group + head 同事务（§11 原子不变量）。 */
async function seedChain(
  prefix: string,
  opts: { kcs?: string[]; submittedAt?: Date } = {},
): Promise<SeedIds> {
  const db = testDb();
  const qid = `${prefix}_q`;
  const issuanceId = `${prefix}_iss`;
  const groupId = `${prefix}_grp`;
  const submissionId = `${prefix}_sub`;
  const submittedAt = opts.submittedAt ?? NOW;
  await seedQuestionRow(qid, { kcs: opts.kcs });
  const { revisionId } = await publishAdmittedForGroup(qid);
  await db.insert(assessment_issuance).values({
    issuance_id: issuanceId,
    revision_id: revisionId,
    part_ids: [],
    material_bindings: [],
    option_order: [],
    claim_policy: 'one_time',
    claim_status: 'claimed',
    claimed_by_ref: 'occ_1',
    issued_at: NOW,
  });
  await db.transaction(async (tx) => {
    await tx.insert(evaluation_group).values({
      evaluation_group_id: groupId,
      submission_ids: [submissionId],
      created_at: NOW,
    });
    await tx.insert(assessment_submission).values({
      submission_id: submissionId,
      issuance_id: issuanceId,
      revision_id: revisionId,
      evaluation_group_id: groupId,
      response_set: { entries: [] },
      group_evidence: [],
      idempotency_key: `${prefix}_idem`,
      submitted_at: submittedAt,
    });
    await insertInitialEvaluationHead(tx, {
      evaluation_group_id: groupId,
      submission_id: submissionId,
      now: submittedAt,
    });
  });
  return { qid, revisionId, issuanceId, groupId, submissionId };
}

interface EvalOpts {
  unitResults?: unknown[];
  aggregate?: unknown;
  provenance?: Record<string, unknown>;
  attempt?: number;
}

async function seedEvaluation(seed: SeedIds, evalId: string, opts: EvalOpts = {}) {
  const db = testDb();
  await db.insert(evaluation).values({
    evaluation_id: evalId,
    evaluation_group_id: seed.groupId,
    submission_id: seed.submissionId,
    attempt: opts.attempt ?? 1,
    status: 'completed',
    unit_results: (opts.unitResults as never) ?? [],
    aggregate: (opts.aggregate as never) ?? {
      kind: 'points_total',
      points: 1,
      policy: { kind: 'sum' },
    },
    plan_digest: null,
    run_refs: [],
    provenance: opts.provenance ?? { source: 'automatic', assisted: false },
    created_at: NOW,
  });
}

function unitResult(unitId: string, points: number, scoredBecause = 'response') {
  return {
    status: 'scored',
    scoring_unit_id: unitId,
    points_awarded: points,
    scored_because: scoredBecause,
  };
}

async function activate(
  evalId: string,
  expected: { effectiveId: string | null; generation: number },
  now?: Date,
) {
  const db = testDb();
  return db.transaction((tx) =>
    activateEvaluation(
      tx,
      {
        evaluation_id: evalId,
        expected_effective_id: expected.effectiveId,
        expected_generation: expected.generation,
      },
      { settle: learningSettlement, actorRef: 'test', now: now ?? NOW },
    ),
  );
}

async function fsrsRow(_kind: 'knowledge' | 'question', id: string) {
  const db = testDb();
  const [row] = await db
    .select()
    .from(material_fsrs_state)
    .where(eq(material_fsrs_state.subject_id, id));
  return row;
}

async function masteryRow(id: string, _kind = 'knowledge') {
  const db = testDb();
  const [row] = await db.select().from(mastery_state).where(eq(mastery_state.subject_id, id));
  return row;
}

async function settlementEvents(groupId?: string) {
  const db = testDb();
  const rows = await db.select().from(event).where(eq(event.action, ASSESSMENT_SETTLEMENT_ACTION));
  return groupId
    ? rows.filter(
        (r) => (r.payload as { evaluation_group_id?: string }).evaluation_group_id === groupId,
      )
    : rows;
}

describe('learningSettlement（YUK-1053 D13–D16 + replay）', () => {
  beforeEach(resetDb);

  it('首次激活全对单 KC：FSRS good 卡 + θ̂ success 一次（bounded adapter 恰一次）+ snapshot brackets', async () => {
    const db = testDb();
    await seedKnowledge('kc_a', { domain: 'dom_x' });
    const seed = await seedChain('s1', { kcs: ['kc_a'] });
    const unitId = `${seed.qid}::u`;
    await seedEvaluation(seed, 's1_ev1', {
      unitResults: [unitResult(unitId, 1)],
    });

    const result = await activate('s1_ev1', { effectiveId: null, generation: 0 });
    expect(result).toEqual({ status: 'activated', effect: 'applied', generation: 1 });

    const fsrs = await fsrsRow('knowledge', 'kc_a');
    expect(fsrs).toBeTruthy();
    expect(fsrs?.subject_kind).toBe('knowledge');
    expect(fsrs?.state?.reps).toBe(1);
    const settleEvent = (await settlementEvents(seed.groupId)).find(
      (e) => (e.payload as { effect?: string }).effect === 'applied',
    );
    expect(settleEvent).toBeTruthy();
    expect(fsrs?.last_review_event_id).toBe(settleEvent?.id);

    const m = await masteryRow('kc_a');
    expect(m).toBeTruthy();
    expect(m?.evidence_count).toBe(1);
    expect(m?.success_count).toBe(1);
    expect(m?.fail_count).toBe(0);
    // occurrence 时点（submitted_at）写入 —— last_outcome_at = NOW。
    expect(new Date(m?.last_outcome_at ?? 0).toISOString()).toBe(NOW.toISOString());

    // ability_global 行（hierarchical flag ON）：dom_x 也挪一次。
    const g = await masteryRow('dom_x', 'ability_global');
    expect(g).toBeTruthy();
    expect(g?.subject_kind).toBe('ability_global');
    expect(g?.evidence_count).toBe(1);

    // snapshot brackets 存在（replay/纠错机械基础）。
    const bracketEvents = (await db.select().from(event)).filter(
      (e) =>
        e.id === `${settleEvent?.id}:checkpoint:theta` ||
        e.id === `${settleEvent?.id}:checkpoint:fsrs`,
    );
    expect(bracketEvents).toHaveLength(2);
  });

  it('partial verdict：FSRS hard 评级落位，per-KC partial ⇒ θ̂ abstain（partial→1 已 REJECTED）', async () => {
    await seedKnowledge('kc_a', { domain: 'dom_x' });
    const seed = await seedChain('s2', { kcs: ['kc_a'] });
    const unitId = `${seed.qid}::u`;
    await seedEvaluation(seed, 's2_ev1', {
      // 发布 unit points=1；判 0.5 → normalized 0.5 ⇒ partial。
      unitResults: [unitResult(unitId, 0.5)],
      aggregate: { kind: 'points_total', points: 0.5, policy: { kind: 'sum' } },
    });

    const result = await activate('s2_ev1', { effectiveId: null, generation: 0 });
    expect(result.status).toBe('activated');
    expect((result as { effect: string }).effect).toBe('applied');

    const fsrs = await fsrsRow('knowledge', 'kc_a');
    expect(fsrs?.state?.reps).toBe(1);
    // θ̂ abstain：该 KC 不产生 mastery obs。
    expect(await masteryRow('kc_a')).toBeUndefined();
    const se = (await settlementEvents(seed.groupId))[0] as {
      payload: { theta_decision?: { applied?: boolean; abstainReason?: string } };
    };
    const theta = se.payload.theta_decision;
    expect(theta?.applied).toBe(false);
    expect(theta?.abstainReason).toBe('no_kc_evidence');
  });

  it('blank_marked_zero：分数计零（incorrect→again 卡），但 KC 无 mastery 票（空白≠全 KC failure）', async () => {
    await seedKnowledge('kc_a', { domain: 'dom_x' });
    const seed = await seedChain('s3', { kcs: ['kc_a'] });
    const unitId = `${seed.qid}::u`;
    await seedEvaluation(seed, 's3_ev1', {
      unitResults: [unitResult(unitId, 0, 'blank_marked_zero')],
      aggregate: { kind: 'points_total', points: 0, policy: { kind: 'sum' } },
    });

    const result = await activate('s3_ev1', { effectiveId: null, generation: 0 });
    expect((result as { effect: string }).effect).toBe('applied');
    expect((await fsrsRow('knowledge', 'kc_a'))?.state?.reps).toBe(1);
    expect(await masteryRow('kc_a')).toBeUndefined();
    const obs = ((
      (await settlementEvents(seed.groupId))[0] as {
        payload: { kc_observations?: { bit?: unknown }[] };
      }
    ).payload.kc_observations ?? [])[0];
    expect(obs?.bit).toBe('abstain');
  });

  it('D16 assisted：评级保留（FSRS 落位），θ̂/family/calibration 全排除', async () => {
    await seedKnowledge('kc_a', { domain: 'dom_x' });
    const seed = await seedChain('s4', { kcs: ['kc_a'] });
    const unitId = `${seed.qid}::u`;
    await seedEvaluation(seed, 's4_ev1', {
      unitResults: [unitResult(unitId, 1)],
      provenance: { source: 'automatic', assisted: true },
    });

    const result = await activate('s4_ev1', { effectiveId: null, generation: 0 });
    expect((result as { effect: string }).effect).toBe('applied');
    expect((await fsrsRow('knowledge', 'kc_a'))?.state?.reps).toBe(1);
    expect(await masteryRow('kc_a')).toBeUndefined();
    const theta = (
      (await settlementEvents(seed.groupId))[0] as {
        payload: { theta_decision?: { abstainReason?: string } };
      }
    ).payload.theta_decision;
    expect(theta?.abstainReason).toBe('provenance_excluded');
  });

  it('D15 manual/self_report：只写 FSRS，θ̂ 不写（无 self-report θ̂）', async () => {
    await seedKnowledge('kc_a', { domain: 'dom_x' });
    const seed = await seedChain('s5', { kcs: ['kc_a'] });
    const unitId = `${seed.qid}::u`;
    await seedEvaluation(seed, 's5_ev1', {
      unitResults: [unitResult(unitId, 1)],
      provenance: { source: 'manual', assisted: false },
    });

    await activate('s5_ev1', { effectiveId: null, generation: 0 });
    expect((await fsrsRow('knowledge', 'kc_a'))?.state?.reps).toBe(1);
    expect(await masteryRow('kc_a')).toBeUndefined();
    const payload = (await settlementEvents(seed.groupId))[0]?.payload as {
      rating_source?: string;
    };
    expect(payload.rating_source).toBe('user');
  });

  it('unsupported verdict ⇒ ineligible：不写任何学习态，receipt 如实记', async () => {
    await seedKnowledge('kc_a', { domain: 'dom_x' });
    const seed = await seedChain('s6', { kcs: ['kc_a'] });
    await seedEvaluation(seed, 's6_ev1', {
      aggregate: { kind: 'unresolved', reason: 'pending_units', detail: 'u pending' },
    });

    const result = await activate('s6_ev1', { effectiveId: null, generation: 0 });
    expect((result as { effect: string }).effect).toBe('ineligible');
    expect(await fsrsRow('knowledge', 'kc_a')).toBeUndefined();
    expect(await masteryRow('kc_a')).toBeUndefined();
  });

  it('regrade 不算额外练习：revert 原结算 + 新 verdict 落位；θ̂ 位翻转、计数不加', async () => {
    await seedKnowledge('kc_a', { domain: 'dom_x' });
    const seed = await seedChain('s7', { kcs: ['kc_a'] });
    const unitId = `${seed.qid}::u`;
    await seedEvaluation(seed, 's7_ev1', {
      attempt: 1,
      unitResults: [unitResult(unitId, 1)],
    });
    await activate('s7_ev1', { effectiveId: null, generation: 0 });
    const m1 = await masteryRow('kc_a');
    expect(m1?.evidence_count).toBe(1);
    expect(m1?.success_count).toBe(1);

    // regrade：全对 → 全错（attempt 2，同一 submission，不算新作答）。
    await seedEvaluation(seed, 's7_ev2', {
      attempt: 2,
      unitResults: [unitResult(unitId, 0)],
      aggregate: { kind: 'points_total', points: 0, policy: { kind: 'sum' } },
    });
    const replaced = await activate('s7_ev2', { effectiveId: 's7_ev1', generation: 1 });
    expect(replaced.status).toBe('activated');

    const m2 = await masteryRow('kc_a');
    // 原 success obs 被 revert，failure obs 落位：evidence=1（不 +1）、fail=1、success=0。
    expect(m2?.evidence_count).toBe(1);
    expect(m2?.success_count).toBe(0);
    expect(m2?.fail_count).toBe(1);

    const fsrs = await fsrsRow('knowledge', 'kc_a');
    // FSRS：revert 到 cold-start（ev1 的 before=null ⇒ 删行）再落新卡 ⇒ reps=1。
    expect(fsrs?.state?.reps).toBe(1);

    // 原结算事件被 supersedes 标记（dead）；新事件的 supersedes 面显式。
    const events = await settlementEvents(seed.groupId);
    const appliedEvents = events.filter(
      (e) => (e.payload as { effect?: string }).effect === 'applied',
    );
    expect(appliedEvents).toHaveLength(2);
    const newEv = appliedEvents.find(
      (e) => (e.payload as { evaluation_id?: string }).evaluation_id === 's7_ev2',
    );
    const oldEv = appliedEvents.find(
      (e) => (e.payload as { evaluation_id?: string }).evaluation_id === 's7_ev1',
    );
    const newPayload = newEv?.payload as {
      supersedes_settlement_event_id?: string;
      reverted_settlement_event_ids?: string[];
    };
    expect(newPayload.supersedes_settlement_event_id).toBe(oldEv?.id);
    expect(newPayload.reverted_settlement_event_ids).toContain(oldEv?.id);
  });

  it('有序 replay：早期证据晚到 ⇒ revert 更晚结算 → 落位 → 原 occurrence 重放', async () => {
    await seedKnowledge('kc_a', { domain: 'dom_x' });
    const t1 = new Date('2026-09-20T00:00:00Z');
    const t2 = new Date('2026-09-21T00:00:00Z');
    // 组 A（t2，晚 occurrence）先结算成功。
    const seedA = await seedChain('sA', { kcs: ['kc_a'], submittedAt: t2 });
    const unitA = `${seedA.qid}::u`;
    await seedEvaluation(seedA, 'evA', {
      unitResults: [unitResult(unitA, 1)],
    });
    await activate('evA', { effectiveId: null, generation: 0 }, t2);
    // 组 B（t1 < t2，早 occurrence）后到 —— 同一 KC。
    const seedB = await seedChain('sB', { kcs: ['kc_a'], submittedAt: t1 });
    const unitB = `${seedB.qid}::u`;
    await seedEvaluation(seedB, 'evB', {
      unitResults: [unitResult(unitB, 1)],
    });

    const result = await activate(
      'evB',
      { effectiveId: null, generation: 0 },
      new Date('2026-09-22T00:00:00Z'),
    );
    expect(result.status).toBe('activated');
    expect((result as { effect: string }).effect).toBe('applied');

    // A 被 revert 后按其原 occurrence 重放：last_review_event_id 指向新 re-apply 事件。
    const fsrs = await fsrsRow('knowledge', 'kc_a');
    const settleA = (await settlementEvents(seedA.groupId))[0];
    const reApplied = (await settlementEvents()).filter(
      (e) => (e.payload as { replay_of?: string }).replay_of === settleA?.id,
    );
    expect(reApplied).toHaveLength(1);
    expect(fsrs?.last_review_event_id).toBe(reApplied[0]?.id);
    // A 的原事件已被标记 dead（在 B 的 reverted 列表内）。
    const bPayload = ((await settlementEvents(seedB.groupId))[0]?.payload ?? {}) as {
      reverted_settlement_event_ids?: string[];
    };
    expect(bPayload.reverted_settlement_event_ids).toContain(settleA?.id);
    // θ̂：B(t1) + A(t2) 两条 success obs ⇒ evidence_count=2（不重放丢增量）。
    const m = await masteryRow('kc_a');
    expect(m?.evidence_count).toBe(2);
    expect(m?.success_count).toBe(2);
    expect(new Date(m?.last_outcome_at ?? 0).toISOString()).toBe(t2.toISOString());
  });

  it('非结算 writer 的更晚痕迹 ⇒ failed_pending + replay_required 事件（不静默追加）', async () => {
    await seedKnowledge('kc_a', { domain: 'dom_x' });
    const t1 = new Date('2026-09-20T00:00:00Z');
    const seed = await seedChain('s8', { kcs: ['kc_a'], submittedAt: t1 });
    const unitId = `${seed.qid}::u`;
    await seedEvaluation(seed, 's8_ev1', {
      unitResults: [unitResult(unitId, 1)],
    });
    // 模拟一个【非结算事件写入】的更晚 FSRS 痕迹（如 legacy path 的 review 落卡）。
    const db = testDb();
    const { initialFsrsState } = await import('@/core/fsrs');
    const init = initialFsrsState(new Date('2026-09-25T00:00:00Z'));
    const { upsertFsrsState } = await import('@/server/fsrs/state');
    await upsertFsrsState(db, {
      subject_kind: 'knowledge',
      subject_id: 'kc_a',
      // last_review > submission occurrence(t1=09-20) ⇒ 有更早证据未结算的更晚写入。
      state: { ...init.state, last_review: new Date('2026-09-25T00:00:00Z') },
      due_at: init.dueAt,
      last_review_event_id: 'evt_legacy_review_1',
    });

    const result = await activate('s8_ev1', { effectiveId: null, generation: 0 });
    expect((result as { effect: string }).effect).toBe('failed_pending');
    const rows = await settlementEvents(seed.groupId);
    expect(rows[0] && (rows[0].payload as { effect?: string }).effect).toBe('replay_required');
  });

  it('用户评级守卫：manual 评级不被 judge 纠正在本层覆盖（FSRS 保持用户评级）', async () => {
    await seedKnowledge('kc_a', { domain: 'dom_x' });
    const seed = await seedChain('s9', { kcs: ['kc_a'] });
    const unitId = `${seed.qid}::u`;
    // ev1：manual provenance（用户确认评级 good）。
    await seedEvaluation(seed, 's9_ev1', {
      attempt: 1,
      unitResults: [unitResult(unitId, 1)],
      provenance: { source: 'manual', assisted: false },
    });
    await activate('s9_ev1', { effectiveId: null, generation: 0 });
    const fsrs1 = await fsrsRow('knowledge', 'kc_a');
    expect(fsrs1?.state?.reps).toBe(1);
    const lastReview1 = fsrs1?.last_review_event_id;

    // ev2：automatic 判 incorrect —— judge 纠正试图覆盖用户评级。
    await seedEvaluation(seed, 's9_ev2', {
      attempt: 2,
      unitResults: [unitResult(unitId, 0)],
      aggregate: { kind: 'points_total', points: 0, policy: { kind: 'sum' } },
      provenance: { source: 'automatic', assisted: false },
    });
    const result = await activate('s9_ev2', { effectiveId: 's9_ev1', generation: 1 });
    expect(result.status).toBe('activated');

    const fsrs2 = await fsrsRow('knowledge', 'kc_a');
    // FSRS 保持用户评级落位后的状态：仍是 ev1 的卡（不 revert、不重排）。
    expect(fsrs2?.state?.reps).toBe(1);
    expect(fsrs2?.last_review_event_id).toBe(lastReview1);
    // θ̂ 独立：automatic 判分证据照常落位（failure obs，evidence=1 —— ev1 manual 本无 θ̂）。
    const m = await masteryRow('kc_a');
    expect(m?.fail_count).toBe(1);
    expect(m?.evidence_count).toBe(1);
  });

  it('advisory lock：per-KC fsrs:knowledge 锁与 ability_global 域锁在同事务内可观测', async () => {
    const db = testDb();
    await seedKnowledge('kc_a', { domain: 'dom_x' });
    const seed = await seedChain('s10', { kcs: ['kc_a'] });
    const unitId = `${seed.qid}::u`;
    await seedEvaluation(seed, 's10_ev1', {
      unitResults: [unitResult(unitId, 1)],
    });

    const locks = await db.transaction(async (tx) => {
      const result = await activateEvaluation(
        tx,
        { evaluation_id: 's10_ev1', expected_effective_id: null, expected_generation: 0 },
        { settle: learningSettlement, actorRef: 'test', now: NOW },
      );
      expect(result.status).toBe('activated');
      // pg_advisory_xact_lock(hashtext(...)) 以 8-byte 单键入锁：objid = int4
      // 的无符号位型（负值 classid=0xFFFFFFFF），故按 objid 对 unsigned hash 比对。
      const rows = await tx.execute<{ objid: number }>(
        sql`SELECT objid FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`,
      );
      return new Set(rows.map((r) => Number(r.objid)));
    });

    const [{ h: kcHash }] = await db.execute<{ h: number }>(
      sql`SELECT hashtext('fsrs:knowledge:kc_a')::oid AS h`,
    );
    const [{ h: globalHash }] = await db.execute<{ h: number }>(
      sql`SELECT hashtext('mastery:ability_global:dom_x')::oid AS h`,
    );
    const [{ h: writeLock }] = await db.execute<{ h: number }>(
      sql`SELECT hashtext('learning-state:write')::oid AS h`,
    );
    expect(locks.has(Number(kcHash))).toBe(true);
    expect(locks.has(Number(globalHash))).toBe(true);
    expect(locks.has(Number(writeLock))).toBe(true);
  });

  it('多 part 混合 KC 位 ⇒ θ̂ abstain(mixed)；各自 per-KC obs 如实记录', async () => {
    const db = testDb();
    // 复合组：root + 两个物理 part（各 1 KC、各 1 单元）。
    await seedKnowledge('kc_a', { domain: 'dom_x' });
    await seedKnowledge('kc_b', { domain: 'dom_x' });
    await seedQuestionRow('mp_q', { kcs: [] });
    await seedQuestionRow('mp_p1', { kcs: ['kc_a'], parentId: 'mp_q' });
    await seedQuestionRow('mp_p2', { kcs: ['kc_b'], parentId: 'mp_q' });
    const [root] = await db.select().from(question).where(eq(question.id, 'mp_q'));
    const [p1] = await db.select().from(question).where(eq(question.id, 'mp_p1'));
    const [p2] = await db.select().from(question).where(eq(question.id, 'mp_p2'));
    const n = normalizeQuestionGroupToContract(root as NormalizableQuestionRow, [
      p1 as PartRow,
      p2 as PartRow,
    ]);
    const pub = await publishQuestionGroup(db, {
      group_id: n.group_id,
      contract: {
        structure: n.structure,
        response_spec: n.response_spec,
        scoring_basis: n.scoring_basis,
        execution_plan: n.execution_plan,
        integrity_digest: n.integrity_digest,
      },
      expectedCurrentRevision: null,
      expectedAdmissionGeneration: null,
      availability: 'general_pool',
      admission: { state: 'admitted', evidence: ADMITTED_EVIDENCE },
      actorRef: 'test:publish',
      now: NOW,
    });
    if (pub.status !== 'published') throw new Error(`publish: ${pub.status}`);
    const groupId = 'mp_grp';
    const submissionId = 'mp_sub';
    const issuanceId = 'mp_iss';
    await db.insert(assessment_issuance).values({
      issuance_id: issuanceId,
      revision_id: pub.revision_id,
      part_ids: ['mp_p1', 'mp_p2'],
      material_bindings: [],
      option_order: [],
      claim_policy: 'one_time',
      claim_status: 'claimed',
      claimed_by_ref: 'occ_1',
      issued_at: NOW,
    });
    await db.transaction(async (tx) => {
      await tx.insert(evaluation_group).values({
        evaluation_group_id: groupId,
        submission_ids: [submissionId],
        created_at: NOW,
      });
      await tx.insert(assessment_submission).values({
        submission_id: submissionId,
        issuance_id: issuanceId,
        revision_id: pub.revision_id,
        evaluation_group_id: groupId,
        response_set: { entries: [] },
        group_evidence: [],
        idempotency_key: 'mp_idem',
        submitted_at: NOW,
      });
      await insertInitialEvaluationHead(tx, {
        evaluation_group_id: groupId,
        submission_id: submissionId,
        now: NOW,
      });
    });
    // p1 全对（kc_a=1）、p2 全错（kc_b=0）—— per-KC 位混合。
    await db.insert(evaluation).values({
      evaluation_id: 'mp_ev1',
      evaluation_group_id: groupId,
      submission_id: submissionId,
      attempt: 1,
      status: 'completed',
      unit_results: [unitResult('mp_p1::u', 1), unitResult('mp_p2::u', 0)] as never,
      aggregate: { kind: 'points_total', points: 1, policy: { kind: 'sum' } } as never,
      plan_digest: null,
      run_refs: [],
      provenance: { source: 'automatic', assisted: false },
      created_at: NOW,
    });

    const result = await activate('mp_ev1', { effectiveId: null, generation: 0 });
    expect(result.status).toBe('activated');

    // per-KC obs：kc_a=1、kc_b=0（局部证据各自成立）……
    const se = (await settlementEvents(groupId))[0] as {
      payload: {
        kc_observations?: { kc_id: string; bit: unknown }[];
        theta_decision?: { applied?: boolean; abstainReason?: string };
      };
    };
    const obs = se.payload.kc_observations ?? [];
    expect(obs.find((o) => o.kc_id === 'kc_a')?.bit).toBe(1);
    expect(obs.find((o) => o.kc_id === 'kc_b')?.bit).toBe(0);
    // ……但 bounded adapter 不能把 mixed 位塞进 one-bit update ⇒ θ̂ 全 abstain。
    const theta = se.payload.theta_decision;
    expect(theta?.applied).toBe(false);
    expect(theta?.abstainReason).toBe('mixed_kc_bits');
    expect(await masteryRow('kc_a')).toBeUndefined();
    expect(await masteryRow('kc_b')).toBeUndefined();
    // FSRS 不受 mixed 位影响：组级 partial ⇒ hard 评级落两张 KC 卡。
    expect((await fsrsRow('knowledge', 'kc_a'))?.state?.reps).toBe(1);
    expect((await fsrsRow('knowledge', 'kc_b'))?.state?.reps).toBe(1);
  });

  // YUK-1054 — replay 付费 fanout 抑制（ticket: 「replay 不重发 models/nudges/
  // memory」）。读侧结构性保证由本测试钉住：
  //   1) replay 路径只写 `experimental:assessment_settlement` 事件——不写任何
  //      attempt/review/judge 事件 ⇒ 订阅链无 refire 入点；
  //   2) 结算事件 ingest_at 预填（writer 传入 activatedAt）⇒ memory outbox 的
  //      `ingest_at IS NULL` 拾取口天然跳过它；
  //   3) actor_kind='system' ⇒ shouldExtractToMemory 的 user 门也过不了。
  it('replay 结算只写 settlement 事件（无 judge/attempt refire）+ ingest_at 预填跳过 memory outbox', async () => {
    await seedKnowledge('kc_a', { domain: 'dom_x' });
    const t1 = new Date('2026-09-20T00:00:00Z');
    const t2 = new Date('2026-09-21T00:00:00Z');
    const seedA = await seedChain('nfA', { kcs: ['kc_a'], submittedAt: t2 });
    const unitA = `${seedA.qid}::u`;
    await seedEvaluation(seedA, 'evA', { unitResults: [unitResult(unitA, 1)] });
    await activate('evA', { effectiveId: null, generation: 0 }, t2);
    const seedB = await seedChain('nfB', { kcs: ['kc_a'], submittedAt: t1 });
    const unitB = `${seedB.qid}::u`;
    await seedEvaluation(seedB, 'evB', { unitResults: [unitResult(unitB, 1)] });

    await activate('evB', { effectiveId: null, generation: 0 }, new Date('2026-09-22T00:00:00Z'));

    // replay 已发生：A 被 revert 后按原 occurrence 重放出一个 replay 结算。
    const all = await settlementEvents();
    expect(
      all.some(
        (e) =>
          (e.payload as { replay_of?: string }).replay_of !== undefined &&
          (e.payload as { replay_of?: string }).replay_of !== null,
      ),
    ).toBe(true);

    // 全链零 attempt/review/judge 事件——replay 不产生任何可订阅的判分/作答行。
    const domainRows = await testDb()
      .select({ id: event.id })
      .from(event)
      .where(and(inArray(event.action, ['attempt', 'review', 'judge'])));
    expect(domainRows).toHaveLength(0);

    // ingest_at 预填 + actor_kind='system'：memory outbox 两道门都关死。
    for (const row of all) {
      expect(row.ingest_at).not.toBeNull();
      expect(row.actor_kind).toBe('system');
    }
  });

  it('YUK-1093 P1-1：θ̂ bracket 含 ability_global 行 —— regrade 后 domain 证据/θ̂ 不双计', async () => {
    const db = testDb();
    await seedKnowledge('kc_a', { domain: 'dom_x' });
    const seed = await seedChain('y1093', { kcs: ['kc_a'] });
    const unitId = `${seed.qid}::u`;
    await seedEvaluation(seed, 'y1093_ev1', {
      unitResults: [unitResult(unitId, 1)],
    });
    await activate('y1093_ev1', { effectiveId: null, generation: 0 });

    // θ̂ segment bracket 必须封存 ability_global 行（revert 才能恢复 domain 层）。
    const s1 = (await settlementEvents(seed.groupId)).find(
      (e) => (e.payload as { effect?: string }).effect === 'applied',
    );
    expect(s1).toBeTruthy();
    const snapRows = await db
      .select()
      .from(event)
      .where(eq(event.id, `${s1?.id}:snapshot:theta`));
    const thetaSnaps =
      (
        snapRows[0]?.payload as {
          theta_snapshots?: { kc_id: string; subject_kind?: string }[];
        }
      )?.theta_snapshots ?? [];
    const kcSnap = thetaSnaps.find((t) => t.kc_id === 'kc_a');
    expect(kcSnap).toBeTruthy();
    const globalSnap = thetaSnaps.find(
      (t) => t.subject_kind === 'ability_global' && t.kc_id === 'dom_x',
    );
    expect(globalSnap).toBeTruthy();

    // regrade：correct → incorrect（同 occurrence 替换，不算额外练习）。
    await seedEvaluation(seed, 'y1093_ev2', {
      attempt: 2,
      unitResults: [unitResult(unitId, 0)],
      aggregate: { kind: 'points_total', points: 0, policy: { kind: 'sum' } },
    });
    const regrade = await activate('y1093_ev2', { effectiveId: 'y1093_ev1', generation: 1 });
    expect(regrade.status).toBe('activated');

    // domain 行：原 success drift 被 revert，failure drift 落位 —— 计数恰好 1，
    // 不凭空 +1（buggy：evidence=2 / success=1 / fail=1）。
    const g = await masteryRow('dom_x', 'ability_global');
    expect(g?.evidence_count).toBe(1);
    expect(g?.success_count).toBe(0);
    expect(g?.fail_count).toBe(1);

    // oracle：另一个 domain 上恰好一次全新 failure settlement —— regrade 后的
    // domain θ̂ 必须等于「一次 failure」而不是「+success 再 +failure」的和。
    await seedKnowledge('kc_oracle', { domain: 'dom_oracle' });
    const oracle = await seedChain('y1093o', { kcs: ['kc_oracle'] });
    const oracleUnit = `${oracle.qid}::u`;
    await seedEvaluation(oracle, 'y1093o_ev1', {
      unitResults: [unitResult(oracleUnit, 0)],
      aggregate: { kind: 'points_total', points: 0, policy: { kind: 'sum' } },
    });
    await activate('y1093o_ev1', { effectiveId: null, generation: 0 });
    const gOracle = await masteryRow('dom_oracle', 'ability_global');
    expect(gOracle).toBeTruthy();
    expect(g?.theta_hat).toBeCloseTo(gOracle?.theta_hat ?? Number.NaN, 12);
  });

  it('YUK-1093 P1-2：manual→auto→auto —— 第二次 judge 纠正仍保持用户评级（沿链回溯 provenance）', async () => {
    await seedKnowledge('kc_a', { domain: 'dom_x' });
    const seed = await seedChain('y1093c', { kcs: ['kc_a'] });
    const unitId = `${seed.qid}::u`;

    // ev1：manual 评级落卡（用户确认的调度）。
    await seedEvaluation(seed, 'y1093c_ev1', {
      attempt: 1,
      unitResults: [unitResult(unitId, 1)],
      provenance: { source: 'manual', assisted: false },
    });
    await activate('y1093c_ev1', { effectiveId: null, generation: 0 });
    const s1 = (await settlementEvents(seed.groupId)).find(
      (e) => (e.payload as { effect?: string }).effect === 'applied',
    );
    const fsrs1 = await fsrsRow('knowledge', 'kc_a');
    expect(fsrs1?.state?.reps).toBe(1);
    expect(fsrs1?.last_review_event_id).toBe(s1?.id);

    // ev2：第一次自动纠正（incorrect）—— 守卫已生效，用户评级不动。
    await seedEvaluation(seed, 'y1093c_ev2', {
      attempt: 2,
      unitResults: [unitResult(unitId, 0)],
      aggregate: { kind: 'points_total', points: 0, policy: { kind: 'sum' } },
    });
    await activate('y1093c_ev2', { effectiveId: 'y1093c_ev1', generation: 1 });
    const fsrs2 = await fsrsRow('knowledge', 'kc_a');
    expect(fsrs2?.state?.reps).toBe(1);
    expect(fsrs2?.last_review_event_id).toBe(s1?.id);

    // ev3：第二次自动纠正 —— 直接前驱是 auto（ratingSource='verdict'），但 live
    // FSRS 卡仍来自 ev1 的用户评级；守卫必须沿链保留（buggy：只看直接前驱 ⇒
    // ev3 静默重排用户的卡：reps=2 + last_review 指向 ev3 结算事件）。
    await seedEvaluation(seed, 'y1093c_ev3', {
      attempt: 3,
      unitResults: [unitResult(unitId, 1)],
      aggregate: { kind: 'points_total', points: 1, policy: { kind: 'sum' } },
    });
    const r3 = await activate('y1093c_ev3', { effectiveId: 'y1093c_ev2', generation: 2 });
    expect(r3.status).toBe('activated');
    expect((r3 as { effect: string }).effect).toBe('applied');
    const fsrs3 = await fsrsRow('knowledge', 'kc_a');
    expect(fsrs3?.state?.reps).toBe(1);
    expect(fsrs3?.last_review_event_id).toBe(s1?.id);

    // ev4：再次 manual —— 用户评级【显式替换】旧用户评级：守卫不吞用户评级，
    // 新评级在保留的卡上正常落位（reps=2）。
    await seedEvaluation(seed, 'y1093c_ev4', {
      attempt: 4,
      unitResults: [unitResult(unitId, 1)],
      provenance: { source: 'manual', assisted: false },
    });
    const r4 = await activate('y1093c_ev4', { effectiveId: 'y1093c_ev3', generation: 3 });
    expect(r4.status).toBe('activated');
    const s4 = (await settlementEvents(seed.groupId)).find(
      (e) => (e.payload as { evaluation_id?: string }).evaluation_id === 'y1093c_ev4',
    );
    const fsrs4 = await fsrsRow('knowledge', 'kc_a');
    expect(fsrs4?.state?.reps).toBe(2);
    expect(fsrs4?.last_review_event_id).toBe(s4?.id);
  });

  it('YUK-1093 P1-3：全量 regrade（→unsupported）以被替换主体播种闭包 —— 不误报 failed_pending', async () => {
    const t1 = new Date('2026-09-20T00:00:00Z');
    const t2 = new Date('2026-09-21T00:00:00Z');
    await seedKnowledge('kc_a', { domain: 'dom_x' });
    // G1（t1）先结算 correct：kc_a + dom_x 上留 success obs 与用户无关 FSRS 卡。
    const seedA = await seedChain('y1093s', { kcs: ['kc_a'], submittedAt: t1 });
    const unitA = `${seedA.qid}::u`;
    await seedEvaluation(seedA, 'y1093s_ev1', {
      unitResults: [unitResult(unitA, 1)],
    });
    await activate('y1093s_ev1', { effectiveId: null, generation: 0 }, t1);
    const sOld = (await settlementEvents(seedA.groupId)).find(
      (e) => (e.payload as { effect?: string }).effect === 'applied',
    );

    // G2（t2 > t1，异组同 KC）随后结算 —— live 结算在 G1 被替换主体的证据之后。
    const seedB = await seedChain('y1093t', { kcs: ['kc_a'], submittedAt: t2 });
    const unitB = `${seedB.qid}::u`;
    await seedEvaluation(seedB, 'y1093t_ev1', {
      unitResults: [unitResult(unitB, 1)],
    });
    await activate('y1093t_ev1', { effectiveId: null, generation: 0 }, t2);
    const g2 = await settlementEvents(seedB.groupId);
    const g2Live = g2.find((e) => (e.payload as { effect?: string }).effect === 'applied');
    const mMid = await masteryRow('kc_a');
    expect(mMid?.evidence_count).toBe(2);

    // G1 regrade → unsupported：本次结算不写任何主体（subjects 为空）。闭包
    // 必须以【被替换结算的主体】播种，否则 G2 不入闭包 —— revert S_old 时撞
    // 上 G2 的 snapshot 链 ⇒ revert_failed ⇒ failed_pending（buggy 行为）。
    await seedEvaluation(seedA, 'y1093s_ev2', {
      attempt: 2,
      aggregate: { kind: 'unresolved', reason: 'pending_units', detail: 'u pending' },
    });
    const result = await activate('y1093s_ev2', {
      effectiveId: 'y1093s_ev1',
      generation: 1,
    });
    expect(result.status).toBe('activated');
    expect((result as { effect: string }).effect).not.toBe('failed_pending');

    // S_old 的写入被 revert；G2 按其原 occurrence 重放：kc_a 只剩 G2 一条 obs。
    const m = await masteryRow('kc_a');
    expect(m?.evidence_count).toBe(1);
    expect(m?.success_count).toBe(1);
    expect(new Date(m?.last_outcome_at ?? 0).toISOString()).toBe(t2.toISOString());
    const g = await masteryRow('dom_x', 'ability_global');
    expect(g?.evidence_count).toBe(1);

    // FSRS：G2 按原 occurrence 重排（re-apply 事件成为卡的写入者）。
    const fsrs = await fsrsRow('knowledge', 'kc_a');
    const replayed = (await settlementEvents()).filter(
      (e) => (e.payload as { replay_of?: string }).replay_of === g2Live?.id,
    );
    expect(replayed).toHaveLength(1);
    expect(fsrs?.last_review_event_id).toBe(replayed[0]?.id);

    // regrade 事件的 reverted 面显式（S_old + G2 原事件）。
    const newEv = (await settlementEvents(seedA.groupId)).find(
      (e) => (e.payload as { evaluation_id?: string }).evaluation_id === 'y1093s_ev2',
    );
    const revertedIds =
      ((newEv?.payload ?? {}) as { reverted_settlement_event_ids?: string[] })
        .reverted_settlement_event_ids ?? [];
    expect(revertedIds).toContain(sOld?.id);
    expect(revertedIds).toContain(g2Live?.id);
  });
});
