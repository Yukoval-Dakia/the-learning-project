// YUK-58 — review feedback attempt timeline.
//
// GET /api/questions/[id]/timeline?limit=10
//
// Returns the recent attempt + review history for one question, with chained
// judge cause hydrated onto attempts. Timestamps are unix seconds (number) to
// match the rest of /api/* and avoid the "Date as JSON string" drift PR #122
// flagged on the original YUK-58 plan.

import { db } from '@/db/client';
import { getQuestionTimeline } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

type RouteParams = { params: Promise<{ id: string }> };

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function parseLimit(raw: string | null): number {
  if (raw === null || raw === '') return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new ApiError('validation_error', `invalid limit '${raw}'`, 400);
  }
  return Math.min(parsed, MAX_LIMIT);
}

export async function GET(req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id } = await params;
    if (!id) throw new ApiError('validation_error', 'question id required', 400);

    const url = new URL(req.url);
    const limit = parseLimit(url.searchParams.get('limit'));

    const entries = await getQuestionTimeline(db, id, limit);

    return Response.json({
      question_id: id,
      events: entries.map((entry) => {
        const base = {
          event_id: entry.event_id,
          // unix seconds — JSON-safe, matches /api/records/[id] + learning-sessions
          created_at_sec: Math.floor(entry.created_at.getTime() / 1000),
        };
        if (entry.kind === 'attempt') {
          return {
            kind: 'attempt' as const,
            ...base,
            outcome: entry.outcome,
            duration_ms: entry.duration_ms,
            cause: entry.cause,
          };
        }
        return {
          kind: 'review' as const,
          ...base,
          fsrs_rating: entry.fsrs_rating,
          outcome: entry.outcome,
          duration_ms: entry.duration_ms,
        };
      }),
      computed_at_sec: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
