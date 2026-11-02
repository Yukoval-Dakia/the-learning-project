// Grid-Bayes against live Elo+SRT. Read-only. This module does not flip THETA_GRID_ENABLED
// and does not write the database. READY_FOR_FLIP means non-inferior on this data. The flip
// is still an owner decision.
// scoresSrt holds the dark grid probability. scoresBinary holds the live Elo+SRT probability.
// The names come from the shared bootstrap shape. RT-less steps stay in, unlike V-A1-fwd,
// because the two engines differ without an RT. The loader is scripts/ops-calibration.ts.

import { SRT_ENABLED } from '@/core/theta';
import { type ClusterForwardPreds, deltaAucClusterBootstrap } from './bootstrap';
import { effectiveNFromClusters } from './design-effect';
import { ece } from './ece';
import { type ReplayAttempt, replayTheta } from './replay';

export interface GridConfig {
  effectiveNFloor: number; // default 100
  minKcClusters: number; // default 10
  /** READY needs the ΔAUC lower CI bound above −this. Grid not materially worse than live. */
  deltaThreshold: number; // default 0.02
  /** READY needs eceGrid <= eceLive + this. */
  eceTolerance: number; // default 0.02
  bootstrapB: number; // default 2000
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

/** An out-of-range override would mint an advisory verdict. Throw instead. */
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

/** Same labels for both engines. ECE is not clustered. The AUC comparison is. */
export interface GridPooled {
  predGrid: number[];
  predLive: number[];
  labels: (0 | 1)[];
}

export interface AssembledGridClusters {
  /** scoresSrt is grid. scoresBinary is live Elo+SRT. */
  clusters: ClusterForwardPreds[];
  pooled: GridPooled;
  nScorable: number;
}

export interface GridResult {
  verdict: GridVerdict;
  /** AUC_grid − AUC_live. */
  pointDelta: number;
  aucGrid: number | null;
  aucLive: number | null;
  ci: { lo: number; hi: number };
  /** Non-degenerate replicates. Single-class draws are not redrawn. */
  b: number;
  degenerateFraction: number;
  eceGrid: number;
  eceLive: number;
  n: number;
  n1: number;
  n0: number;
  kClusters: number;
  deff: number;
  effectiveN: number;
  reason: string;
  config: GridConfig;
}

/**
 * One live replay, grid track on. θ_global is shared across KCs in a domain, so the list
 * stays whole. A step needs both predictions. scoresSrt is the grid value.
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
    if (kc === null) continue;
    // Null on either side is not a pair. Skipping beats scoring a one-sided prediction.
    if (s.predictedP === null || s.gridPredictedP === null) continue;
    nScorable++;
    let entry = byKc.get(kc);
    if (entry === undefined) {
      entry = { scoresSrt: [], scoresBinary: [], labels: [] };
      byKc.set(kc, entry);
    }
    entry.scoresSrt.push(s.gridPredictedP); // grid, despite the field name
    entry.scoresBinary.push(s.predictedP); // live Elo+SRT
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

/** INSUFFICIENT on thin data. Otherwise READY_FOR_FLIP or NOT_READY. Neither flips the flag. */
export function evaluateGridForward(
  clusters: ClusterForwardPreds[],
  pooled: GridPooled,
  cfg: Partial<GridConfig>,
  rng: () => number,
): GridResult {
  const config: GridConfig = { ...DEFAULT_CONFIG, ...cfg };
  validateConfig(config);

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

  // Below the floor this returns INSUFFICIENT, not NOT_READY. The value is also reported.
  const eff = effectiveNFromClusters(clusters.map((c) => c.labels));
  const deff = eff.deff;
  const effectiveN = eff.effectiveN;

  // Pooled, so KC clustering is ignored. The AUC interval is the clustered one.
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

  // One class has no AUC comparison. That is not NOT_READY.
  if (n1 === 0 || n0 === 0) {
    return {
      ...base,
      verdict: 'INSUFFICIENT',
      pointDelta: Number.NaN,
      reason:
        'both classes (correct AND wrong) required among single-KC scorable attempts to compare AUCs',
    };
  }

  // The report still shows ΔAUC. The grid stays dark.
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

  const boot = deltaAucClusterBootstrap(clusters, { b: config.bootstrapB, rng });
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

  // Advisory only. ciLo above −deltaThreshold, and ECE within tolerance. Neither writes a flag.
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

/** JSON when asked. The prose report is what a person reviews before any flag change. */
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
