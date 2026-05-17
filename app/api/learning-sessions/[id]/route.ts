// Phase 1d — learning_session detail endpoint.
//
// Returns the session row + every event chained via session_id, joined with
// question prompts for review events. The UI computes per-rating stats
// client-side from this single payload (no separate aggregate query).

import { asc, eq, inArray } from 'drizzle-orm';

import { db } from '@/db/client';
import { event, learning_session, question } from '@/db/schema';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id } = await params;

    const sessRows = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, id))
      .limit(1);
    const session = sessRows[0];
    if (!session) {
      throw new ApiError('not_found', `learning_session ${id} not found`, 404);
    }

    const events = await db
      .select()
      .from(event)
      .where(eq(event.session_id, id))
      .orderBy(asc(event.created_at));

    // Join question prompt for review/attempt events (subject_kind='question').
    const questionIds = Array.from(
      new Set(events.filter((e) => e.subject_kind === 'question').map((e) => e.subject_id)),
    );
    const qById = new Map<string, { id: string; prompt_md: string; reference_md: string | null }>();
    if (questionIds.length > 0) {
      const qRows = await db
        .select({
          id: question.id,
          prompt_md: question.prompt_md,
          reference_md: question.reference_md,
        })
        .from(question)
        .where(inArray(question.id, questionIds));
      for (const q of qRows) qById.set(q.id, q);
    }

    const durationMs =
      session.ended_at && session.started_at
        ? session.ended_at.getTime() - session.started_at.getTime()
        : null;

    return Response.json({
      id: session.id,
      type: session.type,
      status: session.status,
      summary_md: session.summary_md,
      goal_id: session.goal_id,
      started_at: Math.floor(session.started_at.getTime() / 1000),
      ended_at: session.ended_at ? Math.floor(session.ended_at.getTime() / 1000) : null,
      duration_ms: durationMs,
      version: session.version,
      events: events.map((e) => ({
        id: e.id,
        action: e.action,
        actor_kind: e.actor_kind,
        actor_ref: e.actor_ref,
        subject_kind: e.subject_kind,
        subject_id: e.subject_id,
        outcome: e.outcome,
        payload: e.payload,
        caused_by_event_id: e.caused_by_event_id,
        cost_micro_usd: e.cost_micro_usd,
        created_at: Math.floor(e.created_at.getTime() / 1000),
        question: e.subject_kind === 'question' ? (qById.get(e.subject_id) ?? null) : null,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
