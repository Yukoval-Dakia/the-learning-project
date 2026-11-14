// The execution winner seals this bounded input window before any model/tool send.
// Settlement copies it verbatim; recovery cannot reconstruct the original input.
import { and, asc, eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { job_events } from '@/db/schema';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from './copilot-run-status';

export interface CopilotHistoryReadSet {
  version: 1;
  event_ids: string[];
}

export function parseHistoryReadSet(
  value: unknown,
  ...excludedIds: string[]
): CopilotHistoryReadSet | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.event_ids)) return null;
  if (
    record.event_ids.some((id) => typeof id !== 'string' || !id.trim() || excludedIds.includes(id))
  )
    return null;
  return { version: 1, event_ids: [...new Set(record.event_ids as string[])] };
}

export async function readWinningHistoryReadSet(
  db: Db | Tx,
  runId: string,
  replyId: string,
  deterministicPreExecution: boolean,
): Promise<CopilotHistoryReadSet | null> {
  const events = await db
    .select({ event_type: job_events.event_type, payload: job_events.payload })
    .from(job_events)
    .where(and(eq(job_events.business_table, COPILOT_RUN_TABLE), eq(job_events.business_id, runId)))
    .orderBy(asc(job_events.id));
  const fences = events.filter(
    (event) => event.event_type === COPILOT_RUN_EVENTS.EXECUTION_STARTED,
  );
  if (fences.length === 1)
    return parseHistoryReadSet(fences[0].payload.history_read_set, runId, replyId);
  if (fences.length > 0) return null;
  const executionEvidence = events.some((event) =>
    [
      COPILOT_RUN_EVENTS.STEP,
      COPILOT_RUN_EVENTS.DELTA,
      COPILOT_RUN_EVENTS.REPLY,
      COPILOT_RUN_EVENTS.DONE,
    ].some((type) => type === event.event_type),
  );
  const enqueueFailed = events.some(
    (event) =>
      event.event_type === COPILOT_RUN_EVENTS.FAILED && event.payload.reason === 'enqueue_failed',
  );
  return (deterministicPreExecution || enqueueFailed) && !executionEvidence
    ? { version: 1, event_ids: [] }
    : null;
}
