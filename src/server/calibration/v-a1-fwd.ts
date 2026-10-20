// Forward gate for SRT against binary Elo. PASS needs ΔAUC above deltaThreshold and a CI
// that excludes 0. Thin evidence stays INSUFFICIENT.
// Replay the full ordered list twice. θ_global is shared across KCs in a domain, so a
// per-KC replay would not match production. The loader is scripts/audit-calibration.ts.
// deltaThreshold 0.02 comes from the dossier cell. The other defaults have no external source.

import { type ClusterForwardPreds, deltaAucClusterBootstrap } from './bootstrap';
import { effectiveNFromClusters } from './design-effect';
import { type ReplayAttempt, replayTheta } from './replay';

export interface VA1Config {
  /** No external source. Below it the verdict is INSUFFICIENT. */
  effectiveNFloor: number; // default 100
  minKcClusters: number; // default 10
  /** From the dossier cell. */
  deltaThreshold: number; // default 0.02
  bootstrapB: number; // default 2000
  /** Above this fraction of single-class replicates the verdict is INSUFFICIENT. */
  maxDegenerateFraction: number; // default 0.05
  /**
   * Copied onto the result for the report. Bucketing uses the argument to
   * assembleForwardClusters. The audit caller must set both the same way.
   */
  multiKcScoring: boolean; // default false
}

const DEFAULT_CONFIG: VA1Config = {
  effectiveNFloor: 100,
  minKcClusters: 10,
  deltaThreshold: 0.02,
  bootstrapB: 2000,
  maxDegenerateFraction: 0.05,
  multiKcScoring: false,
};

/** An out-of-range override would mint a verdict. Throw instead. */
function validateConfig(config: VA1Config): void {
  const {
    effectiveNFloor,
    minKcClusters,
    deltaThreshold,
    bootstrapB,
    maxDegenerateFraction,
    multiKcScoring,
  } = config;
  if (!Number.isFinite(effectiveNFloor) || effectiveNFloor < 0) {
    throw new Error(
      `v-a1-fwd config: effectiveNFloor must be a finite number >= 0 (got ${effectiveNFloor})`,
    );
  }
  if (!Number.isInteger(minKcClusters) || minKcClusters < 1) {
    throw new Error(
      `v-a1-fwd config: minKcClusters must be an integer >= 1 (got ${minKcClusters})`,
    );
  }
  if (!Number.isFinite(deltaThreshold) || deltaThreshold < 0) {
    throw new Error(
      `v-a1-fwd config: deltaThreshold must be a finite number >= 0 (got ${deltaThreshold})`,
    );
  }
  if (!Number.isInteger(bootstrapB) || bootstrapB < 1) {
    throw new Error(`v-a1-fwd config: bootstrapB must be an integer >= 1 (got ${bootstrapB})`);
  }
  if (
    !Number.isFinite(maxDegenerateFraction) ||
    maxDegenerateFraction < 0 ||
    maxDegenerateFraction > 1
  ) {
    throw new Error(
      `v-a1-fwd config: maxDegenerateFraction must be a finite number in [0,1] (got ${maxDegenerateFraction})`,
    );
  }
  if (typeof multiKcScoring !== 'boolean') {
    throw new Error(
      `v-a1-fwd config: multiKcScoring must be a boolean (got ${String(multiKcScoring)})`,
    );
  }
}

export type VA1Verdict = 'PASS' | 'FAIL' | 'INSUFFICIENT';

export interface VA1Result {
  verdict: VA1Verdict;
  pointDelta: number;
  aucSrt: number | null;
  aucBinary: number | null;
  ci: { lo: number; hi: number };
  b: number;
  degenerateFraction: number;
  /** Scorable steps, including RT-less. Missing meta falls back to nWithRt. */
  nTotal: number;
  /** The gate's sample. RT-less steps are identical under both variants, so they stay out. */
  nWithRt: number;
  n1: number;
  n0: number;
  kClusters: number;
  /** Kish design effect. The power check uses effectiveN. */
  deff: number;
  /** Below the floor the verdict is INSUFFICIENT, before PASS or FAIL. */
  effectiveN: number;
  /** Attempts whose forward b included a non-zero family delta. */
  familyDeltaAppliedCount: number;
  familyDeltaTotal: number;
  /** Dropped because a partial outcome is not a binary 1PL label. */
  partialDropped: number;
  reason: string;
  config: VA1Config;
}

export interface AssembledClusters {
  /** Single-KC clusters, plus combo clusters when multi-KC scoring is on. */
  clusters: ClusterForwardPreds[];
  /** Includes RT-less steps. The gate pool does not. */
  nTotalScorable: number;
}

