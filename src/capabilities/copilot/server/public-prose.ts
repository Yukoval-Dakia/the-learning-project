import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { job_events } from '@/db/schema';
import {
  COPILOT_PROVIDER_REJECTION_REPLY,
  type CopilotPublicProse,
  type CopilotPublicProseFailure,
  parseCopilotPublicProse,
} from '../public-prose-contract';
import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
  isCopilotRunTerminalEvent,
} from './copilot-run-status';

export function publicProseFailureForReason(reason: unknown): CopilotPublicProseFailure {
  return {
    kind:
      reason === 'cancelled'
        ? 'cancelled'
        : reason === 'exhausted' || reason === 'pre_execution_lost' || reason === 'enqueue_failed'
          ? 'execution_failed'
          : 'execution_unknown',
  };
}

export function publicProseStatus(
  failure?: CopilotPublicProseFailure,
): CopilotPublicProse['status'] {
  return !failure
    ? 'completed'
    : failure.kind === 'cancelled' || failure.kind === 'execution_unknown'
      ? 'interrupted'
      : 'failed';
}

/** Safe public copy; the original durable reason/error and paid receipts remain independent. */
export function publicProseFailureMessage(failure?: CopilotPublicProseFailure): string {
  if (failure?.kind === 'provider_rejected' && failure.http_status === 400)
    return COPILOT_PROVIDER_REJECTION_REPLY;
  if (failure?.kind === 'cancelled') return '已停止这次运行。';
  if (failure?.kind === 'execution_unknown')
    return '这次运行的执行结果尚未确认；请先确认现有结果，再决定是否重新发起。';
  if (failure?.kind === 'finalization_failed') return '这次回答未完成可验证的收口。';
  return '这次运行未完成回答。';
}

/**
 * Only the original sanitized, committed DELTA channel is eligible. The query is
 * scoped by accepted run identity; ids are actual job_events ids, never SDK seq.
 * Ordering/dedup also makes the fold safe for repeated or unordered read results.
 */
export async function readCopilotPublicProse(
  db: Db | Tx,
  runIds: readonly string[],
): Promise<Map<string, CopilotPublicProse>> {
  if (runIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: job_events.id,
      runId: job_events.business_id,
      event_type: job_events.event_type,
      payload: job_events.payload,
    })
    .from(job_events)
    .where(
      and(
        eq(job_events.business_table, COPILOT_RUN_TABLE),
        inArray(job_events.business_id, [...new Set(runIds)]),
      ),
    )
    .orderBy(asc(job_events.id));
  const result = new Map<string, CopilotPublicProse>();
  const seen = new Set<number>();
  for (const row of [...rows].sort((a, b) => a.id - b.id)) {
    if (!Number.isSafeInteger(row.id) || row.id <= 0 || seen.has(row.id)) continue;
    seen.add(row.id);
    const prior = result.get(row.runId);
    const prose = prior ?? {
      version: 1 as const,
      text: '',
      status: 'streaming' as const,
      last_event_id: 0,
    };
    if (
      prose.status === 'streaming' &&
      row.event_type === COPILOT_RUN_EVENTS.DELTA &&
      typeof row.payload.text === 'string' &&
      row.payload.text.length > 0
    ) {
      prose.text += row.payload.text;
      prose.last_event_id = row.id;
      result.set(row.runId, prose);
    } else if (
      row.event_type === COPILOT_RUN_EVENTS.REPLY ||
      row.event_type === COPILOT_RUN_EVENTS.DONE
    ) {
      const frozen = parseCopilotPublicProse(row.payload.public_prose);
      const completed = frozen ?? prose;
      if (row.event_type === COPILOT_RUN_EVENTS.DONE || frozen?.status === 'completed') {
        completed.status = 'completed';
        delete completed.failure;
        result.set(row.runId, completed);
      }
    } else if (row.event_type === COPILOT_RUN_EVENTS.FAILED && isCopilotRunTerminalEvent(row)) {
      const frozen = parseCopilotPublicProse(row.payload.public_prose);
      const failed = frozen ?? prose;
      failed.failure = frozen?.failure ?? publicProseFailureForReason(row.payload.reason);
      failed.status = publicProseStatus(failed.failure);
      result.set(row.runId, failed);
    }
  }
  return result;
}
