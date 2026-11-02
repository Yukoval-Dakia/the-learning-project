import type { LibraryClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartLibraryQuestionMistakesFunction } from './library-question-mistakes-function';

export const startLibraryQuestionMistakesClient: LibraryClient['listQuestionMistakes'] = async (
  id,
) =>
  JSON.parse(
    await getStartLibraryQuestionMistakesFunction({
      fetch: authenticatedStartFetch,
      data: id,
    }),
  );
