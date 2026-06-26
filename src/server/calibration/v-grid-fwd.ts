// V-grid-fwd — grid-Bayes vs live-Elo forward retro-validation (YUK-436 / YUK-461).
//
// The OWNER decision "harness-validate-then-flip": pnpm audit:calibration retro-validates
// the DARK grid-Bayes θ_KC posterior path against the LIVE Elo+SRT path on the real event
// log, READ-ONLY + REPORT-ONLY, so the owner has the evidence to decide whether to flip
// THETA_GRID_ENABLED live. This module NEVER flips the flag and NEVER writes the DB.
//
// CONTRAST WITH V-A1-fwd: V-A1-fwd compares two SRT VARIANTS of the SAME engine (Elo with
//   SRT on vs off) → ΔAUC isolates SRT. V-grid-fwd compares two ENGINES on the SAME live
//   run: the grid forward prediction (DARK) vs the live Elo+SRT forward prediction. Both
//   predict the SAME realized outcomes from PRE-attempt state (no leakage — the replay
//   emits gridPredictedP/predictedP before folding outcome_t).
//
// REUSES the ClusterForwardPreds {scoresSrt, scoresBinary, labels} shape so the proven
//   paired whole-KC cluster bootstrap (deltaAucClusterBootstrap) gives
//   ΔAUC = AUC(scoresSrt) − AUC(scoresBinary) = AUC_grid − AUC_live directly:
//     scoresSrt    ← step.gridPredictedP (GRID, dark)
//     scoresBinary ← step.predictedP     (LIVE Elo+SRT)
//   The bootstrap is paired (same resampled clusters for both), so the CI reflects the
//   grid-vs-live contrast, not either AUC's sampling noise.
//
// RT-less steps ARE included (unlike V-A1-fwd, which excludes them because they are
//   identical under both SRT variants). Here the comparison is grid-vs-live, and grid vs
//   Elo differ on every single-KC step regardless of RT, so all single-KC scorable steps
//   carry signal.
//
// ALL PURE. The DB-loading of attempt records is the separate thin seam
//   (scripts/audit-calibration.ts) — this module only consumes ReplayAttempt records.
//
// ADVISORY VERDICT (NEVER 'PASS'/auto-flip): READY_FOR_FLIP / NOT_READY / INSUFFICIENT.
//   READY_FOR_FLIP only states the grid is NON-INFERIOR + at-least-as-calibrated on this
//   data; the actual flip is an OWNER decision after reviewing this report.

import { SRT_ENABLED } from '@/core/theta';
import { type ClusterForwardPreds, deltaAucClusterBootstrap } from './bootstrap';
import { effectiveNFromClusters } from './design-effect';
import { ece } from './ece';
import { type ReplayAttempt, replayTheta } from './replay';

export interface GridConfig {
  /** effective-N power floor — OWNER-CHOSEN (mirrors V-A1-fwd default). */
  effectiveNFloor: number; // default 100
  /** minimum KC clusters — owner-chosen (mirrors V-A1-fwd default). */
  minKcClusters: number; // default 10
  /**
   * non-inferiority margin on ΔAUC = AUC_grid − AUC_live: READY requires the bootstrap
   * lower CI bound to exceed −deltaThreshold (grid AUC not materially worse than live).
   * default 0.02 (mirrors the V-A1-fwd ΔAUC scale).
   */
  deltaThreshold: number; // default 0.02
  /** ECE non-inferiority tolerance: READY requires eceGrid <= eceLive + eceTolerance. */
  eceTolerance: number; // default 0.02
  /** bootstrap replicates. */
  bootstrapB: number; // default 2000
  /** max tolerated degenerate-replicate fraction before INSUFFICIENT — owner-chosen. */
  maxDegenerateFraction: number; // default 0.05
}

const DEFAULT_CONFIG: GridConfig = {
  effectiveNFloor: 100,
  minKcClusters: 10,
  deltaThreshold: 0.02,
  eceTolerance: 0.02,
  bootstrapB: 2000,
  maxDegenerateFraction: 0.05,
};

