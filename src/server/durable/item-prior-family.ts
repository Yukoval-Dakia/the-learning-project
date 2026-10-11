// YUK-1355: unregistered, read-only DAG member candidate. No cron or paid dispatch.
// Safe durable paid claims/receipts are a parent prerequisite. Every invocation
// fails after admission, including an empty batch, so it cannot discharge a node.

import { DBOS } from '@dbos-inc/dbos-sdk';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  DEFAULT_MAX_PER_RUN,
  type ItemPriorCandidateFrozen,
  type ItemPriorExecutionParams,
  type ItemPriorPreparedWork,
  type ItemPriorStagedItem,
  normalizeMethod,
  normalizeReps,
  prepareItemPriorWork,
  resolveItemPriorKnowledgeNames,
  runItemPriorItemRepStages,
  selectItemPriorCandidates,
} from '@/capabilities/practice/server/item-prior-durable-operation';
import type { PracticeTaskRunFn } from '@/capabilities/practice/server/task-runtime';
import type { Db, Tx } from '@/db/client';
import { waitForRunnableEpoch } from '@/server/contract-epoch';
import {
  type ItemPriorDispatch,
  type ItemPriorDispatchedRequest,
  ItemPriorMemberIdentityError,
  type ItemPriorMemberRequest,
  ItemPriorPaidEffectAdapter,
  itemPriorDispatchedRequestSchema,
  itemPriorMemberRequestSchema,
  readItemPriorPgBossDelivery,
} from './item-prior-paid-effect-adapter';
import { readPaidEffectControl } from './paid-effect-control';
import {
  PaidEffectControlFencedError,
  decidePaidEffectControlAdmission,
  paidEffectJsonEquals,
} from './paid-effect-protocol';

export const ITEM_PRIOR_MEMBER = 'item_prior_backfill';
// The retained manifest declares dependsOn: []; this candidate is only that root.
export const ITEM_PRIOR_UPSTREAMS: readonly string[] = [];

export type {
  ItemPriorDispatchedRequest,
  ItemPriorMemberRequest,
} from './item-prior-paid-effect-adapter';
export {
  ItemPriorMemberIdentityError,
  itemPriorDispatchedRequestSchema,
  itemPriorMemberRequestSchema,
} from './item-prior-paid-effect-adapter';

export interface ItemPriorAdmission {
  identity: Pick<ItemPriorMemberRequest, 'member' | 'dagRunId' | 'runDate' | 'nodeId'>;
  params: ItemPriorExecutionParams;
  candidates: ItemPriorCandidateFrozen[];
  knowledgeNames: [string, string][];
  /**
   * Frozen per-candidate paid inputs (subject profile included), prepared
   * inside the same read-only snapshot. Execution and every later recorded-step
   * replay consume only these works: re-resolving a profile after admission
   * would re-key the input digest, strand old obligations and re-send the same
   * logical input under a new identity (parent review 2026-10-11).
   */
  prepared: ItemPriorPreparedWork[];
}

export class ItemPriorDurabilityPrerequisiteError extends Error {
  readonly code = 'ITEM_PRIOR_DURABLE_PREREQUISITE';

  constructor(readonly admission: ItemPriorAdmission) {
    super(
      `item_prior_backfill node ${admission.identity.nodeId}: durable paid claim/receipt owner missing; ${admission.candidates.length} frozen candidate(s), no dispatch`,
    );
  }
}

// One admission step only. This port does not model paid-effect recovery.
export interface ItemPriorStepRunner {
  runStep(name: string, fn: () => Promise<ItemPriorAdmission>): Promise<ItemPriorAdmission>;
}