/**
 * Drops nTotalScorable. evaluateVA1Forward then reports nWithRt as nTotal.
 * Use assembleForwardClustersDetailed when the report must count RT-less steps.
 */
export function assembleForwardClusters(
  orderedAttempts: ReplayAttempt[],
  opts: { multiKcScoring?: boolean } = {},
): ClusterForwardPreds[] {
  return assembleForwardClustersDetailed(orderedAttempts, opts).clusters;
}

/**
 * Pass the full timeline. θ_global drifts once per touched domain per attempt and is shared
 * by every KC in that domain, so a per-KC replay would not match production θ̂.
 * Multi-KC steps join a separate combo cluster, disjoint from single-KC keys, and only when
 * multiKcScoring is set. Otherwise the pool matches the single-KC assembly.
 */
export function assembleForwardClustersDetailed(
  orderedAttempts: ReplayAttempt[],
  opts: { multiKcScoring?: boolean } = {},
): AssembledClusters {
  const multiKcScoring = opts.multiKcScoring ?? false;
  // Both runs see multiKcScoring. One side without it would pair a combo score with null.
  const srtRun = replayTheta(orderedAttempts, { srtEnabled: true, multiKcScoring });
  const binaryRun = replayTheta(orderedAttempts, { srtEnabled: false, multiKcScoring });
  // A length mismatch would pair an SRT score with the wrong binary score and corrupt every ΔAUC.
  if (srtRun.steps.length !== binaryRun.steps.length) {
    throw new Error(
      `assembleForwardClusters: srt/binary step count mismatch (${srtRun.steps.length} vs ${binaryRun.steps.length}) — replay divergence`,
    );
  }

  // Map order is first scored appearance, so the cluster order does not depend on key sort.
  const byKc = new Map<
    string,
    { scoresSrt: number[]; scoresBinary: number[]; labels: (0 | 1)[] }
  >();
  // A separate map so a combo key cannot collide with a single-KC id. One attempt, one cluster.
  const byCombo = new Map<
    string,
    { scoresSrt: number[]; scoresBinary: number[]; labels: (0 | 1)[] }
  >();
  let nTotalScorable = 0;

  for (let i = 0; i < srtRun.steps.length; i++) {
    const s = srtRun.steps[i];
    const bnry = binaryRun.steps[i];
    // scoredKnowledgeId and hasRt come from the attempt, so the SRT run and the binary run agree.
    const kc = s.scoredKnowledgeId;
    if (kc !== null) {
      nTotalScorable++;
      if (!s.hasRt) continue; // Identical under both variants, so ΔAUC would not move.
      if (s.predictedP === null || bnry.predictedP === null) continue;
      let entry = byKc.get(kc);
      if (entry === undefined) {
        entry = { scoresSrt: [], scoresBinary: [], labels: [] };
        byKc.set(kc, entry);
      }
      entry.scoresSrt.push(s.predictedP);
      entry.scoresBinary.push(bnry.predictedP);
      entry.labels.push(s.outcome);
      continue;
    }
    // Item fields stay null unless multi-KC scoring is on, so this does not change the single-KC pool.
    if (!multiKcScoring || s.itemPredictedP === null || s.itemClusterKey === null) continue;
    nTotalScorable++;
    if (!s.hasRt) continue;
    if (bnry.itemPredictedP === null) continue;
    const comboKey = s.itemClusterKey;
    let entry = byCombo.get(comboKey);
    if (entry === undefined) {
      entry = { scoresSrt: [], scoresBinary: [], labels: [] };
      byCombo.set(comboKey, entry);
    }
    entry.scoresSrt.push(s.itemPredictedP);
    entry.scoresBinary.push(bnry.itemPredictedP);
    entry.labels.push(s.outcome);
  }

  const clusters: ClusterForwardPreds[] = [];
  for (const entry of byKc.values()) {
    if (entry.labels.length > 0) clusters.push(entry);
  }
  // Appended after single-KC clusters. The bootstrap resamples by index, so this order is only for stability.
  for (const entry of byCombo.values()) {
    if (entry.labels.length > 0) clusters.push(entry);
  }

  return { clusters, nTotalScorable };
}

export interface VA1Meta {
  /** When omitted, nTotal becomes nWithRt. The RT-less count is not invented. */
  nTotalScorable?: number;
  familyDeltaAppliedCount?: number;
  familyDeltaTotal?: number;
  partialDropped?: number;
}

