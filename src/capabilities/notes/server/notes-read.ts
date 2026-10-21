// Compat re-export: the implementation lives in the shared kernel read model,
// but notes-internal consumers and notes/public keep this path.

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
