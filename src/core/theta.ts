// B1-W1 (ADR-0035 阶段② Elo/θ 追踪) — 纯函数 Elo θ̂ 在线更新。
//
// 只更新 θ̂（个体能力，logit 尺度）；b 是锁死外部锚，永不回写（G4 红线，
// item-更新半边 n=1 结构性失效）。喂 PFA p(L) 诊断维，绝不碰 FSRS R 调度维。
//
// K schedule 设计裁决（VERIFY:elo-k-schedule，1/√n REFUTED）:
//   owner 主线场景是非平稳（在学、θ 上升）。1/√(evidence_count) 单调衰减是
//   平稳目标收敛工具，套到上升 θ 会产生 downward lag bias（稳定停在过去能力）。
//   故本 wave 用「有界 K + 冷启段高 K + 时间折扣」轻量退路（VERIFY 选项 A），
//   而非不确定性驱动 K（选项 B，需 RD/urn-count 后验机器，本 wave 太重，defer Wave2）。
//   K 不单调衰减到 0：保 kFloor 让 θ̂ 永远保留追上升能力的自由度。
//
// θ̂_min 分栏注意（防后人误用）：ADR-0042 的 θ̂_min 是**选题/MFI 聚合语义**
//   （ex-ante 选哪道题），不是更新语义（ex-post 这道题怎么动 θ̂）。本模块只做
//   ex-post 在线更新；选题聚合不在本 wave 范围。

import { POLY_SIGMOID_ENABLED, polySigmoid } from './poly-exp';

/** Logistic CDF — the 1PL/Rasch item characteristic curve P = σ(θ - b).
 * decision ② (dark-ship, POLY_SIGMOID_ENABLED=false today): routes through the shared
 * bit-exact `polySigmoid` when flipped, else the live `Math.exp` (byte-identical to today). */
function logistic(x: number): number {
  return POLY_SIGMOID_ENABLED ? polySigmoid(x) : 1 / (1 + Math.exp(-x));
}

/**
 * Expected score under the 1PL ICC: P(correct) = σ(θ - b).
 * Exposed so the credit-assignment layer (mastery/state.ts) can read p(L_k)
 * from θ̂ without re-deriving the logistic.
 */
export function expectedScore(theta: number, b: number): number {
  return logistic(theta - b);
}

/**
 * Project θ̂ (logit) → a 0..1 number = σ(θ̂) = expectedScore(θ̂, 0): the 1PL
 * p(correct) at the neutral logit origin b=0. Cold start θ̂=0 → 0.5; θ̂>0 → >0.5;
 * monotone; strictly in (0,1). Point estimate only — no confidence interval.
 *
 * ⚠️ SUPERSEDED AS THE DISPLAY MASTERY NUMBER (YUK-420). This σ(θ̂)@b=0 form was
 *   the INTERIM mastery projection (it ignored item difficulty b and the PFA
 *   success/fail history). The B1 FULL path replaced it: the live display / AI-
 *   facing mastery number is now the **difficulty-aware PFA p(L)** computed in
 *   `getMasteryProjection` (src/server/mastery/state.ts) via `pfaLogit` /
 *   `pLearnedBand` (src/core/pfa.ts) — conditioned on the KC's representative
 *   item difficulty β AND the PFA success/fail counts, plus an ADR-0035
 *   confidence-interval band. `thetaToMastery` is retained as the bare σ(θ̂)
 *   helper (callers that want the b=0 ability projection, or tests that pin the
 *   old interim form, may still use it), but it is NO LONGER what any read
 *   surface shows as "mastery".
 */
export function thetaToMastery(thetaHat: number): number {
  return expectedScore(thetaHat, 0);
}

export interface EloKConfig {
  /** 冷启段步长（前 coldStartN 次）。logit 尺度，占位待标定。 */
  kCold?: number; // default 0.4
  /** 稳态步长下限——非平稳保护，永不衰到 0（VERIFY:elo-k-schedule 选项A）。 */
  kFloor?: number; // default 0.12
  /** 冷启段长度——此段 θ̂ 由 LLM 先验主导，K 大，最不该衰（VERIFY 第4点）。 */
  coldStartN?: number; // default 4
}

/**
 * K 因子：冷启段返回 kCold，之后返回 kFloor（有界，不单调衰减）。
 * 禁用 1/√(evidence_count)（VERIFY:elo-k-schedule REFUTED）。
 */
export function eloK(evidenceCount: number, cfg: EloKConfig = {}): number {
  const kCold = cfg.kCold ?? 0.4;
  const kFloor = cfg.kFloor ?? 0.12;
  const coldStartN = cfg.coldStartN ?? 4;
  return evidenceCount < coldStartN ? kCold : kFloor;
}

