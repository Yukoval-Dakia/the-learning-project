import { ApiError, errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const createStartIngestionSession: FrontdoorContext['createIngestionSession'] = ({
  body,
  key,
}) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        raw = null;
      }
      const { CreateIngestionSessionBody, createIngestionSession } = await import(
        '@/capabilities/ingestion/public'
      );
      const parsed = CreateIngestionSessionBody.safeParse(raw);
      if (!parsed.success) {
        throw new ApiError(
          'validation_error',
          parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; '),
          400,
        );
      }
      const { db } = await import('@/db/client');
      const result = await createIngestionSession(db, parsed.data, key);
      if (result.status === 500) {
        throw Response.json(result.body, {
          status: result.status,
          headers: {
            Location: result.location,
            ...(result.replayed ? { 'Idempotency-Replayed': 'true' } : {}),
          },
        });
      }
      if (!('session' in result.body)) throw new Error('Unexpected ingestion creation result');
      return { ...result, body: result.body };
    } catch (error) {
      throw error instanceof Response ? error : errorResponse(error);
    }
  });
