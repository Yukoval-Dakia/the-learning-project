// 冷启动题目先验的确定性解释与合成；不执行任务或写入状态。
// retained / staged 共用文本解释和成功 rep 集合的合成规则。

import {
  ItemPriorDraft,
  type ItemPriorDraftT,
  ItemPriorLlasaDraft,
  type ItemPriorLlasaDraftT,
  LLASA_ABILITY_TIERS,
} from './schema/item_prior';

export function parseItemPriorOutput(text: string): ItemPriorDraftT {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseItemPriorOutput: no JSON object found in text');
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`parseItemPriorOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  const parsed = ItemPriorDraft.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `parseItemPriorOutput: schema invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return parsed.data;
}

// ─── YUK-376 — LLaSA 学生模拟变体的解析 barrier ───────────────────────────
//
// 两段式：brace-slice + ItemPriorLlasaDraft Zod parse（模拟作答明细），再走
// 本模块的确定性 1PL MLE 反推折回 ItemPriorDraftT。
// 与上面 parseItemPriorOutput 同样的失败语义——throw 由 backfill job 当该题
// 本轮跳过（不写 row，下轮重试）；覆盖度不足（distinct θ 档 < 4）在 invert
// 侧 throw，同路径处理。

function parseItemPriorLlasaOutput(text: string): {
  simulation: ItemPriorLlasaDraftT;
  prior: ItemPriorDraftT;
  inversion: LlasaInversion;
} {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseItemPriorLlasaOutput: no JSON object found in text');
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`parseItemPriorLlasaOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  const parsed = ItemPriorLlasaDraft.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `parseItemPriorLlasaOutput: schema invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const inversion = invertLlasaSimulation(parsed.data);
  return { simulation: parsed.data, prior: inversion.prior, inversion };
}

// YUK-376 — LLaSA 学生模拟 → b 的确定性反推（纯函数，零 IO）。
//
// LLaSA（EMNLP 2024）间接学生模拟：ItemPriorLlasaTask 让 LLM 扮演多档能力
// 学习者作答并自判对错，产 ItemPriorLlasaDraft；本模块把 (θ, correct) 观测
// 点用 1PL（Rasch）极大似然反推成 ItemPriorDraftT（b_logit/confidence/
// reasoning），供 applyItemPrior 走既有写路径（source='llm_prior_llasa'）。
//
// 反推口径（全部确定性，可复算）：
//   - 观测 = 每条 simulated response 一个 (θ_j, y_j∈{0,1}) Bernoulli 点；
//     p(θ)=σ(θ−b)，b̂ = argmax_b Σ_j [y_j·log σ(θ_j−b) + (1−y_j)·log(1−σ(θ_j−b))]，
//     在 [-4,4] 网格（步长 0.01）上求 argmax（1PL 对数似然对 b 凹，网格足够）。
//   - 删失（censoring）：全对 → b̂ 落到 -inf，约定报 min(θ)−1 并标 censored='low'；
//     全错 → max(θ)+1，censored='high'。删失值是「至少比最外档还易/难一档」的
//     保守读数，不是点估计——confidence 相应压低。
//   - 覆盖度硬门：distinct θ 档 < LLASA_MIN_TIERS → throw（当本轮失败，调用方
//     走既有 skip/retry 语义）——档位太少时反推没有形状信息。
//   - confidence 启发式（写进 confidence 列的只是先验把握，不是真值）：
//     interior 0.65 / censored 0.40 为基底，逐档 p̂ 单调不减 +0.15、
//     存在相邻档 p̂ 下降（违反 1PL 单调性）−0.15，clamp [0.2, 0.85]。
//     封顶 0.85：学生模拟仍是 LLM 先验，永远不该高置信。

/** 反推所需的最少 distinct θ 档数（5 档设计里容许缺 1 档）。 */
const LLASA_MIN_TIERS = LLASA_ABILITY_TIERS.length - 1;

/** b 网格搜索界：±4 比 prompt 软引导的 ±3 外沿再多一档，删失读数落 ±3。 */
const B_GRID_MIN = -4;
const B_GRID_MAX = 4;
const B_GRID_STEP = 0.01;

interface LlasaTierStat {
  theta: number;
  correct: number;
  total: number;
  p_hat: number;
}

