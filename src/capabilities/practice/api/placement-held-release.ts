// POST /api/placement-sessions/[id]/held-release.
//
// Releases the probe's currently-held issuance: an issued item whose answer was accepted
// but no judge task/settlement can complete stays 'held' forever without this exit. The
// release records the item as UNRESOLVED (a durable placement_released event) — never
// counted as wrong, never re-served — then runs the same locked advance as
// question-selections and returns the post-release selection.
//
// Exactly-once + refresh-safe: the release event id is deterministic
// (hash(sessionId, issuanceId), first-write-wins), and re-POSTing the same issuance_id
// replays the advance with replayed=true instead of 409ing. A different issuance_id
// gets 409 not_releasable — only the LIVE held item may be released, preserving the
// "never select past an unsettled original" ordering invariant.
//
// The 'end' half of the held exit needs no new route: PATCH /api/placement-sessions/[id]
// {status:'completed'} already closes the probe and now reports unresolved_items.

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { releaseHeldPlacement } from '../server/session-operations/placement-held-release';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const { id } = params;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new ApiError('validation_error', 'request body must be valid JSON', 400);
    }
    return Response.json(await releaseHeldPlacement(db, id, raw));
  } catch (err) {
    return errorResponse(err);
  }
}
