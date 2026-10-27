import { ApiError, errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const createStartRecordManualMistake: FrontdoorContext['createRecordManualMistake'] = ({
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
      const { CreateMistakeBodySchema, createManualMistake } = await import(
        '@/capabilities/ingestion/public'
      );
      const parsed = CreateMistakeBodySchema.safeParse(raw);
      if (!parsed.success) {
        const message = parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
        throw new ApiError('validation_error', message, 400);
      }
      const { db } = await import('@/db/client');
      const result = await createManualMistake(db, parsed.data, key);
      if (result.status !== 201 || !('mistake_id' in result.body)) {
        throw new Error('Unexpected manual mistake creation result');
      }
      return { ...result, body: result.body };
    } catch (error) {
      throw errorResponse(error);
    }
  });
