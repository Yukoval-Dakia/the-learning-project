import { activateSubmissionCandidate } from '../judge/evaluate-submission';
import { recordAssistanceExposure } from './assistance';
import { commitFormalAttempt, previewFormalAttempt } from './attempt';
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
  assessment_response_draft,
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  evaluation_group,
  event,
  mastery_state,
  material_fsrs_state,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import {
  type NormalizableQuestionRow,
  normalizeQuestionRowToContract,
} from '@/server/questions/contract-normalizer';
import { publishQuestionGroup } from '@/server/questions/publisher';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { POST as previewAdvice } from '../../api/advice';
import { AttemptResponseSchema } from '../../api/contracts';
import { GET as questionDetail } from '../../api/question-detail';
import { createAttempt } from '../../api/submit';
import { planSolveHint, startSolveSession } from '../solve-session';
import { issueAssessment } from './issue';
import { revealFrozenStudyReference } from './study-context';
import {
  getIssuanceState,
  listResponseDraftsByGroup,
  saveResponseDraft,
  saveSubmission,
} from './submit';

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
  opts?: { claimPolicy?: 'one_time' | 'unbounded' },
): Promise<Published> {
  const db = testDb();
  await seedQuestion(qid);
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

async function setSuspended(
  groupId: string,
  reason: 'verify_hold' | 'retraction_hold' = 'verify_hold',
) {
  await testDb()
    .update(question_group_lifecycle)
    .set({ suspended: true, suspension_reason: reason })
    .where(eq(question_group_lifecycle.group_id, groupId));
}
async function setWithdrawn(groupId: string) {
  await testDb()
    .update(question_group_lifecycle)
    .set({ withdrawn: true, withdrawn_at: NOW })
    .where(eq(question_group_lifecycle.group_id, groupId));
}
async function setUnadmitted(groupId: string) {
  // admission_branch_ck：withheld 必须带 withheld_reason。
  await testDb()
    .update(question_group_lifecycle)
    .set({ scoring_admission_state: 'withheld', scoring_admission_withheld_reason: 'owner_hold' })
    .where(eq(question_group_lifecycle.group_id, groupId));
}

function rs(pub: Published): ResponseSetT {
  return { entries: [{ slot_id: pub.slotId, kind: 'choice', option_ids: [pub.optionIds[0]] }] };
}

// ---------- issueAssessment ----------

describe('issueAssessment', () => {
  beforeEach(resetDb);

  it('pins immutable revision/part/material/option-order binding at serve time', async () => {
    const pub = await publishAdmitted('iss1');
    const out = await issueAssessment(testDb(), {
      group_id: pub.groupId,
      actorRef: 'test:issue',
      now: NOW,
    });
    expect(out.status).toBe('issued');
    if (out.status !== 'issued') return;
    expect(out.issuance.binding.revision_id).toBe(pub.revisionId);
    expect(out.issuance.binding.part_ids).toEqual([pub.partId]);
    expect(out.practice_dto.faces.length).toBe(1);
    expect(out.admission_generation_observed).toBe(pub.admissionGeneration);
    // row is immutable bound
    const [row] = await testDb()
      .select()
      .from(assessment_issuance)
      .where(eq(assessment_issuance.issuance_id, out.issuance.issuance_id));
    expect(row.revision_id).toBe(pub.revisionId);
    expect(row.option_order).toEqual([{ slot_id: pub.slotId, option_ids: pub.optionIds }]);
  });

  it('explicit revision_id wins and must belong to the group', async () => {
    const a = await publishAdmitted('issA');
    const b = await publishAdmitted('issB');
    // 显式 revision 但属于另一组 → revision_mismatch（不发 latest）
    const wrong = await issueAssessment(testDb(), {
      group_id: a.groupId,
      revision_id: b.revisionId,
    });
    expect(wrong.status).toBe('revision_mismatch');
    // 显式正确 revision → issued
    const ok = await issueAssessment(testDb(), {
      group_id: a.groupId,
      revision_id: a.revisionId,
    });
    expect(ok.status).toBe('issued');
  });

  it('rejects suspended / withdrawn / unadmitted / unpublished groups', async () => {
    const suspended = await publishAdmitted('issS');
    await setSuspended(suspended.groupId);
    expect((await issueAssessment(testDb(), { group_id: suspended.groupId })).status).toBe(
      'suspended',
    );

    const withdrawn = await publishAdmitted('issW');
    await setWithdrawn(withdrawn.groupId);
    expect((await issueAssessment(testDb(), { group_id: withdrawn.groupId })).status).toBe(
      'withdrawn',
    );

    const unadmitted = await publishAdmitted('issU');
    await setUnadmitted(unadmitted.groupId);
    expect((await issueAssessment(testDb(), { group_id: unadmitted.groupId })).status).toBe(
      'not_admitted',
    );

    const never = await publishAdmitted('issP');
    // 从未发布：手工删掉 lifecycle，模拟“尚无 published revision”状态
    await testDb()
      .delete(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, never.groupId));
    expect((await issueAssessment(testDb(), { group_id: 'issP' })).status).toBe('unpublished');
    expect((await issueAssessment(testDb(), { group_id: 'issGhost' })).status).toBe('not_found');
  });

  it('manual mode bypasses admission gate (D9)', async () => {
    const pub = await publishAdmitted('issM');
    await setUnadmitted(pub.groupId);
    const manual = await issueAssessment(testDb(), { group_id: pub.groupId, mode: 'manual' });
    expect(manual.status).toBe('issued');
  });

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

// ---------- saveResponseDraft + getIssuanceState ----------

describe('saveResponseDraft / pending restore', () => {
  beforeEach(resetDb);

  it('saves draft only via server ack and restores pending state', async () => {
    const pub = await publishAdmitted('dr1');
    const issued = await issueAssessment(testDb(), { group_id: pub.groupId });
    if (issued.status !== 'issued' && issued.status !== 'replayed') throw new Error('seed issue');
    const iid = issued.issuance.issuance_id;

    const saved = await saveResponseDraft(testDb(), {
      issuance_id: iid,
      evaluation_group_ref: 'grp_paper',
      response_set: rs(pub),
      expected_save_epoch: 0,
    });
    expect(saved.status).toBe('saved');
    if (saved.status !== 'saved') return;
    expect(saved.save_epoch).toBe(1);

    const state = await getIssuanceState(testDb(), iid);
    expect(state.draft?.response_set).toEqual(rs(pub));
    expect(state.draft?.evaluation_group_ref).toBe('grp_paper');
    expect(state.draft?.save_epoch).toBe(1);
    expect(state.submissions).toEqual([]);
  });

  it('upserts in place (one live draft per issuance) and stale epoch is rejected', async () => {
    const pub = await publishAdmitted('dr2');
    const issued = await issueAssessment(testDb(), { group_id: pub.groupId });
    if (issued.status !== 'issued' && issued.status !== 'replayed') throw new Error('seed issue');
    const iid = issued.issuance.issuance_id;

    await saveResponseDraft(testDb(), { issuance_id: iid, response_set: rs(pub) });
    const second = await saveResponseDraft(testDb(), {
      issuance_id: iid,
      response_set: rs(pub),
      expected_save_epoch: 1,
    });
    expect(second.status).toBe('saved');
    if (second.status !== 'saved') return;
    expect(second.save_epoch).toBe(2);

    // stale client: expected 1 but server is at 2 → reject (no silent overwrite)
    const stale = await saveResponseDraft(testDb(), {
      issuance_id: iid,
      response_set: rs(pub),
      expected_save_epoch: 1,
    });
    expect(stale.status).toBe('stale_draft');
    if (stale.status === 'stale_draft') expect(stale.current_save_epoch).toBe(2);

    // still exactly one draft row
    const rows = await testDb()
      .select()
      .from(assessment_response_draft)
      .where(eq(assessment_response_draft.issuance_id, iid));
    expect(rows).toHaveLength(1);
  });

  it('rejects response referencing slots outside the issued scope', async () => {
    const pub = await publishAdmitted('dr3');
    const issued = await issueAssessment(testDb(), { group_id: pub.groupId });
    if (issued.status !== 'issued' && issued.status !== 'replayed') throw new Error('seed issue');
    const out = await saveResponseDraft(testDb(), {
      issuance_id: issued.issuance.issuance_id,
      response_set: {
        entries: [
          { slot_id: 'ghost::slot', kind: 'choice', option_ids: ['x'] },
          { slot_id: pub.slotId, kind: 'choice', option_ids: [pub.optionIds[0]] },
        ],
      },
    });
    expect(out.status).toBe('invalid_response');
    expect(
      (
        await testDb()
          .select()
          .from(assessment_response_draft)
          .where(eq(assessment_response_draft.issuance_id, issued.issuance.issuance_id))
      ).length,
    ).toBe(0);
  });

  it('issuance_not_found for unknown issuance', async () => {
    const out = await saveResponseDraft(testDb(), {
      issuance_id: 'iss_none',
      response_set: { entries: [] },
    });
    expect(out.status).toBe('issuance_not_found');
  });

  // P1-3（YUK-1091）：提交删草稿后，迟到的 autosave 不得把已提交作答重建为
  // live draft —— submission 行即 tombstone（按草稿声明的组锚点判定）。
  it('rejects a late autosave after the submission cleared the draft', async () => {
    const pub = await publishAdmitted('drSub');
    const issued = await issueAssessment(testDb(), { group_id: pub.groupId });
    if (issued.status !== 'issued' && issued.status !== 'replayed') throw new Error('seed');
    const iid = issued.issuance.issuance_id;

    await saveResponseDraft(testDb(), {
      issuance_id: iid,
      evaluation_group_ref: 'g-late',
      response_set: rs(pub),
    });
    const submitted = await saveSubmission(testDb(), {
      issuance_id: iid,
      evaluation_group_id: 'g-late',
      idempotency_key: 'k-late',
      response_set: rs(pub),
    });
    expect(submitted.status).toBe('saved');

    // 带 ref 的迟到 autosave → 拒收（返回已接收提交的锚点）。
    const lateScoped = await saveResponseDraft(testDb(), {
      issuance_id: iid,
      evaluation_group_ref: 'g-late',
      response_set: rs(pub),
      expected_save_epoch: 1,
    });
    expect(lateScoped.status).toBe('already_submitted');
    if (lateScoped.status === 'already_submitted' && submitted.status === 'saved') {
      expect(lateScoped.existing_submission_id).toBe(submitted.submission.submission_id);
    }

    // 未定组的迟到 autosave：本 issuance 已有提交 ⇒ 该草稿所属尝试已被归档。
    const lateUnset = await saveResponseDraft(testDb(), {
      issuance_id: iid,
      response_set: rs(pub),
    });
    expect(lateUnset.status).toBe('already_submitted');

    // 断言没有被重建 live draft；state 视图也不报待办草稿。
    const rows = await testDb()
      .select()
      .from(assessment_response_draft)
      .where(eq(assessment_response_draft.issuance_id, iid));
    expect(rows).toHaveLength(0);
    const state = await getIssuanceState(testDb(), iid);
    expect(state.draft).toBeNull();
    expect(state.submissions).toHaveLength(1);
    const [stored] = await testDb()
      .select()
      .from(assessment_submission)
      .where(eq(assessment_submission.submission_id, state.submissions[0].submission_id));
    expect(state.submissions[0]).toMatchObject({
      response_set: stored.response_set,
      group_evidence: stored.group_evidence,
      idempotency_key: stored.idempotency_key,
    });

    // 另一次尝试（新组锚点）仍允许新草稿 —— tombstone 不误伤下一题面。
    const next = await saveResponseDraft(testDb(), {
      issuance_id: iid,
      evaluation_group_ref: 'g-next',
      response_set: rs(pub),
    });
    expect(next.status).toBe('saved');
    const stateAfter = await getIssuanceState(testDb(), iid);
    expect(stateAfter.draft?.evaluation_group_ref).toBe('g-next');
  });
});

// ---------- saveSubmission ----------

describe('saveSubmission', () => {
  beforeEach(resetDb);

  // P1-5（YUK-1091）：恢复读面补回 practice_dto + admission_generation_observed
  // —— 只有 issuance_id 也能恢复题面并带上激活 CAS 锚点。
  it('returns practice_dto and issuance-time admission_generation in the recovery snapshot', async () => {
    const pub = await publishAdmitted('snap1');
    const issued = await issueAssessment(testDb(), { group_id: pub.groupId });
    if (issued.status !== 'issued' && issued.status !== 'replayed') throw new Error('seed');
    const iid = issued.issuance.issuance_id;

    const state = await getIssuanceState(testDb(), iid);
    expect(state.issuance?.issuance_id).toBe(iid);
    // practice_dto 由冻结绑定 + pinned revision 重建，与发题时返回的一致。
    expect(state.practice_dto?.issuance_id).toBe(iid);
    expect(state.practice_dto?.revision_id).toBe(pub.revisionId);
    expect(state.practice_dto?.faces).toHaveLength(1);
    expect(state.practice_dto?.response_spec.slots).toHaveLength(1);
    // 观测到的发题时 admission generation（发题事件载荷）。
    expect(state.admission_generation_observed).toBe(pub.admissionGeneration);

    // 修复前遗留的脏行兜底：草稿指向已提交组也不报 pending。
    const submitted = await saveSubmission(testDb(), {
      issuance_id: iid,
      evaluation_group_id: 'g-snap',
      idempotency_key: 'k-snap',
      response_set: rs(pub),
    });
    expect(submitted.status).toBe('saved');
    await testDb()
      .insert(assessment_response_draft)
      .values({
        issuance_id: iid,
        evaluation_group_ref: 'g-snap',
        response_set: rs(pub),
        group_evidence: [],
        save_epoch: 1,
        updated_at: NOW,
      });
    const after = await getIssuanceState(testDb(), iid);
    expect(after.draft).toBeNull();
    expect(after.submissions).toHaveLength(1);
  });

  it('persists immutable submission pinned to issued revision; clears draft; anchors head', async () => {
    const pub = await publishAdmitted('sub1');
    const issued = await issueAssessment(testDb(), { group_id: pub.groupId });
    if (issued.status !== 'issued' && issued.status !== 'replayed') throw new Error('seed issue');
    const iid = issued.issuance.issuance_id;

    // 先自动保存草稿，提交后必须被清掉（同一组锚点）
    await saveResponseDraft(testDb(), {
      issuance_id: iid,
      evaluation_group_ref: 'g1',
      response_set: rs(pub),
    });

    const out = await saveSubmission(testDb(), {
      issuance_id: iid,
      evaluation_group_id: 'g1',
      idempotency_key: 'k1',
      response_set: rs(pub),
    });
    expect(out.status).toBe('saved');
    if (out.status !== 'saved') return;
    expect(out.revision_id).toBe(pub.revisionId);
    expect(out.issuance_id).toBe(iid);

    // immutable submission row
    const [sub] = await testDb()
      .select()
      .from(assessment_submission)
      .where(eq(assessment_submission.submission_id, out.submission.submission_id));
    expect(sub.revision_id).toBe(pub.revisionId);
    expect(sub.idempotency_key).toBe('k1');

    // group anchors the submission
    const [grp] = await testDb()
      .select()
      .from(evaluation_group)
      .where(eq(evaluation_group.evaluation_group_id, 'g1'));
    expect(grp.submission_ids).toEqual([out.submission.submission_id]);

    // initial effective head anchored to first submission (§11 same-tx invariant)
    const [head] = await testDb()
      .select()
      .from(evaluation_effective_head)
      .where(eq(evaluation_effective_head.evaluation_group_id, 'g1'));
    expect(head.submission_id).toBe(out.submission.submission_id);
    expect(head.effective_evaluation_id).toBeNull();
    expect(head.generation).toBe(0);

    // draft cleared on submit
    const drafts = await testDb()
      .select()
      .from(assessment_response_draft)
      .where(eq(assessment_response_draft.issuance_id, iid));
    expect(drafts).toHaveLength(0);

    // state view shows submitted anchor
    const state = await getIssuanceState(testDb(), iid);
    expect(state.submissions.map((s) => s.submission_id)).toEqual([out.submission.submission_id]);
    expect(state.draft).toBeNull();
  });

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

  it('multiple evaluation attempts keep separate submission identities', async () => {
    const pub = await publishAdmitted('sub3');
    const issued = await issueAssessment(testDb(), { group_id: pub.groupId });
    if (issued.status !== 'issued' && issued.status !== 'replayed') throw new Error('seed issue');
    const iid = issued.issuance.issuance_id;

    const s1 = await saveSubmission(testDb(), {
      issuance_id: iid,
      evaluation_group_id: 'g3',
      idempotency_key: 'k-a',
      response_set: rs(pub),
    });
    const s2 = await saveSubmission(testDb(), {
      issuance_id: iid,
      evaluation_group_id: 'g3',
      idempotency_key: 'k-b',
      response_set: {
        entries: [{ slot_id: pub.slotId, kind: 'choice', option_ids: [pub.optionIds[1]] }],
      },
    });
    expect(s1.status).toBe('saved');
    expect(s2.status).toBe('saved');
    if (s1.status !== 'saved' || s2.status !== 'saved') return;
    expect(s1.submission.submission_id).not.toBe(s2.submission.submission_id);

    const [grp] = await testDb()
      .select()
      .from(evaluation_group)
      .where(eq(evaluation_group.evaluation_group_id, 'g3'));
    expect(grp.submission_ids.sort()).toEqual(
      [s1.submission.submission_id, s2.submission.submission_id].sort(),
    );
    // head stays anchored to first submission (multi-submission group)
    const [head] = await testDb()
      .select()
      .from(evaluation_effective_head)
      .where(eq(evaluation_effective_head.evaluation_group_id, 'g3'));
    expect(head.submission_id).toBe(s1.submission.submission_id);
  });

  it('submission during suspension is still accepted (received-work conservation §3.3)', async () => {
    const pub = await publishAdmitted('sub4');
    const issued = await issueAssessment(testDb(), { group_id: pub.groupId });
    if (issued.status !== 'issued' && issued.status !== 'replayed') throw new Error('seed issue');
    await setSuspended(pub.groupId);
    const out = await saveSubmission(testDb(), {
      issuance_id: issued.issuance.issuance_id,
      evaluation_group_id: 'g4',
      idempotency_key: 'k4',
      response_set: rs(pub),
    });
    expect(out.status).toBe('saved');
  });

  it('rejects response outside issued scope and unknown issuance', async () => {
    const pub = await publishAdmitted('sub5');
    const issued = await issueAssessment(testDb(), { group_id: pub.groupId });
    if (issued.status !== 'issued' && issued.status !== 'replayed') throw new Error('seed issue');
    const bad = await saveSubmission(testDb(), {
      issuance_id: issued.issuance.issuance_id,
      evaluation_group_id: 'g5',
      idempotency_key: 'k5',
      response_set: {
        entries: [{ slot_id: 'not::issued', kind: 'choice', option_ids: ['z'] }],
      },
    });
    expect(bad.status).toBe('invalid_response');
    const none = await saveSubmission(testDb(), {
      issuance_id: 'iss_none',
      evaluation_group_id: 'g5',
      idempotency_key: 'k5',
      response_set: { entries: [] },
    });
    expect(none.status).toBe('issuance_not_found');
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

  it('rejects out-of-range / non-integer self_confidence (schema_invalid → invalid_response)', async () => {
    const pub = await publishAdmitted('sub7');
    const issued = await issueAssessment(testDb(), { group_id: pub.groupId });
    if (issued.status !== 'issued' && issued.status !== 'replayed') throw new Error('seed issue');
    const iid = issued.issuance.issuance_id;
    for (const badConf of [0, 6, 3.5]) {
      const out = await saveSubmission(testDb(), {
        issuance_id: iid,
        evaluation_group_id: 'g7',
        idempotency_key: `k7-${badConf}`,
        response_set: {
          entries: [
            {
              slot_id: pub.slotId,
              kind: 'choice',
              option_ids: [pub.optionIds[0]],
              // 刻意越界（0/6/3.5）：schema 必须在入口拒收为 schema_invalid
              self_confidence: badConf,
            },
          ],
        },
      });
      expect(out.status).toBe('invalid_response');
    }
    // 越界 draft 同样拒收（同口径）
    const badDraft = await saveResponseDraft(testDb(), {
      issuance_id: iid,
      response_set: {
        entries: [
          {
            slot_id: pub.slotId,
            kind: 'choice',
            option_ids: [pub.optionIds[0]],
            // 刻意越界：draft 校验与提交同口径
            self_confidence: 9,
          },
        ],
      },
    });
    expect(badDraft.status).toBe('invalid_response');
  });
});

// ---------- listResponseDraftsByGroup ----------

describe('listResponseDraftsByGroup (paper session restore)', () => {
  beforeEach(resetDb);

  it('returns all live drafts sharing a group anchor for a paper session', async () => {
    const a = await publishAdmitted('papA');
    const b = await publishAdmitted('papB');
    for (const pub of [a, b]) {
      const issued = await issueAssessment(testDb(), { group_id: pub.groupId });
      if (issued.status !== 'issued' && issued.status !== 'replayed') throw new Error('seed');
      await saveResponseDraft(testDb(), {
        issuance_id: issued.issuance.issuance_id,
        evaluation_group_ref: 'paper_grp',
        response_set: rs(pub),
      });
    }
    const drafts = await listResponseDraftsByGroup(testDb(), 'paper_grp');
    expect(drafts).toHaveLength(2);
    expect(drafts.map((d) => d.issuance_id).every(Boolean)).toBe(true);
    expect(await listResponseDraftsByGroup(testDb(), 'empty_grp')).toEqual([]);
  });
});

describe('formal manual candidate and atomic activation', () => {
  beforeEach(resetDb);
  it('preview and commit use one frozen candidate through the actual HTTP handlers', async () => {
    const pub = await publishAdmitted('preview_commit_api');
    const issued = await issueAssessment(testDb(), { group_id: pub.groupId });
    if (issued.status !== 'issued') throw new Error(issued.status);
    const assessment = {
      issuance_id: issued.issuance.issuance_id,
      evaluation_group_id: 'api_group',
      idempotency_key: 'api_answer',
      response_set: rs(pub),
    };
    const request = (body: unknown) =>
      new Request('http://local/api/attempts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const preview = await previewAdvice(request({ question_id: pub.qid, assessment }));
    expect(preview.status).toBe(200);
    const advice = await preview.json();
    expect(advice).toMatchObject({
      automatic_commit: true,
      judge: { coarse_outcome: 'incorrect' },
    });
    expect(await testDb().select().from(material_fsrs_state)).toHaveLength(0);
    const body = {
      question_id: pub.qid,
      rating: 'good',
      auto_rate: true,
      assessment,
      activation_intent: advice.activation_intent,
    };
    const committed = await createAttempt(request(body));
    expect(committed.status).toBe(200);
    expect(await committed.json()).toMatchObject({
      status: 'effective',
      assessment: { candidate_id: advice.candidate_id, effect: 'applied' },
      judge: { suggested_rating: 'again' },
    });
    expect((await createAttempt(request(body))).status).toBe(200);
    expect(await testDb().select().from(evaluation)).toHaveLength(1);
    expect(await testDb().select().from(material_fsrs_state)).toMatchObject([
      { state: { reps: 1 } },
    ]);
    expect(await testDb().select().from(event).where(eq(event.action, 'review'))).toHaveLength(0);
    expect(
      (
        await createAttempt(
          request({
            ...body,
            activation_intent: { ...advice.activation_intent, evaluation_id: 'eva_unrelated' },
          }),
        )
      ).status,
    ).toBe(409);
  });

  it('teaches and reveals the issued reference after current-row edits, with server assistance recorded', async () => {
    const pub = await publishAdmitted('study_native');
    const issued = await issueAssessment(testDb(), { group_id: pub.groupId });
    if (issued.status !== 'issued') throw new Error(issued.status);
    const generate = vi
      .fn()
      .mockRejectedValue(new Error('native start must not generate a new solution'));
    const session = await startSolveSession({
      db: testDb(),
      questionId: pub.qid,
      issuanceId: issued.issuance.issuance_id,
      runTaskFn: generate,
    });
    expect(generate).not.toHaveBeenCalled();
    await testDb()
      .update(question)
      .set({
        reference_md: 'NEW PRIVATE ANSWER',
        prompt_md: 'NEW QUESTION',
        metadata: { private_answer: 'NEW PRIVATE ANSWER' },
      })
      .where(eq(question.id, pub.qid));
    const detail = await questionDetail(
      new Request(`http://local/api/questions/${pub.qid}?surface=practice`),
      { id: pub.qid },
    );
    expect(await detail.json()).toMatchObject({
      reference_md: null,
      rubric_json: null,
      metadata: {},
    });
    const hintRunner = vi
      .fn()
      .mockResolvedValue({ text: JSON.stringify({ text_md: '先比较题目给出的三个选项。' }) });
    await planSolveHint({
      db: testDb(),
      sessionId: session.sessionId,
      hintIndex: 0,
      runTaskFn: hintRunner,
    });
    expect(hintRunner).toHaveBeenCalledOnce();
    expect(hintRunner.mock.calls[0][1]).toMatchObject({
      learning_item: { one_line_intent: `题面 ${pub.qid}` },
      atomic_sections: { worked_solution: 'B' },
    });
    await expect(
      planSolveHint({
        db: testDb(),
        sessionId: session.sessionId,
        hintIndex: 1,
        issuanceId: 'another_issuance',
        runTaskFn: hintRunner,
      }),
    ).rejects.toMatchObject({ code: 'coordinate_mismatch' });
    expect(hintRunner).toHaveBeenCalledOnce();
    expect(await revealFrozenStudyReference(testDb(), issued.issuance.issuance_id)).toEqual({
      reference_md: 'B',
    });
    const exposures = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_assistance'));
    expect(exposures.map((row) => row.payload.impact).sort()).toEqual(['answer_help', 'unknown']);
    expect(JSON.stringify(exposures)).not.toContain('NEW PRIVATE');
  });
  it.each(['answer_help', 'unknown'] as const)(
    'freezes %s assistance and permits only explicit FSRS while retaining the score',
    async (impact) => {
      const pub = await publishAdmitted(`assistance_${impact}`);
      const issued = await issueAssessment(testDb(), { group_id: pub.groupId });
      if (issued.status !== 'issued') throw new Error(issued.status);
      await recordAssistanceExposure(testDb(), {
        issuanceId: issued.issuance.issuance_id,
        questionId: pub.qid,
        kind: 'hint',
        impact,
        contentDigest: `sha256:${'a'.repeat(64)}`,
      });
      const request = {
        issuance_id: issued.issuance.issuance_id,
        evaluation_group_id: `assisted_${impact}`,
        idempotency_key: 'answer',
        response_set: {
          entries: [
            { slot_id: pub.slotId, kind: 'choice' as const, option_ids: [pub.optionIds[1]] },
          ],
        },
      };
      const preview = await previewFormalAttempt(testDb(), 'advice_preview', pub.qid, request);
      expect(preview.candidate.result.coarse_outcome).toBe('correct');
      expect(preview.candidate.evaluation.record.provenance).toMatchObject({ assisted: true });
      expect(preview.automatic_commit).toBe(false);
      expect(await testDb().select().from(material_fsrs_state)).toHaveLength(0);
      const committed = await commitFormalAttempt(testDb(), 'solo_submit', pub.qid, request, {
        activationIntent: preview.activation_intent,
        userRating: 'hard',
      });
      expect(committed.status).toBe('effective');
      expect(committed.candidate.evaluation.record.evaluation_id).toBe(
        preview.candidate.evaluation.record.evaluation_id,
      );
      expect(await testDb().select().from(mastery_state)).toHaveLength(0);
      expect(await testDb().select().from(material_fsrs_state)).toMatchObject([
        { state: { reps: 1 } },
      ]);
    },
  );

  it('does not penalize verified harmless clarification or rewrite a submitted assistance snapshot', async () => {
    const pub = await publishAdmitted('harmless');
    const issued = await issueAssessment(testDb(), { group_id: pub.groupId });
    if (issued.status !== 'issued') throw new Error(issued.status);
    const exposure = {
      issuanceId: issued.issuance.issuance_id,
      questionId: pub.qid,
      kind: 'hint' as const,
      contentDigest: `sha256:${'b'.repeat(64)}`,
    };
    await recordAssistanceExposure(testDb(), { ...exposure, impact: 'harmless_clarification' });
    const request = {
      issuance_id: issued.issuance.issuance_id,
      evaluation_group_id: 'clarified',
      idempotency_key: 'original',
      response_set: rs(pub),
    };
    const preview = await previewFormalAttempt(testDb(), 'advice_preview', pub.qid, request);
    expect(preview.automatic_commit).toBe(true);
    expect(preview.candidate.evaluation.record.provenance).toMatchObject({ assisted: false });
    await recordAssistanceExposure(testDb(), {
      ...exposure,
      kind: 'solution',
      impact: 'answer_help',
    });
    const replay = await previewFormalAttempt(testDb(), 'advice_preview', pub.qid, request);
    expect(replay.candidate.evaluation.record).toEqual(preview.candidate.evaluation.record);
    const subsequent = await previewFormalAttempt(testDb(), 'advice_preview', pub.qid, {
      ...request,
      evaluation_group_id: 'after-reveal',
      idempotency_key: 'later',
    });
    expect(subsequent.candidate.evaluation.record.provenance).toMatchObject({ assisted: true });
    await expect(
      recordAssistanceExposure(testDb(), {
        ...exposure,
        questionId: 'unrelated',
        impact: 'unknown',
      }),
    ).rejects.toMatchObject({ code: 'coordinate_mismatch' });
  });
  it('commits the native API receipt once, preserves capture, and keeps manual ratings out of mastery', async () => {
    const pub = await publishAdmitted('manual_api');
    await setUnadmitted(pub.groupId);
    const issued = await issueAssessment(testDb(), { group_id: pub.groupId, mode: 'manual' });
    if (issued.status !== 'issued') throw new Error(issued.status);
    const body = {
      question_id: pub.qid,
      rating: 'hard',
      self_report: true,
      response_md: '我认为是甲，但无法确认这个推导。',
      reasoning_trace: '先逐个排除；仍不确定条件是否足够。',
      self_confidence: 2,
      latency_ms: 12000,
      assessment: {
        issuance_id: issued.issuance.issuance_id,
        evaluation_group_id: 'manual_api_group',
        idempotency_key: 'manual_api_key',
        response_set: rs(pub),
      },
    };
    const send = (value: typeof body) =>
      createAttempt(
        new Request('http://local/api/attempts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(value),
        }),
      );
    const first = await send(body);
    expect(first.status).toBe(200);
    const receipt = AttemptResponseSchema.parse(await first.json());
    expect(receipt).toMatchObject({
      status: 'effective',
      assessment: { effect: 'applied' },
      judge: null,
    });
    const repeated = await send({ ...body, latency_ms: 18000 });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({
      status: 'effective',
      review_event: receipt.review_event,
      assessment: { effect: 'idempotent_replay' },
    });
    const rows = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_attempt'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: receipt.review_event.id,
      outcome: null,
      payload: {
        response_md: body.response_md,
        reasoning_trace: body.reasoning_trace,
        self_confidence: 2,
        duration_ms: 12000,
        evaluation_group_id: 'manual_api_group',
      },
    });
    expect(await testDb().select().from(mastery_state)).toHaveLength(0);
    expect(await testDb().select().from(material_fsrs_state)).toMatchObject([
      { state: { reps: 1 } },
    ]);
    expect((await send({ ...body, rating: 'good' })).status).toBe(409);
    expect(await testDb().select().from(material_fsrs_state)).toMatchObject([
      { state: { reps: 1 } },
    ]);
  });
  it('unadmitted manual practice schedules only explicit FSRS and rolls back with its receipt', async () => {
    const pub = await publishAdmitted('manual_native');
    await setUnadmitted(pub.groupId);
    const issued = await issueAssessment(testDb(), {
      group_id: pub.groupId,
      mode: 'manual',
      now: NOW,
    });
    if (issued.status !== 'issued') throw new Error(`Unexpected issue state ${issued.status}`);
    const prepared = await previewFormalAttempt(
      testDb(),
      'solo_submit',
      pub.qid,
      {
        issuance_id: issued.issuance.issuance_id,
        evaluation_group_id: 'manual_group',
        idempotency_key: 'manual-key',
        response_set: rs(pub),
        now: NOW,
      },
      undefined,
      { selfReport: true },
    );
    expect(prepared.candidate.evaluation.record).toMatchObject({
      status: 'completed',
      provenance: { source: 'self_report' },
      aggregate: { kind: 'unresolved' },
    });
    expect(prepared.candidate.evaluation.record.run_refs).toEqual([]);
    const intent = { ...prepared.activation_intent, user_rating: 'hard' as const };
    await expect(
      activateSubmissionCandidate(testDb(), intent, {
        actorRef: 'test:formal',
        now: NOW,
        record: async () => {
          throw new Error('receipt failed');
        },
      }),
    ).rejects.toThrow('receipt failed');
    expect(await testDb().select().from(material_fsrs_state)).toHaveLength(0);
    expect(await testDb().select().from(mastery_state)).toHaveLength(0);
    const [head] = await testDb()
      .select()
      .from(evaluation_effective_head)
      .where(eq(evaluation_effective_head.evaluation_group_id, 'manual_group'));
    expect(head).toMatchObject({ generation: 0, effective_evaluation_id: null });
    let receiptCount = 0;
    expect(
      await activateSubmissionCandidate(testDb(), intent, {
        actorRef: 'test:formal',
        now: NOW,
        record: async () => {
          receiptCount++;
        },
      }),
    ).toMatchObject({ status: 'activated', effect: 'applied' });
    expect(
      await activateSubmissionCandidate(testDb(), intent, {
        actorRef: 'test:formal',
        now: NOW,
        record: async () => {
          receiptCount++;
        },
      }),
    ).toMatchObject({ status: 'already_effective' });
    expect(receiptCount).toBe(1);
    expect(await testDb().select().from(mastery_state)).toHaveLength(0);
    const [card] = await testDb().select().from(material_fsrs_state);
    expect(card).toMatchObject({
      subject_kind: 'question',
      subject_id: pub.qid,
      state: { reps: 1 },
    });
  });
});
