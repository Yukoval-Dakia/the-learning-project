// ─────────────────────────────────────────────────────────────────────────────
// A4 (YUK-436) — discrete grid-Bayes posterior over the per-KC θ_KC OFFSET.
//
// inc-1 is PURE-ADDITIVE SHADOW: we maintain a discrete posterior over the per-KC
// θ_KC OFFSET (the same offset the Elo path tracks as theta_hat), computed and
// PERSISTED shadow-only (no downstream reader in inc-1). Elo theta_hat stays the
// SOURCE OF TRUTH. The grid exists to validate calibration on live data before the
// invasive grid→SoT cut-over (inc-2, deferred — must serialize AFTER A3). The
// posterior yields a CALIBRATED standard error (posteriorSe) the point-estimate Elo
// precision/Fisher path cannot, which is the eventual payoff.
//
// ORTHOGONALITY TO A2 (hierarchical Elo): the grid is over the θ_KC OFFSET, with
//   θ_global as a TRANSLATION ANCHOR. The 1PL likelihood evaluates the item
//   characteristic curve at the EFFECTIVE ability = θ_global + θ_KC_offset, i.e. we
//   shift the item difficulty by θ_global: b' = b − θ_global. So the grid runs over
//   the SAME offset coordinate A2's per-KC layer uses, and θ_global merely translates
//   the likelihood. The grid does NOT subsume A2 (it does not model θ_global) and it
//   builds ON it (reads θ_global as the anchor). θ_global defaults 0 pre-A2 / reads
//   the A2 per-domain global post-A2 — at the wiring seam (state.ts).
//
// FLAG: THETA_GRID_ENABLED gates the whole thing as a module-level const (mirrors
//   SRT_ENABLED / HIERARCHICAL_ELO_ENABLED — NO config table, NO env). Default FALSE
//   this PR = dark-ship. When false, NO grid is computed or persisted: theta_hat +
//   precision + counts stay BYTE-IDENTICAL to today and theta_grid_json stays NULL
//   (the regression anchor the db tests pin with toBe + IS NULL).
//
// inc-1 likelihood = BINARY Bernoulli ONLY. A continuous-CB (signed-residual-time)
//   likelihood is written below but GATED — it is wired only when SRT_ENABLED &&
//   THETA_GRID_ENABLED (both true), which is NOT the case inc-1. It is stubbed-but-
//   correct so the cut-over (inc-2) can wire it without re-deriving the math.
//
// inc-1 runs the grid ONLY for single-KC items (knowledgeIds.length === 1). The
//   multi-KC conjunctive likelihood (a product over the touched KCs' offsets) is
//   DEFERRED — a single attempt's outcome is one Bernoulli draw shared across KCs, so
//   the per-KC posterior factorisation is non-trivial and not needed to validate
//   single-KC calibration. The wiring seam (state.ts) enforces the single-KC gate.
// ─────────────────────────────────────────────────────────────────────────────

import { expectedScore, fisherInformation3pl } from './theta';

/**
 * Master flag for the discrete grid-Bayes θ_KC posterior. **Default false (dark-ship).**
 *
 * false → NO grid is computed or persisted anywhere. updateThetaForAttempt's tail
 *   shadow-write block is skipped entirely → theta_grid_json stays NULL and the Elo
 *   theta_hat / precision / counts are BYTE-IDENTICAL to today (regression anchor).
 * true  → for SINGLE-KC items only, the per-KC θ_KC offset posterior is updated by one
 *   sequential-Bayes step and PERSISTED shadow-only to mastery_state.theta_grid_json.
 *   NOTHING downstream reads it in inc-1 (it does not feed p(L) / effectiveB / selection).
 *
 * Flipped only at the inc-2 grid→SoT cut-over (deferred; must serialize AFTER A3),
 * after the shadow posterior is validated against the live Elo point estimate.
 */
export const THETA_GRID_ENABLED = false;

