// YUK-361 Phase 6 (Task 11, ADR-0043 §4 半数据驱动 b + §6 难度标签 + §7 active-PPI/AIPW)
// — active-PPI 难度重标定机器。
//
// ─── 这台机器做什么（ADR-0043 §4 路线表「去偏引擎」）────────────────────────────
// 在线 θ̂ 半边锁死 b（item-半边 G4 红线，永不回写）。本模块是**离线/批量**的 b 去偏引擎：
// 攒够「锚定 θ̂ 反推的难度标签」后，用 active-PPI（AIPW / control-variate 无偏半参数估计）
// 把**冷启锚 b_anchor 的尺度偏差**校正成去偏后的 b_calib。两时间尺度（§识别性）：θ̂ 快
// （每作答 Elo），b 慢（批量重标定，对 θ 准静态）；硬条件 b 校准频率 ≪ θ 更新频率。
//
// ─── 不变量①（红线，与 Phase 5 家族层一致）──────────────────────────────────────
// 在线 attempt 路径**只 READS** effectiveB（见下），**从不 WRITES** b_calib。b_calib 只由
// 本模块的 recalibrateQuestion（批量）写。effectiveB / b_anchor / b_calib 的关系：
//   effectiveB(row) = b_calib ?? b_anchor ?? b
// 即「去偏后」优先于「冷启锚」优先于「历史 b 列」。b_calib 攒够标签前恒 NULL → effectiveB
// 退回 b_anchor ?? b（read-compat NO-OP，零行为变更直到首次 firm-up）。
//
// ─── 标签的真值是难度 b 不是判分（§6 承重红线）──────────────────────────────────
// PPI 的 Y = **难度标签 b_label**（锚定 θ̂ 反推的隐含难度），不是裸 outcome。裸 outcome 混
// θ/学习漂移，当 b 真值会把 b 校成 response-rate 残差。单条 b_label 反推噪声大（n=1 CI 宽），
// 这是预期的——AIPW 在候选池上聚合去噪（§7）。
//
// ─── AIPW 归一化 + Hájek 自归一化（§7，Codex review 揪出的两个 bug 不能犯）──────────
// 校正项是已标注子集的 IPW（Horvitz-Thompson）均值，**自归一化（Hájek）形**用样本权重
// 的精确和 Σ(1/π) 作分母（不是池规模 N，更不是 round(N̂)）：
//   ppiPlusMean = λ·predictionMean(pool)  +  [ Σ_labeled (ξ_j / π_j) ] / [ Σ_labeled (1/π_j) ]
//   ξ_j = label_j − λ·m̂_j（残差），π_j = 真随机抽样的 inclusion probability，m̂ = 锚预测。
// labeled 为空 → 校正项 0（退回 λ·predictionMean）。
//
// 为什么 ÷Σ(1/π) 而非 ÷N（FINDING #1，Codex review）：单题常数锚模式下 m̂≡b_anchor、
// predictionMean=b_anchor，λ=1 时 b_calib = b_anchor + Σ((label−b_anchor)/π) / Σ(1/π) —— 这是
// 标签的 **Hájek 自归一化 IPW 均值**：当所有 label 一致（如全 1.5）时，分子 = (1.5−anchor)·Σ(1/π)、
// 分母 = Σ(1/π)，比值**恰好** = 1.5−anchor ⇒ b_calib=1.5 **精确**（与 π 分布无关）。旧实现用
// round(Σ1/π) 当分母（materializing Array(N).fill 池）：Σ1/π 非整（真实混合 π 几乎总非整）→
// 比值偏离 1 → 系统偏差（12 条全 b=1.5 + 非均匀 π → b_calib≈1.513 而非 1.5）。旧单/db 测全用
// 均匀 π=0.5 ⇒ Σ1/π=2·n 为整 ⇒ round 无害，遮住了偏差。
//
// 朴素错误形对照（仍要防）：把校正项 ÷n_labeled 再保留 ÷π 隐含的 N/n 因子（均匀抽样下
// π≈n/N）会多乘一个 N/n_labeled 过度校正——Hájek 的 ÷Σ(1/π) 同样自动消掉这个因子。
// positivity（§7）：任何 π ≤ 0 抛错（IPW 权重分母，0 或负是上游 bug）。

