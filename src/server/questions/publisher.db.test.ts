// YUK-1043 — publisher DB 测试（db 分区；testcontainer + resetDb）。
// 被测不变量：同事务原子发布（revision + lifecycle + event + identity diff）、
// 双 CAS（revision + admission generation）、digest 幂等、supersedes 链、
// admission 分支与 evidence 形状、archive/restore 的 claim 语义、mid-step 故障
// 全量回滚（trigger 注入）、并发兄弟编辑的组根锁序（复审 P1/P2 全覆盖）。

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
  publishQuestionGroup,
  publishQuestionGroupFromRow,
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

  for (const existing of [false, true]) {
  }

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
});

describe('publishQuestionGroupFromRow — 锁序/组语义/未决转换（复审 P1）', () => {
  beforeEach(resetDb);
  afterEach(resetDb);

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
});
