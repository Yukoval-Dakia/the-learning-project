export type { AdmissionProbe, ProbeOutcome } from './calibrate';
export { methodFingerprint, probeSetDigest } from './calibrate';
export type {
  AdmissionSourceAnswer,
  AdmissionUnitKind,
  AdmissionUnitSpec,
  QuestionAdmissionDefinition,
} from './contract';
export { definitionFromContract } from './definition-from-contract';
export type {
  QuestionAdmissionOptions,
  QuestionAdmissionResult,
  ResolvedAdmissionContract,
  UnitAdmissionResult,
} from './run-admission';
export {
  QUESTION_ADMISSION_POLICY_ID,
  runQuestionAdmission,
} from './run-admission';
export type { AdmissionKey, AdmissionSolveReceipt } from './solve';
