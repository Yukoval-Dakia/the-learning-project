import {
  type LibraryClient,
  buildQuestionsListQuery,
  projectQuestionsListResponse,
} from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartLibraryQuestionsFunction } from './library-question-list-function';

export const startLibraryQuestionsClient: LibraryClient['getQuestionsList'] = async (filters) =>
  projectQuestionsListResponse(
    JSON.parse(
      await getStartLibraryQuestionsFunction({
        fetch: authenticatedStartFetch,
        data: buildQuestionsListQuery(filters),
      }),
    ),
  );
