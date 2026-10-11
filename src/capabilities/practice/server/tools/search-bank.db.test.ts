// ADR-0072 LIGHT — search_bank 引擎 DB 测试（db 分区；testcontainer + resetDb）。
// 被测不变量（提案 §6 / D2 / D6）：
//   - FTS（simple + CJK 逐字切分）与向量通道并行、RRF 融合、硬过滤生效；
//   - 命中携带版本化 ref（qrev1）与 mutable question_id 指针；
//   - 未发布 draft 无 ref（missing=no_published_revision），默认 draft_state=all 可见；
//   - admission_state=admitted 只回已准入且可服务；
//   - 撤回（archived 墓碑 + lifecycle withdrawn）不出现在候选；
//   - embed 失败 → vector 通道 unavailable（诚实降级，FTS 照常）；
//   - cursor 只续同一次检索，翻页一致；
//   - 复合组（父题 + parts）作为 group 卡片出现，part 行不单独成候选；
//   - subject 派生轴经 knowledge 树解析。
// 查询嵌入一律确定性 fake（axis 向量）；不触真实 provider。

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { knowledge, question } from '@/db/schema';
import { publishQuestionGroupFromRow } from '@/server/questions/publisher';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { encodeBankRef, parseBankRef } from './bank-ref';
import { runSearchBank } from './bank-search';

const db = testDb();

const ADMITTED = {
  state: 'admitted' as const,
  evidence: {
    marking_provenance: 'official' as const,
    verification: { structural_check_passed: true, independent_verification: null },
    model_slice: null,
  },
};

/** 1024 维轴向量：axis(0) 与 axis(1) 正交——cosine 排序确定性可控。 */
function axis(index: number): number[] {
  const v = new Array<number>(1024).fill(0);
  v[index] = 1;
  return v;
}

