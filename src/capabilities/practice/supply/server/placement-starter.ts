import { and, desc, eq, sql } from 'drizzle-orm';
import type { SendOptions } from 'pg-boss';
import type { Db, Tx } from '@/db/client';
import { goal, learning_session, placement_starter_claim } from '@/db/schema';
import {
  JOB_RETRY_DELAY_SECONDS,
  JOB_RETRY_LIMIT,
  type PlacementJobQueue,
  enqueuePlacementJob,
  enqueuePlacementSupplyExecuteJob,
  fromPgBossDrizzleTx,
  placementJobState,
} from '@/kernel/placement-jobs';
import type { QuizGenJobData } from '@/kernel/quiz-gen-contract';
import { EvidenceDemandV1, evidenceDemandToTargetContext } from '@/kernel/supply-contracts';
import { dispatchSupplyTarget } from './dispatcher';
import { PLACEMENT_QUEUE_EXPIRY_MS } from './placement-starter-attempts';
import { resolvePlacementStarterGoalAuthority } from './placement-starter-store';
import type { QuestionSupplyTarget } from './target-discovery';

const PLACEMENT_STARTER_COUNT = 8;

// The status→queued transition can collide with placement_starter_claim_nonterminal_uq when another
// claim for the same goal+subject is already in flight. postgres.js surfaces the index name as
// constraint_name; pg-boss's internal `pg` driver uses `constraint`. drizzle wraps the
// driver error in a DrizzleQueryError, so walk the `.cause` chain and check both field names.
function isNonterminalSingleFlightViolation(err: unknown): boolean {
  for (let cur: unknown = err, depth = 0; cur != null && depth < 5; depth++) {
    const e = cur as {
      code?: string;
      constraint_name?: string;
      constraint?: string;
      cause?: unknown;
    };
    if (
      e.code === '23505' &&
      (e.constraint_name === 'placement_starter_claim_nonterminal_uq' ||
        e.constraint === 'placement_starter_claim_nonterminal_uq')
    ) {
      return true;
    }
    cur = e.cause;
  }
  return false;
}

type ClaimRow = typeof placement_starter_claim.$inferSelect;

/** The pg-boss queue that owns a claim's deliveries, fixed by the claim's stored route. */
export function placementClaimJobQueue(claim: Pick<ClaimRow, 'supply_route'>): PlacementJobQueue {
  return claim.supply_route === 'sourcing_web' ? 'supply_execute' : 'quiz_gen';
}

export function buildPlacementStarterDemand(claim: ClaimRow) {
  return EvidenceDemandV1.parse({
    version: 1,
    demand_id: claim.demand_id,
    policy_version: 'placement-starter-v1',
    subject_id: claim.subject_id,
    claim: {
      kind: 'content_coverage',
      knowledge_ids: [claim.knowledge_id],
      statement: `${PLACEMENT_STARTER_COUNT} verified active placement starters for semantic goal revision ${claim.semantic_goal_revision_id}`,
    },
    evidence: {
      observables: ['distinct verified active pool-visible question eligible for placement'],
      minimum_observations: PLACEMENT_STARTER_COUNT,
    },
    task: { kinds: ['any'], allowed_uses: ['placement', 'diagnostic'] },
    difficulty: { band: 'near', scale: 'loom_difficulty_1_5', target_value: null },
    inventory_goal: { eligible_count: PLACEMENT_STARTER_COUNT, horizon_days: 1 },
    control: {
      needed_by: null,
      // null for sourcing_web claims: no money cap under the approved background policy.
      max_budget_micro_usd: claim.budget_limit_micro_usd,
      max_attempts: claim.max_paid_attempts,
    },
    causes: [{ kind: 'owner_request', ref: claim.semantic_goal_revision_id }],
  });
}

export function buildPlacementStarterTarget(claim: ClaimRow): QuestionSupplyTarget {
  const demand = buildPlacementStarterDemand(claim);
  return {
    id: claim.target_id,
    fingerprint: claim.fingerprint,
    gapKind: 'placement_starter',
    subjectId: claim.subject_id,
    knowledgeIds: [claim.knowledge_id],
    kind: 'any',
    difficultyBand: 'near',
    desiredCount: PLACEMENT_STARTER_COUNT,
    minSourceTier: 3,
    // In-flight claims created before the 2026-11-02 policy keep closed-book quiz_gen; new
    // claims are the source agent's (web search, source verification, independent admission).
    ...(claim.supply_route === 'sourcing_web'
      ? { routePreference: ['sourcing_web' as const] }
      : {
          routePreference: ['quiz_gen' as const],
          preferredGenerationMethod: 'closed_book' as const,
        }),
    priority: 1,
    reason: `placement starter for semantic goal revision ${claim.semantic_goal_revision_id}`,
    constraints: { exactCount: PLACEMENT_STARTER_COUNT },
    context: evidenceDemandToTargetContext(demand),
    placementStarter: {
      claimId: claim.id,
      semanticGoalRevisionId: claim.semantic_goal_revision_id,
    },
  };
}