const runRowSchema = z.object({ id: z.string(), run_date: z.string(), status: z.string() });
const nodeRowSchema = z.object({
  id: z.string(),
  status: z.enum(['pending', 'enqueued', 'running', 'succeeded', 'failed', 'skipped']),
  boss_job_id: z.string().nullable(),
});
const bossJobSchema = z.object({ state: z.string() });
async function verifyItemPriorMemberIdentity(
  tx: Tx,
  request: ItemPriorMemberRequest,
  dispatch?: ItemPriorDispatch,
): Promise<void> {
  const [rawRun] = await tx.execute(
    sql`select id, run_date, status from dag_orchestration_run where id = ${request.dagRunId}`,
  );
  if (!rawRun) throw new ItemPriorMemberIdentityError(`Unknown DAG run ${request.dagRunId}`);
  const run = runRowSchema.parse(rawRun);
  if (run.status !== 'running' || run.run_date !== request.runDate)
    throw new ItemPriorMemberIdentityError(
      `DAG run ${request.dagRunId}: status=${run.status}, run_date=${run.run_date} != running/${request.runDate}`,
    );
  const [rawNode] = await tx.execute(
    sql`select id, status, boss_job_id from dag_orchestration_node
      where run_id = ${request.dagRunId} and job_name = ${ITEM_PRIOR_MEMBER}`,
  );
  if (!rawNode)
    throw new ItemPriorMemberIdentityError(
      `No DAG node for ${ITEM_PRIOR_MEMBER} in run ${request.dagRunId}`,
    );
  const node = nodeRowSchema.parse(rawNode);
  if (node.id !== request.nodeId || !['pending', 'enqueued', 'running'].includes(node.status))
    throw new ItemPriorMemberIdentityError(
      `DAG node ${node.id}: status=${node.status}, expected nonterminal node ${request.nodeId}`,
    );
  if (dispatch) {
    if (dispatch.backend === 'pg-boss') {
      if (node.boss_job_id !== dispatch.deliveryId) {
        throw new ItemPriorMemberIdentityError(
          'Dispatched pg-boss job is not the node-bound original delivery',
        );
      }
      await readItemPriorPgBossDelivery(tx, { ...request, dispatch }, 'read');
      // Terminal jobs may recover receipts; reservation rechecks state under a job row lock.
    } else if (node.boss_job_id) {
      const [rawJob] = await tx.execute(
        sql`select state::text as state from pgboss.job where id = ${node.boss_job_id}::uuid`,
      );
      if (rawJob && ['created', 'retry', 'active'].includes(bossJobSchema.parse(rawJob).state)) {
        throw new ItemPriorMemberIdentityError(
          `Competing pg-boss job ${node.boss_job_id} still owns node ${request.nodeId}`,
        );
      }
    }
    // Read-only snapshot check preserves the supplied generation. The adapter's shared claim
    // enforces control atomically before a send, including a concurrent switch.
    const control = await readPaidEffectControl(tx, ITEM_PRIOR_MEMBER);
    const admission = decidePaidEffectControlAdmission(control, dispatch);
    if (admission.kind === 'fenced') {
      throw new PaidEffectControlFencedError(ITEM_PRIOR_MEMBER, admission.reason, admission.owner);
    }
    return;
  }
  // This is only a read check in one direction, not a cross-backend claim or fence.
  // Even passing this check never enables paid dispatch in this checkpoint.
  if (node.boss_job_id) {
    const [rawBossJob] = await tx.execute(
      sql`select state::text as state from pgboss.job where id = ${node.boss_job_id}::uuid`,
    );
    if (
      rawBossJob &&
      ['created', 'retry', 'active'].includes(bossJobSchema.parse(rawBossJob).state)
    )
      throw new ItemPriorMemberIdentityError(
        `pg-boss job ${node.boss_job_id} still owns node ${request.nodeId}`,
      );
  }
}

export interface ItemPriorMemberDeps {
  db: Db;
  steps: ItemPriorStepRunner;
  request: unknown;
  gateEpoch?: (db: Db) => Promise<void>;
}

/**
 * Shared admission body (one recorded step, `item-prior-admission-v1`): epoch
 * gate, then a read-only repeatable-read freeze of delivery identity,
 * normalized params, candidates and knowledge names. Used unchanged by the
 * blocked candidate and by the explicit versioned execution path below.
 */
