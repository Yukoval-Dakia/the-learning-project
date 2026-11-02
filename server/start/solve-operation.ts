import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const createStartSolveSession: FrontdoorContext['createSolveSession'] = (body) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        raw = null;
      }
      const { createPracticeSolveSession } = await import('@/capabilities/practice/public');
      const { db } = await import('@/db/client');
      return await createPracticeSolveSession(db, raw);
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const createStartHintRequest: FrontdoorContext['createHintRequest'] = ({
  sessionId,
  body,
}) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        raw = null;
      }
      const { createPracticeHintRequest } = await import('@/capabilities/practice/public');
      const { db } = await import('@/db/client');
      return await createPracticeHintRequest(db, sessionId, raw);
    } catch (error) {
      throw errorResponse(error);
    }
  });
