// YUK-361 Phase 3 Step C2 — 档2 softmax_mfi 选题编排（async shell 路径）。
//
// 这是整条选题线的**第一个真行为变更**：把 Step A（候选信号）→ Step B（L2 LLM
// 权重）→ Step C1（tempered-softmax sampler + π_i）接成一条 async 选题路径，改变
// owner 每日看到的**非到期**题选择。到期项（presence + intra-day 序）仍 L1 确定性，
// **不动**（档2 不取档3）。
//
// 权威 spec：
//   - docs/superpowers/plans/2026-06-16-phase3-randomized-mfi-impl.md（Step C）
//   - ADR-0042 编排档2 amendment（docs/adr/0042-...md:46-68）
//
// ════════════════════════════════════════════════════════════════════════════
// 4 条不可让铁律（ADR-0042:58，本模块的 L3 守门保全）：
//   ① 不写 b（difficulty 单写者只读，三轴正交）——本模块从不写 item_calibration。
//   ② 到期 presence + intra-day 序（L1 确定性，NOT sampled/reordered by LLM）。
//   ③ recall-locked = 同题重背（never sampled/varied/MFI-scored）。
//   ④ 容量 + draft 排除 + dedup。
// ════════════════════════════════════════════════════════════════════════════
//
// 控制流（三条路径，两级 fallback，**永不 throw 出去**——日常工具不能挂）：
//   softmax 主路：候选信号 → L2 LLM 权重 → sampler 抽样 → 落题 + 记真 π_i。
//     ├─ L1 fallback（LLM/runTask 挂 OR parse 挂 OR 空）：纯统计 sampler，
//     │    用 mfiScore（退 diagnosticScore）当权重跑 sampleByWeight（仍记真 π_i）。
//     └─ L2 fallback（候选收集本身挂 / catastrophic）：退确定性 composeDailyStream
//          （legacy，π_i 不记）。
//
// composeDailyStream（stream-composer.ts）保持 PURE 不动——它是 L2 fallback + legacy
// policy 的承重确定性核心（7 单测钉死）。本模块是它之外的**独立新 async 路径**。

import type { QuestionKindT } from '@/core/schema/judge-routing';
import type { Db, Tx } from '@/db/client';
import { question } from '@/db/schema';
import { inArray } from 'drizzle-orm';

import {
  buildSelectionOrchestratorInput,
  parseSelectionOrchestratorOutput,
} from '@/server/ai/selection-orchestrator';
import {
  type CandidateInput,
  type CollectedSignal,
  collectCandidateSignals,
} from './candidate-signals';
import { DEFAULT_TEMPERATURE, type SelectionPolicyConfig } from './selection-constants';
import { type WeightedCandidate, sampleByWeight } from './selection-sampler';
import {
  type ComposerInputs,
  type StreamPlan,
  type StreamPlanItem,
  composeDailyStream,
} from './stream-composer';

type DbLike = Db | Tx;

// ───────────────────────────────────────────────────────────────────────────
// 依赖注入（测试可 mock runTask / rng，**绝不命中 live endpoint**）。
// ───────────────────────────────────────────────────────────────────────────

