import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import { provider_session_admission } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { acquireProviderSession } from './provider-session-admission';
import {
  PROVIDER_SESSION_HEARTBEAT_MS,
  type ProviderSessionAdmissionPlan,
} from './provider-session-admission-policy';

const BASE_POLICY = {
  laneId: 'xiaomi' as const,
  maxConcurrentSessions: 1,
  maxSessionStartsPerMinute: 100,
  maxQueuedSessions: 10,
  maxWaitMs: 2_000,
  fingerprint: 'test-policy-v1',
};

type ActivePlan = Exclude<ProviderSessionAdmissionPlan, { mode: 'off' }>;

const ASYNC_EVENT_TIMEOUT_MS = PROVIDER_SESSION_HEARTBEAT_MS * 2 + 2_000;

interface IndependentDb {
  db: Db;
  close(): Promise<void>;
}

const opened: IndependentDb[] = [];
const controllers: AbortController[] = [];
const permits: Array<{ release(): Promise<void> }> = [];
const pending: Promise<unknown>[] = [];

function openIndependentDb(): IndependentDb {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL not set');
  const client = postgres(url, { max: 1 });
  const handle = {
    db: drizzle(client, { schema }) as unknown as Db,
    close: () => client.end(),
  };
  opened.push(handle);
  return handle;
}

function plan(
  overrides: Partial<typeof BASE_POLICY> = {},
  mode: ActivePlan['mode'] = 'enforce',
): ActivePlan {
  return { mode, laneId: 'xiaomi', policy: { ...BASE_POLICY, ...overrides } };
}

function startAcquire(input: {
  db: Db;
  taskRunId: string;
  admissionPlan?: ActivePlan;
  parentTaskRunId?: string;
  executionTimeoutMs?: number;
}) {
  const controller = new AbortController();
  controllers.push(controller);
  const promise = acquireProviderSession({
    db: input.db,
    kind: 'AttributionTask',
    taskRunId: input.taskRunId,
    parentTaskRunId: input.parentTaskRunId,
    executionTimeoutMs: input.executionTimeoutMs ?? 1_000,
    signal: controller.signal,
    plan: input.admissionPlan ?? plan(),
    onLeaseLost: () => controller.abort(),
  }).then((permit) => {
    permits.push(permit);
    return permit;
  });
  pending.push(promise);
  return promise;
}

async function waitForStatus(taskRunId: string, status: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await testDb()
      .select({ status: provider_session_admission.status })
      .from(provider_session_admission)
      .where(eq(provider_session_admission.task_run_id, taskRunId));
    if (rows[0]?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`admission ${taskRunId} did not reach status=${status}`);
}

interface LeaseSnapshot {
  mode: 'observe' | 'enforce';
  acquiredAt: Date;
  heartbeatAt: Date;
  leaseExpiresAt: Date;
  hardReclaimAt: Date;
}

async function readLeaseSnapshot(taskRunId: string): Promise<LeaseSnapshot> {
  const rows = await testDb()
    .select({
      mode: provider_session_admission.mode,
      acquiredAt: provider_session_admission.acquired_at,
      heartbeatAt: provider_session_admission.heartbeat_at,
      leaseExpiresAt: provider_session_admission.lease_expires_at,
      hardReclaimAt: provider_session_admission.hard_reclaim_at,
    })
    .from(provider_session_admission)
    .where(eq(provider_session_admission.task_run_id, taskRunId));
  const row = rows[0];
  if (!row?.acquiredAt || !row.heartbeatAt || !row.leaseExpiresAt || !row.hardReclaimAt) {
    throw new Error(`admission ${taskRunId} has no complete lease snapshot`);
  }
  return {
    mode: row.mode,
    acquiredAt: row.acquiredAt,
    heartbeatAt: row.heartbeatAt,
    leaseExpiresAt: row.leaseExpiresAt,
    hardReclaimAt: row.hardReclaimAt,
  };
}

async function _waitForHeartbeatAfter(taskRunId: string, prior: Date): Promise<LeaseSnapshot> {
  const deadline = Date.now() + ASYNC_EVENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const snapshot = await readLeaseSnapshot(taskRunId);
    if (snapshot.heartbeatAt.getTime() > prior.getTime()) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`admission ${taskRunId} heartbeat did not advance`);
}

async function _waitForAbort(signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + ASYNC_EVENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal.aborted) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('provider session heartbeat did not fence the lost owner');
}

beforeEach(async () => {
  await resetDb();
});

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.allSettled(permits.splice(0).map((permit) => permit.release()));
  await Promise.allSettled(pending.splice(0));
  await Promise.allSettled(opened.splice(0).map((handle) => handle.close()));
});

describe('YUK-842 cross-process provider SDK-session admission', () => {
  it('shares one concurrency cap across two independent DB clients', async () => {
    const a = openIndependentDb();
    const b = openIndependentDb();
    const first = await startAcquire({ db: a.db, taskRunId: 'session-a' });
    const secondPromise = startAcquire({ db: b.db, taskRunId: 'session-b' });

    await waitForStatus('session-b', 'waiting');
    await first.release();
    const second = await secondPromise;

    expect(second.borrowedFromTaskRunId).toBeNull();
    await waitForStatus('session-b', 'acquired');
  });
});
