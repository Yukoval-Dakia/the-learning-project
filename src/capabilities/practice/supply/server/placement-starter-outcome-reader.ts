import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { learning_session, placement_starter_claim } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { placementStarterIdentity } from './placement-starter-identity';
import {
  type PlacementStarterOutcome,
  readPlacementStarterFailure,
} from './placement-starter-outcome';
import { resolvePlacementStarterGoalAuthority } from './placement-starter-store';

/** Call in a read-only repeatable-read transaction so goal and claim binding share a snapshot. */
export async function readPlacementStarterOutcomes(
  db: Tx,
  sessionId: string,
): Promise<PlacementStarterOutcome[]> {
  const [session] = await db
    .select({ goalId: learning_session.goal_id })
    .from(learning_session)
    .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'placement')));
  if (!session) throw new ApiError('not_found', 'placement session not found', 404);
  const goalId = session.goalId;
  const unbound = {
    session_id: sessionId,
    goal_id: goalId,
    semantic_goal_revision_id: null,
    subject_id: null,
    claim_id: null,
  };
  if (!goalId)
    return [{ ...unbound, state: 'absent', next_action: 'provide_goal', failure_reason: null }];

  let authority: Awaited<ReturnType<typeof resolvePlacementStarterGoalAuthority>>;
  try {
    authority = await resolvePlacementStarterGoalAuthority(db, goalId);
  } catch (error) {
    if (!(error instanceof ApiError) || ![404, 422].includes(error.status)) throw error;
    return [
      {
        ...unbound,
        state: 'unknown',
        next_action: 'resolve_unknown_outcome',
        failure_reason: { code: 'authority_unknown' },
      },
    ];
  }
  const claims = await db
    .select()
    .from(placement_starter_claim)
    .where(
      and(
        eq(placement_starter_claim.goal_id, goalId),
        eq(placement_starter_claim.semantic_goal_revision_id, authority.semanticGoalRevisionId),
        inArray(placement_starter_claim.subject_id, authority.subjectIds),
      ),
    );
  return authority.subjectIds.map((subjectId): PlacementStarterOutcome => {
    const identity = placementStarterIdentity(authority.semanticGoalRevisionId, subjectId);
    const claim = claims.find((row) => row.subject_id === subjectId);
    const binding = {
      session_id: sessionId,
      goal_id: goalId,
      semantic_goal_revision_id: authority.semanticGoalRevisionId,
      subject_id: subjectId,
      claim_id: claim?.id ?? null,
    };
    if (!claim)
      return {
        ...binding,
        claim_id: null,
        state: 'absent',
        next_action: 'source_questions',
        failure_reason: null,
      };
    const claimed = { ...binding, claim_id: claim.id };
    if (claim.id !== identity.claimId || claim.fingerprint !== identity.fingerprint) {
      return {
        ...binding,
        state: 'unknown',
        next_action: 'resolve_unknown_outcome',
        failure_reason: { code: 'authority_unknown' },
      };
    }
    if (claim.known_cost_micro_usd === null || claim.last_error_code === 'cost_unknown') {
      return {
        ...binding,
        state: 'unknown',
        next_action: 'resolve_unknown_outcome',
        failure_reason: { code: 'cost_unknown' },
      };
    }
    switch (claim.status) {
      case 'pending_dispatch':
      case 'queued':
      case 'running':
      case 'verifying':
      case 'retry_scheduled':
        return {
          ...claimed,
          state: 'pending',
          next_action: 'wait_for_supply',
          failure_reason:
            claim.status === 'retry_scheduled' || claim.last_error_code
              ? readPlacementStarterFailure(claim)
              : null,
        };
      case 'satisfied':
        return {
          ...claimed,
          state: 'satisfied',
          next_action: 'continue_placement',
          failure_reason: null,
        };
      case 'exhausted':
        return {
          ...claimed,
          state: 'exhausted',
          next_action: 'review_supply_failure',
          failure_reason: readPlacementStarterFailure(claim),
        };
      case 'cancelled':
        return {
          ...binding,
          state: 'unknown',
          next_action: 'resolve_unknown_outcome',
          failure_reason: readPlacementStarterFailure(claim),
        };
      default: {
        const exhaustive: never = claim.status;
        throw new Error(`unrecognized placement starter status: ${exhaustive}`);
      }
    }
  });
}
