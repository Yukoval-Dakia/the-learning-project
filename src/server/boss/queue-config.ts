// Shared by the infra book and the capability registrar, so expiry and the create race live once.
//
// pg-boss stores expiry on the queue. The 15-minute default retries a long model job while it is still active.
// FAST queues have no dead-letter queue. A missed cron tick runs on the next schedule.
// LLM is one model call. note_generate's 30-minute budget still fits in the 1h lease, with the wait before the call.
// AGENT is a multi-step loop, with a 2h lease. Both keep an exhausted job on `<queue>_dlq`.
// Retention is 7 days, under the 14-day default, so a stuck created job does not sit for two weeks.
// Create the dead-letter queue first. createQueue does not update a row that already exists.

import type { PgBoss } from 'pg-boss';

import { isQueueCreateRace } from '@/server/boss/client';

type QueueAdmin = Pick<PgBoss, 'createQueue' | 'updateQueue'>;

export const RETENTION_7D = 604_800; // 7 days
export const EXPIRE_FAST = 3_600; // 1h floor for a cheap tick
export const EXPIRE_LLM = 3_600; // 1h
export const EXPIRE_AGENT = 7_200; // 2h

// retryLimit 2 matches the library default, so the count does not change.
// The delay and backoff are the change. A failed paid job waits instead of hammering the outage.
// In-process retry is off for these handlers, so this queue is their only retry.
// Worst case is one try plus retryLimit. The cap stays at 2 because each retry is a full bill.
export const JOB_RETRY_LIMIT = 2;
export const JOB_RETRY_DELAY_SECONDS = 30;

export const FAST_QUEUE_OPTS = {
  expireInSeconds: EXPIRE_FAST,
  retentionSeconds: RETENTION_7D,
} as const;

/**
 * Caller creates the dead-letter queue first.
 * updateQueue writes these retry fields onto a queue that already exists.
 */
function jobQueueOpts(
  queueName: string,
  expireInSeconds: number,
  overrides: { heartbeatSeconds?: number } = {},
) {
  return {
    expireInSeconds,
    retentionSeconds: RETENTION_7D,
    deadLetter: `${queueName}_dlq`,
    retryLimit: JOB_RETRY_LIMIT,
    retryDelay: JOB_RETRY_DELAY_SECONDS,
    retryBackoff: true,
    ...overrides,
  } as const;
}

/**
 * createQueue is insert-on-conflict-do-nothing, so an existing row keeps its old expiry.
 * updateQueue is what lands the current options on a database that already has the queue.
 * A 23505 means the other process inserted the row. Still update it. Any other error rethrows.
 */
export async function createOrUpdateQueue(
  boss: QueueAdmin,
  name: string,
  opts: {
    expireInSeconds: number;
    retentionSeconds: number;
    deadLetter?: string;
    retryLimit?: number;
    retryDelay?: number;
    retryBackoff?: boolean;
    heartbeatSeconds?: number;
  },
): Promise<void> {
  try {
    await boss.createQueue(name, opts);
  } catch (err) {
    if (!isQueueCreateRace(err)) throw err;
    // The row exists. updateQueue below still applies the current options.
    console.warn(
      `[boss] createQueue('${name}') hit a concurrent create race (23505 queue_pkey) — queue already exists, reconciling config (YUK-259)`,
    );
  }
  await boss.updateQueue(name, opts);
}

/**
 * The dead-letter queue must exist before the main queue names it.
 * It holds failed payloads and has no worker, so it uses the fast options.
 */
export async function createJobQueue(
  boss: QueueAdmin,
  name: string,
  expireInSeconds: number,
  overrides: { heartbeatSeconds?: number } = {},
): Promise<void> {
  await createOrUpdateQueue(boss, `${name}_dlq`, FAST_QUEUE_OPTS);
  await createOrUpdateQueue(boss, name, jobQueueOpts(name, expireInSeconds, overrides));
}
