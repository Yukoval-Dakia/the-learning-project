import type { LibraryClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import {
  enableStartLibraryDraftFunction,
  forceEnableStartLibraryDraftFunction,
} from './library-draft-promotion-function';

export const startLibraryDraftEnableClient: LibraryClient['enableDraft'] = async (id) =>
  JSON.parse(
    await enableStartLibraryDraftFunction({
      fetch: authenticatedStartFetch,
      data: { id },
    }),
  );

export const startLibraryDraftForceEnableClient: LibraryClient['forceEnableDraft'] = async (
  id,
  reason,
) =>
  JSON.parse(
    await forceEnableStartLibraryDraftFunction({
      fetch: authenticatedStartFetch,
      data: { id, body: JSON.stringify({ reason }) },
    }),
  );
