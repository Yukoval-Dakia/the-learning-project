// YUK-1052 — issueAssessment / saveResponseDraft / saveSubmission DB 测试
//（db 分区；testcontainer + resetDb）。断言契约：
//   (1) 发题绑定不可变 revision/part/材料/呈现顺序（preselected≠issued）；显式
//       revision 不属于组 → revision_mismatch；in_progress 必须明确版本；
//   (2) ResponseSet 自动保存恢复覆盖发出范围；saving/saved 仅服务端 ack；
//   (3) 同 (group,idempotency_key) 幂等：一致→replayed、不同→conflict；
//       多 evaluation attempt 保持各自 submission 身份；
//   (4) 挂起不发新题，但已发题的挂起期间提交仍接收（§3.3 守恒）；
//   (5) 组行锁 + head 锚定第一份提交（多提交组 head 不重锚）。

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResponseSetT } from '@/core/schema/assessment';
import {
  assessment_issuance,
  assessment_submission,
  evaluation_effective_head,
  evaluation_group,
  event,
  learning_record,
  learning_session,
  material_fsrs_state,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import {
  type NormalizableQuestionRow,
  contractIntegrityDigest,
  normalizeQuestionRowToContract,
} from '@/server/questions/contract-normalizer';
import { publishQuestionGroup } from '@/server/questions/publisher';
import { Tutor } from '@/server/session';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { createSolveSubmissionResource } from '../../api/resource-routes';
import { startSolveSession } from '../solve-session';
import { issueAssessment } from './issue';
import { getIssuanceState, saveResponseDraft, saveSubmission } from './submit';

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

interface Published {
  qid: string;
  groupId: string;
  revisionId: string;
  slotId: string;
  optionIds: string[];
  partId: string;
  admissionGeneration: number;
}

/** 种子 + 发布 admitted 单题组，返回发题/作答所需的真实坐标。 */
async function publishAdmitted(
  qid: string,
  opts?: { claimPolicy?: 'one_time' | 'unbounded'; referenceOnly?: boolean },
): Promise<Published> {
  const db = testDb();
  await seedQuestion(qid);
  const [row] = await db.select().from(question).where(eq(question.id, qid)).limit(1);
  const n = normalizeQuestionRowToContract(row as NormalizableQuestionRow);
  if (opts?.referenceOnly) {
    const solutions = new Set(
      n.structure.materials
        .filter((material) => /^sol_[0-9a-f]{12}$/.test(material.asset.asset_id))
        .map((material) => material.material_id),
    );
    n.structure.materials = n.structure.materials.filter(
      (material) => !solutions.has(material.material_id),
    );
    for (const part of n.structure.parts)
      part.material_ids = part.material_ids.filter((id) => !solutions.has(id));
    n.integrity_digest = contractIntegrityDigest(n);
  }

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
    claimPolicy: opts?.claimPolicy,
    admission: { state: 'admitted', evidence: ADMITTED_EVIDENCE },
    actorRef: 'test:publish',
    now: NOW,
  });
  if (result.status !== 'published') throw new Error(`seed publish: ${result.status}`);
  const [lc] = await db
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, qid));
  const [rev] = await db
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, result.revision_id))
    .limit(1);
  const slot = rev.response_spec.slots[0];
  if (slot.kind !== 'single_choice') throw new Error('seed: expected single_choice slot');
  return {
    qid,
    groupId: qid,
    revisionId: result.revision_id,
    slotId: slot.slot_id,
    optionIds: slot.options.map((o) => o.option_id),
    partId: rev.structure.parts[0].part_id,
    admissionGeneration: lc.scoring_admission_generation,
  };
}

function rs(pub: Published): ResponseSetT {
  return { entries: [{ slot_id: pub.slotId, kind: 'choice', option_ids: [pub.optionIds[0]] }] };
}

// ---------- issueAssessment ----------

