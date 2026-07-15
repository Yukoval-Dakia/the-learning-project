// Capability packages consume shared domain schemas through this pure facade
// instead of reaching into core/subjects implementation paths directly.
export {
  ArtifactBodyBlocks,
  ArtifactHistoryEntry,
  CauseCategory,
  IngestionEntrypoint,
  NoteSection,
  NoteVerificationResult,
  QuestionKind,
} from '@/core/schema/business';
export { CorrectArtifactEvent } from '@/core/schema/event';
export { NudgeKind } from '@/core/schema/event/nudge-events';
export { SuggestionKind } from '@/core/schema/event/known';
export { PageSpan } from '@/core/schema/index';
export { MistakeEnrollOutcome } from '@/core/schema/mistake_enroll';
export { FigureRef, StructuredQuestion } from '@/core/schema/structured_question';
export { MAX_PDF_PAGES } from '@/core/limits';
export { SubjectProfileSchema } from '@/subjects/profile-schema';
