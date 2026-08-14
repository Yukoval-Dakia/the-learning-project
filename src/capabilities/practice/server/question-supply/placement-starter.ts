import type { Db, Tx } from '@/db/client';
import { placement_starter_claim } from '@/db/schema';
import {
  JOB_RETRY_DELAY_SECONDS,
  JOB_RETRY_LIMIT,
  type QuizGenJobData,
  fromPgBossDrizzleTx,
  getStartedQuestionSupplyBoss,
} from '@/kernel/question-supply-infrastructure';
import { and, eq } from 'drizzle-orm';
import type { SendOptions } from 'pg-boss';
import { dispatchSupplyTarget } from './dispatcher';
import { EvidenceDemandV1, evidenceDemandToTargetContext } from './evidence-demand';
import type { QuestionSupplyTarget } from './target-discovery';

const PLACEMENT_STARTER_COUNT = 8;

// The status→queued transition can collide with placement_starter_claim_nonterminal_uq when another
// claim for the same goal+subject is already in flight (YUK-452 round-2). postgres.js surfaces the
// index name as constraint_name; pg-boss's internal `pg` driver uses `constraint`. drizzle wraps the
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
    routePreference: ['quiz_gen'],
    preferredGenerationMethod: 'closed_book',
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

export async function dispatchPlacementStarterClaimTx(
  tx: Tx,
  claimId: string,
  send: (queue: 'quiz_gen', data: QuizGenJobData, options: SendOptions) => Promise<string | null>,
  admit: PlacementStarterAdmission = async () => true,
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
  // the claim persists across the savepoint (YUK-452 round-2 / YUK-776).
  try {
    return await tx.transaction(async (sp) => {
      const target = buildPlacementStarterTarget(claim);
      const result = await dispatchSupplyTarget(sp, target, {
        atomic: true,
        cooldownDays: 0,
        actorRef: 'placement_starter',
        tavilyAvailable: () => true,
        enqueueQuizGen: (data) =>
          send('quiz_gen', data, {
            db: fromPgBossDrizzleTx(sp),
            retryLimit: JOB_RETRY_LIMIT,
            retryDelay: JOB_RETRY_DELAY_SECONDS,
            retryBackoff: true,
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
  const boss = await getStartedQuestionSupplyBoss();
  return db.transaction((tx) =>
    dispatchPlacementStarterClaimTx(
      tx,
      claimId,
      (queue, data, options) => boss.send(queue, data, options),
      admit,
    ),
  );
}

// pg-boss job states from which a further delivery may STILL arrive. 'created' and 'retry' are
// waiting to be fetched; 'active' is being worked right now.
//
// This is an ALLOWLIST, not an enumeration of the terminal states, and that is the load-bearing
// property: any state not listed — including one added by a future pg-boss, or the historical
// 'expired' — reads as NOT live. That is the safe default here, because "not live" only ever
// leads to a reap that is already gated behind the 6h grace window and the claim's own status
// re-check, whereas defaulting unknown states to live would let a genuine zombie block every
// later goal revision forever (the exact bug this sweeper exists to fix).
//
// On 'expired' specifically (review PRRT…nAc suggested adding it to the state union): the
// installed pg-boss v12.26.1 `job_state` enum has exactly six states — created / retry / active /
// completed / cancelled / failed — and 'expired' is NOT among them; it is a v9/v10 state, and v12
// handles a timed-out job by deleting and re-inserting it as retry or failed. That was verified
// against plans.d.ts JOB_STATES + plans.js by YUK-758; see the mapBossState docblock in
// src/server/orchestration/orchestrator.ts for the full write-up. Naming it in the union here
// would contradict that finding, so it is called out as the drift case the allowlist absorbs.
const LIVE_PLACEMENT_JOB_STATES: ReadonlySet<string> = new Set(['created', 'retry', 'active']);

/**
 * True when the quiz_gen job backing a placement starter claim may still redeliver (YUK-761).
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
export async function isPlacementStarterJobLive(jobId: string | null): Promise<boolean> {
  if (!jobId) return false;
  const boss = await getStartedQuestionSupplyBoss();
  const job = await boss.getJobById('quiz_gen', jobId);
  return job != null && LIVE_PLACEMENT_JOB_STATES.has(job.state);
}
