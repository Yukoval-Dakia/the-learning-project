// Stable server contract for consumers outside the notes capability.
export {
  groupBacklinksByArtifactType,
  listBacklinks,
  resolveOwningLearningItemIds,
} from './server/block-refs';
export type { BacklinksByArtifactType } from './server/block-refs';
export {
  interactiveForKnowledge,
  notesForKnowledge,
} from './server/notes-read';
export type { NoteSummary } from './server/notes-read';
export {
  listNoteRefineChanges,
  undoNoteRefineApplyEvent,
} from './server/note-refine-apply';
export {
  enqueueDreamingNoteRefine,
  enqueueMasteryNoteRefine,
} from './server/note-refine-triggers';
export type { NoteUpdateAcceptResult } from './server/proposal-accept-applier';
