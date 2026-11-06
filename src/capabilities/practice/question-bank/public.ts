export { readAdmissionWaits } from './server/admission/stages';
// 题库与准入 owner 的稳定业务操作。practice 内其它 owner 只经本文件引用本 owner
// （`pnpm audit:practice-subowners`）；根 `public.ts` 按名字转出。
// 根 barrel 的静态加载链经过这里（迁移 bundle 不得引入 SDK）：静态导出只放不带 provider
// SDK 的模块与同步契约，其余操作在调用时才加载。

export { embedQuestionTextForIngest, questionEmbedStamp } from './jobs/embed_backfill';
export { runQuestionAdmissionChecks } from './server/admission/checks';
export { isPendingAdmission } from './server/admission/enqueue';
// Server-only: reveals the solution path. The practice root barrel does not re-export it,
// and audit:practice-subowners rejects it from tools, api and ui paths inside practice.
export {
  type NearestMethodQuestion,
  type StoredSolutionPrior,
  nearestQuestionsByMethod,
  readSolutionPriorForServer,
} from './server/admission/solution-prior';
export { readPracticeDraftList } from './server/draft-list-read';
export { enablePracticeDraft, forceEnablePracticeDraft } from './server/draft-promotion-operations';
export { readDraftReviewDetail } from './server/draft-review';
export {
  authorInterventionPackage,
  reviewInterventionPackageCandidate,
} from './server/intervention-author';
export {
  DEFAULT_MAX_PER_RUN,
  type ItemPriorCandidateFrozen,
  type ItemPriorExecutionParams,
  type ItemPriorPreparedWork,
  type ItemPriorStagedItem,
  normalizeMethod,
  normalizeReps,
  prepareItemPriorWork,
  resolveItemPriorKnowledgeNames,
  runItemPriorItemRepStages,
  selectItemPriorCandidates,
} from './server/item-prior-durable-operation';
export {
  type ItemPriorDispatch,
  type ItemPriorDispatchedRequest,
  ItemPriorMemberIdentityError,
  type ItemPriorMemberRequest,
  ItemPriorPaidEffectAdapter,
  itemPriorDispatchSchema,
  itemPriorDispatchedRequestSchema,
  itemPriorMemberRequestSchema,
  readItemPriorPgBossDelivery,
} from './server/item-prior-paid-effect-adapter';
export type {
  EnqueueVariantVerifyFn,
  PracticeApplierOpts,
  QuestionDraftAcceptResult,
  QuestionEditAcceptResult,
  VariantQuestionAcceptResult,
} from './server/proposal-appliers';
export { readQuestionDetail } from './server/question-detail-read';
export { readPracticeQuestionList } from './server/question-list-read';
export {
  archivePracticeQuestion,
  restorePracticeQuestion,
  updatePracticeQuestion,
} from './server/question-write-operations';
export {
  EXACT_DUPLICATE_EVENT_SAMPLE_CAP,
  type ExactQuestionDuplicateKnowledgeMerge,
  canonicalQuestionContentHash,
  combineExactDuplicateKnowledgeIds,
  mergeExactQuestionDuplicateKnowledgeIds,
  settleOneQuestionPageHit,
} from './server/quiz/content-fingerprint';
export { type Demand, demandToSupplyTarget } from './server/quiz/matcher';
export { poolFetch } from './server/quiz/pool-fetch';
export { SOLVE_LANE_TASK_KINDS, resolveSolveOverrideFromEnv } from './server/quiz/solve-lane';
export { runPracticeServingAction } from './server/serving-action-operation';
export { recoverHeldServingRechecks, runSystemServingRecheck } from './server/serving-actions';
export {
  type EnqueueVerifyFn,
  VERIFY_DISPATCH_COMPLETE_ACTION,
  VERIFY_DISPATCH_INTENT_ACTION,
  VERIFY_DISPATCH_VERSION,
  type VerifyRecoveryMark,
  dispatchPendingVerifyIntents,
  recoverOrphanVerifyDispatches,
  writeVerifyDispatchIntent,
} from './server/verify-dispatch-outbox';
export {
  BankGapRequestSchema,
  type BankSearchScope,
  verifyBankGapEvidenceMac,
} from './tools/bank-search';

export const materializeGeneratedQuestionParts: typeof import('./server/question-parts').materializeGeneratedQuestionParts =
  async (...args) =>
    (await import('./server/question-parts')).materializeGeneratedQuestionParts(...args);

export async function installInterventionAuthorStages(): Promise<void> {
  const [{ installInterventionAuthorStages: install }, { interventionAuthorStages }] =
    await Promise.all([
      import('@/kernel/records/intervention-package-author'),
      import('./server/intervention-author'),
    ]);
  install(interventionAuthorStages);
}

export { checkSourceConsistency, checkStructureCompleteness } from './jobs/source_verify_prechecks';