type PlacementStarterAdmission = (tx: Tx, claim: ClaimRow) => Promise<boolean>;
type SendSupplyExecute = (
  data: Record<string, unknown>,
  options: SendOptions,
) => Promise<string | null>;

export async function dispatchPlacementStarterClaimTx(
  tx: Tx,
  claimId: string,
  send: (queue: 'quiz_gen', data: QuizGenJobData, options: SendOptions) => Promise<string | null>,
  admit: PlacementStarterAdmission = async () => true,
  sendSupplyExecute: SendSupplyExecute = enqueuePlacementSupplyExecuteJob,
): Promise<string | null> {
  const [claim] = await tx
    .select()
    .from(placement_starter_claim)
    .where(eq(placement_starter_claim.id, claimId))
    .for('update');
  if (!claim || claim.status !== 'pending_dispatch') return claim?.pg_boss_job_id ?? null;
  if (!(await admit(tx, claim))) return null;

  const now = new Date();
  // Enqueue + status→queued run in a SAVEPOINT (nested tx) so a nonterminal single-flight 23505 on
  // the pending→queued update rolls back the enqueue (no orphan quiz_gen job) without aborting the
  // outer tx — then we leave the claim pending for a later attempt. The outer FOR UPDATE lock on
  // the claim persists across the savepoint.
  try {
    return await tx.transaction(async (sp) => {
      const target = buildPlacementStarterTarget(claim);
      // Provenance anchor: the claim only exists because a learner started
      // placement on this goal. Server-resolve the goal's latest placement
      // session and bind it onto the dispatch event; admission lineage proof
      // reads session-bound ancestors and nothing else counts.
      const [placementSession] = await sp
        .select({ id: learning_session.id })
        .from(learning_session)
        .where(
          and(eq(learning_session.type, 'placement'), eq(learning_session.goal_id, claim.goal_id)),
        )
        .orderBy(desc(learning_session.started_at))
        .limit(1);
      const result = await dispatchSupplyTarget(sp, target, {
        atomic: true,
        cooldownDays: 0,
        actorRef: 'placement_starter',
        session_id: placementSession?.id ?? null,
        webSearchAvailable: () => true,
        enqueueQuizGen: (data) =>
          send('quiz_gen', data, {
            db: fromPgBossDrizzleTx(sp),
            retryLimit: JOB_RETRY_LIMIT,
            retryDelay: JOB_RETRY_DELAY_SECONDS,
            retryBackoff: true,
          }),
        // The supply_execute delivery carries the same transport contract the placement
        // consumer verifies: 3 deliveries, the original backoff, and the 120-minute expiry.
        enqueueSupplyExecute: (data) =>
          sendSupplyExecute(data, {
            db: fromPgBossDrizzleTx(sp),
            retryLimit: JOB_RETRY_LIMIT,
            retryDelay: JOB_RETRY_DELAY_SECONDS,
            retryBackoff: true,
            expireInSeconds: PLACEMENT_QUEUE_EXPIRY_MS / 1_000,
          }),
      });
      const jobId = result.jobId;
      if (!jobId)
        throw new Error(`pg-boss returned no job id for placement starter claim ${claim.id}`);

      await sp
        .update(placement_starter_claim)
        .set({
          status: 'queued',
          pg_boss_job_id: jobId,
          updated_at: now,
          version: claim.version + 1,
        })
        .where(
          and(
            eq(placement_starter_claim.id, claim.id),
            eq(placement_starter_claim.status, 'pending_dispatch'),
          ),
        );
      return jobId;
    });
  } catch (err) {
    if (!isNonterminalSingleFlightViolation(err)) throw err;
    // Another revision still owns the paid single-flight slot. The losing claim may be the CURRENT
    // authoritative revision, so terminalizing it would be irreversible: its deterministic
    // (revision, subject) identity cannot be re-created after the old flight eventually finishes.
    // Keep it pending. The savepoint already rolled back the enqueue + observations, so this is a
    // free deferral with no orphan job; /placement/start or the recovery sweeper can retry after the
    // winner terminalizes. A genuinely stale pending claim is cancelled by the sweeper's explicit
    // semantic-revision guard, where authority is known rather than guessed from a 23505.
    return null;
  }
}

