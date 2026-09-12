// YUK-988 (Supply-Agent/3) — web_fetch_candidates tool db 测试。
//
// 锁死 candidate-only 边界（SourcingTask 找题 + 判题；不写 question / verify intent /
// proposal）：ok 路（含幻觉 knowledge_id 的活体校验 + 锚点回退）、anchor_not_found、
// kind_gate、tavily_unavailable（dep 返回 null）、parse 失败。runSourcingAgent 注入
// fake（不依赖真 Tavily/LLM）；parseLoose 走真身（parse 失败路真实可测）。

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { event, knowledge, question } from '@/db/schema';
import { resolveSubjectProfile } from '@/subjects/profile';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import type {
  RunWebSourcingAgentFn,
  WebSourcingAgentInput,
} from '../question-supply/web-candidates';
import { executeWebFetchCandidates, webFetchCandidatesTool } from './web-fetch-candidates';

const db = testDb();

beforeEach(() => resetDb());

const NOW = new Date('2026-09-01T00:00:00Z');

async function seedTree(): Promise<void> {
  await db.insert(knowledge).values([
    {
      id: 'math-root',
      name: '数学',
      domain: 'math',
      parent_id: null,
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'kc-anchor',
      name: '二次函数',
      // 锚点自带 domain → subject 服务端解析的受测面（无 domain 的 KC 会落到 general）。
      domain: 'math',
      parent_id: 'math-root',
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'kc-sets',
      name: '集合',
      domain: null,
      parent_id: 'math-root',
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'kc-dead',
      name: '已归档考点',
      domain: null,
      parent_id: 'math-root',
      created_at: NOW,
      updated_at: NOW,
      archived_at: NOW,
    },
  ]);
}

// ── realistic SourcingTask fixtures（长题干 / 嵌套 choices / 真实感 URL / 难度证据）──

const Q_VALID_CHOICE = {
  kind: 'choice',
  prompt_md:
    '已知二次函数 f(x)=ax²+2ax+3（a≠0）的图象经过点 A(1,4)，且对称轴在直线 x=1 的左侧。' +
    '若 f(x) 在闭区间 [0,2] 上的最大值为 7，则实数 a 的取值集合为（　）',
  reference_md:
    '【答案】B\n【分析】由 f(1)=a+2a+3=4 解得 a=1/3，此时对称轴 x=-1 在 x=1 左侧，与题设矛盾，' +
    '故按区间最值分类讨论：当 -1≤-a≤2 时最大值在端点取得；当 -a<-1 时 f(x) 在 [0,2] 单调递增，' +
    'f(2)=8a+3=7 得 a=1/2，但 -a=-1/2>-1 不满足单调前提，舍去；继续讨论端点与顶点值综合比较。\n' +
    '【解答】分类讨论得 -3<a<0，选 B。',
  choices_md: ['A. a≤-3 或 a≥1/2', 'B. -3<a<0', 'C. 0<a<1/3', 'D. a=1/2'],
  judge_kind_override: 'exact',
  difficulty: 4,
  difficulty_evidence: {
    version: 1,
    value: 4,
    scale: 'loom_difficulty_1_5',
    basis: 'producer_estimate',
    confidence: 0.35,
    source_route: 'sourcing_web',
  },
  knowledge_ids: ['kc-sets'],
  source_url: 'https://www.zhixin.com/math/ques/detail/2025-0931',
  source_title: '2026 届某市高三第二次模拟考试 数学（理）第 11 题',
  extraction_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  extract:
    '网页原文节选：已知二次函数 f(x)=ax²+2ax+3（a≠0）的图象经过点 A(1,4)，且对称轴在直线 x=1 ' +
    '的左侧。若 f(x) 在闭区间 [0,2] 上的最大值为 7，则实数 a 的取值集合为（　）A. a≤-3 或 a≥1/2 ' +
    'B. -3<a<0 C. 0<a<1/3 D. a=1/2 ……【答案】B 【分析】分类讨论区间最值。',
};

