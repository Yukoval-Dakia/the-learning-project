import type { z } from 'zod';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { type EnvelopedEvent, getEventById, getEventChain, writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import {
  INTERACTIVE_ARTIFACT_TOOL_NAMES,
  redactInteractiveArtifactToolInput,
  stripInteractiveAnswerAttributes,
} from '@/kernel/learning-content';
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

// Keep every envelope field, including passthrough, and make date/undefined explicit.
function eventDto(envelope: EnvelopedEvent): Record<string, unknown> {
  const dto = Object.fromEntries(
    Object.entries({ ...envelope, created_at: envelope.created_at.toISOString() }).filter(
      ([, value]) => value !== undefined,
    ),
  );
  // YUK-1763 — the tool_use mirror payload carries the authoring tool's FULL
  // args (html with answer attributes + the answer manifest); the event detail
  // page renders payloads verbatim, so redact before serving. Storage untouched.
  if (envelope.action === 'tool_use') {
    const payload = envelope.payload;
    if (
      payload !== null &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      typeof (payload as Record<string, unknown>).tool_name === 'string' &&
      INTERACTIVE_ARTIFACT_TOOL_NAMES.has((payload as Record<string, unknown>).tool_name as string)
    ) {
      const record = payload as Record<string, unknown>;
      const args = record.args;
      dto.payload = {
        ...record,
        ...(args !== null && typeof args === 'object' && !Array.isArray(args)
          ? { args: redactInteractiveArtifactToolInput(args as Record<string, unknown>) }
          : {}),
      };
    }
  }
  // The artifact create / lifecycle events carry the stored artifact attrs, whose
  // `html` holds the same answer attributes (row.attrs.html / attrs.html).
  if (
    envelope.action === 'experimental:artifact_create' ||
    envelope.action === 'experimental:artifact_lifecycle'
  ) {
    dto.payload = stripArtifactAttrsHtml(dto.payload);
  }
  return dto;
}

function stripAttrsHtml(attrs: unknown): unknown {
  if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs)) return attrs;
  const record = attrs as Record<string, unknown>;
  return typeof record.html === 'string'
    ? { ...record, html: stripInteractiveAnswerAttributes(record.html) }
    : record;
}

function stripArtifactAttrsHtml(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record };
  if ('attrs' in record) next.attrs = stripAttrsHtml(record.attrs);
  const row = record.row;
  if (row !== null && typeof row === 'object' && !Array.isArray(row)) {
    const rowRecord = row as Record<string, unknown>;
    next.row =
      'attrs' in rowRecord ? { ...rowRecord, attrs: stripAttrsHtml(rowRecord.attrs) } : rowRecord;
  }
  return next;
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

/** Every call creates a fresh correction event; this is not request deduplication. */
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
