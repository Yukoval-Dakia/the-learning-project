// 原生 solve 提交路由 DB 测试（db 分区；testcontainer + resetDb）。
// 断言契约：提交与会话转移原子提交、replay 幂等、revealed 答案只来自冻结 revision。

import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResponseSetT } from '@/core/schema/assessment';
import {
  assessment_response_draft,
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
import { issueAssessment } from '@/kernel/records/assessment-issuance';
import {
  type NormalizableQuestionRow,
  contractIntegrityDigest,
  normalizeQuestionRowToContract,
} from '@/kernel/records/assessment-normalization';
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import { STUDY_ASSISTANCE_ACTION } from '@/kernel/records/study-reference';
import { resetDb, testDb } from '../../../../../../tests/helpers/db';
import { createSolveSubmissionResource } from '../../../api/resource-routes';
import { startSolveSession } from '../../../server/solve-session';
import * as Tutor from '../../../server/tutor-session';
import { createSubmission } from '../../api/assessment-route';
import { revealAnswerTool } from '../../tools/reveal-answer';
import { snapshotIssuanceAssistance } from './assistance';
import { saveResponseDraft } from './submit';

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
  // @invariant concurrency: 作答、会话与结算原子提交，重放复用冻结身份。
  // @fails-if 会话更新失败仍写入学习状态，或重放再次结算、返回可变参考答案。
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
    const issuedSlot = issued.practice_dto.response_spec.slots[0];
    if (issuedSlot.kind !== 'single_choice') throw new Error('seed: expected single_choice');
    const correctOption = issuedSlot.options.find(
      (option) => option.option_id === pub.optionIds[1],
    );
    if (!correctOption) throw new Error('seed: issued options missing stable id');
    expect(result).toMatchObject({
      status: 'effective',
      judge: { coarse_outcome: 'incorrect' },
      revealed_solution_md: `${correctOption.label}. ${correctOption.text}`,
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

describe('reveal_answer assistance recording', () => {
  beforeEach(resetDb);
  // @invariant security: the copilot give-answer path commits a solution/answer_help exposure on the issuance before the reference reaches the learner, so the later submission is excluded from independent mastery evidence @fails-if reference_md is returned without a committed assistance event, or an unissued question yields a reveal anyway
  it('reveals only against an open issuance and leaves an assisted record', async () => {
    const db = testDb();
    const pub = await publishAdmitted('reveal_assist');
    const toolCtx = {
      db,
      taskRunId: 'reveal-test',
      callerActor: { kind: 'agent' as const, ref: 'agent:copilot' },
    };

    expect(await revealAnswerTool.execute(toolCtx, { question_id: pub.groupId })).toMatchObject({
      status: 'no_open_issuance',
    });
    expect(await revealAnswerTool.execute(toolCtx, { question_id: 'never-seen' })).toMatchObject({
      status: 'unknown_question',
    });

    const issued = await issueAssessment(db, { group_id: pub.groupId });
    if (issued.status !== 'issued') throw new Error(issued.status);

    const revealed = await revealAnswerTool.execute(toolCtx, { question_id: pub.groupId });
    expect(revealed).toMatchObject({
      status: 'revealed',
      issuance_id: issued.issuance.issuance_id,
    });
    if (revealed.status !== 'revealed') throw new Error(revealed.status);
    const issuedSlot = issued.practice_dto.response_spec.slots[0];
    if (issuedSlot.kind !== 'single_choice') throw new Error('seed: expected single_choice');
    const correctOption = issuedSlot.options.find(
      (option) => option.option_id === pub.optionIds[1],
    );
    if (!correctOption) throw new Error('seed: issued options missing stable id');
    expect(revealed.reference_md).toContain(`${correctOption.label}. ${correctOption.text}`);
    expect(revealed.prompt_md.length).toBeGreaterThan(0);
    expect(revealed.practice_dto.issuance_id).toBe(issued.issuance.issuance_id);

    const exposures = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, STUDY_ASSISTANCE_ACTION),
          eq(event.subject_kind, 'issuance'),
          eq(event.subject_id, issued.issuance.issuance_id),
        ),
      );
    expect(exposures).toHaveLength(1);
    expect(exposures[0].payload).toMatchObject({ kind: 'solution', impact: 'answer_help' });
    expect(await snapshotIssuanceAssistance(db, issued.issuance.issuance_id)).toMatchObject({
      status: 'assisted',
    });

    const secondReveal = await revealAnswerTool.execute(toolCtx, {
      question_id: issued.issuance.binding.part_ids[0],
    });
    expect(secondReveal).toMatchObject({
      status: 'revealed',
      issuance_id: issued.issuance.issuance_id,
    });
    expect(
      (
        await db
          .select()
          .from(event)
          .where(
            and(
              eq(event.action, STUDY_ASSISTANCE_ACTION),
              eq(event.subject_kind, 'issuance'),
              eq(event.subject_id, issued.issuance.issuance_id),
            ),
          )
      ).length,
    ).toBe(1);

    const secondIssued = await issueAssessment(db, { group_id: pub.groupId });
    if (secondIssued.status !== 'issued') throw new Error(secondIssued.status);
    expect(await revealAnswerTool.execute(toolCtx, { question_id: pub.groupId })).toMatchObject({
      status: 'ambiguous',
    });
  });
});