/** runTask 投影（只取 .text）。与 review-session.ts:RunTaskFn 同形——DI 便于 mock。 */
export type RunTaskFn = (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;

/** 哪一级 fallback 触发了（观测/测试断言用）。'none' = softmax 主路全程成功。 */
export type FallbackLevel = 'none' | 'statistical' | 'legacy';

export interface ComposeSoftmaxDeps {
  /** L2 LLM 编排器。省略 → 默认动态 import runTask（production 路径）。 */
  runTaskFn?: RunTaskFn;
  /** Poisson 抽样 rng（默认 Math.random）；测试传 seeded rng 确定化。 */
  rng?: () => number;
}

export interface ComposeSoftmaxResult {
  plan: StreamPlan;
  /** 哪一级 fallback 触发（'none' = softmax 主路成功）。 */
  fallback: FallbackLevel;
  /**
   * 被 sampler 抽中的**非到期**项的 π_i 快照（喂 Phase 6 active-PPI IPW）。
   * 物化后由调用方据此 recordSelectionObservation（streamItemId=物化 id）。
   * key = refId。recall-locked passthrough / 到期项 / paper 透传**不在**此 map
   * （它们 π_i=1 确定性，非随机抽样——IPW 只关心被抽样的非到期项）。
   */
  sampledInclusion: Map<string, number>;
  /** 每个**非到期** ref 的信号快照（物化进 StreamPlanItem.signals，已在 plan 里）。 */
  signalByRef: Map<string, CollectedSignal>;
}

// ───────────────────────────────────────────────────────────────────────────
// 容量常量（与 composeDailyStream DEFAULT_WARN/MAX 对齐——单一真相，不漂移）。
// ───────────────────────────────────────────────────────────────────────────
const DEFAULT_WARN = 12;
const DEFAULT_MAX = 30;

function kpSuffix(label?: string): string {
  return label ? `「${label}」` : '这一块';
}

// ───────────────────────────────────────────────────────────────────────────
// 候选富化：variant/new_check 候选只带 questionId，需补 kind/knowledge_ids/difficulty
// 才能算 MFI（candidate-signals 据此聚合 θ̂_min + recall 路由 + b 弱锚）。批量点查
// question 表（一次 inArray），缺字段 → undefined（信号层退化为 MFI-less，不 throw）。
// ───────────────────────────────────────────────────────────────────────────

interface NonDueRaw {
  questionId: string;
  role: SelectionOrchestratorCandidateRole;
  knowledgeLabel?: string;
}

/** 非到期候选在本模块内部的角色（与 CandidateInput.role 同集，去 'due'/'paper'）。 */
type SelectionOrchestratorCandidateRole = 'variant' | 'new_check';

async function enrichCandidates(db: DbLike, raws: NonDueRaw[]): Promise<CandidateInput[]> {
  if (raws.length === 0) return [];
  const qids = [...new Set(raws.map((r) => r.questionId))];
  const rows = await db
    .select({
      id: question.id,
      kind: question.kind,
      knowledge_ids: question.knowledge_ids,
      difficulty: question.difficulty,
    })
    .from(question)
    .where(inArray(question.id, qids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return raws.map((raw) => {
    const q = byId.get(raw.questionId);
    return {
      refKind: 'question' as const,
      refId: raw.questionId,
      // CandidateInput.role 用 core role 集（'diagnostic'/'new_check'/...）。变体候选
      // 走诊断角色（可换变体 → 进 MFI 评分）；new_check 候选保 new_check 角色。
      role: raw.role === 'new_check' ? ('new_check' as const) : ('diagnostic' as const),
      kind: q?.kind as QuestionKindT | undefined,
      knowledgeIds: q?.knowledge_ids,
      difficulty: q?.difficulty,
    };
  });
}

// ───────────────────────────────────────────────────────────────────────────
// reasoning 模板（softmax 路径的占位文案；M4 夜链 AI 化后由 composer 写 AI 文案）。
// ───────────────────────────────────────────────────────────────────────────
function dueReasoning(label?: string): string {
  return `我看了你的曲线：${kpSuffix(label)}到了复习边缘，先把它咬住。`;
}
function variantReasoning(label?: string): string {
  return `之前${kpSuffix(label)}翻过车，这道换了说法再来一次。`;
}
function newCheckReasoning(label?: string): string {
  return `你刚学了${kpSuffix(label)}，自测一道确认真的进脑子了。`;
}
function paperReasoning(
  title: string,
  source: ComposerInputs['pendingPapers'][number]['source'],
): string {
  return source === 'on_demand'
    ? `你点播的「${title}」排好了——卷内不给即时反馈，交卷统一判。`
    : source === 'import'
      ? `你导入的「${title}」在待做里——交卷后统一判分。`
      : `散题做完后用「${title}」收口——卷内不给即时反馈，交卷统一判。`;
}

// ───────────────────────────────────────────────────────────────────────────
// 主入口。
// ───────────────────────────────────────────────────────────────────────────

/**
 * composeSoftmaxStream — 档2 LLM-strong 选题编排（async）。
 *
 * **永不 throw**：两级 fallback 兜底（statistical → legacy）保证总返回合法 StreamPlan。
 * 调用方（stream-store getStream/recompose）物化 plan 后，据 result.sampledInclusion
 * 对每个被抽中的非到期项 recordSelectionObservation（π_i + policy='softmax_mfi'）。
 */
export async function composeSoftmaxStream(
  db: DbLike,
  inputs: ComposerInputs,
  config: SelectionPolicyConfig,
  deps: ComposeSoftmaxDeps = {},
): Promise<ComposeSoftmaxResult> {
  const warn = inputs.capacity?.warn ?? DEFAULT_WARN;
  const max = inputs.capacity?.max ?? DEFAULT_MAX;
  const temperature = config.temperature ?? DEFAULT_TEMPERATURE;

  // ── dedup 真相源（铁律④）：到期项先到先得；非到期/卷不与已排 ref 重复（in-memory
  //    seen + materializeStream date+ref 唯一索引双保险）。
  const seen = new Set<string>();

  // ① 到期项（L1 确定性）——presence + due_at ASC 序原样透传，NEVER sampled/reordered。
  const dueItems = inputs.dueItems.filter((d) => !seen.has(d.questionId) && seen.add(d.questionId));
  const dueDrafts: Omit<StreamPlanItem, 'position'>[] = dueItems.map((d) => ({
    item_kind: 'question',
    ref_id: d.questionId,
    source: 'decay',
    reasoning: dueReasoning(d.knowledgeLabel),
    // 到期项不带选题信号（它们不经 sampler/MFI）——signals 缺省 {}（materialize 兜底）。
  }));
  const dueRefSet = new Set(dueDrafts.map((d) => d.ref_id));

  // ② 非到期候选（variant + new_check）——去重后是 sampler 的池子。
  const variantRaws: NonDueRaw[] = inputs.variantItems
    .filter((v) => !seen.has(v.questionId) && seen.add(v.questionId))
    .map((v) => ({ questionId: v.questionId, role: 'variant', knowledgeLabel: v.knowledgeLabel }));
  const newCheckRaws: NonDueRaw[] = inputs.newCheckItems
    .filter((n) => !seen.has(n.questionId) && seen.add(n.questionId))
    .map((n) => ({
      questionId: n.questionId,
      role: 'new_check',
      knowledgeLabel: n.knowledgeLabel,
    }));
  const nonDueRaws = [...variantRaws, ...newCheckRaws];
  const labelByRef = new Map<string, string | undefined>(
    nonDueRaws.map((r) => [r.questionId, r.knowledgeLabel]),
  );
  const roleByRef = new Map<string, SelectionOrchestratorCandidateRole>(
    nonDueRaws.map((r) => [r.questionId, r.role]),
  );

  // ③ 卷（paper）——透传，不进 MFI/sampler（卷不可拆，组卷层已处理内部题）。容量内置后。
  const paperDrafts: Omit<StreamPlanItem, 'position'>[] = inputs.pendingPapers
    .filter((p) => !seen.has(p.paperId) && seen.add(p.paperId))
    .map((p) => ({
      item_kind: 'paper' as const,
      ref_id: p.paperId,
      source: p.source,
      reasoning: paperReasoning(p.title, p.source),
    }));

  // ── L2 fallback 入口（候选收集本身挂 / catastrophic）：退确定性 composeDailyStream。
  //    把整条 softmax 路径（含信号收集）包在 try 里——任何非 fallback-内部消化的异常
  //    都退 legacy（日常工具不能 throw 出去）。
  let signals: CollectedSignal[];
  try {
    const candidates = await enrichCandidates(db, nonDueRaws);
    signals = await collectCandidateSignals(db, candidates);
  } catch (err) {
    console.warn('[softmax-selection] candidate collection failed → legacy fallback', {
      err: err instanceof Error ? err.message : String(err),
    });
    return legacyFallback(inputs);
  }

  // recall-locked passthrough（铁律③）：recall-locked 非到期候选**不进 sampler/MFI**
  //   ——它们是原题重背，确定性透传（same question re-shown），从信号收集结果里切出来。
  //   collectCandidateSignals 已给它们 recallLocked:true 且 mfiScore/diagnosticScore
  //   恒 undefined；这里把它们从 weighted 池剔除，单独确定性纳入。
  const recallLocked = signals.filter((s) => s.refKind === 'question' && s.recallLocked === true);
  const recallLockedRefs = new Set(recallLocked.map((s) => s.refId));
  const samplable = signals.filter(
    (s) => s.refKind === 'question' && !recallLockedRefs.has(s.refId),
  );

  // signalByRef：所有非到期题的信号快照（含 recall-locked），物化进 StreamPlanItem.signals。
  const signalByRef = new Map<string, CollectedSignal>(signals.map((s) => [s.refId, s]));

  // ── 容量预算：非到期 sampler 的 targetCount = 容量 − 到期 − 卷 − recall透传 − new_check保底
  //    （≥0）。到期项 hard-present 不占可调预算；卷 + recall 确定性纳入也先扣除。
  const fixedCount = dueDrafts.length + paperDrafts.length + recallLocked.length;
  const nonDueBudget = Math.max(0, max - fixedCount);

  // ── softmax 主路 + L1 fallback：拿到 WeightedCandidate[]（LLM 权重 OR 统计权重）。
  let fallback: FallbackLevel = 'none';
  let weighted: WeightedCandidate[];
  let arrangementByRef = new Map<string, number>();

  if (samplable.length === 0) {
    // 无可抽样非到期候选（全到期/全 recall/全卷）——无需调 LLM，直接空抽样。
    weighted = [];
  } else {
    const llmResult = await tryLlmOrchestration(db, samplable, deps.runTaskFn);
    if (llmResult) {
      weighted = llmResult.weighted;
      arrangementByRef = llmResult.arrangementByRef;
    } else {
      // L1 fallback：LLM/parse 挂或空 → 纯统计 sampler（MFI/诊断分当权重）。
      fallback = 'statistical';
      weighted = statisticalWeights(samplable);
    }
  }

  // ── 抽样：sampleByWeight 出真 π_i（Poisson IPPS）。
  const sampled =
    weighted.length === 0
      ? []
      : sampleByWeight(weighted, { temperature, targetCount: nonDueBudget, rng: deps.rng });
  const sampledInclusion = new Map<string, number>(
    sampled.map((s) => [s.refId, s.inclusionProbability]),
  );

  // ── 组装：到期（L1 序） + recall 透传 + 抽中非到期（LLM arrangement 序） + 卷 + 收尾。
  const nonDueDrafts: Omit<StreamPlanItem, 'position'>[] = [];

  // recall-locked 透传（确定性 same-question，不排序不换题——按 collect 顺序纳入）。
  for (const s of recallLocked) {
    nonDueDrafts.push({
      item_kind: 'question',
      ref_id: s.refId,
      source: roleByRef.get(s.refId) === 'new_check' ? 'new_check' : 'variant',
      reasoning:
        roleByRef.get(s.refId) === 'new_check'
          ? newCheckReasoning(labelByRef.get(s.refId))
          : variantReasoning(labelByRef.get(s.refId)),
      signals: s as unknown as Record<string, unknown>,
    });
  }

  // 抽中的非到期项——按 LLM arrangement（越小越靠前）排；无 arrangement 的排后、保抽样序。
  const sampledOrdered = [...sampled].sort((a, b) => {
    const aa = arrangementByRef.get(a.refId);
    const bb = arrangementByRef.get(b.refId);
    if (aa === undefined && bb === undefined) return 0;
    if (aa === undefined) return 1;
    if (bb === undefined) return -1;
    return aa - bb;
  });
  for (const s of sampledOrdered) {
    const role = roleByRef.get(s.refId);
    nonDueDrafts.push({
      item_kind: 'question',
      ref_id: s.refId,
      source: role === 'new_check' ? 'new_check' : 'variant',
      reasoning:
        role === 'new_check'
          ? newCheckReasoning(labelByRef.get(s.refId))
          : variantReasoning(labelByRef.get(s.refId)),
      signals: signalByRef.get(s.refId) as unknown as Record<string, unknown>,
    });
  }

  // 顺序：到期（L1 序，热身/优先） → 非到期散题（recall 透传 + 抽中） → 卷收口。
  const assembled = [...dueDrafts, ...nonDueDrafts, ...paperDrafts];

  // ── L3 容量守门（铁律④）：超 max 截断。**到期项受保护**——截断只砍非到期/卷尾部，
  //    到期项永不被容量截掉（presence 铁律②优先于容量）。
  const { kept, truncated } = capacityGuard(assembled, dueRefSet, max);

  const plan: StreamPlan = {
    date: inputs.date,
    items: kept.map((d, i) => ({ ...d, position: i + 1 })),
    truncated,
    warned: assembled.length > warn,
  };

  // ── L3 守门断言（presence / recall）——assemble 后校验，违例即 bug，throw 留痕
  //    （这是确定性逻辑 bug，不是 LLM/IO 失败——不该被 fallback 吞，要在测试/CI 暴露）。
  assertL3Invariants(plan, dueRefSet, recallLockedRefs, sampledInclusion);

  // 截断后被砍掉的 sampled 项要从 inclusion map 移除（没物化就不该记 π_i）。
  const keptRefs = new Set(plan.items.map((it) => it.ref_id));
  for (const ref of [...sampledInclusion.keys()]) {
    if (!keptRefs.has(ref)) sampledInclusion.delete(ref);
  }

  return { plan, fallback, sampledInclusion, signalByRef };
}

// ───────────────────────────────────────────────────────────────────────────
// L2 LLM 编排（softmax 主路）。失败/空 → null（调用方走 L1 统计 fallback）。
// ───────────────────────────────────────────────────────────────────────────
async function tryLlmOrchestration(
  db: DbLike,
  samplable: CollectedSignal[],
  runTaskFn?: RunTaskFn,
): Promise<{ weighted: WeightedCandidate[]; arrangementByRef: Map<string, number> } | null> {
  try {
    const inputText = buildSelectionOrchestratorInput(samplable);
    if (inputText.trim().length === 0) return null;
    const fn = runTaskFn ?? (await defaultRunTaskFn());
    const result = await fn('SelectionOrchestratorTask', { candidates: inputText }, { db });
    const refIds = samplable.map((s) => s.refId);
    const parsed = parseSelectionOrchestratorOutput(result.text, refIds);
    if (parsed.length === 0) return null;
    const weighted: WeightedCandidate[] = parsed.map((c) => ({ refId: c.refId, weight: c.weight }));
    const arrangementByRef = new Map<string, number>();
    for (const c of parsed) {
      if (c.arrangement !== undefined) arrangementByRef.set(c.refId, c.arrangement);
    }
    return { weighted, arrangementByRef };
  } catch (err) {
    console.warn('[softmax-selection] L2 LLM orchestration failed → statistical fallback', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** 默认 production runTask（动态 import 避免 server-only 模块进 unit graph）。 */
async function defaultRunTaskFn(): Promise<RunTaskFn> {
  const { runTask } = await import('@/server/ai/runner');
  return (kind, input, ctx) => runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
}

// ───────────────────────────────────────────────────────────────────────────
// L1 fallback：纯统计 sampler。用 mfiScore（退 diagnosticScore，再退小正权）当权重。
// ───────────────────────────────────────────────────────────────────────────
function statisticalWeights(samplable: CollectedSignal[]): WeightedCandidate[] {
  return samplable.map((s) => {
    // mfiScore 优先；缺则 diagnosticScore；都缺（无 θ̂/b）给一个小正权（仍可被抽中，
    // π_i>0 保 positivity——softmax 退化为近均匀，符合「无信号 → 不偏好」语义）。
    const weight = s.mfiScore ?? s.diagnosticScore ?? 0.01;
    return { refId: s.refId, weight };
  });
}

// ───────────────────────────────────────────────────────────────────────────
// L2 fallback：退确定性 composeDailyStream（legacy）。π_i 不记（确定性无随机抽样）。
// ───────────────────────────────────────────────────────────────────────────
function legacyFallback(inputs: ComposerInputs): ComposeSoftmaxResult {
  return {
    plan: composeDailyStream(inputs),
    fallback: 'legacy',
    sampledInclusion: new Map(),
    signalByRef: new Map(),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// L3：容量守门——超 max 截断，但**到期项受保护**（presence 铁律②优先）。
// ───────────────────────────────────────────────────────────────────────────
function capacityGuard(
  assembled: Omit<StreamPlanItem, 'position'>[],
  dueRefSet: Set<string>,
  max: number,
): { kept: Omit<StreamPlanItem, 'position'>[]; truncated: boolean } {
  if (assembled.length <= max) return { kept: assembled, truncated: false };
  // 必须保留全部到期项；非到期/卷按当前顺序填满剩余容量。
  const dues = assembled.filter((d) => dueRefSet.has(d.ref_id));
  const rest = assembled.filter((d) => !dueRefSet.has(d.ref_id));
  const remaining = Math.max(0, max - dues.length);
  const keptRest = rest.slice(0, remaining);
  // 维持原相对顺序：到期项在前（L1 序），非到期保留段紧随——assembled 已是该序，
  // 重组时按「先到期、后保留的非到期」拼回（到期项本就在前）。
  const keptRestSet = new Set(keptRest.map((d) => d.ref_id));
  const kept = assembled.filter((d) => dueRefSet.has(d.ref_id) || keptRestSet.has(d.ref_id));
  return { kept, truncated: true };
}

// ───────────────────────────────────────────────────────────────────────────
// L3：断言守门（presence 铁律② + recall 铁律③）。
// ───────────────────────────────────────────────────────────────────────────
function assertL3Invariants(
  plan: StreamPlan,
  dueRefSet: Set<string>,
  recallLockedRefs: Set<string>,
  sampledInclusion: Map<string, number>,
): void {
  const planRefs = new Set(plan.items.map((it) => it.ref_id));
  // 铁律②：每个到期项必须在最终流（presence）。容量守门已保护到期项——若仍缺，是 bug。
  for (const dueRef of dueRefSet) {
    if (!planRefs.has(dueRef)) {
      throw new Error(
        `[softmax-selection] L3 due-presence violated: due item ${dueRef} missing from final plan`,
      );
    }
  }
  // 铁律③：recall-locked 项**不得**出现在 sampledInclusion（它们走确定性透传，从不抽样）。
  for (const ref of recallLockedRefs) {
    if (sampledInclusion.has(ref)) {
      throw new Error(
        `[softmax-selection] L3 recall-lock violated: recall item ${ref} was sampled (must be deterministic passthrough)`,
      );
    }
  }
}