interface LlasaInversion {
  prior: ItemPriorDraftT;
  /** 'low'=全对（b 低于最弱档），'high'=全错，null=内部交叉（真点估计）。 */
  censored: 'low' | 'high' | null;
  /** 逐档聚合（按 θ 升序）。 */
  tiers: LlasaTierStat[];
  /** p̂ 是否随 θ 单调不减（1PL 一致性检验）。 */
  monotone: boolean;
  /** b̂ 处的最大对数似然（诊断用，跨题可比）。 */
  log_likelihood: number;
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/**
 * 把一次 LLaSA 模拟（ItemPriorLlasaDraft）折回 ItemPriorDraftT。
 * throws：distinct θ 档覆盖不足（< LLASA_MIN_TIERS）——调用方按既有失败语义
 * 当本轮跳过/重试，不写 row。
 */
function invertLlasaSimulation(draft: ItemPriorLlasaDraftT): LlasaInversion {
  // 逐档聚合（theta_level 保留模型给的实际值，含插值档）。
  const byTier = new Map<number, { correct: number; total: number }>();
  for (const r of draft.simulated_responses) {
    const cell = byTier.get(r.theta_level) ?? { correct: 0, total: 0 };
    cell.total += 1;
    if (r.correct) cell.correct += 1;
    byTier.set(r.theta_level, cell);
  }
  const tiers: LlasaTierStat[] = [...byTier.entries()]
    .sort(([a], [b]) => a - b)
    .map(([theta, cell]) => ({ theta, ...cell, p_hat: cell.correct / cell.total }));

  const weakest = tiers[0];
  const strongest = tiers[tiers.length - 1];
  if (tiers.length < LLASA_MIN_TIERS || weakest === undefined || strongest === undefined) {
    throw new Error(
      `invertLlasaSimulation: insufficient tier coverage — ${tiers.length} distinct theta levels < ${LLASA_MIN_TIERS}`,
    );
  }

  const points = draft.simulated_responses.map((r) => ({
    theta: r.theta_level,
    y: r.correct ? 1 : 0,
  }));
  const totalCorrect = points.reduce((acc, p) => acc + p.y, 0);

  let censored: LlasaInversion['censored'] = null;
  let bHat: number;
  let logLik: number;

  if (totalCorrect === 0) {
    // 全错：b 高于最强档。保守读数 = max θ + 1（删失，非点估计）。
    censored = 'high';
    bHat = strongest.theta + 1;
    logLik = points.length * Math.log(1 - sigmoid(strongest.theta - bHat));
  } else if (totalCorrect === points.length) {
    censored = 'low';
    bHat = weakest.theta - 1;
    logLik = points.length * Math.log(sigmoid(weakest.theta - bHat));
  } else {
    // 1PL MLE 网格 argmax。
    let best = -Infinity;
    let bestB = 0;
    for (let b = B_GRID_MIN; b <= B_GRID_MAX + 1e-9; b += B_GRID_STEP) {
      let ll = 0;
      for (const p of points) {
        const prob = sigmoid(p.theta - b);
        ll += p.y === 1 ? Math.log(prob) : Math.log(1 - prob);
      }
      if (ll > best) {
        best = ll;
        bestB = b;
      }
    }
    bHat = Math.round(bestB * 100) / 100;
    logLik = best;
  }

  // 单调性：逐档 p̂ 随 θ 不减（并列算不减）。
  const monotone = tiers.every((t, i) => i === 0 || t.p_hat >= (tiers[i - 1]?.p_hat ?? 0) - 1e-9);

  // confidence 启发式（见文件头）。censored 压低 + 非单调压低。
  let confidence = censored === null ? 0.65 : 0.4;
  confidence += monotone ? 0.15 : -0.15;
  confidence = Math.min(0.85, Math.max(0.2, Math.round(confidence * 100) / 100));

  const tierSummary = tiers.map((t) => `θ=${t.theta}:${t.correct}/${t.total}`).join(', ');
  const reasoning =
    `LLaSA 学生模拟反推：${points.length} 名模拟学生覆盖 ${tiers.length} 档（${tierSummary}），` +
    `1PL MLE 得 b≈${bHat}${censored ? `（${censored === 'low' ? '全对' : '全错'}删失读数）` : ''}，p̂${monotone ? '' : '非'}单调。` +
    `模型自述：${draft.reasoning}`;

  return {
    prior: {
      b_logit: Math.min(6, Math.max(-6, bHat)),
      confidence,
      reasoning,
    },
    censored,
    tiers,
    monotone,
    log_likelihood: logLik,
  };
}

// YUK-1034 — feature→b 同题 N 次重复采样的 median 聚合（纯函数，零 IO）。
//
// 实测动机（YUK-376 eval，docs/planning/2026-09-23-llasa-prior-eval.md 封存）：
// feature→b 单次采样 within-question SD ≈ 0.30 mean / 0.28 median（30 题 × 3
// reps，xiaomi/mimo-v2.5-pro）。同法 N 次采样取 b_logit median 是已验证的最便宜
// 降噪杠杆——不改估计目标、不引入新链路，实测分布下 median-of-3 有效 SD 期望
// ~0.17，成本随 reps 线性（≈+$0.0004/题·rep）。
//
// 聚合口径（全部确定性，可复算）：
//   - b_logit：各成功 rep 的 median（偶数个 → 两中位均值，标准定义；奇偶对称
//     不偏向任何一侧 rep）；
//   - confidence：同取 median——重复采样压的是估计方差，不是模型自知把握，
//     聚合置信度保持中位水平，不凭空拔高；
//   - reasoning：取 b_logit 最接近 median 的那次 rep 的原文（该 rep 的特征
//     分析最能代表聚合结论），追加聚合 provenance 后缀（成功/尝试数 + 各次
//     b_logit）。reasoning 不落 item_calibration 列（applier 只写
//     b/confidence）；各 rep 原始输出由各自 ai_task_run 行持久留痕，此处
//     provenance 保证聚合值在任何 draft 消费点可读、可审计。
//   - 失败 rep 由调用方丢弃后才进本函数；drafts 为空 → throw（调用方按既有
//     单题失败语义 skip/重试，与单次失败同路径）。

interface ItemPriorRepAggregation {
  /** 聚合后的 draft：b_logit/confidence 取 median，reasoning 含 provenance 后缀。 */
  draft: ItemPriorDraftT;
  /** 各成功 rep 的 b_logit（升序）。 */
  rep_b_logits: number[];
  /** 聚合掉的成功 rep 数（= rep_b_logits.length）。 */
  succeeded: number;
  /** 调用方声明的总尝试 rep 数（含失败丢弃）。 */
  attempted: number;
}

/** 已升序数组的中位数；偶数个取两中位均值。空数组 → NaN（调用方保证非空）。 */
function medianOfSorted(xs: readonly number[]): number {
  const n = xs.length;
  if (n === 0) return Number.NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

const fmtB = (x: number): string => String(Number(x.toFixed(3)));

/**
 * 把同一道题的 N 次 feature→b 采样折成一个 ItemPriorDraftT。
 * throws：drafts 为空（全部 rep 失败）——调用方按既有失败语义当本轮跳过。
 */
function aggregateItemPriorRepDrafts(
  drafts: readonly ItemPriorDraftT[],
  attempted: number = drafts.length,
): ItemPriorRepAggregation {
  if (drafts.length === 0) {
    throw new Error('aggregateItemPriorRepDrafts: no successful rep drafts to aggregate');
  }
  const byB = [...drafts].sort((a, b) => a.b_logit - b.b_logit);
  const repBLogits = byB.map((d) => d.b_logit);
  const bMedian = medianOfSorted(repBLogits);
  const confMedian = medianOfSorted(drafts.map((d) => d.confidence).sort((a, b) => a - b));
  // 代表 rep = b_logit 离 median 最近者。升序遍历 + 严格小于 ⇒ 平局确定性取
  // 较小侧首个，不依赖输入顺序。
  const representative = byB.reduce((best, d) =>
    Math.abs(d.b_logit - bMedian) < Math.abs(best.b_logit - bMedian) ? d : best,
  );
  const effectiveAttempted = Math.max(attempted, drafts.length);
  const provenance = `[reps median 聚合：${drafts.length}/${effectiveAttempted} 成功；b_logit 各次 ${repBLogits.map(fmtB).join(', ')} → median ${fmtB(bMedian)}]`;
  return {
    draft: {
      b_logit: bMedian,
      confidence: confMedian,
      reasoning: `${representative.reasoning} ${provenance}`,
    },
    rep_b_logits: repBLogits,
    succeeded: drafts.length,
    attempted: effectiveAttempted,
  };
}

/** 完成文本解释；方法专属的模拟结果与反推诊断留在本模块内。 */
export function parseItemPriorDraft(method: 'feature' | 'llasa', text: string): ItemPriorDraftT {
  return method === 'llasa' ? parseItemPriorLlasaOutput(text).prior : parseItemPriorOutput(text);
}

/**
 * 合成已成功解释的 drafts；按计划次数选择首份或 median，而非成功份数。
 * feature 计划多次但全失败时，保留原聚合错误供 retained caller 处理；
 * staged caller 仍在进入本函数前处理空集合的 no-anchor 状态。
 */
export function aggregateItemPriorDrafts(
  method: 'feature' | 'llasa',
  drafts: readonly ItemPriorDraftT[],
  intendedReps: number,
): ItemPriorDraftT {
  return method === 'llasa' || intendedReps <= 1
    ? drafts[0]
    : aggregateItemPriorRepDrafts(drafts, intendedReps).draft;
}
