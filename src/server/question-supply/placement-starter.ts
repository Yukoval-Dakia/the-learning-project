import type { Db, Tx } from '@/db/client';
import { placement_starter_claim } from '@/db/schema';
import type { QuizGenJobData } from '@/server/boss/handlers/quiz_gen';
import { fromPgBossDrizzleTx } from '@/server/boss/pg-boss-drizzle';
import { JOB_RETRY_DELAY_SECONDS, JOB_RETRY_LIMIT } from '@/server/boss/queue-config';
import { and, eq } from 'drizzle-orm';
import type { SendOptions } from 'pg-boss';
import { dispatchSupplyTarget } from './dispatcher';
import { EvidenceDemandV1, evidenceDemandToTargetContext } from './evidence-demand';
import type { QuestionSupplyTarget } from './target-discovery';

const PLACEMENT_STARTER_COUNT = 8;

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
      statement: `Eight verified active placement starters for semantic goal revision ${claim.semantic_goal_revision_id}`,
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

  const target = buildPlacementStarterTarget(claim);
  const result = await dispatchSupplyTarget(tx, target, {
    atomic: true,
    cooldownDays: 0,
    actorRef: 'placement_starter',
    tavilyAvailable: () => true,
    enqueueQuizGen: (data) =>
      send('quiz_gen', data, {
        db: fromPgBossDrizzleTx(tx),
        retryLimit: JOB_RETRY_LIMIT,
        retryDelay: JOB_RETRY_DELAY_SECONDS,
        retryBackoff: true,
      }),
  });
  const jobId = result.jobId;
  if (!jobId) throw new Error(`pg-boss returned no job id for placement starter claim ${claim.id}`);

  await tx
    .update(placement_starter_claim)
    .set({
      status: 'queued',
      pg_boss_job_id: jobId,
      updated_at: new Date(),
      version: claim.version + 1,
    })
    .where(
      and(
        eq(placement_starter_claim.id, claim.id),
        eq(placement_starter_claim.status, 'pending_dispatch'),
      ),
    );
  return jobId;
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
