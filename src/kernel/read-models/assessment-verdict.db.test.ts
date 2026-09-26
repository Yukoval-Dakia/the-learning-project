// YUK-1054 — 双轨裁决读模型 DB 测试。
//
// LEGACY lane 钉住的行为：
//   - 无 judge ⇒ 三轨全 null；
//   - 单判 ⇒ original === effective === newest_raw；
//   - 申诉重判（新 judge subject_id=attempt / caused_by=appeal + correct
//     supersede 旧判）⇒ original 仍是最早判，effective/newest_raw 指向新判；
//     caused_by≠attempt 的重判不丢（旧 caused_by-only 读面的 gap 修复点）；
//   - mark_wrong/retract 后 effective=null 而 original/newest_raw 仍留行；
//   - 批量多 attempt 互不串轨。
//
// CONTRACT lane 钉住的行为：
//   - head.effective_evaluation_id ⇒ effective；第一条 active activation 事件
//     ⇒ original；无 activation 时回退最早 applied settlement；再退最早 attempt；
//   - retract 的 activation 不算「第一判生效」；
//   - verdict 经 deriveCoarseVerdict + revision.scoring_basis（choice 题 basis
//     sum/units=1pt：points 1→correct、0.5→partial、0→incorrect、pending→
//     unsupported）。

import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  evaluation_group,
  event,
  question,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import {
  ASSESSMENT_ACTIVATION_ACTION,
  activateEvaluation,
  insertInitialEvaluationHead,
} from '@/server/assessment/activate';
import {
  type NormalizableQuestionRow,
  normalizeQuestionRowToContract,
} from '@/server/questions/contract-normalizer';
import { publishQuestionGroup } from '@/server/questions/publisher';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { resolveVerdictsForAttempts, resolveVerdictsForGroups } from './assessment-verdict';

const T0 = new Date('2026-09-26T00:00:00Z');
const T1 = new Date('2026-09-26T00:01:00Z');
const T2 = new Date('2026-09-26T00:02:00Z');
const T3 = new Date('2026-09-26T00:03:00Z');

// ---------- legacy lane seeds ----------

async function seedAttempt(id: string, createdAt = T0): Promise<void> {
  await writeEvent(testDb(), {
    id,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: `q_${id}`,
    outcome: 'failure',
    payload: { answer_md: 'wrong', answer_image_refs: [], referenced_knowledge_ids: [] },
    created_at: createdAt,
  });
}

async function seedJudge(opts: {
  id: string;
  attemptEventId: string;
  causedBy?: string;
  coarseOutcome: string;
  score?: number;
  actorRef?: string;
  appealEventId?: string;
  createdAt: Date;
}): Promise<void> {
  await writeEvent(testDb(), {
    id: opts.id,
    actor_kind: 'agent',
    actor_ref: opts.actorRef ?? 'paper_judge',
    action: 'judge',
    subject_kind: 'event',
    subject_id: opts.attemptEventId,
    outcome: 'success',
    payload: {
      cause: {
        primary_category: 'other',
        secondary_categories: [],
        analysis_md: '<test>',
        confidence: 0.9,
      },
      referenced_knowledge_ids: ['kc_a'],
      coarse_outcome: opts.coarseOutcome,
      ...(opts.score !== undefined ? { score: opts.score } : {}),
      feedback_md: `fb_${opts.id}`,
      ...(opts.appealEventId ? { appeal_event_id: opts.appealEventId } : {}),
    },
    caused_by_event_id: opts.causedBy ?? opts.attemptEventId,
    created_at: opts.createdAt,
  });
}

async function seedCorrection(opts: {
  id: string;
  targetEventId: string;
  correctionKind: 'supersede' | 'retract' | 'mark_wrong';
  replacementEventId?: string;
  causedBy?: string;
  createdAt: Date;
}): Promise<void> {
  await writeEvent(testDb(), {
    id: opts.id,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'correct',
    subject_kind: 'event',
    subject_id: opts.targetEventId,
    outcome: 'success',
    payload: {
      correction_kind: opts.correctionKind,
      replacement_event_id: opts.replacementEventId,
      reason_md: 'test correction',
      affected_refs: [{ kind: 'question', id: 'q' }],
    },
    caused_by_event_id: opts.causedBy,
    created_at: opts.createdAt,
  });
}

// ---------- contract lane seeds ----------

const ADMITTED_EVIDENCE = {
  marking_provenance: 'official' as const,
  verification: { structural_check_passed: true, independent_verification: null },
  model_slice: null,
};