import { newId } from '@/core/ids';
import { difficultyToLogitB } from '@/core/theta';
import type { Db, Tx } from '@/db/client';
import {
  difficulty_calibration_label,
  item_calibration,
  practice_stream_item,
  selection_observation,
} from '@/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { impliedDifficultyResidual, isObjectiveJudgeRoute } from './personalized-difficulty';

type DbLike = Db | Tx;

// ─────────────────────────────────────────────────────────────────────────────
// attemptLocalDate — 作答时刻 → 用户本地日（YYYY-MM-DD），**显式锁定 Asia/Shanghai**。
//
// FINDING #3 π_i join 需要把作答钉在「作答当天放置该 slot 的选题事件」，故要作答的本地日。
// 度量必须与 selection_observation.date / practice_stream_item.date 完全一致——那两者由
// stream-store.ts 的 `streamLocalDate(now)`（同一 'sv-SE' + timeZone:'Asia/Shanghai' 公式）写入。
// 此处**有意内联**而非 import `streamLocalDate`：那是 src/capabilities/practice/server 的重模块
// （拉入 due-list / practice-read / composer 整张依赖图），而本模块在 src/server/mastery，被
// submit.ts/paper-submit.ts import——import 它会把整张图拽进 mastery 层并制造 import cycle 风险。
// 公式是单行且单用户时区固定，内联 + 注释指向唯一真相源（stream-store.ts streamLocalDate）即可。
// ─────────────────────────────────────────────────────────────────────────────
export function attemptLocalDate(now: Date): string {
  return now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

// ─────────────────────────────────────────────────────────────────────────────
// effectiveB — b 读取终态优先链（read-compat helper，Task 11 step 1）。
//
// b_calib ?? b_anchor ?? b。**纯函数**（无 IO），供 selection 的 resolveBAnchor + θ̂ 锚
// （state.ts updateThetaForAttempt）统一读 b。b_calib 攒够标签前 NULL → 退回 b_anchor ??
// b，故接进 live b-resolution 是 NO-OP today（安全可接线，见 step 5 wiring）。
//
// 家族组合（Phase 5 effectiveFamilyB 的接缝）：live b-resolution 的终态是
//   b_effective = effectiveFamilyB(effectiveB(row), familyRow)
//             = (b_calib ?? b_anchor ?? b)  +  shrunk_family_delta
// 即家族 delta 叠在去偏 b 之上（两条慢线组合，见 personalized-difficulty.ts effectiveFamilyB
// 文档）。本 helper 只负责列层 b_calib/b_anchor/b 的解析，家族 delta 由 effectiveFamilyB 叠加。
// ─────────────────────────────────────────────────────────────────────────────
export interface ItemCalibrationBRow {
  b: number | null;
  b_anchor: number | null;
  b_calib: number | null;
}

/** b_calib ?? b_anchor ?? b。三者皆 null（冷启无锚）→ null。 */
export function effectiveB(row: ItemCalibrationBRow | null | undefined): number | null {
  if (row == null) return null;
  return row.b_calib ?? row.b_anchor ?? row.b ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// impliedBLabel — 单次 fixed-anchor IRT 反推的难度标签（Task 11 step 3，ADR-0043 §6）。
//
// 给定 (outcome, theta_snapshot, b_anchor)，反推「这道题对这个能力学习者隐含的难度」：
//   b_label = b_anchor + impliedDifficultyResidual(θ, b_anchor, outcome)
// 其中 impliedDifficultyResidual（复用 Phase 5 家族层的同一 IRT 推导，单一真相）=
//   −(outcome − p) / max(p·(1−p), MIN_FISHER)，p = σ(θ − b_anchor)，量级 clamp。
// 即从锚 b_anchor 出发，沿 1PL 对数似然对 b 的牛顿方向走一步：
//   - 答错（outcome=0）→ 正残差 → b_label > b_anchor（题对此人更难）。
//   - 答对（outcome=1）→ 负残差 → b_label < b_anchor（题对此人更易）。
// 这是「锚定 θ 的 IRT 反推难度标签」（§6），**不是**裸 outcome——单条噪声大（n=1 CI 宽），
// AIPW 池上聚合去噪。fixed-anchor = 反推锚定在 b_anchor（不自由互估 b，守识别性）。
// ─────────────────────────────────────────────────────────────────────────────
export function impliedBLabel(theta: number, bAnchor: number, outcome: 0 | 1): number {
  return bAnchor + impliedDifficultyResidual(theta, bAnchor, outcome);
}

// ─────────────────────────────────────────────────────────────────────────────
// aipwMean — AIPW / PPI rectifier 均值，**Hájek 自归一化形**（Task 11 step 3，
// ADR-0043 §7；FINDING #1 修复——精确 Σ(1/π) 分母，非 round(N̂) 池规模）。
//
//   aipwMean = predictionMean(pool)  +  [ Σ_labeled (ξ_j / π_j) ] / [ Σ_labeled (1/π_j) ]
//   ξ_j = residual_j = label_j − 锚预测_j；分母 = 已标注样本权重的**精确和** Σ(1/π_j)。
//   labeled 为空 → 校正项 0（退回纯 predictionMean）。
//
// 直觉（control-variate + Hájek 自归一化 Horvitz-Thompson 校正）：先用锚预测 m̂ 在**整个
// 池**上取均值（低方差但有偏——锚可能有系统尺度偏差）；再用**已标注子集**的残差 ξ 做
// Hájek IPW 校正（自归一化 ⇒ 标签一致时校正项精确收敛到真值偏移），两者相加 = 半参数估计。
//
// ⚠️ FINDING #1（§7，Codex review）：校正项分母是 Σ(1/π)（精确权重和），**不是** round(Σ1/π)
// 当池规模 N̂、也**不是** poolPredictions.length。旧实现 materializing Array(round(Σ1/π)).fill
// + ÷N 在非均匀 π 下偏差（Σ1/π 非整 → 比值偏离 1）。均匀 π 下 Σ1/π=N 为整 → 偶然无害，
// 遮住了偏差。自归一化的另一好处：自动消掉「÷n_labeled 再 ÷π」朴素错误形会多乘的 N/n 因子。
//
// positivity（§7）：任何 π ≤ 0 抛错——IPW 权重分母，0 或负是上游 bug（确定性 top-item
// 选题事后归一化的伪 π 不满足 positivity，绝不该到这里）。
// ─────────────────────────────────────────────────────────────────────────────
export interface LabeledResidual {
  /** ξ = label − 锚预测（该已标注样本的残差）。 */
  residual: number;
  /** π = 真随机抽样的 inclusion probability ∈ (0, 1]。≤0 抛错（positivity）。 */
  pi: number;
}

export function aipwMean(poolPredictions: number[], labeledResiduals: LabeledResidual[]): number {
  const N = poolPredictions.length;
  if (N === 0) {
    throw new Error('aipwMean: poolPredictions must be non-empty (N=0 → undefined mean)');
  }
  const predictionMean = poolPredictions.reduce((a, b) => a + b, 0) / N;
  let residualCorrection = 0;
  let weightSum = 0; // Σ(1/π) — Hájek 自归一化分母（精确权重和，FINDING #1）。
  for (const r of labeledResiduals) {
    if (!(r.pi > 0)) {
      // positivity 违反——IPW 权重分母 ≤0 是上游 bug（伪 π / 确定性选题），fail-fast。
      throw new Error(`aipwMean: inclusion probability must be > 0 (positivity), got ${r.pi}`);
    }
    residualCorrection += r.residual / r.pi;
    weightSum += 1 / r.pi;
  }
  // Hájek 自归一化：校正项 ÷ Σ(1/π)（精确），不是 ÷round(Σ1/π) / ÷N（FINDING #1）。
  // labeled 为空 → weightSum=0 → 校正项 0（退回 predictionMean）。
  return predictionMean + (weightSum > 0 ? residualCorrection / weightSum : 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// PPI++ power-tuning λ*（Task 11 step 4，ADR-0043 §7 / §代价行「锚质量自适配兜底」）。
//
// 当锚 b_anchor 质量差（池预测 m̂ 与真标签相关性低）时，纯 AIPW 的方差被坏锚放大。
// PPI++ 引入一个 power λ ∈ [0,1] 给锚预测项降权，**自动向 classical（纯标签）估计退化**：
//   ppiPlusMean(λ) = λ·predictionMean + [ Σ (ξ_λ / π) ] / [ Σ (1/π) ]，ξ_λ = label − λ·m̂
//   （Hájek 自归一化分母 Σ(1/π)，FINDING #1）。
//   λ=1 → 标准 AIPW（信任锚）；λ=0 → classical 纯 Hájek IPW 标签均值（完全不信锚）。
//
// λ* 闭式解（Angelopoulos et al. PPI++ 2023，最小化估计方差）：
//   λ* = Cov(m̂, label_via_ipw) / Var(m̂_via_ipw)
// 这里用 IPW 加权的样本协方差/方差近似（仅已标注样本可观测 label）。锚与标签强相关
// （好锚）→ λ*→1（充分用锚降方差）；弱相关（坏锚）→ λ*→0（退化 classical，不被坏锚拖累）。
// clamp 到 [0,1]（理论上 λ* 可超界，工程上夹住）。
//
// 这是 ADR-0043 §7「PPI++ power-tuning λ* 作锚质量自适配兜底」的实例化——**已实现**
// （非留 seam），因数学闭式且与 aipwMean 同形（aipwMean = ppiPlusMean(λ=1)）。
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
 * 估计 λ*（PPI++ power-tuning）。labeled 样本不足 2 条或锚方差≈0 → 返回 1（退化为标准
 * AIPW，无害默认：单样本无法估方差比，信任锚）。clamp [0,1]。
 */
export function estimateLambdaStar(labeled: LabeledSample[]): number {
  const n = labeled.length;
  if (n < 2) return 1;
  for (const s of labeled) {
    if (!(s.pi > 0)) {
      throw new Error(
        `estimateLambdaStar: inclusion probability must be > 0 (positivity), got ${s.pi}`,
      );
    }
  }
  // IPW 加权一阶矩（每样本权重 1/π，Horvitz-Thompson 风格）。
  const wSum = labeled.reduce((a, s) => a + 1 / s.pi, 0);
  if (!(wSum > 0)) return 1;
  const wMean = (sel: (s: LabeledSample) => number): number =>
    labeled.reduce((a, s) => a + (1 / s.pi) * sel(s), 0) / wSum;
  const mBar = wMean((s) => s.prediction);
  const yBar = wMean((s) => s.label);
  let cov = 0;
  let varM = 0;
  for (const s of labeled) {
    const w = 1 / s.pi;
    const dm = s.prediction - mBar;
    cov += w * dm * (s.label - yBar);
    varM += w * dm * dm;
  }
  if (!(varM > 0)) return 1; // 锚预测无方差（同质池）→ 信任锚（λ=1）。
  const lambda = cov / varM;
  return Math.max(0, Math.min(1, lambda));
}

/**
 * PPI++ power-tuned 均值（aipwMean 的 λ 泛化；λ=1 时数值等于 aipwMean）。**Hájek 自归一化**
 * 校正分母 Σ(1/π)（FINDING #1——精确权重和，非池规模 N / round(N̂)）：
 *   ppiPlusMean(λ) = λ·predictionMean(pool) + [ Σ_labeled ((label − λ·m̂) / π) ] / [ Σ_labeled (1/π) ]
 * labeled 为空 → 校正项 0（退回 λ·predictionMean）。
 */
export function ppiPlusMean(
  poolPredictions: number[],
  labeled: LabeledSample[],
  lambda: number,
): number {
  const N = poolPredictions.length;
  if (N === 0) {
    throw new Error('ppiPlusMean: poolPredictions must be non-empty');
  }
  const predictionMean = poolPredictions.reduce((a, b) => a + b, 0) / N;
  let correction = 0;
  let weightSum = 0; // Σ(1/π) — Hájek 自归一化分母（FINDING #1）。
  for (const s of labeled) {
    if (!(s.pi > 0)) {
      throw new Error(`ppiPlusMean: inclusion probability must be > 0 (positivity), got ${s.pi}`);
    }
    correction += (s.label - lambda * s.prediction) / s.pi;
    weightSum += 1 / s.pi;
  }
  // Hájek 自归一化：÷ Σ(1/π)（精确），不是 ÷N / ÷round(Σ1/π)（FINDING #1）。
  return lambda * predictionMean + (weightSum > 0 ? correction / weightSum : 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 重标定门控阈值（Task 11 step 4，ADR-0043 §4「真值攒到 ~数十题级才启动」）。
//
// RECALIBRATION_MIN_LABELS：该题攒够这么多 difficulty_calibration_label 条才 firm-up
// b_calib。未达 → 不写 b_calib（保持 NULL，effectiveB 退回 b_anchor ?? b）。占位裁决
// （owner 可调）——与 §4「数十题级」对齐取 12（保守起步；单题维度标签稀疏，家族级才稠）。
// ─────────────────────────────────────────────────────────────────────────────
export const RECALIBRATION_MIN_LABELS = 12;

// ─────────────────────────────────────────────────────────────────────────────
// 标签记录 hook — recordDifficultyCalibrationLabel（Task 11 step 3）。
//
// 在一次**客观判分 + softmax-选中（有真 π_i）** 的 attempt 上写一条 difficulty_calibration_label。
// 由 submit.ts / paper-submit.ts 在 attempt tx 的 **SAVEPOINT** 内 best-effort 调用（同
// Phase 5 family hook 的 tx-abort 隔离纪律——任何 DB 错只回滚 savepoint，不毒化主 attempt tx）。
//
// π_i join（YUK-372 L2——按被答 slot 的 stream_item_id **直 join**，彻底修 FINDING #3 +
// Codex P2 残留接缝）：caller 现在把被答 slot 的 practice_stream_item.id 经 input.streamItemId
// 透传进来（submit.ts 从 SubmitBody.stream_item_id；PfSolo 流作答传被答 slot id）。hook 直接
// `eq(selection_observation.stream_item_id, input.streamItemId)` 取**放置那个被答 slot**的随机
// 抽样事件的 π_i，不再用 (date, ref) DESC-LIMIT 近似。
//
// 为什么这是唯一正确判别子：selection_observation 每个 (date, ref_id) 一行（日级
// materializeStream + 当日 reRankAfterAnswer 各写 π_i）。旧的 (date, ref) 近似有两个偏置：
//   - 跨日最近（FINDING #3）：题 day-1 选中 π=0.3、day-5 又选中 π=0.7，以 day-1 作答却贴 0.7。
//     →（date 等值后）已缓解，但仍——
//   - 同日散题重答（Codex P2 残留）：题被 softmax 选进今天的流（π=0.3），用户却经非流路径
//     （散题复习同一题）作答它——仅凭 (date, ref) 无法区分这次作答走没走流 slot，仍把 0.3 错贴
//     给散题作答 → 1/π 是 IPW 权重 ⇒ 偏置 rectifier。
// 按被答 slot 的 stream_item_id 直 join **同时**消掉这两个偏置：精确钉到被答 slot 的那次抽样。
//
// 红线 #2 — 无 streamItemId → **skip，绝不退回 (date, ref) 近似**：散题 / paper / 非流作答
// caller 传 null/undefined（它们本就没走流 slot）→ 立即 skip。宁可少打一条标签，也不把流
// slot 的 π_i 错贴到非流作答上——首批 b_calib 被污染后攒不回（慢资产不可逆）。
//
// 只对真随机抽样（softmax_mfi selected）选中的锚题打标签（§7 positivity）：legacy/到期项确定性
// 选题无 softmax_mfi 观测 → join 不到 → skip。
//
// matched-stream-slot gate（Codex P2，保留为 race-guard）：再 join 被答 slot 的
// practice_stream_item 确认它**仍活、仍属本题**（slot 可能被后续重排删/回填）。判别子是
// (id=streamItemId AND ref_id=questionId)——被答 slot 的日期归属已由 stream_item_id 直 join 隐含
// 确定，**不再叠 date=attemptLocalDate(now) 等值**：那会在跨本地午夜作答时（slot 物化于本地日 D、
// now 滚到 D+1）令 date 等值变成实质约束而非纯冗余 → 误 skip 一条本可成立的午夜锚题标签
// （慢热标签资产稀缺，YUK-372 修复）。
//
// θ-before：caller 传 thetaBefore（在 updateThetaForAttempt 之前捕获的 PRE-attempt θ̂），
// 同 Phase 5 family hook 的纪律——b_label 反推必须锚定作答前的 θ̂，不读已被本次作答移动的
// POSTERIOR mastery_state.theta_hat。
//
// partial 排除：attemptOutcome='partial' → 早返不写（同 Phase 5；部分对对难度反推语义歧义）。
// ─────────────────────────────────────────────────────────────────────────────
export interface RecordDifficultyCalibrationLabelInput {
  /** question.id（被标定题）。 */
  questionId: string;
  /** 产生本标签的 attempt/review event.id（去重锚 + provenance）。 */
  attemptEventId: string;
  /**
   * 题的 1-5 难度档（弱锚兜底）。hook 内部解析 b 锚：item_calibration effectiveB
   * （b_calib ?? b_anchor ?? b，track='hard'）有则用，否则 difficultyToLogitB(difficulty)。
   * 与 state.ts θ̂ 锚 + Phase 5 family hook 同来源链。
   */
  difficulty: number;
  /** 客观判分二元结果：success=1 / failure=0。partial 由 attemptOutcome 早返排除。 */
  outcome: 0 | 1;
  /**
   * 原始 attempt outcome（partial 排除）。'partial' → 早返不写。未传（散题/review 无
   * partial）→ 视为非 partial，按 outcome 折。
   */
  attemptOutcome?: 'success' | 'failure' | 'partial';
  /** 判分路由（isObjectiveJudgeRoute 判客观性；null/非客观 → hook 早返不打标签，§6）。 */
  judgeRoute: string | null | undefined;
  /**
   * 作答时（PRE-attempt）的 θ̂（同 Phase 5 thetaBefore 纪律）。b_label 反推锚定它。
   */
  thetaBefore: number;
  now: Date;
  /**
   * YUK-372 L2 — 被答 slot 的 practice_stream_item.id（π_i 直 join 判别子，Codex P2 残留接缝
   * 的彻底修复）。caller（submit.ts /api/review/submit）从 SubmitBody.stream_item_id 透传；流
   * 作答（PfSolo）传被答 slot id，散题/paper/非流作答传 **null/undefined**。
   *
   * - 非空 → **直 join** selection_observation.stream_item_id = 这个 id（精确取放置该 slot 的
   *   随机抽样事件的 π_i），不再用 (date, ref) DESC-LIMIT 近似。
   * - null/undefined → **立即 skip**（不打标签，不退回 (date, ref) 近似）——这是红线 #2：同日
   *   散题重答同一题时，没有被答 slot id 就无法区分这次作答走没走流 slot，落 (date, ref) 近似会
   *   把流 slot 的 π_i 错贴到散题作答上，毒化首批 b_calib（慢资产污染后攒不回）。宁可 skip。
   */
  streamItemId?: string | null;
}

/**
 * 写一条难度校准标签，或 skip（非客观 / partial / 无真 π_i）。
 *
 * 单条 upsert（onConflictDoNothing on attempt_event_id），无跨步副作用 → 被 SAVEPOINT 吞
 * 而不留半写。**绝不**抛错冒泡打断 attempt 主路径（caller 用 SAVEPOINT + try/catch 兜底）。
 */
export async function recordDifficultyCalibrationLabel(
  tx: Tx,
  input: RecordDifficultyCalibrationLabelInput,
): Promise<void> {
  // 门 (a)：非客观判分不打标签（§6——软判分混 LLM 主观噪声，不进 b 真值通道）。
  if (!isObjectiveJudgeRoute(input.judgeRoute)) return;
  // partial 排除（同 Phase 5）：部分对对难度反推语义歧义，不折。
  if (input.attemptOutcome === 'partial') return;

  // 红线 #2（YUK-372 L2，Codex P2 残留接缝的彻底修复）：被答 slot 的 stream_item_id 是 π_i 的
  // **唯一**正确判别子。无它 → **立即 skip**，绝不退回 (date, ref) 近似。
  // 散题 / paper / 非流作答 caller 传 null/undefined → skip（它们本就没有流 slot 的 π_i）。
  // 流作答（PfSolo）传被答 slot id → 直 join。这把「该题当天在流里被选中」收紧成「**这次作答
  // 走的就是**那个被随机抽样选中的流 slot」——同日散题重答同一题不再误挂流 slot 的 π_i。
  if (input.streamItemId == null) return;
  const streamItemId = input.streamItemId;

  // π_i 直 join（YUK-372 L2）：精确取放置**被答 slot** 的那次 softmax 随机抽样事件的 π_i——
  // 按 stream_item_id 等值 join（不再 (date, ref) DESC-LIMIT 近似）。要求该观测是 softmax_mfi
  // 真随机抽样、selected=true 的事件（§7 positivity；legacy/确定性选题无 softmax_mfi 观测）。
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
  // 只对真随机抽样选中的锚题打标签（§7 positivity）。无真 π_i → skip（不落伪 π_i）。
  if (pi === null || !(pi > 0 && pi <= 1)) return;

  // matched-stream-slot gate（Codex P2）：要求被答 slot 的 practice_stream_item **仍活、仍属本题**。
  // slot 可能因后续重排被删/回填——若已不在，则这条 π_i 不再对应一个活的流 slot → skip。
  // 判别子 = (id=streamItemId AND ref_id=questionId)：被答 slot 的日期归属已由 stream_item_id 直
  // join 隐含确定，**不**再叠 date=attemptLocalDate(now) 等值——那会在跨本地午夜作答时误 skip 合法
  // 锚题标签（slot 物化于本地日 D、now 滚到 D+1 → date 不等 → 丢标签；YUK-372 修复）。
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

  // b 锚：item_calibration effectiveB（track='hard'）有则用，否则弱锚 difficultyToLogitB
  // （与 state.ts θ̂ 锚 + Phase 5 family hook 同来源链）。b_label 反推锚定它。
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
    // 同一 attempt 事件最多一条标签（重试 / 并发首插兜底）。
    .onConflictDoNothing({ target: difficulty_calibration_label.attempt_event_id });
}

// ─────────────────────────────────────────────────────────────────────────────
// 重标定函数 — recalibrateQuestion（Task 11 step 4）。
//
// 读该题的全部 difficulty_calibration_label + 锚 b_anchor，运行 PPI++ AIPW →（门控过则）
// 写 b_calib / calibration_n / calibration_weight / last_calibrated_at。**只此函数写
// b_calib**（不变量①：在线 attempt 不写）。on-demand 函数（非 cron job，见 Report 决策）。
//
// **生产 caller（YUK-372 L1 已接线）**：recalibration_nightly cron（04:50 Asia/Shanghai，
// practice manifest 注册）逐夜把「攒够标签 + 窗内有新标签」的题喂进本函数 firm-up b_calib——
// active-PPI 重标定引擎自此在生产逐夜写首批 b_calib。FINDING #1（Hájek 精确分母）+ FINDING #3
// （π_i 按 placing event join）的估计器正确性是 caller 落地的前置（首批 b_calib 写入即不带偏差，
// 慢热资产不被污染）；本函数仍是纯 on-demand（job 顶层调，不在 attempt tx 内）。
//
// Hájek 自归一化估计器（FINDING #1 修复）：单题维度下锚预测对全池是常数 b_anchor ⇒
// predictionMean=b_anchor 与池如何枚举无关。故**不再** materializing round(Σ1/π) 大小的
// Array(N).fill(b_anchor) 池——`[b_anchor]` 单元素池即给出 predictionMean=b_anchor。IPW 校正
// 项用 ppiPlusMean 的 **Hájek 自归一化分母 Σ(1/π)**（精确权重和）：
//   λ=1（单题常数锚恒定，见下 λ* 说明）⇒ b_calib = b_anchor + Σ((label−b_anchor)/π) / Σ(1/π)
//   = 标签的 Hájek 自归一化 IPW 均值。所有 label 一致（如全 1.5）→ 分子=(1.5−anchor)·Σ(1/π)、
//   分母=Σ(1/π) ⇒ 比值精确 = 1.5−anchor ⇒ b_calib=1.5 **与 π 分布无关**（FINDING #1 旧
//   round(Σ1/π) 分母在非均匀 π 下偏离 1.5）。
//
// λ* 在单题常数锚模式恒 =1（FINDING low-1）：poolPredictions 全 = b_anchor（常数）⇒ 锚预测
// 在样本间无方差 ⇒ estimateLambdaStar 的 Var(m̂)=0 分支返回 1。即「坏锚自降级」安全阀在本
// 模式下**不可能触发**（这不是 bug——λ* 闭式正确，只是常数 m̂ 让方差比无定义，保守信任锚）。
// 安全阀只在 Phase 7+ 引入**非常数** m̂（家族/全库回归锚预测）后才激活；届时 estimateLambdaStar
// 会按真实 Cov(m̂,label)/Var(m̂) 给坏锚降权。本 phase 加 λ*==1 的断言测，防未来读者误以为阀已活。
//
// residual = label − b_anchor（锚预测）。门控：标签数 ≥ RECALIBRATION_MIN_LABELS 才 firm-up。
// 这是单题粒度的轻量实例化（家族/全库粒度的更宽真池 + 非常数 m̂ 留 Phase 7+）。
//
// **数据闸**：b_calib 只在标签攒够后非空（owner 用工具攒标签）。门控未过 → 返回
// {updated:false}，b_calib 保持 NULL，effectiveB 退回 b_anchor ?? b（这是 roadmap 的本意：
// 机器全建好，攒够数据前 idle）。
// ─────────────────────────────────────────────────────────────────────────────
export interface RecalibrateResult {
  updated: boolean;
  labelCount: number;
  /** 写入的 b_calib（updated=true 时）；否则 null。 */
  bCalib: number | null;
  /** PPI++ λ*（updated=true 时）。 */
  lambdaStar?: number;
  reason?: 'below_threshold' | 'no_anchor' | 'ok';
}

export async function recalibrateQuestion(
  db: DbLike,
  questionId: string,
): Promise<RecalibrateResult> {
  // 1. 读锚 b_anchor（track='hard'）。重标定校的是 b_anchor 的尺度偏差。
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
    return { updated: false, labelCount: 0, bCalib: null, reason: 'no_anchor' };
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
  // 3. 数据闸：标签未攒够 → no-op（b_calib 保持 NULL）。
  if (labelCount < RECALIBRATION_MIN_LABELS) {
    return { updated: false, labelCount, bCalib: null, reason: 'below_threshold' };
  }

  // 4. PPI++ AIPW（Hájek 自归一化，FINDING #1）。样本 = (label, m̂=b_anchor, π)。
  const samples: LabeledSample[] = labels.map((l) => ({
    label: l.b_label,
    prediction: bAnchor,
    pi: l.pi,
  }));
  // 单题常数锚：predictionMean=b_anchor 与池规模无关 ⇒ 单元素池即可（**不再** materializing
  // round(Σ1/π) 大小的 Array.fill 池——FINDING #1：那条路径把 IPW 校正项 ÷round(N̂)，非均匀 π
  // 下产生偏差）。IPW 校正用 ppiPlusMean 的 Hájek 自归一化分母 Σ(1/π)（精确权重和）。
  // λ* 在常数锚模式恒 =1（Var(m̂)=0；FINDING low-1，见上 doc），坏锚安全阀本模式不触发。
  const poolPredictions = [bAnchor];
  const lambdaStar = estimateLambdaStar(samples);
  const bCalib = ppiPlusMean(poolPredictions, samples, lambdaStar);

  // 5. firm-up b_calib（**只此函数写**，不变量①）。calibration_weight = 有效样本量 proxy
  //    Σ π_i（Horvitz-Thompson 期望子集大小，标签越多/π 越接近 1 → 权重越高）。
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

  return { updated: true, labelCount, bCalib, lambdaStar, reason: 'ok' };
}
