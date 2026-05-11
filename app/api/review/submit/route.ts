import { createId } from '@paralleldrive/cuid2';
import { z } from 'zod';

import { FsrsRating, FsrsState } from '@/core/schema/business';
import { db } from '@/db/client';
import { mistake, review_event } from '@/db/schema';
import { ApiError, errorResponse } from '@/server/http/errors';
import { scheduleReview } from '@/server/review/fsrs';
import { and, eq } from 'drizzle-orm';

type FsrsStateData = z.infer<typeof FsrsState>;

/** Serialize FsrsState for JSONB storage: convert Date fields to ISO strings. */
function serializeState(s: FsrsStateData): Record<string, unknown> {
  return {
    ...s,
    due: s.due instanceof Date ? s.due.toISOString() : s.due,
    last_review:
      s.last_review instanceof Date ? s.last_review.toISOString() : (s.last_review ?? null),
  };
}

export const runtime = 'nodejs';

const SubmitBody = z.object({
  mistake_id: z.string().min(1),
  rating: FsrsRating,
  response_md: z.string().nullable().optional(),
  latency_ms: z.number().int().min(0).max(3_600_000).nullable().optional(),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = SubmitBody.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ApiError('validation_error', message, 400);
    }
    const body = parsed.data;
    const now = new Date();

    // Fetch the mistake
    const rows = await db
      .select({
        id: mistake.id,
        fsrs_state: mistake.fsrs_state,
        version: mistake.version,
        archived_at: mistake.archived_at,
        deleted_at: mistake.deleted_at,
      })
      .from(mistake)
      .where(eq(mistake.id, body.mistake_id))
      .limit(1);

    const row = rows[0];
    if (!row || row.archived_at !== null || row.deleted_at !== null) {
      throw new ApiError('not_found', `mistake ${body.mistake_id} not found`, 404);
    }

    // Parse and schedule FSRS
    let prevState: ReturnType<typeof FsrsState.parse> | null;
    let result: ReturnType<typeof scheduleReview>;
    try {
      prevState = row.fsrs_state ? FsrsState.parse(row.fsrs_state) : null;
      result = scheduleReview(prevState, body.rating, now);
    } catch (err) {
      console.error('review submit prep failed', { mistakeId: body.mistake_id, err });
      throw new ApiError(
        'corrupt_state',
        `mistake ${body.mistake_id} fsrs_state could not be parsed; please reset this mistake`,
        422,
      );
    }

    const dueBefore = prevState ? prevState.due : null;
    const eventId = createId();

    // Atomic transaction: update mistake (optimistic) + insert review_event
    let updateChanges = 0;
    let eventRow: typeof review_event.$inferSelect | null = null;

    await db.transaction(async (tx) => {
      // Optimistic concurrency: update only if version matches
      const updateResult = await tx
        .update(mistake)
        .set({
          fsrs_state: serializeState(result.nextState) as FsrsStateData,
          updated_at: now,
          version: row.version + 1,
        })
        .where(and(eq(mistake.id, body.mistake_id), eq(mistake.version, row.version)));

      // postgres-js drizzle returns rowCount on the result
      updateChanges = (updateResult as { count?: number }).count ?? 0;

      // Always insert review_event for audit trail (even on version mismatch)
      const inserted = await tx
        .insert(review_event)
        .values({
          id: eventId,
          mistake_id: body.mistake_id,
          rating: body.rating,
          response_md: body.response_md ?? null,
          latency_ms: body.latency_ms ?? null,
          fsrs_state_before: prevState ? (serializeState(prevState) as FsrsStateData) : undefined,
          fsrs_state_after: serializeState(result.nextState) as FsrsStateData,
          due_at_before: dueBefore,
          due_at_next: result.dueAt,
          created_at: now,
        })
        .returning();

      eventRow = inserted[0] ?? null;
    });

    if (updateChanges !== 1) {
      throw new ApiError(
        'conflict',
        `mistake ${body.mistake_id} was concurrently modified (audit logged)`,
        409,
      );
    }

    return Response.json({
      next_due_at: Math.floor(result.dueAt.getTime() / 1000),
      new_state: result.nextState,
      review_event: eventRow,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