/**
 * 单 KC θ̂ 更新：(θ, b, outcome, k, weight?) → newθ。
 * weight = credit-assignment 责任权重（多 KC 分摊，VERIFY:multi-kc）+ 弱锚降权
 * （difficulty_proxy 时 ×0.3，VERIFY:difficulty-logit-map）。default 1。
 * b 是入参常量——此函数无任何回写 b 的出口（G4）。
 */
export function updateTheta(
  theta: number,
  b: number,
  outcome: 0 | 1,
  k: number,
  weight = 1,
): number {
  const expected = expectedScore(theta, b); // 1PL ICC: P = σ(θ - b)
  return theta + k * weight * (outcome - expected);
}

/**
 * Conjunctive (DINA-style, PARAMETER-FREE) item-level success probability:
 *   P_item = ∏_j σ(θ_j − b)
 *
 * The probability a learner answers a multi-KC question correctly when the question
 * requires ALL of its KCs (conjunctive / DINA with slip=guess=0). This is the SINGLE
 * TRUTH SOURCE for the item product used in BOTH (a) conjunctiveCredits' wrong-branch
 * odds and (b) the V-A1-fwd multi-KC forward predictor (YUK-463) — so the harness scores
 * multi-KC attempts with the EXACT same conjunctive probability the live credit path uses.
 *
 * ⚠ n=1 RED LINE: this is the PARAMETER-FREE conjunctive (s=g=0). θ_j are the single
 *   learner's own per-KC effective abilities (sufficient statistics) and b is the
 *   owner/loader item-difficulty anchor — BOTH already live on the credit path, neither a
 *   fitted cross-examinee parameter. It NEVER introduces DINA's slip/guess (those are
 *   cross-examinee parameters → INADMISSIBLE under the n=1 litmus). Zero new estimated
 *   parameters.
 */
export function conjunctiveItemProb(thetas: number[], b: number): number {
  return thetas.map((t) => expectedScore(t, b)).reduce((acc, p) => acc * p, 1);
}

/**
 * 多 KC 合取 credit-assignment（owner 拍板 MLE，review SF-1 修复）。
 *
 * 一道挂多 KC 的题产生 ONE outcome，多个 θ_k 要更新 = credit assignment。模型取
 * 合取（conjunctive / DINA 式「需要所有 KC 才做对」）：P_item = ∏ σ(θ_j − b)。
 * 返回每 KC 的 credit 项（log 似然对 θ_k 的梯度，无量纲），caller 各乘自己的 K
 * （+ bWeight）。
 *
 *   correct (x=1): credit_k = (1 − p_k)
 *   wrong   (x=0): credit_k = −(1 − p_k) · P_item/(1 − P_item)
 *
 * (1−p_k) 灵敏度 ⇒ 最弱的 KC 双向都动最多（owner 拍的 MLE）。题目级 surprise
 * 因子 (outcome−P_item 的等价) 取代了旧的 per-KC 残差 (outcome−p_k)——后者在
 * 两端自我抵消，导致「已诊断为弱的 KC 答错几乎不降」（与意图反向，review SF-1）。
 *
 * n=1 精确退化为标准 Elo：correct→(1−p)=(x−p)，wrong→−p=(x−p)。
 *
 * 数值守护：wrong 分支 odds 比 P_item/(1−P_item) 在全强 KC（P_item→1）时是大
 * surprise，自然趋向 normalized blame（量级 ≤ 1），但 float 下 P_item 舍入到 1.0
 * 会让 odds 爆掉——故 (a) 分母 floor 1e-9，(b) 每 KC credit 量级 clamp 到 1（一次
 * 意外 miss 不该比一次自信 correct 移动 θ̂ 更多）。
 */
export function conjunctiveCredits(thetas: number[], b: number, outcome: 0 | 1): number[] {
  const ps = thetas.map((t) => expectedScore(t, b));
  if (ps.length <= 1) {
    // 单 KC（或空）→ 标准 Elo credit (outcome − p)。
    return ps.map((p) => outcome - p);
  }
  if (outcome === 1) {
    return ps.map((p) => 1 - p);
  }
  // wrong: −(1−p_k) · P_item/(1−P_item)，clamp 量级 ≤ 1。
  const pItem = conjunctiveItemProb(thetas, b); // ∏ σ(θ_j − b), single truth source.
  const odds = pItem / Math.max(1 - pItem, 1e-9);
  return ps.map((p) => Math.max(-(1 - p) * odds, -1));
}

/**
 * difficulty(1-5) → logit b 兜底映射。
 * ⚠️ 占位、非真值（VERIFY:difficulty-logit-map REFUTED「每档1logit任意」）:
 *   序数当 interval，斜率无标定来源。caller 必须配 source='difficulty_proxy'
 *   + 降权 w≈0.3，并优先 item_calibration.b。scale 待 fixed-anchor 慢热校准。
 */
