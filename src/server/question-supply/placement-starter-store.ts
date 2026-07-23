import { createHash } from 'node:crypto';
import { updateGoalScope } from '@/capabilities/agency/server/goals/queries';
import { getEffectiveDomain } from '@/capabilities/knowledge/server/domain';
import type { Db, Tx } from '@/db/client';
import {
  event,
  goal,
  knowledge,
  materialized_id_index,
  placement_starter_attempt,
  placement_starter_attempt_question,
  placement_starter_claim,
  placement_starter_cost_component,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/server/http/errors';
import { upsertMaterializedIdIndex } from '@/server/projections/materialized-id-index';
import { knowledgeRowToSnapshot } from '@/server/projections/snapshot-mappers';
import { getDefaultSubjectRegistry, resolveKnownSubjectId } from '@/subjects/profile';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PlacementStarterIdentity } from './placement-starter-identity';
import { placementStarterIdentity } from './placement-starter-identity';

export interface PlacementStarterGoalAuthority {
  goalId: string;
  title: string;
  scopeMode: 'explicit' | 'subject_live';
  scopeKnowledgeIds: string[];
  semanticGoalRevisionId: string;
  subjectIds: string[];
}

function isRegisteredPaidSubject(subjectId: string | null | undefined): subjectId is string {
  if (!subjectId || subjectId === 'general') return false;
  return getDefaultSubjectRegistry().get(subjectId) != null;
}

export async function resolvePlacementStarterGoalAuthority(
  db: Db | Tx,
  goalId: string,
): Promise<PlacementStarterGoalAuthority> {
  const [row] = await db.select().from(goal).where(eq(goal.id, goalId)).limit(1);
  if (!row) throw new ApiError('not_found', 'placement goal not found', 404);
  return resolvePlacementStarterGoalAuthorityFromRow(db, row);
}

async function resolvePlacementStarterGoalAuthorityFromRow(
  db: Db | Tx,
  row: typeof goal.$inferSelect,
): Promise<PlacementStarterGoalAuthority> {
  const goalId = row.id;
  const semanticEvents = await db
    .select({
      id: event.id,
      actorRef: event.actor_ref,
      action: event.action,
      payload: event.payload,
    })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'goal'),
        eq(event.subject_id, goalId),
        inArray(event.action, ['experimental:genesis', 'experimental:goal_scope_update']),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id));
  const semantic = semanticEvents.find((candidate) => {
    if (
      candidate.action === 'experimental:goal_scope_update' &&
      candidate.actorRef === 'placement_starter' &&
      candidate.payload.placement_starter_augmentation === true
    ) {
      return false;
    }
    if (candidate.action === 'experimental:goal_scope_update') {
      return (
        candidate.payload.title !== undefined || candidate.payload.scope_knowledge_ids !== undefined
      );
    }
    return true;
  });
  const semanticGoalRevisionId =
    semantic?.id ??
    row.source_ref ??
    `goal-row-v1-${createHash('sha256')
      .update(
        JSON.stringify({
          id: row.id,
          title: row.title,
          subject_id: row.subject_id,
          scope_mode: row.scope_mode,
          scope_knowledge_ids: row.scope_knowledge_ids,
        }),
      )
      .digest('hex')}`;

  const subjects = new Set<string>();
  const canonicalGoalSubject = resolveKnownSubjectId(row.subject_id);
  if (isRegisteredPaidSubject(canonicalGoalSubject)) subjects.add(canonicalGoalSubject);

  if (row.scope_mode === 'explicit' && row.scope_knowledge_ids.length > 0) {
    const scoped = await db
      .select({ id: knowledge.id, parentId: knowledge.parent_id })
      .from(knowledge)
      .where(
        and(
          inArray(knowledge.id, row.scope_knowledge_ids),
          isNull(knowledge.archived_at),
          sql`${knowledge.id} NOT LIKE 'seed:%:root'`,
        ),
      );
    for (const node of scoped) {
      const canonical = resolveKnownSubjectId(await getEffectiveDomain(db, node.id));
      if (isRegisteredPaidSubject(canonical)) subjects.add(canonical);
    }
  }

  const subjectIds = [...subjects].sort();
  if (subjectIds.length === 0) {
    throw new ApiError(
      'validation_error',
      'placement goal has no authoritative subject for starter generation',
      422,
    );
  }
  return {
    goalId,
    title: row.title,
    scopeMode: row.scope_mode,
    scopeKnowledgeIds: row.scope_knowledge_ids,
    semanticGoalRevisionId,
    subjectIds,
  };
}

