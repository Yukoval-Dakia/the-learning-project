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

import {
  type ItemPriorDraftT,
  type ItemPriorLlasaDraftT,
  LLASA_ABILITY_TIERS,
} from './schema/item_prior';

/** 反推所需的最少 distinct θ 档数（5 档设计里容许缺 1 档）。 */
export const LLASA_MIN_TIERS = LLASA_ABILITY_TIERS.length - 1;

/** b 网格搜索界：±4 比 prompt 软引导的 ±3 外沿再多一档，删失读数落 ±3。 */
const B_GRID_MIN = -4;
const B_GRID_MAX = 4;
const B_GRID_STEP = 0.01;

export interface LlasaTierStat {
  theta: number;
  correct: number;
  total: number;
  p_hat: number;
}

export interface LlasaInversion {
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
export function invertLlasaSimulation(draft: ItemPriorLlasaDraftT): LlasaInversion {
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
