import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { type CopilotPublicProse, parseCopilotPublicProse } from '../public-prose-contract';
import type { CopilotModeState } from './chat-contracts';
import { parseCopilotModeState } from './mode-completion';
import {
  publicProseFailureForReason,
  publicProseStatus,
  readCopilotPublicProse,
} from './public-prose';
import { CopilotPrimaryViewSchema } from './reply-finalization';
import type { CopilotPrimaryView } from './turns';

export type PersistedDurableReply =
  | {
      outcome: 'success';
      replyMd: string;
      taskRunId: string;
      publicProse?: CopilotPublicProse;
      finishReason: string;
      modeState?: CopilotModeState;
      primaryView?: CopilotPrimaryView;
    }
  | {
      outcome: 'failure';
      replyMd: string;
      taskRunId: string;
      publicProse?: CopilotPublicProse;
      reason: 'cancelled' | 'exhausted' | 'ambiguous_execution' | 'pre_execution_lost';
      error: string;
      checkpointSafe?: boolean;
    };

/** One persisted outcome decoder for paid settlement and native child fencing. */
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
  const frozenProse = parseCopilotPublicProse(payload.public_prose);
  const retainedProse = frozenProse
    ? undefined
    : (await readCopilotPublicProse(db, [runId])).get(runId);
  // Legacy rows get a prose projection only while real delta evidence remains.
  const recoveredProse =
    retainedProse && retainedProse.last_event_id > 0 ? retainedProse : undefined;
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
    const failureInfo = publicProseFailureForReason(failureRecord.reason);
    const publicProse =
      frozenProse ??
      (recoveredProse
        ? {
            ...recoveredProse,
            status: publicProseStatus(failureInfo),
            failure: failureInfo,
          }
        : undefined);
    return {
      outcome: 'failure',
      replyMd: publicProse?.text || replyMd,
      taskRunId,
      ...(publicProse ? { publicProse } : {}),
      reason,
      error: typeof failureRecord.error === 'string' ? failureRecord.error : replyMd,
      ...(failureRecord.checkpoint_safe === false ? { checkpointSafe: false } : {}),
    };
  }
  if (row.outcome !== 'success') return null;
  const publicProse =
    frozenProse ??
    (recoveredProse ? { ...recoveredProse, status: 'completed' as const } : undefined);
  const modeState = parseCopilotModeState(payload);
  const primaryView = CopilotPrimaryViewSchema.safeParse(payload.primary_view);
  return {
    outcome: 'success',
    replyMd,
    taskRunId,
    ...(publicProse ? { publicProse } : {}),
    finishReason:
      typeof payload.durable_finish_reason === 'string'
        ? payload.durable_finish_reason
        : 'recovered',
    ...(modeState ? { modeState } : {}),
    ...(primaryView.success ? { primaryView: primaryView.data } : {}),
  };
}
