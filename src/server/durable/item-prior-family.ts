// YUK-1355: unregistered, read-only DAG member candidate. No cron or paid dispatch.
// Safe durable paid claims/receipts are a parent prerequisite. Every invocation
// fails after admission, including an empty batch, so it cannot discharge a node.

import { DBOS } from '@dbos-inc/dbos-sdk';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  DEFAULT_MAX_PER_RUN,
  ItemPriorApplicationError,
  type ItemPriorCandidateFrozen,
  ItemPriorDurableStoreError,
  type ItemPriorExecutionParams,
  type ItemPriorPreparedWork,
  ItemPriorReceiptPersistenceError,
  type ItemPriorRepEffectPort,
  type ItemPriorStagedItem,
  commitItemPriorStagedCalibration,
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
  /**
   * Frozen per-candidate paid inputs (subject profile included), prepared
   * inside the same read-only snapshot. Execution and every later recorded-step
   * replay consume only these works: re-resolving a profile after admission
   * would re-key the input digest, strand old obligations and re-send the same
   * logical input under a new identity (parent review 2026-10-11).
   */
  prepared: ItemPriorPreparedWork[];
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

/**
 * Shared admission body (one recorded step, `item-prior-admission-v1`): epoch
 * gate, then a read-only repeatable-read freeze of delivery identity,
 * normalized params, candidates and knowledge names. Used unchanged by the
 * blocked candidate and by the port-driven execution path below.
 */
async function admitItemPriorMember(
  deps: ItemPriorMemberDeps,
  request: ItemPriorMemberRequest,
): Promise<ItemPriorAdmission> {
  // All I/O stays inside the step. A missing checkpoint may repeat these reads;
  // retriesAllowed:false does not prevent crash recovery from running a step.
  await (deps.gateEpoch ?? waitForRunnableEpoch)(deps.db);
  return deps.db.transaction(
    async (tx) => {
      await verifyItemPriorMemberIdentity(tx, request);
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

// ─── YUK-1355 — real per-rep execution behind the shared port (unregistered) ──
//
// This path exists so the seams above compose into an executable member the
// moment the parent relays lane B's fixed typed protocol. It stays
// unregistered and unbooted, requires an explicit port AND runTaskFn (no
// manufactured defaults), and never turns the blocked candidate's rejection
// off. Held items are counted and returned — never thrown, never retried
// in-run, never auto-resent on a later delivery. Durable unknowns (store
// access, receipt persistence, application outcome) propagate as dedicated
// errors instead of being isolated or completed over.

export interface ItemPriorMemberExecutionDeps extends ItemPriorMemberDeps {
  /** Lane B's durable paid-effect protocol, relayed by the parent. Required. */
  readonly port: ItemPriorRepEffectPort;
  /** Explicit provider runner; no default is manufactured here. Required. */
  readonly runTaskFn: PracticeTaskRunFn;
}

export interface ItemPriorDurableMemberResult {
  /** Scheduler delivery identity — distinct from every item's rep identity. */
  readonly identity: ItemPriorAdmission['identity'];
  readonly params: ItemPriorExecutionParams;
  readonly considered: number;
  /** Domain hard row verified to match this staged draft — NOT a paid-effect receipt guarantee. */
  readonly applied: number;
  /** An existing differing hard row held; this attempt's draft was not persisted. */
  readonly superseded: number;
  readonly held: number;
  readonly noAnchor: number;
  readonly incomplete: number;
  readonly skippedError: number;
  readonly items: readonly ItemPriorStagedItem[];
}

export async function runItemPriorDurableMemberExecution(
  deps: ItemPriorMemberExecutionDeps,
): Promise<ItemPriorDurableMemberResult> {
  const request = itemPriorMemberRequestSchema.parse(deps.request);
  const admission = await deps.steps.runStep('item-prior-admission-v1', () =>
    admitItemPriorMember(deps, request),
  );
  const items: ItemPriorStagedItem[] = [];
  const counts = {
    applied: 0,
    superseded: 0,
    held: 0,
    noAnchor: 0,
    incomplete: 0,
    skippedError: 0,
  };
  // Frozen works only: preparation already happened inside the recorded
  // admission snapshot, so execution never re-resolves profiles or re-keys
  // input digests (recovery input drift, parent review 2026-10-11).
  for (const work of admission.prepared) {
    try {
      const staged = await runItemPriorItemRepStages(work, {
        port: deps.port,
        runTaskFn: deps.runTaskFn,
      });
      const verification = await commitItemPriorStagedCalibration(deps.db, staged);
      if (verification.status === 'applied') {
        counts.applied++;
      } else if (verification.status === 'superseded') {
        counts.superseded++;
      } else if (staged.status === 'held') {
        counts.held++;
      } else if (staged.status === 'no-anchor') {
        counts.noAnchor++;
      } else {
        counts.incomplete++;
      }
      items.push(staged);
    } catch (err) {
      // Durable unknowns propagate (parent review 2026-10-11): a store,
      // receipt-persistence or application failure at/after a paid send must
      // stay visible for later reconciliation — isolating it as an ordinary
      // skip would let a later delivery treat an unresolved obligation as a
      // plain retry or, worse, let the member report completion over it.
      if (
        err instanceof ItemPriorDurableStoreError ||
        err instanceof ItemPriorReceiptPersistenceError ||
        err instanceof ItemPriorApplicationError
      ) {
        throw err;
      }
      // Defensive per-item isolation for unexpected non-durable failures.
      // Every classified path above either returns an outcome or throws one of
      // the propagated durable errors; provider failures are recorded in the
      // port and surface as status 'held', so they never reach this catch.
      console.error('[item_prior_durable_member] question staging failed', {
        questionId: work.candidate.id,
        err,
      });
      counts.skippedError++;
    }
  }
  return {
    identity: admission.identity,
    params: admission.params,
    considered: admission.candidates.length,
    ...counts,
    items,
  } satisfies ItemPriorDurableMemberResult;
}
