import type { LibraryClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { updateStartLibraryQuestionFunction } from './library-question-update-function';

export const startLibraryQuestionUpdateClient: LibraryClient['patchQuestion'] = async (id, body) =>
  JSON.parse(
    await updateStartLibraryQuestionFunction({
      fetch: authenticatedStartFetch,
      data: { id, body: JSON.stringify(body) },
    }),
  );
