// Capability packages consume shared domain schemas through this pure facade
// instead of reaching into core/subjects implementation paths directly.
export {
  ArtifactBodyBlocks,
  ArtifactHistoryEntry,
  NoteSection,
  NoteVerificationResult,
} from '@/core/schema/business';
export { CorrectArtifactEvent } from '@/core/schema/event';
export { NudgeKind } from '@/core/schema/event/nudge-events';
export { SuggestionKind } from '@/core/schema/event/known';
export { SubjectProfileSchema } from '@/subjects/profile-schema';
