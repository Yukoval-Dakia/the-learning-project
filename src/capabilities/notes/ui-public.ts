// Client-only public contribution surface.

export type { AiChangeRow } from './ui/notes-api';
export {
  getNotePage,
  undoAiChange,
} from './ui/notes-api';

export const loadNoteReaderPage = () =>
  import('./ui/NoteReaderPage').then((module) => module.default);

export const loadNotesIndexPage = () =>
  import('./ui/NotesIndexPage').then((module) => module.default);
