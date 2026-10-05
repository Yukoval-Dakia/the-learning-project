import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import type { CopilotModeState } from './chat-contracts';
import { parseCopilotModeState } from './mode-completion';
import { CopilotPrimaryViewSchema } from './reply-finalization';
import type { CopilotPrimaryView } from './turns';

export type PersistedDurableReply =
  | {
      outcome: 'success';
      replyMd: string;
      taskRunId: string;
      finishReason: string;
      modeState?: CopilotModeState;
      primaryView?: CopilotPrimaryView;
      emitReviewedDelta?: boolean;
    }
  | {
      outcome: 'failure';
      replyMd: string;
      taskRunId: string;
      reason: 'cancelled' | 'exhausted' | 'ambiguous_execution' | 'pre_execution_lost';
      error: string;
      checkpointSafe?: boolean;
      emitReviewedDelta?: boolean;
    };

/** The same persisted outcome decoder serves paid settlement and native child fencing. */
export async function findPersistedDurableReply(
  db: Db | Tx,
  runId: string,
  sessionId?: string,
): Promise<PersistedDurableReply | null> {
  const rows = await db
    .select({ outcome: event.outcome, payload: event.payload, taskRunId: event.task_run_id })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:copilot_reply'),
        eq(event.caused_by_event_id, runId),
        inArray(event.outcome, ['success', 'failure']),
        sessionId ? eq(event.session_id, sessionId) : undefined,
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const payload = row.payload as Record<string, unknown>;
  const replyMd = payload.reply_md;
  const taskRunId = row.taskRunId ?? payload.task_run_id;
  if (typeof replyMd !== 'string' || typeof taskRunId !== 'string') return null;
  if (row.outcome === 'failure') {
    const failure = payload.durable_failure;
    const failureRecord =
      failure && typeof failure === 'object' && !Array.isArray(failure)
        ? (failure as Record<string, unknown>)
        : {};
    const reason =
      failureRecord.reason === 'cancelled'
        ? 'cancelled'
        : failureRecord.reason === 'ambiguous_execution'
          ? 'ambiguous_execution'
          : failureRecord.reason === 'pre_execution_lost'
            ? 'pre_execution_lost'
            : 'exhausted';
    return {
      outcome: 'failure',
      replyMd,
      taskRunId,
      reason,
      error: typeof failureRecord.error === 'string' ? failureRecord.error : replyMd,
      ...(failureRecord.checkpoint_safe === false ? { checkpointSafe: false } : {}),
      ...(payload.durable_emit_reviewed_delta === true ? { emitReviewedDelta: true } : {}),
    };
  }
  if (row.outcome !== 'success') return null;
  const modeState = parseCopilotModeState(payload);
  const primaryView = CopilotPrimaryViewSchema.safeParse(payload.primary_view);
  return {
    outcome: 'success',
    replyMd,
    taskRunId,
    finishReason:
      typeof payload.durable_finish_reason === 'string'
        ? payload.durable_finish_reason
        : 'recovered',
    ...(payload.durable_emit_reviewed_delta === true ? { emitReviewedDelta: true } : {}),
    ...(modeState ? { modeState } : {}),
    ...(primaryView.success ? { primaryView: primaryView.data } : {}),
  };
}
