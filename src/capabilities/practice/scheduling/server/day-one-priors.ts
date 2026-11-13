// Day-one mastery prior for one knowledge scope.
// Owns the prerequisite read, the measured anchors, the DAG propagation, and the claim.
// Both readers expand the requested ids through prerequisite ancestors, then return
// only those requested ids. A root with a measured effective ability or a calibrated
// difficulty uses a unit-precision offset prior in that frame. Every other root stays
// uniform. Downstream nodes inherit through the probabilistic-AND. A cycle or a read
// failure returns null so callers keep their previous behavior.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { knowledge_edge } from '@/db/schema';
import { getRepresentativeKcBeta } from '@/kernel/read-models/mastery-projection';
import { effectiveThetaForKcBatch, getMasteryStates } from '@/kernel/read-models/mastery-state';
import {
  type DayOneGridPosterior,
  type DayOnePrereqEdge,
  dayOneAbilityOffset,
  dayOnePropagationFailureReason,
  propagateDayOnePriors,
} from './day-one-prior-propagate';

// Scales how hard a prerequisite gap pulls a dependent prior down. Owner-fixed;
// never estimated from answers.
export const DAY_ONE_SHRINK_COEFF = 1.0;

export type DayOnePriorInputs = 'neutral_zero' | 'seeded_anchors';

const NEUTRAL_CLAIM = {
  observation: 'untested',
  basis: 'model_prior',
  inputs: 'neutral_zero',
  mastery_role: 'not_independent_mastery',
} as const;

/**
 * Display prior for one KC. `mean_mastery` is the model prior, not observed mastery.
 * `evidence_count` stays 0 because no answers were folded into this KC.
 */
export interface DayOnePrior {
  mean_mastery: number;
  weakest_prereq_id?: string;
  weakest_prereq_mastery?: number;
  evidence_count: 0;
  claim: {
    observation: 'untested';
    basis: 'model_prior';
    inputs: DayOnePriorInputs;
    mastery_role: 'not_independent_mastery';
  };
}

interface PropagatedDayOne {
  prior: DayOnePrior;
  abilityOffset: number;
}

type DbLike = Db | Tx;

function scopeIds(scope: readonly string[]): string[] {
  return Array.from(new Set(scope.map((id) => id.trim()).filter((id) => id.length > 0)));
}

function toDayOnePrior(
  ids: readonly string[],
  post: DayOneGridPosterior,
  inputs: DayOnePriorInputs,
): DayOnePrior {
  const prior: DayOnePrior = {
    mean_mastery: post.mastery,
    evidence_count: 0,
    claim: inputs === 'neutral_zero' ? NEUTRAL_CLAIM : { ...NEUTRAL_CLAIM, inputs },
  };
  const index = post.weakestPrereqId;
  const mastery = post.weakestPrereqMastery;
  if (index !== undefined && mastery !== undefined && index >= 0 && index < ids.length) {
    prior.weakest_prereq_id = ids[index];
    prior.weakest_prereq_mastery = mastery;
  }
  return prior;
}

/** A node is seeded when its own anchor is measured or a prerequisite's is. */
function inheritAnchor(
  count: number,
  edges: readonly DayOnePrereqEdge[],
  selfAnchored: readonly boolean[],
): boolean[] {
  const anchored = selfAnchored.slice();
  for (let pass = 0; pass < count; pass++) {
    let changed = false;
    for (const edge of edges) {
      if (anchored[edge.prereqIdx] && !anchored[edge.depIdx]) {
        anchored[edge.depIdx] = true;
        changed = true;
      }
    }
    if (!changed) return anchored;
  }
  return anchored;
}

async function loadInScopeEdges(
  db: DbLike,
  ids: readonly string[],
): Promise<Array<{ from: string; to: string }>> {
  return db
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
}

/**
 * Requested ids plus prerequisite ancestors, so a cold KC keeps an observed
 * prerequisite that sits outside the requested scope. Ancestors are sorted
 * so a mastery tie breaks the same way on every read.
 */
async function prerequisiteClosure(db: DbLike, roots: readonly string[]): Promise<string[]> {
  const seen = new Set(roots);
  const ancestors: string[] = [];
  let frontier = [...roots];
  while (frontier.length > 0) {
    const rows = await db
      .select({
        from: knowledge_edge.from_knowledge_id,
        to: knowledge_edge.to_knowledge_id,
      })
      .from(knowledge_edge)
      .where(
        and(
          eq(knowledge_edge.relation_type, 'prerequisite'),
          isNull(knowledge_edge.archived_at),
          inArray(knowledge_edge.to_knowledge_id, frontier),
        ),
      );
    const next: string[] = [];
    for (const row of rows) {
      if (seen.has(row.from)) continue;
      seen.add(row.from);
      ancestors.push(row.from);
      next.push(row.from);
    }
    frontier = next;
  }
  ancestors.sort((a, b) => a.localeCompare(b));
  return [...roots, ...ancestors];
}

