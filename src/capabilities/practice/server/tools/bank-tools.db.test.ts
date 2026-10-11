// ADR-0072 LIGHT — 题库三工具边界测试（owner 2026-10-11 22:15 裁决：
// 只经真实边界进入——工具契约 + 真实 DB 查询；一不变量一用例；唯一 fake 是
// 查询嵌入（外部 provider）。不定参数排列、不测内部 helper、不断言 mock 交互）。
//
// 不变量清单：
//   1. 硬过滤不可绕过（withdrawn / draft / 非自动可判不被“服务”）；
//   2. ref 绝不偷换 latest；过期 / 撤回 ref 显式报错；
//   3. 缺图如实上报；
//   4. 工具不读也不写 learner state；
//   （5. 内容变更后旧向量不再使用——随 embedding 失效修复提交加入。）

import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { event, material_fsrs_state, question } from '@/db/schema';
import type { ToolContext } from '@/kernel/tools/types';
import { publishQuestionGroupFromRow } from '@/server/questions/publisher';
import { archiveQuestion, editQuestion } from '@/server/questions/write';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { encodeBankRef } from './bank-ref';
import { checkBankTool } from './check-bank';
import { readBankTool } from './read-bank';
import { searchBankTool } from './search-bank';

const db = testDb();

// ── 唯一 fake：查询嵌入（外部 provider seam）——1024 维轴向量，可按用例改向。 ──
const embedState = vi.hoisted(() => ({
  vector: (() => {
    const v = new Array(1024).fill(0);
    v[0] = 1;
    return v;
  })(),
}));
vi.mock('@/server/ai/embed', () => ({ embedText: async () => embedState.vector }));

const ctx = {
  db,
  taskRunId: 'test-run',
  callerActor: { kind: 'agent' as const, ref: 'test' },
} satisfies ToolContext;

const ADMITTED = {
  state: 'admitted' as const,
  evidence: {
    marking_provenance: 'official' as const,
    verification: { structural_check_passed: true, independent_verification: null },
    model_slice: null,
  },
};

async function seedQuestion(id: string, overrides: Partial<typeof question.$inferInsert> = {}) {
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'single_choice',
    prompt_md: `题 ${id}`,
    reference_md: null,
    knowledge_ids: [],
    difficulty: 3,
    source: 'web_sourced',
    draft_status: 'active',
    variant_depth: 0,
    created_at: now,
    updated_at: now,
    version: 0,
    ...overrides,
  });
}

async function publishAdmitted(id: string) {
  const result = await publishQuestionGroupFromRow(db, {
    rootId: id,
    admission: ADMITTED,
    actorRef: 'test:publish',
    now: new Date(),
  });
  if (result.status !== 'published') throw new Error(`publish failed: ${result.status}`);
  return result;
}

async function searchHits(input: Record<string, unknown>) {
  const output = await searchBankTool.execute(ctx, searchBankTool.inputSchema.parse(input));
  return output;
}

