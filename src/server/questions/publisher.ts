// Compatibility entrypoint for the shared assessment publication engine.

export type {
  AdmissionVerificationWrite,
  ArchiveGroupLifecycleResult,
  IdentityDiff,
  PartChange,
  PublishAdmission,
  PublishFromRowInput,
  PublishQuestionGroupInput,
  PublishQuestionGroupResult,
  QuestionGroupContractSnapshot,
  ReplacementMapping,
  RestoreGroupLifecycleResult,
  SuspensionReason,
  SuspensionUpdate,
  WithheldReason,
} from '@/kernel/records/assessment-publication';
export {
  ASSESSMENT_PUBLISH_ACTION,
  archiveGroupLifecycle,
  loadQuestionGroupContractSnapshot,
  promoteVerifiedGroupPartRows,
  publishQuestionGroup,
  publishQuestionGroupFromRow,
  restoreGroupLifecycle,
} from '@/kernel/records/assessment-publication';
