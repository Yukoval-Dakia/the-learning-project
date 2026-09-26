// YUK-1045 — activateEvaluation 编排 DB 测试（db 分区；testcontainer + resetDb）。
// 覆盖 §11 activation 契约的可执行部分：
//   - 锁序下 CAS：null CAS（首次）/ ABA（generation_mismatch）/ racing supersede
//     （stale_head）/ 同版幂等重放（already_effective，不重复学习结算 ——
//     commit-before-DONE 重试安全）；
//   - admission 重核：组 suspended/withdrawn 或 observed generation 漂移 ⇒
//     stale_admission，head 不前移、无 receipt；
//   - receipt = `experimental:assessment_activation` 事件（effect 处置不吞）；
//   - 结算端口未接 ⇒ fail-closed 抛错回滚（YUK-1047 blockedBy 接缝）；
//   - releaseIssuanceClaim 只释放 claim 列，不复活 verify 挂起的题。

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '@/db/client';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  evaluation_group,
  event,
  question,
  question_group_lifecycle,
} from '@/db/schema';
import {
  type NormalizableQuestionRow,
  normalizeQuestionRowToContract,
} from '@/server/questions/contract-normalizer';
import { publishQuestionGroup } from '@/server/questions/publisher';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  ASSESSMENT_ACTIVATION_ACTION,
  type ActivationSettleInput,
  ActivationSettlementUnavailable,
  activateEvaluation,
  insertInitialEvaluationHead,
  releaseIssuanceClaim,
} from './activate';

const NOW = new Date('2026-09-25T00:00:00Z');

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
    created_at: NOW,
    updated_at: NOW,
    version: 0,
  });
}

/** 发布 admitted ⇒ 返回 { revisionId, admissionGeneration }。 */
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
    now: NOW,
  });
  if (result.status !== 'published') throw new Error(`seed publish: ${result.status}`);
  const [lc] = await db
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, qid));
  return { revisionId: result.revision_id, admissionGeneration: lc.scoring_admission_generation };
}

interface SeedIds {
  qid: string;
  revisionId: string;
  issuanceId: string;
  groupId: string;
  submissionId: string;
  admissionGeneration: number;
}

/** submission + group + head 同事务种子（§11 原子不变量测试版）。 */
async function seedChain(prefix: string, opts: { withHead?: boolean } = {}): Promise<SeedIds> {
  const db = testDb();
  const qid = `${prefix}_q`;
  const issuanceId = `${prefix}_iss`;
  const groupId = `${prefix}_grp`;
  const submissionId = `${prefix}_sub`;
  await seedQuestion(qid);
  const { revisionId, admissionGeneration } = await publishAdmitted(qid);
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
      submitted_at: NOW,
    });
    if (opts.withHead !== false) {
      await insertInitialEvaluationHead(tx, {
        evaluation_group_id: groupId,
        submission_id: submissionId,
        now: NOW,
      });
    }
  });
  return { qid, revisionId, issuanceId, groupId, submissionId, admissionGeneration };
}

async function seedEvaluation(
  seed: SeedIds,
  evalId: string,
  opts: {
    status?: 'pending' | 'completed';
    attempt?: number;
    points?: number;
    observedGeneration?: number | 'omit';
  } = {},
) {
  const db = testDb();
  const provenance: Record<string, unknown> = { source: 'automatic', assisted: false };
  if (opts.observedGeneration !== 'omit') {
    provenance.admission_generation = opts.observedGeneration ?? seed.admissionGeneration;
  }
  await db.insert(evaluation).values({
    evaluation_id: evalId,
    evaluation_group_id: seed.groupId,
    submission_id: seed.submissionId,
    attempt: opts.attempt ?? 1,
    status: opts.status ?? 'completed',
    unit_results: [],
    aggregate:
      opts.status === 'pending'
        ? null
        : { kind: 'level', level_id: 'pass', points: opts.points ?? 80 },
    plan_digest: null,
    run_refs: [],
    provenance,
    created_at: NOW,
  });
}

function settleApplied() {
  return vi.fn(async (_input: ActivationSettleInput) => 'applied' as const);
}