export function difficultyToLogitB(difficulty: number, scale = 0.85): number {
  return (difficulty - 3) * scale;
}

/** 弱锚（difficulty_proxy）的更新降权——VERIFY:difficulty-logit-map 选项2。 */
export const DIFFICULTY_PROXY_WEIGHT = 0.3;

// ─────────────────────────────────────────────────────────────────────────────
// A2 (YUK-434) — Hierarchical Elo on the θ̂ credit hot path.
//
// Split the single per-KC online θ̂ into TWO layers:
//   θ_global(domain)  — a PER-DOMAIN learner-ability anchor (one row per domain
//                       the learner has touched), drifts SLOWLY.
//   θ_KC (= theta_hat) — a per-KC OFFSET on top of the domain anchor.
// Effective ability for a KC = θ_global(domain-of-KC) + θ_KC.
//   P(correct) = σ(effective − b).
//
// MAIN PAYOFF — per-domain cold-start inheritance: a never-seen KC has θ_KC = 0
//   (the DB default for a fresh mastery_state row), so its effective ability is
//   exactly θ_global of ITS domain. A learner who is strong in a domain starts a
//   new KC of that domain ABOVE the logit origin instead of cold at 0.
//
// HONEST framing: the predictive gain over single Elo is SMALL (per-concept and
//   global ability correlate ~0.6). This is built for (a) per-domain new-KC
//   cold-start inheritance, and (b) the structural scaffold for interpretable
//   per-KC mastery (the θ_KC offset) that later KG-borrowing approaches (A5/A6)
//   lean on — NOT a predictive jump.
//
// FLAG: HIERARCHICAL_ELO_ENABLED gates the whole thing as a module-level const
//   (mirrors SRT_ENABLED / DIFFICULTY_PROXY_WEIGHT — NO config table, NO env).
//   Default FALSE this PR = ship dark. When false, θ_global is treated as
//   identically 0: the per-KC path is BYTE-IDENTICAL to today (theta_hat IS the
//   ability, no global row is read or written). When true, the two-layer path runs.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Master flag for hierarchical (two-layer θ_global + θ_KC) Elo on the credit
 * path. **LIVE default true (P1 go-live, YUK-361 step 1 — flipped from dark-ship).**
 *
 * true (DEFAULT now) → effective ability = θ_global(domain-of-KC) + θ_KC feeds
 *   expectedScore / conjunctiveCredits; θ_KC updates as today (now an offset), and
 *   θ_global drifts slowly (ELO_K_GLOBAL) once per touched domain per attempt.
 * false → θ_global ≡ 0; effective ability == θ_KC == single-layer theta_hat. No
 *   per-domain global row is read or written. The θ̂ update + the selection read
 *   paths are BYTE-IDENTICAL to single-layer Elo. STILL A VALID BEHAVIOUR (the
 *   off path) — exercised by the explicit-false regression anchors in
 *   state.db.test.ts (hierFlag.value=false, toBe byte-identical), NOT deleted.
 *
 * Composes orthogonally with SRT_ENABLED: SRT modulates the per-KC credit VALUE;
 * this flag modulates the θ INPUT that feeds the credit. All four combinations
 * are well-defined (srtOutcome / eloK / precision math are untouched by A2).
 */
export const HIERARCHICAL_ELO_ENABLED = true;

/**
 * Global-layer Elo step (≈ 0.4 × the eloK floor 0.12). θ_global is a SLOW-moving
 * per-domain anchor — it should integrate ability across many KCs/attempts, not
 * chase a single item the way the per-KC offset does. A small fixed step keeps the
 * domain anchor stable while the per-KC θ_KC offset absorbs item-level surprise.
 * Owner-tunable; deliberately well below eloK's kFloor (0.12) so the global layer
 * drifts SLOWER than the per-KC layer (asserted in state.db.test.ts).
 */
export const ELO_K_GLOBAL = 0.048;