describe('issueAssessment', () => {
  beforeEach(resetDb);

  it('idempotent re-issue replays identical binding; divergent conflicts', async () => {
    const pub = await publishAdmitted('issR');
    const first = await issueAssessment(testDb(), {
      group_id: pub.groupId,
      issuance_id: 'iss_same',
      part_ids: [pub.partId],
    });
    expect(first.status).toBe('issued');
    const replay = await issueAssessment(testDb(), {
      group_id: pub.groupId,
      issuance_id: 'iss_same',
      part_ids: [pub.partId],
    });
    expect(replay.status).toBe('replayed');
    // 同 id 但绑定漂移（有效绑定不同 container 锚点）→ 显式冲突，不覆盖
    const conflict = await issueAssessment(testDb(), {
      group_id: pub.groupId,
      issuance_id: 'iss_same',
      part_ids: [pub.partId],
      container_occurrence_ref: 'occ_different',
    });
    expect(conflict.status).toBe('issuance_id_conflict');
    // 校验先行的非法绑定仍被 binding_invalid 拒（不发）
    const invalid = await issueAssessment(testDb(), {
      group_id: pub.groupId,
      issuance_id: 'iss_other',
      part_ids: ['ghost_part'],
    });
    expect(invalid.status).toBe('binding_invalid');
  });

  // P1-2（YUK-1091）：one_time claim 的重试命中自己持有的 issuance —— 幂等
  // 解析必须先于 claim 互斥判，否则正常重试被误报 claim_unavailable。
  it('atomically claims one-time issuance even when callers omit claim', async () => {
    const pub = await publishAdmitted('implicitClaim', { claimPolicy: 'one_time' });
    const requests = ['implicit_a', 'implicit_b'].map((issuance_id) => ({
      group_id: pub.groupId,
      issuance_id,
    }));
    const results = await Promise.all(
      requests.map((request) => issueAssessment(testDb(), request)),
    );
    expect(results.map((result) => result.status).sort()).toEqual(['claim_unavailable', 'issued']);
    const winner = results.find((result) => result.status === 'issued');
    if (!winner || winner.status !== 'issued') throw new Error('missing issuance');
    expect(winner.issuance.claim).toEqual({
      policy: 'one_time',
      status: 'claimed',
      claimed_by_ref: winner.issuance.issuance_id,
    });
    expect(
      await issueAssessment(testDb(), {
        group_id: pub.groupId,
        issuance_id: winner.issuance.issuance_id,
      }),
    ).toMatchObject({ status: 'replayed', issuance: winner.issuance });
  });

  it('one_time claim retry with same issuance_id replays instead of claim_unavailable', async () => {
    const pub = await publishAdmitted('issClaim', { claimPolicy: 'one_time' });
    const first = await issueAssessment(testDb(), {
      group_id: pub.groupId,
      issuance_id: 'iss_claim_1',
      claim: { claimed_by_ref: 'holder-a' },
    });
    expect(first.status).toBe('issued');
    if (first.status !== 'issued') return;

    // 逐字重试：同 id 同绑定同 claim —— replay，并如实返回已存 claim 状态。
    const retry = await issueAssessment(testDb(), {
      group_id: pub.groupId,
      issuance_id: 'iss_claim_1',
      claim: { claimed_by_ref: 'holder-a' },
    });
    expect(retry.status).toBe('replayed');
    if (retry.status !== 'replayed') return;
    expect(retry.issuance.claim).toEqual({
      policy: 'one_time',
      status: 'claimed',
      claimed_by_ref: 'holder-a',
    });
    expect(retry.issuance.issued_at).toBe(first.issuance.issued_at);
    expect(retry.issuance.binding.revision_id).toBe(pub.revisionId);

    // 另一个 claimer 抢同组 —— 互斥语义不变。
    const rival = await issueAssessment(testDb(), {
      group_id: pub.groupId,
      issuance_id: 'iss_claim_2',
      claim: { claimed_by_ref: 'holder-b' },
    });
    expect(rival.status).toBe('claim_unavailable');

    // claim 释放后：rival 可占；同 id 重试如实报告 released（持久状态非请求）。
    await testDb()
      .update(assessment_issuance)
      .set({ claim_status: 'released', claimed_by_ref: null })
      .where(eq(assessment_issuance.issuance_id, 'iss_claim_1'));
    const afterRelease = await issueAssessment(testDb(), {
      group_id: pub.groupId,
      issuance_id: 'iss_claim_1',
      claim: { claimed_by_ref: 'holder-a' },
    });
    expect(afterRelease.status).toBe('replayed');
    if (afterRelease.status === 'replayed') {
      expect(afterRelease.issuance.claim.status).toBe('released');
    }
    const rivalAfterRelease = await issueAssessment(testDb(), {
      group_id: pub.groupId,
      issuance_id: 'iss_claim_3',
      claim: { claimed_by_ref: 'holder-b' },
    });
    expect(rivalAfterRelease.status).toBe('issued');
  });
});

// ---------- saveSubmission ----------

