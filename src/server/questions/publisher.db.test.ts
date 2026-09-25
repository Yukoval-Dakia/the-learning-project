// YUK-1043 — publisher DB 测试（db 分区；testcontainer + resetDb）。
// 被测不变量：同事务原子发布（revision + lifecycle + event）、CAS、digest 幂等、
// supersedes 链、admission 分支、archive/restore 的 claim 语义、回滚不留痕。

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AdmissionEvidenceT } from '@/core/schema/assessment';
import { event, question, question_group_lifecycle, question_revision } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  type NormalizableQuestionRow,
  normalizeQuestionRowToContract,
} from './contract-normalizer';
import {
  ASSESSMENT_PUBLISH_ACTION,
  archiveGroupLifecycle,
  publishQuestionGroup,
  publishQuestionGroupFromRow,
  restoreGroupLifecycle,
} from './publisher';

const ADMITTED_EVIDENCE: AdmissionEvidenceT = {
  marking_provenance: 'official',
  verification: { structural_check_passed: true, independent_verification: null },
  model_slice: null,
};

async function seedQuestion(id: string, overrides: Partial<typeof question.$inferInsert> = {}) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'choice',
    prompt_md: `下列关于 ${id} 的说法正确的是`,
    reference_md: 'B',
    knowledge_ids: [],
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    choices_md: ['甲', '乙', '丙'],
    created_at: now,
    updated_at: now,
    version: 0,
    ...overrides,
  });
}

// 直接构造 publisher 输入（契约由 normalizer 产出，测试里组装）。
function publishInput(
  row: NormalizableQuestionRow,
  over: Record<string, unknown> = {},
): Parameters<typeof publishQuestionGroup>[1] {
  const n = normalizeQuestionRowToContract(row);
  return {
    group_id: n.group_id,
    contract: {
      structure: n.structure,
      response_spec: n.response_spec,
      scoring_basis: n.scoring_basis,
      execution_plan: n.execution_plan,
      integrity_digest: n.integrity_digest,
    },
    expectedCurrentRevision: null,
    availability: 'general_pool',
    admission: { state: 'withheld', reason: 'unverified_rules' },
    actorRef: 'test:publisher',
    now: new Date(),
    ...over,
  } as Parameters<typeof publishQuestionGroup>[1];
}

async function readRow(id: string): Promise<NormalizableQuestionRow> {
  const db = testDb();
  const [row] = await db.select().from(question).where(eq(question.id, id)).limit(1);
  if (!row) throw new Error(`row ${id} missing`);
  return row as NormalizableQuestionRow;
}