// ─────────────────────────────────────────────────────────────────────────────
// A1 (YUK-433) — SRT (Signed Residual Time) scoring on the θ̂ credit hot path.
//
// Maris & van der Maas (2012): the *signed residual time* is a sufficient
// statistic for θ in a speed-accuracy IRT model. Under their construction the
// per-item time-limit d plays the role of the 2PL discrimination a — but a is
// un-estimable per-examinee, so we collapse it into an owner-controlled DESIGN
// CONSTANT d (same 2PL family as the current locked-b Elo: zero cross-examinee
// variance, d is a fixed feature of the item, not a fitted parameter).
//
// CONSERVATIVE route (this PR): we do NOT rewrite the SRT likelihood. We replace
// the BINARY {0,1} `outcome` that feeds the existing `outcome − p` Elo credit
// with a CONTINUOUS time-aware analog `srtOutcome ∈ [0,1]`. Everything downstream
// (eloK, bWeight, conjunctive credit-assignment, precision/Fisher) is untouched.
//
// FLAG: SRT_ENABLED gates the whole thing as a module-level constant (mirrors the
//   DIFFICULTY_PROXY_WEIGHT module-const pattern above — NO config table, NO env).
//   Default false this PR = ship dark; flip in a follow-up once response-time data
//   has accumulated. When false the θ̂ math is BYTE-IDENTICAL to today.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Master flag for SRT scoring on the θ̂ credit path. **LIVE default true (P1
 * go-live, YUK-361 step 1 — flipped from dark-ship).**
 *
 * true (DEFAULT now) → WHEN a response time is available AND d resolves → the
 *   continuous srtOutcome drives the credit. Missing-RT still falls back to binary
 *   even when true (paper path / solo attempts lacking RT → binary, unchanged).
 * false → the hot path uses the pure binary outcome exactly as before (the
 *   srtOutcome / conjunctiveCreditsContinuous code is never reached → bit-identical).
 *   STILL A VALID BEHAVIOUR (the off path) — exercised by the explicit-false
 *   regression anchors in state.db.test.ts (srtFlag.value=false, NO-OP byte-identical
 *   to binary), NOT deleted.
 *
 * Phase-deferred (still open): a YUK-433 follow-up replaces resolveSrtTimeLimit's
 * population-seeded d (a population constant, identical across examinees) with a
 * per-KC rolling RT quantile once per-KC RT accumulates (see YUK-449).
 */
export const SRT_ENABLED = true;

/**
 * Minimum-signal floor for the residual-time fraction (Cursor Bugbot HIGH fix).
 *
 * WHY: the raw residual r = clamp((d−t)/d, 0, 1) hits 0 at t ≥ d (any slow answer),
 *   which collapsed BOTH srtOutcome(correct) and srtOutcome(wrong) to exactly 0.5 —
 *   ERASING the correctness sign. A timed-out WRONG answer then moved θ̂ like a slow
 *   CORRECT one (same 0.5−p credit) while fail_count still incremented, and multi-KC
 *   slow-wrong got ZERO penalty at that boundary. A wrong answer must ALWAYS pull θ
 *   below what a correct answer would at the same response time.
 *
 * FIX: floor the EFFECTIVE residual at SRT_MIN_SIGNAL so r_eff ∈ [SRT_MIN_SIGNAL, 1].
 *   The correctness sign survives at every t: correct stays strictly in (0.5, 1],
 *   wrong strictly in [0, 0.5), with a guaranteed gap ≥ SRT_MIN_SIGNAL between them.
 *   Fast (r=1) is unchanged → r_eff=1 → binary anchors 1.0 / 0.0 PRESERVED.
 *
 * In (0,1); 0.15 = a small-but-non-zero floored reward/penalty for slow answers
 * (floored slow-correct = 0.575, floored slow-wrong = 0.425). Owner-tunable.
 */
export const SRT_MIN_SIGNAL = 0.15;

/**
 * A1 (YUK-450) — master flag for the Fisher-conditioned TIME-WEIGHT on the SRT credit.
 * **Default false this PR = ship DARK; flip in a follow-up once RT has accumulated and the
 * time-noise at extreme p has been observed.**
 *
 * WHY: the residual-time signal carries the most θ information when the item difficulty ≈
 *   the learner's current ability (p ≈ 0.5, Rasch Fisher information peak); at p → 0/1 the
 *   outcome is near-certain so RT carries little θ info AND the wall-clock RT is noisier
 *   (more mind-wandering on a too-hard item). Both point to: DOWN-WEIGHT the time term at
 *   extreme p. The weight is w = 4·p(1−p) (peak 1 at p=0.5, → 0 at the extremes), where p is
 *   the model's OWN p(correct) for the item (a function of θ̂ and the locked b anchor —
 *   self-state, n=1 admissible). It does NOT estimate a per-item time-discrimination φ
 *   (a cross-examinee variance component, un-learnable at n=1 — the design red-line).
 *
 * true → the state.ts / replay seam passes timeWeight = 4·pItem·(1−pItem) into srtOutcome.
 * false (DEFAULT) → timeWeight = 1 → srtOutcome is BYTE-IDENTICAL to today (the time term is
 *   never down-weighted). STILL A VALID BEHAVIOUR (the off path) — exercised by the
 *   explicit-false regression anchor in state.db.test.ts, NOT deleted.
 *
 * Composes orthogonally with SRT_ENABLED (gates whether SRT runs at all), HIERARCHICAL_ELO
 * (gates the θ INPUT), and SRT_D_FROM_QUANTILE (gates the d SCALE). This flag gates only the
 * time-term WEIGHT, never the binary correctness sign (a wrong answer always pulls θ below a
 * correct one — the SRT_MIN_SIGNAL floor still holds at every weight).
 */
