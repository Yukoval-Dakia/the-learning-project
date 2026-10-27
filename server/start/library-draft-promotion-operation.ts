import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const enableStartLibraryDraft: FrontdoorContext['enableLibraryDraft'] = (id) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { enablePracticeDraft } = await import('@/capabilities/practice/public');
      const { db } = await import('@/db/client');
      return await enablePracticeDraft(db, { id });
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const forceEnableStartLibraryDraft: FrontdoorContext['forceEnableLibraryDraft'] = ({
  id,
  body,
}) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { forceEnablePracticeDraft } = await import('@/capabilities/practice/public');
      const { db } = await import('@/db/client');
      return await forceEnablePracticeDraft(db, { id }, async () => JSON.parse(body));
    } catch (error) {
      throw errorResponse(error);
    }
  });