async function propagateScope(
  db: DbLike,
  ids: readonly string[],
  edgeRows: readonly { from: string; to: string }[],
): Promise<Map<string, PropagatedDayOne> | null> {
  const indexOf = new Map(ids.map((id, index) => [id, index]));
  const prereqEdges: DayOnePrereqEdge[] = [];
  for (const edge of edgeRows) {
    const prereqIdx = indexOf.get(edge.from);
    const depIdx = indexOf.get(edge.to);
    if (prereqIdx === undefined || depIdx === undefined) continue;
    prereqEdges.push({ prereqIdx, depIdx });
  }

  const [mastery, beta] = await Promise.all([
    getMasteryStates(db, [...ids], 'knowledge'),
    getRepresentativeKcBeta(db, [...ids]),
  ]);
  const effective = await effectiveThetaForKcBatch(
    db,
    ids.map((id) => ({
      knowledgeId: id,
      thetaKc: mastery.get(id)?.theta_hat ?? 0,
    })),
  );
  const theta = ids.map((id) => {
    const value = effective.get(id) ?? 0;
    return Number.isFinite(value) ? value : 0;
  });
  const difficulty = ids.map((id) => {
    const value = beta.get(id);
    return value !== undefined && Number.isFinite(value) ? value : 0;
  });
  const selfAnchored = theta.map((value, index) => value !== 0 || difficulty[index] !== 0);

  const propagated = propagateDayOnePriors({
    kcIds: ids.map((_, index) => index),
    prereqEdges,
    bPerKc: difficulty,
    domainThetaGlobal: theta,
    shrinkCoeff: DAY_ONE_SHRINK_COEFF,
    rootPrior: 'unit_precision',
  });
  if (!propagated.ok) {
    console.error(
      '[loadDayOnePriors] propagation rejected',
      dayOnePropagationFailureReason(propagated.failure),
    );
    return null;
  }

  const anchored = inheritAnchor(ids.length, prereqEdges, selfAnchored);
  const out = new Map<string, PropagatedDayOne>();
  for (let i = 0; i < ids.length; i++) {
    const post = propagated.posteriors[i];
    if (!post) return null;
    const inputs: DayOnePriorInputs = anchored[i] ? 'seeded_anchors' : 'neutral_zero';
    out.set(ids[i], {
      prior: toDayOnePrior(ids, post, inputs),
      abilityOffset: dayOneAbilityOffset(post),
    });
  }
  return out;
}

/** Ancestors included, archived edges excluded. Callers project back to the requested ids. */
async function propagateEvidenceClosure(
  db: DbLike,
  requested: readonly string[],
): Promise<Map<string, PropagatedDayOne> | null> {
  const ids = await prerequisiteClosure(db, requested);
  return propagateScope(db, ids, await loadInScopeEdges(db, ids));
}

/** Propagated priors for a scope, or null when the scope is empty or the graph is rejected. */
export async function loadDayOnePriors(
  db: DbLike,
  scope: string[],
): Promise<Map<string, DayOnePrior> | null> {
  const requested = scopeIds(scope);
  if (requested.length === 0) return null;

  try {
    const propagated = await propagateEvidenceClosure(db, requested);
    if (!propagated) return null;
    const out = new Map<string, DayOnePrior>();
    for (const id of requested) {
      const row = propagated.get(id);
      if (!row) return null;
      out.set(id, row.prior);
    }
    return out;
  } catch (err) {
    console.error('[loadDayOnePriors] propagation failed', err);
    return null;
  }
}

/**
 * Offset added to a cold KC's effective ability. 0 for a root. Null when the
 * prerequisite graph is rejected, so selection keeps the unpropagated theta.
 */
export async function loadPropagatedAbilityOffsets(
  db: DbLike,
  knowledgeIds: readonly string[],
): Promise<Map<string, number> | null> {
  const roots = scopeIds(knowledgeIds);
  if (roots.length === 0) return new Map();

  try {
    const propagated = await propagateEvidenceClosure(db, roots);
    if (!propagated) return null;
    const out = new Map<string, number>();
    for (const id of roots) out.set(id, propagated.get(id)?.abilityOffset ?? 0);
    return out;
  } catch (err) {
    console.error('[loadDayOnePriors] propagation failed', err);
    return null;
  }
}