async function seedQuestion(id: string) {
  const db = testDb();
  await db.insert(question).values({
    id,
    kind: 'choice',
    prompt_md: `题面 ${id}`,
    reference_md: 'B',
    knowledge_ids: [],
    difficulty: 3,
    source: 'web_sourced',
    variant_depth: 0,
    choices_md: ['甲', '乙', '丙'],
    created_at: T0,
    updated_at: T0,
    version: 0,
  });
}

async function publishAdmitted(qid: string) {
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
    now: T0,
  });
  if (result.status !== 'published') throw new Error(`seed publish: ${result.status}`);
  return result.revision_id;
}

async function seedChain(prefix: string) {
  const db = testDb();
  const qid = `${prefix}_q`;
  const groupId = `${prefix}_grp`;
  const submissionId = `${prefix}_sub`;
  const issuanceId = `${prefix}_iss`;
  await seedQuestion(qid);
  const revisionId = await publishAdmitted(qid);
  await db.insert(assessment_issuance).values({
    issuance_id: issuanceId,
    revision_id: revisionId,
    part_ids: [],
    material_bindings: [],
    option_order: [],
    claim_policy: 'one_time',
    claim_status: 'claimed',
    claimed_by_ref: 'occ_1',
    issued_at: T0,
  });
  await db.transaction(async (tx) => {
    await tx.insert(evaluation_group).values({
      evaluation_group_id: groupId,
      submission_ids: [submissionId],
      created_at: T0,
    });
    await tx.insert(assessment_submission).values({
      submission_id: submissionId,
      issuance_id: issuanceId,
      revision_id: revisionId,
      evaluation_group_id: groupId,
      response_set: { entries: [] },
      group_evidence: [],
      idempotency_key: `${prefix}_idem`,
      submitted_at: T0,
    });
    await insertInitialEvaluationHead(tx, {
      evaluation_group_id: groupId,
      submission_id: submissionId,
      now: T0,
    });
  });
  return { qid, revisionId, issuanceId, groupId, submissionId };
}

async function seedEvaluation(
  groupId: string,
  submissionId: string,
  evalId: string,
  opts: { status?: 'pending' | 'completed'; attempt?: number; points?: number | null } = {},
) {
  const db = testDb();
  await db.insert(evaluation).values({
    evaluation_id: evalId,
    evaluation_group_id: groupId,
    submission_id: submissionId,
    attempt: opts.attempt ?? 1,
    status: opts.status ?? 'completed',
    unit_results: [],
    aggregate:
      opts.status === 'pending'
        ? null
        : { kind: 'level', level_id: 'pass', points: opts.points ?? 1 },
    plan_digest: null,
    run_refs: [],
    provenance: { source: 'automatic', assisted: false },
    created_at: T0,
  });
}

// ---------- tests ----------

