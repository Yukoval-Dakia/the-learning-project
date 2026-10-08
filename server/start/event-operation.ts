import type { Db, Tx } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';

export type StartEventOptions = { database?: Db | Tx; now?: Date };

// The authenticated wrapper loads this adapter only after token and active epoch.
export async function readStartEventDetail(input: unknown, options: StartEventOptions = {}) {
  try {
    const { EventParamsSchema, readEventDetail } = await import(
      '@/capabilities/observability/public'
    );
    const params = EventParamsSchema.safeParse(input);
    if (!params.success) throw new ApiError('validation_error', 'event id is required', 400);
    const database = options.database ?? (await import('@/db/client')).db;
    return await readEventDetail(database, params.data.id);
  } catch (error) {
    throw errorResponse(error);
  }
}

export async function createStartEventCorrection(input: unknown, options: StartEventOptions = {}) {
  try {
    const { EventParamsSchema, EventCorrectionBodySchema, createEventCorrection } = await import(
      '@/capabilities/observability/public'
    );
    const params = EventParamsSchema.extend({ input: EventCorrectionBodySchema }).safeParse(input);
    if (!params.success) {
      throw new ApiError(
        'validation_error',
        params.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        400,
      );
    }
    const database = options.database ?? (await import('@/db/client')).db;
    const receipt = await createEventCorrection(
      database,
      params.data.id,
      params.data.input,
      options.now,
    );
    return {
      ...receipt,
      status: 201 as const,
      canonicalLocation: `/api/events/${encodeURIComponent(receipt.correction_event_id)}`,
    };
  } catch (error) {
    throw errorResponse(error);
  }
}
