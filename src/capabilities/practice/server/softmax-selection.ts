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

import { QuestionKind } from '@/core/schema/business';
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
      // FINDING 4（fail-open→fail-closed）：DB question.kind 是 text 列，行里可能存
      //   **不在 QuestionKind 枚举内**的脏值（历史脏数据 / enum 收缩后的遗留 / 手填）。
      //   裸 `as QuestionKindT` 会把脏值原样传给 collectQuestionSignal → rotationClassForKind
      //   读 `ROTATION_CLASS_BY_KIND[脏值]` 返 undefined → `=== 'recall'` 为假 → recallLocked
      //   =false → 题被 sampler 抽样，违反铁律③（身份不明的题不得被抽样/MFI 评分）。
      //   故在此用 enum 校验：枚举内 → 传真 kind；枚举外/缺失 → 传 undefined，落到
      //   collectQuestionSignal 的 `cand.kind ? … : true` 保守分支 → recallLocked（不抽样）。
      kind: resolveEnumKind(q?.kind),
      knowledgeIds: q?.knowledge_ids,
      difficulty: q?.difficulty,
    };
  });
}

/**
 * 把 DB 读到的 question.kind（text，可能脏）收敛成**枚举内**的 QuestionKindT 或 undefined。
 * 枚举外的值（含 null/缺失）→ undefined，使 collectQuestionSignal 走 fail-closed recall-lock
 * 分支（FINDING 4，铁律③深防御）。
 */
