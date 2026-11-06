// GET /api/proposals/auto-applied: historical cards, their batch-undo state,
// and the verdict-rate snapshot.
//
// Optional `from`/`to` ISO datetimes scope the list to an explicit window; the
// summary page uses them instead of slicing a fixed trailing window client-side.

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { getAutoAppliedDigest } from '../server/auto-applied-read';

function parseBoundary(raw: string | null, field: string): Date | undefined {
  if (raw === null || raw.trim().length === 0) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError('validation_error', `${field} must be an ISO datetime`, 400);
  }
  return parsed;
}

export async function GET(req: Request): Promise<Response> {
  try {
    const query = new URL(req.url).searchParams;
    const from = parseBoundary(query.get('from'), 'from');
    const to = parseBoundary(query.get('to'), 'to');
    if (from && to && from.getTime() > to.getTime()) {
      throw new ApiError('validation_error', 'from must not be after to', 400);
    }
    return Response.json(
      await getAutoAppliedDigest(db, { ...(from ? { from } : {}), ...(to ? { to } : {}) }),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
