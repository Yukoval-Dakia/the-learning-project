import { createHash } from 'node:crypto';
import type { Tx } from '@/db/client';
import { practiceBossTransaction } from '../server/queue-runtime';

export const ATTRIBUTION_FOLLOWUP_QUEUE = 'attribution_followup' as const;
export const VARIANT_GEN_QUEUE = 'variant_gen' as const;

export interface FailureLearningJobData {
  attempt_event_id: string;
}

export type FailureLearningQueue = typeof ATTRIBUTION_FOLLOWUP_QUEUE | typeof VARIANT_GEN_QUEUE;

export interface FailureLearningSendOptions {
  id: string;
  db?: ReturnType<typeof practiceBossTransaction>;
}

export type FailureLearningBossSend = (
  name: FailureLearningQueue,
  data: FailureLearningJobData,
  options: FailureLearningSendOptions,
) => Promise<string | null>;

/**
 * Stable RFC 9562 UUIDv8 used as the pg-boss primary key for one workflow stage.
 *
 * The queue name is part of the seed, so attribution and variant generation for
 * the same attempt never collide. The contract version makes a future deliberate
 * replay policy change explicit instead of silently changing existing identities.
 */
export function failureLearningJobId(queue: FailureLearningQueue, attemptEventId: string): string {
  const hex = createHash('sha256')
    .update(`practice.failure-learning@v1\0${queue}\0${attemptEventId}`)
    .digest('hex');
  const bytes = hex.slice(0, 32).split('');
  bytes[12] = '8';
  bytes[16] = ((Number.parseInt(bytes[16], 16) & 0x3) | 0x8).toString(16);
  const value = bytes.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
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