function resolveEnumKind(kind: string | null | undefined): QuestionKindT | undefined {
  const parsed = QuestionKind.safeParse(kind);
  return parsed.success ? (parsed.data as QuestionKindT) : undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// reasoning 模板（softmax 路径的占位文案；M4 夜链 AI 化后由 composer 写 AI 文案）。
// ───────────────────────────────────────────────────────────────────────────
function dueReasoning(label?: string): string {
  return `我看了你的曲线：${kpSuffix(label)}到了复习边缘，先把它咬住。`;
}
// Task 9 增量重排（stream-store.reRankAfterAnswer）复用这两个模板——重抽样换进的新候选
// 需生成与首次 compose 一致的 reasoning 文案（单一真相，不重复 kpSuffix 模板）。
export function variantReasoning(label?: string): string {
  return `之前${kpSuffix(label)}翻过车，这道换了说法再来一次。`;
}
export function newCheckReasoning(label?: string): string {
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
  // 到期项的 L1 真相序（dedup 后，due_at ASC）——assertL3Invariants 据此校验 plan 里
  //   due 子序列**顺序**与 L1 一致（铁律②不止 presence，还含 intra-day 序）。
  const dueRefOrder = dueDrafts.map((d) => d.ref_id);
  const dueRefSet = new Set(dueRefOrder);

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

  // ── 容量预算：非到期 sampler 的 targetCount = 容量 − 到期 − recall透传（≥0）。
  //
  //    FINDING C（卷不得预扣 sampler 预算）：**不扣卷**（paperDrafts.length）。卷是
  //    **可截断尾部**——assemble 把卷放在非到期散题**之后**，capacityGuard 把卷归入
  //    truncatable（被抽中非到期项受保护、卷不受保护），超容量时**先砍卷尾**。若像旧码
  //    那样把 paperDrafts.length 也从预算里扣掉，会出现：ready 卷一多（如 30 张卷、max=30）
  //    → nonDueBudget=0 → sampler 一道非到期都不抽 → 练习题被卷**饿死**——但卷本就该让位给
  //    散题（卷是尾部、可截断），方向恰好反了。正确做法：卷不占 sampler 预算，散题先拿满
  //    预算，capacityGuard 再用剩余容量截断卷尾（见下方 capacityGuard 注释，total 仍受 max
  //    约束：protected[dues∪sampled] + 截断后的 truncatable[recall+卷] ≤ max，除非 protected
  //    自身 over-emit）。
  //    recall 透传仍扣：它确定性纳入、assemble 在被抽中散题**之前**，先占掉的容量不该再被
  //    sampler 重复瓜分（否则 sampled + recall 之和会无谓胀大、把卷尾全顶掉）。到期项
  //    hard-present 同样先扣。
  const fixedCount = dueDrafts.length + recallLocked.length;
  const nonDueBudget = Math.max(0, max - fixedCount);

  // FINDING 5：caller-supplied config.targetCount（实验/下采样旋钮）此前被忽略——sampler
  //   恒用 nonDueBudget。修复：config.targetCount 在场时取 min(config.targetCount, nonDueBudget)
  //   ——既尊重 caller 的下采样意图，又让容量（nonDueBudget）仍作上界（不会因 caller 传大值
  //   而突破容量）。缺省（undefined）→ 仍用 nonDueBudget（原行为）。
  const effectiveTarget =
    config.targetCount !== undefined ? Math.min(config.targetCount, nonDueBudget) : nonDueBudget;

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

  // ── 抽样：sampleByWeight 出真 π_i（Poisson IPPS）。targetCount=effectiveTarget（FINDING 5）。
  const sampled =
    weighted.length === 0
      ? []
      : sampleByWeight(weighted, { temperature, targetCount: effectiveTarget, rng: deps.rng });
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

  // ── L3 容量守门（铁律④）：超 max 截断。**到期项 + 被抽中非到期项受保护**——截断只砍卷
  //    （paper，确定性、不记 π_i）尾部。到期项 presence（铁律②）优先于容量；被抽中非到期项
  //    的 π_i 受 IPW 资产保护（FINDING 2，见 capacityGuard 注释）。
  const sampledRefs = new Set(sampled.map((s) => s.refId));
  const { kept, truncated } = capacityGuard(assembled, dueRefSet, sampledRefs, max);

  const plan: StreamPlan = {
    date: inputs.date,
    items: kept.map((d, i) => ({ ...d, position: i + 1 })),
    truncated,
    warned: assembled.length > warn,
  };

  // ── L3 守门断言（presence + due-ORDER / recall）——assemble 后校验，违例即 bug，
  //    throw 留痕（这是确定性逻辑 bug，不是 LLM/IO 失败——不该被 fallback 吞，要在
  //    测试/CI 暴露）。due-ORDER 是 review CLUSTER B 加的深防御：plan 里 due 子序列必须
  //    与 inputs 的 L1 序逐一相等（不止 presence）。
  assertL3Invariants(plan, dueRefOrder, dueRefSet, recallLockedRefs, sampledInclusion);

  // 守恒不变量（depth defense，FINDING 2 后）：sampledInclusion 只能含**真出现在最终
  //   plan 里**的 ref——记录的 π_i 必须 ⇔ 该项在流里。capacityGuard 现已保护被抽中项不被
  //   截断（见 FINDING 2 注释），故正常路径下此循环 no-op；保留它兜底任何「sampled 项最终
  //   不在 plan」的将来路径，绝不让一条不在流里的 π_i 漏进 IPW 资产。
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

    // FINDING 1（positivity / silent candidate loss）：LLM 可能只编排 samplable 的**子集**
    //   （漏排 / 重复被 dedup / 幻觉 id 被 ⊆filter 丢）。parse barrier 只在结果**全空**时才
    //   throw；部分子集会让被漏掉的 samplable 候选拿不到权重 → 不进 sampleByWeight → π_i=0
    //   → 违反 ADR-0043 §7 positivity（每个 samplable 候选都需 π_i>0，否则它永不被选中、也
    //   永不被记进 IPW 资产 → active-PPI 估计偏置）。
    //   修复：FLOOR-FILL——保留 LLM 给出的权重（它的编排信号），对 LLM 漏掉的每个 samplable
    //   候选补一个**统计**权重（mfiScore → 退 diagnosticScore → 退 STAT_FLOOR_EPSILON），
    //   使其留在加权池里、π_i>0。这样既不丢候选，又不抹掉 LLM 对它排过的那些的偏好。
    const llmWeightByRef = new Map<string, number>(parsed.map((c) => [c.refId, c.weight]));
    const weighted: WeightedCandidate[] = samplable.map((s) => ({
      refId: s.refId,
      weight: llmWeightByRef.get(s.refId) ?? statisticalFloorWeight(s),
    }));
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

/** 无任何 MFI/诊断信号时的小正权——保 π_i>0（positivity）、softmax 退化为近均匀。 */
const STAT_FLOOR_EPSILON = 0.01;

/**
 * 一条 samplable 候选的统计权重：mfiScore 优先；缺则 diagnosticScore；都缺（无 θ̂/b）
 * 给 STAT_FLOOR_EPSILON 小正权（仍可被抽中，π_i>0 保 positivity——符合「无信号 → 不偏好」
 * 语义）。L1 统计 fallback 与 FINDING 1 的 floor-fill 共用此函数（单一真相，权重语义一致）。
 */
function statisticalFloorWeight(s: CollectedSignal): number {
  return s.mfiScore ?? s.diagnosticScore ?? STAT_FLOOR_EPSILON;
}

/**
 * 把 samplable 信号映射成 WeightedCandidate[]（统计权重）。L1 fallback 用，且 Task 9
 * 的作答后增量重排**复用**它（hybrid 运行时：增量重排走纯统计 sampler——用更新后 θ̂ 重算
 * mfiScore 权重，不重跑 LLM，ADR-0042 §4 amendment）。导出以单一真相共享权重语义。
 */
export function statisticalWeights(samplable: CollectedSignal[]): WeightedCandidate[] {
  return samplable.map((s) => ({ refId: s.refId, weight: statisticalFloorWeight(s) }));
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
// L3：容量守门——超 max 截断，但**到期项 + 被抽中非到期项受保护**。
// ───────────────────────────────────────────────────────────────────────────
// 行为契约（review CLUSTER F + FINDING 2）：两类受保护项**永不被容量截断**——
//   ① 到期项（presence 铁律②优先于容量硬顶）；
//   ② 被 sampler 抽中的非到期项（其 π_i 是 Phase-6 active-PPI IPW 的慢热资产）。
// 可截断的只剩**确定性非到期尾部**（recall 透传 + 卷 paper，都不记 π_i）。
//
// 为什么不截断被抽中项（FINDING 2 / ADR-0043 §7）：sampler 记录的 π_i **必须**等于
// 该项出现在最终流里的真实概率 P(item ∈ final stream)。Poisson IPPS 抽样的 realized
// 子集大小是随机的（均值 = effectiveTarget = nonDueBudget）；若在抽样后再按容量截断
// 被抽中项的尾部，这是一道**第二重条件过滤**——幸存项的真实入选概率被压低，但代码记的
// 仍是**截断前**的 π_i → π_i **高估**真实入选概率 → IPW/Horvitz-Thompson 估计偏置。
// 修复采纳 option (b)：**非到期容量经 sampler 的 targetCount 在期望意义上兜底，不做抽样后
// 硬截断**。代价：Poisson 上溢时最终流长度可略超 max（与到期 over-emit 同款 soft-capacity
// 取舍——presence/π_i 正确性 > 硬顶）。这样记录的 π_i 恒 = 真实最终入选概率，IPW 资产干净。
//
// 调用方/下游不得假设 `truncated === true ⇒ length ≤ max`——到期 over-emit 或抽样上溢时
// 两者可同真（与 legacy composeDailyStream 的「无条件 slice(0, max)」**有意不同**）。
function capacityGuard(
  assembled: Omit<StreamPlanItem, 'position'>[],
  dueRefSet: Set<string>,
  sampledRefs: Set<string>,
  max: number,
): { kept: Omit<StreamPlanItem, 'position'>[]; truncated: boolean } {
  if (assembled.length <= max) return { kept: assembled, truncated: false };
  // 受保护 = 到期项 ∪ 被抽中非到期项（π_i 资产）。两者永不截断。
  const isProtected = (d: Omit<StreamPlanItem, 'position'>) =>
    dueRefSet.has(d.ref_id) || sampledRefs.has(d.ref_id);
  // 可截断 = 确定性非到期尾部（recall 透传 + 卷）。按剩余容量从头保留。
  const protectedItems = assembled.filter(isProtected);
  const truncatable = assembled.filter((d) => !isProtected(d));
  const remaining = Math.max(0, max - protectedItems.length);
  const keptTruncatable = truncatable.slice(0, remaining);
  // 维持原相对顺序（assembled 已是 [到期, recall, 抽中, 卷] 序）：受保护项 + 保留的可截断项
  // 按原序拼回。protectedItems.length 可 > max（到期 over-emit 或抽样上溢）⇒ remaining=0
  // ⇒ keptTruncatable=[] ⇒ kept 仅受保护项（length 可 > max，over-cap，有意）。
  const keptTruncatableSet = new Set(keptTruncatable.map((d) => d.ref_id));
  const kept = assembled.filter((d) => isProtected(d) || keptTruncatableSet.has(d.ref_id));
  return { kept, truncated: true };
}

// ───────────────────────────────────────────────────────────────────────────
// L3：断言守门（presence 铁律② + recall 铁律③）。
// ───────────────────────────────────────────────────────────────────────────
function assertL3Invariants(
  plan: StreamPlan,
  dueRefOrder: readonly string[],
  dueRefSet: Set<string>,
  recallLockedRefs: Set<string>,
  sampledInclusion: Map<string, number>,
): void {
  const planRefs = new Set(plan.items.map((it) => it.ref_id));
  // 铁律②（presence）：每个到期项必须在最终流。容量守门已保护到期项——若仍缺，是 bug。
  for (const dueRef of dueRefSet) {
    if (!planRefs.has(dueRef)) {
      throw new Error(
        `[softmax-selection] L3 due-presence violated: due item ${dueRef} missing from final plan`,
      );
    }
  }
  // 铁律②（intra-day 序，review CLUSTER B 深防御）：plan.items 里到期项的子序列必须与
  // inputs 的 L1 序（due_at ASC，dedup 后）逐一相等——LLM/装配绝不能重排到期项。
  const planDueSubsequence = plan.items.map((it) => it.ref_id).filter((r) => dueRefSet.has(r));
  if (
    planDueSubsequence.length !== dueRefOrder.length ||
    planDueSubsequence.some((r, i) => r !== dueRefOrder[i])
  ) {
    throw new Error(
      `[softmax-selection] L3 due-order violated: plan due subsequence [${planDueSubsequence.join(
        ', ',
      )}] != L1 order [${dueRefOrder.join(', ')}]`,
    );
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