describe('bank tools boundary invariants (search_bank / read_bank / check_bank)', () => {
  beforeEach(resetDb);

  it('hard filters cannot be bypassed: withdrawn never served; draft/admission filters hold', async () => {
    // 四个真实 fixture：已准入在池 / 未准入（withheld）/ 未发布 draft / 已撤回（archive 墓碑）。
    await seedQuestion('bt_admitted', {
      prompt_md: '电容器充放电过程中电荷量的变化判断题（已准入）',
      embedding: embedState.vector.slice(),
      embed_model: 'text-embedding-v4',
      embed_version: 2,
      embed_content_hash: 'seed-bt-admitted',
    });
    await publishAdmitted('bt_admitted');
    await seedQuestion('bt_withheld', { prompt_md: '电容器充放电的位移电流说法判断（未过准入）' });
    const withheldPub = await publishQuestionGroupFromRow(db, {
      rootId: 'bt_withheld',
      actorRef: 'test:publish',
      now: new Date(),
    });
    if (withheldPub.status !== 'published') throw new Error('withheld publish failed');
    await seedQuestion('bt_draft', {
      prompt_md: '电容器充放电平衡态的新拟草稿（draft）',
      draft_status: 'draft',
    });
    await seedQuestion('bt_withdrawn', { prompt_md: '电容器充放电旧题（已归档撤回）' });
    await publishAdmitted('bt_withdrawn');
    const [row] = await db.select().from(question).where(eq(question.id, 'bt_withdrawn'));
    const archived = await archiveQuestion(db, 'bt_withdrawn', row.version, 'test');
    expect(archived.status).toBe('archived');

    // 服务面检索（自动可判 + active）：只有已准入在池题。
    const served = await searchHits({
      query: '电容器 充放电',
      admission_state: 'admitted',
      draft_state: 'active',
    });
    expect(served.hits.map((h) => h.question_id)).toEqual(['bt_admitted']);
    expect(served.hits[0].ref).toMatch(/^qrev1:/);

    // 默认查重面（any/all）：draft 可见（带无版本 ref 标记），withheld 可见，
    // withdrawn 在任何面都不可见。
    const dedup = await searchHits({ query: '电容器 充放电' });
    const ids = dedup.hits.map((h) => h.question_id);
    expect(ids).toContain('bt_admitted');
    expect(ids).toContain('bt_withheld');
    expect(ids).toContain('bt_draft');
    expect(ids).not.toContain('bt_withdrawn');
    const draftHit = dedup.hits.find((h) => h.question_id === 'bt_draft');
    expect(draftHit?.ref).toBeNull();
    expect(draftHit?.missing).toContain('no_published_revision');
  });

  it('a ref never silently swaps to latest; expired/withdrawn refs are explicit errors', async () => {
    await seedQuestion('bt_versioned', {
      prompt_md: '求 f(x)=√(x-3) 的定义域（第一版题面）',
    });
    const v1 = await publishAdmitted('bt_versioned');
    const v1Ref = encodeBankRef(v1.revision_id, v1.revision_digest);

    // 第一版按 ref 可读。
    const firstRead = await readBankTool.execute(
      ctx,
      readBankTool.inputSchema.parse({ refs: [v1Ref], include: ['content', 'relations'] }),
    );
    expect(firstRead.items[0].status).toBe('ok');
    if (firstRead.items[0].status !== 'ok') return;
    expect(firstRead.items[0].content?.parts[0].prompt_md).toContain('第一版题面');
    expect(firstRead.items[0].current).toBe(true);

    // 编辑铸出第二版后：旧 ref 仍读旧内容（不可变），current=false；
    // lifecycle 指向新版 ref；check_bank 对旧 ref 的 is_current 判 contradicted。
    const [row] = await db.select().from(question).where(eq(question.id, 'bt_versioned'));
    const edit = await editQuestion(
      db,
      'bt_versioned',
      row.version,
      {
        prompt_md: '求 f(x)=√(2x-6) 的定义域（第二版题面，条件已改）',
      },
      'test:edit',
    );
    expect(edit.status).toBe('updated');

    const secondRead = await readBankTool.execute(
      ctx,
      readBankTool.inputSchema.parse({ refs: [v1Ref], include: ['content', 'relations'] }),
    );
    const item = secondRead.items[0];
    expect(item.status).toBe('ok');
    if (item.status !== 'ok') return;
    expect(item.content?.parts[0].prompt_md).toContain('第一版题面');
    expect(item.current).toBe(false);
    expect(item.lifecycle.current_revision_ref).not.toBeNull();
    expect(item.lifecycle.current_revision_ref).not.toBe(v1Ref);

    const check = await checkBankTool.execute(
      ctx,
      checkBankTool.inputSchema.parse({
        checks: [{ id: 'old-is-current', refs: [v1Ref], kind: 'ref_state' }],
      }),
    );
    expect(check.checks[0].verdict).toBe('contradicted');

    // digest 错位（过期/错引）与幽灵 ref：显式错误，绝不回退 latest。
    const tampered = `qrev1:${v1.revision_id}:${'0'.repeat(12)}`;
    const ghost = `qrev1:ghost123456789:${'a'.repeat(12)}`;
    const errs = await readBankTool.execute(
      ctx,
      readBankTool.inputSchema.parse({ refs: [tampered, ghost] }),
    );
    expect(errs.items.map((i) => i.status).sort()).toEqual(['digest_mismatch', 'unresolvable']);

    // 组撤回后：ref 显式 withdrawn 错误。
    const [row2] = await db.select().from(question).where(eq(question.id, 'bt_versioned'));
    await archiveQuestion(db, 'bt_versioned', row2.version, 'test');
    const withdrawnRead = await readBankTool.execute(
      ctx,
      readBankTool.inputSchema.parse({ refs: [v1Ref] }),
    );
    expect(withdrawnRead.items[0].status).toBe('withdrawn');
  });

  it('missing figures are reported honestly, not hidden behind a readable stem', async () => {
    await seedQuestion('bt_fig', {
      prompt_md: '如图所示，在正方体中求异面直线所成角。（图缺失题）',
      figures: [
        {
          asset_id: 'bt_missing_asset',
          role: 'diagram',
          source_page_index: 0,
          source_bbox: { x: 0, y: 0, width: 1, height: 1 },
          attached_to_index: 'stem',
          attach_confidence: 'manual',
        },
      ],
    });
    const pub = await publishAdmitted('bt_fig');
    const ref = encodeBankRef(pub.revision_id, pub.revision_digest);

    const read = await readBankTool.execute(
      ctx,
      readBankTool.inputSchema.parse({ refs: [ref], include: ['content', 'materials'] }),
    );
    const item = read.items[0];
    expect(item.status).toBe('ok');
    if (item.status !== 'ok') return;
    expect(item.content?.parts[0].prompt_md).toContain('正方体'); // 题面仍可读
    expect(item.coverage.complete).toBe(false); // 但缺口不被掩盖
    expect(item.coverage.unavailable.join(' ')).toContain('bt_missing_asset');
    const material = (item.materials ?? []).find((m) => m.asset.asset_id === 'bt_missing_asset');
    expect(material?.asset.present).toBe(false);
  });

  it('the tools neither read nor write learner state', async () => {
    await seedQuestion('bt_learner', { prompt_md: '等比数列通项公式求解题（带学习者历史）' });
    const pub = await publishAdmitted('bt_learner');
    const ref = encodeBankRef(pub.revision_id, pub.revision_digest);

    // 真实 learner state：一次 attempt 事件 + 一张 FSRS 卡。
    await db.insert(event).values({
      id: 'bt_evt_attempt',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'test',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'bt_learner',
      outcome: 'failure',
      payload: { answer: 'wrong' },
      created_at: new Date(),
    });
    await db.insert(material_fsrs_state).values({
      id: 'bt_fsrs_card',
      subject_kind: 'question',
      subject_id: 'bt_learner',
      state: {
        due: new Date('2026-10-12T00:00:00.000Z'),
        stability: 1,
        difficulty: 5,
        scheduled_days: 1,
        learning_steps: 0,
        reps: 1,
        lapses: 0,
        state: 'review' as const,
        last_review: new Date('2026-10-11T00:00:00.000Z'),
      },
      due_at: new Date('2026-10-12T00:00:00.000Z'),
    });

    const before = await db.select({ n: sql<number>`count(*)::int` }).from(event);
    const fsrsBefore = await db.select({ n: sql<number>`count(*)::int` }).from(material_fsrs_state);

    const search = await searchHits({ query: '等比数列 通项' });
    const read = await readBankTool.execute(
      ctx,
      readBankTool.inputSchema.parse({ refs: [ref], include: ['content', 'answers', 'metadata'] }),
    );
    const check = await checkBankTool.execute(
      ctx,
      checkBankTool.inputSchema.parse({ checks: [{ id: 's', refs: [ref], kind: 'ref_state' }] }),
    );

    // 输出不含任何学习者状态字段（搜索卡片 / 读取项 / 检查结果的字段白名单）。
    const searchHit = search.hits.find((h) => h.question_id === 'bt_learner');
    expect(searchHit).toBeDefined();
    expect(Object.keys(searchHit ?? {}).sort()).toEqual(
      [
        'admission',
        'availability',
        'difficulty',
        'draft_status',
        'group_id',
        'kind',
        'knowledge_ids',
        'match_evidence',
        'missing',
        'question_id',
        'ref',
        'source',
        'source_tier',
        'suspended',
        'title',
      ].sort(),
    );
    const readItem = read.items[0];
    expect(readItem.status).toBe('ok');
    expect(JSON.stringify(read)).not.toMatch(
      /"(attempts|review_history|fsrs_state|mastery|records)"/,
    );
    expect(JSON.stringify(check)).not.toMatch(
      /"(attempts|review_history|fsrs_state|mastery|records)"/,
    );

    // 全部只读：learner state 行数不变。
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(event);
    const fsrsAfter = await db.select({ n: sql<number>`count(*)::int` }).from(material_fsrs_state);
    expect(after[0].n).toBe(before[0].n);
    expect(fsrsAfter[0].n).toBe(fsrsBefore[0].n);
  });
});