export const SRT_FISHER_WEIGHT_ENABLED = false;

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * SRT outcome-analog ∈ [0,1] that slots into the existing `outcome − p` credit form.
 *
 * `d` = per-item time-limit (the 2PL discrimination design constant), `t` = the
 * examinee's response time. BOTH IN THE SAME UNIT (seconds — see resolveSrtTimeLimit
 * + the ms→s conversion at the state.ts wiring seam). Residual-time fraction:
 *
 *   r     = clamp((d − t) / d, 0, 1)            // fast t→0 ⇒ r→1; slow t≥d ⇒ r=0
 *   r_eff = SRT_MIN_SIGNAL + (1 − SRT_MIN_SIGNAL)·r   // floored ⇒ r_eff ∈ [floor, 1]
 *
 *   correct: 0.5 + 0.5·r_eff   wrong: 0.5 − 0.5·r_eff
 *
 * CONSERVATIVE / BOUNDED — the flag-on outcome NEVER exceeds the binary magnitude,
 * and the floor guarantees the correctness sign is NEVER erased (Bugbot HIGH fix):
 *   - fast-correct (r=1, r_eff=1) → 1.0  == binary correct (regression anchor)
 *   - slow-correct (r=0, r_eff=floor) → 0.5 + 0.5·floor  >  0.5 (small reward, NOT 0.5)
 *   - fast-wrong   (r=1, r_eff=1) → 0.0  == binary wrong (regression anchor)
 *   - slow-wrong   (r=0, r_eff=floor) → 0.5 − 0.5·floor  <  0.5 (small penalty, NOT 0.5)
 * INVARIANT (all t≥0): srtOutcome(true) − srtOutcome(false) ≥ SRT_MIN_SIGNAL·timeWeight, so a
 * wrong answer ALWAYS pulls θ below what a correct answer would at the same response time
 * (whenever timeWeight > 0). fast-correct moves θ MORE than slow-correct, fast-wrong is
 * penalised HARDER than slow-wrong, all inside the binary [0,1] envelope.
 *
 * A1 (YUK-450) — `timeWeight ∈ [0,1]` (DEFAULT 1) is the Fisher-conditioned weight on the
 * TIME component (see SRT_FISHER_WEIGHT_ENABLED). It shrinks the effective residual toward
 * the pure-binary endpoint as it → 0, fading the time term at extreme-p items while keeping
 * the correctness sign. timeWeight = 1 ⇒ output BYTE-IDENTICAL to the pre-YUK-450 srtOutcome
 * for every (correct, d, t); timeWeight = 0 ⇒ correct → 1.0 / wrong → 0.0 (pure binary).
 */
export function srtOutcome(correct: boolean, d: number, t: number, timeWeight = 1): number {
  // d ≤ 0 is a config bug (resolveSrtTimeLimit always returns > 0); treat a bad d as "no
  // time signal" → the floored minimum-signal residual (NOT a bare 0.5 — that would re-erase
  // the correctness sign the SRT_MIN_SIGNAL floor exists to protect). Otherwise the effective
  // residual is floored at SRT_MIN_SIGNAL so r_eff ∈ [SRT_MIN_SIGNAL, 1]: even a fully
  // timed-out answer (raw r=0) keeps a minimum correctness signal, so correct and wrong NEVER
  // collapse to the same value (Bugbot HIGH fix). Fast (raw r=1) ⇒ r_eff=1 ⇒ binary anchors
  // 1.0 / 0.0 preserved exactly.
  const rEff =
    d > 0 ? SRT_MIN_SIGNAL + (1 - SRT_MIN_SIGNAL) * clamp01((d - t) / d) : SRT_MIN_SIGNAL;
  // YUK-450 — the Fisher-conditioned time weight shrinks r_eff toward the pure-binary endpoint
  // (r_effW = 1) as timeWeight → 0, fading the TIME component while preserving the correctness
  // sign. Written as the ENDPOINT-EXACT linear interpolation `w·r_eff + (1 − w)` (algebraically
  // `1 − w·(1 − r_eff)`, but the latter is NOT byte-identical to pre-YUK-450: IEEE754
  // `1 − (1 − x) ≠ x` for ~1/3 of doubles, so the `1 − w·(1 − r_eff)` form drifts ~1 ULP from
  // main on the LIVE SRT path at w=1). With this form: timeWeight = 1 (DEFAULT) ⇒ `1·r_eff + 0`
  // = r_eff EXACTLY (×1 and +0 are exact in IEEE754) ⇒ BYTE-IDENTICAL to pre-YUK-450 for every
  // input (incl. the d ≤ 0 guard: r_effW = SRT_MIN_SIGNAL). timeWeight = 0 ⇒ `0 + 1` = 1 ⇒ pure
  // binary. The golden-constant anchor in theta.test.ts guards this byte-identity against main.
  const rEffW = timeWeight * rEff + (1 - timeWeight);
  return correct ? 0.5 + 0.5 * rEffW : 0.5 - 0.5 * rEffW;
}

