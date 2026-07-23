import type { Db, Tx } from '@/db/client';
import { placement_starter_claim } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { fromPgBossDrizzleTx } from '@/server/boss/pg-boss-drizzle';
import { and, eq } from 'drizzle-orm';
import {
  EvidenceDemandV1,
  buildSupplyTrace,
  evidenceDemandToTargetContext,
} from './evidence-demand';
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
  };
}

export async function dispatchPlacementStarterClaimTx(
  tx: Tx,
  claimId: string,
  send: (
    queue: string,
    data: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => Promise<string | null>,
): Promise<string | null> {
  const [claim] = await tx
    .select()
    .from(placement_starter_claim)
    .where(eq(placement_starter_claim.id, claimId))
    .for('update');
  if (!claim || claim.status !== 'pending_dispatch') return claim?.pg_boss_job_id ?? null;

  const target = buildPlacementStarterTarget(claim);
  const supplyTrace = {
    ...buildSupplyTrace(
      {
        targetId: target.id,
        targetFingerprint: target.fingerprint,
        context: evidenceDemandToTargetContext(buildPlacementStarterDemand(claim)),
      },
      'quiz_gen',
    ),
    claim_id: claim.id,
    semantic_goal_revision_id: claim.semantic_goal_revision_id,
  };
  const jobId = await send(
    'quiz_gen',
    {
      trigger: 'knowledge',
      ref_id: claim.knowledge_id,
      count: PLACEMENT_STARTER_COUNT,
      exact_count: PLACEMENT_STARTER_COUNT,
      knowledge_id: claim.knowledge_id,
      generation_method: 'closed_book',
      placement_starter_claim_id: claim.id,
      semantic_goal_revision_id: claim.semantic_goal_revision_id,
      supply_trace: supplyTrace,
    },
    { db: fromPgBossDrizzleTx(tx), retryLimit: 2, retryDelay: 30, retryBackoff: true },
  );
  if (!jobId) throw new Error(`pg-boss returned no job id for placement starter claim ${claim.id}`);

  await writeEvent(tx, {
    id: `placement-starter-dispatch-v1-${claim.id}`,
    actor_kind: 'system',
    actor_ref: 'placement_starter',
    action: 'experimental:question_supply',
    subject_kind: 'query',
    subject_id: target.id,
    outcome: 'success',
    payload: {
      target_id: target.id,
      fingerprint: target.fingerprint,
      gap_kind: target.gapKind,
      subject_id: target.subjectId,
      knowledge_ids: target.knowledgeIds,
      desired_count: target.desiredCount,
      chosen_route: 'quiz_gen',
      status: 'dispatched',
      job_id: jobId,
      constraints: target.constraints,
      supply_trace: supplyTrace,
    },
  });
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
): Promise<string | null> {
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  return db.transaction((tx) =>
    dispatchPlacementStarterClaimTx(tx, claimId, (queue, data, options) =>
      boss.send(queue, data, options),
    ),
  );
}