const Q_GHOST_SHORT_ANSWER = {
  kind: 'short_answer',
  prompt_md:
    '设集合 A={x | x²-5x+6=0}，B={x | ax-2=0}。若 B⊆A，求实数 a 的所有取值组成的集合，' +
    '并讨论当 a 变化时 B 为空集的条件是否需要单独列入结果。',
  reference_md:
    '【答案】{1/2, 2/3} 或 ∅（当且仅当 B=∅ 即方程无解时，注意 a=0 时 B=∅ 亦满足 B⊆A）\n' +
    '【分析】A={2,3}；B⊆A 需分 B=∅（a=0）与 B≠∅（2/a∈A）两类讨论。\n' +
    '【解答】a=0 时 B=∅ 成立；a≠0 时 2/a=2 得 a=1，2/a=3 得 a=2/3。综上 a∈{0, 1, 2/3}。',
  difficulty: 2,
  difficulty_evidence: {
    version: 1,
    value: 2,
    scale: 'loom_difficulty_1_5',
    basis: 'producer_estimate',
    confidence: 0.35,
    source_route: 'sourcing_web',
  },
  knowledge_ids: ['kc-ghost-1', 'kc-ghost-2'],
  source_url: 'https://www.jyeoo.com/math2/ques/detail/ghost-881',
  source_title: '集合与子集关系分类讨论 经典例题',
  extract:
    '网页原文节选：设集合 A={x | x²-5x+6=0}，B={x | ax-2=0}。若 B⊆A，求实数 a 的所有取值组成' +
    '的集合……【答案】a∈{0, 1, 2/3}（含 B=∅ 的讨论）。',
};

const IMAGE_CANDIDATE = {
  source_url: 'https://www.pep.com.cn/gzsx/jszx_1/czsxtbjx/2026/t22886/',
  source_title: '人教版高三数学摸底卷（扫描版 PDF 页）',
  summary_md:
    '整卷为扫描图片，题干不可提取：第 17-21 题为解析几何与导数综合大题，含手写批注与辅助线，' +
    '需 VLM 抽取（accept 后的付费动作）。建议整页提取后再拆题。',
};

function sourcingOutputText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    questions: [Q_VALID_CHOICE, Q_GHOST_SHORT_ANSWER],
    image_candidates: [IMAGE_CANDIDATE],
    query_plan: [
      '二次函数 区间最值 高考真题 分类讨论',
      'site:zhixin.com 二次函数 选择题 模拟卷',
      '集合 包含关系 参数取值 解答题',
    ],
    fetched_at: '2026-09-12T02:14:03.000Z',
    tool: 'tavily',
    ...overrides,
  });
}

/** fake LLM 相位：记录收到的 SourcingTask 输入并返回固定 text（默认合法输出）。 */
function fakeAgent(
  calls: WebSourcingAgentInput[],
  text: string = sourcingOutputText(),
): RunWebSourcingAgentFn {
  return async (params) => {
    calls.push(params.input);
    return { text, task_run_id: 'tr_sourcing_web_1', cost_usd: 0.42 };
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    anchor_knowledge_id: 'kc-anchor',
    knowledge_ids: ['kc-sets', 'kc-dead'],
    count: 3,
    ...overrides,
  };
}

async function runTool(
  input: ReturnType<typeof baseInput>,
  runSourcingAgent: RunWebSourcingAgentFn,
) {
  return executeWebFetchCandidates({ db, taskRunId: 'test-run' }, input, {
    runSourcingAgent,
  });
}

async function canaryRows() {
  return db.select().from(event).where(eq(event.action, 'experimental:web_fetch_candidates'));
}