/**
 * Population-seeded per-item time-limit d (the SRT design constant), IN SECONDS.
 *
 * COLD-START source: a difficulty(1-5)→seconds map. This is a population seed, NOT a
 * fitted parameter — it is owner-controlled and identical across examinees (zero
 * cross-examinee variance, the whole point of collapsing the un-estimable 2PL a into d).
 *
 * Phase-deferred (do NOT build now): a follow-up replaces this with a per-KC rolling
 * RT quantile (e.g. the KC's median/p60 response time) once RT data accumulates — see
 * the YUK-433 follow-up that also flips SRT_ENABLED. Until then every item of a given
 * difficulty shares the seed.
 *
 * NOT stored in / read from kt_json (ADR-0035 red-line: kt_json is a pure persistence
 * sink with zero downstream consumer — d is a pure module constant).
 */
export function resolveSrtTimeLimit(difficulty: number): number {
  // difficulty → allotted seconds. Harder items get more time (monotone). Out-of-range
  // / NaN → the difficulty-3 default. Placeholder magnitudes, owner-tunable.
  const map: Record<number, number> = { 1: 20, 2: 25, 3: 30, 4: 40, 5: 50 };
  const d = map[Math.round(difficulty)];
  return d ?? 30;
}

// ─────────────────────────────────────────────────────────────────────────────
// A1 (YUK-449) — per-KC rolling RT quantile as the SRT design constant d.
//
// The population-seeded resolveSrtTimeLimit above is identical across examinees (zero
// cross-examinee variance — the point of collapsing the un-estimable 2PL a into d), but
// its d is a COARSE seed. This upgrade derives d from the LEARNER'S OWN answered-correct
// response times on that KC: a rolling buffer of the last K correct-attempt RTs, with d =
// the buffer's quantile (median by default). This is n=1 admissible — the quantile is a
// sufficient statistic of the SINGLE learner's own state (self-RT distribution), NOT a
// fitted per-item / cross-examinee parameter. Cold start (too few samples) FALLS BACK to
// the population seed, so the scale anchor never disappears.
//
// FLAG: SRT_D_FROM_QUANTILE gates ONLY the d SOURCE (module const, mirrors SRT_ENABLED — NO
//   config table, NO env). Default false this PR = ship DARK: d stays the population seed,
//   so the θ̂ math is BYTE-IDENTICAL to today. The buffer COLLECTION is NOT gated by this
//   flag — it accumulates live whenever SRT runs (so the data exists to justify the flip
//   later); only the "use the quantile for d" step is deferred behind the flag.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Master flag for deriving the SRT design constant d from the per-KC rolling RT quantile.
 * **Default false this PR = ship DARK; flip in a follow-up once per-KC RT has accumulated and
 * the audit:calibration forward-AUC shows the quantile-d beats the population-seed-d.**
 *
 * true → resolveSrtTimeLimitFromQuantile(buffer, difficulty) is used at the state.ts / replay
 *   seam (buffer ≥ SRT_RT_MIN_N → quantile d; else population seed).
 * false (DEFAULT) → d = resolveSrtTimeLimit(difficulty) exactly as today → θ̂ BYTE-IDENTICAL.
 *   STILL A VALID BEHAVIOUR (the off path) — exercised by the explicit-false regression anchor
 *   in state.db.test.ts, NOT deleted.
 */
export const SRT_D_FROM_QUANTILE = false;

/**
 * Ring-buffer capacity: keep the last K answered-correct response times (ms) per KC. Small
 * (n=1, fast adaptation to the learner's current pace) — owner-tunable.
 */
export const SRT_RT_BUFFER_K = 20;

/**
 * Minimum buffered correct-RT samples before the quantile is trusted as d. Below this the
 * cold-start population seed is used (the quantile of < ~8 samples is too noisy). Owner-tunable.
 */
export const SRT_RT_MIN_N = 8;

/**
 * Which quantile of the per-KC correct-RT buffer becomes d. 0.5 = median (default). p60
 * (0.6) would give a slightly more lenient d (more answers count as "fast"); left as a single
 * owner-tunable knob. In (0,1).
 */
