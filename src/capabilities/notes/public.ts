// Stable server contract for consumers outside the notes capability.
export {
  groupBacklinksByArtifactType,
  listBacklinks,
  resolveOwningLearningItemIds,
} from './server/block-refs';
// YUK-878 — the teaching context loader (copilot capability) projects an
// artifact's body blocks into note sections; expose the single projection
// instead of a deep import into notes/server.
export { bodyBlocksToNoteSections } from './server/body-blocks';
export type { BacklinksByArtifactType } from './server/block-refs';
export {
  interactiveForKnowledge,
  notesForKnowledge,
} from './server/notes-read';
export type { NoteSummary } from './server/notes-read';
export {
  type PersistNoteRefineApplyResult,
  listNoteRefineChanges,
  persistNoteRefineApply,
  undoNoteRefineApplyEvent,
} from './server/note-refine-apply';
export {
  enqueueDreamingNoteRefine,
  enqueueMasteryNoteRefine,
} from './server/note-refine-triggers';
export { emitArtifactLifecycleEvent } from './server/artifacts/mutation-events';
export {
  activeArtifactCorrectionStatus,
  getArtifactCorrectionState,
  getArtifactCorrectionStates,
} from './server/artifact-corrections';
export type {
  ArtifactCorrectionState,
  ArtifactCorrectionStatus,
} from './server/artifact-corrections';
export type { NoteUpdateAcceptResult } from './server/proposal-accept-applier';
export { dispatchNoteGeneration, writeNoteGenerationIntent } from './server/note-handoff';
export { createLearningIntentNote } from './server/learning-intent-note';
export type {
  CreateLearningIntentNoteFn,
  CreateLearningIntentNoteInput,
} from './server/learning-intent-note';