describe('web_fetch_candidates — ok path', () => {
  it('returns candidates with live-validated knowledge ids and writes NO question/proposal rows', async () => {
    await seedTree();
    const agentCalls: WebSourcingAgentInput[] = [];
    const output = await runTool(baseInput(), fakeAgent(agentCalls));

    expect(output.status).toBe('ok');
    if (output.status !== 'ok') return;
    // 输出 schema 自洽（tool 定义的 zod 镜像可解析真结果）。
    expect(webFetchCandidatesTool.outputSchema.safeParse(output).success).toBe(true);

    // 2 候选：valid id 原样保留；幻觉 id 被丢、回退到活 resolver 序（锚点优先，归档 KC 剔除）。
    expect(output.candidates).toHaveLength(2);
    expect(output.candidates[0]?.question.knowledge_ids).toEqual(['kc-sets']);
    expect(output.candidates[1]?.question.knowledge_ids).toEqual(['kc-anchor', 'kc-sets']);
    expect(output.candidates[0]?.extraction_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(output.candidates[0]?.source_id).toBeNull();
    expect(output.candidates[0]?.staged_asset_ids).toEqual([]);
    expect(output.candidates[0]?.candidate_id).toBe('webcand_kc-anchor_1');
    // 题面其余字段逐字保真（不重写、不裁剪）。
    expect(output.candidates[0]?.question.prompt_md).toBe(Q_VALID_CHOICE.prompt_md);
    expect(output.candidates[1]?.question.knowledge_ids).not.toContain('kc-ghost-1');

    // 图片型候选原样返回（proposal 是调用方的决定）。
    expect(output.image_candidates).toHaveLength(1);
    expect(output.image_candidates[0]?.source_url).toBe(IMAGE_CANDIDATE.source_url);
    expect(output.query_plan).toHaveLength(3);
    expect(output.task_run_id).toBe('tr_sourcing_web_1');
    expect(output.cost_usd).toBe(0.42);
    // fetched_at 是核的执行时钟（now.toISOString()），非 agent 自报值。
    expect(Number.isNaN(Date.parse(output.fetched_at))).toBe(false);

    // candidate-only：不写 question、不写 proposal。
    const questions = await db.select().from(question);
    expect(questions).toHaveLength(0);
    const proposals = await db.select().from(event).where(eq(event.action, 'propose'));
    expect(proposals).toHaveLength(0);

    const canary = await canaryRows();
    expect(canary).toHaveLength(1);
    expect(canary[0]).toMatchObject({
      actor_kind: 'agent',
      actor_ref: 'sourcing',
      action: 'experimental:web_fetch_candidates',
      subject_kind: 'query',
      subject_id: 'tr_sourcing_web_1',
      outcome: 'success',
      task_run_id: 'test-run',
    });
    expect(canary[0]?.payload).toMatchObject({
      anchor_knowledge_id: 'kc-anchor',
      knowledge_ids: ['kc-sets', 'kc-dead'],
      count: 3,
      tool: 'web_fetch_candidates',
      task_run_id: 'test-run',
      candidate_ids: ['webcand_kc-anchor_1', 'webcand_kc-anchor_2'],
      image_candidate_count: 1,
      cost_usd: 0.42,
    });

    // SourcingTask 输入契约与旧 sourcing job 一致：subject 由锚点 domain 解析、
    // whitelist 为 profile 宽容读取（空 → []）、ref/knowledge_context 挂锚点。
    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0]?.subject).toBe('math');
    // whitelist 为 profile 宽容读取（math profile 当前携带真实白名单——与 resolve 面
    // 同源，锁“宽容读取不断链”而非具体域名表）。
    expect(agentCalls[0]?.whitelist).toEqual(resolveSubjectProfile('math').sourceWhitelist);
    expect(agentCalls[0]?.count).toBe(3);
    expect(agentCalls[0]?.ref.id).toBe('kc-anchor');
    expect(agentCalls[0]?.knowledge_context[0]?.id).toBe('kc-anchor');
  });
});

describe('web_fetch_candidates — deterministic failures', () => {
  it('fails anchor_not_found for a missing/archived anchor (no LLM call)', async () => {
    await seedTree();
    const agentCalls: WebSourcingAgentInput[] = [];
    const output = await runTool(
      baseInput({ anchor_knowledge_id: 'kc-missing' }),
      fakeAgent(agentCalls),
    );
    expect(output).toMatchObject({ status: 'failed', failure_class: 'anchor_not_found' });
    expect(agentCalls).toHaveLength(0);
    const canary = await canaryRows();
    expect(canary).toHaveLength(1);
    expect(canary[0]?.outcome).toBe('failure');
    // 未产生任何 question / proposal。
    expect(await db.select().from(question)).toHaveLength(0);
  });

  it('fails kind_gate when a kind-pinned run produces a mismatched kind', async () => {
    await seedTree();
    // kind_required + kind='choice'：两题中第二题是 short_answer → 违约。
    const output = await runTool(
      baseInput({ kind: 'choice', kind_required: true }),
      fakeAgent([], sourcingOutputText()),
    );
    expect(output).toMatchObject({ status: 'failed', failure_class: 'kind_gate' });
    expect(await db.select().from(question)).toHaveLength(0);
  });

  it('fails tavily_unavailable when the sourcing dep returns null (no TAVILY_API_KEY)', async () => {
    await seedTree();
    const nullAgent: RunWebSourcingAgentFn = async () => null;
    const output = await runTool(baseInput(), nullAgent);
    expect(output).toMatchObject({ status: 'failed', failure_class: 'tavily_unavailable' });
    const canary = await canaryRows();
    expect(canary).toHaveLength(0);
  });

  it('fails parse when the agent text carries no JSON object (riskyRepair:reject seam intact)', async () => {
    await seedTree();
    const output = await runTool(
      baseInput(),
      fakeAgent([], '检索完成：本轮未找到可结构化的题源页面，仅有人工整理的目录索引。'),
    );
    expect(output).toMatchObject({ status: 'failed', failure_class: 'parse' });
    if (output.status !== 'failed') return;
    expect(output.detail).toContain('no JSON object');
    expect(await db.select().from(question)).toHaveLength(0);
    const canary = await canaryRows();
    expect(canary).toHaveLength(1);
    expect(canary[0]).toMatchObject({
      actor_ref: 'sourcing',
      subject_kind: 'query',
      outcome: 'failure',
      task_run_id: 'test-run',
    });
    expect(canary[0]?.payload).toMatchObject({
      failure_class: 'parse',
      tool: 'web_fetch_candidates',
    });
  });
});
