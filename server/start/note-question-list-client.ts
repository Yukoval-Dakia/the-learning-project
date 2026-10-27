import {
  type NoteQuestionListClient,
  buildNoteQuestionsQuery,
  projectNoteQuestionsResponse,
} from '@/capabilities/notes/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartLibraryQuestionsFunction } from './library-question-list-function';

export const startNoteQuestionListClient: NoteQuestionListClient = async (knowledgeIds, limit) =>
  projectNoteQuestionsResponse(
    JSON.parse(
      await getStartLibraryQuestionsFunction({
        fetch: authenticatedStartFetch,
        data: buildNoteQuestionsQuery(knowledgeIds, limit),
      }),
    ),
  );
