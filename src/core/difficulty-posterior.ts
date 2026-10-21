// YUK-439 (ADR-0043 2026-10-19 Amendment A1–A5) — 先验锚定的 b×θ̂ 联合标定：纯数学层。
//
// ─── 这层做什么 ─────────────────────────────────────────────────────────────
// 每道题的难度先验 b_j ~ N(μ_j, τ_j²)（μ_j = item_calibration.b_anchor，agent 先验；
// τ_j 由 source 经登记在案的固定映射派生，A1）。跨题作答证据（含模型判分、部分得分、
// 非 softmax 来源）以加权伯努利似然 s·log p + (1−s)·log(1−p)（A4）折进后验：
//
//   Q(b) = Σ_e w_e·[s_e·log σ(θ_e − b) + (1−s_e)·log(1−σ(θ_e − b))] − (b−μ_j)²/(2τ_j²)
//
// Q 严格凹（Bernoulli 对数似然 + 二次先验罚项）⇒ 唯一 MAP；Q' 严格单调递减，用二分
// 求根（不振荡/发散）。后验方差取 MAP 处 Laplace 近似 V = 1/(1/τ² + Σ w_e·p_e(1−p_e))
// —— 先验精度垫底 ⇒ V ≤ τ² 结构性
// 成立（A2 收敛条件 1：单调收缩、不超先验方差）。
//
// ─── 识别性（A1，n=1 红线的在线化）──────────────────────────────────────────
// 无锚联合估计被 ADR-0043 原文否决（logit 平移不变）。先验罚项 (b−μ_j)²/2τ_j² 在平移下
// 不再不变（μ_j 是外部固定输入）⇒ 平坦谷变成有唯一 MAP 的谷。识别信息全部来自 agent
// 先验场；数据只能在先验 leash（τ_j² 预算）内挪 b。
//
// ─── 纯度契约 ──────────────────────────────────────────────────────────────
// 本模块无 IO、无 newId/Date.now。同输入 ⇒ 逐位同输出。DB 编排在
// src/server/mastery/joint-calibration.ts。

/** 先验参数：μ（锚 b_anchor）+ τ（登记映射派生的先验标准差）。 */
export interface DifficultyPrior {
  mu: number;
  tau: number;
}

/** 一条作答证据：θ_before 快照（A2 thetaBefore 纪律）+ 连续分数 + 证据权重 w_e。 */
export interface DifficultyEvidencePoint {
  /** 作答时（PRE-attempt）的 θ̂ 快照（该题 primary KC 的 offset θ̂，同既有 theta_snapshot 纪律）。 */
  theta: number;
  /** 分数 ∈ [0,1]（0/1 是特例；部分得分直接进似然，A4）。 */
  score: number;
  /** w_e = 来源权重 × 判分可靠度（caller 按登记规则算好传入）。 */
  weight: number;
}

/**
 * τ 映射（A1「登记在案的固定映射」，owner 可调）。
 *
 * 裁决记录：τ 只按 source 键控，**不**用 item_calibration.confidence 折算——LLM
// * 自述置信是未过校准闸的不确定性，按 ADR-0035 2026-06-20 增补只可作降权参考、
// * 不得当硬置信用；把它乘进 τ 会把自报置信当精度用（违反该增补）。fixed_anchor
// * 是 owner 钦定真值（小 τ 强 leash）；llm_prior 弱锚取大 τ（诚实天花板：BEA 2024
// * LLM 难度 RMSE≈dummy；τ 取得过大 ≈ 弱弹簧退回自由互估，故封顶 2.5）。
 */
export const PRIOR_TAU_BY_SOURCE: Readonly<Record<string, number>> = Object.freeze({
  fixed_anchor: 0.5,
  llm_prior_llasa: 1.5,
  llm_prior: 2.0,
});

/** 未知/其它 source 的兜底 τ（保守：视为最弱锚）。 */
export const PRIOR_TAU_DEFAULT = 2.5;

/** source → τ（登记映射的读取面；YUK-1557 读 posterior_variance 时按同源语义解释）。 */
export function priorTau(source: string | null | undefined): number {
  if (source == null) return PRIOR_TAU_DEFAULT;
  return PRIOR_TAU_BY_SOURCE[source] ?? PRIOR_TAU_DEFAULT;
}

// ─── 证据来源与判分可靠度（A4 登记初值，保守起步）───────────────────────────

