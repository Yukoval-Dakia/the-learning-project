import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const acceptStartTeachingChip: FrontdoorContext['acceptTeachingChip'] = ({
  sessionId,
  body,
}) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { requestTeachingChipAcceptance } = await import('@/capabilities/copilot/public');
      const { db } = await import('@/db/client');
      return await requestTeachingChipAcceptance(db, { id: sessionId }, async () =>
        JSON.parse(body),
      );
    } catch (error) {
      throw errorResponse(error);
    }
  });
