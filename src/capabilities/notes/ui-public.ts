// Client-only public contribution surface.
export {
  getNotePage,
  undoAiChange,
} from './ui/notes-api';
export type { AiChangeRow } from './ui/notes-api';

export const loadNoteReaderPage = () =>
  import('./ui/NoteReaderPage').then((module) => module.default);