export async function dispatchPlacementStarterClaim(
  db: Db,
  claimId: string,
  admit?: PlacementStarterAdmission,
): Promise<string | null> {
  return db.transaction((tx) =>
    dispatchPlacementStarterClaimTx(tx, claimId, enqueuePlacementJob, admit),
  );
}

/**
 * Hand a claim whose paid delivery just failed back into dispatch. The same-job pg-boss
 * retry cannot produce another sourcing run — the web demand is durable-'blocked' under
 * the demand id baked into the failed job's payload, so a same-job redelivery tallies
 * 'skipped' and underfills without ever fetching again. Only a fresh job (a fresh
 * demand id per send) performs the next real find-question. The
 * retry_scheduled → pending_dispatch CAS re-arms the one legitimate dispatch CAS in
 * dispatchPlacementStarterClaimTx (pending_dispatch → queued), keeping this handoff,
 * the sweeper, and /placement/start single-sender — a sweeper that dispatched first
 * just makes dispatch return the winner's job id. The admit re-verifies inside the
 * dispatch transaction that the goal is still active and the claim's semantic revision
 * is still authoritative; a declined admit or send leaves the claim pending_dispatch
 * with next_reconcile_at = now, where the sweeper's pending leg applies its own
 * guard ceremony on the next tick.
 */
export async function handOffFailedPlacementDelivery(db: Db, claimId: string): Promise<boolean> {
  const now = new Date();
  const moved = await db
    .update(placement_starter_claim)
    .set({
      status: 'pending_dispatch',
      next_reconcile_at: now,
      updated_at: now,
      version: sql`${placement_starter_claim.version} + 1`,
    })
    .where(
      and(
        eq(placement_starter_claim.id, claimId),
        eq(placement_starter_claim.status, 'retry_scheduled'),
      ),
    )
    .returning({ id: placement_starter_claim.id });
  if (moved.length !== 1) return false;
  const jobId = await dispatchPlacementStarterClaim(db, claimId, async (tx, claim) => {
    const [goalRow] = await tx
      .select({ status: goal.status })
      .from(goal)
      .where(eq(goal.id, claim.goal_id))
      .limit(1);
    if (goalRow?.status !== 'active') return false;
    const authority = await resolvePlacementStarterGoalAuthority(tx, claim.goal_id);
    return authority.semanticGoalRevisionId === claim.semantic_goal_revision_id;
  });
  return jobId !== null;
}

// pg-boss job states from which a further delivery may STILL arrive. 'created' and 'retry' are
// waiting to be fetched; 'active' is being worked right now.
// This is an ALLOWLIST, not an enumeration of the terminal states, and that is the load-bearing
// property: any state not listed — including one added by a future pg-boss, or the historical
// 'expired' — reads as NOT live. That is the safe default here, because "not live" only ever
// leads to a reap that is already gated behind the 6h grace window and the claim's own status
// re-check, whereas defaulting unknown states to live would let a genuine zombie block every
// later goal revision forever (the exact bug this sweeper exists to fix).
// On 'expired' specifically (review PRRT…nAc suggested adding it to the state union): the
// installed pg-boss v12.26.1 `job_state` enum has exactly six states — created / retry / active /
// completed / cancelled / failed — and 'expired' is NOT among them; it is a v9/v10 state, and v12
// handles a timed-out job by deleting and re-inserting it as retry or failed. That was verified
// against plans.d.ts JOB_STATES + plans.js by ; see the mapBossState docblock in
// src/server/orchestration/orchestrator.ts for the full write-up. Naming it in the union here
// would contradict that finding, so it is called out as the drift case the allowlist absorbs.
const LIVE_PLACEMENT_JOB_STATES: ReadonlySet<string> = new Set(['created', 'retry', 'active']);

/**
 * True when the job backing a placement starter claim (on the claim's own queue) may still
 * redeliver.
 *
 * The recovery sweeper MUST consult this before terminalizing a long-stale 'retry_scheduled'
 * claim: elapsed time alone is not proof that the retry is dead. If the quiz_gen queue is paused,
 * saturated, or the worker fleet is down, a perfectly legitimate retry can sit unfetched for far
 * longer than the sweeper's grace window — and terminalizing the claim then would make the
 * eventual delivery fail admission in `acquirePlacementAttempt` ("placement starter claim is
 * exhausted"), throwing away paid generation work that was still coming.
 *
 * A null jobId or a job pg-boss can no longer find (deleted past `retentionSeconds`) means no
 * redelivery source exists — not live.
 */
export async function isPlacementStarterJobLive(
  jobId: string | null,
  queue: PlacementJobQueue = 'quiz_gen',
): Promise<boolean> {
  if (!jobId) return false;
  const state = await placementJobState(jobId, queue);
  return state != null && LIVE_PLACEMENT_JOB_STATES.has(state);
}
