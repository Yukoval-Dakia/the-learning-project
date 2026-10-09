import { createHash } from 'node:crypto';
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import {
  type JudgeReservation,
  JudgeWorkflowInput,
  type JudgeWorkflowInputT,
} from '@/core/schema/event/judge-operational-events';
import { getStartedBoss } from '@/server/boss/client';
import { JUDGE_RUN_QUEUE } from './judge-durable-config';
import type { JudgeRunJobData } from './judge-run-payload';

export const JUDGE_DBOS_WORKFLOW = 'judge-run-v1';
export const JUDGE_DBOS_QUEUE = 'judge-run-v1';
export const JUDGE_DBOS_APPLICATION = 'tlp-housekeeping';
// Preserve the existing shared host's version and already registered families.
export const JUDGE_DBOS_APPLICATION_VERSION = 'prune-v1';
export const JUDGE_DBOS_SCHEMA = 'tlp_dbos';
const workflowState = z.enum([
  'PENDING',
  'ENQUEUED',
  'DELAYED',
  'SUCCESS',
  'ERROR',
  'CANCELLED',
  'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
]);
export type JudgeWorkflowObservation =
  | {
      kind: 'present';
      state: z.infer<typeof workflowState>;
      input: JudgeWorkflowInputT | null;
      deliveryId: string;
    }
  | { kind: 'absent'; deliveryId: string }
  | { kind: 'unavailable'; reason: 'backend_unavailable' | 'identity_unverified' };
export function judgeLegacyJobId(runId: string, slot = 0) {
  const seed = slot ? `judge_run:${runId}:recovery:${slot}` : `judge_run:${runId}`;
  const bytes = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  bytes[12] = '8';
  bytes[16] = ((Number.parseInt(bytes[16], 16) & 3) | 8).toString(16);
  const h = bytes.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
export function judgeDeliveryInput(reservation: JudgeReservation): JudgeWorkflowInputT {
  return JudgeWorkflowInput.parse({
    version: 1,
    run_id: reservation.run_id,
    pending_id: reservation.pending_id,
    pending_digest: reservation.pending_digest,
    reservation_id: `evt_judge_delivery_${canonicalHash([reservation.run_id, reservation.slot])}`,
    delivery_id: reservation.delivery_id,
    ownership: reservation.ownership,
  });
}
async function withClient<T>(fn: (client: DBOSClient) => Promise<T>) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Judge DBOS client requires DATABASE_URL');
  const client = await DBOSClient.create({
    systemDatabaseUrl: url,
    systemDatabaseSchemaName: JUDGE_DBOS_SCHEMA,
    applicationName: JUDGE_DBOS_APPLICATION,
    systemDatabasePoolSize: 1,
    observabilityQueryTimeoutMs: 3000,
  });
  try {
    return await fn(client);
  } finally {
    await client.destroy();
  }
}
export interface JudgeLegacySender {
  send: (name: string, data: unknown, options?: { id?: string }) => Promise<string | null>;
}
/** The engine owns both legacy sending and lookup; dispatch retains authorization and receipts. */
export async function enqueueLegacyJudgeDelivery(
  job: JudgeRunJobData,
  input: JudgeWorkflowInputT,
  sender?: JudgeLegacySender,
): Promise<string | null> {
  const boss = sender ?? (await getStartedBoss());
  return boss.send(JUDGE_RUN_QUEUE, { ...job, operational: input }, { id: input.delivery_id });
}
export async function enqueueDbosJudgeDelivery(input: JudgeWorkflowInputT): Promise<string> {
  const valid = JudgeWorkflowInput.parse(input);
  return withClient(async (client) => {
    const handle = await client.enqueue(
      {
        workflowID: valid.delivery_id,
        workflowName: JUDGE_DBOS_WORKFLOW,
        queueName: JUDGE_DBOS_QUEUE,
        appVersion: JUDGE_DBOS_APPLICATION_VERSION,
        applicationName: JUDGE_DBOS_APPLICATION,
      },
      valid,
    );
    // Fixed IDs alone do not compare arguments in this SDK. Validate the stored input before acknowledging.
    const observed = await client.getWorkflow(valid.delivery_id);
    if (
      !observed ||
      observed.workflowName !== JUDGE_DBOS_WORKFLOW ||
      observed.queueName !== JUDGE_DBOS_QUEUE ||
      observed.applicationName !== JUDGE_DBOS_APPLICATION ||
      observed.applicationVersion !== JUDGE_DBOS_APPLICATION_VERSION ||
      canonicalHash(JudgeWorkflowInput.parse(observed.input?.[0])) !== canonicalHash(valid)
    )
      throw new Error('Judge enqueue identity is unverified');
    return handle.workflowID;
  });
}
export async function observeJudgeDelivery(
  reservation: JudgeReservation,
): Promise<JudgeWorkflowObservation> {
  const expected = judgeDeliveryInput(reservation);
  try {
    if (reservation.ownership.backend === 'dbos')
      return await withClient(async (client) => {
        const status = await client.getWorkflow(reservation.delivery_id);
        if (!status) return { kind: 'absent', deliveryId: reservation.delivery_id };
        const input = JudgeWorkflowInput.safeParse(status.input?.[0]);
        const state = workflowState.safeParse(status.status);
        if (
          !input.success ||
          !state.success ||
          status.workflowName !== JUDGE_DBOS_WORKFLOW ||
          status.queueName !== JUDGE_DBOS_QUEUE ||
          status.applicationName !== JUDGE_DBOS_APPLICATION ||
          status.applicationVersion !== JUDGE_DBOS_APPLICATION_VERSION ||
          canonicalHash(input.data) !== canonicalHash(expected)
        )
          return { kind: 'unavailable', reason: 'identity_unverified' };
        return {
          kind: 'present',
          state: state.data,
          input: input.data,
          deliveryId: reservation.delivery_id,
        };
      });
    const boss = await getStartedBoss();
    const job = await boss.getJobById(JUDGE_RUN_QUEUE, reservation.delivery_id);
    if (!job) return { kind: 'absent', deliveryId: reservation.delivery_id };
    const input = z.object({ operational: JudgeWorkflowInput }).safeParse(job.data);
    if (!input.success || canonicalHash(input.data.operational) !== canonicalHash(expected))
      return { kind: 'unavailable', reason: 'identity_unverified' };
    const state =
      job.state === 'active'
        ? 'PENDING'
        : job.state === 'completed'
          ? 'SUCCESS'
          : job.state === 'failed'
            ? 'ERROR'
            : job.state === 'cancelled'
              ? 'CANCELLED'
              : 'ENQUEUED';
    return { kind: 'present', state, input: input.data.operational, deliveryId: job.id };
  } catch {
    return { kind: 'unavailable', reason: 'backend_unavailable' };
  }
}
/** With no domain pointer, all deterministic legacy IDs and the DBOS initial ID must answer. */
export async function observeUnmappedJudgeRun(runId: string): Promise<JudgeWorkflowObservation> {
  try {
    const boss = await getStartedBoss();
    for (const slot of [0, 1, 2]) {
      const job = await boss.getJobById(JUDGE_RUN_QUEUE, judgeLegacyJobId(runId, slot));
      if (job) return { kind: 'unavailable', reason: 'identity_unverified' };
    }
    return await withClient(async (client) => {
      for (const slot of [0, 1, 2])
        if (await client.getWorkflow(`judge-run-v1:${runId}:delivery:${slot}`))
          return { kind: 'unavailable', reason: 'identity_unverified' };
      return { kind: 'absent', deliveryId: `judge-run-v1:${runId}:delivery:0` };
    });
  } catch {
    return { kind: 'unavailable', reason: 'backend_unavailable' };
  }
}

