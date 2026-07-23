import { db } from '@/db/client';
import { event, job_events } from '@/db/schema';
import { getCorrectionStatus } from '@/kernel/events/corrections';
import { ApiError, errorResponse } from '@/server/http/errors';
import { orchestrateCascadeRevert } from '@/server/revert/cascade-revert';
import { findReusableCopilotConversation } from '@/server/session/conversation';
import { and, eq, sql } from 'drizzle-orm';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from '../server/copilot-run-status';

export async function POST(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const checkpointEventId = params.eventId;
    const currentSession = await findReusableCopilotConversation(db);
    if (!currentSession) throw new ApiError('not_found', 'checkpoint not found', 404);

    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`copilot_revert:${checkpointEventId}`}, 0))`,
      );
      const roots = await tx
        .select({ id: event.id })
        .from(event)
        .where(
          and(
            eq(event.id, checkpointEventId),
            eq(event.action, 'experimental:copilot_user_ask'),
            eq(event.session_id, currentSession.id),
          ),
        )
        .limit(1);
      if (roots.length === 0) throw new ApiError('not_found', 'checkpoint not found', 404);

      const correction = await getCorrectionStatus(tx, checkpointEventId);
      if (correction.state === 'retracted') {
        return {
          status: 200,
          body: {
            ok: true,
            status: 'already_reverted',
            checkpoint_event_id: checkpointEventId,
            compensation_event_ids: [],
          },
        } as const;
      }

      const replies = await tx
        .select({ id: event.id })
        .from(event)
        .where(
          and(
            eq(event.action, 'experimental:copilot_reply'),
            eq(event.caused_by_event_id, checkpointEventId),
            eq(event.session_id, currentSession.id),
          ),
        )
        .limit(1);
      const terminalJobEvents = await tx
        .select({ event_type: job_events.event_type })
        .from(job_events)
        .where(
          and(
            eq(job_events.business_table, COPILOT_RUN_TABLE),
            eq(job_events.business_id, checkpointEventId),
          ),
        );
      const durableTerminal = terminalJobEvents.some(
        (row) =>
          row.event_type === COPILOT_RUN_EVENTS.DONE ||
          row.event_type === COPILOT_RUN_EVENTS.FAILED,
      );
      if (replies.length === 0 || (terminalJobEvents.length > 0 && !durableTerminal)) {
        throw new ApiError('turn_not_terminal', 'turn must be terminal before revert', 409);
      }

      const result = await orchestrateCascadeRevert(tx, checkpointEventId, {
        copilotAskOnly: true,
      });
      if (!result.ok) {
        return {
          status: result.refusal === 'no_checkpoint' ? 404 : 409,
          body: result,
        } as const;
      }
      return {
        status: 200,
        body: {
          ok: true,
          status: 'reverted',
          checkpoint_event_id: checkpointEventId,
          reverted: result.reverted,
          compensation_event_ids: result.compensationEventIds,
        },
      } as const;
    });

    return Response.json(outcome.body, { status: outcome.status });
  } catch (err) {
    return errorResponse(err);
  }
}
