import type { z } from 'zod';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { type EnvelopedEvent, getEventById, getEventChain, writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import {
  EventCorrectionBodySchema,
  type EventCorrectionResponseSchema,
  EventDetailResponseSchema,
  EventParamsSchema,
} from '../api/event-contracts';

export type EventDetail = z.infer<typeof EventDetailResponseSchema>;
export type EventCorrectionInput = z.infer<typeof EventCorrectionBodySchema>;
export type EventCorrectionResult = z.infer<typeof EventCorrectionResponseSchema>;

function parseEventId(eventId: string): string {
  const parsed = EventParamsSchema.safeParse({ id: eventId });
  if (!parsed.success) {
    throw new ApiError('validation_error', 'event id is required', 400);
  }
  return parsed.data.id;
}

// Preserve every kernel envelope field, including passthrough fields, while
// making the DTO's date and undefined omission explicit for every consumer.
function eventDto(envelope: EnvelopedEvent): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({ ...envelope, created_at: envelope.created_at.toISOString() }).filter(
      ([, value]) => value !== undefined,
    ),
  );
}

export async function readEventDetail(db: Db | Tx, eventId: string): Promise<EventDetail> {
  const id = parseEventId(eventId);
  const focal = await getEventById(db, id);
  if (!focal) {
    throw new ApiError('not_found', `event ${id} not found`, 404);
  }
  const chain = await getEventChain(db, id);
  return EventDetailResponseSchema.parse({
    event: eventDto(focal),
    correction_status: focal.correction_status,
    chain: {
      caused_by: chain.caused_by === null ? null : eventDto(chain.caused_by),
      caused_events: chain.caused_events.map(eventDto),
      corrections: chain.corrections.map(eventDto),
    },
  });
}

/** Each invocation creates a fresh correction event; this is not request deduplication. */
export async function createEventCorrection(
  db: Db | Tx,
  eventId: string,
  input: unknown,
  now: Date = new Date(),
): Promise<EventCorrectionResult> {
  const id = parseEventId(eventId);
  const parsed = EventCorrectionBodySchema.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(
      'validation_error',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      400,
    );
  }
  const target = await getEventById(db, id);
  if (!target) {
    throw new ApiError('not_found', `event ${id} not found`, 404);
  }

  const correctionEventId = newId();
  await writeEvent(db, {
    id: correctionEventId,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'correct',
    subject_kind: 'event',
    subject_id: id,
    outcome: 'success',
    payload: parsed.data,
    caused_by_event_id: id,
    created_at: now,
  });
  return { correction_event_id: correctionEventId };
}