export const JudgeEngineItem = z
  .object({
    task_id: z.string(),
    kind: z.enum(['job', 'tick', 'dlq', 'forwarder', 'schedule']),
    state: z.string(),
    payload_digest: z.string().regex(/^[a-f0-9]{64}$/),
    run_id: z.string().nullable(),
  })
  .strict();
export const JudgeEngineInventory = z
  .object({
    backend: z.enum(['pg-boss', 'dbos']),
    observed_at: z.iso.datetime(),
    items: z.array(JudgeEngineItem),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type JudgeEngineInventoryT = z.infer<typeof JudgeEngineInventory>;
export function sealJudgeEngineInventory(
  backend: JudgeEngineInventoryT['backend'],
  items: JudgeEngineInventoryT['items'],
  at = new Date(),
) {
  const body = {
    backend,
    observed_at: at.toISOString(),
    items: [...items].sort((a, b) => a.task_id.localeCompare(b.task_id)),
  };
  return JudgeEngineInventory.parse({ ...body, digest: canonicalHash(body) });
}
export function validateJudgeEngineInventory(value: JudgeEngineInventoryT) {
  const parsed = JudgeEngineInventory.parse(value);
  const { digest, ...body } = parsed;
  if (
    canonicalHash(body) !== digest ||
    new Set(body.items.map((i) => i.task_id)).size !== body.items.length
  )
    throw new Error('Judge engine inventory seal conflict');
  return parsed;
}
/** Enumerate every page, including terminal tasks and scheduled ticks. Unverifiable inputs abort the census. */
export async function inspectDbosJudgeInventory(): Promise<JudgeEngineInventoryT> {
  return withClient(async (client) => {
    const items: JudgeEngineInventoryT['items'] = [];
    for (let offset = 0; ; offset += 200) {
      const page = await client.listWorkflows({
        workflowName: [JUDGE_DBOS_WORKFLOW, 'judge-pending-reconcile-v1'],
        applicationName: JUDGE_DBOS_APPLICATION,
        limit: 200,
        offset,
        sortDesc: false,
        loadInput: true,
      });
      for (const row of page) {
        const native = row.workflowName === JUDGE_DBOS_WORKFLOW;
        const input = native ? JudgeWorkflowInput.parse(row.input?.[0]) : null;
        if (
          native &&
          (input?.delivery_id !== row.workflowID ||
            row.queueName !== JUDGE_DBOS_QUEUE ||
            row.applicationVersion !== JUDGE_DBOS_APPLICATION_VERSION)
        )
          throw new Error('DBOS judge inventory input mismatch');
        workflowState.parse(row.status);
        items.push({
          task_id: row.workflowID,
          kind: native ? 'job' : 'tick',
          state: row.status,
          payload_digest: canonicalHash(row.input),
          run_id: input?.run_id ?? null,
        });
      }
      if (page.length < 200) break;
    }
    for (const schedule of await client.listSchedules({
      workflowName: 'judge-pending-reconcile-v1',
    }))
      items.push({
        task_id: schedule.scheduleId,
        kind: 'schedule',
        state: schedule.status,
        payload_digest: canonicalHash(schedule),
        run_id: null,
      });
    return sealJudgeEngineInventory('dbos', items);
  });
}
