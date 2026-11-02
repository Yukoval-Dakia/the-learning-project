import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const submitStartPaperSlot: FrontdoorContext['submitPaperSlot'] = ({ sessionId, body }) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      let raw: unknown = null;
      try {
        raw = JSON.parse(body);
      } catch {
        // Preserve the canonical HTTP malformed-JSON input to the original schema.
      }
      const { createPracticePaperSubmission } = await import('@/capabilities/practice/public');
      const { db } = await import('@/db/client');
      return await createPracticePaperSubmission(db, sessionId, raw);
    } catch (error) {
      throw errorResponse(error);
    }
  });
