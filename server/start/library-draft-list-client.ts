import type { LibraryClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartLibraryDraftsFunction } from './library-draft-list-function';

export const startLibraryDraftsClient: LibraryClient['getReviewDrafts'] = async (query) =>
  JSON.parse(
    await getStartLibraryDraftsFunction({
      fetch: authenticatedStartFetch,
      data: query,
    }),
  );
