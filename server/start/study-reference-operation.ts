import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const revealStartStudyReference: FrontdoorContext['revealStudyReference'] = (issuanceId) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { revealFrozenStudyReference } = await import('@/capabilities/practice/public');
      const { db } = await import('@/db/client');
      return await revealFrozenStudyReference(db, issuanceId);
    } catch (error) {
      throw errorResponse(error);
    }
  });