describe('resolveVerdictsForAttempts（legacy lane 双轨）', () => {
  beforeEach(resetDb);

  it('无 judge ⇒ 三轨全 null', async () => {
    await seedAttempt('att_none');
    const map = await resolveVerdictsForAttempts(testDb(), ['att_none']);
    expect(map.get('att_none')).toEqual({
      attempt_event_id: 'att_none',
      embedded: null,
      original: null,
      effective: null,
      newest_raw: null,
    });
  });

  it('单判 ⇒ 三轨同一行，payload 字段原样投影', async () => {
    await seedAttempt('att_1');
    await seedJudge({
      id: 'j_1',
      attemptEventId: 'att_1',
      coarseOutcome: 'incorrect',
      score: 0.2,
      createdAt: T1,
    });
    const v = (await resolveVerdictsForAttempts(testDb(), ['att_1'])).get('att_1');
    expect(v?.original?.judge_event_id).toBe('j_1');
    expect(v?.effective?.judge_event_id).toBe('j_1');
    expect(v?.newest_raw?.judge_event_id).toBe('j_1');
    expect(v?.effective?.verdict.coarse_outcome).toBe('incorrect');
    expect(v?.effective?.verdict.score).toBe(0.2);
    expect(v?.effective?.verdict.feedback_md).toBe('fb_j_1');
    expect(v?.effective?.correction_state.terminal_state).toBe('active');
  });

  it('申诉重判（subject_id=attempt / caused_by=appeal）+ supersede ⇒ original 最早判，effective/newest_raw 新判', async () => {
    await seedAttempt('att_2');
    await seedJudge({
      id: 'j_old',
      attemptEventId: 'att_2',
      coarseOutcome: 'incorrect',
      score: 0.1,
      createdAt: T1,
    });
    // 申诉事件（锚只作 caused_by 引用）。
    await writeEvent(testDb(), {
      id: 'appeal_1',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:appeal_request',
      subject_kind: 'event',
      subject_id: 'j_old',
      outcome: null,
      payload: { reason_md: '判错了' },
      created_at: T2,
    });
    await seedJudge({
      id: 'j_new',
      attemptEventId: 'att_2',
      causedBy: 'appeal_1',
      coarseOutcome: 'correct',
      score: 0.95,
      actorRef: 'rejudge',
      appealEventId: 'appeal_1',
      createdAt: T2,
    });
    await seedCorrection({
      id: 'corr_1',
      targetEventId: 'j_old',
      correctionKind: 'supersede',
      replacementEventId: 'j_new',
      causedBy: 'j_new',
      createdAt: T2,
    });

    const v = (await resolveVerdictsForAttempts(testDb(), ['att_2'])).get('att_2');
    // original = 历史第一判（即使已被 supersede）。
    expect(v?.original?.judge_event_id).toBe('j_old');
    expect(v?.original?.verdict.coarse_outcome).toBe('incorrect');
    expect(v?.original?.correction_state.state).toBe('superseded');
    // effective = 链端新判。
    expect(v?.effective?.judge_event_id).toBe('j_new');
    expect(v?.effective?.verdict.coarse_outcome).toBe('correct');
    expect(v?.effective?.verdict.appeal_event_id).toBe('appeal_1');
    expect(v?.effective?.original_event_id).toBe('j_old');
    // newest_raw = 同一条（无更新的 raw 行）。
    expect(v?.newest_raw?.judge_event_id).toBe('j_new');
  });

  it('mark_wrong 旧判 + 无替代 ⇒ effective=null，original/newest_raw 仍留行', async () => {
    await seedAttempt('att_3');
    await seedJudge({
      id: 'j_mw',
      attemptEventId: 'att_3',
      coarseOutcome: 'incorrect',
      createdAt: T1,
    });
    await seedCorrection({
      id: 'corr_mw',
      targetEventId: 'j_mw',
      correctionKind: 'mark_wrong',
      createdAt: T2,
    });
    const v = (await resolveVerdictsForAttempts(testDb(), ['att_3'])).get('att_3');
    expect(v?.original?.judge_event_id).toBe('j_mw');
    expect(v?.effective).toBeNull();
    expect(v?.newest_raw?.judge_event_id).toBe('j_mw');
  });

  it('retract 全部判 ⇒ effective=null', async () => {
    await seedAttempt('att_4');
    await seedJudge({
      id: 'j_r',
      attemptEventId: 'att_4',
      coarseOutcome: 'partial',
      createdAt: T1,
    });
    await seedCorrection({
      id: 'corr_r',
      targetEventId: 'j_r',
      correctionKind: 'retract',
      createdAt: T2,
    });
    const v = (await resolveVerdictsForAttempts(testDb(), ['att_4'])).get('att_4');
    expect(v?.effective).toBeNull();
    expect(v?.original?.judge_event_id).toBe('j_r');
  });

  it('批量：多 attempt 各自分轨，互不串', async () => {
    await seedAttempt('att_a');
    await seedAttempt('att_b');
    await seedJudge({
      id: 'j_a',
      attemptEventId: 'att_a',
      coarseOutcome: 'incorrect',
      createdAt: T1,
    });
    await seedJudge({
      id: 'j_b1',
      attemptEventId: 'att_b',
      coarseOutcome: 'incorrect',
      createdAt: T1,
    });
    await seedJudge({
      id: 'j_b2',
      attemptEventId: 'att_b',
      coarseOutcome: 'correct',
      createdAt: T2,
    });
    await seedCorrection({
      id: 'corr_b',
      targetEventId: 'j_b1',
      correctionKind: 'supersede',
      replacementEventId: 'j_b2',
      createdAt: T2,
    });
    const map = await resolveVerdictsForAttempts(testDb(), ['att_a', 'att_b', 'att_missing']);
    expect(map.get('att_a')?.effective?.judge_event_id).toBe('j_a');
    expect(map.get('att_b')?.original?.judge_event_id).toBe('j_b1');
    expect(map.get('att_b')?.effective?.judge_event_id).toBe('j_b2');
    expect(map.get('att_missing')).toEqual({
      attempt_event_id: 'att_missing',
      embedded: null,
      original: null,
      effective: null,
      newest_raw: null,
    });
  });

  it('embedded 判（payload.judge，无 judge event）⇒ embedded 轨填、其余轨 null', async () => {
    // solve-session（YUK-193）把判分嵌在 attempt payload.judge，不另写 judge
    // event —— resolver 必须把它当「执行时写下的那一判」显式保留。
    // solve-session 的 embedded 形状（route/reason_md）不是 JudgeResultV2，写不进
    // writeEvent/parseEvent；raw-insert 以镜像生产行。
    await testDb()
      .insert(event)
      .values({
        id: 'att_emb',
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q_att_emb',
        outcome: 'failure',
        payload: {
          answer_md: 'wrong',
          judge: {
            coarse_outcome: 'incorrect',
            score: 0,
            route: 'solve_session_judge',
            reason_md: 'embedded feedback',
          },
        },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        ingest_at: null,
        created_at: T0,
      });
    const v = (await resolveVerdictsForAttempts(testDb(), ['att_emb'])).get('att_emb');
    expect(v?.embedded).not.toBeNull();
    expect(v?.embedded?.coarse_outcome).toBe('incorrect');
    expect(v?.embedded?.score).toBe(0);
    // embedded 形状用 route/reason_md → 映射到 judge_route/feedback_md。
    expect(v?.embedded?.judge_route).toBe('solve_session_judge');
    expect(v?.embedded?.feedback_md).toBe('embedded feedback');
    // embedded 不是 judge event：original/effective/newest_raw 全部 null。
    expect(v?.original).toBeNull();
    expect(v?.effective).toBeNull();
    expect(v?.newest_raw).toBeNull();
  });

  it('embedded 判 + 另有 judge event ⇒ embedded 保留执行收据，judge 轨照常解析', async () => {
    await testDb()
      .insert(event)
      .values({
        id: 'att_emb2',
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q_att_emb2',
        outcome: 'failure',
        payload: {
          answer_md: 'wrong',
          judge: { coarse_outcome: 'incorrect', route: 'solve_session_judge' },
        },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        ingest_at: null,
        created_at: T0,
      });
    await seedJudge({
      id: 'j_emb2',
      attemptEventId: 'att_emb2',
      coarseOutcome: 'partial',
      createdAt: T1,
    });
    const v = (await resolveVerdictsForAttempts(testDb(), ['att_emb2'])).get('att_emb2');
    // 两轨并存：embedded 仍反映执行时嵌入判，effective 反映后续正式 judge。
    expect(v?.embedded?.coarse_outcome).toBe('incorrect');
    expect(v?.original?.judge_event_id).toBe('j_emb2');
    expect(v?.effective?.verdict.coarse_outcome).toBe('partial');
  });

  it('payload.judge 非对象 ⇒ embedded=null', async () => {
    // writeEvent 走 parseEvent 校验，会在写入前拒掉畸形 payload.judge —— 本用例
    // 断言的是「历史脏行 → embedded 轨安全退化 null」，需绕过 parseEvent 直接
    // insert 一行非对象 judge。
    await testDb()
      .insert(event)
      .values({
        id: 'att_emb3',
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q_att_emb3',
        outcome: 'failure',
        payload: { answer_md: 'wrong', judge: 'not-an-object' },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        ingest_at: null,
        created_at: T0,
      });
    const v = (await resolveVerdictsForAttempts(testDb(), ['att_emb3'])).get('att_emb3');
    expect(v?.embedded).toBeNull();
  });
});

