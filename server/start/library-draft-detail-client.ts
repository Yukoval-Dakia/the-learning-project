import type { LibraryClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartLibraryDraftDetailFunction } from './library-draft-detail-function';

export const startLibraryDraftDetailClient: LibraryClient['getDraftDetail'] = async (id) =>
  JSON.parse(
    await getStartLibraryDraftDetailFunction({
      fetch: authenticatedStartFetch,
      data: id,
    }),
  );
