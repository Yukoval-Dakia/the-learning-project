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
import { and, eq, inArray, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from '../server/copilot-run-status';
import { CopilotCheckpointParamsSchema, type CopilotCheckpointRevertRefusalT } from './contracts';

// Exhaustiveness guard: a new CascadeRevertRefusal variant that isn't handled in the refusal-body
// switch makes this fail to compile (YUK-497 wave-3).
function assertNever(x: never): never {
  throw new Error(`unhandled cascade refusal variant: ${JSON.stringify(x)}`);
}

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
      // Durable run shadow probes. job_events is free-form and a STREAMING run emits many
      // DELTA rows, so never fetch the whole event set just to derive two booleans — two
      // bounded existence checks (does a shadow exist at all; has it reached DONE/FAILED).
      const shadowRows = await tx
        .select({ event_type: job_events.event_type })
        .from(job_events)
        .where(
          and(
            eq(job_events.business_table, COPILOT_RUN_TABLE),
            eq(job_events.business_id, checkpointEventId),
          ),
        )
        .limit(1);
      const shadowExists = shadowRows.length > 0;
      const terminalRows = await tx
        .select({ event_type: job_events.event_type })
        .from(job_events)
        .where(
          and(
            eq(job_events.business_table, COPILOT_RUN_TABLE),
            eq(job_events.business_id, checkpointEventId),
            inArray(job_events.event_type, [COPILOT_RUN_EVENTS.DONE, COPILOT_RUN_EVENTS.FAILED]),
          ),
        )
        .limit(1);
      const durableTerminal = terminalRows.length > 0;
      // YUK-497 review F6 — two distinct not-terminal conditions, previously conflated under
      // one 409. Keep both 409 but name the cause so the client (and forensics) can tell them
      // apart: (a) no reply persisted yet = the turn is still in flight; (b) a durable run
      // shadow exists but has not reached DONE/FAILED = the async job is mid-run.
      if (replies.length === 0) {
        throw new ApiError('turn_not_terminal', 'turn not complete yet — no reply persisted', 409);
      }
      if (shadowExists && !durableTerminal) {
        throw new ApiError(
          'turn_shadow_not_terminal',
          'durable run shadow not terminal yet — cannot revert',
          409,
        );
      }

      // YUK-497 wave-3 (OCR) — G acquired HERE, just before the first learning-state row access
      // (orchestrateCascadeRevert), not at handler entry: the five pre-checks above are all
      // lock-free plain SELECTs (roots / getCorrectionStatus / replies / shadow / terminal — no
      // FOR UPDATE), so holding the global G across them + the early-return paths only amplifies
      // contention. The G→rows invariant still holds (orchestrate takes row locks only after this),
      // and orchestrate re-acquires G reentrantly on the tx path.
      await acquireLearningStateWriteLock(tx);
      const result = await orchestrateCascadeRevert(tx, checkpointEventId, {
        copilotAskOnly: true,
      });
      if (!result.ok) {
        // YUK-497 review F4 — map the orchestrator's internal camelCase refusal to the
        // snake_case wire envelope (irreversible_event_ids / ref.kc_id / conflict_ref.*).
        // wave-3 (OCR) — switch on the discriminant with an exhaustive assertNever so a new
        // refusal variant with required fields fails to compile instead of silently shipping an
        // incomplete body. Wire shapes are unchanged (contracts.db pins them).
        const body: CopilotCheckpointRevertRefusalT = {
          ok: false,
          refusal: result.refusal,
          reason: result.reason,
        };
        switch (result.refusal) {
          case 'irreversible':
            body.irreversible_event_ids = result.irreversibleEventIds;
            break;
          case 'legacy_snapshot':
            body.ref = { kind: result.ref.kind, kc_id: result.ref.kcId };
            break;
          case 'conflict':
            body.conflict_ref = {
              kind: result.conflictRef.kind,
              subject_kind: result.conflictRef.subjectKind,
              subject_id: result.conflictRef.subjectId,
            };
            break;
          case 'truncated':
          case 'no_checkpoint':
            // base { ok, refusal, reason } only — no extra wire fields.
            break;
          default:
            assertNever(result);
        }
        return {
          status: result.refusal === 'no_checkpoint' ? 404 : 409,
          body,
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
    // F3 (TdY3h) — a bad path param is a 400 validation_error, not a generic 500 (mirrors chat.ts /
    // accept-chip: a bare errorResponse(ZodError) would fall through to 500).
    if (err instanceof ZodError) {
      return errorResponse(
        new ApiError('validation_error', err.issues.map((i) => i.message).join('; '), 400),
      );
    }
    return errorResponse(err);
  }
}
