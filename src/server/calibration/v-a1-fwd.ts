// V-A1-fwd — the keystone retro-validation gate for A1 SRT (YUK-461).
//
// For each KC, replay the per-KC θ̂ trajectory twice (SRT on vs off) over the SAME
// time-ordered attempt list; for each forward-scorable RT-bearing single-KC attempt t,
// predict outcome_t from the PRE-attempt θ̂_{t−1} via the 1PL P = σ(θ̂_{t−1} − b_effective);
// compute forward-AUC per variant; ΔAUC = AUC_SRT − AUC_binary; PASS iff ΔAUC > 0.02 AND
// a paired cluster-bootstrap CI on ΔAUC excludes 0. If the RT-bearing evidence base is
// too thin → verdict = INSUFFICIENT ("A1 stays live provisionally") — NEVER fabricate a
// pass/fail on thin data.
//
// ALL PURE. The DB-loading of attempt records is a separate thin seam
// (scripts/audit-calibration.ts) — this module only consumes ReplayAttempt records.
//
// THRESHOLD PROVENANCE (B1): deltaThreshold 0.02 is from the dossier's one V-A1-fwd cell
//   ("ΔAUC>0.02 CI 排 0"). effectiveNFloor 100, minKcClusters 10, maxDegenerateFraction
//   0.05, bootstrapB 2000 are OWNER/ENGINEERING DEFAULTS with no external source — the
//   report says so.

import { type ClusterForwardPreds, deltaAucClusterBootstrap } from './bootstrap';
import { effectiveNFromClusters } from './design-effect';
import { type ReplayAttempt, replayTheta } from './replay';

export interface VA1Config {
  /** effective-N power floor — OWNER-CHOSEN, no external source. */
  effectiveNFloor: number; // default 100
  /** minimum KC clusters — owner-chosen. */
  minKcClusters: number; // default 10
  /** ΔAUC threshold — from the dossier's V-A1-fwd cell ("ΔAUC>0.02"). */
  deltaThreshold: number; // default 0.02
  /** bootstrap replicates. */
  bootstrapB: number; // default 2000
  /** max tolerated degenerate-replicate fraction before INSUFFICIENT — owner-chosen (M1). */
  maxDegenerateFraction: number; // default 0.05
}

const DEFAULT_CONFIG: VA1Config = {
  effectiveNFloor: 100,
  minKcClusters: 10,
  deltaThreshold: 0.02,
  bootstrapB: 2000,
  maxDegenerateFraction: 0.05,
};

export type VA1Verdict = 'PASS' | 'FAIL' | 'INSUFFICIENT';

export interface VA1Result {
  verdict: VA1Verdict;
  pointDelta: number;
  aucSrt: number | null;
  aucBinary: number | null;
  ci: { lo: number; hi: number };
  b: number;
  degenerateFraction: number;
  /** all forward-scorable (single-KC) predictions, incl. RT-less (context only). */
  nTotal: number;
  /** subset where RT is present — the GATE's N (M4). */
  nWithRt: number;
  /** class counts within nWithRt. */
  n1: number;
  n0: number;
  /** KCs contributing RT-bearing forward predictions. */
  kClusters: number;
  /** REPORTED COARSE FLOOR / diagnostic (B4) — NOT the decision. */
  deff: number;
  effectiveN: number;
  /** B3 — attempts where a non-zero family delta entered the forward predictor's b. */
  familyDeltaAppliedCount: number;
  familyDeltaTotal: number;
  /** attempts dropped because outcome was 'partial' (no clean binary 1PL label). */
  partialDropped: number;
  reason: string;
}

export interface AssembledClusters {
  /** one entry per KC: RT-bearing single-KC forward predictions under both variants. */
  clusters: ClusterForwardPreds[];
  /** all single-KC scorable steps incl. RT-less (for nTotal context). */
  nTotalScorable: number;
}

/**
 * Assemble per-KC forward-prediction clusters (the no-leakage core, M4 split).
 *
 * For each KC's time-ordered attempt list: replay BOTH variants over the SAME list (full
 * multi-KC update each, so the trajectory folds in every attempt that touches the KC),
 * then keep ONLY the steps that are forward-scorable (scoredKnowledgeId !== null) AND
 * RT-bearing (hasRt). RT-less steps yield IDENTICAL predictions under both variants → 0
 * ΔAUC contribution → excluded from the gate's pool. One cluster per KC.
 */
export function assembleForwardClusters(
  attemptsByKc: Map<string, ReplayAttempt[]>,
): ClusterForwardPreds[] {
  return assembleForwardClustersDetailed(attemptsByKc).clusters;
}

