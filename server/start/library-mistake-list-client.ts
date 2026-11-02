import type { LibraryClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartLibraryMistakesFunction } from './library-mistake-list-function';

export const startLibraryMistakesClient: LibraryClient['listMistakes'] = async (query) =>
  JSON.parse(
    await getStartLibraryMistakesFunction({
      fetch: authenticatedStartFetch,
      data: query.toString(),
    }),
  );