describe('saveSubmission', () => {
  beforeEach(resetDb);

  it('same (group,idempotency_key) + identical payload replays; different payload conflicts', async () => {
    const pub = await publishAdmitted('sub2');
    const issued = await issueAssessment(testDb(), { group_id: pub.groupId });
    if (issued.status !== 'issued' && issued.status !== 'replayed') throw new Error('seed issue');
    const iid = issued.issuance.issuance_id;

    const first = await saveSubmission(testDb(), {
      issuance_id: iid,
      evaluation_group_id: 'g2',
      idempotency_key: 'same',
      response_set: rs(pub),
    });
    expect(first.status).toBe('saved');
    if (first.status !== 'saved') return;

    // 相同 payload 重试 → replayed，不新增行、不重复学习效应
    const replay = await saveSubmission(testDb(), {
      issuance_id: iid,
      evaluation_group_id: 'g2',
      idempotency_key: 'same',
      response_set: rs(pub),
    });
    expect(replay.status).toBe('replayed');
    if (replay.status === 'replayed') {
      expect(replay.submission.submission_id).toBe(first.submission.submission_id);
    }
    const subs = await testDb()
      .select()
      .from(assessment_submission)
      .where(eq(assessment_submission.evaluation_group_id, 'g2'));
    expect(subs).toHaveLength(1);

    // 相同 key 不同作答 → 显式冲突（不覆盖已接收作答）
    const conflict = await saveSubmission(testDb(), {
      issuance_id: iid,
      evaluation_group_id: 'g2',
      idempotency_key: 'same',
      response_set: {
        entries: [{ slot_id: pub.slotId, kind: 'choice', option_ids: [pub.optionIds[1]] }],
      },
    });
    expect(conflict.status).toBe('idempotency_conflict');
    if (conflict.status === 'idempotency_conflict') {
      expect(conflict.existing_submission_id).toBe(first.submission.submission_id);
    }
  });

  // P1-4（YUK-1091）：两个不同 issuance 并发首提同一新 evaluation_group ——
  // FOR UPDATE 锁不住不存在的行，组创建必须经 advisory 锁串行化；双方提交
  // 都应接收（不丢作答），组锚点包含两份 submission。
  it('serializes concurrent first submissions into one shared evaluation group', async () => {
    const pubA = await publishAdmitted('grpA');
    const pubB = await publishAdmitted('grpB');
    const issA = await issueAssessment(testDb(), { group_id: pubA.groupId });
    const issB = await issueAssessment(testDb(), { group_id: pubB.groupId });
    if (
      (issA.status !== 'issued' && issA.status !== 'replayed') ||
      (issB.status !== 'issued' && issB.status !== 'replayed')
    ) {
      throw new Error('seed');
    }

    const [outA, outB] = await Promise.all([
      saveSubmission(testDb(), {
        issuance_id: issA.issuance.issuance_id,
        evaluation_group_id: 'g_shared',
        idempotency_key: 'k-a',
        response_set: rs(pubA),
      }),
      saveSubmission(testDb(), {
        issuance_id: issB.issuance.issuance_id,
        evaluation_group_id: 'g_shared',
        idempotency_key: 'k-b',
        response_set: rs(pubB),
      }),
    ]);
    // 两笔都接收（advisory 锁 + 锁内重读，无 PK 撞车 500）。
    expect(outA.status).toBe('saved');
    expect(outB.status).toBe('saved');
    if (outA.status !== 'saved' || outB.status !== 'saved') return;

    const [grp] = await testDb()
      .select()
      .from(evaluation_group)
      .where(eq(evaluation_group.evaluation_group_id, 'g_shared'));
    expect(grp.submission_ids.sort()).toEqual(
      [outA.submission.submission_id, outB.submission.submission_id].sort(),
    );
    // 组内 head 只锚定一份提交（先落者）。
    const [head] = await testDb()
      .select()
      .from(evaluation_effective_head)
      .where(eq(evaluation_effective_head.evaluation_group_id, 'g_shared'));
    expect(head.generation).toBe(0);
  });

  // YUK-1052 / Q-922 — self_confidence（1-5，observe-only）契约+存储位验收。
  it('accepts optional self_confidence (1-5) on entries; persists on submission + draft; replays identically', async () => {
    const pub = await publishAdmitted('sub6');
    const issued = await issueAssessment(testDb(), { group_id: pub.groupId });
    if (issued.status !== 'issued' && issued.status !== 'replayed') throw new Error('seed issue');
    const iid = issued.issuance.issuance_id;

    const responseSet: ResponseSetT = {
      entries: [
        {
          slot_id: pub.slotId,
          kind: 'choice',
          option_ids: [pub.optionIds[0]],
          self_confidence: 4,
        },
      ],
    };

    // draft path accepts + restores it
    const draft = await saveResponseDraft(testDb(), {
      issuance_id: iid,
      evaluation_group_ref: 'g6',
      response_set: responseSet,
    });
    expect(draft.status).toBe('saved');
    const stateBefore = await getIssuanceState(testDb(), iid);
    expect(stateBefore.draft?.response_set.entries[0].self_confidence).toBe(4);

    // submission persists it on the immutable row
    const saved = await saveSubmission(testDb(), {
      issuance_id: iid,
      evaluation_group_id: 'g6',
      idempotency_key: 'k6',
      response_set: responseSet,
    });
    expect(saved.status).toBe('saved');
    if (saved.status !== 'saved') return;
    const [sub] = await testDb()
      .select()
      .from(assessment_submission)
      .where(eq(assessment_submission.submission_id, saved.submission.submission_id));
    expect(sub.response_set.entries[0].self_confidence).toBe(4);

    // identical replay (same key + same self_confidence) replays — canonical
    // 比较覆盖新字段；缺省/改值应判 conflict。
    const replay = await saveSubmission(testDb(), {
      issuance_id: iid,
      evaluation_group_id: 'g6',
      idempotency_key: 'k6',
      response_set: responseSet,
    });
    expect(replay.status).toBe('replayed');
    const changed = await saveSubmission(testDb(), {
      issuance_id: iid,
      evaluation_group_id: 'g6',
      idempotency_key: 'k6',
      response_set: {
        entries: [
          {
            slot_id: pub.slotId,
            kind: 'choice',
            option_ids: [pub.optionIds[0]],
            self_confidence: 2,
          },
        ],
      },
    });
    expect(changed.status).toBe('idempotency_conflict');
  });
});