export async function ensurePlacementStarterKnowledgeAndClaim(
  tx: Tx,
  authority: PlacementStarterGoalAuthority,
  subjectId: string,
  now = new Date(),
): Promise<{ identity: PlacementStarterIdentity; insertedKnowledge: boolean }> {
  const rootId = `seed:${subjectId}:root`;
  const [root] = await tx
    .select({
      domain: knowledge.domain,
      parentId: knowledge.parent_id,
      archivedAt: knowledge.archived_at,
    })
    .from(knowledge)
    .where(eq(knowledge.id, rootId));
  if (!root || root.archivedAt || root.domain !== subjectId || root.parentId !== null) {
    throw new ApiError(
      'invariant_conflict',
      `placement starter subject root is missing or invalid: ${rootId}`,
      409,
    );
  }
  const identity = placementStarterIdentity(authority.semanticGoalRevisionId, subjectId);
  const [inserted] = await tx
    .insert(knowledge)
    .values({
      id: identity.knowledgeId,
      name: authority.title,
      domain: subjectId,
      parent_id: `seed:${subjectId}:root`,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing({ target: knowledge.id })
    .returning();
  if (inserted) {
    await writeEvent(tx, {
      id: identity.genesisEventId,
      actor_kind: 'system',
      actor_ref: 'placement_starter',
      action: 'experimental:genesis',
      subject_kind: 'knowledge',
      subject_id: inserted.id,
      outcome: 'success',
      payload: { row: knowledgeRowToSnapshot(inserted) },
      created_at: now,
      ingest_at: now,
    });
    await upsertMaterializedIdIndex(tx, {
      materialized_id: inserted.id,
      anchor_event_id: identity.genesisEventId,
      subject_kind: 'knowledge',
    });
  } else {
    const [existing] = await tx
      .select()
      .from(knowledge)
      .where(eq(knowledge.id, identity.knowledgeId));
    if (!existing || existing.domain !== subjectId || existing.parent_id !== rootId) {
      throw new ApiError(
        'invariant_conflict',
        'placement starter knowledge identity collision',
        409,
      );
    }
    const [anchor] = await tx
      .select({
        anchorEventId: materialized_id_index.anchor_event_id,
        subjectKind: materialized_id_index.subject_kind,
      })
      .from(materialized_id_index)
      .where(eq(materialized_id_index.materialized_id, identity.knowledgeId));
    const [genesis] = await tx
      .select({
        action: event.action,
        subjectKind: event.subject_kind,
        subjectId: event.subject_id,
        payload: event.payload,
      })
      .from(event)
      .where(eq(event.id, identity.genesisEventId));
    const genesisRow = genesis?.payload.row as Record<string, unknown> | undefined;
    const expectedGenesisRow = knowledgeRowToSnapshot(existing);
    if (
      anchor?.anchorEventId !== identity.genesisEventId ||
      anchor.subjectKind !== 'knowledge' ||
      genesis?.action !== 'experimental:genesis' ||
      genesis.subjectKind !== 'knowledge' ||
      genesis.subjectId !== identity.knowledgeId ||
      !genesisRow ||
      Object.entries(expectedGenesisRow).some(([key, value]) => {
        const actual = genesisRow[key];
        if (value instanceof Date) {
          return new Date(String(actual)).getTime() !== value.getTime();
        }
        return JSON.stringify(actual) !== JSON.stringify(value);
      })
    ) {
      throw new ApiError(
        'invariant_conflict',
        'placement starter knowledge has a mismatched genesis anchor',
        409,
      );
    }
  }

  await tx
    .insert(placement_starter_claim)
    .values({
      id: identity.claimId,
      fingerprint: identity.fingerprint,
      goal_id: authority.goalId,
      semantic_goal_revision_id: authority.semanticGoalRevisionId,
      subject_id: subjectId,
      knowledge_id: identity.knowledgeId,
      demand_id: identity.demandId,
      target_id: identity.targetId,
      status: 'pending_dispatch',
      max_paid_attempts: 3,
      budget_limit_micro_usd: 1_000_000,
      known_cost_micro_usd: 0,
      next_reconcile_at: now,
      created_at: now,
      updated_at: now,
      version: 0,
    })
    // Target-less ON CONFLICT DO NOTHING so BOTH the PK (same revision re-run, idempotent) and
    // the placement_starter_claim_nonterminal_uq partial unique on (goal_id, subject_id) — an
    // earlier revision's claim still in flight for this goal+subject — degrade to a silent skip
    // rather than aborting the materialize transaction. The cross-revision skip is the intended
    // budget guard: the in-flight batch fills the pool; a later placement/start re-materializes
    // once it terminalizes (YUK-452 review).
    .onConflictDoNothing();
  return { identity, insertedKnowledge: Boolean(inserted) };
}

export async function materializePlacementStartersForGoal(
  tx: Tx,
  goalId: string,
  now = new Date(),
): Promise<{ authority: PlacementStarterGoalAuthority; identities: PlacementStarterIdentity[] }> {
  const [lockedGoal] = await tx.select().from(goal).where(eq(goal.id, goalId)).for('update');
  if (!lockedGoal) throw new ApiError('not_found', 'placement goal not found', 404);

  const authority = await resolvePlacementStarterGoalAuthorityFromRow(tx, lockedGoal);
  const identities: PlacementStarterIdentity[] = [];
  for (const subjectId of authority.subjectIds) {
    const { identity } = await ensurePlacementStarterKnowledgeAndClaim(
      tx,
      authority,
      subjectId,
      now,
    );
    identities.push(identity);
  }
  await addPlacementStarterKnowledgeToExplicitGoal(
    tx,
    authority.goalId,
    identities.map((identity) => identity.knowledgeId),
    now,
  );
  return { authority, identities };
}

export async function markPlacementStarterClaimTerminal(
  tx: Tx,
  claimId: string,
  status: 'satisfied' | 'exhausted' | 'cancelled',
  now = new Date(),
  error?: { class?: string; code?: string; message?: string },
): Promise<void> {
  await tx
    .update(placement_starter_claim)
    .set({
      status,
      satisfied_at: status === 'satisfied' ? now : null,
      exhausted_at: status === 'exhausted' ? now : null,
      last_error_class: error?.class ?? null,
      last_error_code: error?.code ?? null,
      last_error: error?.message ?? null,
      updated_at: now,
      version: sql`${placement_starter_claim.version} + 1`,
    })
    .where(eq(placement_starter_claim.id, claimId));
}

export async function addPlacementStarterCostComponent(
  tx: Tx,
  input: typeof placement_starter_cost_component.$inferInsert,
): Promise<void> {
  // Lock the claim row before the insert + known_cost recompute so concurrent cost writers
  // serialize on it (parity with addAuthorizedCostComponent, which locks FOR UPDATE; YUK-452
  // review). The correlated SUM is self-healing under READ COMMITTED, but the explicit lock
  // removes any doubt and keeps the recompute deterministic.
  await tx
    .select({ id: placement_starter_claim.id })
    .from(placement_starter_claim)
    .where(eq(placement_starter_claim.id, input.claim_id))
    .for('update');
  await tx
    .insert(placement_starter_cost_component)
    .values({
      id: input.id,
      claim_id: input.claim_id,
      attempt_id: input.attempt_id,
      component_kind: input.component_kind,
      question_id: input.question_id ?? null,
      provider_task_run_id: input.provider_task_run_id,
      cost_micro_usd: input.cost_micro_usd,
      created_at: input.created_at,
    })
    .onConflictDoNothing();
  await tx
    .update(placement_starter_claim)
    .set({
      known_cost_micro_usd: sql`(
        SELECT COALESCE(SUM(${placement_starter_cost_component.cost_micro_usd}), 0)::int
        FROM ${placement_starter_cost_component}
        WHERE ${placement_starter_cost_component.claim_id} = ${input.claim_id}
      )`,
      // The claim's updated_at marks when the claim row changed, not when the cost component was
      // created — use a fresh timestamp (parity with addAuthorizedCostComponent's `now`).
      updated_at: new Date(),
    })
    .where(eq(placement_starter_claim.id, input.claim_id));
}

export async function recordPlacementStarterAttempt(
  tx: Tx,
  input: typeof placement_starter_attempt.$inferInsert,
): Promise<void> {
  await tx
    .insert(placement_starter_attempt)
    .values({
      id: input.id,
      claim_id: input.claim_id,
      pg_boss_job_id: input.pg_boss_job_id,
      delivery_no: input.delivery_no,
      fencing_token: input.fencing_token,
      status: input.status,
      lease_expires_at: input.lease_expires_at ?? null,
      provider_task_run_id: input.provider_task_run_id ?? null,
      provider_output_hash: input.provider_output_hash ?? null,
      provider_output_recorded_at: input.provider_output_recorded_at ?? null,
      error_class: input.error_class ?? null,
      error_code: input.error_code ?? null,
      error_message: input.error_message ?? null,
      started_at: input.started_at ?? null,
      finished_at: input.finished_at ?? null,
      created_at: input.created_at,
      updated_at: input.updated_at,
    })
    .onConflictDoNothing();
}

export async function authorizePlacementStarterQuestion(
  tx: Tx,
  input: typeof placement_starter_attempt_question.$inferInsert,
): Promise<void> {
  await tx
    .insert(placement_starter_attempt_question)
    .values({
      attempt_id: input.attempt_id,
      claim_id: input.claim_id,
      question_id: input.question_id,
      canonical_hash: input.canonical_hash,
      verification_authority_epoch: input.verification_authority_epoch,
      verification_status: input.verification_status ?? 'authorized',
      created_at: input.created_at,
    })
    .onConflictDoNothing();
}

export async function addPlacementStarterKnowledgeToExplicitGoal(
  tx: Tx,
  goalId: string,
  knowledgeIds: string[],
  now = new Date(),
): Promise<void> {
  // Caller holds the canonical goal row lock. Re-read current scope rather than using the authority
  // snapshot so concurrent owner changes are unioned, never replaced.
  const [current] = await tx
    .select({ scopeMode: goal.scope_mode, scopeKnowledgeIds: goal.scope_knowledge_ids })
    .from(goal)
    .where(eq(goal.id, goalId));
  if (!current || current.scopeMode !== 'explicit') return;
  const stableUnion = [...new Set([...current.scopeKnowledgeIds, ...knowledgeIds])];
  if (stableUnion.length === current.scopeKnowledgeIds.length) return;
  await updateGoalScope(
    tx,
    goalId,
    { scope_knowledge_ids: stableUnion, placement_starter_augmentation: true },
    now,
    'placement_starter',
  );
}
