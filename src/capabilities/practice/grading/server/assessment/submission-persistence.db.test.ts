// 原生 solve 提交路由 DB 测试（db 分区；testcontainer + resetDb）。
// 断言契约：提交与会话转移原子提交、replay 幂等、revealed 答案只来自冻结 revision。

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResponseSetT } from '@/core/schema/assessment';
import {
  event,
  learning_record,
  learning_session,
  material_fsrs_state,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { issueAssessment } from '@/kernel/records/assessment-issuance';
import {
  type NormalizableQuestionRow,
  contractIntegrityDigest,
  normalizeQuestionRowToContract,
} from '@/kernel/records/assessment-normalization';
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import { resetDb, testDb } from '../../../../../../tests/helpers/db';
import { createSolveSubmissionResource } from '../../../api/resource-routes';
import { startSolveSession } from '../../../server/solve-session';
import * as Tutor from '../../../server/tutor-session';

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
