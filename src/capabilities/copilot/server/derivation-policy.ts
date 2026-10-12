import { and, eq } from 'drizzle-orm';
import { type DerivationPolicyT, readDerivationPolicy } from '@/core/schema/derivation-policy';
import type { Db } from '@/db/client';
import { event, job_events } from '@/db/schema';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from './copilot-run-status';
import { type CopilotRunJobData, hashCopilotDurableInput } from './durable-dispatch';

/** Delivery is not authority: validate the immutable accepted source before any execution. */
export async function acceptedCopilotDerivationPolicy(
  db: Db,
  data: CopilotRunJobData,
): Promise<DerivationPolicyT> {
  const [ask] = await db
    .select({ payload: event.payload, sessionId: event.session_id, action: event.action })
    .from(event)
    .where(eq(event.id, data.run_id))
    .limit(1);
  const delivered = readDerivationPolicy(data);
  if (!ask) {
    if (delivered === 'answer_only') throw new Error('restricted Copilot source missing');
    return 'allow'; // Retained pre-anchor jobs only.
  }
  const accepted = readDerivationPolicy(ask.payload);
  if (
    accepted !== delivered ||
    ask.sessionId !== data.session_id ||
    !['experimental:copilot_user_ask', 'experimental:copilot_chip_trigger'].includes(ask.action) ||
    ask.payload.user_message !== data.user_message ||
    (ask.action === 'experimental:copilot_chip_trigger' ? 'chip' : 'chat') !== data.triggered_by
  ) {
    throw new Error('Copilot delivery does not match accepted source');
  }
  const [queued] = await db
    .select({ payload: job_events.payload })
    .from(job_events)
    .where(
      and(
        eq(job_events.business_table, COPILOT_RUN_TABLE),
        eq(job_events.business_id, data.run_id),
        eq(job_events.event_type, COPILOT_RUN_EVENTS.QUEUED),
      ),
    )
    .limit(1);
  if ((!queued || queued.payload.job_data === undefined) && accepted === 'answer_only')
    throw new Error('restricted Copilot acceptance missing');
  if (
    queued &&
    (readDerivationPolicy(queued.payload) !== accepted ||
      (queued.payload.job_data !== undefined &&
        (readDerivationPolicy(queued.payload.job_data) !== accepted ||
          hashCopilotDurableInput(queued.payload.job_data) !== hashCopilotDurableInput(data))))
  ) {
    throw new Error('Copilot acceptance policy mismatch');
  }
  return accepted;
}