/**
 * Sibling dark-ship flag for YUK-513 #123 / inc-E — the deterministic prereq-DAG
 * day-one (n=0) prior propagation (the Rust `propagatePriors` kernel,
 * crates/calibration-native). **Default false (dark-ship).**
 *
 * NAME — deliberately `DAY_ONE_PRIOR_ENABLED`, NOT `PREREQ_PROPAGATION_ENABLED`
 * (which the design doc pre-blessed for inc-E): YUK-455 shipped two flags of that
 * name first — `src/core/prereq-propagation.ts` (A6 directed θ̂ propagation) and
 * `src/server/mastery/prereq-propagation.ts` (A13 backward-risk producer). Those are
 * DIFFERENT inc-E mechanisms with independent flip gates; this one gates ONLY the
 * day-one prior read surface, so it carries a distinct, specific name to avoid a
 * three-way same-name collision.
 *
 * Lives here, alongside THETA_GRID_ENABLED, for the SAME reason its consumer
 * (src/server/coldstart/propagate-priors.ts loadDayOnePriors) reads it across a
 * module boundary: a getter-mock on '@/core/theta-grid' can then toggle the flag
 * for both the wrapper's internal read AND the placement-profile route in one place
 * (mirrors how candidate-signals.ts / state.ts consume THETA_GRID_ENABLED).
 *
 * false → loadDayOnePriors returns null (NO-OP); the placement-profile response is
 *   BYTE-IDENTICAL to today (no day_one_prior field). The regression anchor.
 * true  → every KC in scope gets a day-one prior — roots sit at the uniform ≈0.5,
 *   dependents are shrunk by the probabilistic-AND of their prerequisites' E_mastery
 *   (plus a weakest-prereq attribution) — surfaced as a DARK field on ProfileKc. Still
 *   no UI consumer until PR-3 (design-gated). The native binding is dev/CI-only, so even
 *   with the flag true the surface NO-OPs wherever the .node is absent (incl. prod
 *   today) — flipping it on is safe, never a hard dependency.
 */
export const DAY_ONE_PRIOR_ENABLED = false;

/**
 * Grid endpoints on the θ_KC OFFSET logit scale: [-4, 4]. The offset is the
 * deviation of per-KC ability from the (A2) per-domain anchor θ_global, so a ±4-logit
 * window comfortably brackets any plausible per-KC deviation (σ(±4) ≈ 0.018 / 0.982).
 */
export const GRID_MIN = -4;
export const GRID_MAX = 4;

/**
 * Number of grid points: 41 over [-4, 4] ⇒ a 0.2-logit step (GRID_STEP). 41 is odd so
 * a point lands EXACTLY on the offset origin 0 (index 20), the cold-start prior mode.
 */
export const GRID_POINTS = 41;

/** Logit step between adjacent grid points = (GRID_MAX − GRID_MIN) / (GRID_POINTS − 1) = 0.2. */
export const GRID_STEP = (GRID_MAX - GRID_MIN) / (GRID_POINTS - 1);

/**
 * The θ_KC OFFSET support points: [-4, -3.8, …, 0, …, 3.8, 4] (41 points, 0.2 step).
 * Frozen module constant — every posterior is a length-GRID_POINTS probability vector
 * aligned to this support.
 */
export const GRID_THETA: readonly number[] = Array.from(
  { length: GRID_POINTS },
  (_, i) => GRID_MIN + i * GRID_STEP,
);

/**
 * The shadow posterior persisted to mastery_state.theta_grid_json (inc-1). We store
 * ONLY the probability vector (the support is the frozen GRID_THETA module constant,
 * so persisting it would be redundant + drift-prone) plus the integer evidence count
 * (how many sequential-Bayes steps have folded in). posteriorMean / Var / Se are
 * DERIVED on read — never persisted (single source of truth, mirrors thetaSe deriving
 * SE from precision rather than storing it).
 */
export interface ThetaGridPosterior {
  /** length-GRID_POINTS probability mass over GRID_THETA; sums to 1 (normalised). */
  probs: number[];
  /** number of sequential-Bayes updates folded into this posterior (0 = pure prior). */
  evidence: number;
}

/**
 * The cold-start prior over the θ_KC OFFSET: UNIFORM over the 41 grid points (mass
 * 1/41 each). Uniform — not Gaussian-at-0 — keeps inc-1 assumption-light: the offset
 * prior is whatever the sequential likelihood folds in, with no extra shrinkage knob
 * to mis-tune before calibration validation. evidence = 0 (pure prior, no folds yet).
 */
export function uniformPrior(): ThetaGridPosterior {
  const mass = 1 / GRID_POINTS;
  return { probs: Array.from({ length: GRID_POINTS }, () => mass), evidence: 0 };
}

