// Math, replay, and the forward gate. The DB loader stays in scripts/audit-calibration.ts
// so this barrel does not import the database client.

export { type AucResult, forwardAuc } from './auc';
export { type ClusterForwardPreds, type DeltaAucCi, deltaAucClusterBootstrap } from './bootstrap';
export {
  type EffectiveNResult,
  type IccResult,
  designEffect,
  effectiveNFromClusters,
  iccOneWayAnova,
} from './design-effect';
export { type Binning, type EceOptions, type EceResult, type ReliabilityBin, ece } from './ece';
export {
  EZ_SCALING_S,
  type EzInputs,
  type EzReason,
  type EzResult,
  computeEzDiffusion,
  edgeCorrectPc,
  ezFromResponses,
} from './ez-diffusion';
export { type KappaResult, cohenKappa } from './kappa';
export {
  type ReplayAttempt,
  type ReplayFinalState,
  type ReplayResult,
  type ReplayStep,
  replayTheta,
} from './replay';
export { mulberry32 } from './rng';
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
