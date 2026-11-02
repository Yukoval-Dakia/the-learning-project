// YUK-439 (ADR-0043 2026-10-19 Amendment) — 现行方案 vs 联合标定的历史重放对照引擎。
//
// 纯内存（无 IO）：同一份时序作答史跑两个**完整系统**（各自维护自己的 θ̂ 轨迹与 b 场），
// 逐作答比较**事前**预测——
//   - incumbent（现行 main）：θ̂ Elo（updateThetaForAttempt 路径的镜像，读
//     b_calib ?? b_anchor 链）+ 旧 active-PPI 机器按其真实节奏模拟（≥12 条 legacy 标签
//     才 firm-up b_calib，Hájek AIPW——复用 recalibration.ts 的估计器，机器保留的对照用途）；
//   - joint（YUK-439）：θ̂ Elo 原样（读 b_post）+ 每批边界从证据账本全量重算 b_post
//     （core/difficulty-posterior.ts，含信任域）。
//
// 两侧 θ̂ 更新数学完全相同（core/theta primitives，镜像 replayTheta 的循环结构），
// 预测都在 θ̂ 写入**之前**发出（outcome_t never forms θ̂_{t−1}），对照只差 b 的演化
// 方式。分数目标 s ∈ [0,1]（部分得分按分数伯努利计 log loss，两侧同靶）；ECE 只在
// 二元 outcome 子集上算（ece() 的标签类型契约）。
//
// READ-ONLY / REPORT-ONLY：绝不翻 flag、绝不写库。DB 读取在
// scripts/replay-joint-calibration.ts（thin seam，镜像 ops-calibration 的 loader 纪律）。

import {
  type DifficultyEvidencePoint,
  evidenceWeight,
  priorTau,
  updateDifficultyPosterior,
} from '@/core/difficulty-posterior';
import { mulberry32 } from '@/core/rng';
import {
  ELO_K_GLOBAL,
  HIERARCHICAL_ELO_ENABLED,
  conjunctiveCredits,
  conjunctiveCreditsContinuous,
  eloK,
  expectedScore,
  resolveSrtTimeLimit,
  srtOutcome,
} from '@/core/theta';
import {
  type LabeledSample,
  RECALIBRATION_MIN_LABELS,
  aipwMean,
  impliedBLabel,
} from '@/server/mastery/recalibration';
import { ece } from './ece';

/** 一条作答史记录（loader 产出；synthetic 模式由脚本生成）。 */
export interface JointReplayAttempt {
  eventId: string;
  questionId: string;
  /** θ̂ 更新的完整 KC 集（production 更新全部）。 */
  knowledgeIds: string[];
  /** 单 KC 题的可评分 KC；多 KC 题 null（不进 forward 评分，仍进 θ̂/证据）。 */
  scoredKnowledgeId: string | null;
  /** KC → effective domain（null 跳过 hierarchical drift）。 */
  domainByKc: Record<string, string | null>;
  /** θ̂ Elo 的二元 outcome（production credit 路径就是二元）。 */
  outcome: 0 | 1;
  /** 连续分数 ∈ [0,1]（预测目标 + joint 证据；二元作答 = outcome）。 */
  score: number;
  difficulty: number;
  /** 先验均值 μ_j（item_calibration.b_anchor；null → 该题两侧都退锚不更新）。 */
  bAnchor: number | null;
  /** 锚 source（τ 映射）。 */
  anchorSource: string | null;
  /** 弱锚降权（difficulty_proxy 0.3；真锚 1）——θ̂ credit 的 bWeight。 */
  bWeight: number;
  evidenceSource: string;
  judgeRoute: string;
  judgeConfidence: number | null;
  /** softmax 流内真 π_i（incumbent 侧 AIPW 权重；null → 0.5 均匀假设，文档化近似）。 */
  inclusionProbability: number | null;
  responseTimeMs: number | null;
  createdAt: number;
}