/** 作答进入标定的来源标签（A6.3 观测口径同一套词）。 */
export type CalibrationEvidenceSource =
  | 'stream_softmax' // 流内 softmax 选题（有真 π_i）
  | 'due' // 流内到期/确定性放置（无 softmax π）
  | 'solo' // 散题（无 stream_item_id、无容器）
  | 'paper' // 试卷
  | 'worksheet' // 导学案/工作纸
  | 'placement' // 定位评估
  | 'probe' // conjecture 探针（agent 选探题，选择效应最强）
  | 'ingestion'; // 录入判分
// 注：'tutor' 类来源当前没有独立 issuance 容器前缀（Active Teaching 走 teaching_check
// 题源、见 A4 注），落 'solo' 或 'probe'；出现新前缀时在此登记。

/**
 * 来源权重（A4「登记在案初值：低于流内选题，保守起步」）。选择效应越强（学习者/出卷
 * 人/agent 挑题越有偏向）权重越低——这些来源没有 π_i 可 IPW 校正（A4 诚实项），靠权重保守。
 */
export const EVIDENCE_SOURCE_WEIGHT: Readonly<Record<CalibrationEvidenceSource, number>> =
  Object.freeze({
    stream_softmax: 1.0,
    due: 0.8,
    solo: 0.7,
    paper: 0.7,
    worksheet: 0.7,
    placement: 0.7,
    probe: 0.5,
    ingestion: 0.5,
  });

/** 未知来源的兜底权重（保守）。 */
export const EVIDENCE_SOURCE_WEIGHT_UNKNOWN = 0.5;

/** 模型判分路由类（settle 面 plan.judgeRoute 的非确定性类）复判一致率不足时的登记默认可靠度。 */
export const MODEL_ROUTE_DEFAULT_RELIABILITY = 0.6;

/** 判分路由类：'exact' = 全 deterministic 单元；'contract_evaluation' = 含模型执行单元。 */
export type CalibrationJudgeRouteClass = 'exact' | 'contract_evaluation';

/**
 * w_e（A4）：来源权重 × 判分可靠度。
 *   - deterministic（exact）：可靠度 1，不折（A4「deterministic 路由 confidence=1 不折」）。
 *   - 模型判分（contract_evaluation）：可靠度 = 复判一致率（insufficient → 登记默认 0.6）
 *     × judge confidence（缺失按 1；自述置信只降权不升权——乘的是 ≤1 的因子）。
 */
export function evidenceWeight(input: {
  source: string;
  judgeRoute: string | null | undefined;
  judgeConfidence?: number | null;
  /** 路由级复判一致率（live 资产读出；null = 样本不足）。 */
  modelAgreementRate: number | null;
}): number {
  const src = EVIDENCE_SOURCE_WEIGHT[input.source as CalibrationEvidenceSource];
  const sourceWeight = src ?? EVIDENCE_SOURCE_WEIGHT_UNKNOWN;
  if (input.judgeRoute === 'exact') return sourceWeight;
  const agreement = input.modelAgreementRate ?? MODEL_ROUTE_DEFAULT_RELIABILITY;
  const confidence =
    typeof input.judgeConfidence === 'number' && Number.isFinite(input.judgeConfidence)
      ? Math.max(0, Math.min(1, input.judgeConfidence))
      : 1;
  return sourceWeight * agreement * confidence;
}

// ─── 后验更新（A2/A3 核心）─────────────────────────────────────────────────

/** 每批每题 |Δb| 的 damping 上限（A2 收敛条件 2：信任域，防 θ̂↔b 交替正反馈）。 */
export const MAX_ABS_STEP_PER_BATCH = 0.75;

/** Q' 二分求解的迭代上限。Q' 严格单调递减 ⇒ 二分不会振荡/发散。 */
const BISECTION_MAX_ITERS = 120;

/** 数值稳定的 logistic（θ−b 很大时 exp 溢出方向只影响一侧，结果仍为 0/1）。 */
function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Q'(b) = Σ_e w_e·(σ(θ_e−b) − s_e) − (b−μ)/τ²。Q' 严格单调递减，零点即唯一 MAP。 */
function qPrime(
  b: number,
  priorMu: number,
  priorPrecision: number,
  points: readonly DifficultyEvidencePoint[],
): number {
  let grad = -(b - priorMu) * priorPrecision;
  for (const e of points) {
    grad += e.weight * (logistic(e.theta - b) - e.score);
  }
  return grad;
}

