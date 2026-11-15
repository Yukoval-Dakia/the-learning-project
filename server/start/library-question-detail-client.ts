import type { LibraryClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import {
  getStartLibraryPublishedQuestionVersionFunction,
  getStartLibraryQuestionDetailFunction,
} from './library-question-detail-function';

export const startLibraryQuestionDetailClient: LibraryClient['getQuestionFull'] = async (id) =>
  JSON.parse(
    await getStartLibraryQuestionDetailFunction({
      fetch: authenticatedStartFetch,
      data: id,
    }),
  );

export const startLibraryPublishedQuestionVersionClient: Required<
  Pick<LibraryClient, 'getPublishedQuestionVersion'>
> = {
  getPublishedQuestionVersion: async (id) =>
    JSON.parse(
      await getStartLibraryPublishedQuestionVersionFunction({
        fetch: authenticatedStartFetch,
        data: id,
      }),
    ),
};