export interface JointReplayOptions {
  /** 模拟批粒度：每多少条作答跑一次批边界（nightly 的代理）。default 40。 */
  batchEveryN?: number;
  /** 模型路由复判一致率（A4 w_e 因子；null → 登记默认）。 */
  modelAgreementRate?: number | null;
  /** paired bootstrap 轮数。default 2000。 */
  bootstrapB?: number;
  /** RNG seed（bootstrap 确定性）。 */
  seed?: number;
}

export interface JointReplayStep {
  eventId: string;
  questionId: string;
  /** 两侧事前预测（各自 θ̂_eff 对各自 b_current；无锚/多 KC → null）。 */
  pIncumbent: number | null;
  pJoint: number | null;
  score: number;
  outcome: 0 | 1;
}

export interface JointReplayResult {
  steps: JointReplayStep[];
  /** 单 KC 有锚评分步数（两侧同集）。 */
  nScored: number;
  logLossIncumbent: number;
  logLossJoint: number;
  /** Δ = incumbent − joint（>0 ⇒ joint 预测对数损失更低）。 */
  logLossDelta: number;
  /** 二元子集 ECE（equal-width 10 bins）。 */
  eceIncumbent: number;
  eceJoint: number;
  /** paired cluster（按题）bootstrap 的 Δlogloss 95% CI。 */
  deltaCi: { lo: number; hi: number; b: number };
  /** joint 侧终态 vs 锚的 Δb（有锚题）——票面「b 变化量的分布」。 */
  bDelta: { questionId: string; anchor: number; post: number }[];
  absDeltaSummary: { mean: number; p50: number; p90: number; max: number };
  /** 证据构成（A6.3 口径）。 */
  evidenceBySource: Record<string, number>;
  modelJudged: number;
  /** incumbent 侧被旧机器 firm-up 的题数（≥12 标签门），对照透明。 */
  incumbentFirmups: number;
}

/** 一侧方案的 θ̂ 状态（两侧各自维护，更新数学相同）。 */
interface ThetaState {
  thetaKc: Map<string, number>;
  evidence: Map<string, number>;
  thetaGlobal: Map<string, number>;
}

function dedupKcs(ids: string[]): string[] {
  return Array.from(new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0)));
}

function clipP(p: number): number {
  return Math.min(1 - 1e-12, Math.max(1e-12, p));
}

function meanLogLoss(ps: number[], ss: number[]): number {
  let sum = 0;
  for (let i = 0; i < ps.length; i++) {
    const p = clipP(ps[i]);
    sum += -(ss[i] * Math.log(p) + (1 - ss[i]) * Math.log(1 - p));
  }
  return ps.length === 0 ? Number.NaN : sum / ps.length;
}

