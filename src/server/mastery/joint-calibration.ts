// YUK-439 (ADR-0043 2026-10-19 Amendment A1–A6) — 先验锚定的 b×θ̂ 联合标定：批量写者。
//
// ─── 这台机器做什么 ─────────────────────────────────────────────────────────
// 小批 b 后验更新（A2 节奏：nightly `recalibration_nightly` 承载；θ̂ 仍每作答在线 Elo，
// updateThetaForAttempt 路径不变、读 b_post）。批内以每条证据的 θ_before 快照对 θ̂
// 准静态（thetaBefore 纪律）做条件后验更新；θ|b 的另一半交替由在线 θ̂ 在批间自然承担
// （每次作答读新 b_post）——票面验收 4 的「或每次 b 更新后做对齐」选项。
//
// 每题后验从**证据账本全量重算**（幂等；更正/撤销删改账本行后下批自然跟随）：
//   b_post(j) = MAP[ N(μ_j, τ_j²) 先验 + Σ_e w_e·(s_e·log σ(θ_e−b) + (1−s_e)·log(1−σ(θ_e−b))) ]
// 数学在 src/core/difficulty-posterior.ts（纯层）；本模块是 DB 编排 + 写者。
//
// ─── 写者契约（G4 改写后的红线，A3）─────────────────────────────────────────
// b_post / posterior_variance / calibration_n / calibration_weight /
// calibration_source / last_calibrated_at 的批量写只由本模块承担；锚写者
// （applyItemPrior / setFixedAnchor）只在写锚时**初始化**后验（= 先验）；结算
// revert/withdraw 删掉某题最后一条证据后，由 item-calibration.ts
// resetPosteriorToPriorIfNoEvidence 在**同一事务**把该题后验修回先验（否则零证据题
// 不再进批，会永久保留含已撤销作答的后验）。在线 attempt 路径只 READS（effectiveB），
// 从不写 b——b 单写者由标定批保。
//
// ─── A5 尺度漂移审计（Kolen-Brennan mean/sigma linking）──────────────────────
// 每批边界：参照集 = 后验仍由先验主导的强锚题（证据精度贡献 ≤
// REFERENCE_EVIDENCE_PRECISION_FRACTION_MAX），把 (θ̂, b) 场对回先验锚尺度。
// |shift| / |slope−1| 超容差 → θ̂ 与 b 场整体归一回锚尺度（平移分量保预测不变，
// slope 分量是单位修正）+ 触发先验质量调查（日志 flag）。归一是先验锚住整体平移的
// 落点——数据只能把场拖离锚到容差内，越界即拉回。
//
// ─── 红线 ──────────────────────────────────────────────────────────────────
// G1：本模块在 job 顶层调（非 attempt tx 内）→ per-item try/catch 隔离，不加 SAVEPOINT。
// G3：只写 item_calibration 后验列族（+ 归一时的 mastery_state θ̂ / evidence θ 快照 /
//     family b_delta 尺度随动）；never item b / stream / due / 判分。
// G5：候选 JOIN question 排 draft（notDraftPredicate）。

import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  type DifficultyEvidencePoint,
  MAX_ABS_STEP_PER_BATCH,
  REFERENCE_EVIDENCE_PRECISION_FRACTION_MAX,
  REFERENCE_MIN_N,
  deltaSummary,
  evidenceWeight,
  kbDrift,
  priorTau,
  updateDifficultyPosterior,
} from '@/core/difficulty-posterior';
import type { Db } from '@/db/client';
import { notDraftPredicate } from '@/db/predicates';
import { difficulty_calibration_evidence, event, item_calibration, question } from '@/db/schema';
import { acquireLearningStateWriteLock } from '@/server/advisory-locks';
import { attemptLocalDate } from './recalibration';

