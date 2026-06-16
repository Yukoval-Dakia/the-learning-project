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
// ─── AIPW 归一化（§7，Codex review 揪出的 bug 不能犯）──────────────────────────────
// 正确形： aipwMean = (1/N)·Σ_pool m̂_i  +  (1/N)·Σ_labeled (ξ_j / π_j)
//   N = 候选池大小（poolPredictions.length），m̂ = 池上锚预测（b_label 的锚预测），
//   ξ_j = 第 j 条已标注的残差（label − 锚预测），π_j = 真随机抽样的 inclusion probability。
// **不是**对已标注先 ÷n_labeled 再 ÷π（均匀抽样下会多乘 N/n_labeled 过度校正）——两段都
// ÷N。positivity：任何 π ≤ 0 抛错（IPW 权重分母）。

import { newId } from '@/core/ids';
import { difficultyToLogitB } from '@/core/theta';
import type { Db, Tx } from '@/db/client';
import { difficulty_calibration_label, item_calibration, selection_observation } from '@/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { impliedDifficultyResidual, isObjectiveJudgeRoute } from './personalized-difficulty';

type DbLike = Db | Tx;

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
// aipwMean — AIPW / PPI rectifier 均值（Task 11 step 3，ADR-0043 §7 正确归一化）。
//
//   aipwMean = predictionMean + (1/N)·Σ_j (residual_j / π_j)
//            = (1/N)·Σ_pool m̂_i  +  (1/N)·Σ_labeled (ξ_j / π_j)
//   N = poolPredictions.length（候选池大小，分母两段都用它）。
//
// 直觉（control-variate / Horvitz-Thompson 校正）：先用锚预测 m̂ 在**整个池**上取均值
// （低方差但有偏——锚可能有系统尺度偏差）；再用**已标注子集**的残差 ξ/π 做 IPW 校正
// （无偏但高方差），两者相加 = 半参数无偏估计。π 是真随机抽样的 inclusion probability。
//
// ⚠️ 正确归一化（§7，Codex review）：残差校正项是 (1/N)·Σ ξ/π，**不是** (1/n_labeled)·
// Σ ξ/π 再 ÷π。均匀抽样下 π ≈ n_labeled/N，若误用 (1/n_labeled)·Σ ξ/π 会让校正项 ≈
// (1/n_labeled)·Σ ξ·(N/n_labeled) —— 多乘了一个 N/n_labeled 因子，过度校正。两段都 ÷N。
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
  for (const r of labeledResiduals) {
    if (!(r.pi > 0)) {
      // positivity 违反——IPW 权重分母 ≤0 是上游 bug（伪 π / 确定性选题），fail-fast。
      throw new Error(`aipwMean: inclusion probability must be > 0 (positivity), got ${r.pi}`);
    }
    residualCorrection += r.residual / r.pi;
  }
  // **两段都 ÷N**（§7 正确归一化）——不是 residualCorrection ÷ n_labeled。
  return predictionMean + residualCorrection / N;
}

// ─────────────────────────────────────────────────────────────────────────────
// PPI++ power-tuning λ*（Task 11 step 4，ADR-0043 §7 / §代价行「锚质量自适配兜底」）。
//
// 当锚 b_anchor 质量差（池预测 m̂ 与真标签相关性低）时，纯 AIPW 的方差被坏锚放大。
// PPI++ 引入一个 power λ ∈ [0,1] 给锚预测项降权，**自动向 classical（纯标签）估计退化**：
//   ppiPlusMean(λ) = λ·predictionMean + (1/N)·Σ (ξ_λ / π)，ξ_λ = label − λ·m̂
//   λ=1 → 标准 AIPW（信任锚）；λ=0 → classical 纯 IPW 标签均值（完全不信锚）。
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
 * PPI++ power-tuned 均值（aipwMean 的 λ 泛化；λ=1 时数值等于 aipwMean）。
 *   ppiPlusMean(λ) = λ·predictionMean(pool) + (1/N)·Σ_labeled ((label − λ·m̂) / π)
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
  for (const s of labeled) {
    if (!(s.pi > 0)) {
      throw new Error(`ppiPlusMean: inclusion probability must be > 0 (positivity), got ${s.pi}`);
    }
    correction += (s.label - lambda * s.prediction) / s.pi;
  }
  return lambda * predictionMean + correction / N;
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
// π_i join（设计接缝，见 Report「π_i join 的设计张力」）：从 selection_observation 取该题
// （ref_id=questionId AND ref_kind='question'）**最近一条 policy='softmax_mfi' 且
// selected=true** 的观测的 inclusion_probability（按 created_at desc）。**有意不按 date
// 等值 join**——题可能在前一天被 softmax 选中、今天才作答，date 等值会漏掉真 π_i；取「该题
// 最近一次 softmax 选中观测」是治理本次作答的那个抽样事件的最稳健代理。只对真随机抽样选中
// 的锚题打标签（§7 positivity）；legacy/到期项无真 π_i（确定性选题，无 softmax_mfi 观测）
// → join 不到 → **skip**（一条都不写，不落伪 π_i 污染慢热资产）。
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

  // π_i join：取该题最近一条 softmax 选中观测的真 π_i。legacy/到期/无观测 → null → skip。
  const obsRows = await tx
    .select({ pi: selection_observation.inclusion_probability })
    .from(selection_observation)
    .where(
      and(
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
// 候选池 + HT 一致性（§7 positivity 的承重细节）：active-PPI/AIPW 的 `(1/N)` 里 N 必须是
// **候选池规模**（不是已标注条数）——否则 §7 警告的「多乘 N/n」过度校正会反向发生（用
// n_labeled 当 N 会**少**算池规模，让 IPW 校正项被放大）。单题维度下锚预测对全池是常数
// b_anchor，故 predictionMean=b_anchor 与池如何枚举无关；关键是 N。π_i 是真随机抽样的
// inclusion probability，Horvitz-Thompson 恒等式 E[Σ_labeled 1/π_i] = N_pool ⇒ 池规模的
// 无偏估计 N̂_pool = round(Σ 1/π_i)。故 poolPredictions = b_anchor 复制 N̂_pool 次：
//   - 均匀 π=0.5、N_labeled 条 → N̂_pool = 2·N_labeled，bCalib = anchor + mean(label−anchor)
//     = mean(label)（退化为标签的 Hájek/自归一化均值，直觉正确）。
//   - π→1（几乎确定性选中）→ N̂_pool→N_labeled，池≈已观测，校正项不被 IPW 放大。
// residual = label − b_anchor（锚预测）。门控：标签数 ≥ RECALIBRATION_MIN_LABELS 才 firm-up。
// 这是单题粒度的轻量实例化（家族/全库粒度的更宽真池留 Phase 7+，届时 m̂ 不再是常数）。
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

  // 4. PPI++ AIPW。样本 = (label, m̂=b_anchor, π)。
  const samples: LabeledSample[] = labels.map((l) => ({
    label: l.b_label,
    prediction: bAnchor,
    pi: l.pi,
  }));
  // 池规模 N̂_pool = round(Σ 1/π_i)（Horvitz-Thompson 无偏估计，见上 doc）。锚对全池常数 →
  // poolPredictions = b_anchor 复制 N̂_pool 次。floor 到 labelCount（池至少有已观测这么多）。
  const estimatedPoolSize = Math.max(
    labelCount,
    Math.round(samples.reduce((a, s) => a + 1 / s.pi, 0)),
  );
  const poolPredictions = Array(estimatedPoolSize).fill(bAnchor);
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