describe('formal manual candidate and atomic activation', () => {
  beforeEach(resetDb);
  it('commits native solve input and session transitions atomically, replays once, and reveals only the frozen reference', async () => {
    const pub = await publishAdmitted('native_solve');
    const issued = await issueAssessment(testDb(), { group_id: pub.groupId });
    if (issued.status !== 'issued') throw new Error(issued.status);
    const session = await startSolveSession({
      db: testDb(),
      questionId: pub.qid,
      issuanceId: issued.issuance.issuance_id,
    });
    const key = `solve_${session.sessionId}`;
    const body = {
      question_id: pub.qid,
      student_text_steps: ['先列条件，再检查方向。'],
      student_final_answer_text: 'display text is not the scoring input',
      hints_used: 0,
      final_hint_level: 0,
      assessment: {
        issuance_id: issued.issuance.issuance_id,
        evaluation_group_id: key,
        idempotency_key: key,
        response_set: rs(pub),
      },
    };
    const send = (value = body) =>
      createSolveSubmissionResource(
        new Request('http://local/api/solve-sessions/s/submissions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(value),
        }),
        { sid: session.sessionId },
      );
    await testDb()
      .update(question)
      .set({ reference_md: 'NEW ANSWER MUST NOT LEAK' })
      .where(eq(question.id, pub.qid));
    const transition = vi
      .spyOn(Tutor, 'markJudgedTx')
      .mockRejectedValueOnce(new Error('session transition storage unavailable'));
    expect((await send()).status).toBe(500);
    transition.mockRestore();
    expect(await testDb().select().from(material_fsrs_state)).toHaveLength(0);
    expect(await testDb().select().from(learning_record)).toHaveLength(0);
    expect(await testDb().select().from(learning_session)).toMatchObject([
      { id: session.sessionId, status: 'active' },
    ]);
    const response = await send();
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result).toMatchObject({
      status: 'effective',
      judge: { coarse_outcome: 'incorrect' },
      revealed_solution_md: 'B',
    });
    expect(await testDb().select().from(learning_session)).toMatchObject([
      { id: session.sessionId, status: 'judged' },
    ]);
    const [capture] = await testDb()
      .select()
      .from(event)
      .where(eq(event.id, result.attempt_event_id));
    expect(capture).toMatchObject({
      action: 'experimental:assessment_attempt',
      outcome: null,
      payload: { reasoning_trace: '先列条件，再检查方向。', hints_used: 0, final_hint_level: 0 },
    });
    expect(await (await send()).json()).toMatchObject({
      attempt_event_id: result.attempt_event_id,
      assessment: { effect: 'idempotent_replay' },
    });
    expect(await testDb().select().from(learning_record)).toHaveLength(1);
    expect(await testDb().select().from(material_fsrs_state)).toMatchObject([
      { state: { reps: 1 } },
    ]);
    expect(
      (
        await send({
          ...body,
          assessment: {
            ...body.assessment,
            response_set: {
              entries: [{ slot_id: pub.slotId, kind: 'choice', option_ids: [pub.optionIds[1]] }],
            },
          },
        })
      ).status,
    ).toBe(409);
  });
});
