// Client-only public contribution surface.

import { createElement } from 'react';
import { UiNextRoot } from '@/ui-next/public';
import { parseNoteBodyBlocks } from './api/contracts';
import { questionDetailHref } from './ui/NoteBlocks';
import { NoteDocBody } from './ui/NoteDocBody';

export type { AiChangeRow } from './ui/notes-api';
export {
  buildNoteQuestionsQuery,
  getNotePage,
  projectNoteQuestionsResponse,
} from './ui/notes-api';

export const loadNoteReaderPage = () =>
  import('./ui/NoteReaderPage').then((module) => module.default);

export const loadNotesPage = () => import('./ui/NotesPage').then((module) => module.default);

export { NoteListResponseSchema, NotePageJsonResponseSchema } from './api/contracts';

export function NoteBodyPreview({
  title,
  bodyBlocks,
  navigate,
}: {
  title: string;
  bodyBlocks: unknown;
  navigate: (to: string) => void;
}) {
  const body = parseNoteBodyBlocks(bodyBlocks);
  const scope = { className: 'nt-page', 'data-note-embed': '' };
  return createElement(
    UiNextRoot,
    scope,
    body
      ? createElement(NoteDocBody, {
          type: 'note_atomic',
          title,
          interactive: null,
          blocks: body.content,
          navigate,
          onOpenQuestion: (id: string) => navigate(questionDetailHref(id)),
        })
      : createElement('p', { className: 'nt-quiet' }, '正文暂时无法预览，可打开阅读器查看。'),
  );
}

export type { NoteListResponse, NoteListRow } from './ui/notes-api';
export type NoteListClient = typeof import('./ui/notes-api').listNotes;

export type NotePageClient = typeof import('./ui/notes-api').getNotePage;

export type NoteSaveClient = typeof import('./ui/notes-api').saveBodyBlocks;

export type NoteAiChangesClient = typeof import('./ui/notes-api').getAiChanges;

export type NoteReferenceSearchClient = typeof import('./ui/notes-api').searchArtifacts;

export type NoteQuestionListClient = typeof import('./ui/notes-api').questionsForKnowledge;

export type NoteEditingHeartbeatClient = typeof import('./ui/notes-api').editingHeartbeat;

export type NoteEditingBlurClient = typeof import('./ui/notes-api').editingBlur;