async function readHead(db: Db, groupId: string) {
  const [head] = await db
    .select()
    .from(evaluation_effective_head)
    .where(eq(evaluation_effective_head.evaluation_group_id, groupId));
  return head;
}

async function receiptEvents(db: Db, groupId: string) {
  return db.select().from(event).where(eq(event.subject_id, groupId));
}

describe('activateEvaluation（YUK-1045 §11 activation 编排骨架）', () => {
  beforeEach(resetDb);

  it('首次激活：CAS null 前置成立 ⇒ head 前移 + generation=1 + settle 恰好一次 + receipt 事件', async () => {
    const db = testDb();
    const seed = await seedChain('act1');
    await seedEvaluation(seed, 'act1_ev1', { points: 80 });
    const settle = settleApplied();

    const result = await db.transaction((tx) =>
      activateEvaluation(
        tx,
        {
          evaluation_id: 'act1_ev1',
          expected_effective_id: null,
          expected_generation: 0,
        },
        { settle, actorRef: 'test:activate', now: NOW },
      ),
    );

    expect(result).toEqual({ status: 'activated', effect: 'applied', generation: 1 });
    const head = await readHead(db, seed.groupId);
    expect(head.effective_evaluation_id).toBe('act1_ev1');
    expect(head.generation).toBe(1);
    expect(settle).toHaveBeenCalledTimes(1);
    const settleInput = settle.mock.calls[0]?.[0];
    if (!settleInput) throw new Error('settle not called');
    expect(settleInput.questionGroupId).toBe(seed.qid);
    expect(settleInput.issuance.issuance_id).toBe(seed.issuanceId);

    const receipts = (await receiptEvents(db, seed.groupId)).filter(
      (e) => e.action === ASSESSMENT_ACTIVATION_ACTION,
    );
    expect(receipts).toHaveLength(1);
    const payload = receipts[0]?.payload as Record<string, unknown>;
    expect(payload.effect).toBe('applied');
    expect(payload.evaluation_id).toBe('act1_ev1');
    expect(payload.generation).toBe(1);
  });

  it('commit-before-DONE 重试安全：重复激活同 candidate ⇒ already_effective，不重结算、不重写 head、不产第二条 receipt', async () => {
    const db = testDb();
    const seed = await seedChain('act2');
    await seedEvaluation(seed, 'act2_ev1', { points: 80 });
    const settle = settleApplied();

    const first = await db.transaction((tx) =>
      activateEvaluation(
        tx,
        { evaluation_id: 'act2_ev1', expected_effective_id: null, expected_generation: 0 },
        { settle, actorRef: 'test', now: NOW },
      ),
    );
    expect(first.status).toBe('activated');

    // 重试（commit 成功但调用方未记 DONE ⇒ 相同 intent 重放）。
    const retry = await db.transaction((tx) =>
      activateEvaluation(
        tx,
        { evaluation_id: 'act2_ev1', expected_effective_id: null, expected_generation: 0 },
        { settle, actorRef: 'test', now: NOW },
      ),
    );
    expect(retry).toEqual({
      status: 'already_effective',
      effect: 'idempotent_replay',
      generation: 1,
    });
    expect(settle).toHaveBeenCalledTimes(1); // 不重复学习结算
    const head = await readHead(db, seed.groupId);
    expect(head.generation).toBe(1);
    const receipts = (await receiptEvents(db, seed.groupId)).filter(
      (e) => e.action === ASSESSMENT_ACTIVATION_ACTION,
    );
    expect(receipts).toHaveLength(1);
  });

  it('racing supersede：期望已前移的 head ⇒ stale_head；正确 expected（旧 id + 现 gen）⇒ 有意义替换成功', async () => {
    const db = testDb();
    const seed = await seedChain('act3');
    await seedEvaluation(seed, 'act3_ev1', { attempt: 1, points: 80 });
    // 同 coarse 但分值不同的修正 candidate（meaningful replacement 的载体）。
    await seedEvaluation(seed, 'act3_ev2', { attempt: 2, points: 65 });
    const settle = settleApplied();

    await db.transaction((tx) =>
      activateEvaluation(
        tx,
        { evaluation_id: 'act3_ev1', expected_effective_id: null, expected_generation: 0 },
        { settle, actorRef: 'test', now: NOW },
      ),
    );

    // 竞争投递：仍按"首次激活"的旧期望打 ev2 ⇒ stale_head。
    const raced = await db.transaction((tx) =>
      activateEvaluation(
        tx,
        { evaluation_id: 'act3_ev2', expected_effective_id: null, expected_generation: 0 },
        { settle, actorRef: 'test', now: NOW },
      ),
    );
    expect(raced).toEqual({ status: 'cas_conflict', conflict: 'stale_head' });
    expect((await readHead(db, seed.groupId)).effective_evaluation_id).toBe('act3_ev1');

    // 正确 CAS：expected_effective_id=ev1 + generation=1 ⇒ 替换生效。
    const replace = await db.transaction((tx) =>
      activateEvaluation(
        tx,
        {
          evaluation_id: 'act3_ev2',
          expected_effective_id: 'act3_ev1',
          expected_generation: 1,
        },
        { settle, actorRef: 'test', now: NOW },
      ),
    );
    expect(replace).toEqual({ status: 'activated', effect: 'applied', generation: 2 });
    const head = await readHead(db, seed.groupId);
    expect(head.effective_evaluation_id).toBe('act3_ev2');
    expect(head.generation).toBe(2);
    expect(settle).toHaveBeenCalledTimes(2);
    expect(settle.mock.calls[1]?.[0].evaluation.evaluation_id).toBe('act3_ev2');
  });

  it('ABA 防线：effective id 巧合回指但 generation 漂移 ⇒ generation_mismatch', async () => {
    const db = testDb();
    const seed = await seedChain('act4');
    await seedEvaluation(seed, 'act4_ev1', { attempt: 1, points: 80 });
    await seedEvaluation(seed, 'act4_ev2', { attempt: 2, points: 60 });
    const settle = settleApplied();

    await db.transaction((tx) =>
      activateEvaluation(
        tx,
        { evaluation_id: 'act4_ev1', expected_effective_id: null, expected_generation: 0 },
        { settle, actorRef: 'test', now: NOW },
      ),
    );
    await db.transaction((tx) =>
      activateEvaluation(
        tx,
        { evaluation_id: 'act4_ev2', expected_effective_id: 'act4_ev1', expected_generation: 1 },
        { settle, actorRef: 'test', now: NOW },
      ),
    );
    // 现在 head={ev2, gen2}。旧 intent 重放 ev1 且 expected 恰好=ev1？不行 ——
    // effective 已是 ev2。用 generation 漂移场景：expected id 对、gen 错。
    const aba = await db.transaction((tx) =>
      activateEvaluation(
        tx,
        { evaluation_id: 'act4_ev1', expected_effective_id: 'act4_ev2', expected_generation: 1 },
        { settle, actorRef: 'test', now: NOW },
      ),
    );
    expect(aba).toEqual({ status: 'cas_conflict', conflict: 'generation_mismatch' });
    expect((await readHead(db, seed.groupId)).generation).toBe(2);
  });

  it('admission 重核：组在评估后被挂起（verify_hold）⇒ stale_admission，head 不前移且无 receipt', async () => {
    const db = testDb();
    const seed = await seedChain('act5');
    await seedEvaluation(seed, 'act5_ev1', { points: 80 });
    const settle = settleApplied();

    // 评估完成后、activation 前 verify 挂起（generation 不变 —— suspension 是
    // 独立维度，校验直接看 suspended 标志）。
    await db
      .update(question_group_lifecycle)
      .set({ suspended: true, suspension_reason: 'verify_hold', updated_at: NOW })
      .where(eq(question_group_lifecycle.group_id, seed.qid));

    const result = await db.transaction((tx) =>
      activateEvaluation(
        tx,
        { evaluation_id: 'act5_ev1', expected_effective_id: null, expected_generation: 0 },
        { settle, actorRef: 'test', now: NOW },
      ),
    );
    expect(result).toEqual({ status: 'stale_admission' });
    expect(settle).not.toHaveBeenCalled();
    const head = await readHead(db, seed.groupId);
    expect(head.effective_evaluation_id).toBeNull();
    expect(head.generation).toBe(0);
    const receipts = (await receiptEvents(db, seed.groupId)).filter(
      (e) => e.action === ASSESSMENT_ACTIVATION_ACTION,
    );
    expect(receipts).toHaveLength(0);
  });

  it('admission 重核：observed generation 落后于当前 ⇒ stale_admission（旧评估不得盖过新 admission）', async () => {
    const db = testDb();
    const seed = await seedChain('act6');
    // candidate 观察的是 generation=1；之后 admission 翻转到 generation=2。
    await seedEvaluation(seed, 'act6_ev1', { points: 80, observedGeneration: 1 });
    await db
      .update(question_group_lifecycle)
      .set({ scoring_admission_generation: 2, updated_at: NOW })
      .where(eq(question_group_lifecycle.group_id, seed.qid));

    const result = await db.transaction((tx) =>
      activateEvaluation(
        tx,
        { evaluation_id: 'act6_ev1', expected_effective_id: null, expected_generation: 0 },
        { settle: settleApplied(), actorRef: 'test', now: NOW },
      ),
    );
    expect(result).toEqual({ status: 'stale_admission' });
    expect((await readHead(db, seed.groupId)).generation).toBe(0);
  });

  it('前置拒绝：pending candidate ⇒ not_completed；head 缺失 ⇒ head_missing', async () => {
    const db = testDb();
    const seed = await seedChain('act7');
    await seedEvaluation(seed, 'act7_ev1', { status: 'pending' });

    const pending = await db.transaction((tx) =>
      activateEvaluation(
        tx,
        { evaluation_id: 'act7_ev1', expected_effective_id: null, expected_generation: 0 },
        { settle: settleApplied(), actorRef: 'test', now: NOW },
      ),
    );
    expect(pending).toEqual({ status: 'not_completed' });

    const orphan = await seedChain('act7b', { withHead: false });
    await seedEvaluation(orphan, 'act7b_ev1', { points: 80 });
    const missing = await db.transaction((tx) =>
      activateEvaluation(
        tx,
        { evaluation_id: 'act7b_ev1', expected_effective_id: null, expected_generation: 0 },
        { settle: settleApplied(), actorRef: 'test', now: NOW },
      ),
    );
    expect(missing).toEqual({ status: 'head_missing' });
  });

  it('fail-closed：未注入结算端口 ⇒ 抛 ActivationSettlementUnavailable，head/receipt 全部回滚', async () => {
    const db = testDb();
    const seed = await seedChain('act8');
    await seedEvaluation(seed, 'act8_ev1', { points: 80 });

    await expect(
      db.transaction((tx) =>
        activateEvaluation(
          tx,
          { evaluation_id: 'act8_ev1', expected_effective_id: null, expected_generation: 0 },
          { actorRef: 'test', now: NOW },
        ),
      ),
    ).rejects.toBeInstanceOf(ActivationSettlementUnavailable);

    const head = await readHead(db, seed.groupId);
    expect(head.effective_evaluation_id).toBeNull();
    expect(head.generation).toBe(0);
    const receipts = (await receiptEvents(db, seed.groupId)).filter(
      (e) => e.action === ASSESSMENT_ACTIVATION_ACTION,
    );
    expect(receipts).toHaveLength(0);
  });

  it('结算端口返回 ineligible / failed_pending：head 前移但 receipt 如实记处置（不吞）', async () => {
    const db = testDb();
    const seed = await seedChain('act9');
    await seedEvaluation(seed, 'act9_ev1', { points: 80 });
    const seed2 = await seedChain('act9b');
    await seedEvaluation(seed2, 'act9b_ev1', { points: 40 });

    const r1 = await db.transaction((tx) =>
      activateEvaluation(
        tx,
        { evaluation_id: 'act9_ev1', expected_effective_id: null, expected_generation: 0 },
        { settle: async () => 'ineligible', actorRef: 'test', now: NOW },
      ),
    );
    expect(r1).toEqual({ status: 'activated', effect: 'ineligible', generation: 1 });

    const r2 = await db.transaction((tx) =>
      activateEvaluation(
        tx,
        { evaluation_id: 'act9b_ev1', expected_effective_id: null, expected_generation: 0 },
        { settle: async () => 'failed_pending', actorRef: 'test', now: NOW },
      ),
    );
    expect(r2).toEqual({ status: 'activated', effect: 'failed_pending', generation: 1 });

    const receipts = (await receiptEvents(db, seed.groupId))
      .concat(await receiptEvents(db, seed2.groupId))
      .filter((e) => e.action === ASSESSMENT_ACTIVATION_ACTION);
    expect(receipts).toHaveLength(2);
    const effects = receipts.map((e) => (e.payload as Record<string, unknown>).effect).sort();
    expect(effects).toEqual(['failed_pending', 'ineligible']);
  });

  // YUK-1095 — DB 层 CAS 兜底必须实际校验行数：哪怕锁内快照判定通过，
  // 一旦谓词在写入时命中 0 行（锁外写者/谓词漂移）也绝不写 receipt、
  // 绝不返回 activated。这里用结算端口模拟一个忽略锁序、在同一事务内
  // 推进 head generation 的写者。
  it('CAS 兜底：head UPDATE 命中 0 行 ⇒ cas_conflict stale_head，不写 receipt 不返回 activated', async () => {
    const db = testDb();
    const seed = await seedChain('act10');
    await seedEvaluation(seed, 'act10_ev1', { points: 80 });
    const settle = vi.fn(async (input: ActivationSettleInput) => {
      // 模拟锁外写者：把 head generation 推到 999（effective 不动）。
      await input.tx
        .update(evaluation_effective_head)
        .set({ generation: 999, updated_at: NOW })
        .where(eq(evaluation_effective_head.evaluation_group_id, seed.groupId));
      return 'applied' as const;
    });

    const result = await db.transaction((tx) =>
      activateEvaluation(
        tx,
        { evaluation_id: 'act10_ev1', expected_effective_id: null, expected_generation: 0 },
        { settle, actorRef: 'test', now: NOW },
      ),
    );

    expect(result).toEqual({ status: 'cas_conflict', conflict: 'stale_head' });
    // head 绝不被本次激活当成成功前移（effective 仍为 null），
    // 且不得写入 activation receipt（未执行的尝试不产 receipt）。
    const head = await readHead(db, seed.groupId);
    expect(head.effective_evaluation_id).toBeNull();
    const receipts = (await receiptEvents(db, seed.groupId)).filter(
      (e) => e.action === ASSESSMENT_ACTIVATION_ACTION,
    );
    expect(receipts).toHaveLength(0);
    expect(settle).toHaveBeenCalledTimes(1);
  });
});

