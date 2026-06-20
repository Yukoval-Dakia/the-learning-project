// Calibration harness — PURE surface barrel (YUK-461, axis-2 Wave-0).
//
// Re-exports ONLY the pure, fully-unit-tested calibration math + replay engine + V-A1-fwd
// gate. The DB-touching loader lives in scripts/audit-calibration.ts and is NOT exported
// here (the math core stays import-clean of @/db/client so the unit partition holds).

// ECE — Expected Calibration Error + reliability table.
export { type Binning, type EceOptions, type EceResult, type ReliabilityBin, ece } from './ece';
// forward-AUC — Mann–Whitney U.
export { type AucResult, forwardAuc } from './auc';
// design-effect / ICC(1,1) / effective-N.
export {
  type EffectiveNResult,
  type IccResult,
  designEffect,
  effectiveNFromClusters,
  iccOneWayAnova,
} from './design-effect';
// Cohen's κ.
export { type KappaResult, cohenKappa } from './kappa';
// seeded RNG.
export { mulberry32 } from './rng';
// PURE θ̂ replay engine.
export {
  type ReplayAttempt,
  type ReplayFinalState,
  type ReplayResult,
  type ReplayStep,
  replayTheta,
} from './replay';
// paired cluster bootstrap CI for ΔAUC.
export { type ClusterForwardPreds, type DeltaAucCi, deltaAucClusterBootstrap } from './bootstrap';
// V-A1-fwd gate + assembly + report.
export {
  type AssembledClusters,
  type VA1Config,
  type VA1Meta,
  type VA1Result,
  type VA1Verdict,
  assembleForwardClusters,
  assembleForwardClustersDetailed,
  evaluateVA1Forward,
  formatReport,
} from './v-a1-fwd';
