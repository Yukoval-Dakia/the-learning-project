// POST /api/goals — at-entry direct goal creation: a brand-new user declares a goal
// (with a KC scope) so the cold-start placement probe has knowledge nodes to walk.
//
// Goals are normally materialized from an accepted `goal_scope` proposal, which needs
// pre-existing evidence; this additive manual path (source='manual') does not replace
// that path — both go through the goal command owner.
//
// Constraints:
// - Only a title is required, and an empty scope is allowed (cold-start north-star).
// - A subject goal's scope is NEVER frozen at write time. The row carries scope_mode:
//   'explicit' (hand-picked frozen set is authoritative) vs 'subject_live' (readers
//   derive from subject_id at read time; frozen stays []). Freezing the derivation
//   resolves day-one to the synthetic seed root, pinning placement to it forever.

import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { goal } from '@/db/schema';
import { ApiError, errorResponse, resourceResponse } from '@/kernel/http';
import { createGoal } from '../server/goals/create';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const rows = await db.select().from(goal).where(eq(goal.id, params.id)).limit(1);
    const row = rows[0];
    if (!row) throw new ApiError('not_found', `goal ${params.id} not found`, 404);
    return Response.json(row);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new ApiError('validation_error', 'request body must be valid JSON', 400);
    }
    const result = await createGoal(db, raw);
    return resourceResponse(result, {
      outcome: 'created',
      location: `/api/goals/${encodeURIComponent(result.id)}`,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