export interface DifficultyPosterior {
  /** 后验均值（MAP，信任域 clamp 后的落点）。0 条证据 ⇒ = μ（A3：无 NULL 哨兵）。 */
  bPost: number;
  /** 后验方差（已验证 MAP 处 Laplace；不随信任域 clamp 的 bPost 虚高）。≤ τ²；0 证据 ⇒ τ²。 */
  variance: number;
}

/**
 * 单题后验更新：prior + 全量证据（每批从证据账本全量重算——幂等、对更正友好：
 * 账本行被删/改后下批自然跟随；「方差单调不增」在证据只增时结构性成立，更正打破它
 * 是诚实的例外）。`previousBPost`（上一批落点）存在时施信任域 clamp（A2.2）。
 *
 * 数值守护：score/θ/weight 非有限或 score∉[0,1]、weight<0 → throw（上游 bug，fail-fast）。
 */
export function updateDifficultyPosterior(
  prior: DifficultyPrior,
  evidence: readonly DifficultyEvidencePoint[],
  opts: { previousBPost?: number | null } = {},
): DifficultyPosterior {
  if (!Number.isFinite(prior.tau) || !(prior.tau > 0))
    throw new Error(`updateDifficultyPosterior: tau must be finite and > 0, got ${prior.tau}`);
  if (!Number.isFinite(prior.mu))
    throw new Error(`updateDifficultyPosterior: mu must be finite, got ${prior.mu}`);
  const priorPrecision = 1 / (prior.tau * prior.tau);
  const points: DifficultyEvidencePoint[] = [];
  for (const e of evidence) {
    if (!Number.isFinite(e.theta)) {
      throw new Error(`updateDifficultyPosterior: non-finite theta ${e.theta}`);
    }
    if (!Number.isFinite(e.score) || e.score < 0 || e.score > 1) {
      throw new Error(`updateDifficultyPosterior: score must be finite in [0,1], got ${e.score}`);
    }
    if (!Number.isFinite(e.weight) || e.weight < 0) {
      throw new Error(`updateDifficultyPosterior: weight must be finite >= 0, got ${e.weight}`);
    }
    if (e.weight === 0) continue; // 零权重证据无信息，跳过。
    points.push(e);
  }

  // Q 严格凹、Q' 严格单调递减 ⇒ 用二分求 Q 的唯一零点（MAP）。无阻尼牛顿在
  // θ−b 很大时曲率≈先验精度，步长会越过整段证据区、来回振荡或发散到错侧；二分
  // 只依赖 Q' 的符号，先验主导远处也有有限 bracket。
  const mode = points.length === 0 ? prior.mu : solveMode(prior, priorPrecision, points);

  // 信任域（A2.2）：相对上一批落点的每批 |Δb| 上限。legacy 载入值（b_post 回填自
  // b_calib）也经它逐批收敛进后验——部署时刻读数连续，无一次性跳变。
  let bPost = mode;
  if (typeof opts.previousBPost === 'number' && Number.isFinite(opts.previousBPost)) {
    const delta = mode - opts.previousBPost;
    if (Math.abs(delta) > MAX_ABS_STEP_PER_BATCH) {
      bPost = opts.previousBPost + Math.sign(delta) * MAX_ABS_STEP_PER_BATCH;
    }
  }

  // Laplace 方差在**已验证的 MAP** 取值：V = 1/(1/τ² + Σ w·p(1−p))，结构性 ≤ τ²。
  // 信任域只 clamp 对外落点 bPost；方差不跟着 clamp 点虚高，否则 KB 参照集会误把
  // 证据充分的题当成「先验主导」。
  let curvatureAtMode = priorPrecision;
  for (const e of points) {
    const p = logistic(e.theta - mode);
    curvatureAtMode += e.weight * p * (1 - p);
  }
  return { bPost, variance: 1 / curvatureAtMode };
}

/**
 * 求 Q' 的唯一零点。Q' 严格递减；由 |Q' 的先验项| = Σw(p−s) ≤ Σw 可得
 * |b−μ| ≤ τ²·Σw，故有限 bracket 必然包住根。bracket 反向（浮点边界）时加倍扩展，
 * 扩展失败或有非有限量则 fail-fast，绝不返回未经验证的迭代末值。
 */
