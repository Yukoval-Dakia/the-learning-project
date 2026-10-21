import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { createKnowledgeNodeFromEvents } from '@/capabilities/knowledge/public';
import type { Db, Tx } from '@/db/client';
import {
  event,
  goal,
  knowledge,
  placement_starter_attempt,
  placement_starter_attempt_question,
  placement_starter_claim,
  placement_starter_cost_component,
} from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { getEffectiveDomain, updateGoalScope } from '@/kernel/placement-persistence';
import { getDefaultSubjectRegistry, resolveKnownSubjectId } from '@/subjects/profile';
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

/**
 * (Stage 1 B6 S5) — the starter-supply anchor is a REAL knowledge
 * node, never the goal's text. Resolution order:
 * 1. an explicit-scope goal resolves to its own declared in-subject KCs
 * (deterministic: lowest id) — they are already inside the goal's scope;
 * 2. otherwise the shared per-subject starter node under the subject root
 * (`identity.knowledgeId` = `placement-starter:<subject>`) — created once
 * and reused across goals/revisions, named after the SUBJECT (e.g.
 * 「数学·起点测评」), authorised by the learner's placement start.
 * The per-subject starter node exists because a question's knowledge_ids must
 * intersect the placement scope to be served, and an empty subject tree has no
 * content KC to anchor to; anchoring to the bare seed root would produce
 * questions the subject scope read (which excludes roots) could never serve.
 *
 * For explicit goals the resolved anchor that is not already in scope is
 * unioned into `goal.scope_knowledge_ids` by the caller — the "scope record"
 * half of the contract (`addPlacementStarterKnowledgeToExplicitGoal`).
 */
async function resolvePlacementStarterAnchor(
  tx: Tx,
  authority: PlacementStarterGoalAuthority,
  subjectId: string,
  rootId: string,
  rootName: string,
  now: Date,
): Promise<string> {
  if (authority.scopeMode === 'explicit' && authority.scopeKnowledgeIds.length > 0) {
    const scoped = await tx
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(
        and(
          inArray(knowledge.id, authority.scopeKnowledgeIds),
          isNull(knowledge.archived_at),
          sql`${knowledge.id} NOT LIKE 'seed:%:root'`,
        ),
      );
    const inSubject: string[] = [];
    for (const node of scoped) {
      const domain = await getEffectiveDomain(tx, node.id);
      if (resolveKnownSubjectId(domain) === subjectId) inSubject.push(node.id);
    }
    inSubject.sort();
    if (inSubject[0]) return inSubject[0];
  }
  const anchorId = placementStarterIdentity(
    authority.semanticGoalRevisionId,
    subjectId,
  ).knowledgeId;
  // Idempotent per-subject anchor creation under the validated root — a
  // learner-initiated placement flow, so the node is born approved (the
  // creation is inside an already-authorised plan, not an agent's ad hoc
  // invention). onExisting='skip' makes repeated/concurrent materialization a
  // no-op; existing anchors are never rewritten.
  await createKnowledgeNodeFromEvents(
    tx,
    {
      id: anchorId,
      name: `${rootName}·起点测评`,
      domain: null,
      parent_id: rootId,
      proposed_by_ai: false,
      created_at: now,
    },
    { actorRef: 'placement_starter', eventId: `placement-starter-genesis:${subjectId}` },
    'skip',
  );
  return anchorId;
}

export async function ensurePlacementStarterAnchorAndClaim(
  tx: Tx,
  authority: PlacementStarterGoalAuthority,
  subjectId: string,
  now = new Date(),
): Promise<{ identity: PlacementStarterIdentity; anchorId: string }> {
  const rootId = `seed:${subjectId}:root`;
  const [root] = await tx
    .select({
      name: knowledge.name,
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
  const anchorId = await resolvePlacementStarterAnchor(
    tx,
    authority,
    subjectId,
    rootId,
    root.name,
    now,
  );
  const identity = placementStarterIdentity(authority.semanticGoalRevisionId, subjectId);

  await tx
    .insert(placement_starter_claim)
    .values({
      id: identity.claimId,
      fingerprint: identity.fingerprint,
      goal_id: authority.goalId,
      semantic_goal_revision_id: authority.semanticGoalRevisionId,
      subject_id: subjectId,
      knowledge_id: anchorId,
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
    // Target-less ON CONFLICT DO NOTHING makes same-revision re-runs idempotent. pending_dispatch
    // is intentionally outside the cross-revision nonterminal index, so a current revision claim
    // is persisted even while an older paid flight exists; its dispatch remains pending and
    // retryable until that old flight terminalizes.
    .onConflictDoNothing();
  return { identity, anchorId };
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
  const anchorIds: string[] = [];
  for (const subjectId of authority.subjectIds) {
    const { identity, anchorId } = await ensurePlacementStarterAnchorAndClaim(
      tx,
      authority,
      subjectId,
      now,
    );
    identities.push(identity);
    anchorIds.push(anchorId);
  }
  // for an explicit-scope goal the resolved anchors not already in
  // scope are unioned into goal.scope_knowledge_ids (the "scope record" half of
  // the contract; placement_starter_augmentation marks it in the scope event).
  // Anchors that ARE declared scope KCs are a union no-op. subject_live goals
  // return early inside (their scope is derived live, never frozen).
  await addPlacementStarterKnowledgeToExplicitGoal(tx, authority.goalId, anchorIds, now);
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
  // serialize on it (parity with addAuthorizedCostComponent, which locks FOR UPDATE;
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
        SELECT CASE
          WHEN COUNT(*) FILTER (WHERE ${placement_starter_cost_component.cost_micro_usd} IS NULL) > 0
            THEN NULL
          ELSE COALESCE(SUM(${placement_starter_cost_component.cost_micro_usd}), 0)::int
        END
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