/**
 * Validate a fully-merged GridConfig (mirrors v-a1-fwd validateConfig). Each field guards
 * a distinct silent-wrong-verdict failure mode, so an out-of-range override throws rather
 * than fabricating an advisory verdict.
 */
function validateConfig(config: GridConfig): void {
  const {
    effectiveNFloor,
    minKcClusters,
    deltaThreshold,
    eceTolerance,
    bootstrapB,
    maxDegenerateFraction,
  } = config;
  if (!Number.isFinite(effectiveNFloor) || effectiveNFloor < 0) {
    throw new Error(
      `v-grid-fwd config: effectiveNFloor must be a finite number >= 0 (got ${effectiveNFloor})`,
    );
  }
  if (!Number.isInteger(minKcClusters) || minKcClusters < 1) {
    throw new Error(
      `v-grid-fwd config: minKcClusters must be an integer >= 1 (got ${minKcClusters})`,
    );
  }
  if (!Number.isFinite(deltaThreshold) || deltaThreshold < 0) {
    throw new Error(
      `v-grid-fwd config: deltaThreshold must be a finite number >= 0 (got ${deltaThreshold})`,
    );
  }
  if (!Number.isFinite(eceTolerance) || eceTolerance < 0) {
    throw new Error(
      `v-grid-fwd config: eceTolerance must be a finite number >= 0 (got ${eceTolerance})`,
    );
  }
  if (!Number.isInteger(bootstrapB) || bootstrapB < 1) {
    throw new Error(`v-grid-fwd config: bootstrapB must be an integer >= 1 (got ${bootstrapB})`);
  }
  if (
    !Number.isFinite(maxDegenerateFraction) ||
    maxDegenerateFraction < 0 ||
    maxDegenerateFraction > 1
  ) {
    throw new Error(
      `v-grid-fwd config: maxDegenerateFraction must be a finite number in [0,1] (got ${maxDegenerateFraction})`,
    );
  }
}

export type GridVerdict = 'READY_FOR_FLIP' | 'NOT_READY' | 'INSUFFICIENT';

/** Pooled aligned predictions for ECE (grid vs live) over the same labels. */
export interface GridPooled {
  predGrid: number[];
  predLive: number[];
  labels: (0 | 1)[];
}

export interface AssembledGridClusters {
  /** one entry per KC: grid (scoresSrt) vs live (scoresBinary) forward preds + labels. */
  clusters: ClusterForwardPreds[];
  /** pooled aligned grid/live predictions for the ECE comparison. */
  pooled: GridPooled;
  /** count of single-KC scorable steps that contributed (both preds present). */
  nScorable: number;
}

export interface GridResult {
  verdict: GridVerdict;
  /** AUC_grid − AUC_live on the full pooled sample. */
  pointDelta: number;
  aucGrid: number | null;
  aucLive: number | null;
  ci: { lo: number; hi: number };
  /** non-degenerate bootstrap replicates used. */
  b: number;
  degenerateFraction: number;
  eceGrid: number;
  eceLive: number;
  /** single-KC scorable forward predictions compared (grid vs live). */
  n: number;
  n1: number;
  n0: number;
  kClusters: number;
  deff: number;
  effectiveN: number;
  reason: string;
  /** merged config used for this evaluation (for audit traceability in formatGridReport). */
  config: GridConfig;
}

/**
 * Assemble per-KC grid-vs-live forward-prediction clusters (the no-leakage core).
 *
 * Replay the WHOLE ordered list ONCE under the LIVE flags (srtEnabled: SRT_ENABLED) with
 * the grid track ON. θ_global accumulates across every KC of a domain (YUK-466) in the one
 * replay; the grid track shadows it. For each single-KC scorable step that produced BOTH a
 * live prediction (predictedP) AND a grid prediction (gridPredictedP), bucket by
 * scoredKnowledgeId into a cluster carrying scoresSrt=grid, scoresBinary=live, labels.
 *
 * Map insertion order = order of first scored appearance → deterministic cluster order.
 */