// ─────────────────────────────────────────────────────────────────────────────
// 模型判分路由级复判一致率（A4 w_e 的 agreement 因子）。
//
// live 资产：nightly judge-calibration sampler 写的 experimental:judge_calibration_sample
// 观测事件（practice 包 job）+ /api/admin/judge-calibration agreement 读面。此处按
// **bit 一致率**（correct/incorrect 二分位一致——标定证据消费的正是分数方向）在模型
// 路由（legacy JudgeKind 里非 objective 的路由）上聚合；same_lane 样本（同 lane 自一致，
// 非对照）排除——与观测读面同纪律。样本 < MIN_N → null（批时落登记默认 0.6，
// MODEL_ROUTE_DEFAULT_RELIABILITY）。
//
// 读 seam 说明：payload 形状归 practice 的 sampler job 所有；本处是最小只读聚合
//（与 admin 读面同一事件源、不同投影——那边带 notes/近期样本，这边只要一个比率），
// 不拉 observability 包依赖（capability 边界）。
// ─────────────────────────────────────────────────────────────────────────────
const JUDGE_SAMPLE_ACTION = 'experimental:judge_calibration_sample';
const JUDGE_SAMPLE_WINDOW_DAYS = 90;
const JUDGE_SAMPLE_MIN_N = 5;
/** 模型判分路由（legacy JudgeKind 里非 objective 的族；rejudge_route 的值域）。 */
const MODEL_REJUDGE_ROUTES = new Set([
  'semantic',
  'steps',
  'multimodal_direct',
  'unit_dimension',
  'ai_flexible',
]);