async function admitItemPriorMember(
  deps: Pick<ItemPriorMemberDeps, 'db' | 'gateEpoch'>,
  request: ItemPriorMemberRequest,
  dispatch?: ItemPriorDispatch,
): Promise<ItemPriorAdmission> {
  // All I/O stays inside the step. A missing checkpoint may repeat these reads;
  // retriesAllowed:false does not prevent crash recovery from running a step.
  await (deps.gateEpoch ?? waitForRunnableEpoch)(deps.db);
  return deps.db.transaction(
    async (tx) => {
      await verifyItemPriorMemberIdentity(tx, request, dispatch);
      const params = {
        method: normalizeMethod(request.method),
        reps: normalizeReps(request.reps),
      } satisfies ItemPriorExecutionParams;
      const candidates = await selectItemPriorCandidates(tx, DEFAULT_MAX_PER_RUN);
      const names = await resolveItemPriorKnowledgeNames(tx, candidates);
      // Freeze the exact paid inputs (subject profile included) inside this
      // snapshot so execution and every later replay use identical digests; a
      // profile change after admission can never re-key the work.
      const nameById = new Map(names);
      const prepared: ItemPriorPreparedWork[] = [];
      for (const candidate of candidates) {
        prepared.push(await prepareItemPriorWork(tx, candidate, nameById, params));
      }
      return {
        identity: {
          member: request.member,
          dagRunId: request.dagRunId,
          runDate: request.runDate,
          nodeId: request.nodeId,
        },
        params,
        candidates,
        knowledgeNames: [...names.entries()],
        prepared,
      } satisfies ItemPriorAdmission;
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

export async function runItemPriorDurableMember(deps: ItemPriorMemberDeps): Promise<never> {
  const request = itemPriorMemberRequestSchema.parse(deps.request);
  const admission = await deps.steps.runStep('item-prior-admission-v1', () =>
    admitItemPriorMember(deps, request),
  );

  // No token comparison, task invocation or domain write. A failed prerequisite
  // is not an unknown paid outcome and is not a terminal business disposition.
  throw new ItemPriorDurabilityPrerequisiteError(admission);
}

/** Parent integration entry, currently unused by registration, boot or manifests. */
export function registerItemPriorFamilyWorkflow(db: Db) {
  return DBOS.registerWorkflow(
    async (request: unknown): Promise<never> =>
      runItemPriorDurableMember({
        db,
        request,
        steps: {
          runStep: (name, fn) => DBOS.runStep(fn, { name, retriesAllowed: false }),
        },
      }),
    { name: ITEM_PRIOR_MEMBER },
  );
}

// Explicit versioned dispatch only. The old candidate and registration remain blocked.
export interface ItemPriorDispatchedAdmission extends ItemPriorAdmission {
  readonly dispatch: ItemPriorDispatchedRequest['dispatch'];
}

export interface ItemPriorExecutionStepRunner {
  runStep(
    name: string,
    fn: () => Promise<ItemPriorDispatchedAdmission>,
  ): Promise<ItemPriorDispatchedAdmission>;
}

export interface ItemPriorMemberExecutionDeps extends Omit<ItemPriorMemberDeps, 'steps'> {
  readonly steps: ItemPriorExecutionStepRunner;
  readonly runTaskFn: PracticeTaskRunFn;
}

export interface ItemPriorDurableMemberResult {
  readonly identity: ItemPriorAdmission['identity'];
  readonly dispatch: ItemPriorDispatchedRequest['dispatch'];
  readonly params: ItemPriorExecutionParams;
  readonly considered: number;
  /** Verified matched application disposition, possibly historical after later domain edits. Noncausal. */
  readonly matched: number;
  readonly superseded: number;
  readonly held: number;
  readonly noAnchor: number;
  readonly incomplete: number;
  readonly items: readonly ItemPriorStagedItem[];
}

export class ItemPriorMemberIncompleteError extends Error {
  readonly code = 'ITEM_PRIOR_MEMBER_INCOMPLETE';

  constructor(readonly result: ItemPriorDurableMemberResult) {
    super(`item_prior_backfill node ${result.identity.nodeId} has unresolved items`);
  }
}

export async function runItemPriorDurableMemberExecution(
  deps: ItemPriorMemberExecutionDeps,
): Promise<ItemPriorDurableMemberResult> {
  const request = itemPriorDispatchedRequestSchema.parse(deps.request);
  // A distinct recorded step prevents an old unversioned checkpoint from becoming an upgraded job.
  const admission = await deps.steps.runStep('item-prior-dispatched-admission-v1', async () => ({
    ...(await admitItemPriorMember(deps, request, request.dispatch)),
    dispatch: request.dispatch,
  }));
  const expectedIdentity = {
    member: request.member,
    dagRunId: request.dagRunId,
    runDate: request.runDate,
    nodeId: request.nodeId,
  };
  if (
    !paidEffectJsonEquals(admission.identity, expectedIdentity) ||
    !paidEffectJsonEquals(admission.dispatch, request.dispatch) ||
    !paidEffectJsonEquals(admission.params, {
      method: normalizeMethod(request.method),
      reps: normalizeReps(request.reps),
    })
  ) {
    throw new ItemPriorMemberIdentityError(
      'Recorded item-prior dispatch differs from original request',
    );
  }
  const effects = new ItemPriorPaidEffectAdapter(deps.db, request);
  const items: ItemPriorStagedItem[] = [];
  const counts = { matched: 0, superseded: 0, held: 0, noAnchor: 0, incomplete: 0 };
  for (const work of admission.prepared) {
    const staged = await runItemPriorItemRepStages(work, {
      effects,
      runTaskFn: deps.runTaskFn,
    });
    const disposition = await effects.commitStaged(work, staged);
    if (disposition.status === 'matched') counts.matched++;
    else if (disposition.status === 'superseded') counts.superseded++;
    else if (disposition.status === 'no-anchor') counts.noAnchor++;
    else if (staged.status === 'held') counts.held++;
    else counts.incomplete++;
    items.push(staged);
  }
  const result = {
    identity: admission.identity,
    dispatch: admission.dispatch,
    params: admission.params,
    considered: admission.candidates.length,
    ...counts,
    items,
  } satisfies ItemPriorDurableMemberResult;
  // Successful workflow return must never discharge a DAG member over an open obligation.
  if (result.held > 0 || result.incomplete > 0) throw new ItemPriorMemberIncompleteError(result);
  return result;
}
