import type { LibraryClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartLibraryQuestionDetailFunction } from './library-question-detail-function';

export const startLibraryQuestionDetailClient: LibraryClient['getQuestionFull'] = async (id) =>
  JSON.parse(
    await getStartLibraryQuestionDetailFunction({
      fetch: authenticatedStartFetch,
      data: id,
    }),
  );