export const SRT_RT_QUANTILE = 0.5;

/**
 * Persisted shape of `mastery_state.rt_correct_ms` — the per-KC rolling correct-RT ring buffer
 * (the last ≤ SRT_RT_BUFFER_K answered-correct response times, in MILLISECONDS, oldest→newest).
 * Object-wrapped (not a bare array) so a future per-difficulty bucketing refinement can extend
 * it without a column reshape. SHADOW persistence — the buffer feeds ONLY the d source when
 * SRT_D_FROM_QUANTILE flips; it never changes theta_hat (the SoT) while the flag is off.
 */
export interface RtCorrectBuffer {
  /** last ≤ SRT_RT_BUFFER_K answered-correct RTs in ms, oldest→newest. */
  samples: number[];
}

/**
 * Exact quantile of a numeric sample (linear interpolation between order statistics, the
 * "type-7" / Excel PERCENTILE convention). EXACT (not the P² streaming estimator): the n=1
 * buffers are tiny (≤ SRT_RT_BUFFER_K), so an honest exact quantile beats a streaming
 * approximation. Returns NaN for an empty input (caller must guard via SRT_RT_MIN_N).
 *
 * @param values unsorted samples (copied + sorted internally; caller's array is not mutated).
 * @param q in [0,1] (clamped).
 */
export function quantile(values: number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, z) => a - z);
  if (sorted.length === 1) return sorted[0];
  const qc = q < 0 ? 0 : q > 1 ? 1 : q;
  const pos = qc * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const frac = pos - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

/**
 * Append one answered-correct response time (ms) to a per-KC ring buffer, keeping the last
 * SRT_RT_BUFFER_K samples (FIFO drop of the oldest). Pure — returns a NEW array, never mutates
 * the input. Non-finite / non-positive samples are dropped (a missing/garbage RT must not
 * pollute the scale). null/undefined buffer → treated as empty.
 */
export function pushRtCorrectSample(
  buffer: number[] | null | undefined,
  sampleMs: number,
): number[] {
  const base = buffer ?? [];
  if (!Number.isFinite(sampleMs) || sampleMs <= 0) return [...base];
  const next = [...base, sampleMs];
  return next.length > SRT_RT_BUFFER_K ? next.slice(next.length - SRT_RT_BUFFER_K) : next;
}

/**
 * Resolve the SRT design constant d (SECONDS) from the per-KC rolling correct-RT buffer,
 * falling back to the population seed when there is not yet enough data (n=1 cold-start anchor
 * never disappears).
 *
 *   buffer has ≥ SRT_RT_MIN_N samples → d = quantile(buffer, SRT_RT_QUANTILE) / 1000 (ms→s).
 *   else (null / too few)             → d = resolveSrtTimeLimit(difficulty)  (population seed).
 *
 * The quantile is computed from the LEARNER'S OWN correct RTs on the KC (self-state) — zero
 * cross-examinee variance, d stays a design constant rather than a fitted a/φ. Samples are ms
 * (the unit responseTimeMs arrives in); d is returned in seconds to match srtOutcome's t.
 * A degenerate quantile (≤ 0 / non-finite — impossible given pushRtCorrectSample's positivity
 * filter, but defensive) also falls back to the seed so d is always a sane positive limit.
 */
export function resolveSrtTimeLimitFromQuantile(
  bufferMs: number[] | null | undefined,
  difficulty: number,
): number {
  if (bufferMs && bufferMs.length >= SRT_RT_MIN_N) {
    const qMs = quantile(bufferMs, SRT_RT_QUANTILE);
    const dSeconds = qMs / 1000;
    if (Number.isFinite(dSeconds) && dSeconds > 0) return dSeconds;
  }
  return resolveSrtTimeLimit(difficulty);
}

/**
 * Continuous variant of conjunctiveCredits: accepts a continuous `outcome ∈ [0,1]`
 * (the srtOutcome) instead of only {0,1}, and reduces BIT-IDENTICALLY to the binary
 * conjunctiveCredits when `outcome` is exactly 0 or 1 (regression anchor).
 *
 * Decomposition (mirrors conjunctiveCredits' two branches, scaled by direction magnitude):
 *   - single KC (or empty): standard residual `outcome − p` (continuous Elo residual).
 *   - multi-KC, outcome ≥ 0.5 (correct-direction): credit_k = (1 − p_k) · m,
 *       m = 2·(outcome − 0.5) ∈ [0,1]  ⇒ m=1 at outcome=1 reproduces the binary (1−p_k).
 *   - multi-KC, outcome < 0.5 (wrong-direction): credit_k = max(−(1−p_k)·odds, −1) · m,
 *       m = 2·(0.5 − outcome) ∈ [0,1]  ⇒ m=1 at outcome=0 reproduces the binary
 *       clamped −(1−p_k)·odds. The (1−p_k) SENSITIVITY (weaker KC moves most) and the
 *       per-KC magnitude clamp are preserved; m only scales the whole vector toward 0
 *       as the answer slows (outcome→0.5 ⇒ m→0 ⇒ no movement).
 *
 * EXACT binary equivalence: for outcome ∈ {0,1} this delegates to conjunctiveCredits so
 * the bytes are identical, not merely close (the regression test asserts `toBe`).
 */
