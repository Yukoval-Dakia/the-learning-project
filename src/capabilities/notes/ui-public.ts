// Client-only public contribution surface.

export type { AiChangeRow } from './ui/notes-api';
export {
  buildNoteQuestionsQuery,
  getNotePage,
  projectNoteQuestionsResponse,
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

export type NoteReferenceSearchClient = typeof import('./ui/notes-api').searchArtifacts;

export type NoteQuestionListClient = typeof import('./ui/notes-api').questionsForKnowledge;