export function assembleGridForwardClusters(
  orderedAttempts: ReplayAttempt[],
): AssembledGridClusters {
  const run = replayTheta(orderedAttempts, { srtEnabled: SRT_ENABLED, gridEnabled: true });

  const byKc = new Map<
    string,
    { scoresSrt: number[]; scoresBinary: number[]; labels: (0 | 1)[] }
  >();
  const pooled: GridPooled = { predGrid: [], predLive: [], labels: [] };
  let nScorable = 0;

  for (const s of run.steps) {
    const kc = s.scoredKnowledgeId;
    if (kc === null) continue; // multi-KC → not forward-scorable.
    // Both predictions must exist. predictedP is the LIVE Elo+SRT forward prediction;
    // gridPredictedP is the DARK grid forward prediction. Either being null (should not
    // happen for a single-KC step with grid on) means no comparable pair → skip.
    if (s.predictedP === null || s.gridPredictedP === null) continue;
    nScorable++;
    let entry = byKc.get(kc);
    if (entry === undefined) {
      entry = { scoresSrt: [], scoresBinary: [], labels: [] };
      byKc.set(kc, entry);
    }
    entry.scoresSrt.push(s.gridPredictedP); // GRID (dark)
    entry.scoresBinary.push(s.predictedP); // LIVE Elo+SRT
    entry.labels.push(s.outcome);
    pooled.predGrid.push(s.gridPredictedP);
    pooled.predLive.push(s.predictedP);
    pooled.labels.push(s.outcome);
  }

  const clusters: ClusterForwardPreds[] = [];
  for (const entry of byKc.values()) {
    if (entry.labels.length > 0) clusters.push(entry);
  }

  return { clusters, pooled, nScorable };
}

/**
 * Evaluate V-grid-fwd over assembled clusters + pooled predictions.
 *
 * @param clusters per-KC grid(scoresSrt)-vs-live(scoresBinary) forward-prediction clusters.
 * @param pooled   aligned pooled grid/live predictions + labels (for the ECE comparison).
 * @param cfg      partial config overriding the owner defaults.
 * @param rng      injected RNG for the bootstrap (mulberry32).
 */
