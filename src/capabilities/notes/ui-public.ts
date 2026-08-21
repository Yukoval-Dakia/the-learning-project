// Client-only public contribution surface.

export type { AiChangeRow } from './ui/notes-api';
export {
  getNotePage,
  undoAiChange,
} from './ui/notes-api';

export const loadNoteReaderPage = () =>
  import('./ui/NoteReaderPage').then((module) => module.default);

export const loadNotesPage = () => import('./ui/NotesPage').then((module) => module.default);