describe('submission draft preservation', () => {
  beforeEach(resetDb);
  // @invariant concurrency: a newer committed draft survives a stale submission, while an accepted replay leaves later drafts untouched @fails-if stale input creates a submission/group/receipt or deletes the newer answer, or replay consumes another draft
  it('rejects stale input before writing and replays accepted input without consuming later drafts', async () => {
    const db = testDb();
    const pub = await publishAdmitted('draft_preservation');
    const issued = await issueAssessment(db, { group_id: pub.groupId });
    if (issued.status !== 'issued') throw new Error(issued.status);
    const issuance_id = issued.issuance.issuance_id;
    const responseA = rs(pub);
    const responseB: ResponseSetT = {
      entries: [{ slot_id: pub.slotId, kind: 'choice', option_ids: [pub.optionIds[1]] }],
    };
    const body = {
      issuance_id,
      evaluation_group_id: 'draft_group',
      idempotency_key: 'draft_submit',
      response_set: responseA,
      expected_save_epoch: 1,
    };
    const send = (value = body) =>
      createSubmission(
        new Request('http://local/api/submissions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(value),
        }),
      );
    expect(
      await saveResponseDraft(db, {
        issuance_id,
        response_set: responseA,
        evaluation_group_ref: body.evaluation_group_id,
      }),
    ).toMatchObject({ status: 'saved', save_epoch: 1 });
    const savedB = Promise.withResolvers<void>();
    const releaseB = Promise.withResolvers<void>();
    let blocker = 0;
    const savingB = db.transaction(async (tx) => {
      expect(
        await saveResponseDraft(tx, {
          issuance_id,
          response_set: responseB,
          evaluation_group_ref: body.evaluation_group_id,
          expected_save_epoch: 1,
        }),
      ).toMatchObject({ status: 'saved', save_epoch: 2 });
      const [connection] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      blocker = connection.pid;
      savedB.resolve();
      await releaseB.promise;
    });
    await Promise.race([savedB.promise, savingB]);
    const submitting = send();
    try {
      await expect
        .poll(async () => {
          const waiting = await db.execute(sql`
          select pid, wait_event_type, wait_event, pg_blocking_pids(pid) as blockers
          from pg_stat_activity
          where datname = current_database() and ${blocker} = any(pg_blocking_pids(pid))
        `);
          if (waiting.length) console.log('issuance lock wait', JSON.stringify(waiting));
          return waiting.length;
        })
        .toBeGreaterThan(0);
    } finally {
      releaseB.resolve();
      await savingB;
    }
    const stale = await submitting;
    const staleBody = await stale.json();
    const drafts = await db.select().from(assessment_response_draft);
    console.log(
      'draft preservation boundary',
      JSON.stringify({
        status: stale.status,
        body: staleBody,
        drafts,
        submissions: await db.select().from(assessment_submission),
        groups: await db.select().from(evaluation_group),
      }),
    );
    expect(stale.status).toBe(409);
    expect(staleBody).toMatchObject({ error: 'stale_draft', details: { current_save_epoch: 2 } });
    expect(drafts).toMatchObject([{ response_set: responseB, save_epoch: 2 }]);
    expect(await db.select().from(assessment_submission)).toHaveLength(0);
    expect(await db.select().from(evaluation_group)).toHaveLength(0);
    expect(await db.select().from(evaluation_effective_head)).toHaveLength(0);
    expect(
      await db.select().from(event).where(eq(event.action, 'experimental:assessment_submission')),
    ).toHaveLength(0);
    const accepted = await send({ ...body, response_set: responseB, expected_save_epoch: 2 });
    expect(accepted.status).toBe(201);
    const receipt = await accepted.json();
    expect(
      await saveResponseDraft(db, {
        issuance_id,
        response_set: responseA,
        evaluation_group_ref: 'later_group',
      }),
    ).toMatchObject({ status: 'saved' });
    const later = await db.select().from(assessment_response_draft);
    const replay = await send({ ...body, response_set: responseB, expected_save_epoch: 0 });
    expect(await replay.json()).toMatchObject({
      status: 'replayed',
      submission: receipt.submission,
    });
    expect(await db.select().from(assessment_response_draft)).toEqual(later);
    expect(await db.select().from(assessment_submission)).toHaveLength(1);
    expect(
      await db.select().from(event).where(eq(event.action, 'experimental:assessment_submission')),
    ).toHaveLength(1);
    expect(await (await send()).json()).toMatchObject({ error: 'idempotency_conflict' });
  });
});