function solveMode(
  prior: DifficultyPrior,
  priorPrecision: number,
  points: readonly DifficultyEvidencePoint[],
): number {
  const sumWeight = points.reduce((acc, e) => acc + e.weight, 0);
  if (!Number.isFinite(sumWeight)) {
    throw new Error(`updateDifficultyPosterior: non-finite evidence weight sum ${sumWeight}`);
  }
  let span = prior.tau * prior.tau * sumWeight + 1;
  let lo = prior.mu - span;
  let hi = prior.mu + span;
  for (let expand = 0; expand < 64; expand++) {
    if (!Number.isFinite(span) || !Number.isFinite(lo) || !Number.isFinite(hi)) {
      throw new Error('updateDifficultyPosterior: failed to build a finite MAP bracket');
    }
    const gLo = qPrime(lo, prior.mu, priorPrecision, points);
    const gHi = qPrime(hi, prior.mu, priorPrecision, points);
    if (gLo >= 0 && gHi <= 0) break;
    span *= 2;
    lo = prior.mu - span;
    hi = prior.mu + span;
  }
  if (
    !(qPrime(lo, prior.mu, priorPrecision, points) >= 0) ||
    !(qPrime(hi, prior.mu, priorPrecision, points) <= 0)
  ) {
    throw new Error('updateDifficultyPosterior: failed to bracket the MAP');
  }
  for (let iter = 0; iter < BISECTION_MAX_ITERS; iter++) {
    const mid = lo + (hi - lo) / 2;
    if (mid === lo || mid === hi) return mid;
    const g = qPrime(mid, prior.mu, priorPrecision, points);
    if (g === 0) return mid;
    if (g > 0) lo = mid;
    else hi = mid;
  }
  return lo + (hi - lo) / 2;
}

// ─── 尺度漂移审计（A5：Kolen-Brennan mean/sigma linking，降格为审计 + 越界归一）──

/**
 * 每批每题 |Δb| 分布的中位数/最大值（A2.3 收敛判据 + A6.5 观测）。
 * quantile 用 theta.ts 同一 type-7 约定（这里独立小实现，避免 core 内部互相拉依赖图）。
 */
export function deltaSummary(deltas: readonly number[]): {
  median: number | null;
  max: number | null;
} {
  if (deltas.length === 0) return { median: null, max: null };
  const sorted = [...deltas].sort((a, z) => a - z);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  let max = 0;
  for (const d of sorted) if (Math.abs(d) > Math.abs(max)) max = d;
  return { median, max };
}

/** KB linking 对齐容差（登记初值，owner 可调）：|shift|（logit）与 |slope−1|。 */
export const KB_SHIFT_TOLERANCE = 0.25;
export const KB_SLOPE_TOLERANCE = 0.1;

/** 参照集资格：后验仍由先验主导（证据精度贡献 ≤ 该比例）+ 最小参照集规模。 */
export const REFERENCE_EVIDENCE_PRECISION_FRACTION_MAX = 0.2;
export const REFERENCE_MIN_N = 8;

export interface KbDriftResult {
  n: number;
  /** 平移分量 A：把后验场对回锚尺度（b' = A + B·b）。参照集空/退化 → A=0, B=1。 */
  shift: number;
  /** 尺度分量 B（σ_μ/σ_b；σ_b≈0 退化 → 1）。 */
  slope: number;
  /** 越界（|A| > shift 容差 或 |B−1| > slope 容差）⇒ 触发 A5 归一 + 先验质量调查。 */
  beyondTolerance: boolean;
}

/**
 * Kolen-Brennan mean/sigma linking（A5）：参照集 = 后验仍由先验主导的强锚题（caller
 * 按 REFERENCE_EVIDENCE_PRECISION_FRACTION_MAX 筛选），把 (θ̂, b) 场对回先验锚尺度。
 * 方法：B = σ_μ(ref)/σ_post(ref)，A = mean(μ) − B·mean(b_post)。系统性同向漂移（数据
 * 把整场拖离锚 / 回路自激）在 A 上现形；单位漂移在 B 上现形。
 */
export function kbDrift(reference: readonly { mu: number; bPost: number }[]): KbDriftResult {
  const n = reference.length;
  if (n === 0) return { n: 0, shift: 0, slope: 1, beyondTolerance: false };
  const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
  const std = (xs: number[], m: number) =>
    Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / xs.length);
  const mus = reference.map((r) => r.mu);
  const posts = reference.map((r) => r.bPost);
  const meanMu = mean(mus);
  const meanPost = mean(posts);
  const sigmaPost = std(posts, meanPost);
  const slope = sigmaPost > 1e-9 ? std(mus, meanMu) / sigmaPost : 1;
  const shift = meanMu - slope * meanPost;
  return {
    n,
    shift,
    slope,
    beyondTolerance:
      Math.abs(shift) > KB_SHIFT_TOLERANCE || Math.abs(slope - 1) > KB_SLOPE_TOLERANCE,
  };
}