/** Same as assembleForwardClusters, also returning the total scorable-step count. */
export function assembleForwardClustersDetailed(
  attemptsByKc: Map<string, ReplayAttempt[]>,
): AssembledClusters {
  const clusters: ClusterForwardPreds[] = [];
  let nTotalScorable = 0;

  for (const [kc, attempts] of attemptsByKc) {
    const srtRun = replayTheta(attempts, { srtEnabled: true });
    const binaryRun = replayTheta(attempts, { srtEnabled: false });
    // The two runs share the same step ordering (same attempt list); index-align them.
    const scoresSrt: number[] = [];
    const scoresBinary: number[] = [];
    const labels: (0 | 1)[] = [];
    for (let i = 0; i < srtRun.steps.length; i++) {
      const s = srtRun.steps[i];
      const bnry = binaryRun.steps[i];
      // forward-scorable iff this KC is the sole KC of the attempt's question.
      if (s.scoredKnowledgeId !== kc) continue;
      nTotalScorable++;
      if (!s.hasRt) continue; // RT-less → identical under both variants → 0 ΔAUC (M4).
      if (s.predictedP === null || bnry.predictedP === null) continue;
      scoresSrt.push(s.predictedP);
      scoresBinary.push(bnry.predictedP);
      labels.push(s.outcome);
    }
    if (labels.length > 0) {
      clusters.push({ scoresSrt, scoresBinary, labels });
    }
  }

  return { clusters, nTotalScorable };
}

export interface VA1Meta {
  /** total scorable steps incl. RT-less (for nTotal). */
  nTotalScorable?: number;
  familyDeltaAppliedCount?: number;
  familyDeltaTotal?: number;
  partialDropped?: number;
}

/**
 * Evaluate V-A1-fwd over assembled per-KC clusters.
 *
 * @param clusters RT-bearing single-KC forward-prediction clusters (assembleForwardClusters).
 * @param cfg      partial config overriding the owner defaults.
 * @param rng      injected RNG for the bootstrap.
 * @param meta     optional reporting metadata threaded from the loader (nTotal, family
 *   delta counts, partial-dropped count).
 */
export function evaluateVA1Forward(
  clusters: ClusterForwardPreds[],
  cfg: Partial<VA1Config>,
  rng: () => number,
  meta: VA1Meta = {},
): VA1Result {
  const config: VA1Config = { ...DEFAULT_CONFIG, ...cfg };

  // Pool counts within the RT-bearing single-KC set.
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
  const nTotal = meta.nTotalScorable ?? nWithRt;
  const familyDeltaAppliedCount = meta.familyDeltaAppliedCount ?? 0;
  const familyDeltaTotal = meta.familyDeltaTotal ?? 0;
  const partialDropped = meta.partialDropped ?? 0;

  // deff/effectiveN over the per-KC LABELS (reported coarse floor + diagnostic, B4).
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
  };

  // Hard class floor — a forward AUC needs BOTH classes among the RT-bearing attempts.
  if (n1 === 0 || n0 === 0) {
    return {
      ...base,
      verdict: 'INSUFFICIENT',
      pointDelta: Number.NaN,
      reason: 'both classes (correct AND wrong) required among RT-bearing single-KC attempts',
    };
  }

  // Power floor — keyed on the RT-bearing data (M4). Still compute pointDelta "for
  // information only" so the report shows the observed effect even when underpowered.
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

  // Adequately powered → run the paired cluster bootstrap and decide.
  const boot = deltaAucClusterBootstrap(clusters, { b: config.bootstrapB, rng });

  // Degenerate guard (M1).
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

/** Human-readable report (or JSON when opts.json). */
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
  lines.push('Evidence base:');
  lines.push(`  nTotal (single-KC forward-scorable, incl. RT-less) = ${result.nTotal}`);
  lines.push(`  nWithRt (the GATE's N — RT-bearing only)           = ${result.nWithRt}`);
  lines.push(`  classes within nWithRt: correct=${result.n1}, wrong=${result.n0}`);
  lines.push(`  kClusters (KCs with RT-bearing forward preds)      = ${result.kClusters}`);
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
    '  - N keys on RT-BEARING single-KC attempts only (RT-less contribute identically to both variants).',
  );
  lines.push(
    '  - SRT design constant d is fixed (resolveSrtTimeLimit), never re-fit on scored outcomes (no in-sample leakage).',
  );
  lines.push('  - A2 (HIERARCHICAL_ELO_ENABLED) held LIVE for both variants so ΔAUC isolates SRT.');
  lines.push(`  - 'partial' outcomes dropped from forward scoring: ${result.partialDropped}.`);
  lines.push(
    '  - effectiveN floor (100) + minKcClusters (10) are OWNER-CHOSEN; ΔAUC threshold 0.02 from the dossier V-A1-fwd cell.',
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
