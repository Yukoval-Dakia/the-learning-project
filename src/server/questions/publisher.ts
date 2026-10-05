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
  ReplacementMapping,
  RestoreGroupLifecycleResult,
  SuspensionReason,
  SuspensionUpdate,
  WithheldReason,
} from '@/kernel/records/assessment-publication';
export {
  ASSESSMENT_PUBLISH_ACTION,
  archiveGroupLifecycle,
  publishQuestionGroup,
  publishQuestionGroupFromRow,
  restoreGroupLifecycle,
} from '@/kernel/records/assessment-publication';
