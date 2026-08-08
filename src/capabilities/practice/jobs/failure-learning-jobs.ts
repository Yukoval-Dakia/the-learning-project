import type { Tx } from '@/db/client';
import {
  ATTRIBUTION_FOLLOWUP_QUEUE,
  type FailureLearningQueue,
  VARIANT_GEN_QUEUE,
  failureLearningJobId,
} from '../server/failure-learning-identity';
import { practiceBossTransaction } from '../server/queue-runtime';

export {
  ATTRIBUTION_FOLLOWUP_QUEUE,
  type FailureLearningQueue,
  VARIANT_GEN_QUEUE,
  failureLearningJobId,
} from '../server/failure-learning-identity';

export interface FailureLearningJobData {
  attempt_event_id: string;
}

export interface FailureLearningSendOptions {
  id: string;
  db?: ReturnType<typeof practiceBossTransaction>;
}

export type FailureLearningBossSend = (
  name: FailureLearningQueue,
  data: FailureLearningJobData,
  options: FailureLearningSendOptions,
) => Promise<string | null>;

/** Parse the legacy payload without trusting its compile-time generic. */
export function failureLearningAttemptId(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const attemptEventId = (data as { attempt_event_id?: unknown }).attempt_event_id;
  return typeof attemptEventId === 'string' && attemptEventId.trim().length > 0
    ? attemptEventId
    : null;
}

async function enqueueFailureLearningJob(
  send: FailureLearningBossSend,
  queue: FailureLearningQueue,
  attemptEventId: string,
  tx?: Tx,
): Promise<string> {
  const id = failureLearningJobId(queue, attemptEventId);
  const sent = await send(
    queue,
    { attempt_event_id: attemptEventId },
    {
      id,
      ...(tx ? { db: practiceBossTransaction(tx) } : {}),
    },
  );
  // pg-boss returns null when this exact stable id already exists. That is a
  // successful replay: the durable delivery is already present.
  return sent ?? id;
}

export function enqueueAttributionFollowup(
  send: FailureLearningBossSend,
  attemptEventId: string,
  tx?: Tx,
): Promise<string> {
  return enqueueFailureLearningJob(send, ATTRIBUTION_FOLLOWUP_QUEUE, attemptEventId, tx);
}

export function enqueueVariantGen(
  send: FailureLearningBossSend,
  attemptEventId: string,
): Promise<string> {
  return enqueueFailureLearningJob(send, VARIANT_GEN_QUEUE, attemptEventId);
}
