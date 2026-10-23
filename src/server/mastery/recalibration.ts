// YUK-361 Phase 6 (ADR-0043 §4/§6/§7) — active-PPI difficulty recalibration.
//
// ─── YUK-439 起的定位（ADR-0043 2026-10-19 Amendment）──────────────────────────
// 难度读链 effectiveB 由 kernel/read-models/question-difficulty 持有（此处保留旧出口），
// 优先读取联合标定后验 b_post；本模块的**写侧机器**（recalibrateQuestion 的 AIPW firm-up + 12 标签
// 硬门控 + label hook）自 YUK-439 起转为离线审计/对照工具：生产夜跑（recalibration_
// nightly）改喂 src/server/mastery/joint-calibration.ts 的连续后验批（RECALIBRATION_
// MIN_LABELS 硬门控与 b_calib 首写语义随之退出生产路径，A3）；label hook 仍被 settle
// 调用（既有契约 pin 的审计面），但 label 账本不再喂标定。AIPW 估计器（aipwMean /
// ppiPlusMean / estimateLambdaStar）保留：重放对照脚本（scripts/replay-joint-calibration）
// 以它复刻现行方案作比较基线。
//
// 在线 θ̂ 半边锁死 b（G4）。本模块是离线/批量的 b 去偏引擎：攒够锚定 θ̂ 反推的难度
// 标签后，用 active-PPI（AIPW）把冷启锚 b_anchor 的尺度偏差校正成 b_calib。θ̂ 快、
// b 慢（批量重标定，对 θ 准静态）。
//
// 在线 attempt 路径只读 effectiveB，从不写 b_calib；本模块的 recalibrateQuestion 是
// 唯一批量写者。effectiveB = b_calib ?? b_anchor ?? b：首次 firm-up 前 b_calib 恒 NULL，
// 读链退回锚，零行为变更。
//
// 标签真值是难度 b_label（锚定 θ̂ 反推），不是裸 outcome：裸 outcome 混 θ/学习漂移，
// 会把 b 校成 response-rate 残差。单条噪声大，AIPW 在候选池上聚合去噪。
//
// 校正项是已标注子集的 IPW（Horvitz-Thompson）均值，采用 Hájek 自归一化：分母是
// Σ(1/π)（精确权重和），不是池规模 N，也不是 round(N̂)。
//   ppiPlusMean = λ·predictionMean(pool) + [Σ_labeled(ξ_j/π_j)] / [Σ_labeled(1/π_j)]
// 标签一致时该比值精确收敛到真值偏移；用 round(Σ1/π) 会在非均匀 π 下引入系统偏差
// （均匀 π 时 Σ1/π 为整，恰好掩盖该 bug）。positivity：任何 π ≤ 0 抛错。

import { and, desc, eq } from 'drizzle-orm';
import { newId } from '@/core/ids';
import { difficultyToLogitB, quantile } from '@/core/theta';
import type { Db, Tx } from '@/db/client';
import {
  difficulty_calibration_label,
  item_calibration,
  practice_stream_item,
  selection_observation,
} from '@/db/schema';
import { effectiveB } from '@/kernel/read-models/question-difficulty';
import { impliedDifficultyResidual, isObjectiveJudgeRoute } from './personalized-difficulty';

export { type ItemCalibrationBRow, effectiveB } from '@/kernel/read-models/question-difficulty';

type DbLike = Db | Tx;

