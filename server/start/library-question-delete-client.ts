import {
  type LibraryClient,
  projectQuestionDeleteResponse,
} from '@/capabilities/practice/ui-public';
import { ApiError } from '@/ui/lib/api';
import { authenticatedStartFetch } from './authenticated-fetch';
import { archiveStartLibraryQuestionFunction } from './library-question-delete-function';

export const startLibraryQuestionDeleteClient: LibraryClient['deleteQuestion'] = async (
  id,
  opts = {},
) => {
  const sp = new URLSearchParams();
  if (opts.confirm) sp.set('confirm', 'true');
  if (opts.confirmChildren) sp.set('confirm_children', 'true');
  if (opts.version != null) sp.set('version', String(opts.version));

  let body: unknown;
  try {
    body = JSON.parse(
      await archiveStartLibraryQuestionFunction({
        fetch: authenticatedStartFetch,
        data: { id, query: sp.toString() },
      }),
    );
  } catch (error) {
    if (error instanceof ApiError) {
      return projectQuestionDeleteResponse(
        { status: error.status, ok: false, statusText: '' },
        { ...error.details, error: error.code, message: error.message },
        opts.fallbackChildren ?? 0,
      );
    }
    throw error;
  }
  return projectQuestionDeleteResponse(
    { status: 200, ok: true, statusText: 'OK' },
    body,
    opts.fallbackChildren ?? 0,
  );
};
