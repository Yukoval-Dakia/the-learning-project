// Client-only public contribution surface.

export type { AiChangeRow } from './ui/notes-api';
export {
  getNotePage,
  undoAiChange,
} from './ui/notes-api';

export const loadNoteReaderPage = () =>
  import('./ui/NoteReaderPage').then((module) => module.default);

export const loadNotesPage = () => import('./ui/NotesPage').then((module) => module.default);

export { NoteListResponseSchema, NotePageJsonResponseSchema } from './api/contracts';
export type { NoteListResponse, NoteListRow } from './ui/notes-api';
export type NoteListClient = typeof import('./ui/notes-api').listNotes;

export type NotePageClient = typeof import('./ui/notes-api').getNotePage;

export type NoteSaveClient = typeof import('./ui/notes-api').saveBodyBlocks;

export type NoteAiChangesClient = typeof import('./ui/notes-api').getAiChanges;
