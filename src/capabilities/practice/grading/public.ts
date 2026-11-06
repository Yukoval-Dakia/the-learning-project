// 作答与判分 owner 的稳定业务操作。practice 内其它 owner 只经本文件引用本 owner
// （`pnpm audit:practice-subowners`）；根 `public.ts` 按名字转出。
// 根 barrel 的静态加载链经过这里（迁移 bundle 不得引入 SDK）：静态导出只放不带 provider SDK
// 的模块；作答复习、DBOS judge 投递与对账这几条链只在调用时加载。

export { readJudgeCalibrationConfig } from './jobs/judge-calibration-config';
export { normalizeReviewSubmitActivityRef } from './server/activity-ref';
export { recordAssistanceExposure } from './server/assessment/assistance';
export {
  commitFormalAttempt,
  prepareFormalAttemptSubmission,
  previewFormalAttempt,
  recordFormalAttemptCapture,
} from './server/assessment/attempt';
export type {
  NativeAttemptDispatchOptions,
  NativeAttemptDispatchPort,
} from './server/assessment/native-attempt-dispatch-port';
export {
  requestAssessmentIssuance,
  requestResponseDraftSave,
} from './server/assessment/request';
export {
  loadFrozenStudyContext,
  loadFrozenStudyImages,
  projectFrozenStudyContext,
  revealFrozenStudyReference,
} from './server/assessment/study-context';
export {
  type SaveSubmissionRequest,
  getIssuanceState,
  saveResponseDraft,
  saveSubmission,
} from './server/assessment/submit';
export { createAssessmentAssetLoader } from './server/assets';
export {
  type CalibrationSampleDispatch,
  calibrationSampleDispatchSchema,
} from './server/calibration-sample-store';
export {
  loadCommittedInterventionDiagnosticAttempt,
  questionKnowledgeIdsForJudge,
} from './server/intervention-diagnostics';
export {
  type AnswerInput,
  type ContractAttemptInput,
  type ContractAttemptOutcome,
  type ContractGradingRef,
  EVALUATION_ENTRY_POINTS,
  type EntryPointDisposition,
  type EvaluateAttemptInput,
  type EvaluateAttemptOutcome,
  EvaluateSubmissionError,
  type EvaluateSubmissionRequest,
  type EvaluateSubmissionResult,
  type GradingEntryPoint,
  IMAGE_CONSUMING_JUDGE_ROUTES,
  type JevModelExecutorSpec,
  type JudgeAnswerParams,
  type JudgeAnswerResult,
  type JudgeInvokerOutput,
  type JudgeKind,
  type JudgeQuestionRow,
  type JudgeResult,
  type JudgeRoute,
  type JudgeRouteQuestionRow,
  type JudgeRouterInput,
  MODEL_BACKED_JUDGE_ROUTES,
  type MultimodalDirectImageFetchFn,
  type MultimodalDirectRunTaskFn,
  createDefaultJudgeInvoker,
  evaluateAttempt,
  evaluateSubmission,
  isModelBackedJudgeRoute,
  judgeAnswer,
  judgeRouter,
  judgeRouterV2,
  projectEvaluationToJudgeResult,
  resolveQuestionJudgeRoute,
  runMultimodalDirectJudge,
  runSemanticJudge,
} from './server/judge';
export {
  activateSubmissionCandidate,
  createFormalModelExecutor,
} from './server/judge/evaluate-submission';
export { assertGeneratedQuestionHasJudgeContract } from './server/judge/question-contract';
export {
  type RunSourceGroundingVerifyParams,
  type SourceGroundingVerifyResult,
  assertSourceGroundingLaneConfigured,
  runSourceGroundingVerify,
} from './server/judge/source-grounding-verify';
export { judgeFallbackProvider } from './server/judge-durable-config';
export const divertReviewAnswer: typeof import('./server/review-operation').divertReviewAnswer =
  async (...args) => (await import('./server/review-operation')).divertReviewAnswer(...args);
// Judge engine identity and census belong to grading; the shared DBOS host consumes them.
export {
  JUDGE_DBOS_QUEUE,
  JUDGE_DBOS_WORKFLOW,
  type JudgeEngineInventoryT,
  inspectDbosJudgeInventory,
  judgeDeliveryInput,
  judgeLegacyJobId,
  sealJudgeEngineInventory,
  validateJudgeEngineInventory,
} from './server/judge-engine-client';
export { ratingFromCoarseOutcome } from './server/judge-rating';
export { readJudgeRunPermanent } from './server/judge-run-observation';
export {
  JUDGE_RUN_EVENTS,
  JUDGE_RUN_TABLE,
  JudgeDurablePendingResponseSchema,
} from './server/judge-run-status';
export { installModelAdmissionPins } from './server/model-admission-pins';
export type { ReviewAnswerContext, ReviewAnswerResult } from './server/review-operation';

export const submitReviewAnswer: typeof import('./server/review-operation').submitReviewAnswer =
  async (...args) => (await import('./server/review-operation')).submitReviewAnswer(...args);
export const requestReviewAnswer: typeof import('./server/review-operation').requestReviewAnswer =
  async (...args) => (await import('./server/review-operation')).requestReviewAnswer(...args);
export type { ReviewAnswerReceipt } from './tools/submit-review-answer';

export async function installInterventionDiagnosticLeaves(): Promise<void> {
  const [{ installInterventionDiagnosticLeaves: install }, { interventionDiagnosticLeaves }] =
    await Promise.all([
      import('@/kernel/records/intervention-diagnostic-materialize'),
      import('./server/intervention-diagnostics'),
    ]);
  install(interventionDiagnosticLeaves);
}

export async function readJudgeRunStatus(database: import('@/db/client').Db, runId: string) {
  return (await import('./server/judge-run-observation')).readJudgeRunStatus(database, runId);
}
export async function reconcileJudgeAttempts(
  ...args: Parameters<typeof import('./jobs/judge_pending_reconcile').reconcileStalledJudgeAttempts>
) {
  return (await import('./jobs/judge_pending_reconcile')).reconcileStalledJudgeAttempts(...args);
}
export async function buildLegacyJudgeHandler(
  ...args: Parameters<typeof import('./jobs/judge_run').buildJudgeRunHandler>
) {
  return (await import('./jobs/judge_run')).buildJudgeRunHandler(...args);
}
export async function recordJudgeOperationalReceipt(
  ...args: Parameters<typeof import('./server/judge-operational').writeJudgeReceipt>
) {
  return (await import('./server/judge-operational')).writeJudgeReceipt(...args);
}
export async function readPermanentJudgeRun(
  ...args: Parameters<typeof import('./server/judge-run-observation').readJudgeRunPermanent>
) {
  return (await import('./server/judge-run-observation')).readJudgeRunPermanent(...args);
}
export async function executeJudgeWorkflow(
  ...args: Parameters<typeof import('./jobs/judge_run').runJudgeWorkflowDelivery>
) {
  return (await import('./jobs/judge_run')).runJudgeWorkflowDelivery(...args);
}

export const reserveJudgeOperationalDelivery: typeof import('./server/judge-operational').reserveJudgeDelivery =
  async (...args) => (await import('./server/judge-operational')).reserveJudgeDelivery(...args);