// ─────────────────────────────────────────────────────────────────────────────
// attemptLocalDate — 作答时刻 → 用户本地日，显式锁定 Asia/Shanghai。
//
// 必须与 selection_observation.date / practice_stream_item.date 的 streamLocalDate
// 公式一致。有意内联而不 import：streamLocalDate 在 practice 重模块里，拉进来会给
// mastery 层制造整张依赖图和 cycle 风险；公式单行且时区固定。
// ─────────────────────────────────────────────────────────────────────────────
export function attemptLocalDate(now: Date): string {
  return now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

// ─────────────────────────────────────────────────────────────────────────────
// impliedBLabel — 单次 fixed-anchor IRT 反推的难度标签（Task 11 step 3，ADR-0043 §6）。
//
// 给定 (outcome, theta_snapshot, b_anchor)，反推「这道题对这个能力学习者隐含的难度」：
//   b_label = b_anchor + impliedDifficultyResidual(θ, b_anchor, outcome)
// 即从锚出发沿 1PL 对数似然对 b 走一步牛顿方向：答错 → 更难，答对 → 更易。
// 这是锚定 θ 的反推，不是裸 outcome；单条噪声大，池上聚合去噪。
// ─────────────────────────────────────────────────────────────────────────────
export function impliedBLabel(theta: number, bAnchor: number, outcome: 0 | 1): number {
  return bAnchor + impliedDifficultyResidual(theta, bAnchor, outcome);
}

// ─────────────────────────────────────────────────────────────────────────────
// aipwMean — AIPW / PPI rectifier 均值，Hájek 自归一化形：
//   aipwMean = predictionMean(pool) + [Σ_labeled(ξ_j/π_j)] / [Σ_labeled(1/π_j)]
//   ξ_j = label_j − 锚预测_j
// 先在整池取锚预测均值（低方差但有偏），再用已标注子集的残差做自归一化 IPW 校正。
// 分母必须是精确的 Σ(1/π)；labeled 为空 → 校正项 0。π ≤ 0 抛错（positivity）。
// ─────────────────────────────────────────────────────────────────────────────
export interface LabeledResidual {
  /** ξ = label − 锚预测（该已标注样本的残差）。 */
  residual: number;
  /** π = 真随机抽样的 inclusion probability ∈ (0, 1]。≤0 抛错（positivity）。 */
  pi: number;
}

export function aipwMean(
  poolPredictions: number[],
  labeledResiduals: LabeledResidual[],
  capFactor: number = IPW_WEIGHT_CAP_C,
): number {
  const N = poolPredictions.length;
  if (N === 0) {
    throw new Error('aipwMean: poolPredictions must be non-empty (N=0 → undefined mean)');
  }
  const predictionMean = poolPredictions.reduce((a, b) => a + b, 0) / N;
  // positivity 先于 cap（YUK-558 M1）——IPW 权重分母 ≤0 是上游 bug（伪 π / 确定性选题），
  // fail-fast，且必须先于截权（cap 不救 ≤0 的 π）。
  for (const r of labeledResiduals) {
    if (!(Number.isFinite(r.pi) && r.pi > 0)) {
      throw new Error(
        `aipwMean: inclusion probability must be a finite number > 0 (positivity), got ${r.pi}`,
      );
    }
  }
  // median-相对截权（与 ppiPlusMean(λ=1) 恒等；aipwMean 保留导出）。
  const { weights } = cappedIpwWeights(
    labeledResiduals.map((r) => r.pi),
    capFactor,
  );
  let residualCorrection = 0;
  let weightSum = 0; // Σ(capped 1/π)，Hájek 分母。
  for (let i = 0; i < labeledResiduals.length; i++) {
    const r = labeledResiduals[i];
    const w = weights[i];
    // 未截项保留 residual/π 单舍入，与旧实现逐位一致；截项走 residual*w。
    residualCorrection += w === 1 / r.pi ? r.residual / r.pi : r.residual * w;
    weightSum += weights[i];
  }
  // Hájek 自归一化：÷ Σ(capped 1/π)；labeled 为空 → 校正项 0。
  return predictionMean + (weightSum > 0 ? residualCorrection / weightSum : 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// PPI++ power-tuning λ*（ADR-0043 §7）。
//
// 坏锚会放大 AIPW 方差；λ ∈ [0,1] 给锚预测项降权：
//   ppiPlusMean(λ) = λ·predictionMean + [Σ(ξ_λ/π)] / [Σ(1/π)]，ξ_λ = label − λ·m̂
//   λ=1 → 标准 AIPW；λ=0 → 纯 Hájek IPW 标签均值。
// λ* = Cov(m̂, label_via_ipw) / Var(m̂_via_ipw)，用 IPW 加权矩近似；强相关 → 1，
// 弱相关 → 0。clamp 到 [0,1]（理论上可超界）。
// ─────────────────────────────────────────────────────────────────────────────
export interface LabeledSample {
  /** 难度标签 b_label（该样本反推的隐含难度）。 */
  label: number;
  /** 该样本的锚预测 m̂（= b_anchor，候选池预测同源）。 */
  prediction: number;
  /** 真随机抽样 inclusion probability ∈ (0, 1]。 */
  pi: number;
}

/**
 * 估计 λ*（PPI++ power-tuning）。样本不足 2 条或锚方差≈0 → 1（退化标准 AIPW）；
 * clamp [0,1]。
 */
export function estimateLambdaStar(
  labeled: LabeledSample[],
  capFactor: number = IPW_WEIGHT_CAP_C,
): number {
  const n = labeled.length;
  if (n < 2) return 1;
  for (const s of labeled) {
    if (!(Number.isFinite(s.pi) && s.pi > 0)) {
      throw new Error(
        `estimateLambdaStar: inclusion probability must be a finite number > 0 (positivity), got ${s.pi}`,
      );
    }
  }
  // 常数锚短路必须先于加权矩：单题模式下 prediction 全等，严格相等成立。
  // 放在矩算之后会被 FP 噪声逃逸，吐出垃圾 λ*。
  if (labeled.every((s) => s.prediction === labeled[0].prediction)) return 1;
  // median-相对截权进 IPW 加权一阶矩。单题常数锚下 varM=0 → 先返回 1，截权对输出
  // 目前是 no-op；非常数 m̂ 的 Phase 7+ 才激活（届时 capped 矩只是启发式）。
  const { weights } = cappedIpwWeights(
    labeled.map((s) => s.pi),
    capFactor,
  );
  const wSum = weights.reduce((a, w) => a + w, 0);
  if (!(wSum > 0)) return 1;
  const wMean = (sel: (s: LabeledSample) => number): number =>
    labeled.reduce((a, s, i) => a + weights[i] * sel(s), 0) / wSum;
  const mBar = wMean((s) => s.prediction);
  const yBar = wMean((s) => s.label);
  let cov = 0;
  let varM = 0;
  for (let i = 0; i < labeled.length; i++) {
    const w = weights[i];
    const dm = labeled[i].prediction - mBar;
    cov += w * dm * (labeled[i].label - yBar);
    varM += w * dm * dm;
  }
  if (!(varM > 0)) return 1; // 锚预测无方差（同质池）→ 信任锚（λ=1）。
  const lambda = cov / varM;
  return Math.max(0, Math.min(1, lambda));
}

/**
 * PPI++ power-tuned 均值（aipwMean 的 λ 泛化；λ=1 时数值等于 aipwMean）。分母是
 * Hájek 自归一化的 Σ(1/π)。labeled 为空 → 校正项 0。
 */
export function ppiPlusMean(
  poolPredictions: number[],
  labeled: LabeledSample[],
  lambda: number,
  capFactor: number = IPW_WEIGHT_CAP_C,
): number {
  const N = poolPredictions.length;
  if (N === 0) {
    throw new Error('ppiPlusMean: poolPredictions must be non-empty');
  }
  const predictionMean = poolPredictions.reduce((a, b) => a + b, 0) / N;
  // positivity 先于 cap：cap 绝不救 ≤0 的 π。
  for (const s of labeled) {
    if (!(Number.isFinite(s.pi) && s.pi > 0)) {
      throw new Error(
        `ppiPlusMean: inclusion probability must be a finite number > 0 (positivity), got ${s.pi}`,
      );
    }
  }
  // median-相对截权：单条低-π fluke 的自归一化质量有界（见 IPW_WEIGHT_CAP_C）。
  const { weights } = cappedIpwWeights(
    labeled.map((s) => s.pi),
    capFactor,
  );
  let correction = 0;
  let weightSum = 0; // Σ(capped 1/π) — Hájek 自归一化分母（FINDING #1）。
  for (let i = 0; i < labeled.length; i++) {
    const s = labeled[i];
    const w = weights[i];
    const xi = s.label - lambda * s.prediction;
    // 未截项保留 xi/π 单舍入，与旧实现逐位一致；截项走 xi*w。
    correction += w === 1 / s.pi ? xi / s.pi : xi * w;
    weightSum += weights[i];
  }
  // Hájek 自归一化：÷ Σ(capped 1/π)（精确），不是 ÷N / ÷round(Σ1/π)（FINDING #1）。
  return lambda * predictionMean + (weightSum > 0 ? correction / weightSum : 0);
}

// 该题攒够这么多 difficulty_calibration_label 条才 firm-up b_calib；未达则不写，
// effectiveB 退回 b_anchor ?? b。owner 可调的保守起步值（单题标签稀疏）。
export const RECALIBRATION_MIN_LABELS = 12;

// ─────────────────────────────────────────────────────────────────────────────
// IPW_WEIGHT_CAP_C — median-相对 IPW 截权常数（owner 拍 C=4）。
//
// 保守初值，非拟合结果：单条标签权重 1/π 封顶于 C·median(该题标签批内未截权重)。
// median-相对而非绝对 floor：honest 权重尺度随候选池增长，固定 floor 在大池时把
// 所有权重压平成无权均值。
//
// 这是 deliberate bias-for-variance 交易，不免费：截权拉向高-π 标签的均值，部分
// 重引入 IPW 要去除的 selection bias。默认 ON 只立足「首写不可逆 + 在线消费不可回放
// ⇒ 有界方差优于无偏」。回滚旋钮 = C = Infinity，精确还原 uncapped 旧行为。
// ─────────────────────────────────────────────────────────────────────────────
export const IPW_WEIGHT_CAP_C = 4;

/**
 * 批内 median-相对截权：w_j = min(1/π_j, C·median(1/π))。
 *
 * positivity throw 由 caller 先行（cap 不救 ≤0 的 π）。capFactor=Infinity ⇒ cap 永不
 * bind，weights 与原始 1/π 逐位相等，精确还原旧行为。下方 `1/pi` 必须保持字面除法：
 * estimator 用 `w === 1/π` 判别未截项，改写成 Math.pow 会破坏逐位回滚。
 *
 * @returns weights 与 pis 等长同序；clipped 为被截权条数。
 */
export function cappedIpwWeights(
  pis: number[],
  capFactor: number = IPW_WEIGHT_CAP_C,
): { weights: number[]; clipped: number } {
  if (pis.length === 0) return { weights: [], clipped: 0 };
  const raw = pis.map((pi) => 1 / pi);
  // 批内未截权重中位数（quantile type-7，与旧 medianOfWeights 偶数取中两点均值逐位一致）。
  // 空数组已被上方 early-return 挡 ⇒ quantile 的 NaN-on-empty 契约不可达。
  const cap = capFactor * quantile(raw, 0.5);
  let clipped = 0;
  const weights = raw.map((w) => {
    if (w > cap) {
      clipped++;
      return cap;
    }
    return w;
  });
  return { weights, clipped };
}

// Bound 陈述纪律：这些界是 regime-conditional 的，不能写成无条件 estimator 保证。
// 首写前 b_calib ⊆ [b_anchor±2]；首写后 ±2 是相对当前 effectiveB 的逐夜棘轮，
// 不是稳态不变量。Phase 7+ 非常数 m̂ 下凸组合性质也不成立。

// ─────────────────────────────────────────────────────────────────────────────
// 标签记录 hook — recordDifficultyCalibrationLabel。
//
// 在客观判分 + softmax 选中的 attempt 上写一条 difficulty_calibration_label，由
// submit.ts / paper-submit.ts 在 attempt tx 的 SAVEPOINT 内 best-effort 调用。
//
// π_i 按被答 slot 的 stream_item_id 直 join（不再用 (date, ref) 近似）：只有直 join
// 才能区分同日散题重答，避免把流 slot 的 π_i 错贴给非流作答。
//
// 红线：无 streamItemId → 立即 skip，绝不退回近似。慢资产一旦污染就攒不回。
// 只对 softmax_mfi selected 的真随机抽样打标签；再 join practice_stream_item 确认
// slot 仍活、仍属本题（race guard），不叠 date 等值以免跨本地午夜误 skip。
//
// thetaBefore 必须是 PRE-attempt θ̂；partial 早返不写。
// ─────────────────────────────────────────────────────────────────────────────
export interface RecordDifficultyCalibrationLabelInput {
  questionId: string;
  /** 产生本标签的 attempt/review event id（去重锚 + provenance）。 */
  attemptEventId: string;
  /** 题的 1-5 难度档（弱锚兜底）；hook 内按 effectiveB → difficultyToLogitB 解析锚。 */
  difficulty: number;
  /** 客观判分二元结果：success=1 / failure=0。 */
  outcome: 0 | 1;
  /** 原始 outcome；'partial' 早返不写。 */
  attemptOutcome?: 'success' | 'failure' | 'partial';
  /** 判分路由；null/非客观提前返回。 */
  judgeRoute: string | null | undefined;
  /** 作答前（PRE-attempt）的 θ̂；b_label 反推锚定它。 */
  thetaBefore: number;
  now: Date;
  /**
   * 被答 slot 的 practice_stream_item.id。非空则直 join π_i；null/undefined 立即
   * skip（不退回 (date, ref) 近似）。
   */
  streamItemId?: string | null;
}

/**
 * 写一条难度校准标签，或 skip（非客观 / partial / 无真 π_i）。单条 upsert，可被
 * SAVEPOINT 吞而不留半写；不冒泡打断 attempt 主路径。
 */
export async function recordDifficultyCalibrationLabel(
  tx: Tx,
  input: RecordDifficultyCalibrationLabelInput,
): Promise<void> {
  // 非客观判分不进 b 真值通道。
  if (!isObjectiveJudgeRoute(input.judgeRoute)) return;
  // partial 对对难度反推语义歧义，不折。
  if (input.attemptOutcome === 'partial') return;

  // 无被答 slot 就没有可信 π_i；宁可 skip 也不退回 (date, ref) 近似。
  if (input.streamItemId == null) return;
  const streamItemId = input.streamItemId;

  // 按 stream_item_id 直 join 被答 slot 的 softmax_mfi 真随机抽样。
  const obsRows = await tx
    .select({ pi: selection_observation.inclusion_probability })
    .from(selection_observation)
    .where(
      and(
        eq(selection_observation.stream_item_id, streamItemId),
        eq(selection_observation.ref_id, input.questionId),
        eq(selection_observation.ref_kind, 'question'),
        eq(selection_observation.policy, 'softmax_mfi'),
        eq(selection_observation.selected, true),
      ),
    )
    .orderBy(desc(selection_observation.created_at))
    .limit(1);
  const pi = obsRows[0]?.pi ?? null;
  // 无真 π_i → skip（不落伪 π_i）。
  if (pi === null || !(pi > 0 && pi <= 1)) return;

  // race guard：slot 仍活、仍属本题。日期归属已由 stream_item_id 隐含，不再叠 date。
  const slotRows = await tx
    .select({ id: practice_stream_item.id })
    .from(practice_stream_item)
    .where(
      and(
        eq(practice_stream_item.id, streamItemId),
        eq(practice_stream_item.ref_id, input.questionId),
      ),
    )
    .limit(1);
  if (slotRows.length === 0) return;

  // 锚：effectiveB → 弱锚 difficultyToLogitB，与 θ̂/family hook 同链。
  const calRows = await tx
    .select({
      b: item_calibration.b,
      b_anchor: item_calibration.b_anchor,
      b_calib: item_calibration.b_calib,
    })
    .from(item_calibration)
    .where(
      and(eq(item_calibration.question_id, input.questionId), eq(item_calibration.track, 'hard')),
    )
    .limit(1);
  const bAnchor = effectiveB(calRows[0]) ?? difficultyToLogitB(input.difficulty);

  const bLabel = impliedBLabel(input.thetaBefore, bAnchor, input.outcome);

  await tx
    .insert(difficulty_calibration_label)
    .values({
      id: newId(),
      question_id: input.questionId,
      attempt_event_id: input.attemptEventId,
      theta_snapshot: input.thetaBefore,
      outcome: input.outcome,
      b_label: bLabel,
      inclusion_probability: pi,
      created_at: input.now,
    })
    // 同一 attempt 最多一条标签。
    .onConflictDoNothing({ target: difficulty_calibration_label.attempt_event_id });
}

// ─────────────────────────────────────────────────────────────────────────────
// recalibrateQuestion — 读该题全部标签 + 锚，跑 PPI++ AIPW，门控过则写 b_calib。
// b_calib 的写只由本函数（firm-up）与 clearCalibrationBelowThreshold（重建清旧值）
// 承担；在线 attempt 永不写。on-demand，job 顶层调用。
//
// 生产夜跑自 YUK-439 起改喂 joint-calibration.ts，本函数保留为离线审计/对照工具
// （replay 脚本复刻现行方案）。单题常数锚下 predictionMean = b_anchor 与池规模无关，
// 故单元素池即可；IPW 校正用 Hájek 精确分母 Σ(1/π)。
//
// λ* 在常数锚模式恒为 1（Var(m̂)=0），坏锚安全阀在此模式不触发；Phase 7+ 引入非常数
// m̂ 后才激活。标签数 < RECALIBRATION_MIN_LABELS → 不写，b_calib 保持 NULL。
// ─────────────────────────────────────────────────────────────────────────────
export interface RecalibrateResult {
  updated: boolean;
  labelCount: number;
  /** 写入的 b_calib（updated=true 时）；否则 null。 */
  bCalib: number | null;
  /** PPI++ λ*（updated=true 时）。 */
  lambdaStar?: number;
  reason?: 'below_threshold' | 'no_anchor' | 'ok';
  /**
   * median-相对 IPW 截权激活条数（YUK-558 M1，clip 可观测——注偏改动与其可检测性同 wave）。
   * firm-up 未发生（no_anchor / below_threshold）→ 0（cap 未运行）。
   */
  clipActivations: number;
  /** firm-up 批的 min/max inclusion probability（观测 fat-tail 深度）；未 firm-up → null。 */
  minPi: number | null;
  maxPi: number | null;
}

export async function recalibrateQuestion(
  db: DbLike,
  questionId: string,
): Promise<RecalibrateResult> {
  // 1. 读锚（track='hard'）。重标定校的是 b_anchor 的尺度偏差。
  const calRows = await db
    .select({
      b: item_calibration.b,
      b_anchor: item_calibration.b_anchor,
      b_calib: item_calibration.b_calib,
    })
    .from(item_calibration)
    .where(and(eq(item_calibration.question_id, questionId), eq(item_calibration.track, 'hard')))
    .limit(1);
  const calRow = calRows[0] ?? null;
  // 锚 = b_anchor ?? b（重标定需要一个锚作 m̂；冷启无锚 → 不重标定）。
  const bAnchor = calRow?.b_anchor ?? calRow?.b ?? null;
  if (bAnchor === null) {
    return {
      updated: false,
      labelCount: 0,
      bCalib: null,
      reason: 'no_anchor',
      clipActivations: 0,
      minPi: null,
      maxPi: null,
    };
  }

  // 2. 读该题全部标签（b_label + π_i）。
  const labels = await db
    .select({
      b_label: difficulty_calibration_label.b_label,
      pi: difficulty_calibration_label.inclusion_probability,
    })
    .from(difficulty_calibration_label)
    .where(eq(difficulty_calibration_label.question_id, questionId));

  const labelCount = labels.length;
  // 3. 数据闸：未攒够 → no-op，b_calib 保持 NULL。
  if (labelCount < RECALIBRATION_MIN_LABELS) {
    return {
      updated: false,
      labelCount,
      bCalib: null,
      reason: 'below_threshold',
      clipActivations: 0,
      minPi: null,
      maxPi: null,
    };
  }

  // 4. PPI++ AIPW（Hájek 自归一化）。样本 = (label, m̂=b_anchor, π)。
  const samples: LabeledSample[] = labels.map((l) => ({
    label: l.b_label,
    prediction: bAnchor,
    pi: l.pi,
  }));
  // 常数锚：单元素池即可；校正用 Hájek 精确分母 Σ(1/π)。常数锚下 λ* = 1。
  const poolPredictions = [bAnchor];
  // 观测与 estimator 必须同源 capFactor。
  const capFactor = IPW_WEIGHT_CAP_C;
  const lambdaStar = estimateLambdaStar(samples, capFactor);
  const bCalib = ppiPlusMean(poolPredictions, samples, lambdaStar, capFactor);
  // 截权可观测：激活条数 + fat-tail 深度（min/max π）。与 estimator 内部同源 capFactor。
  const pis = samples.map((s) => s.pi);
  const { clipped: clipActivations } = cappedIpwWeights(pis, capFactor);
  // reduce（非 Math.min(...spread)）——避免超大标签批 spread 爆栈，同 selection-signals.ts 哲学。
  const minPi = pis.reduce((m, p) => (p < m ? p : m), pis[0]);
  const maxPi = pis.reduce((m, p) => (p > m ? p : m), pis[0]);

  // 5. firm-up b_calib（唯一路径）。calibration_weight = Σπ_i（有效样本量 proxy）。
  const calibrationWeight = samples.reduce((a, s) => a + s.pi, 0);
  await db
    .update(item_calibration)
    .set({
      b_calib: bCalib,
      calibration_n: labelCount,
      calibration_weight: calibrationWeight,
      last_calibrated_at: new Date(),
      updated_at: new Date(),
    })
    .where(and(eq(item_calibration.question_id, questionId), eq(item_calibration.track, 'hard')));

  return {
    updated: true,
    labelCount,
    bCalib,
    lambdaStar,
    reason: 'ok',
    clipActivations,
    minPi,
    maxPi,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// clearCalibrationBelowThreshold — 重建时显式清 stale b_calib。
//
// recalibrateQuestion 的 below_threshold 是 no-op，不清旧值；但 settlement revert /
// 批量 backfill 删标签让 count 跌破阈值时必须清，否则被撤销作答留下的 b_calib 仍喂
// effectiveB（幽灵校准）。本函数是唯一清旧值 path；无值可清或标签仍 ≥ 阈值时 no-op，
// 幂等。返回 cleared=true 表示确有 stale 值被清零。
// ─────────────────────────────────────────────────────────────────────────────
export interface ClearCalibrationResult {
  cleared: boolean;
  labelCount: number;
}

export async function clearCalibrationBelowThreshold(
  db: DbLike,
  questionId: string,
): Promise<ClearCalibrationResult> {
  const labelRows = await db
    .select({ id: difficulty_calibration_label.id })
    .from(difficulty_calibration_label)
    .where(eq(difficulty_calibration_label.question_id, questionId));
  const labelCount = labelRows.length;
  if (labelCount >= RECALIBRATION_MIN_LABELS) {
    return { cleared: false, labelCount };
  }
  const rows = await db
    .select({
      b_calib: item_calibration.b_calib,
      calibration_n: item_calibration.calibration_n,
      calibration_weight: item_calibration.calibration_weight,
      last_calibrated_at: item_calibration.last_calibrated_at,
    })
    .from(item_calibration)
    .where(and(eq(item_calibration.question_id, questionId), eq(item_calibration.track, 'hard')))
    .limit(1);
  const row = rows[0] ?? null;
  const hasStale =
    row !== null &&
    (row.b_calib !== null ||
      row.calibration_weight !== null ||
      row.last_calibrated_at !== null ||
      row.calibration_n !== 0);
  if (!hasStale) {
    return { cleared: false, labelCount };
  }
  await db
    .update(item_calibration)
    .set({
      b_calib: null,
      calibration_n: 0,
      calibration_weight: null,
      last_calibrated_at: null,
      updated_at: new Date(),
    })
    .where(and(eq(item_calibration.question_id, questionId), eq(item_calibration.track, 'hard')));
  return { cleared: true, labelCount };
}
