// Day-one (n=0) mastery prior for one goal scope.
// Owns the prerequisite read, the DAG propagation, rejection, and the claim.
// b and domain ability are the neutral all-zero assumption, not measured anchors.
// A cycle or a read failure returns null so the profile read stays intact.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { knowledge_edge } from '@/db/schema';
import {
  type DayOneGridPosterior,
  dayOnePropagationFailureReason,
  propagateDayOnePriors,
} from './day-one-prior-propagate';

// Scales how hard a prerequisite gap pulls a dependent prior down. Owner-fixed;
// never estimated from answers.
export const DAY_ONE_SHRINK_COEFF = 1.0;

const DAY_ONE_PRIOR_CLAIM = {
  observation: 'untested',
  basis: 'model_prior',
  inputs: 'neutral_zero',
  mastery_role: 'not_independent_mastery',
} as const;

/**
 * Display prior for one KC. `mean_mastery` is the model prior, not observed mastery.
 * `evidence_count` stays 0 because no answers were folded.
 */
export interface DayOnePrior {
  mean_mastery: number;
  weakest_prereq_id?: string;
  weakest_prereq_mastery?: number;
  evidence_count: 0;
  claim: {
    observation: 'untested';
    basis: 'model_prior';
    inputs: 'neutral_zero';
    mastery_role: 'not_independent_mastery';
  };
}

function scopeIds(scope: readonly string[]): string[] {
  return Array.from(new Set(scope.map((id) => id.trim()).filter((id) => id.length > 0)));
}

function toDayOnePrior(ids: readonly string[], post: DayOneGridPosterior): DayOnePrior {
  const prior: DayOnePrior = {
    mean_mastery: post.mastery,
    evidence_count: 0,
    claim: DAY_ONE_PRIOR_CLAIM,
  };
  const index = post.weakestPrereqId;
  const mastery = post.weakestPrereqMastery;
  if (index !== undefined && mastery !== undefined && index >= 0 && index < ids.length) {
    prior.weakest_prereq_id = ids[index];
    prior.weakest_prereq_mastery = mastery;
  }
  return prior;
}

/** Propagated priors for a goal scope, or null when the scope is empty or the graph is rejected. */
export async function loadDayOnePriors(
  db: Db,
  scope: string[],
): Promise<Map<string, DayOnePrior> | null> {
  const ids = scopeIds(scope);
  if (ids.length === 0) return null;

  try {
    const edgeRows = await db
      .select({
        from: knowledge_edge.from_knowledge_id,
        to: knowledge_edge.to_knowledge_id,
      })
      .from(knowledge_edge)
      .where(
        and(
          eq(knowledge_edge.relation_type, 'prerequisite'),
          isNull(knowledge_edge.archived_at),
          inArray(knowledge_edge.from_knowledge_id, ids),
          inArray(knowledge_edge.to_knowledge_id, ids),
        ),
      );

    const indexOf = new Map(ids.map((id, index) => [id, index]));
    const prereqEdges = [];
    for (const edge of edgeRows) {
      const prereqIdx = indexOf.get(edge.from);
      const depIdx = indexOf.get(edge.to);
      if (prereqIdx === undefined || depIdx === undefined) continue;
      prereqEdges.push({ prereqIdx, depIdx });
    }

    // Separate arrays: difficulty and domain ability are different inputs, both
    // the neutral zero assumption on this read.
    const propagated = propagateDayOnePriors({
      kcIds: ids.map((_, index) => index),
      prereqEdges,
      bPerKc: ids.map(() => 0),
      domainThetaGlobal: ids.map(() => 0),
      shrinkCoeff: DAY_ONE_SHRINK_COEFF,
    });
    if (!propagated.ok) {
      console.error(
        '[loadDayOnePriors] propagation rejected',
        dayOnePropagationFailureReason(propagated.failure),
      );
      return null;
    }

    const out = new Map<string, DayOnePrior>();
    for (let i = 0; i < ids.length; i++) {
      const post = propagated.posteriors[i];
      if (!post) return null;
      out.set(ids[i], toDayOnePrior(ids, post));
    }
    return out;
  } catch (err) {
    console.error('[loadDayOnePriors] propagation failed', err);
    return null;
  }
}