describe('resolveVerdictsForGroups（contract lane 双轨）', () => {
  beforeEach(resetDb);

  it('无 head 无 eval ⇒ 三字段 null', async () => {
    const map = await resolveVerdictsForGroups(testDb(), ['grp_empty']);
    expect(map.get('grp_empty')).toEqual({
      evaluation_group_id: 'grp_empty',
      effective: null,
      original: null,
      head: null,
    });
  });

  it('activation 链：head.effective ⇒ effective，首条 activation ⇒ original，verdict 经 basis 派生', async () => {
    const db = testDb();
    const seed = await seedChain('cl1');
    await seedEvaluation(seed.groupId, seed.submissionId, 'ev_first', { attempt: 1, points: 0 });
    await seedEvaluation(seed.groupId, seed.submissionId, 'ev_second', { attempt: 2, points: 1 });
    const settle = async () => 'applied' as const;

    await db.transaction((tx) =>
      activateEvaluation(
        tx,
        { evaluation_id: 'ev_first', expected_effective_id: null, expected_generation: 0 },
        { settle, actorRef: 'test', now: T1 },
      ),
    );
    await db.transaction((tx) =>
      activateEvaluation(
        tx,
        { evaluation_id: 'ev_second', expected_effective_id: 'ev_first', expected_generation: 1 },
        { settle, actorRef: 'test', now: T2 },
      ),
    );

    const v = (await resolveVerdictsForGroups(db, [seed.groupId])).get(seed.groupId);
    expect(v?.head?.generation).toBe(2);
    expect(v?.effective?.evaluation_id).toBe('ev_second');
    // choice basis：unit points=1、sum ⇒ points 1 → correct，0 → incorrect。
    expect(v?.effective?.verdict.verdict).toBe('correct');
    expect(v?.original?.evaluation_id).toBe('ev_first');
    expect(v?.original?.verdict.verdict).toBe('incorrect');
  });

  it('retract 首条 activation ⇒ original 落到下一条', async () => {
    const db = testDb();
    const seed = await seedChain('cl2');
    await seedEvaluation(seed.groupId, seed.submissionId, 'ev_a', { attempt: 1, points: 1 });
    await seedEvaluation(seed.groupId, seed.submissionId, 'ev_b', { attempt: 2, points: 1 });
    const settle = async () => 'applied' as const;
    await db.transaction((tx) =>
      activateEvaluation(
        tx,
        { evaluation_id: 'ev_a', expected_effective_id: null, expected_generation: 0 },
        { settle, actorRef: 'test', now: T1 },
      ),
    );
    await db.transaction((tx) =>
      activateEvaluation(
        tx,
        { evaluation_id: 'ev_b', expected_effective_id: 'ev_a', expected_generation: 1 },
        { settle, actorRef: 'test', now: T2 },
      ),
    );
    // retract 第一条 activation 收据（本组最早一条）。
    const [firstAct] = await db
      .select()
      .from(event)
      .where(eq(event.subject_id, seed.groupId))
      .orderBy(asc(event.created_at), asc(event.id))
      .limit(1);
    expect(firstAct?.action).toBe(ASSESSMENT_ACTIVATION_ACTION);
    await seedCorrection({
      id: 'corr_act',
      targetEventId: firstAct.id,
      correctionKind: 'retract',
      createdAt: T3,
    });
    const v = (await resolveVerdictsForGroups(db, [seed.groupId])).get(seed.groupId);
    expect(v?.original?.evaluation_id).toBe('ev_b');
    expect(v?.effective?.evaluation_id).toBe('ev_b');
  });

  it('无 activation 事件 ⇒ original 回退最早 applied settlement 的 evaluation_id', async () => {
    const db = testDb();
    const seed = await seedChain('cl3');
    await seedEvaluation(seed.groupId, seed.submissionId, 'ev_s1', { attempt: 1, points: 0 });
    await seedEvaluation(seed.groupId, seed.submissionId, 'ev_s2', { attempt: 2, points: 1 });
    // 手工写 settlement 事件（最早 applied 指向 ev_s2）。
    await writeEvent(db, {
      id: 'stl_1',
      actor_kind: 'agent',
      actor_ref: 'assessment:settle',
      action: 'experimental:assessment_settlement',
      subject_kind: 'evaluation_group',
      subject_id: seed.groupId,
      outcome: 'success',
      payload: {
        version: 1,
        evaluation_group_id: seed.groupId,
        evaluation_id: 'ev_s2',
        effect: 'applied',
        occurrence_at: T1.toISOString(),
      },
      created_at: T1,
    });
    const v = (await resolveVerdictsForGroups(db, [seed.groupId])).get(seed.groupId);
    // head.effective=null ⇒ effective null（从未激活）。
    expect(v?.effective).toBeNull();
    expect(v?.original?.evaluation_id).toBe('ev_s2');
  });

  it('既无 activation 也无 settlement ⇒ original 退到最早 attempt 序', async () => {
    const db = testDb();
    const seed = await seedChain('cl4');
    await seedEvaluation(seed.groupId, seed.submissionId, 'ev_t2', { attempt: 2, points: 1 });
    await seedEvaluation(seed.groupId, seed.submissionId, 'ev_t1', { attempt: 1, points: 0 });
    const v = (await resolveVerdictsForGroups(db, [seed.groupId])).get(seed.groupId);
    expect(v?.original?.evaluation_id).toBe('ev_t1');
    expect(v?.original?.attempt).toBe(1);
  });

  it('pending evaluation ⇒ verdict unsupported（evaluation_pending）', async () => {
    const db = testDb();
    const seed = await seedChain('cl5');
    await seedEvaluation(seed.groupId, seed.submissionId, 'ev_p', {
      attempt: 1,
      status: 'pending',
    });
    const v = (await resolveVerdictsForGroups(db, [seed.groupId])).get(seed.groupId);
    expect(v?.original?.evaluation_id).toBe('ev_p');
    expect(v?.original?.verdict.verdict).toBe('unsupported');
    expect(v?.original?.verdict.reason).toBe('evaluation_pending');
  });
});
