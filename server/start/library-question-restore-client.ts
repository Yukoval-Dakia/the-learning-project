import type { LibraryClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { restoreStartLibraryQuestionFunction } from './library-question-restore-function';

export const startLibraryQuestionRestoreClient: LibraryClient['restoreQuestion'] = async (
  id,
  version,
) =>
  JSON.parse(
    await restoreStartLibraryQuestionFunction({
      fetch: authenticatedStartFetch,
      data: { id, body: JSON.stringify({ version }) },
    }),
  );