async function seedKnowledge(id: string, domain: string) {
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: `K-${id}`,
    domain,
    parent_id: null,
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

interface SeedOptions {
  prompt: string;
  kind?: string;
  source?: string;
  draft?: 'draft' | 'active' | null;
  knowledgeIds?: string[];
  embedding?: number[];
  reference?: string | null;
}

async function seedQuestion(id: string, opts: SeedOptions) {
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: opts.kind ?? 'single_choice',
    prompt_md: opts.prompt,
    reference_md: opts.reference ?? null,
    choices_md: ['A．1', 'B．2', 'C．3', 'D．4'],
    knowledge_ids: opts.knowledgeIds ?? [],
    difficulty: 3,
    source: opts.source ?? 'web_sourced',
    draft_status: opts.draft ?? 'active',
    variant_depth: 0,
    embedding: opts.embedding ?? null,
    embed_model: opts.embedding ? 'text-embedding-v4' : null,
    embed_version: opts.embedding ? 2 : null,
    embed_content_hash: opts.embedding ? `seed-${id}` : null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function publishAdmitted(id: string) {
  const result = await publishQuestionGroupFromRow(db, {
    rootId: id,
    admission: ADMITTED,
    actorRef: 'test:publish',
    now: new Date(),
  });
  expect(result.status).toBe('published');
  return result;
}

describe('runSearchBank（ADR-0072 LIGHT 竖切）', () => {
  beforeEach(resetDb);

  it('fuses FTS + vector recall into versioned-ref cards with honest coverage', async () => {
    await seedQuestion('sb_math_domain', {
      prompt: '求函数 f(x)=√(x-3) 的定义域，并写出不等式解集。',
      kind: 'single_choice',
      embedding: axis(0),
    });
    await publishAdmitted('sb_math_domain');
    await seedQuestion('sb_math_circuit', {
      prompt: '如图所示的电路中，电源内阻不计。求电阻 R₁ 两端电压。',
      embedding: axis(1),
    });
    await publishAdmitted('sb_math_circuit');
    await seedQuestion('sb_yuwen_read', {
      prompt: '阅读下面的课外散文，回答文后各题：散文主旨理解与手法赏析。',
      knowledgeIds: ['kc_yuwen_1'],
    });
    await publishAdmitted('sb_yuwen_read');

    const output = await runSearchBank(
      db,
      {
        form: 'new',
        query: '定义域',
        scope: { draft_state: 'all', admission_state: 'any' },
        limit: 10,
      },
      { embedFn: async () => axis(0) },
    );

    // FTS：只有第一题包含 定/义/域 全部字符；向量：query=axis(0) 最近同轴题。
    // 两者都指向 sb_math_domain ⇒ 它排第一且双通道命中。
    expect(output.hits.length).toBeGreaterThanOrEqual(2);
    const top = output.hits[0];
    expect(top.question_id).toBe('sb_math_domain');
    expect(top.match_evidence.map((e) => e.channel).sort()).toEqual(['fts', 'vector']);
    expect(top.ref).not.toBeNull();
    expect(parseBankRef(top.ref as string)?.revisionId).toBeTruthy();
    expect(top.draft_status).toBe('active');
    expect(top.admission?.state).toBe('admitted');
    expect(top.source_tier.tier).toBeGreaterThanOrEqual(1);
    // 覆盖：小池无截断、双通道可用 ⇒ complete=true。
    expect(output.coverage.unavailable_channels).toEqual([]);
    expect(output.coverage.retrieval_truncated).toBe(false);
    expect(output.coverage.complete).toBe(true);
    expect(output.coverage.candidate_pool_size).toBe(output.hits.length);
    // requirements 回显：语义匹配是排序依据，不是逐项保证。
    expect(output.requirements.not_verified.length).toBeGreaterThan(0);
  });

  it('includes unpublished drafts (ref null + missing flag) — dedup use case', async () => {
    await seedQuestion('sb_draft unpublished', {
      prompt: '求不等式 2x-6<0 的解集，并判断是否包含定义域边界。',
      draft: 'draft',
    });
    // 未发布：不铸 revision / lifecycle。

    const output = await runSearchBank(
      db,
      {
        form: 'new',
        query: '不等式 解集',
        scope: { draft_state: 'all', admission_state: 'any' },
        limit: 10,
      },
      { embedFn: async () => axis(0) },
    );

    expect(output.hits).toHaveLength(1);
    const hit = output.hits[0];
    expect(hit.ref).toBeNull();
    expect(hit.missing).toContain('no_published_revision');
    expect(hit.draft_status).toBe('draft');
  });

  it('draft_state=active hides drafts; admission_state=admitted withholds unadmitted groups', async () => {
    await seedQuestion('sb_active_ok', { prompt: '三角函数化简求值 sin²θ+cos²θ' });
    await publishAdmitted('sb_active_ok');
    await seedQuestion('sb_draft_hidden', {
      prompt: '三角函数辅助角公式 asinθ+bcosθ',
      draft: 'draft',
    });
    await seedQuestion('sb_withheld_one', { prompt: '三角函数周期 T=2π/ω 的计算' });
    // 缺省 admission（preserve → withheld/unverified_rules）。
    const pub = await publishQuestionGroupFromRow(db, {
      rootId: 'sb_withheld_one',
      actorRef: 'test:publish',
      now: new Date(),
    });
    expect(pub.status).toBe('published');

    const activeOnly = await runSearchBank(
      db,
      {
        form: 'new',
        query: '三角函数',
        scope: { draft_state: 'active', admission_state: 'any' },
        limit: 10,
      },
      { embedFn: async () => axis(0) },
    );
    expect(activeOnly.hits.map((h) => h.question_id)).not.toContain('sb_draft_hidden');
    expect(activeOnly.hits.map((h) => h.question_id).sort()).toEqual(
      ['sb_active_ok', 'sb_withheld_one'].sort(),
    );

    const admittedOnly = await runSearchBank(
      db,
      {
        form: 'new',
        query: '三角函数',
        scope: { draft_state: 'all', admission_state: 'admitted' },
        limit: 10,
      },
      { embedFn: async () => axis(0) },
    );
    expect(admittedOnly.hits.map((h) => h.question_id)).toEqual(['sb_active_ok']);
    expect(admittedOnly.scope_applied.admission_state).toBe('admitted');
  });

  it('withdrawn (archived) groups never surface as candidates', async () => {
    await seedQuestion('sb_archived_one', { prompt: '数列等差中项概念判断题（已归档）' });
    await publishAdmitted('sb_archived_one');
    // 软删 = re-draft + metadata.archived_at 墓碑（write.ts 头注决策）。
    const [row] = await db.select().from(question).where(eq(question.id, 'sb_archived_one'));
    await db
      .update(question)
      .set({ draft_status: 'draft', metadata: { archived_at: 1, archived_reason: 'test' } })
      .where(eq(question.id, 'sb_archived_one'));

    const output = await runSearchBank(
      db,
      {
        form: 'new',
        query: '等差中项',
        scope: { draft_state: 'all', admission_state: 'any' },
        limit: 10,
      },
      { embedFn: async () => axis(0) },
    );
    expect(output.hits.map((h) => h.question_id)).toEqual([]);
    expect(row.id).toBe('sb_archived_one');
  });

  it('vector channel failure degrades honestly (unavailable_channels, complete=false)', async () => {
    await seedQuestion('sb_fts_only', { prompt: '平面向量数量积的坐标运算公式' });
    await publishAdmitted('sb_fts_only');

    const output = await runSearchBank(
      db,
      {
        form: 'new',
        query: '数量积',
        scope: { draft_state: 'all', admission_state: 'any' },
        limit: 10,
      },
      {
        embedFn: async () => {
          throw new Error('deterministic fake embed failure');
        },
      },
    );
    expect(output.coverage.unavailable_channels).toEqual(['vector']);
    expect(output.coverage.complete).toBe(false);
    expect(output.hits).toHaveLength(1);
    expect(output.hits[0].match_evidence.map((e) => e.channel)).toEqual(['fts']);
  });

  it('cursor continues the same search only; pagination is stable', async () => {
    await seedQuestion('sb_pg1', { prompt: '二次函数图象开口方向与顶点坐标练习一' });
    await publishAdmitted('sb_pg1');
    await seedQuestion('sb_pg2', { prompt: '二次函数图象对称轴与顶点坐标练习二' });
    await publishAdmitted('sb_pg2');

    const pageOne = await runSearchBank(
      db,
      {
        form: 'new',
        query: '二次函数 顶点',
        scope: { draft_state: 'all', admission_state: 'any' },
        limit: 1,
      },
      { embedFn: async () => axis(0) },
    );
    expect(pageOne.hits).toHaveLength(1);
    expect(pageOne.coverage.page_has_more).toBe(true);
    expect(pageOne.coverage.candidate_pool_size).toBe(2);
    expect(pageOne.coverage.next_cursor).not.toBeNull();

    const pageTwo = await runSearchBank(
      db,
      { form: 'cursor', cursor: pageOne.coverage.next_cursor as string },
      { embedFn: async () => axis(0) },
    );
    expect(pageTwo.hits).toHaveLength(1);
    expect(pageTwo.coverage.page_has_more).toBe(false);
    expect(pageTwo.coverage.complete).toBe(true);
    expect(pageTwo.hits[0].question_id).not.toBe(pageOne.hits[0].question_id);
  });

  it('composite group surfaces as one group card; parts are not standalone candidates', async () => {
    await seedQuestion('sb_composite_root', {
      prompt: '阅读材料，完成 (1)(2) 两小题。（共享材料大题）',
    });
    const now = new Date();
    await db.insert(question).values([
      {
        id: 'sb_composite_p1',
        parent_question_id: 'sb_composite_root',
        part_index: 0,
        kind: 'question_part',
        prompt_md: '(1) 第一小问：求材料中的数量关系。',
        reference_md: '设未知数列方程',
        knowledge_ids: [],
        difficulty: 3,
        source: 'web_sourced',
        variant_depth: 0,
        draft_status: 'active',
        created_at: now,
        updated_at: now,
        version: 0,
      },
      {
        id: 'sb_composite_p2',
        parent_question_id: 'sb_composite_root',
        part_index: 1,
        kind: 'question_part',
        prompt_md: '(2) 第二小问：写出检验过程。',
        reference_md: '代回原方程',
        knowledge_ids: [],
        difficulty: 3,
        source: 'web_sourced',
        variant_depth: 0,
        draft_status: 'active',
        created_at: now,
        updated_at: now,
        version: 0,
      },
    ]);
    await publishAdmitted('sb_composite_root');

    const output = await runSearchBank(
      db,
      {
        form: 'new',
        query: '小问 检验',
        scope: { draft_state: 'all', admission_state: 'any' },
        limit: 10,
      },
      { embedFn: async () => axis(0) },
    );
    // part 行不单独成候选（父题过滤 parent_question_id IS NULL）。
    expect(output.hits.map((h) => h.question_id)).toEqual(['sb_composite_root']);
    expect(output.hits[0].kind).toBe('group');
  });

  it('subject scope resolves through the knowledge tree', async () => {
    await seedKnowledge('kc_yuwen_1', 'yuwen');
    await seedKnowledge('kc_math_1', 'math');
    await seedQuestion('sb_subject_yw', {
      prompt: '文言文中「之」字用作凭借义的判断题',
      knowledgeIds: ['kc_yuwen_1'],
    });
    await publishAdmitted('sb_subject_yw');
    await seedQuestion('sb_subject_math', {
      prompt: '文言文不再出现——指数函数单调性判断',
      knowledgeIds: ['kc_math_1'],
    });
    await publishAdmitted('sb_subject_math');

    const scoped = await runSearchBank(
      db,
      {
        form: 'new',
        query: '文言文 之',
        scope: { subject: 'yuwen', draft_state: 'all', admission_state: 'any' },
        limit: 10,
      },
      { embedFn: async () => axis(0) },
    );
    expect(scoped.scope_applied.subject).toEqual({ profile: 'yuwen', knowledge_id_count: 1 });
    expect(scoped.hits.map((h) => h.question_id)).toEqual(['sb_subject_yw']);
  });

  it('search card ref round-trips into the revision it points at', async () => {
    await seedQuestion('sb_ref_roundtrip', { prompt: '对数运算法则换底公式推导' });
    const pub = await publishAdmitted('sb_ref_roundtrip');

    const output = await runSearchBank(
      db,
      {
        form: 'new',
        query: '换底公式',
        scope: { draft_state: 'all', admission_state: 'any' },
        limit: 5,
      },
      { embedFn: async () => axis(0) },
    );
    expect(output.hits).toHaveLength(1);
    const ref = output.hits[0].ref as string;
    // 与发布 seam 铸的当前版本一致。
    if (pub.status === 'published') {
      expect(ref).toBe(encodeBankRef(pub.revision_id, pub.revision_digest));
    }
  });
});
