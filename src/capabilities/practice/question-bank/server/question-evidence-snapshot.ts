// implementation moved verbatim to
// @/kernel/read-models/question-evidence-snapshot (shared cross-capability
// read model); this file remains as an explicit compat re-export for the
// practice/public surface.

export {
  QuestionEvidenceSnapshotError,
  loadAttemptQuestionSnapshot,
  loadQuestionWithAttemptSnapshot,
} from '@/kernel/read-models/question-evidence-snapshot';