export function evaluateGridForward(
  clusters: ClusterForwardPreds[],
  pooled: GridPooled,
  cfg: Partial<GridConfig>,
  rng: () => number,
): GridResult {
  const config: GridConfig = { ...DEFAULT_CONFIG, ...cfg };
  validateConfig(config);

  // Pool counts within the single-KC scorable set.
  let n = 0;
  let n1 = 0;
  let n0 = 0;
  for (const c of clusters) {
    for (const y of c.labels) {
      n++;
      if (y === 1) n1++;
      else n0++;
    }
  }
  const kClusters = clusters.length;

  // deff/effectiveN over the per-KC LABELS (reported coarse floor + diagnostic).
  const eff = effectiveNFromClusters(clusters.map((c) => c.labels));
  const deff = eff.deff;
  const effectiveN = eff.effectiveN;

  // ECE on the pooled aligned predictions (grid vs live, same labels). Both classes
  // present is guaranteed below before this matters; ece itself tolerates any binary mix.
  const eceGrid = pooled.predGrid.length > 0 ? ece(pooled.predGrid, pooled.labels).ece : 0;
  const eceLive = pooled.predLive.length > 0 ? ece(pooled.predLive, pooled.labels).ece : 0;

  const base = {
    aucGrid: null as number | null,
    aucLive: null as number | null,
    ci: { lo: Number.NaN, hi: Number.NaN },
    b: 0,
    degenerateFraction: 0,
    eceGrid,
    eceLive,
    n,
    n1,
    n0,
    kClusters,
    deff,
    effectiveN,
    config,
  };

  // Hard class floor — a forward AUC needs BOTH classes.
  if (n1 === 0 || n0 === 0) {
    return {
      ...base,
      verdict: 'INSUFFICIENT',
      pointDelta: Number.NaN,
      reason:
        'both classes (correct AND wrong) required among single-KC scorable attempts to compare AUCs',
    };
  }

  // Power floor — INSUFFICIENT on thin data. Still compute the point delta + CI for the
  // report (information only), so the owner sees the observed effect even when underpowered.
  if (effectiveN < config.effectiveNFloor || kClusters < config.minKcClusters) {
    const boot = deltaAucClusterBootstrap(clusters, { b: config.bootstrapB, rng });
    return {
      ...base,
      aucGrid: boot.aucSrt,
      aucLive: boot.aucBinary,
      pointDelta: boot.pointDelta,
      ci: { lo: boot.ciLo, hi: boot.ciHi },
      b: boot.b,
      degenerateFraction: boot.degenerateFraction,
      verdict: 'INSUFFICIENT',
      reason:
        `insufficient power: effectiveN ${round(effectiveN)} (floor ${config.effectiveNFloor}), ` +
        `kClusters ${kClusters} (floor ${config.minKcClusters}). The grid stays DARK; ` +
        `do NOT flip THETA_GRID_ENABLED. ΔAUC ${round(boot.pointDelta)} reported for information only.`,
    };
  }

  // Adequately powered → paired cluster bootstrap on ΔAUC = AUC_grid − AUC_live.
  const boot = deltaAucClusterBootstrap(clusters, { b: config.bootstrapB, rng });

  // Degenerate guard.
  if (boot.degenerateFraction > config.maxDegenerateFraction) {
    return {
      ...base,
      aucGrid: boot.aucSrt,
      aucLive: boot.aucBinary,
      pointDelta: boot.pointDelta,
      ci: { lo: boot.ciLo, hi: boot.ciHi },
      b: boot.b,
      degenerateFraction: boot.degenerateFraction,
      verdict: 'INSUFFICIENT',
      reason:
        `bootstrap unstable: ${round(boot.degenerateFraction * 100)}% of replicates were ` +
        `single-class (> ${config.maxDegenerateFraction * 100}% limit). The grid stays DARK.`,
    };
  }

  // NON-INFERIORITY decision (advisory):
  //   AUC: lower CI bound on (grid − live) must exceed −deltaThreshold (grid not worse).
  //   ECE: grid ECE must be within eceTolerance of live ECE (grid at least as calibrated).
  const aucNonInferior = boot.ciLo > -config.deltaThreshold;
  const eceNonInferior = eceGrid <= eceLive + config.eceTolerance;
  const ready = aucNonInferior && eceNonInferior;

  const readyReason = `grid is NON-INFERIOR: ΔAUC(grid−live) CI lower bound ${round(boot.ciLo)} > −${config.deltaThreshold} AND ECE_grid ${round(eceGrid)} <= ECE_live ${round(eceLive)} + ${config.eceTolerance}. ADVISORY ONLY — the flip of THETA_GRID_ENABLED is an owner decision.`;
  const aucReason = aucNonInferior
    ? ''
    : `ΔAUC CI lower bound ${round(boot.ciLo)} <= −${config.deltaThreshold} (AUC worse); `;
  const eceReason = eceNonInferior
    ? ''
    : `ECE_grid ${round(eceGrid)} > ECE_live ${round(eceLive)} + ${config.eceTolerance} (less calibrated); `;
  const notReadyReason = `grid NOT yet non-inferior: ${aucReason}${eceReason}do NOT flip THETA_GRID_ENABLED.`;

  return {
    ...base,
    aucGrid: boot.aucSrt,
    aucLive: boot.aucBinary,
    pointDelta: boot.pointDelta,
    ci: { lo: boot.ciLo, hi: boot.ciHi },
    b: boot.b,
    degenerateFraction: boot.degenerateFraction,
    verdict: ready ? 'READY_FOR_FLIP' : 'NOT_READY',
    reason: ready ? readyReason : notReadyReason,
  };
}

function round(x: number): number {
  if (!Number.isFinite(x)) return x;
  return Math.round(x * 10000) / 10000;
}

