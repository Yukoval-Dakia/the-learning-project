// Phase 1c.1 Step 6 — raw event log filter API.
//
// GET /api/events?action=X&subject_kind=Y&actor_kind=Z&actor_ref=R&limit=N&since=ISO
//   → { rows: Array<KnownEventT> }
//
// All filters optional; AND combined. Server delegates to `getEvents` in
// `src/server/events/queries.ts` which parses output via `parseEvent` — wire
// JSON is the parseEvent-valid shape (client may re-parse to validate).
//
// EventChain UI primitive prereq (v2.1).

import { z } from 'zod';

import { db } from '@/db/client';
import { type GetEventsFilter, getEvents } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

const QuerySchema = z.object({
  action: z.string().min(1).optional(),
  subject_kind: z.string().min(1).optional(),
  subject_id: z.string().min(1).optional(),
  actor_kind: z.string().min(1).optional(),
  actor_ref: z.string().min(1).optional(),
  outcome: z.string().min(1).optional(),
  since: z
    .string()
    .min(1)
    .optional()
    .refine((s) => s === undefined || !Number.isNaN(new Date(s).getTime()), {
      message: 'since must be an ISO-8601 timestamp',
    }),
  limit: z
    .string()
    .min(1)
    .optional()
    .refine((s) => s === undefined || /^\d+$/.test(s), {
      message: 'limit must be a positive integer',
    })
    .transform((s) => (s === undefined ? undefined : Number.parseInt(s, 10))),
});

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const raw: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) {
      raw[key] = value;
    }
    const parsed = QuerySchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ApiError('validation_error', message, 400);
    }

    const filter: GetEventsFilter = {};
    if (parsed.data.action) filter.action = parsed.data.action;
    if (parsed.data.subject_kind) filter.subject_kind = parsed.data.subject_kind;
    if (parsed.data.subject_id) filter.subject_id = parsed.data.subject_id;
    if (parsed.data.actor_kind) filter.actor_kind = parsed.data.actor_kind;
    if (parsed.data.actor_ref) filter.actor_ref = parsed.data.actor_ref;
    if (parsed.data.outcome) filter.outcome = parsed.data.outcome;
    if (parsed.data.since) filter.since = new Date(parsed.data.since);
    if (parsed.data.limit !== undefined) filter.limit = parsed.data.limit;

    const rows = await getEvents(db, filter);
    return Response.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}
