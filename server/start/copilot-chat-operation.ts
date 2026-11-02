import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

// Copilot owns the whole acceptance (validation, idempotency replay, backlog, durable write).
export const sendStartCopilotChat: FrontdoorContext['sendCopilotChat'] = ({ body, key }, signal) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { requestCopilotChat } = await import('@/capabilities/copilot/public');
      const { db } = await import('@/db/client');
      return await requestCopilotChat(db, {
        readBody: async () => JSON.parse(body),
        idempotencyKey: key,
        signal,
      });
    } catch (error) {
      throw errorResponse(error);
    }
  });
