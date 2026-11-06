import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
export const updateStartPracticeStreamItem = ({ id, body }: { id: string; body: string }) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      let raw: unknown = null;
      try {
        raw = JSON.parse(body);
      } catch {
        // Preserve the HTTP adapter's malformed-JSON input to the shared schema.
      }
      const { updatePracticeStreamItem } = await import(
        '@/capabilities/practice/scheduling/public'
      );
      const { db } = await import('@/db/client');
      return await updatePracticeStreamItem(db, id, raw);
    } catch (error) {
      throw errorResponse(error);
    }
  });
