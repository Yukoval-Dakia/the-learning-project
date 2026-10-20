// Unregistered, read-only DAG member candidate: no cron and no paid dispatch.
// Safe durable paid claims/receipts are a parent prerequisite. Every invocation
// fails after admission, including an empty batch, so it cannot discharge a node.

import { DBOS } from '@dbos-inc/dbos-sdk';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { PracticeTaskRunFn } from '@/capabilities/practice/public';
import {
  DEFAULT_MAX_PER_RUN,
  type ItemPriorCandidateFrozen,
  type ItemPriorDispatch,
  type ItemPriorDispatchedRequest,
  type ItemPriorExecutionParams,
  ItemPriorMemberIdentityError,
  type ItemPriorMemberRequest,
  ItemPriorPaidEffectAdapter,
  type ItemPriorPreparedWork,
  type ItemPriorStagedItem,
  itemPriorDispatchedRequestSchema,
  itemPriorMemberRequestSchema,
  normalizeMethod,
  normalizeReps,
  prepareItemPriorWork,
  readItemPriorPgBossDelivery,
  resolveItemPriorKnowledgeNames,
  runItemPriorItemRepStages,
  selectItemPriorCandidates,
} from '@/capabilities/practice/public';
import {
  PaidEffectControlFencedError,
  decidePaidEffectControlAdmission,
  paidEffectJsonEquals,
} from '@/core/migration/paid-effect-protocol';
import type { Db, Tx } from '@/db/client';
import { readPaidEffectControl } from '@/db/paid-effect-control';
import { waitForRunnableEpoch } from '@/server/contract-epoch';

export const ITEM_PRIOR_MEMBER = 'item_prior_backfill';
// The retained manifest declares dependsOn: []; this candidate is only that root.
export const ITEM_PRIOR_UPSTREAMS: readonly string[] = [];

export type {
  ItemPriorDispatchedRequest,
  ItemPriorMemberRequest,
} from '@/capabilities/practice/public';
export {
  ItemPriorMemberIdentityError,
  itemPriorDispatchedRequestSchema,
  itemPriorMemberRequestSchema,
} from '@/capabilities/practice/public';

export interface ItemPriorAdmission {
  identity: Pick<ItemPriorMemberRequest, 'member' | 'dagRunId' | 'runDate' | 'nodeId'>;
  params: ItemPriorExecutionParams;
  candidates: ItemPriorCandidateFrozen[];
  knowledgeNames: [string, string][];
  /**
   * Paid inputs frozen in the admission snapshot, subject profile included.
   * Execution and step replay must consume these works; re-resolving a profile
   * would change the digest and re-send the same logical input as a new identity.
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
      // Terminal jobs may recover receipts; the reservation rechecks under a job row lock.
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
    // Read-only check preserves the supplied generation; the shared claim still
    // enforces control atomically before a send, including a concurrent switch.
    const control = await readPaidEffectControl(tx, ITEM_PRIOR_MEMBER);
    const admission = decidePaidEffectControlAdmission(control, dispatch);
    if (admission.kind === 'fenced') {
      throw new PaidEffectControlFencedError(ITEM_PRIOR_MEMBER, admission.reason, admission.owner);
    }
    return;
  }
  // One-directional read check, not a cross-backend claim or fence; passing it
  // never enables paid dispatch in this checkpoint.
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
 * Shared admission body: epoch gate, then a read-only repeatable-read snapshot
 * freezing identity, normalized params, candidates and knowledge names.
 */
async function admitItemPriorMember(
  deps: Pick<ItemPriorMemberDeps, 'db' | 'gateEpoch'>,
  request: ItemPriorMemberRequest,
  dispatch?: ItemPriorDispatch,
): Promise<ItemPriorAdmission> {
  // All I/O stays inside the step; crash recovery may run it again even with
  // retriesAllowed:false.
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
      // Freeze paid inputs in this snapshot so execution and replay use identical
      // digests; a later profile change cannot re-key the work.
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
  // is neither an unknown paid outcome nor a terminal disposition.
  throw new ItemPriorDurabilityPrerequisiteError(admission);
}

/** Parent integration entry; no registration, boot path or manifest uses it yet. */
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

// Explicit versioned dispatch only; the old candidate stays blocked.
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
