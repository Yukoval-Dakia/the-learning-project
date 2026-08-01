import { persistCopilotRunCancellationMarker } from '@/capabilities/copilot/server/copilot-run-cancellation';
import { acquireCopilotExecutionSettlementLock } from '@/capabilities/copilot/server/copilot-run-coordination';
import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
  hasCancelRequest,
  isCopilotRunTerminalEvent,
} from '@/capabilities/copilot/server/copilot-run-status';
import {
  readCopilotDurableAcceptanceByRunId,
  withCopilotDurableDispatchLock,
} from '@/capabilities/copilot/server/durable-dispatch';
import { db } from '@/db/client';
import { event, job_events } from '@/db/schema';
import { ApiError, errorResponse } from '@/kernel/http';
import { writeJobEvent } from '@/server/events/writer';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { ZodError } from 'zod';
import { CopilotRunParamsSchema } from './contracts';

type CancelRunStatus = 'cancel_requested' | 'cancelled' | 'already_requested' | 'already_settled';

function response(runId: string, status: CancelRunStatus): Response {
  return Response.json({ ok: true, run_id: runId, status });
}

/** Request cooperative cancellation of one accepted durable Copilot run. */
export async function POST(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const { id: runId } = CopilotRunParamsSchema.parse(params);
    const status = await withCopilotDurableDispatchLock(db, runId, async (tx) => {
      // Lock order is always dispatch -> settlement. The worker's paid loop
      // holds neither lock; only its fence and short outcome commit do.
      await acquireCopilotExecutionSettlementLock(tx, runId);

      const acceptance = await readCopilotDurableAcceptanceByRunId(tx, runId);
      if (!acceptance) throw new ApiError('not_found', 'copilot run not found', 404);

      // A QUEUED row alone is not enough: bind the public handle back to the
      // canonical user ask and its fixed conversation session.
      const roots = await tx
        .select({ id: event.id })
        .from(event)
        .where(
          and(
            eq(event.id, runId),
            eq(event.action, 'experimental:copilot_user_ask'),
            eq(event.session_id, acceptance.sessionId),
          ),
        )
        .limit(1);
      if (roots.length === 0) throw new ApiError('not_found', 'copilot run not found', 404);

      const events = await tx
        .select({
          id: job_events.id,
          event_type: job_events.event_type,
          payload: job_events.payload,
        })
        .from(job_events)
        .where(
          and(eq(job_events.business_table, COPILOT_RUN_TABLE), eq(job_events.business_id, runId)),
        )
        .orderBy(asc(job_events.id));

      if (events.some(isCopilotRunTerminalEvent)) return 'already_settled' as const;

      // The domain outcome is authoritative even when its public DONE/FAILED
      // suffix has not yet been projected.
      const markers = await tx
        .select({ id: event.id })
        .from(event)
        .where(
          and(
            eq(event.action, 'experimental:copilot_reply'),
            eq(event.caused_by_event_id, runId),
            inArray(event.outcome, ['success', 'failure']),
          ),
        )
        .limit(1);
      if (markers.length > 0) return 'already_settled' as const;

      const executionStarted = events.some(
        (item) => item.event_type === COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      );
      const queued = events.find((item) => item.event_type === COPILOT_RUN_EVENTS.QUEUED);
      const actorRef =
        queued?.payload.triggered_by === 'chip' ? 'agent:copilot_chip' : 'agent:copilot';
      if (hasCancelRequest(events)) {
        // A pre-fence orphan request can only come from legacy/manual data: a
        // normal endpoint call writes request + terminal in this transaction.
        if (!executionStarted) {
          await persistCopilotRunCancellationMarker(tx, {
            runId,
            sessionId: acceptance.sessionId,
            actorRef,
            checkpointSafe: true,
          });
          await writeJobEvent(tx, {
            business_table: COPILOT_RUN_TABLE,
            business_id: runId,
            event_type: COPILOT_RUN_EVENTS.FAILED,
            payload: {
              reason: 'cancelled',
              cancelled_before_start: true,
              checkpoint_event_id: runId,
            },
          });
          return 'cancelled' as const;
        }
        return 'already_requested' as const;
      }

      await writeJobEvent(tx, {
        business_table: COPILOT_RUN_TABLE,
        business_id: runId,
        event_type: COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
        payload: { requested_by: 'user', requested_at: new Date().toISOString() },
      });

      if (executionStarted) return 'cancel_requested' as const;

      // The shared dispatch lock makes this atomic with the paid-execution
      // fence: once this commits, the worker cannot enter model/tool execution.
      await persistCopilotRunCancellationMarker(tx, {
        runId,
        sessionId: acceptance.sessionId,
        actorRef,
        checkpointSafe: true,
      });
      await writeJobEvent(tx, {
        business_table: COPILOT_RUN_TABLE,
        business_id: runId,
        event_type: COPILOT_RUN_EVENTS.FAILED,
        payload: {
          reason: 'cancelled',
          cancelled_before_start: true,
          checkpoint_event_id: runId,
        },
      });
      return 'cancelled' as const;
    });

    return response(runId, status);
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(
        new ApiError('validation_error', err.issues.map((issue) => issue.message).join('; '), 400),
      );
    }
    return errorResponse(err);
  }
}