/**
 * Binary Bernoulli likelihood of one attempt outcome at a given θ_KC offset, under the
 * 1PL/Rasch ICC evaluated at the EFFECTIVE ability (θ_global anchor + offset). We pass
 * the DIFFICULTY-shifted anchor b' = b − θ_global so the likelihood reads:
 *
 *   p = σ(effective − b) = σ((θ_global + offset) − b) = σ(offset − (b − θ_global)) = σ(offset − b')
 *
 * i.e. `expectedScore(offset, bPrime)`. This is exactly the Elo path's likelihood with
 * the offset as the free coordinate and θ_global folded into the anchor — orthogonal
 * to A2, building ON its θ_global. correct ⇒ p, wrong ⇒ 1 − p.
 *
 * **c 定义域（CR-1/CR-3）：c ∈ [0, 1)**。唯一 producer 是 `choicesToGuess`，结构性只
 *   返回 {0} ∪ (0, 1/2]（k≥2 → 1/k ≤ 1/2；k≤1 → 0），永不产 c≥1/2 以上、更不产 c=1。
 *   c=1 是域外的退化点（correct 恒 1 / wrong 恒 0），仅靠 gridUpdate 的 total>0 守卫优雅
 *   降级、非受支持输入。**inc-2 接线绝不可把 c 回落到 ADR-0035 的软轨 `irt_c` 列**——本桥
 *   的 c 是 choices_md.length 派生的设计常量（n=1 红线合规），不是拟合出的 guess 参数。
 */
export function binaryLikelihood(offset: number, bPrime: number, outcome: 0 | 1, c = 0): number {
  // BKT graft 1 (YUK-436): 3PL lower-asymptote. c=0 ⇒ 1PL 退化（显式 delegate 保
  // byte-identical 回归锚）；c>0（选择题，c=1/k）走 3PL 渐近线 P=c+(1−c)·σ。
  //   correct ⇒ P(correct) = c + (1−c)·σ(offset − b')
  //   wrong   ⇒ P(wrong)   = (1−c)·(1 − σ(offset − b'))      （= 1 − P(correct)）
  // c 是 choices_md.length 派生的设计常量（n=1 红线合规，见 fisherInformation3pl 注）。
  if (c === 0) {
    const p = expectedScore(offset, bPrime); // σ(offset − b') = σ((θ_global+offset) − b)
    return outcome === 1 ? p : 1 - p;
  }
  const phat = expectedScore(offset, bPrime);
  return outcome === 1 ? c + (1 - c) * phat : (1 - c) * (1 - phat);
}

/**
 * 从 question.choices_md（jsonb<string[]>）派生 3PL guess 参数 c = 1/k。
 *
 * k = choices_md.length（选择题选项数）；k<2（null / 空 / 单选占位）按非选择题处理
 * ⇒ c=0，binaryLikelihood/gridUpdate/klpScoreFromGrid 退化为现有 1PL（逐位相同）。
 * **选择题的决定性特征就是 choices_md**（参 exact.ts:71-102 的判分侧用法），无需新
 * schema 列；接线（state.ts 把 choices_md 喂进来）在 inc-2 grid→SoT cut-over 才上，
 * 故本桥当前是 DARK-SHIP 算法层供件，无 live caller。
 */
export function choicesToGuess(choices: readonly string[] | null | undefined): number {
  if (!choices || choices.length < 2) return 0; // 非选择题 → 1PL 退化
  return 1 / choices.length;
}

/**
 * GATED continuous-CB (signed-residual-time) likelihood STUB — NOT wired inc-1.
 *
 * The A1 continuous srtOutcome ∈ [0,1] is a soft correctness analog. Under the same
 * 1PL anchor, the continuous-Bernoulli (CB) likelihood at offset is the CB density with
 * mean tied to p = σ(offset − b'). For inc-1 we DO NOT wire this — it is reached only
 * when BOTH SRT_ENABLED && THETA_GRID_ENABLED (the state.ts seam keeps it gated). We
 * provide a correct-form stub (the soft-Bernoulli p^x·(1−p)^(1−x) interpolation, the
 * same family conjunctiveCreditsContinuous reduces to at the binary endpoints) so the
 * inc-2 cut-over can wire it without re-deriving the math.
 *
 * Reduces BIT-EXACTLY to binaryLikelihood at the binary endpoints (srt ∈ {0,1}):
 *   srt=1 ⇒ p^1·(1−p)^0 = p == binaryLikelihood(…, 1)
 *   srt=0 ⇒ p^0·(1−p)^1 = 1−p == binaryLikelihood(…, 0)
 */