/** INSUFFICIENT on one class, on a thin sample, or on an unstable bootstrap. Otherwise PASS or FAIL. */
export function evaluateVA1Forward(
  clusters: ClusterForwardPreds[],
  cfg: Partial<VA1Config>,
  rng: () => number,
  meta: VA1Meta = {},
): VA1Result {
  const config: VA1Config = { ...DEFAULT_CONFIG, ...cfg };
  // Validate the merged values. A negative threshold or a zero replicate count would mint a verdict.
  validateConfig(config);

  let nWithRt = 0;
  let n1 = 0;
  let n0 = 0;
  for (const c of clusters) {
    for (const y of c.labels) {
      nWithRt++;
      if (y === 1) n1++;
      else n0++;
    }
  }
  const kClusters = clusters.length;
  // Absent meta means the RT-less count is unknown. Do not invent a larger nTotal.
  const nTotal = meta.nTotalScorable ?? nWithRt;
  const familyDeltaAppliedCount = meta.familyDeltaAppliedCount ?? 0;
  const familyDeltaTotal = meta.familyDeltaTotal ?? 0;
  const partialDropped = meta.partialDropped ?? 0;

  // Below this floor, or below minKcClusters, the verdict is INSUFFICIENT.
  const eff = effectiveNFromClusters(clusters.map((c) => c.labels));
  const deff = eff.deff;
  const effectiveN = eff.effectiveN;

  const base = {
    aucSrt: null as number | null,
    aucBinary: null as number | null,
    ci: { lo: Number.NaN, hi: Number.NaN },
    b: 0,
    degenerateFraction: 0,
    nTotal,
    nWithRt,
    n1,
    n0,
    kClusters,
    deff,
    effectiveN,
    familyDeltaAppliedCount,
    familyDeltaTotal,
    partialDropped,
    config,
  };

  // One class has no AUC. That is not a fail.
  if (n1 === 0 || n0 === 0) {
    return {
      ...base,
      verdict: 'INSUFFICIENT',
      pointDelta: Number.NaN,
      reason: 'both classes (correct AND wrong) required among RT-bearing single-KC attempts',
    };
  }

  // Still compute pointDelta. The report shows the effect, and the verdict stays INSUFFICIENT.
  if (effectiveN < config.effectiveNFloor || kClusters < config.minKcClusters) {
    const boot = deltaAucClusterBootstrap(clusters, { b: config.bootstrapB, rng });
    return {
      ...base,
      aucSrt: boot.aucSrt,
      aucBinary: boot.aucBinary,
      pointDelta: boot.pointDelta,
      verdict: 'INSUFFICIENT',
      reason:
        `insufficient power: effectiveN ${round(effectiveN)} ` +
        `(floor ${config.effectiveNFloor}), kClusters ${kClusters} (floor ${config.minKcClusters}). ` +
        `A1 stays live provisionally. pointDelta ${round(boot.pointDelta)} reported for information only.`,
    };
  }

  const boot = deltaAucClusterBootstrap(clusters, { b: config.bootstrapB, rng });
  if (boot.degenerateFraction > config.maxDegenerateFraction) {
    return {
      ...base,
      aucSrt: boot.aucSrt,
      aucBinary: boot.aucBinary,
      pointDelta: boot.pointDelta,
      ci: { lo: boot.ciLo, hi: boot.ciHi },
      b: boot.b,
      degenerateFraction: boot.degenerateFraction,
      verdict: 'INSUFFICIENT',
      reason:
        `bootstrap unstable: ${round(boot.degenerateFraction * 100)}% of replicates were ` +
        `single-class (> ${config.maxDegenerateFraction * 100}% limit). A1 stays live provisionally.`,
    };
  }

  const pass = boot.pointDelta > config.deltaThreshold && boot.ciLo > 0;
  return {
    ...base,
    aucSrt: boot.aucSrt,
    aucBinary: boot.aucBinary,
    pointDelta: boot.pointDelta,
    ci: { lo: boot.ciLo, hi: boot.ciHi },
    b: boot.b,
    degenerateFraction: boot.degenerateFraction,
    verdict: pass ? 'PASS' : 'FAIL',
    reason: pass
      ? `ΔAUC ${round(boot.pointDelta)} > ${config.deltaThreshold} AND CI [${round(boot.ciLo)}, ${round(boot.ciHi)}] excludes 0 → SRT improves forward prediction.`
      : `ΔAUC ${round(boot.pointDelta)} (CI [${round(boot.ciLo)}, ${round(boot.ciHi)}]) does NOT clear the bar (>${config.deltaThreshold} AND CI excludes 0).`,
  };
}

function round(x: number): number {
  if (!Number.isFinite(x)) return x;
  return Math.round(x * 10000) / 10000;
}