/** 模型路由族的整体 bit 一致率；样本不足 → null。 */
export async function loadModelAgreementRate(db: Db): Promise<number | null> {
  const windowStart = new Date(Date.now() - JUDGE_SAMPLE_WINDOW_DAYS * 24 * 3600 * 1000);
  const rows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(and(eq(event.action, JUDGE_SAMPLE_ACTION), gte(event.created_at, windowStart)));
  let n = 0;
  let bitAgreed = 0;
  for (const row of rows) {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    if (p.same_lane_suspected === true) continue;
    if (typeof p.rejudge_route !== 'string' || !MODEL_REJUDGE_ROUTES.has(p.rejudge_route)) continue;
    if (typeof p.bit_agreed !== 'boolean') continue;
    n++;
    if (p.bit_agreed) bitAgreed++;
  }
  return n >= JUDGE_SAMPLE_MIN_N ? bitAgreed / n : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 批结果（A6 可观测性指标随批产出；job 顶层 console.log 出口）。
// ─────────────────────────────────────────────────────────────────────────────
export interface JointCalibrationBatchResult {
  /** 本轮候选题数（capped by maxPerRun）。 */
  considered: number;
  /** 成功重算并写后验的题数。 */
  recalibrated: number;
  /** 候选中无锚（b_anchor/b 皆缺）跳过的题数。 */
  skipped_no_anchor: number;
  /** 单题重算抛错被跳过（不阻断其余题）。 */
  skipped_failed: number;
  /** 本批 Δb（相对上一批落点/锚）中位数/最大值（A2.3 收敛判据；logit）。 */
  delta_median: number | null;
  delta_max: number | null;
  /** KB 漂移审计：参照集大小 / 平移 A / 斜率 B / 是否越界。 */
  kb_reference_n: number;
  kb_shift: number;
  kb_slope: number;
  /** 越界 ⇒ 已执行归一（A5）并 flag 先验质量调查。 */
  kb_renormalized: boolean;
  /** A6.1：已离开先验（|b_post − b_anchor| > τ_j）的题数 / 有锚题总数。 */
  items_left_prior: number;
  items_with_anchor: number;
  /** A6.2：calibration_n>0 题上 |b_post − b_anchor| 的均值与分位数。 */
  abs_delta_mean: number | null;
  abs_delta_p50: number | null;
  abs_delta_p90: number | null;
  abs_delta_max: number | null;
  /** A6.3：证据账本按来源 × 判分路由类的条数（全表）。 */
  evidence_by_source: Record<string, number>;
  evidence_model_judged: number;
  evidence_total: number;
}

const DEFAULT_MAX_PER_RUN = 2000;

/**
 * A5 参照集位置 leash：|b_post − μ| > 3τ 的题不作为「先验主导的强锚」。
 * 旧求解器的发散行会把自己的方差报成 ≈τ²，只按方差筛会把它们当参照点、把整场
 * θ̂/b_post 平移；位置 leash 是方差筛之外的第二道守卫（正常先验主导题在 1–2τ 内）。
 */
const REFERENCE_MAX_ABS_DELTA_TAU = 3;

/** 候选窗起点：昨日本地日（Asia/Shanghai）零点（同旧 nightly 的 empty-today 防护）。 */
function candidateWindowStart(now: Date): Date {
  const yesterdayLocal = attemptLocalDate(new Date(now.getTime() - 24 * 3600 * 1000));
  return new Date(`${yesterdayLocal}T00:00:00+08:00`);
}

type DepsOverride = {
  /** 测试/重放注入固定 now；默认 new Date()。 */
  now?: Date;
  /** 每轮最多重算多少题。default 2000（全量重算是内存牛顿，SQL 才是成本）。 */
  maxPerRun?: number;
};

function quantileOf(sortedAsc: number[], q: number): number | null {
  if (sortedAsc.length === 0) return null;
  const pos = Math.min(1, Math.max(0, q)) * (sortedAsc.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

/**
 * 一轮联合标定批：候选预筛 → 逐题后验重算 + 写 → KB 漂移审计（越界归一）→ A6 指标。
 *
 * 候选 = 有任何 evidence 的非 draft 题，且（昨日起窗内新证据 OR calibration_n ≠ 当前
 * 证据行数 OR calibration_source 尚非 'joint'——首跑兜住 migration 回填的全部存量）。
 * 幂等：joint 且 n 一致且无新证据 ⇒ 不入选。
 */
export async function runJointCalibrationBatch(
  db: Db,
  deps: DepsOverride = {},
): Promise<JointCalibrationBatchResult> {
  const now = deps.now ?? new Date();
  const maxPerRun = deps.maxPerRun ?? DEFAULT_MAX_PER_RUN;
  const windowStart = candidateWindowStart(now);
  const agreementRate = await loadModelAgreementRate(db);

  // 1. 候选（结构同旧 nightly：GROUP BY + HAVING；LEFT JOIN miss ⇒ stale，正确纳入
  //    有证据但无 calibration 行的题）。
  const candidates = await db
    .select({ questionId: difficulty_calibration_evidence.question_id })
    .from(difficulty_calibration_evidence)
    .innerJoin(question, eq(question.id, difficulty_calibration_evidence.question_id))
    .leftJoin(
      item_calibration,
      and(
        eq(item_calibration.question_id, difficulty_calibration_evidence.question_id),
        eq(item_calibration.track, 'hard'),
      ),
    )
    .where(notDraftPredicate(question.draft_status))
    .groupBy(difficulty_calibration_evidence.question_id)
    .having(
      sql`(
        max(${difficulty_calibration_evidence.created_at}) >= ${windowStart.toISOString()}::timestamptz
        OR coalesce(max(${item_calibration.calibration_n}), 0) <> count(${difficulty_calibration_evidence.id})
        OR bool_or(${item_calibration.calibration_source} IS DISTINCT FROM 'joint')
      )`,
    )
    .limit(maxPerRun);

  const candidateIds = candidates.map((c) => c.questionId);
  const result: JointCalibrationBatchResult = {
    considered: candidates.length,
    recalibrated: 0,
    skipped_no_anchor: 0,
    skipped_failed: 0,
    delta_median: null,
    delta_max: null,
    kb_reference_n: 0,
    kb_shift: 0,
    kb_slope: 1,
    kb_renormalized: false,
    items_left_prior: 0,
    items_with_anchor: 0,
    abs_delta_mean: null,
    abs_delta_p50: null,
    abs_delta_p90: null,
    abs_delta_max: null,
    evidence_by_source: {},
    evidence_model_judged: 0,
    evidence_total: 0,
  };
  if (candidateIds.length === 0) {
    await auditAndMaybeRenormalize(db, result, now);
    await collectEvidenceMix(db, result);
    return result;
  }

  // 2. 批量取证据 + 现行标定行（每题一次内存牛顿，无 per-item 读放大）。
  const evidenceRows = await db
    .select()
    .from(difficulty_calibration_evidence)
    .where(inArray(difficulty_calibration_evidence.question_id, candidateIds));
  const calRows = await db
    .select({
      question_id: item_calibration.question_id,
      b: item_calibration.b,
      b_anchor: item_calibration.b_anchor,
      b_post: item_calibration.b_post,
      source: item_calibration.source,
    })
    .from(item_calibration)
    .where(
      and(inArray(item_calibration.question_id, candidateIds), eq(item_calibration.track, 'hard')),
    );
  const calByQuestion = new Map(calRows.map((r) => [r.question_id, r]));
  const evidenceByQuestion = new Map<string, typeof evidenceRows>();
  for (const row of evidenceRows) {
    const list = evidenceByQuestion.get(row.question_id) ?? [];
    list.push(row);
    evidenceByQuestion.set(row.question_id, list);
  }

  // 3. 逐题后验重算 + 写（per-item try/catch，G1）。
  const deltas: number[] = [];
  for (const questionId of candidateIds) {
    try {
      const cal = calByQuestion.get(questionId) ?? null;
      const mu = cal?.b_anchor ?? cal?.b ?? null;
      if (mu === null || cal === null) {
        result.skipped_no_anchor++;
        continue;
      }
      const tau = priorTau(cal.source);
      const rows = evidenceByQuestion.get(questionId) ?? [];
      const points: DifficultyEvidencePoint[] = rows.map((r) => ({
        theta: r.theta_snapshot,
        score: r.score,
        weight: evidenceWeight({
          source: r.evidence_source,
          judgeRoute: r.judge_route,
          judgeConfidence: r.judge_confidence,
          modelAgreementRate: agreementRate,
        }),
      }));
      // 信任域是**每批边界**的 damping（θ̂ 在批间才动——θ̂↔b 交替的环路在批间）；批内
      // θ 准静态、后验由全量证据+固定 θ 快照重算（无 ratchet、无自激），故在批内迭代到
      // 信任域不再 bind（≤24 步内_guard）。若不迭代，首批被 clamp 的题会因
      // calibration_n == 证据数而不再进 stale 集——收敛被冻结在锚 ± 上限处。
      let previousBPost: number | null = cal.b_post;
      let posterior = updateDifficultyPosterior({ mu, tau }, points, {
        previousBPost,
      });
      for (let i = 0; i < 24; i++) {
        if (Math.abs(posterior.bPost - (previousBPost ?? mu)) < MAX_ABS_STEP_PER_BATCH) break;
        previousBPost = posterior.bPost;
        posterior = updateDifficultyPosterior({ mu, tau }, points, { previousBPost });
      }
      deltas.push(posterior.bPost - (cal.b_post ?? mu));
      await db
        .update(item_calibration)
        .set({
          b_post: posterior.bPost,
          posterior_variance: posterior.variance,
          calibration_n: rows.length,
          calibration_weight: 1 / posterior.variance,
          calibration_source: 'joint',
          last_calibrated_at: now,
          updated_at: now,
        })
        .where(
          and(eq(item_calibration.question_id, questionId), eq(item_calibration.track, 'hard')),
        );
      result.recalibrated++;
    } catch (err) {
      console.error('[joint_calibration] question posterior update failed', { questionId, err });
      result.skipped_failed++;
    }
  }
  const summary = deltaSummary(deltas);
  result.delta_median = summary.median;
  result.delta_max = summary.max;

  // 4. KB 漂移审计 + 越界归一（A5），然后 A6 全局指标。
  await auditAndMaybeRenormalize(db, result, now);
  await collectEvidenceMix(db, result);
  return result;
}

/** A5：全量 hard 行上筛参照集 → KB linking → 越界则归一（θ̂ / b_post / θ 快照 / family delta）。 */
async function auditAndMaybeRenormalize(
  db: Db,
  result: JointCalibrationBatchResult,
  now: Date,
): Promise<void> {
  const rows = await db
    .select({
      question_id: item_calibration.question_id,
      b_anchor: item_calibration.b_anchor,
      b_post: item_calibration.b_post,
      posterior_variance: item_calibration.posterior_variance,
      calibration_n: item_calibration.calibration_n,
      source: item_calibration.source,
    })
    .from(item_calibration)
    .where(eq(item_calibration.track, 'hard'));

  // A6.1/A6.2 全局指标（同一遍扫描算出，避免第二个全表 pass）。
  let leftPrior = 0;
  const absDeltas: number[] = [];
  for (const r of rows) {
    const mu = r.b_anchor ?? null;
    if (mu === null) continue;
    result.items_with_anchor++;
    const tau = priorTau(r.source);
    const bPost = r.b_post ?? mu;
    if (Math.abs(bPost - mu) > tau) leftPrior++;
    if (r.calibration_n > 0) absDeltas.push(Math.abs(bPost - mu));
  }
  result.items_left_prior = leftPrior;
  const sortedAbs = [...absDeltas].sort((a, z) => a - z);
  result.abs_delta_mean =
    sortedAbs.length > 0 ? sortedAbs.reduce((a, x) => a + x, 0) / sortedAbs.length : null;
  result.abs_delta_p50 = quantileOf(sortedAbs, 0.5);
  result.abs_delta_p90 = quantileOf(sortedAbs, 0.9);
  result.abs_delta_max = sortedAbs.length > 0 ? sortedAbs[sortedAbs.length - 1] : null;

  // 参照集：证据精度贡献 ≤ 上限（后验仍由先验主导）。
  const reference: Array<{ mu: number; bPost: number }> = [];
  for (const r of rows) {
    const mu = r.b_anchor ?? null;
    if (mu === null) continue;
    const tau = priorTau(r.source);
    const bPost = r.b_post ?? mu;
    if (!Number.isFinite(bPost)) continue;
    if (Math.abs(bPost - mu) > REFERENCE_MAX_ABS_DELTA_TAU * tau) continue;
    const variance = r.posterior_variance ?? tau * tau; // 未标定 ⇒ 先验方差 ⇒ 主导。
    if (!Number.isFinite(variance) || variance <= 0) continue;
    const evidenceFraction = 1 - variance / (tau * tau);
    if (evidenceFraction <= REFERENCE_EVIDENCE_PRECISION_FRACTION_MAX) {
      reference.push({ mu, bPost });
    }
  }
  const drift = kbDrift(reference);
  result.kb_reference_n = drift.n;
  result.kb_shift = drift.shift;
  result.kb_slope = drift.slope;
  if (drift.n < REFERENCE_MIN_N || !drift.beyondTolerance) return;

  // 越界归一（A5）：x → A + B·x 作用于 θ̂ 场、b_post 场、证据 θ 快照（批间一致性——
  // 历史快照若留在旧尺度会污染下批似然）；family b_delta 是加性 offset，只乘 B 不平移
  // （b+delta 在 x→A+B·x 下要求 delta→B·delta 才保复合读）。
  // 平移分量保预测不变（θ−b 不变）；slope 分量是单位修正（改变预测是越界修正的本意）。
  //
  // mastery_state 分两层：effective θ = θ_KC(knowledge 行) + θ_global(ability_global 行)
  // （state.ts）。复合量只应整体加一次 A：knowledge 行取 A + B·x，ability_global 行只乘
  // B（B·o + B·g = B·θ_eff）。两层都加 A 会把 θ_eff 双加 shift，恰好在本路径触发时
  // 破坏「归一保 θ−b 不变」。
  // 先验质量调查 flag：日志出口（owner 读批日志/后续接 Linear）。
  const A = drift.shift;
  const B = drift.slope;
  console.warn(
    '[joint_calibration] KB drift beyond tolerance — renormalizing scale to prior anchors + FLAG prior-quality investigation',
    { referenceN: drift.n, shift: A, slope: B },
  );
  await db.transaction(async (tx) => {
    await acquireLearningStateWriteLock(tx);
    await tx.execute(
      sql`UPDATE mastery_state SET theta_hat = ${A}::double precision + ${B}::double precision * theta_hat, updated_at = ${now.toISOString()}::timestamptz WHERE subject_kind = 'knowledge'`,
    );
    await tx.execute(
      sql`UPDATE mastery_state SET theta_hat = ${B}::double precision * theta_hat, updated_at = ${now.toISOString()}::timestamptz WHERE subject_kind = 'ability_global'`,
    );
    await tx.execute(
      sql`UPDATE item_calibration SET b_post = ${A}::double precision + ${B}::double precision * b_post, updated_at = ${now.toISOString()}::timestamptz WHERE b_post IS NOT NULL AND track = 'hard'`,
    );
    await tx.execute(
      sql`UPDATE difficulty_calibration_evidence SET theta_snapshot = ${A}::double precision + ${B}::double precision * theta_snapshot`,
    );
    await tx.execute(
      sql`UPDATE item_family_calibration SET b_delta = ${B}::double precision * b_delta, updated_at = ${now.toISOString()}::timestamptz WHERE b_delta <> 0`,
    );
  });
  result.kb_renormalized = true;
}

/** A6.3/A6.4：证据账本的来源 × 路由类构成（全表计数）。 */
async function collectEvidenceMix(db: Db, result: JointCalibrationBatchResult): Promise<void> {
  const rows = await db
    .select({
      evidence_source: difficulty_calibration_evidence.evidence_source,
      judge_route: difficulty_calibration_evidence.judge_route,
      n: sql<number>`count(*)::int`,
    })
    .from(difficulty_calibration_evidence)
    .groupBy(
      difficulty_calibration_evidence.evidence_source,
      difficulty_calibration_evidence.judge_route,
    );
  const bySource: Record<string, number> = {};
  let modelJudged = 0;
  let total = 0;
  for (const r of rows) {
    bySource[r.evidence_source] = (bySource[r.evidence_source] ?? 0) + r.n;
    if (r.judge_route !== 'exact') modelJudged += r.n;
    total += r.n;
  }
  result.evidence_by_source = bySource;
  result.evidence_model_judged = modelJudged;
  result.evidence_total = total;
}