export function continuousCbLikelihood(offset: number, bPrime: number, srt: number): number {
  const p = expectedScore(offset, bPrime);
  // Soft-Bernoulli interpolation p^srt·(1−p)^(1−srt). Endpoints reproduce the binary
  // likelihood exactly; the interior is the (unnormalised-constant) CB kernel — the
  // posterior renormalises across the grid, so the missing CB normaliser C(p) cancels
  // as a per-offset factor only if C is offset-independent. inc-2 must confirm/wire the
  // exact CB normaliser; this stub is INTENTIONALLY not on any live path inc-1.
  return p ** srt * (1 - p) ** (1 - srt);
}

/**
 * One sequential-Bayes update step: posterior ∝ prior · likelihood(outcome | offset, b').
 *
 * n=1-LEGAL: this is single-learner sequential Bayes — the item difficulty b (hence b')
 * is a LOCKED external anchor (item-half locked, G4 red line: we never fit b), so the
 * only free parameter is the learner's per-KC offset. Each attempt folds one Bernoulli
 * likelihood into the running posterior; there is no cohort dimension and none is
 * needed (b is given, not estimated).
 *
 * Pure: returns a NEW posterior, never mutates the input. The result is renormalised so
 * `probs` sums to 1 (guards against float underflow: if the unnormalised mass is ~0 —
 * a likelihood that vanishes over the whole grid — we fall back to the prior rather than
 * dividing by zero, keeping the posterior a valid distribution).
 */
export function gridUpdate(
  prior: ThetaGridPosterior,
  bPrime: number,
  outcome: 0 | 1,
  c = 0,
): ThetaGridPosterior {
  const unnorm = prior.probs.map(
    (mass, i) => mass * binaryLikelihood(GRID_THETA[i], bPrime, outcome, c),
  );
  const total = unnorm.reduce((acc, m) => acc + m, 0);
  if (!(total > 0)) {
    // Degenerate likelihood (underflow over the whole grid) — keep the prior shape +
    // still count the evidence fold (the attempt happened) rather than emit NaNs.
    return { probs: [...prior.probs], evidence: prior.evidence + 1 };
  }
  return {
    probs: unnorm.map((m) => m / total),
    evidence: prior.evidence + 1,
  };
}

/** Posterior mean E[offset] = Σ probs_i · GRID_THETA_i (the calibrated point estimate). */
export function posteriorMean(posterior: ThetaGridPosterior): number {
  return posterior.probs.reduce((acc, mass, i) => acc + mass * GRID_THETA[i], 0);
}

/** Posterior variance Var[offset] = Σ probs_i · (GRID_THETA_i − mean)² (≥ 0). */
export function posteriorVar(posterior: ThetaGridPosterior): number {
  const mean = posteriorMean(posterior);
  return posterior.probs.reduce((acc, mass, i) => acc + mass * (GRID_THETA[i] - mean) ** 2, 0);
}

/**
 * Posterior standard error = √Var — the CALIBRATED SE the grid yields (the eventual
 * payoff over the Elo point estimate's Fisher-derived SE). Derived, never persisted.
 */
export function posteriorSe(posterior: ThetaGridPosterior): number {
  return Math.sqrt(posteriorVar(posterior));
}

// ─────────────────────────────────────────────────────────────────────────────
// A4 inc-2 (YUK-436) — grid→selection wiring: posterior-weighted Fisher information
// over the ACTUAL discrete grid posterior (the calibrated payoff over the Gaussian
// approximation in selection-signals.klpScore).
//
// selection-signals.klpScore integrates Fisher over a Gaussian θ ~ Normal(θ̂, SE²)
// reconstructed from the Elo `theta_precision` — an APPROXIMATION of the posterior. The
// grid already IS the posterior (a length-GRID_POINTS pmf over the θ_KC offset), so when
// it is available we can take the EXACT posterior-weighted Fisher integral instead of
// re-approximating. This is the A4 "免费 Fisher 选题" payoff named in the issue.
//
// DARK-SHIP: this function is PURE + always callable, but its ONLY caller
// (candidate-signals.ts) is gated behind THETA_GRID_ENABLED (default false), so it is a
// complete NO-OP on the live selection path until the grid→SoT cut-over is flipped after
// calibration validation. Wiring the reader now (flag off) does not change any live score.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Posterior-weighted Fisher information over the grid posterior of the θ_KC OFFSET.
 *
 *   score = Σ_i probs_i · fisherInformation(θ_global + GRID_THETA_i, b)
 *
 * The grid runs over the OFFSET; the effective ability at grid point i is
 * `θ_global + GRID_THETA_i` (the same anchor the write-path likelihood uses via
 * b' = b − θ_global — see binaryLikelihood). `b` is the item difficulty (LOCKED anchor,
 * never fit). `probs` already sum to 1 (gridUpdate renormalises), so this is a true
 * expectation — no extra normalisation needed.
 *
 * Relationship to the Gaussian klpScore (selection-signals.ts):
 *   - a posterior concentrated on one offset reduces to point Fisher at that effective
 *     ability (== mfiScore when that point is θ̂);
 *   - a spread posterior down-weights the peak with the surrounding lower-information
 *     offsets ⇒ more conservative, exactly the KLP intent — but driven by the REAL
 *     posterior shape rather than a Gaussian(θ̂, thetaSe) stand-in.
 *
 * Range: fisherInformation ∈ (0, 0.25] and a convex combination stays in (0, 0.25].
 * Pure, zero IO, shares the single `fisherInformation` truth with mfiScore/klpScore.
 */
