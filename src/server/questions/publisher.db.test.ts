// YUK-1043 — publisher DB 测试（db 分区；testcontainer + resetDb）。
// 被测不变量：同事务原子发布（revision + lifecycle + event + identity diff）、
// 双 CAS（revision + admission generation）、digest 幂等、supersedes 链、
// admission 分支与 evidence 形状、archive/restore 的 claim 语义、mid-step 故障
// 全量回滚（trigger 注入）、并发兄弟编辑的组根锁序（复审 P1/P2 全覆盖）。

import { createId } from '@paralleldrive/cuid2';
import { eq, sql } from 'drizzle-orm';
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
    source: 'web_sourced',
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
    expectedAdmissionGeneration: null,
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
    // P1-4 — identity diff 随事件持久化（首版 = 全部新增）。
    expect(publishEvent.payload).toMatchObject({
      identity_changes: {
        part_changes: [{ part_id: qid, status: 'added' }],
        replacement_mappings: [],
      },
    });

    // 同内容再发布（双 CAS 令牌均更新为当前值）→ digest 幂等 noop。
    const again = await publishQuestionGroup(
      db,
      publishInput(row, {
        expectedCurrentRevision: first.revision_id,
        expectedAdmissionGeneration: 1,
      }),
    );
    expect(again).toMatchObject({ status: 'noop', current_revision_id: first.revision_id });

    // CAS：期望错版 → conflict（revision_cas）。
    const stale = await publishQuestionGroup(
      db,
      publishInput(row, { expectedCurrentRevision: null, expectedAdmissionGeneration: null }),
    );
    expect(stale).toMatchObject({
      status: 'conflict',
      current_revision_id: first.revision_id,
      reason: 'revision_cas',
    });
  });

  it('content edit publishes a new revision with supersedes chain + identity diff', async () => {
    const db = testDb();
    const qid = 'pub_q2';
    await seedQuestion(qid);
    const rowBefore = await readRow(qid);
    const first = await publishQuestionGroup(db, publishInput(rowBefore));
    if (first.status !== 'published') throw new Error('first publish failed');

    // 编辑：只改第二个选项文本（语义替换），slot/part 身份保留。
    await db
      .update(question)
      .set({ choices_md: ['甲', '乙（修订）', '丙'], version: 1 })
      .where(eq(question.id, qid));
    const rowAfter = await readRow(qid);
    const second = await publishQuestionGroup(
      db,
      publishInput(rowAfter, {
        expectedCurrentRevision: first.revision_id,
        expectedAdmissionGeneration: 1,
      }),
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
      expect(spec2.slots[0].options[2].option_id).toBe(spec1.slots[0].options[2].option_id);
      expect(spec2.slots[0].options[1].option_id).not.toBe(spec1.slots[0].options[1].option_id);
    }

    // P1-4 —— identity diff：编辑版与被替换版比对，option 1 是替换（增+删）。
    const [ev2] = await db.select().from(event).where(eq(event.id, second.event_id));
    expect(ev2.payload).toMatchObject({
      identity_changes: {
        part_changes: [{ part_id: qid, status: 'replaced' }], // 判分内容变 ⇒ replaced（P1-3）
        option_changes: [
          {
            slot_id: `${qid}::r`,
            added_option_ids: [
              spec2.slots[0].kind === 'single_choice' ? spec2.slots[0].options[1].option_id : '',
            ].filter(Boolean),
            removed_option_ids: [
              spec1.slots[0].kind === 'single_choice' ? spec1.slots[0].options[1].option_id : '',
            ].filter(Boolean),
          },
        ],
      },
    });
  });

  it('P2: mid-step failure rolls back EVERYTHING — fault injected by a trigger AFTER the revision insert', async () => {
    const db = testDb();
    const qid = 'pub_q3';
    await seedQuestion(qid);
    const row = await readRow(qid);

    // 故障注入：lifecycle INSERT 时触发 RAISE —— revision 已写、事件未写。
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION fail_lifecycle_insert() RETURNS trigger AS $$
      BEGIN
        IF current_setting('app.fail_lifecycle', true) = 'on' THEN
          RAISE EXCEPTION 'injected mid-step failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await db.execute(sql`
      CREATE TRIGGER fail_lifecycle_insert_trg BEFORE INSERT ON question_group_lifecycle
      FOR EACH ROW EXECUTE FUNCTION fail_lifecycle_insert()`);

    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL app.fail_lifecycle = 'on'`);
        await publishQuestionGroup(tx, publishInput(row));
      }),
    ).rejects.toThrow(
      /injected mid-step failure|Failed query: insert into "question_group_lifecycle"/,
    );

    // revision 已插但 lifecycle 失败 ⇒ 整个 tx（含 revision）回滚，事件未写。
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

    // 同一触发器关闭后正常发布（清掉注入，恢复路径可用）。
    const ok = await publishQuestionGroup(db, publishInput(row));
    expect(ok.status).toBe('published');
  });

  it('admitted requires PASSING evidence (fail-closed) — P1-5 shape validation', async () => {
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

    // P1-5 —— structural_check_passed=false 不是准入证据。
    await expect(
      publishQuestionGroup(
        db,
        publishInput(row, {
          admission: {
            state: 'admitted',
            evidence: {
              ...ADMITTED_EVIDENCE,
              verification: {
                structural_check_passed: false,
                independent_verification: null,
              },
            },
          },
        }),
      ),
    ).rejects.toThrow(/structural_check_passed=true/);

    // P1-5 —— independent verification 未通过同样拒绝。
    await expect(
      publishQuestionGroup(
        db,
        publishInput(row, {
          admission: {
            state: 'admitted',
            evidence: {
              ...ADMITTED_EVIDENCE,
              verification: {
                structural_check_passed: true,
                independent_verification: {
                  passed: false,
                  verifier: 'independent_model',
                  verified_at: new Date().toISOString(),
                },
              },
            },
          },
        }),
      ),
    ).rejects.toThrow(/PASSED independent verification/);

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

  it('P2: seam recomputes the digest and rejects supplied/derived mismatch + foreign group_id', async () => {
    const db = testDb();
    const qid = 'pub_digest';
    await seedQuestion(qid);
    const row = await readRow(qid);
    const input = publishInput(row);

    await expect(
      publishQuestionGroup(
        db,
        publishInput(row, {
          contract: { ...input.contract, integrity_digest: 'sha256:deadbeef' },
        }),
      ),
    ).rejects.toThrow(/integrity_digest mismatch/);

    // structure.group_id 指向别的组 ⇒ fail-closed。
    const foreign = normalizeQuestionRowToContract({ ...row, id: 'other' });
    await expect(
      publishQuestionGroup(
        db,
        publishInput(row, {
          contract: {
            structure: foreign.structure,
            response_spec: foreign.response_spec,
            scoring_basis: foreign.scoring_basis,
            execution_plan: foreign.execution_plan,
            integrity_digest: foreign.integrity_digest,
          },
        }),
      ),
    ).rejects.toThrow(/structure.group_id .* != target group/);
  });

  it('same digest + changed admission ⇒ admission_updated with generation CAS; stale generation conflicts (P1-5)', async () => {
    const db = testDb();
    const qid = 'pub_q6';
    await seedQuestion(qid);
    const row = await readRow(qid);
    // 模拟 sourced-draft-insert 首版：withheld/unverified_rules。
    const first = await publishQuestionGroup(db, publishInput(row));
    if (first.status !== 'published') throw new Error('first publish failed');

    // 模拟 source_verify promote：内容未变，admission → admitted。
    const promote = await publishQuestionGroup(
      db,
      publishInput(row, {
        expectedCurrentRevision: first.revision_id,
        expectedAdmissionGeneration: 1,
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

    // P1-5 —— 过期 generation 的维度请求不能覆盖新决定（conflict）。
    const staleRequest = await publishQuestionGroup(
      db,
      publishInput(row, {
        expectedCurrentRevision: first.revision_id,
        expectedAdmissionGeneration: 1, // 期望 gen1，实际 gen2
        admission: { state: 'withheld', reason: 'owner_hold' },
      }),
    );
    expect(staleRequest).toMatchObject({ status: 'conflict', reason: 'admission_generation_cas' });
    const [stillAdmitted] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    expect(stillAdmitted.scoring_admission_state).toBe('admitted');
    expect(stillAdmitted.scoring_admission_generation).toBe(2);

    // 同请求幂等重发（gen 已更新为 2）⇒ 真 noop。
    const again = await publishQuestionGroup(
      db,
      publishInput(row, {
        expectedCurrentRevision: first.revision_id,
        expectedAdmissionGeneration: 2,
        admission: { state: 'admitted', evidence: ADMITTED_EVIDENCE },
      }),
    );
    expect(again).toMatchObject({ status: 'noop', current_revision_id: first.revision_id });
  });

  it('archive releases nothing silently; restore reacquires the claim atomically and conflicts when held', async () => {
    const db = testDb();
    const qid = 'pub_q5';
    await seedQuestion(qid, { canonical_content_hash: 'sha256:claim-1' });
    const row = await readRow(qid);
    await publishQuestionGroup(db, publishInput(row));

    // archive：legacy claim 释放（hash 置 NULL）+ lifecycle withdrawn —— 全部同事务（P2）。
    await db.transaction(async (tx) => {
      await tx.update(question).set({ canonical_content_hash: null }).where(eq(question.id, qid));
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
});

describe('publishQuestionGroupFromRow — 锁序/组语义/未决转换（复审 P1）', () => {
  beforeEach(resetDb);
  afterEach(resetDb);

  it('P1-5: preserve on CHANGED content folds to withheld (existing reason kept) — old evidence never crosses generations', async () => {
    const db = testDb();
    const parentId = 'pf_root';
    const now = new Date();
    await seedQuestion(parentId, { kind: 'composite', source: 'quiz_gen' });
    await db.insert(question).values({
      id: 'pf_part',
      parent_question_id: parentId,
      part_index: 0,
      kind: 'question_part',
      prompt_md: '(1)',
      reference_md: 'B',
      knowledge_ids: [],
      difficulty: 3,
      source: 'quiz_gen',
      variant_depth: 0,
      draft_status: 'active',
      choices_md: ['甲', '乙'],
      created_at: now,
      updated_at: now,
      version: 0,
    });

    // 首版 admitted（模拟 verify promote）。
    const first = await publishQuestionGroupFromRow(db, {
      rootId: parentId,
      admission: { state: 'admitted', evidence: ADMITTED_EVIDENCE },
      actorRef: 'test',
      now,
    });
    expect(first.status).toBe('published');

    // 内容编辑（part 答案 B→A）后 preserve 发布：P1-5 ⇒ withheld/unverified_rules。
    await db
      .update(question)
      .set({ reference_md: 'A', updated_at: now })
      .where(eq(question.id, 'pf_part'));
    const after = await publishQuestionGroupFromRow(db, {
      rootId: parentId,
      actorRef: 'test:edit',
      now,
    });
    expect(after.status).toBe('published');
    const [lifecycle] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, parentId));
    expect(lifecycle.scoring_admission_state).toBe('withheld');
    expect(lifecycle.scoring_admission_withheld_reason).toBe('unverified_rules');
    expect(lifecycle.scoring_admission_evidence).toBeNull();
  });

  it('P1-5: unresolved conversion (missing reference) forces withheld even when caller asks admitted', async () => {
    const db = testDb();
    const qid = 'pf_unresolved';
    await seedQuestion(qid, {
      kind: 'short_answer',
      reference_md: null,
      choices_md: null,
      source: 'quiz_gen',
    });
    const result = await publishQuestionGroupFromRow(db, {
      rootId: qid,
      admission: { state: 'admitted', evidence: ADMITTED_EVIDENCE },
      actorRef: 'test',
      now: new Date(),
    });
    expect(result.status).toBe('published');
    const [lifecycle] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    expect(lifecycle.scoring_admission_state).toBe('withheld');
    expect(lifecycle.scoring_admission_withheld_reason).toBe('unverified_rules');
  });

  it('multi-part group: first publish mints group contract; part resolution from a child rootId; tombstoned parts excluded', async () => {
    const db = testDb();
    const parentId = 'pf_grp_root';
    const now = new Date();
    await seedQuestion(parentId, { kind: 'composite', source: 'quiz_gen' });
    await db.insert(question).values([
      {
        id: 'pf_p1',
        parent_question_id: parentId,
        part_index: 0,
        kind: 'question_part',
        prompt_md: '(1) 求值',
        reference_md: '42',
        knowledge_ids: [],
        difficulty: 3,
        source: 'quiz_gen',
        variant_depth: 0,
        draft_status: 'active',
        choices_md: null,
        created_at: now,
        updated_at: now,
        version: 0,
      },
      {
        id: 'pf_p2',
        parent_question_id: parentId,
        part_index: 1,
        kind: 'question_part',
        prompt_md: '(2) 选出正确项',
        reference_md: 'B',
        knowledge_ids: [],
        difficulty: 3,
        source: 'quiz_gen',
        variant_depth: 0,
        draft_status: 'active',
        choices_md: ['选项一', '选项二'],
        created_at: now,
        updated_at: now,
        version: 0,
      },
    ]);

    // 从子行 rootId 发布 ⇒ 解析到父组（P1-1 组根解析）。
    const first = await publishQuestionGroupFromRow(db, {
      rootId: 'pf_p1',
      actorRef: 'test:from-child',
      now,
    });
    expect(first.status).toBe('published');
    if (first.status !== 'published') return;
    expect(first.group_id).toBe(parentId);
    const [rev1] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, first.revision_id));
    expect(rev1.group_id).toBe(parentId);
    expect(rev1.structure.parts.map((p) => p.part_id)).toEqual(['pf_p1', 'pf_p2']);
    // 组根题干作为共享材料（P1-2）。
    expect(rev1.structure.materials.length).toBeGreaterThanOrEqual(1);

    // tombstone 一个 part ⇒ 组契约排除它，重发为少 part 的新版（P2 组语义）。
    await db
      .update(question)
      .set({
        metadata: { archived_at: Math.floor(now.getTime() / 1000) },
        updated_at: now,
      })
      .where(eq(question.id, 'pf_p2'));
    const second = await publishQuestionGroupFromRow(db, {
      rootId: parentId,
      actorRef: 'test:after-tombstone',
      now,
    });
    expect(second.status).toBe('published');
    if (second.status !== 'published') return;
    const [rev2] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, second.revision_id));
    expect(rev2.structure.parts.map((p) => p.part_id)).toEqual(['pf_p1']);
    // P1-4 —— identity diff 记录 pf_p2 移除。
    const [ev2] = await db.select().from(event).where(eq(event.id, second.event_id));
    expect(ev2.payload).toMatchObject({
      identity_changes: {
        part_changes: [
          { part_id: 'pf_p1', status: 'retained' },
          { part_id: 'pf_p2', status: 'removed' },
        ],
      },
    });

    // 全部 part tombstone ⇒ withdrawn，不铸空组。
    await db
      .update(question)
      .set({
        metadata: { archived_at: Math.floor(now.getTime() / 1000) },
        updated_at: now,
      })
      .where(eq(question.id, 'pf_p1'));
    const third = await publishQuestionGroupFromRow(db, {
      rootId: parentId,
      actorRef: 'test:all-tombstoned',
      now,
    });
    expect(third).toMatchObject({ status: 'withdrawn', group_id: parentId });
    const [withdrawn] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, parentId));
    expect(withdrawn.withdrawn).toBe(true);
  });

  it('P1-1: sibling edit under the group-root lock is never lost — barrier handshake, no sleeps (old read-before-lock impl fails this)', async () => {
    const db = testDb();
    const parentId = 'pf_race_root';
    const now = new Date();
    await seedQuestion(parentId, { kind: 'composite', source: 'quiz_gen' });
    await db.insert(question).values({
      id: 'pf_race_part',
      parent_question_id: parentId,
      part_index: 0,
      kind: 'question_part',
      prompt_md: 'original prompt',
      reference_md: 'B',
      knowledge_ids: [],
      difficulty: 3,
      source: 'quiz_gen',
      variant_depth: 0,
      draft_status: 'active',
      choices_md: null,
      created_at: now,
      updated_at: now,
      version: 0,
    });

    // T1：持有组根锁，等待 T2 确认阻塞后才提交 sibling 内容编辑。
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });
    const t1 = db.transaction(async (tx) => {
      await tx
        .select({ id: question.id })
        .from(question)
        .where(eq(question.id, parentId))
        .for('update');
      await t1Gate; // 阻塞确认后（见下方 barrier）才放行提交
      await tx
        .update(question)
        .set({ prompt_md: 'sibling edited prompt', updated_at: now, version: 1 })
        .where(eq(question.id, 'pf_race_part'));
    });

    // T2：FromRow 发布。先取后端 pid（事务已活跃信号），再进 seam。
    let t2Pid = 0;
    let resolvePid!: (pid: number) => void;
    const pidReady = new Promise<number>((resolve) => {
      resolvePid = resolve;
    });
    const t2Promise = db.transaction(async (tx) => {
      const pidRows = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      t2Pid = Number(pidRows[0]?.pid ?? 0);
      resolvePid(t2Pid);
      // 子行 rootId：新实现非锁定解析→只锁组根；旧实现先锁子行再锁父 ——
      // 与 T1（持根锁、待改子行）互为死锁环，旧实现在此被 PG deadlock 检测杀死。
      return publishQuestionGroupFromRow(tx, {
        rootId: 'pf_race_part',
        actorRef: 'test:race-t2',
        now,
      });
    });

    // Barrier：轮询直到 T2 后端持有【未授权】锁请求（= 已在组根锁上排队）——
    // 此时 T1 尚未提交（gate 未放行），T2 的快照读必然发生在获得锁之后。
    await pidReady;
    const deadline = Date.now() + 15_000;
    for (;;) {
      const waiting = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from pg_locks where pid = ${t2Pid} and granted = false`,
      );
      if (Number(waiting[0]?.n ?? 0) > 0) break;
      if (Date.now() > deadline)
        throw new Error('barrier timeout: T2 never blocked on the root lock');
      await new Promise((r) => setTimeout(r, 25));
    }
    // T2 确认在锁上排队 ⇒ 放行 T1 提交。
    releaseT1();
    const t2Result = await t2Promise;
    await t1;

    expect(t2Result.status).toBe('published');
    if (t2Result.status !== 'published') return;
    const [rev] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, t2Result.revision_id));
    // 锁后快照：发布的 part prompt 是 T1 提交的【新】文本，不是旧文本。
    const part = rev.structure.parts.find((p) => p.part_id === 'pf_race_part');
    expect(part?.prompt_md).toBe('sibling edited prompt');
  });

  it('P1-3: same part id + materially changed scoring content ⇒ classified REPLACED (never silently retained)', async () => {
    const db = testDb();
    const parentId = 'pf_repl_root';
    const now = new Date();
    await seedQuestion(parentId, { kind: 'composite', source: 'quiz_gen' });
    await db.insert(question).values({
      id: 'pf_repl_part',
      parent_question_id: parentId,
      part_index: 0,
      kind: 'question_part',
      prompt_md: '原任务：求抛物线与 x 轴交点',
      reference_md: 'B',
      knowledge_ids: [],
      difficulty: 3,
      source: 'quiz_gen',
      variant_depth: 0,
      draft_status: 'active',
      choices_md: ['交点(1,0)', '交点(2,0)'],
      created_at: now,
      updated_at: now,
      version: 0,
    });

    const first = await publishQuestionGroupFromRow(db, {
      rootId: parentId,
      actorRef: 'test',
      now,
    });
    expect(first.status).toBe('published');

    // 整个任务被替换：同 part 行 id，但题面 + 选项 + 答案全换。
    await db
      .update(question)
      .set({
        prompt_md: '新任务：求椭圆的离心率',
        choices_md: ['e=1/2', 'e=√3/2'],
        reference_md: 'A',
        updated_at: now,
        version: 1,
      })
      .where(eq(question.id, 'pf_repl_part'));
    const second = await publishQuestionGroupFromRow(db, {
      rootId: parentId,
      actorRef: 'test:replace',
      now,
    });
    expect(second.status).toBe('published');
    if (second.status !== 'published') return;

    const [ev] = await db.select().from(event).where(eq(event.id, second.event_id));
    const changes = (
      ev.payload as { identity_changes: { part_changes: { part_id: string; status: string }[] } }
    ).identity_changes.part_changes;
    // 行 id 未变，但判分相关内容【实质替换】⇒ replaced + 显式 old→new 映射，不冒充 retained。
    expect(changes).toEqual([{ part_id: 'pf_repl_part', status: 'replaced' }]);
    const mapping = (ev.payload as { identity_changes: { replacement_mappings: unknown[] } })
      .identity_changes.replacement_mappings;
    expect(Array.isArray(mapping)).toBe(true);
    expect(mapping.length).toBe(1);
  });

  it('P1-3: semantically unchanged part (cosmetic whitespace) ⇒ retained', async () => {
    const db = testDb();
    const parentId = 'pf_ret_root';
    const now = new Date();
    await seedQuestion(parentId, { kind: 'composite', source: 'quiz_gen' });
    await db.insert(question).values({
      id: 'pf_ret_part',
      parent_question_id: parentId,
      part_index: 0,
      kind: 'question_part',
      prompt_md: '原任务：求值',
      reference_md: 'B',
      knowledge_ids: [],
      difficulty: 3,
      source: 'quiz_gen',
      variant_depth: 0,
      draft_status: 'active',
      choices_md: ['甲', '乙'],
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await publishQuestionGroupFromRow(db, { rootId: parentId, actorRef: 'test', now });
    // 语义不变重发（不改内容行）⇒ digest 相同 ⇒ noop（天然 retained 路径）。
    const second = await publishQuestionGroupFromRow(db, {
      rootId: parentId,
      actorRef: 'test:again',
      now,
    });
    expect(second).toMatchObject({ status: 'noop' });
  });
});