/** JSON when asked. The prose report is for a person reading the harness output. */
export function formatReport(result: VA1Result, opts: { json?: boolean } = {}): string {
  if (opts.json) {
    return JSON.stringify(result, null, 2);
  }
  const lines: string[] = [];
  lines.push('=== V-A1-fwd: A1 SRT forward-AUC retro-validation (READ-ONLY, REPORT-ONLY) ===');
  lines.push('');
  lines.push(`VERDICT: ${result.verdict}`);
  lines.push(`  ${result.reason}`);
  lines.push('');
  lines.push('Forward-AUC (predicting outcome_t from the PRE-attempt θ̂_{t-1} via 1PL):');
  lines.push(`  AUC_SRT     = ${fmt(result.aucSrt)}`);
  lines.push(`  AUC_binary  = ${fmt(result.aucBinary)}`);
  lines.push(`  ΔAUC (pointDelta) = ${fmt(result.pointDelta)}`);
  lines.push(
    `  bootstrap CI[2.5%,97.5%] = [${fmt(result.ci.lo)}, ${fmt(result.ci.hi)}]  (B=${result.b} non-degenerate replicates, degenerate ${round(result.degenerateFraction * 100)}%)`,
  );
  lines.push('');
  const cfg = result.config;
  lines.push('Evidence base:');
  lines.push(
    cfg.multiKcScoring
      ? `  nTotal (single-KC + multi-KC combo forward-scorable, incl. RT-less) = ${result.nTotal}`
      : `  nTotal (single-KC forward-scorable, incl. RT-less) = ${result.nTotal}`,
  );
  lines.push(`  nWithRt (the GATE's N — RT-bearing only)           = ${result.nWithRt}`);
  lines.push(`  classes within nWithRt: correct=${result.n1}, wrong=${result.n0}`);
  lines.push(
    cfg.multiKcScoring
      ? `  kClusters (KC + combo clusters with RT-bearing forward preds) = ${result.kClusters}`
      : `  kClusters (KCs with RT-bearing forward preds)      = ${result.kClusters}`,
  );
  lines.push(
    `  deff = ${round(result.deff)}, effectiveN = ${round(result.effectiveN)}  (coarse floor / diagnostic)`,
  );
  lines.push('');
  lines.push('Caveats (no silent burial):');
  lines.push(
    '  - The DECISION is the paired whole-KC cluster bootstrap CI. effectiveN = N/deff (ICC(1,1) over per-KC labels) is a REPORTED COARSE FLOOR / heuristic ONLY — NOT a residual-autocorrelation measure; the CI is the inference.',
  );
  lines.push(
    `  - Forward predictor b = production's full effectiveFamilyB(columnarB, familyRow); family delta applied to ${result.familyDeltaAppliedCount}/${result.familyDeltaTotal} RT-bearing single-KC attempts.`,
  );
  lines.push(
    cfg.multiKcScoring
      ? '  - N keys on RT-BEARING attempts (single-KC + multi-KC combo) only (RT-less contribute identically to both variants).'
      : '  - N keys on RT-BEARING single-KC attempts only (RT-less contribute identically to both variants).',
  );
  lines.push(
    '  - SRT design constant d is fixed (resolveSrtTimeLimit), never re-fit on scored outcomes (no in-sample leakage).',
  );
  lines.push('  - A2 (HIERARCHICAL_ELO_ENABLED) held LIVE for both variants so ΔAUC isolates SRT.');
  lines.push(`  - 'partial' outcomes dropped from forward scoring: ${result.partialDropped}.`);
  lines.push(
    `  - effectiveN floor (${cfg.effectiveNFloor}) + minKcClusters (${cfg.minKcClusters}) are OWNER-CHOSEN; ΔAUC threshold ${cfg.deltaThreshold} from the dossier V-A1-fwd cell.`,
  );
  lines.push(
    cfg.multiKcScoring
      ? '  - YUK-463 MULTI-KC SCORING ON: RT-bearing multi-KC attempts ARE forward-scored via the conjunctive item prediction ∏ σ(θ_j − b) and bucketed into disjoint combo clusters (sorted KC set) alongside the single-KC clusters. N includes them (parameter-free DINA s=g=0 — NO slip/guess).'
      : '  - YUK-463 multi-KC scoring OFF (default): multi-KC attempts are replayed for trajectory fidelity but EXCLUDED from the scored pool (single-KC pool only). Pass --multi-kc to fold them in.',
  );
  if (result.verdict === 'INSUFFICIENT') {
    lines.push('');
    lines.push(
      '  >> INSUFFICIENT EVIDENCE: A1 SRT stays live provisionally. This is NOT a failure verdict; do NOT flip any flag.',
    );
  }
  return lines.join('\n');
}

function fmt(x: number | null): string {
  if (x === null) return 'n/a';
  if (!Number.isFinite(x)) return 'NaN';
  return x.toFixed(4);
}
