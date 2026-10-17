// Assessment runtime assembly: model execution and atomic learning activation.

export { type ActivateEvaluationRequestT, activateEvaluation } from './activate';
export { createJevModelExecutor } from './jev-model-executor';
export { snapshotAssessmentLearningScope } from './learning-scope';
// YUK-1496 C2 — 准入切片登记处（服务门读面 + 显式注册/退役）。
export {
  type GroupSubjectLookup,
  ModelSliceRegistrationError,
  type RegisterModelAdmissionSliceInput,
  assertModelAdmissionSliceRegistrable,
  currentModelPins,
  lookupGroupSubjects,
  modelSliceIdFor,
  registerModelAdmissionSlice,
  resolveModelAdmissionContext,
  retireModelAdmissionSlice,
} from './model-slice-registry';
export { createPiModelExecutor } from './pi-model-executor';
export {
  ASSESSMENT_RUBRIC_TASK_KIND,
  createRubricModelExecutor,
} from './rubric-model-executor';
export { type SettlementObservers, learningSettlement, withdrawCapturedOccurrence } from './settle';
