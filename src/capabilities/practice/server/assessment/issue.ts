// Shared issuance persistence; keep existing practice imports compatible.
export type {
  IssueAssessmentRequest,
  IssueAssessmentResult,
} from '@/kernel/records/assessment-issuance';
export {
  ASSESSMENT_ISSUANCE_ACTION,
  ASSESSMENT_ISSUANCE_VERSION,
  issuanceRowToContract,
  issueAssessment,
  readObservedAdmissionGeneration,
  revisionRowToContract,
} from '@/kernel/records/assessment-issuance';
