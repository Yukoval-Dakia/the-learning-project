// V-A1-fwd — the keystone retro-validation gate for A1 SRT (YUK-461).
//
// Replay the FULL ordered attempt list twice (SRT on vs off) so θ_global accumulates across
// every KC of a domain (YUK-466); for each forward-scorable RT-bearing single-KC attempt t,
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

/**
 * Validate a fully-merged VA1Config (OCR finding 6). Each field guards a distinct
 * silent-wrong-verdict failure mode, so an out-of-range override throws rather than
 * fabricating a verdict.
 */
function validateConfig(config: VA1Config): void {
  const { effectiveNFloor, minKcClusters, deltaThreshold, bootstrapB, maxDegenerateFraction } =
    config;
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
  /** merged config used for this evaluation (for audit traceability in formatReport). */
  config: VA1Config;
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
 * ⚠ θ_GLOBAL FIDELITY (YUK-466): takes the FULL time-ordered attempt list (every KC
 *   interleaved), NOT a per-KC partition. Production θ̂ = θ_KC + θ_global(domain), and
 *   θ_global drifts once per touched DOMAIN per attempt (replay.ts:207-227 / state.ts:682-
 *   735, ELO_K_GLOBAL=0.048) — i.e. it is shared across every KC in a domain. Replaying
 *   each KC's attempts in isolation would let that KC's θ_global see ONLY its own attempts,
 *   missing the drift contributed by sibling-KC attempts in the same domain → the forward
 *   predictor's θ̂ would diverge from production. Replaying the WHOLE ordered list once per
 *   variant accumulates θ_global correctly across all KCs, then we bucket the forward-
 *   scorable steps by scoredKnowledgeId. (For ΔAUC = AUC_SRT − AUC_binary this is a 2nd-
 *   order correction since both variants share θ_global, but the ABSOLUTE forward-AUC
 *   fidelity requires it — and the verdict must be trustworthy before it is load-bearing.)
 *
 * Replay BOTH variants over the SAME full list (full multi-KC update each), then keep ONLY
 * the steps that are forward-scorable (scoredKnowledgeId !== null, i.e. single-KC question)
 * AND RT-bearing (hasRt). RT-less steps yield IDENTICAL predictions under both variants → 0
 * ΔAUC contribution → excluded from the gate's pool. One cluster per scored KC, in order of
 * first scored appearance in the timeline.
 *
 * ⚠ OCR finding 8: this THIN variant DISCARDS `nTotalScorable` (the count of single-KC
 *   forward-scorable steps INCLUDING the RT-less ones). A caller that pairs this with
 *   `evaluateVA1Forward` but does NOT pass `meta.nTotalScorable` will get the result's
 *   `nTotal` silently falling back to `nWithRt` — under-reporting the evidence context.
 *   If you need an accurate `nTotal` in the report, call `assembleForwardClustersDetailed`
 *   and thread its `nTotalScorable` into `meta`. Use this thin variant ONLY when the
 *   RT-less context count is genuinely irrelevant (e.g. unit tests that assert on the
 *   gate's pooled decision, not on nTotal).
 */
export function assembleForwardClusters(orderedAttempts: ReplayAttempt[]): ClusterForwardPreds[] {
  return assembleForwardClustersDetailed(orderedAttempts).clusters;
}

/** Same as assembleForwardClusters, also returning the total scorable-step count. */
export function assembleForwardClustersDetailed(
  orderedAttempts: ReplayAttempt[],
): AssembledClusters {
  // Replay the WHOLE ordered list once per variant — θ_global accumulates across every KC
  // in a domain (YUK-466). The engine emits one step per attempt, in list order.
  const srtRun = replayTheta(orderedAttempts, { srtEnabled: true });
  const binaryRun = replayTheta(orderedAttempts, { srtEnabled: false });
  // OCR finding 7: the index-alignment below assumes both runs produce the SAME number of
  // steps (they replay the SAME attempt list, so they must). Assert it so a future
  // divergence in replayTheta fails LOUD here rather than silently mis-pairing srt/binary
  // scores (which would corrupt every ΔAUC without any signal).
  if (srtRun.steps.length !== binaryRun.steps.length) {
    throw new Error(
      `assembleForwardClusters: srt/binary step count mismatch (${srtRun.steps.length} vs ${binaryRun.steps.length}) — replay divergence`,
    );
  }

  // Bucket forward-scorable RT-bearing steps by scoredKnowledgeId (one cluster per KC).
  // Map insertion order = order of first scored appearance → deterministic cluster order.
  const byKc = new Map<
    string,
    { scoresSrt: number[]; scoresBinary: number[]; labels: (0 | 1)[] }
  >();
  let nTotalScorable = 0;

  for (let i = 0; i < srtRun.steps.length; i++) {
    const s = srtRun.steps[i];
    const bnry = binaryRun.steps[i];
    // forward-scorable iff the attempt's question is single-KC (scoredKnowledgeId !== null).
    // scoredKnowledgeId/hasRt are variant-independent (set from the attempt), so reading
    // them off the SRT run is safe.
    const kc = s.scoredKnowledgeId;
    if (kc === null) continue;
    nTotalScorable++;
    if (!s.hasRt) continue; // RT-less → identical under both variants → 0 ΔAUC (M4).
    if (s.predictedP === null || bnry.predictedP === null) continue;
    let entry = byKc.get(kc);
    if (entry === undefined) {
      entry = { scoresSrt: [], scoresBinary: [], labels: [] };
      byKc.set(kc, entry);
    }
    entry.scoresSrt.push(s.predictedP);
    entry.scoresBinary.push(bnry.predictedP);
    entry.labels.push(s.outcome);
  }

  const clusters: ClusterForwardPreds[] = [];
  for (const entry of byKc.values()) {
    if (entry.labels.length > 0) clusters.push(entry);
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
  // OCR finding 6: the merged config is otherwise unchecked — an override like
  // bootstrapB<=0 (no replicates → empty CI), deltaThreshold<0 (every positive ΔAUC
  // "passes"), or minKcClusters=0 (power floor disabled) silently produces a nonsense
  // verdict. Validate the MERGED values so a bad override fails loud.
  validateConfig(config);

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
  // OCR finding 8: nTotalScorable (single-KC scorable steps incl. RT-less) MUST be threaded
  // from the loader/assembler via meta. When absent it degrades to nWithRt (a strict lower
  // bound — the RT-less context is simply unknown to this call, never fabricated upward).
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
    config,
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
  const cfg = result.config;
  lines.push(
    `  - effectiveN floor (${cfg.effectiveNFloor}) + minKcClusters (${cfg.minKcClusters}) are OWNER-CHOSEN; ΔAUC threshold ${cfg.deltaThreshold} from the dossier V-A1-fwd cell.`,
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
