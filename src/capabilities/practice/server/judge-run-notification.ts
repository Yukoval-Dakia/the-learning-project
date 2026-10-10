import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { job_events } from '@/db/schema';
import { writeJobEvent } from '@/server/events/writer';
import { lockJudgeRun } from './judge-operational';
import { readJudgeRunPermanent } from './judge-run-observation';
import { JUDGE_RUN_EVENTS, JUDGE_RUN_TABLE } from './judge-run-status';

/** Retained domain truth controls every projection, including delayed send acknowledgments. */
export async function projectJudgeRunNotification(
  database: Db,
  runId: string,
  progress?: { eventType: string; payload: Record<string, unknown> },
) {
  return database.transaction(async (tx) => {
    await lockJudgeRun(tx, runId);
    const state = await readJudgeRunPermanent(tx, runId);
    const terminal = state.kind === 'resolved' || state.kind === 'manual';
    if (!terminal && !progress) return state;
    const eventType =
      state.kind === 'resolved'
        ? JUDGE_RUN_EVENTS.DONE
        : state.kind === 'manual'
          ? JUDGE_RUN_EVENTS.FAILED
          : progress?.eventType;
    if (!eventType) return state;
    if (terminal) {
      const [last] = await tx
        .select({ eventType: job_events.event_type })
        .from(job_events)
        .where(
          and(eq(job_events.business_table, JUDGE_RUN_TABLE), eq(job_events.business_id, runId)),
        )
        .orderBy(desc(job_events.id))
        .limit(1);
      if (last?.eventType === eventType) return state;
    } else if (state.kind === 'pending' && progress) {
      const deliveryId = progress.payload.delivery_id;
      if (typeof deliveryId === 'string' && state.delivery?.reservation.delivery_id !== deliveryId)
        return state;
      // The worker may have started before the send caller receives its acknowledgment.
      if (
        state.delivery?.kind === 'started' &&
        (eventType === JUDGE_RUN_EVENTS.QUEUED || eventType === JUDGE_RUN_EVENTS.REQUEUED)
      )
        return state;
    }
    await writeJobEvent(tx, {
      business_table: JUDGE_RUN_TABLE,
      business_id: runId,
      event_type: eventType,
      payload:
        state.kind === 'resolved'
          ? state.result
          : state.kind === 'manual'
            ? { reason: 'manual', error_code: state.disposition.reason }
            : (progress?.payload ?? {}),
    });
    return state;
  });
}
