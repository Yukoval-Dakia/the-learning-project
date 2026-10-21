// 冷启动题目先验的确定性解释与合成；不执行任务或写入状态。
// retained / staged 共用文本解释与成功 rep 的合成规则。

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

// YUK-376 — LLaSA simulation parsing barrier. Brace-slice + schema parse, then the
// deterministic 1PL MLE below folds the observations back into an ItemPriorDraft.
// Failures throw and the backfill skips/retries this item; insufficient tier coverage
// throws in the inversion.

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

// YUK-376 — LLaSA simulation → b: deterministic 1PL (Rasch) MLE over a [-4,4] grid.
// Each simulated response is a Bernoulli point (θ_j, y_j). All-correct/all-wrong is
// censored to min(θ)−1 / max(θ)+1, with lower confidence. Fewer than four distinct θ
// tiers throws. Confidence is heuristic: 0.65 interior / 0.40 censored base, ±0.15
// for monotonicity, clamped to [0.2, 0.85] because an LLM prior should never be
// high-confidence.

/** Minimum distinct θ tiers (the 5-tier design tolerates one missing). */
const LLASA_MIN_TIERS = LLASA_ABILITY_TIERS.length - 1;

/** b grid bounds: one tier beyond the prompt's ±3 soft guide. */
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
 * Fold one LLaSA simulation into an ItemPriorDraft. Throws on insufficient tier
 * coverage; the caller skips/retries.
 */
function invertLlasaSimulation(draft: ItemPriorLlasaDraftT): LlasaInversion {
  // Aggregate per tier, keeping the model's actual theta values.
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
    // All wrong: b is above the strongest tier. Censored reading, not a point estimate.
    censored = 'high';
    bHat = strongest.theta + 1;
    logLik = points.length * Math.log(1 - sigmoid(strongest.theta - bHat));
  } else if (totalCorrect === points.length) {
    censored = 'low';
    bHat = weakest.theta - 1;
    logLik = points.length * Math.log(sigmoid(weakest.theta - bHat));
  } else {
    // 1PL MLE grid argmax.
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

  // Monotonicity: per-tier p̂ must not decrease with θ (ties count as monotone).
  const monotone = tiers.every((t, i) => i === 0 || t.p_hat >= (tiers[i - 1]?.p_hat ?? 0) - 1e-9);

  // Confidence heuristic: censored or non-monotone lowers it.
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

// YUK-1034 — median aggregation of N feature→b samples for one question. Measured
// within-question SD was ≈0.30; median-of-3 cuts it to ≈0.17 at linear cost and
// without changing the estimation target. Deterministic:
//   - b_logit / confidence: median (even counts average the two middles).
//   - reasoning: the rep closest to the median b, plus a provenance suffix. Raw rep
//     outputs remain in ai_task_run.
// Empty drafts throw; callers apply their normal per-item skip/retry.

interface ItemPriorRepAggregation {
  /** Aggregated draft: median b/confidence, reasoning plus provenance. */
  draft: ItemPriorDraftT;
  /** Successful rep b logits, ascending. */
  rep_b_logits: number[];
  /** Number of successful reps aggregated. */
  succeeded: number;
  /** Total attempted reps, including discarded failures. */
  attempted: number;
}

/** Median of an ascending array; even counts average the middles. Empty → NaN. */
function medianOfSorted(xs: readonly number[]): number {
  const n = xs.length;
  if (n === 0) return Number.NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

const fmtB = (x: number): string => String(Number(x.toFixed(3)));

/**
 * Fold N feature→b drafts into one. Throws when all reps failed; callers apply the
 * normal per-item skip semantics.
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
  // Representative = closest b to the median. Ascending scan + strict less-than keeps
  // ties deterministic and input-order independent.
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

/** Explain the completion text; method-specific simulation/inversion stays local. */
export function parseItemPriorDraft(method: 'feature' | 'llasa', text: string): ItemPriorDraftT {
  return method === 'llasa' ? parseItemPriorLlasaOutput(text).prior : parseItemPriorOutput(text);
}

/**
 * Compose already-explained drafts: first draft for LLaSA/single-rep, median otherwise.
 * Selection is by planned rep count, not success count.
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
