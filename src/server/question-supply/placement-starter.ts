import type { Db, Tx } from '@/db/client';
import { placement_starter_claim } from '@/db/schema';
import type { QuizGenJobData } from '@/server/boss/handlers/quiz_gen';
import { fromPgBossDrizzleTx } from '@/server/boss/pg-boss-drizzle';
import { JOB_RETRY_DELAY_SECONDS, JOB_RETRY_LIMIT } from '@/server/boss/queue-config';
import { and, eq } from 'drizzle-orm';
import type { SendOptions } from 'pg-boss';
import { dispatchSupplyTarget } from './dispatcher';
import { EvidenceDemandV1, evidenceDemandToTargetContext } from './evidence-demand';
import { markPlacementStarterClaimTerminal } from './placement-starter-store';
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
  // outer tx — then we terminalize this claim below. The outer FOR UPDATE lock on the claim persists
  // across the savepoint (YUK-452 round-2).
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
    // Another claim for this goal+subject is already in flight and won the single-flight slot. This
    // (losing/stale) claim never dispatched, so it spent nothing — terminalize it as 'cancelled'
    // (the closest existing terminal enum state; there is no 'superseded' in the status enum / check
    // constraint, and we must not widen the enum). The savepoint rollback already undid the enqueue
    // and dispatch observation writes, so no paid flight and no orphan job result. Returns null (no
    // dispatch) rather than a retry loop or a 500.
    await markPlacementStarterClaimTerminal(tx, claim.id, 'cancelled', now, {
      class: 'superseded',
      code: 'nonterminal_single_flight',
      message: 'superseded by a concurrent in-flight placement claim for the same goal+subject',
    });
    return null;
  }
}

export async function dispatchPlacementStarterClaim(
  db: Db,
  claimId: string,
  admit?: PlacementStarterAdmission,
): Promise<string | null> {
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  return db.transaction((tx) =>
    dispatchPlacementStarterClaimTx(
      tx,
      claimId,
      (queue, data, options) => boss.send(queue, data, options),
      admit,
    ),
  );
}