function quantileOf(sortedAsc: number[], q: number): number {
  const pos = q * (sortedAsc.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

/**
 * 跑对照。两侧各一条 θ̂ 循环（同 bWeight/eloK/credit/SRT/分层 drift，读各自的 b 场）；
 * 批边界上 incumbent 跑旧 AIPW firm-up、joint 跑后验重算。
 */
export function replayJointComparison(
  orderedAttempts: readonly JointReplayAttempt[],
  opts: JointReplayOptions = {},
): JointReplayResult {
  const batchEveryN = opts.batchEveryN ?? 40;
  const agreementRate = opts.modelAgreementRate ?? null;
  const bootstrapB = opts.bootstrapB ?? 2000;
  const rng = mulberry32(opts.seed ?? 0x5eed_0439);

  const inc: ThetaState = { thetaKc: new Map(), evidence: new Map(), thetaGlobal: new Map() };
  const jnt: ThetaState = { thetaKc: new Map(), evidence: new Map(), thetaGlobal: new Map() };

  // 锚/τ 的 per-question 快照（避免批内 O(N) 查找）。
  const anchorByQuestion = new Map<string, { mu: number; source: string | null }>();
  for (const a of orderedAttempts) {
    if (a.bAnchor !== null && !anchorByQuestion.has(a.questionId)) {
      anchorByQuestion.set(a.questionId, { mu: a.bAnchor, source: a.anchorSource });
    }
  }

  // incumbent 侧 b：读链 b_calib ?? b_anchor（firm-up 才有 b_calib；初值锚）。
  const bIncumbent = new Map<string, number>();
  // joint 侧 b：b_post（初值锚；批边界重算）。
  const bJoint = new Map<string, number>();
  for (const [questionId, anchor] of anchorByQuestion) {
    bIncumbent.set(questionId, anchor.mu);
    bJoint.set(questionId, anchor.mu);
  }
  const evidenceByQuestion = new Map<string, DifficultyEvidencePoint[]>();
  const legacyLabels = new Map<string, LabeledSample[]>();
  const firmed = new Set<string>();
  const evidenceBySource: Record<string, number> = {};
  let modelJudged = 0;

  const globalOf = (state: ThetaState, domainByKc: Record<string, string | null>, kcId: string) => {
    const domain = domainByKc[kcId] ?? null;
    return domain !== null && HIERARCHICAL_ELO_ENABLED ? (state.thetaGlobal.get(domain) ?? 0) : 0;
  };

  /** 一次 θ̂ Elo 更新（镜像 replayTheta 的 per-attempt 段；b 是该方案的当前读数）。 */
  const applyCredit = (state: ThetaState, a: JointReplayAttempt, b: number) => {
    const kcs = dedupKcs(a.knowledgeIds);
    const effectiveThetas = kcs.map(
      (kc) => (state.thetaKc.get(kc) ?? 0) + globalOf(state, a.domainByKc, kc),
    );
    const hasRt = typeof a.responseTimeMs === 'number' && Number.isFinite(a.responseTimeMs);
    let credits: number[];
    if (hasRt) {
      const d = resolveSrtTimeLimit(a.difficulty);
      const tSeconds = (a.responseTimeMs as number) / 1000;
      const pItem = effectiveThetas.reduce((acc, th) => acc * expectedScore(th, b), 1);
      const timeWeight = pItem > 0 && pItem < 1 ? 4 * pItem * (1 - pItem) : 1;
      const srt = srtOutcome(a.outcome === 1, d, tSeconds, timeWeight);
      credits = conjunctiveCreditsContinuous(effectiveThetas, b, srt);
    } else {
      credits = conjunctiveCredits(effectiveThetas, b, a.outcome);
    }
    for (let i = 0; i < kcs.length; i++) {
      const kc = kcs[i];
      const k = eloK(state.evidence.get(kc) ?? 0);
      state.thetaKc.set(kc, (state.thetaKc.get(kc) ?? 0) + k * a.bWeight * credits[i]);
      state.evidence.set(kc, (state.evidence.get(kc) ?? 0) + 1);
    }
    if (HIERARCHICAL_ELO_ENABLED) {
      const creditsByDomain = new Map<string, number[]>();
      for (let i = 0; i < kcs.length; i++) {
        const domain = a.domainByKc[kcs[i]] ?? null;
        if (domain === null) continue;
        const list = creditsByDomain.get(domain) ?? [];
        list.push(credits[i]);
        creditsByDomain.set(domain, list);
      }
      for (const domain of [...creditsByDomain.keys()].sort()) {
        const domainCredits = creditsByDomain.get(domain) as number[];
        const aggregateCredit = domainCredits.reduce((x, c) => x + c, 0) / domainCredits.length;
        const current = state.thetaGlobal.get(domain) ?? 0;
        state.thetaGlobal.set(domain, current + ELO_K_GLOBAL * a.bWeight * aggregateCredit);
      }
    }
  };

  const steps: JointReplayStep[] = [];
  let sinceBatch = 0;

  for (const a of orderedAttempts) {
    const kcs = dedupKcs(a.knowledgeIds);
    if (kcs.length === 0) continue;
    const bInc = bIncumbent.get(a.questionId);
    const bJnt = bJoint.get(a.questionId);

    // ── 事前预测（各自 θ̂_eff、各自 b；θ̂ 写入之前）。──
    let pIncumbent: number | null = null;
    let pJoint: number | null = null;
    if (a.scoredKnowledgeId !== null && bInc !== undefined && bJnt !== undefined) {
      const sk = a.scoredKnowledgeId;
      pIncumbent = expectedScore(
        (inc.thetaKc.get(sk) ?? 0) + globalOf(inc, a.domainByKc, sk),
        bInc,
      );
      pJoint = expectedScore((jnt.thetaKc.get(sk) ?? 0) + globalOf(jnt, a.domainByKc, sk), bJnt);
    }

    // ── 证据/legacy 标签入账（事前 θ 快照——thetaBefore 纪律）。──
    if (a.bAnchor !== null) {
      const list = evidenceByQuestion.get(a.questionId) ?? [];
      list.push({
        theta: jnt.thetaKc.get(kcs[0]) ?? 0,
        score: a.score,
        weight: evidenceWeight({
          source: a.evidenceSource,
          judgeRoute: a.judgeRoute,
          judgeConfidence: a.judgeConfidence,
          modelAgreementRate: agreementRate,
        }),
      });
      evidenceByQuestion.set(a.questionId, list);
      evidenceBySource[a.evidenceSource] = (evidenceBySource[a.evidenceSource] ?? 0) + 1;
      if (a.judgeRoute !== 'exact') modelJudged++;
      // incumbent 侧 legacy 标签门：objective + softmax 流内 + 二元（旧 hook 的三重门）。
      if (a.judgeRoute === 'exact' && a.evidenceSource === 'stream_softmax' && bInc !== undefined) {
        const labels = legacyLabels.get(a.questionId) ?? [];
        labels.push({
          label: impliedBLabel(inc.thetaKc.get(kcs[0]) ?? 0, bInc, a.outcome),
          prediction: bInc,
          pi: a.inclusionProbability ?? 0.5,
        });
        legacyLabels.set(a.questionId, labels);
      }
    }

    steps.push({
      eventId: a.eventId,
      questionId: a.questionId,
      pIncumbent,
      pJoint,
      score: a.score,
      outcome: a.outcome,
    });

    // ── 两侧各按自己的 b 跑 θ̂ credit。──
    if (bJnt !== undefined) applyCredit(jnt, a, bJnt);
    else applyCredit(jnt, a, a.bAnchor ?? 0);
    if (bInc !== undefined) applyCredit(inc, a, bInc);
    else applyCredit(inc, a, a.bAnchor ?? 0);

    // ── 批边界（nightly 代理）：两侧各自动 b。──
    sinceBatch++;
    if (sinceBatch >= batchEveryN) {
      sinceBatch = 0;
      for (const [questionId, anchor] of anchorByQuestion) {
        // joint：先验 + 账本全量重算。信任域按生产批语义在批内迭代到不再 bind
        // （与 joint-calibration.ts 同款，镜像保持一致）。
        const points = evidenceByQuestion.get(questionId);
        if (points === undefined) continue;
        let previous: number | null = bJoint.get(questionId) ?? null;
        let posterior = updateDifficultyPosterior(
          { mu: anchor.mu, tau: priorTau(anchor.source) },
          points,
          { previousBPost: previous },
        );
        for (let i = 0; i < 24; i++) {
          if (Math.abs(posterior.bPost - (previous ?? anchor.mu)) < 0.75) break;
          previous = posterior.bPost;
          posterior = updateDifficultyPosterior(
            { mu: anchor.mu, tau: priorTau(anchor.source) },
            points,
            { previousBPost: previous },
          );
        }
        bJoint.set(questionId, posterior.bPost);
        // incumbent：旧 AIPW firm-up（≥12 legacy 标签；同输入同输出地复刻生产机器）。
        const labels = legacyLabels.get(questionId);
        if (labels !== undefined && labels.length >= RECALIBRATION_MIN_LABELS) {
          bIncumbent.set(
            questionId,
            aipwMean(
              [anchor.mu],
              labels.map((l) => ({ residual: l.label - l.prediction, pi: l.pi })),
            ),
          );
          firmed.add(questionId);
        }
      }
    }
  }

  // ── 汇总指标（两侧同集：单 KC + 有锚）。──
  const psInc: number[] = [];
  const psJnt: number[] = [];
  const ss: number[] = [];
  const binPInc: number[] = [];
  const binPJnt: number[] = [];
  const binY: (0 | 1)[] = [];
  const clusterOf: string[] = [];
  for (const step of steps) {
    if (step.pIncumbent === null || step.pJoint === null) continue;
    psInc.push(step.pIncumbent);
    psJnt.push(step.pJoint);
    ss.push(step.score);
    clusterOf.push(step.questionId);
    if (step.score === 0 || step.score === 1) {
      binPInc.push(step.pIncumbent);
      binPJnt.push(step.pJoint);
      binY.push(step.score === 1 ? 1 : 0);
    }
  }
  const perStepDelta = psInc.map((p, i) => {
    const pc = clipP(p);
    const pj = clipP(psJnt[i]);
    return (
      -(ss[i] * Math.log(pc) + (1 - ss[i]) * Math.log(1 - pc)) -
      -(ss[i] * Math.log(pj) + (1 - ss[i]) * Math.log(1 - pj))
    );
  });

  // paired cluster bootstrap（按题聚簇——同一题的预测序列相关，row bootstrap 低估方差；
  // 每个 replicate 两侧同抽，配对差只反映方案差异）。
  const clusters = new Map<string, number[]>();
  for (let i = 0; i < perStepDelta.length; i++) {
    const list = clusters.get(clusterOf[i]) ?? [];
    list.push(i);
    clusters.set(clusterOf[i], list);
  }
  const clusterArr = [...clusters.values()];
  const point =
    perStepDelta.length > 0 ? perStepDelta.reduce((x, y) => x + y, 0) / perStepDelta.length : 0;
  let lo = point;
  let hi = point;
  if (clusterArr.length > 0 && perStepDelta.length > 0) {
    const replicates: number[] = [];
    for (let b = 0; b < bootstrapB; b++) {
      let sum = 0;
      let count = 0;
      for (let c = 0; c < clusterArr.length; c++) {
        const draw = clusterArr[Math.floor(rng() * clusterArr.length)];
        for (const idx of draw) {
          sum += perStepDelta[idx];
          count++;
        }
      }
      if (count > 0) replicates.push(sum / count);
    }
    replicates.sort((x, y) => x - y);
    lo = replicates[Math.floor(0.025 * replicates.length)] ?? point;
    hi = replicates[Math.ceil(0.975 * replicates.length) - 1] ?? point;
  }

  const bDelta: JointReplayResult['bDelta'] = [];
  for (const [questionId, anchor] of anchorByQuestion) {
    const post = bJoint.get(questionId);
    if (post === undefined) continue;
    bDelta.push({ questionId, anchor: anchor.mu, post });
  }
  const absDeltas = bDelta.map((d) => Math.abs(d.post - d.anchor)).sort((x, y) => x - y);

  return {
    steps,
    nScored: psInc.length,
    logLossIncumbent: meanLogLoss(psInc, ss),
    logLossJoint: meanLogLoss(psJnt, ss),
    logLossDelta: meanLogLoss(psInc, ss) - meanLogLoss(psJnt, ss),
    eceIncumbent:
      binY.length > 0 ? ece(binPInc, binY, { binning: 'equal-width', k: 10 }).ece : Number.NaN,
    eceJoint:
      binY.length > 0 ? ece(binPJnt, binY, { binning: 'equal-width', k: 10 }).ece : Number.NaN,
    deltaCi: { lo, hi, b: bootstrapB },
    bDelta,
    absDeltaSummary: {
      mean:
        absDeltas.length > 0 ? absDeltas.reduce((x, y) => x + y, 0) / absDeltas.length : Number.NaN,
      p50: absDeltas.length > 0 ? quantileOf(absDeltas, 0.5) : Number.NaN,
      p90: absDeltas.length > 0 ? quantileOf(absDeltas, 0.9) : Number.NaN,
      max: absDeltas.length > 0 ? absDeltas[absDeltas.length - 1] : Number.NaN,
    },
    evidenceBySource,
    modelJudged,
    incumbentFirmups: firmed.size,
  };
}