describe('publishQuestionGroup（YUK-1043 统一发布 seam）', () => {
  beforeEach(resetDb);
  afterEach(resetDb);

  it('atomically writes revision + lifecycle + publish event; CAS digest noop on republish', async () => {
    const db = testDb();
    const qid = 'pub_q1';
    await seedQuestion(qid);
    const row = await readRow(qid);

    const first = await publishQuestionGroup(db, publishInput(row));
    expect(first.status).toBe('published');
    if (first.status !== 'published') return;

    const [revision] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, first.revision_id));
    expect(revision.group_id).toBe(qid);
    expect(revision.revision_ordinal).toBe(1);
    expect(revision.supersedes_revision_id).toBeNull();

    const [lifecycle] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    expect(lifecycle.current_revision_id).toBe(first.revision_id);
    // §3.3 维度落位。
    expect(lifecycle.scoring_admission_state).toBe('withheld');
    expect(lifecycle.scoring_admission_withheld_reason).toBe('unverified_rules');
    expect(lifecycle.scoring_admission_generation).toBe(1);
    expect(lifecycle.availability).toBe('general_pool');
    expect(lifecycle.withdrawn).toBe(false);

    const [publishEvent] = await db.select().from(event).where(eq(event.id, first.event_id));
    expect(publishEvent.action).toBe(ASSESSMENT_PUBLISH_ACTION);
    expect(publishEvent.subject_id).toBe(qid);

    // 同内容再发布（期望已更新为当前版）→ digest 幂等 noop。
    const again = await publishQuestionGroup(
      db,
      publishInput(row, { expectedCurrentRevision: first.revision_id }),
    );
    expect(again).toMatchObject({ status: 'noop', current_revision_id: first.revision_id });

    // CAS：期望错版 → conflict。
    const stale = await publishQuestionGroup(
      db,
      publishInput(row, { expectedCurrentRevision: null }),
    );
    expect(stale).toMatchObject({ status: 'conflict', current_revision_id: first.revision_id });
  });

  it('content edit publishes a new revision with supersedes chain + identity preservation', async () => {
    const db = testDb();
    const qid = 'pub_q2';
    await seedQuestion(qid);
    const rowBefore = await readRow(qid);
    const first = await publishQuestionGroup(db, publishInput(rowBefore));
    if (first.status !== 'published') throw new Error('first publish failed');

    // 编辑：只改第三个选项文本（语义替换），slot/part 身份保留。
    await db
      .update(question)
      .set({ choices_md: ['甲', '乙', '丙（修订）'], version: 1 })
      .where(eq(question.id, qid));
    const rowAfter = await readRow(qid);
    const second = await publishQuestionGroup(
      db,
      publishInput(rowAfter, { expectedCurrentRevision: first.revision_id }),
    );
    expect(second.status).toBe('published');
    if (second.status !== 'published') return;

    const [rev2] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, second.revision_id));
    expect(rev2.revision_ordinal).toBe(2);
    expect(rev2.supersedes_revision_id).toBe(first.revision_id);
    expect(rev2.integrity_digest).not.toBe(
      (
        await db
          .select()
          .from(question_revision)
          .where(eq(question_revision.revision_id, first.revision_id))
      )[0].integrity_digest,
    );

    // 身份纪律：slot id / 未变选项 id 跨版本一致。
    const spec1 = (
      await db
        .select()
        .from(question_revision)
        .where(eq(question_revision.revision_id, first.revision_id))
    )[0].response_spec;
    const spec2 = rev2.response_spec;
    expect(spec2.slots[0].slot_id).toBe(spec1.slots[0].slot_id);
    if (spec1.slots[0].kind === 'single_choice' && spec2.slots[0].kind === 'single_choice') {
      expect(spec2.slots[0].options[0].option_id).toBe(spec1.slots[0].options[0].option_id);
      expect(spec2.slots[0].options[2].option_id).not.toBe(spec1.slots[0].options[2].option_id);
    }
  });

  it('mid-publish failure rolls back EVERYTHING (no revision, no lifecycle, no event)', async () => {
    const db = testDb();
    const qid = 'pub_q3';
    await seedQuestion(qid);
    const row = await readRow(qid);
    const input = publishInput(row);

    await expect(
      db.transaction(async (tx) => {
        const result = await publishQuestionGroup(tx, input);
        expect(result.status).toBe('published');
        // 模拟发布后的同事务失败（例如后续 projection 写挂了）。
        throw new Error('post-publish step failed');
      }),
    ).rejects.toThrow('post-publish step failed');

    const revisions = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.group_id, qid));
    expect(revisions).toHaveLength(0);
    const lifecycles = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    expect(lifecycles).toHaveLength(0);
    const events = await db.select().from(event).where(eq(event.subject_id, qid));
    expect(events.filter((e) => e.action === ASSESSMENT_PUBLISH_ACTION)).toHaveLength(0);
  });

  it('admitted requires evidence (fail-closed) and lands the admission branch CHECK shape', async () => {
    const db = testDb();
    const qid = 'pub_q4';
    await seedQuestion(qid);
    const row = await readRow(qid);

    await expect(
      publishQuestionGroup(
        db,
        publishInput(row, { admission: { state: 'admitted' } }), // 缺 evidence
      ),
    ).rejects.toThrow(/admitted requires evidence/);

    const ok = await publishQuestionGroup(
      db,
      publishInput(row, { admission: { state: 'admitted', evidence: ADMITTED_EVIDENCE } }),
    );
    expect(ok.status).toBe('published');
    const [lifecycle] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    expect(lifecycle.scoring_admission_state).toBe('admitted');
    expect(lifecycle.scoring_admission_decided_at).not.toBeNull();
    expect(lifecycle.scoring_admission_evidence).not.toBeNull();
  });

  it('archive releases nothing silently; restore reacquires the claim atomically and conflicts when held', async () => {
    const db = testDb();
    const qid = 'pub_q5';
    await seedQuestion(qid, { canonical_content_hash: 'sha256:claim-1' });
    const row = await readRow(qid);
    await publishQuestionGroup(db, publishInput(row));

    // archive：legacy claim 释放（hash 置 NULL）+ lifecycle withdrawn。
    await db.transaction(async (tx) => {
      await db.update(question).set({ canonical_content_hash: null }).where(eq(question.id, qid));
      // 上面独立 update 在 tx 外效果等同 —— 保持简单：此处直接测 lifecycle 维度。
      await archiveGroupLifecycle(tx, qid, new Date());
    });
    const [archived] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    expect(archived.withdrawn).toBe(true);

    // 占用者出现：另一个 question 拿走了同一 canonical hash。
    const holderId = createId();
    await seedQuestion(holderId, { canonical_content_hash: 'sha256:claim-1' });

    const conflict = await db.transaction(async (tx) =>
      restoreGroupLifecycle(tx, qid, 'sha256:claim-1', new Date()),
    );
    expect(conflict).toMatchObject({ status: 'claim_conflict', conflicting_question_id: holderId });
    // 冲突路径不改 lifecycle（恢复失败 ⇒ 维持 withdrawn）。
    const [stillWithdrawn] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    expect(stillWithdrawn.withdrawn).toBe(true);

    // 占用者释放后 restore 成功（原子重取 claim + withdrawn=false）。
    await db
      .update(question)
      .set({ canonical_content_hash: null })
      .where(eq(question.id, holderId));
    const restored = await db.transaction(async (tx) =>
      restoreGroupLifecycle(tx, qid, 'sha256:claim-1', new Date()),
    );
    expect(restored.status).toBe('restored');
    const [live] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    expect(live.withdrawn).toBe(false);
    const [q] = await db.select().from(question).where(eq(question.id, qid));
    expect(q.canonical_content_hash).toBe('sha256:claim-1');
  });

  it('root question row missing → fail-closed error (no partial writes)', async () => {
    const db = testDb();
    const ghost = publishInput({
      id: 'ghost',
      kind: 'choice',
      prompt_md: 'x',
      reference_md: 'A',
      rubric_json: null,
      choices_md: ['甲', '乙'],
      judge_kind_override: null,
      structured: null,
      parent_question_id: null,
    });
    await expect(publishQuestionGroup(db, ghost)).rejects.toThrow(
      /root question row 'ghost' not found/,
    );
  });

  it('same digest + changed admission ⇒ admission_updated: generation bumps, NO new revision, dimension event written', async () => {
    const db = testDb();
    const qid = 'pub_q6';
    await seedQuestion(qid);
    const row = await readRow(qid);
    // 模拟 sourced-draft-insert 首版：withheld/unverified_rules。
    const first = await publishQuestionGroup(db, publishInput(row));
    if (first.status !== 'published') throw new Error('first publish failed');

    // 模拟 source_verify promote：内容未变，admission → admitted（官方来源 + 确定性核验）。
    const promote = await publishQuestionGroup(
      db,
      publishInput(row, {
        expectedCurrentRevision: first.revision_id,
        admission: { state: 'admitted', evidence: ADMITTED_EVIDENCE },
      }),
    );
    expect(promote.status).toBe('admission_updated');
    if (promote.status !== 'admission_updated') return;
    expect(promote.current_revision_id).toBe(first.revision_id);
    expect(promote.admission_generation).toBe(2);

    // 不铸新 revision —— 内容维度与资格维度各自独立版本化（§3.3）。
    const revisions = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.group_id, qid));
    expect(revisions).toHaveLength(1);

    const [lifecycle] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    expect(lifecycle.scoring_admission_state).toBe('admitted');
    expect(lifecycle.scoring_admission_generation).toBe(2);
    expect(lifecycle.scoring_admission_decided_at).not.toBeNull();

    // 维度事件：同 action，payload 标记 dimension_update 且 revision 不变。
    const [dimensionEvent] = await db.select().from(event).where(eq(event.id, promote.event_id));
    expect(dimensionEvent.action).toBe(ASSESSMENT_PUBLISH_ACTION);
    expect(dimensionEvent.payload).toMatchObject({
      dimension_update: true,
      revision_id: first.revision_id,
      admission: 'admitted',
    });

    // 同请求重发（同 digest + 同维度）⇒ 真 noop。
    const again = await publishQuestionGroup(
      db,
      publishInput(row, {
        expectedCurrentRevision: first.revision_id,
        admission: { state: 'admitted', evidence: ADMITTED_EVIDENCE },
      }),
    );
    expect(again).toMatchObject({ status: 'noop', current_revision_id: first.revision_id });
    const [unchanged] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    expect(unchanged.scoring_admission_generation).toBe(2);
  });

  it('publishQuestionGroupFromRow: first publish mints multi-part group contract; preserve keeps admission across content edits', async () => {
    const db = testDb();
    const parentId = 'pub_grp_root';
    const now = new Date();
    await seedQuestion(parentId, { kind: 'composite', source: 'quiz_gen' });
    await db.insert(question).values([
      {
        id: 'part_a',
        parent_question_id: parentId,
        part_index: 0,
        kind: 'question_part',
        prompt_md: '(1) 求值',
        reference_md: '42',
        knowledge_ids: [],
        difficulty: 3,
        source: 'quiz_gen',
        variant_depth: 0,
        draft_status: 'draft',
        choices_md: null,
        created_at: now,
        updated_at: now,
        version: 0,
      },
      {
        id: 'part_b',
        parent_question_id: parentId,
        part_index: 1,
        kind: 'question_part',
        prompt_md: '(2) 选出正确项',
        reference_md: 'B',
        knowledge_ids: [],
        difficulty: 3,
        source: 'quiz_gen',
        variant_depth: 0,
        draft_status: 'draft',
        choices_md: ['选项一', '选项二'],
        created_at: now,
        updated_at: now,
        version: 0,
      },
    ]);

    // 无 lifecycle ⇒ 首版 preserve 落 withheld/unverified_rules（未核验不自动准入）。
    const first = await publishQuestionGroupFromRow(db, {
      rootId: parentId,
      actorRef: 'test:from-row',
      now,
    });
    expect(first.status).toBe('published');
    if (first.status !== 'published') return;
    const [rev1] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, first.revision_id));
    // 组契约含两个子 part：part 身份 = 子行 id（§3.1）。
    expect(rev1.structure.parts.map((p) => p.part_id)).toEqual(['part_a', 'part_b']);
    expect(rev1.response_spec.slots).toHaveLength(2);

    // quiz_verify 式 promote（admitted）⇒ admission 维度翻转，revision 不变。
    const promoted = await publishQuestionGroupFromRow(db, {
      rootId: parentId,
      admission: {
        state: 'admitted',
        evidence: {
          marking_provenance: 'system_verified',
          verification: {
            structural_check_passed: true,
            independent_verification: {
              passed: true,
              verifier: 'independent_model',
              verified_at: now.toISOString(),
            },
          },
          model_slice: null,
        },
      },
      availability: 'general_pool',
      actorRef: 'test:promote',
      now,
    });
    expect(promoted.status).toBe('admission_updated');

    // 内容编辑（part_b 答案改 A→甲）⇒ 新 revision；preserve 沿用 admitted。
    await db
      .update(question)
      .set({ reference_md: 'A', updated_at: now })
      .where(eq(question.id, 'part_b'));
    const edited = await publishQuestionGroupFromRow(db, {
      rootId: parentId,
      actorRef: 'test:edit',
      now,
    });
    expect(edited.status).toBe('published');
    if (edited.status !== 'published') return;
    expect(edited.revision_ordinal).toBe(2);
    const [lifecycle] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, parentId));
    expect(lifecycle.current_revision_id).toBe(edited.revision_id);
    expect(lifecycle.scoring_admission_state).toBe('admitted'); // preserve 生效
  });
});
