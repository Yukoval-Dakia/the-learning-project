export { listNoteRefineChanges } from '@/kernel/read-models/note-refine-changes';
// Stable server contract for consumers outside the notes capability.

export {
  EditArtifactBodyBlocksBodySchema,
  NoteIdParamsSchema,
  NoteListQuerySchema,
  NoteListResponseSchema,
} from './api/contracts';
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
// The teaching context loader projects body blocks into note sections; expose
// that one projection instead of letting other capabilities deep-import.
export { bodyBlocksToNoteSections } from './server/body-blocks';
export { editArtifactBodyBlocks } from './server/body-blocks-edit';
// Notes owns the consumer-effective facts for its config keys; the composition
// root folds them into GET /api/admin/config.
export { notesConfigEffectiveFacts } from './server/config-effective-facts';
export type { NoteListQuery, NoteListResponse } from './server/note-list-read';
export { loadNoteList } from './server/note-list-read';
export { loadNotePage } from './server/note-page';
export { undoNoteRefineApplyEvent } from './server/note-refine-apply';
export {
  enqueueDreamingNoteRefine,
  enqueueMasteryNoteRefine,
  enqueueNoteRefineTrigger,
} from './server/note-refine-triggers';
export {
  type RunNoteVerifyResult,
  type RunTaskFn,
  runNoteVerify,
} from './server/note-verify-durable-operation';
export type { NoteSummary } from './server/notes-read';
export {
  interactiveForKnowledge,
  listNotes,
  notesForKnowledge,
} from './server/notes-read';
export { buildNoteVerificationControlAdmission } from './server/paid-effect-note-admission';
export {
  NOTE_VERIFY_OBLIGATION_FAMILY,
  countNoteVerifyClaimObligations,
} from './server/paid-effect-note-obligations';
export type { NoteUpdateAcceptResult } from './server/proposal-accept-applier';
export { archiveProposalArtifacts } from './server/proposal-artifacts';
// Task composition uses the narrow task-public entry, not this barrel.
export { notesTaskSpecs } from './task-public';
