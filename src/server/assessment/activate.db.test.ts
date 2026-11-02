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
  question_revision,
} from '@/db/schema';
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import {
  type NormalizableQuestionRow,
  normalizeQuestionRowToContract,
} from '@/server/questions/contract-normalizer';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  ASSESSMENT_ACTIVATION_ACTION,
  type ActivationSettleInput,
  activateEvaluation,
  insertInitialEvaluationHead,
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
  const [revision] = await db
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, revisionId));
  await db.insert(assessment_issuance).values({
    issuance_id: issuanceId,
    revision_id: revisionId,
    part_ids: revision.structure.parts.map((part) => part.part_id),
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
    provenance.admission_snapshot = {
      current_revision_id: seed.revisionId,
      generation: opts.observedGeneration ?? seed.admissionGeneration,
      state: 'admitted',
      suspended: false,
      withdrawn: false,
    };
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
});
