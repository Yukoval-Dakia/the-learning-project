// YUK-203 P1 (ADR-0027) — note(artifact) reads by knowledge label.
//
// YUK-1571 — implementation moved verbatim to
// @/kernel/read-models/notes-read (shared cross-capability read model);
// this file remains as an explicit compat re-export for notes-internal
// consumers and the notes/public surface.

export type {
  ItemNote,
  LearningItemNoteRefs,
  NoteSummary,
} from '@/kernel/read-models/notes-read';
export {
  interactiveForKnowledge,
  listNotes,
  notesForItem,
  notesForKnowledge,
} from '@/kernel/read-models/notes-read';
