// Capability packages consume shared domain schemas through this pure facade
// instead of reaching into core/subjects implementation paths directly.
export {
  ArtifactBodyBlocks,
  ArtifactHistoryEntry,
  NoteSection,
  NoteVerificationResult,
} from '@/core/schema/business';
export { CorrectArtifactEvent } from '@/core/schema/event';
export { SubjectProfileSchema } from '@/subjects/profile-schema';