export function conjunctiveCreditsContinuous(
  thetas: number[],
  b: number,
  outcome: number,
): number[] {
  // Bit-identical regression anchor: at the binary endpoints, delegate to the exact
  // same code path the binary hot path uses today.
  if (outcome === 1) return conjunctiveCredits(thetas, b, 1);
  if (outcome === 0) return conjunctiveCredits(thetas, b, 0);

  const ps = thetas.map((t) => expectedScore(t, b));
  if (ps.length <= 1) {
    // 单 KC（或空）→ continuous Elo residual (outcome − p)，与二元 (x − p) 同形。
    return ps.map((p) => outcome - p);
  }
  if (outcome >= 0.5) {
    // correct-direction，magnitude m = 2·(outcome − 0.5) ∈ [0,1]。
    const m = 2 * (outcome - 0.5);
    return ps.map((p) => (1 - p) * m);
  }
  // wrong-direction，magnitude m = 2·(0.5 − outcome) ∈ [0,1]。先按二元算 clamp 后的
  // per-KC blame，再整体乘 m（m=1 时与二元 wrong 分支逐位相同）。
  const m = 2 * (0.5 - outcome);
  const pItem = conjunctiveItemProb(thetas, b); // ∏ σ(θ_j − b), single truth source.
  const odds = pItem / Math.max(1 - pItem, 1e-9);
  return ps.map((p) => Math.max(-(1 - p) * odds, -1) * m);
}

// ─────────────────────────────────────────────────────────────────────────────
// YUK-361 Phase 2 (Urnings-Lite θ 不确定性) — 给点估计 θ̂ 配一个不确定性度量。
//
// Urnings 作不确定性「灵感」、非在线 item-half 更新（ADR-0042 amendment +
// docs/design/2026-06-15-urnings-lite-calibration-amendment.md）。这里只做 θ̂ 的
// Rasch Fisher information 累积，让后续 MFI 能给高不确定 θ 降权。零选题行为变更。
//
// 数学：1PL/Rasch 下 θ 的单观测 Fisher information I(θ) = p(1−p)（b 给定）。
//   多次观测信息可加（独立），故 thetaPrecision 是 Σ I 的累积；θ̂ 的标准误从
//   precision 派生 SE = 1/√(precision)。precision 越大 → SE 越小 → θ̂ 越可信。
//   default precision = 1 让既有行 backfill-safe（弱先验 1 单位信息，SE=1）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rasch/1PL 单观测 Fisher information for θ at item difficulty b：I(θ) = p(1−p)，
 * 其中 p = σ(θ − b)。在 θ == b（p=0.5）时最大 0.25——题难度贴合能力时一次作答
 * 提供最多 θ 信息；θ 远离 b（p→0 或 1）时信息趋 0（题太难/太易，作答几乎不增信）。
 */
export function fisherInformation(theta: number, b: number): number {
  const p = expectedScore(theta, b);
  return p * (1 - p);
}

/**
 * θ̂ 标准误，从累积 precision 派生：SE = 1/√(precision)。**不持久化 SE**——只存
 * precision，SE 由本函数现算（schema 单一真相）。floor 1e-9 防 precision=0 时除零。
 */
export function thetaSe(thetaPrecision: number): number {
  return 1 / Math.sqrt(Math.max(thetaPrecision, 1e-9));
}

/**
 * 累积 θ precision：precision' = precision + weight² · I(θ_before, b)。
 *
 * 用与 θ̂ 在线更新**同一个 b 锚 + 同一 bWeight** 喂信息：weight 是 caller 的
 * bWeight（difficulty_proxy 时 ×0.3 降权 → 弱锚提供的信息也按 weight² 缩水，
 * 信息按权重平方进 Fisher 累积，与加权 MLE 的有效样本量一致）。thetaBefore 是
 * 这次更新前的 θ̂（信息在 θ̂ 移动之前的位置评估，与梯度同步）。
 */
export function updateThetaPrecision(
  thetaPrecision: number,
  thetaBefore: number,
  b: number,
  weight = 1,
): number {
  return thetaPrecision + weight * weight * fisherInformation(thetaBefore, b);
}