export function klpScoreFromGrid(
  posterior: ThetaGridPosterior,
  b: number,
  thetaGlobal: number,
  c = 0,
): number {
  // BKT graft 1：c>0（选择题）用 3PL Fisher；c=0（非选择题）fisherInformation3pl
  // 显式 delegate 到 fisherInformation（逐位相同），故既有 1PL 测试锚点不变。
  return posterior.probs.reduce(
    (acc, mass, i) => acc + mass * fisherInformation3pl(thetaGlobal + GRID_THETA[i], b, c),
    0,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BKT graft 2 (YUK-436) — 掌握跃迁检测（从 θ̂ 后验轨迹派生，无新模型）。
//
// 设计见 handoff：每 KC 维护滚动窗口——
//   p_mastery = 后验落在 θ* 以上的质量
//   width     = 后验标准差（posteriorSe）
//   毕业触发  = p_mastery > 0.8 连续 N=3 次 且 width < ε 且 evidence_count >= M≈8
//   掌握线 θ* = 该 KC 的一个 **KC 级代表难度 b**（见下「θ* 歧义」）
//
// **θ* 歧义澄清（inc-2 接线契约，切勿混同两个 b）**：
//   ① item_calibration 表按 **question_id 键**，逐题一个 b——**没有逐 KC 的 b 列**。
//   ② 掌握线 θ* 需要一个 **KC 级代表 b**（inc-2 定义：如该 KC 名下 item b 的中位/均值，
//      或指定代表题）。它与「当次 attempt 的 bPrime」**不是同一个数值**——只是同一
//      构造式（都 = 某个 b 减 θ_global，见下 offset 轴表达）。当次 bPrime 逐题跳动；
//      KC 级 θ* 在一个毕业窗口内必须稳定。
//   ③ **inc-2 接线者绝不可把当次 attempt 的 bPrime 直接传给 masterySnapshot 当阈值**：
//      那样掌握线会随每题难度跳动，「连续 N 次 p_mastery>0.8」的连续性判定失去意义
//      （每次比的是不同的线）。masterySnapshot 的 bPrime 参数必须喂 KC 级代表阈值。
//
// **θ* 的 offset 轴表达**：grid posterior 是 over θ_KC OFFSET，effective ability 在
//   grid 点 i = θ_global + GRID_THETA_i。「后验落在 θ* 以上」= 后验 mass 落在
//   θ_global + GRID_THETA_i ≥ θ* 的点 = GRID_THETA_i ≥ θ* − θ_global = b − θ_global
//   = bPrime（与嫁接 1 用的 **同一构造**——减 θ_global——但此处 b 是 KC 级代表难度，
//   非当次 attempt 的 b）。所以掌握线在 offset 轴上恰好是 bPrime，无需 θ_global 作
//   参数——caller 传 KC 级 bPrime 即可。
//
// DARK-SHIP / DEFER：本节全是纯函数、零 IO、无 caller（inc-1 shadow）。轨迹持久化
//   （recent 滚动窗口的 jsonb 字段，参 RtCorrectBuffer 的环形缓冲模式）+ KcGraduated
//   事件枚举 + state.ts 接线 + 掌握线读取 item_calibration.b，全部 defer 到 inc-2
//   grid→SoT cut-over（flag 翻转后才有意义：现在 grid 不被任何路径算）。先落地纯数学
//   让 cut-over 不必再推。
// ─────────────────────────────────────────────────────────────────────────────

/** 一次作答更新后的掌握派生量（caller 现算，不持久化——轨迹才是状态）。 */
export interface MasterySnapshot {
  /** 后验落在掌握线 θ*（offset 轴 = bPrime）以上的质量。 */
  pMastery: number;
  /** 后验标准差 = posteriorSe；小 ⇒ 后验集中 ⇒ 量估计更可信。 */
  width: number;
}

/**
 * 毕业判定的可调阈值（handoff 默认值；ε/M 等 inc-2 拿真实后验收敛宽度后再定）。
 * 全部带默认值，调用方零配置即可用。
 */
export interface GraduationConfig {
  /** p_mastery 下限，默认 0.8（handoff）。 */
  readonly pMasteryMin?: number;
  /** width 上限 ε（logit offset 轴），默认 1.0——占位，待校准。 */
  readonly widthMax?: number;
  /** 连续命中 N 次，默认 3（handoff）。 */
  readonly consecutiveN?: number;
  /** evidence_count 下限 M，默认 8（handoff ≈8）。 */
  readonly evidenceMin?: number;
}

/**
 * 后验落在 offset 阈值（= 掌握线 bPrime）以上的总质量。
 *   p_mastery = Σ_{i : GRID_THETA_i ≥ thresholdOffset} probs_i
 *
 * 用 ≥ 而非 >：grid 步长 0.2，掌握线恰好落在格点上（bPrime 是 b−θ_global，连续值，
 * 一般不正好落格点），用 ≥ 保证边界一致。posteriorMassAbove 也可单独用于「掌握度读数」，
 * 不必走毕业判定。
 */
export function posteriorMassAbove(posterior: ThetaGridPosterior, thresholdOffset: number): number {
  return posterior.probs.reduce(
    (acc, mass, i) => acc + (GRID_THETA[i] >= thresholdOffset ? mass : 0),
    0,
  );
}

/**
 * 从一次后验现算 MasterySnapshot（p_mastery + width）。纯函数无 IO。
 * caller（inc-2 接线）每次 gridUpdate 后调它，把 snapshot 推进 recent 滚动窗口。
 *
 * @param bPrime 掌握线 θ* 在 offset 轴上的表达（= KC 级代表难度 − θ_global）。**必须
 *   是 KC 级稳定阈值，不是当次 attempt 的 bPrime**（见本文件「θ* 歧义澄清」注）——否则
 *   掌握线逐题跳动，连续 N 次判定失义。
 */
export function masterySnapshot(posterior: ThetaGridPosterior, bPrime: number): MasterySnapshot {
  return {
    pMastery: posteriorMassAbove(posterior, bPrime),
    width: posteriorSe(posterior),
  };
}

/**
 * 是否满足毕业触发条件：p_mastery>0.8 连续 N=3 次 且 width<ε 且 evidence≥M。
 *
 * - posterior.evidence < M  → false（证据不足，还没到可毕业的信息量）。
 * - recent 不足 N 个 → false（轨迹太短，连续性无法判定）。
 * - 否则取 recent 最后 N 个，逐个验 pMastery>p_min && width<ε。
 *
 * @param recent 掌握 snapshot 滚动窗口，约定 **oldest→newest**（最后一个是最近一次
 *   作答的 snapshot）——尾部 N 个即「最近连续 N 次」。与 RtCorrectBuffer 的环形缓冲
 *   同序约定（push-newest-to-tail），inc-2 接线者按此顺序推进窗口。
 *
 * 纯函数：不读不写任何状态。recent 滚动窗口的持久化是 caller 的 inc-2 责任。
 */
export function isGraduationCandidate(
  posterior: ThetaGridPosterior,
  recent: readonly MasterySnapshot[],
  cfg: GraduationConfig = {},
): boolean {
  const { pMasteryMin = 0.8, widthMax = 1.0, consecutiveN = 3, evidenceMin = 8 } = cfg;
  // FAIL-CLOSED（CR-2）：毕业 gate 遇坏 config 绝不放行。consecutiveN <= 0 会让
  //   slice(length) = [] → every([]) ≡ true（vacuous truth）→ 空窗口静默毕业。这是
  //   毕业闸，坏配置必须保守拒绝（镜像 srtOutcome 对畸形输入的保守降级惯例），故显式
  //   短路。放在窗口判定之前：recent.length < consecutiveN 对 consecutiveN<=0 恒 false，
  //   兜不住这个洞。
  if (consecutiveN <= 0) return false;
  if (posterior.evidence < evidenceMin) return false;
  if (recent.length < consecutiveN) return false;
  const tail = recent.slice(recent.length - consecutiveN);
  return tail.every((s) => s.pMastery > pMasteryMin && s.width < widthMax);
}
