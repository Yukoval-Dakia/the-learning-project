import { db } from '@/db/client';
import { event, job_events } from '@/db/schema';
import { getCorrectionStatus } from '@/kernel/events/corrections';
import { acquireLearningStateWriteLock } from '@/server/advisory-locks';
import { ApiError, errorResponse } from '@/server/http/errors';
import {
  COPILOT_REPLY_ACTION,
  COPILOT_USER_ASK_ACTION,
  orchestrateCascadeRevert,
} from '@/server/revert/cascade-revert';
import {
  findReusableCopilotConversation,
  lockCopilotSessionSelection,
} from '@/server/session/conversation';
import { and, eq, sql } from 'drizzle-orm';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from '../server/copilot-run-status';
import { CopilotCheckpointParamsSchema } from './contracts';

export async function POST(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const { eventId: checkpointEventId } = CopilotCheckpointParamsSchema.parse(params);
    const outcome = await db.transaction(async (tx) => {
      await lockCopilotSessionSelection(tx);
      const currentSession = await findReusableCopilotConversation(tx);
      if (!currentSession) throw new ApiError('not_found', 'checkpoint not found', 404);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`copilot_revert:${checkpointEventId}`}, 0))`,
      );
      // YUK-497 review F1 — global learning-state write lock G, acquired immediately after the
      // per-checkpoint idempotency lock and BEFORE any state row access, so this tx is G-first
      // (G → rows). Without it the cascade pre-check's FOR NO KEY UPDATE row locks would precede
      // G and invert against a concurrent learning-state writer (which takes G → rows).
      await acquireLearningStateWriteLock(tx);
      const roots = await tx
        .select({ id: event.id })
        .from(event)
        .where(
          and(
            eq(event.id, checkpointEventId),
            eq(event.action, COPILOT_USER_ASK_ACTION),
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
            eq(event.action, COPILOT_REPLY_ACTION),
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
      // YUK-497 review F6 — two distinct not-terminal conditions, previously conflated under
      // one 409. Keep both 409 but name the cause so the client (and forensics) can tell them
      // apart: (a) no reply persisted yet = the turn is still in flight; (b) a durable run
      // shadow exists but has not reached DONE/FAILED = the async job is mid-run.
      if (replies.length === 0) {
        throw new ApiError('turn_not_terminal', 'turn not complete yet — no reply persisted', 409);
      }
      if (terminalJobEvents.length > 0 && !durableTerminal) {
        throw new ApiError(
          'turn_shadow_not_terminal',
          'durable run shadow not terminal yet — cannot revert',
          409,
        );
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
          // YUK-497 review F7 — snake_case wire shape (the orchestrator's internal camelCase
          // domain type is mapped here at the HTTP boundary, matching house response style).
          reverted: {
            snapshots_restored: result.reverted.snapshotsRestored,
            structural_rows_archived: result.reverted.structuralRowsArchived,
            event_layer_compensated: result.reverted.eventLayerCompensated,
            total_nodes: result.reverted.totalNodes,
          },
          compensation_event_ids: result.compensationEventIds,
        },
      } as const;
    });

    return Response.json(outcome.body, { status: outcome.status });
  } catch (err) {
    return errorResponse(err);
  }
}
