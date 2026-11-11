// Stable server contract for consumers outside the notes capability.

export type { NoteEntityCard } from '@/kernel/read-models/note-card';
export {
  isNoteCardVisible,
  readNoteEntityCard,
} from '@/kernel/read-models/note-card';
export {
  EditArtifactBodyBlocksBodySchema,
  NoteIdParamsSchema,
  NoteListQuerySchema,
  NoteListResponseSchema,
} from './api/contracts';
export {
  listArtifactAiChanges,
  readRecentAiChanges,
  undoArtifactAiChange,
} from './server/ai-change-request';
export type {
  ArtifactCorrectionState,
  ArtifactCorrectionStatus,
} from './server/artifact-corrections';
export {
  activeArtifactCorrectionStatus,
  getArtifactCorrectionState,
  getArtifactCorrectionStates,
} from './server/artifact-corrections';
export { searchArtifactReferences } from './server/artifact-reference-search';
export { emitArtifactLifecycleEvent } from './server/artifacts/mutation-events';
export type { BacklinksByArtifactType } from './server/block-refs';
export {
  groupBacklinksByArtifactType,
  listBacklinks,
  resolveOwningLearningItemIds,
} from './server/block-refs';
export { editArtifactBodyBlocks } from './server/body-blocks-edit';
// Notes owns the consumer-effective facts for its config keys; the composition
// root folds them into GET /api/admin/config.
export { notesConfigEffectiveFacts } from './server/config-effective-facts';
export { requestEditingBlur, requestEditingHeartbeat } from './server/editing-request';
export { installNotesHostOperations } from './server/host-operations';
export type { NoteListQuery, NoteListResponse } from './server/note-list-read';
export { loadNoteList } from './server/note-list-read';
export { loadNotePage } from './server/note-page';
export { enqueueMasteryNoteRefine, enqueueNoteRefineTrigger } from './server/note-refine-triggers';
export type { NoteSummary } from './server/notes-read';
export {
  interactiveForKnowledge,
  listNotes,
  notesForKnowledge,
} from './server/notes-read';
export type { NoteUpdateAcceptResult } from './server/proposal-accept-applier';
export { archiveProposalArtifacts } from './server/proposal-artifacts';
export type { ProposalNoteUndoFacts } from './server/undo-usage';
export {
  knowledgeNodesWithNoteLabels,
  lockProposalNoteArtifacts,
  readProposalNoteUndoFacts,
} from './server/undo-usage';
// Task composition uses the narrow task-public entry, not this barrel.
export { notesTaskSpecs } from './task-public';
