// 供题与备题员 owner 的稳定业务操作。practice 内其它 owner 只经本文件引用本 owner
// （`pnpm audit:practice-subowners`）；practice 外部调用方经根 `public.ts` 的具名转出。
// 契约（EvidenceDemandV1 / SupplyTraceV1 / PlacementVerificationAuthority）在
// `@/kernel/supply-contracts`；供题范围锁在 `@/kernel/locks/placement-supply`。
import { lockPlacementSupplyScopes } from '@/kernel/locks/placement-supply';
import { assertPlacementAuthority } from './server/placement-starter-attempts';
import {
  assertPlacementPaidEffectAuthority,
  buildPlacementQuestionPaidCalls,
  readPlacementQuestionAuthority,
  recordPlacementPaidEffect,
} from './server/placement-starter-paid-authority';

/**
 * 定位授权端口（落位接口 3）：verify/admission 消费方一次性取得定位授权断言、
 * 授权读取、付费效果栅栏/入账与供题范围锁。锁序不变（ADR-0052），锁实现在
 * `@/kernel/locks/placement-supply`，非 verify/admission 调用方也可直接引用该 kernel 锁。
 */
export const placementAuthority = {
  assertPlacementAuthority,
  readPlacementQuestionAuthority,
  assertPlacementPaidEffectAuthority,
  recordPlacementPaidEffect,
  buildPlacementQuestionPaidCalls,
  lockPlacementSupplyScopes,
} as const;

export {
  claimHttpSourceDuplicate,
  findVectorNearDuplicate,
  readVisibleVectorNearHold,
  type VectorNearHold,
  vectorNearHoldMetadata,
} from './server/ingest-dedup';
export {
  DEDUP_OVERLAP_THRESHOLD,
  matchesWhitelist,
  maxNgramOverlap,
} from './server/sourced-dedup';
export type { DispatchResult } from './server/dispatcher';
export {
  SUPPLY_DISPATCH_COOLDOWN_DAYS,
  dispatchSupplyTarget,
  dispatchSupplyTargets,
  inFlightSupplyCount,
} from './server/dispatcher';
export {
  type DifficultyBand,
  type QuestionSupplyTarget,
  type SupplyGapKind,
  type SupplyRoute,
  acquisitionTierForQuestion,
  discoverSupplyTargets,
  seedGenerationMethod,
  seedRoutePreference,
  targetFingerprint,
} from './server/target-discovery';
export { type RefillDeps, refillActiveLearningPools } from './server/refill';
export { jyeooBudgetRemaining, jyeooDailyFetchBudget } from './server/jyeoo-budget';
export {
  type JyeooFetchCandidatesResult,
  canonicalJyeooQuestionHash,
  cleanupStagedAssets,
  runJyeooFetchCandidates,
} from './server/jyeoo-candidates';
export {
  findSubjectRootKnowledgeId,
  matchJyeooKnowledgeHints,
} from './server/jyeoo-hint-match';
export {
  JYEOO_BACKFILL_PER_QUESTION_MS,
  JYEOO_SOURCE_HOST,
  jyeooBackfillSpawnTimeoutMs,
  jyeooBinaryPath,
  jyeooSpawnMaxStderrBytes,
  jyeooSpawnMaxStdoutBytes,
  jyeooSpawnTimeoutMs,
} from './server/jyeoo-supply-config';
export { loadCoverageLattice } from './server/coverage-lattice';
export type { CoverageLatticeRead } from './server/coverage-lattice-core';
export {
  type ParseLooseFn,
  type RunWebFetchCandidatesDeps,
  type RunWebFetchCandidatesResult,
  type RunWebSourcingAgentFn,
} from './server/web-candidates';
// runWebFetchCandidates 的调用链（web-candidates → SourcingTask → pi agent runtime）
// 不进 eager barrel：懒转出与根 public 既有的 plan-executor 注释同款原因。
export const runWebFetchCandidates: typeof import('./server/web-candidates').runWebFetchCandidates =
  async (...args) => (await import('./server/web-candidates')).runWebFetchCandidates(...args);
export const recoverWebSupplies: typeof import('./server/web-supply').recoverWebSupplies = async (
  ...args
) => (await import('./server/web-supply')).recoverWebSupplies(...args);
export { discoverConfusableContrastTargets } from './server/confusable-contrast-discovery';
export {
  checkSupplyPlanKnowledgeIds,
  checkSupplyPlanStructure,
  parseSupplyPlanOutput,
} from './server/supply-plan-gate';
export {
  dispatchPlacementStarterClaim,
  isPlacementStarterJobLive,
  placementClaimJobQueue,
} from './server/placement-starter';
export {
  addPlacementStarterCostComponent,
  markPlacementStarterClaimTerminal,
  materializePlacementStartersForGoal,
  resolvePlacementStarterGoalAuthority,
} from './server/placement-starter-store';
export {
  type PlacementStarterFailure,
  type PlacementStarterOutcome,
  PlacementStarterOutcomeSchema,
  placementSchemaFailure,
} from './server/placement-starter-outcome';
export { readPlacementStarterOutcomes } from './server/placement-starter-outcome-reader';
export { placementStarterIdentity } from './server/placement-starter-identity';
export {
  PLACEMENT_ATTEMPT_HEARTBEAT_MS,
  PLACEMENT_GENERATION_RESERVATION_MICRO_USD,
  PLACEMENT_PAID_CALL_RESERVATION_MICRO_USD,
  PLACEMENT_QUEUE_EXPIRY_MS,
  PLACEMENT_STARTER_REQUIRED_COUNT,
  type PlacementAttemptAuthority,
  type PlacementAttemptHeartbeat,
  type PlacementCostComponentKind,
  PlacementStarterAdmissionError,
  PlacementStarterBudgetExhaustedError,
  PlacementStarterStaleAuthorityError,
  PlacementStarterUnknownCostError,
  acquirePlacementAttempt,
  addAuthorizedCostComponent,
  assertPlacementAttemptFence,
  finishPlacementAttempt,
  markAttemptVerifying,
  placementDeliveryMetadata,
  reconcilePlacementDelivery,
  recordPlacementAttemptOutput,
  releaseAuthorizedPaidCall,
  renewPlacementAttempt,
  reserveAuthorizedPaidCall,
  reservePlacementGenerationCall,
  settleAuthorizedPaidCall,
  startPlacementAttemptHeartbeat,
  terminalizeLostPlacementDelivery,
  terminalizePlacementUnknownCost,
} from './server/placement-starter-attempts';
export {
  type PlacementPaidEffectAuthority,
  authorizePlacementQuestion,
} from './server/placement-starter-paid-authority';
export { runQuestionSupplyNightly } from './jobs/question_supply_nightly';
export {
  type StoreSourcedQuestionDeps,
  type SubmitQuestionDeps,
  dispatchSourceVerifyIntents,
  executeStoreSourcedQuestion,
  readCandidateSubmitReceipt,
  submitPlacementSupplyCandidate,
  submitQuestionTool,
} from './tools/submit-question';