/** Human-readable report (or JSON when opts.json). */
export function formatGridReport(result: GridResult, opts: { json?: boolean } = {}): string {
  if (opts.json) {
    return JSON.stringify(result, null, 2);
  }
  const lines: string[] = [];
  lines.push('=== Grid-Bayes vs live Elo forward retro-validation (READ-ONLY, ADVISORY) ===');
  lines.push('');
  lines.push(`VERDICT: ${result.verdict}`);
  lines.push(`  ${result.reason}`);
  lines.push('');
  lines.push('Forward-AUC (predicting outcome_t from PRE-attempt state; grid vs live Elo+SRT):');
  lines.push(`  AUC_grid  = ${fmt(result.aucGrid)}`);
  lines.push(`  AUC_live  = ${fmt(result.aucLive)}`);
  lines.push(`  ΔAUC (grid − live) = ${fmt(result.pointDelta)}`);
  lines.push(
    `  bootstrap CI[2.5%,97.5%] = [${fmt(result.ci.lo)}, ${fmt(result.ci.hi)}]  (B=${result.b} non-degenerate replicates, degenerate ${round(result.degenerateFraction * 100)}%)`,
  );
  lines.push('');
  lines.push('Calibration (ECE on the pooled forward predictions, same labels):');
  lines.push(`  ECE_grid = ${fmt(result.eceGrid)}`);
  lines.push(`  ECE_live = ${fmt(result.eceLive)}`);
  lines.push('');
  lines.push('Evidence base:');
  lines.push(`  n (single-KC scorable forward preds compared) = ${result.n}`);
  lines.push(`  classes: correct=${result.n1}, wrong=${result.n0}`);
  lines.push(`  kClusters (KCs with grid-vs-live forward preds) = ${result.kClusters}`);
  lines.push(
    `  deff = ${round(result.deff)}, effectiveN = ${round(result.effectiveN)}  (coarse floor / diagnostic)`,
  );
  lines.push('');
  lines.push('Caveats (no silent burial):');
  lines.push(
    '  - This NEVER flips THETA_GRID_ENABLED and NEVER writes the DB. The grid is DARK (shadow only).',
  );
  lines.push(
    '  - READY_FOR_FLIP is ADVISORY: it states the grid is non-inferior (AUC + ECE) on THIS data. The flip is an OWNER decision after reviewing this evidence.',
  );
  lines.push(
    '  - ECE is computed on the POOLED forward predictions (KC clustering ignored); the AUC ΔAUC CI is the per-KC cluster bootstrap (clustering respected). ECE is a secondary calibration check, not the primary inference.',
  );
  lines.push(
    '  - The DECISION metric is the paired whole-KC cluster bootstrap CI on ΔAUC(grid−live); effectiveN = N/deff is a REPORTED COARSE FLOOR only.',
  );
  lines.push(
    '  - Grid forward preds come from the SAME single live replay as the Elo preds (gridEnabled track), so θ_global / b anchors are identical — the contrast is purely grid-posterior vs Elo-point-estimate.',
  );
  lines.push(
    '  - No leakage: both predictions are emitted from PRE-attempt state, before folding outcome_t.',
  );
  const cfg = result.config;
  lines.push(
    `  - non-inferiority margins: ΔAUC −${cfg.deltaThreshold}, ECE +${cfg.eceTolerance}; effectiveN floor ${cfg.effectiveNFloor}, minKcClusters ${cfg.minKcClusters} (OWNER-CHOSEN).`,
  );
  if (result.verdict === 'INSUFFICIENT') {
    lines.push('');
    lines.push(
      '  >> INSUFFICIENT EVIDENCE: the grid stays DARK. This is NOT a failure verdict; do NOT flip any flag.',
    );
  }
  return lines.join('\n');
}

function fmt(x: number | null): string {
  if (x === null) return 'n/a';
  if (!Number.isFinite(x)) return 'NaN';
  return x.toFixed(4);
}
