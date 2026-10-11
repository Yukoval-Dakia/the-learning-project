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
  normalizeMethod,
  normalizeReps,
  resolveItemPriorKnowledgeNames,
  selectItemPriorCandidates,
} from '@/capabilities/practice/server/item-prior-durable-operation';
import type { Db, Tx } from '@/db/client';
import { waitForRunnableEpoch } from '@/server/contract-epoch';

export const ITEM_PRIOR_MEMBER = 'item_prior_backfill';
// The retained manifest declares dependsOn: []; this candidate is only that root.
export const ITEM_PRIOR_UPSTREAMS: readonly string[] = [];

export const itemPriorMemberRequestSchema = z.strictObject({
  member: z.literal(ITEM_PRIOR_MEMBER),
  dagRunId: z.string().min(1),
  runDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'runDate must be YYYY-MM-DD'),
  nodeId: z.string().min(1),
  method: z.enum(['feature', 'llasa']).optional(),
  reps: z.number().int().positive().max(9).optional(),
});
export type ItemPriorMemberRequest = z.infer<typeof itemPriorMemberRequestSchema>;

export interface ItemPriorAdmission {
  identity: Pick<ItemPriorMemberRequest, 'member' | 'dagRunId' | 'runDate' | 'nodeId'>;
  params: ItemPriorExecutionParams;
  candidates: ItemPriorCandidateFrozen[];
  knowledgeNames: [string, string][];
}

export class ItemPriorMemberIdentityError extends Error {}

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

export async function runItemPriorDurableMember(deps: ItemPriorMemberDeps): Promise<never> {
  const request = itemPriorMemberRequestSchema.parse(deps.request);
  const admission = await deps.steps.runStep('item-prior-admission-v1', async () => {
    // All I/O stays inside the step. A missing checkpoint may repeat these reads;
    // retriesAllowed:false does not prevent crash recovery from running a step.
    await (deps.gateEpoch ?? waitForRunnableEpoch)(deps.db);
    return deps.db.transaction(
      async (tx) => {
        await verifyItemPriorMemberIdentity(tx, request);
        const candidates = await selectItemPriorCandidates(tx, DEFAULT_MAX_PER_RUN);
        const names = await resolveItemPriorKnowledgeNames(tx, candidates);
        return {
          identity: {
            member: request.member,
            dagRunId: request.dagRunId,
            runDate: request.runDate,
            nodeId: request.nodeId,
          },
          params: { method: normalizeMethod(request.method), reps: normalizeReps(request.reps) },
          candidates,
          knowledgeNames: [...names.entries()],
        } satisfies ItemPriorAdmission;
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  });

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