describe('releaseIssuanceClaim（YUK-1045 §3.3 claim 到期语义）', () => {
  beforeEach(resetDb);

  it('claimed ⇒ released；verify 挂起的 lifecycle 不被复活；重复释放是 no-op', async () => {
    const db = testDb();
    const seed = await seedChain('rel1');

    // verify 挂起该组（撤回语义载体）。
    await db
      .update(question_group_lifecycle)
      .set({ suspended: true, suspension_reason: 'verify_hold', updated_at: NOW })
      .where(eq(question_group_lifecycle.group_id, seed.qid));

    const released = await db.transaction((tx) => releaseIssuanceClaim(tx, seed.issuanceId));
    expect(released).toEqual({ released: true });

    const [iss] = await db
      .select()
      .from(assessment_issuance)
      .where(eq(assessment_issuance.issuance_id, seed.issuanceId));
    if (!iss) throw new Error('issuance missing');
    expect(iss.claim_status).toBe('released');
    expect(iss.claimed_by_ref).toBeNull();

    // §3.3：claim 到期恢复不得复活被 verify 撤回的题 —— suspended 原样保留。
    const [lc] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, seed.qid));
    if (!lc) throw new Error('lifecycle missing');
    expect(lc.suspended).toBe(true);
    expect(lc.suspension_reason).toBe('verify_hold');
    expect(lc.scoring_admission_state).toBe('admitted'); // claim 释放不动 admission

    // 幂等：已 released 再释放 ⇒ false。
    const again = await db.transaction((tx) => releaseIssuanceClaim(tx, seed.issuanceId));
    expect(again).toEqual({ released: false });
  });
});
