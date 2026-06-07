// YUK-280 P4 (YUK-203) — GET /api/questions/[id]: the question-bank detail read.
//
// docs/superpowers/plans/2026-06-07-yuk280-question-bank-api.md §2 (A1d/A1e)
//
// Single-fetch detail aggregator (row + source_tier + labels + variant family +
// per-knowledge FSRS/decay + backlinks + timeline). Auth is enforced upstream by
// middleware (x-internal-token); the handler mirrors the sibling notes/[id] route
// (zod params, 404 on missing, errorResponse).

import { z } from 'zod';

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { loadQuestionDetail } from '@/server/questions/detail';

export const runtime = 'nodejs';

const ParamsSchema = z.object({ id: z.string().trim().min(1) });

interface RouteParams {
  params: Promise<{ id: string }>;
}

const DEFAULT_TIMELINE_LIMIT = 10;
const MAX_TIMELINE_LIMIT = 50;

function parseTimelineLimit(raw: string | null): number {
  if (raw === null || raw === '') return DEFAULT_TIMELINE_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new ApiError('validation_error', `invalid timeline_limit '${raw}'`, 400);
  }
  return Math.min(parsed, MAX_TIMELINE_LIMIT);
}

export async function GET(req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const parsed = ParamsSchema.safeParse(await params);
    if (!parsed.success) {
      throw new ApiError('validation_error', 'question id is required', 400);
    }
    const url = new URL(req.url);
    const timelineLimit = parseTimelineLimit(url.searchParams.get('timeline_limit'));

    const detail = await loadQuestionDetail(db, parsed.data.id, timelineLimit);
    if (!detail) {
      throw new ApiError('not_found', `question ${parsed.data.id} not found`, 404);
    }
    return Response.json(detail);
  } catch (err) {
    return errorResponse(err);
  }
}
