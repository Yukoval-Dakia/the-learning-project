import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
export const readStartLibraryMistakes = (query: string) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readMistakes } = await import('@/capabilities/ingestion/public');
      const { db } = await import('@/db/client');
      const raw: Record<string, string> = {};
      for (const [key, value] of new URLSearchParams(query).entries()) raw[key] = value;
      return await readMistakes(db, raw);
    } catch (error) {
      throw errorResponse(error);
    }
  });
