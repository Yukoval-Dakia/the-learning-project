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
import { beforeEach, describe, expect, it } from 'vitest';

import type { ResponseSetT } from '@/core/schema/assessment';
import {
  assessment_issuance,
  assessment_response_draft,
  assessment_submission,
  evaluation_effective_head,
  evaluation_group,
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
import { issueAssessment } from './issue';
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
async function publishAdmitted(qid: string): Promise<Published> {
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
});

// ---------- saveSubmission ----------

describe('saveSubmission', () => {
  beforeEach(resetDb);

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
