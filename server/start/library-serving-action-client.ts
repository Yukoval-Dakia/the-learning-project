import type { LibraryClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { runStartLibraryServingActionFunction } from './library-serving-action-function';

export const startLibraryServingActionClient: LibraryClient['runServingAction'] = async (
  action,
  idempotencyKey,
) =>
  JSON.parse(
    await runStartLibraryServingActionFunction({
      fetch: authenticatedStartFetch,
      headers: { 'Idempotency-Key': idempotencyKey },
      data: { path: action.path },
    }),
  );
