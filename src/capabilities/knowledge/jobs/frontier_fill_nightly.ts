// Cold-start prerequisite bootstrap. When the learnable frontier is empty, make one
// model call proposing temporary, low-confidence prerequisite edges. Proposals stay
// propose-only: the frontier reads live edges, so nothing changes until the owner
// accepts them in the inbox.
//
// Pre-model DB faults rethrow so pg-boss retries; model/key/parse faults are
// swallowed and counted. Pending and live pairs are deduped, and writes are capped.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
// Same package: knowledge owns both the frontier graph decision and this job. The
// frontier is only a gate signal; this job writes proposals, never live edges.
import {
  type FrontierResolution,
  learnableFrontierResolved,
} from '@/capabilities/knowledge/server/frontier-read';
import { loadPendingEdgeProposalKeys } from '@/capabilities/knowledge/server/propose_edge';
import { loadTreeSnapshot } from '@/capabilities/knowledge/server/tree';
import { parseFrontierProposals } from '@/capabilities/knowledge/tasks/knowledge-tasks';
import { isDirectTreePair } from '@/core/topology-gate';
import type { Db } from '@/db/client';
import { knowledge, knowledge_edge } from '@/db/schema';
import { FRONTIER_PENDING_CAP } from '@/kernel/nightly-eligibility';
import { writeAiProposal } from '@/kernel/proposals/writer';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { type JobYieldOutput, reportJobYield } from '@/server/boss/job-yield';
import { resolveSubjectProfile } from '@/subjects/profile';

/** Bootstrap only at or below this frontier size; 0 means true cold-start. */
export const FRONTIER_BOOTSTRAP_FLOOR = 0;

/** Hard cap on proposals written per run (cost cap / anti-storm). */
export const FRONTIER_FILL_MAX_PROPOSALS = FRONTIER_PENDING_CAP;

/** Candidate cap for the model input; write count alone does not bound input tokens. */
export const FRONTIER_FILL_CANDIDATE_CAP = 50;

/** Tree nodes sent as context; candidates are passed separately. */
export const FRONTIER_FILL_TREE_CAP = 500;

/** Low weight marking these as temporary placeholder edges, not authoritative ones. */
export const FRONTIER_TEMP_WEIGHT = 0.4;

const RELATION_PREREQUISITE = 'prerequisite' as const;

type DepsOverride = {
  runTaskFn?: TaskTextRunFn;
  /** Test seam for the frontier read; lets overflow be exercised without a huge graph. */
  resolveFrontierFn?: (db: Db) => Promise<FrontierResolution>;
};

export interface FrontierFillResult {
  /** Number of candidate KCs (lacking prereq coverage) considered for the LLM input. */
  considered: number;
  /** Number of propose events actually written (≤ FRONTIER_FILL_MAX_PROPOSALS). */
  proposed: number;
  /** 1 when the frontier was non-empty/dense → no-op, no LLM call. */
  skipped_dense: number;
  /** 1 when the closure overflowed, meaning the graph is dense, not cold-start. */
  skipped_overflow: number;
  /** 1 when the frontier was empty but no KC lacks prereq coverage → no-op, no LLM call. */
  skipped_no_candidate: number;
  /** Proposals dropped because an identical (from,to,prerequisite) pair is already pending. */
  skipped_duplicate_pending: number;
  /** Proposals dropped because a LIVE prerequisite edge already exists for the pair. */
  skipped_duplicate_edge: number;
  /** Proposals dropped for self-loop / unknown-node / non-candidate-target reasons. */
  skipped_invalid: number;
  /** Proposals dropped because the direct pair is already represented by tree parent_id. */
  skipped_tree_redundancy: number;
  /** Proposals dropped by the FRONTIER_FILL_MAX_PROPOSALS clamp. */
  skipped_over_cap: number;
  /** 1 once the model half was entered, distinguishing idle nights from calls. */
  llm_attempted: number;
  /** 1 when the model half swallowed a fault, so a failed call is not reported as empty. */
  llm_failed: number;
}

function emptyResult(): FrontierFillResult {
  return {
    considered: 0,
    proposed: 0,
    skipped_dense: 0,
    skipped_overflow: 0,
    skipped_no_candidate: 0,
    skipped_duplicate_pending: 0,
    skipped_duplicate_edge: 0,
    skipped_invalid: 0,
    skipped_tree_redundancy: 0,
    skipped_over_cap: 0,
    llm_attempted: 0,
    llm_failed: 0,
  };
}

function edgeKey(fromId: string, toId: string): string {
  return `${fromId}|${toId}|${RELATION_PREREQUISITE}`;
}

/** KCs with no incoming live prerequisite edge; runs before the model. */
async function loadKcsLackingPrereq(db: Db): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT k.id AS id
    FROM ${knowledge} k
    LEFT JOIN ${knowledge_edge} e
      ON e.to_knowledge_id = k.id
      AND e.relation_type = ${RELATION_PREREQUISITE}
      AND e.archived_at IS NULL
    WHERE e.id IS NULL
      AND k.archived_at IS NULL
    ORDER BY k.id
    LIMIT ${FRONTIER_FILL_CANDIDATE_CAP}
  `);
  return rows.map((r) => r.id);
}

/** Run the bootstrap; see the file header for the gate and swallow boundaries. */
export async function runFrontierFillAndWrite(
  db: Db,
  deps: DepsOverride = {},
): Promise<FrontierFillResult> {
  const result = emptyResult();

  // Sparsity gate, outside the swallow so a DB fault retries instead of becoming
  // proposed:0. Overflow means a dense graph, never a bootstrap target.
  const resolveFrontierFn = deps.resolveFrontierFn ?? learnableFrontierResolved;
  const frontier = await resolveFrontierFn(db);
  if (frontier.kind === 'overflow') {
    return { ...result, skipped_overflow: 1 };
  }
  if (frontier.ids.length > FRONTIER_BOOTSTRAP_FLOOR) {
    return { ...result, skipped_dense: 1 };
  }

  const candidateIds = await loadKcsLackingPrereq(db);
  if (candidateIds.length === 0) {
    return { ...result, skipped_no_candidate: 1 };
  }
  result.considered = candidateIds.length;

  // The snapshot is bounded, so it is context only; endpoint validity is checked
  // against the knowledge table after parsing.
  const tree = await loadTreeSnapshot(db);
  const candidateSet = new Set(candidateIds);

  // Dedup pending proposals and live edges. The live check is redundant with the
  // candidate anti-join today, but keeps the no-duplicate invariant if that changes.
  const pendingEdgeKey = await loadPendingEdgeProposalKeys(db);
  const liveEdges = await db
    .select({
      from_knowledge_id: knowledge_edge.from_knowledge_id,
      to_knowledge_id: knowledge_edge.to_knowledge_id,
    })
    .from(knowledge_edge)
    .where(
      and(
        eq(knowledge_edge.relation_type, RELATION_PREREQUISITE),
        isNull(knowledge_edge.archived_at),
      ),
    );
  const liveEdgeKey = new Set(
    liveEdges.map((e) => edgeKey(e.from_knowledge_id, e.to_knowledge_id)),
  );

  const domain = dominantDomain(tree, candidateSet);

  // From here on, faults are swallowed and counted; only pre-model DB faults retry.
  try {
    result.llm_attempted = 1;
    const runTaskFn = deps.runTaskFn ?? makeRunTaskFn(db);
    const taskResult = await runTaskFn(
      'FrontierPrerequisiteTask',
      {
        tree_snapshot: tree.slice(0, FRONTIER_FILL_TREE_CAP).map((n) => ({
          id: n.id,
          name: n.name,
          parent_id: n.parent_id,
          effective_domain: n.effective_domain,
        })),
        kcs_lacking_prereq: candidateIds,
        domain,
      },
      { subjectProfile: resolveSubjectProfile(domain) },
    );

    const parsed = parseFrontierProposals(taskResult.text);

    // Validate endpoints and tree parents against the source table, not the snapshot.
    const proposedEndpointIds = [
      ...new Set(
        parsed.proposals.flatMap((proposal) => [
          proposal.from_knowledge_id,
          proposal.to_knowledge_id,
        ]),
      ),
    ];
    const endpointRows = proposedEndpointIds.length
      ? await db
          .select({ id: knowledge.id, parent_id: knowledge.parent_id })
          .from(knowledge)
          .where(and(inArray(knowledge.id, proposedEndpointIds), isNull(knowledge.archived_at)))
      : [];
    const validEndpointIds = new Set(endpointRows.map((row) => row.id));
    const treeParentLinks = endpointRows.flatMap((row) =>
      row.parent_id ? [{ child_id: row.id, parent_id: row.parent_id }] : [],
    );

    for (const p of parsed.proposals) {
      if (result.proposed >= FRONTIER_FILL_MAX_PROPOSALS) {
        result.skipped_over_cap += 1;
        continue;
      }

      const from = p.from_knowledge_id;
      const to = p.to_knowledge_id;

      // `from` must exist in the DB; `to` must still lack prereq coverage.
      if (from === to || !validEndpointIds.has(from) || !candidateSet.has(to)) {
        result.skipped_invalid += 1;
        continue;
      }

      if (isDirectTreePair(from, to, treeParentLinks)) {
        result.skipped_tree_redundancy += 1;
        continue;
      }

      const key = edgeKey(from, to);
      if (liveEdgeKey.has(key)) {
        result.skipped_duplicate_edge += 1;
        continue;
      }
      if (pendingEdgeKey.has(key)) {
        result.skipped_duplicate_pending += 1;
        continue;
      }

      // Propose-only. Type and low weight are forced regardless of model output.
      await writeAiProposal(db, {
        actor_ref: 'dreaming',
        outcome: 'success',
        task_run_id: taskResult.task_run_id ?? null,
        cost_usd: taskResult.cost_usd,
        created_at: new Date(),
        payload: {
          kind: 'knowledge_edge',
          target: { subject_kind: 'knowledge_edge', subject_id: null },
          reason_md: p.reasoning,
          evidence_refs: [],
          proposed_change: {
            edge_op: 'create',
            from_knowledge_id: from,
            to_knowledge_id: to,
            relation_type: RELATION_PREREQUISITE,
            weight: FRONTIER_TEMP_WEIGHT,
          },
          cooldown_key: `knowledge_edge:${key}`,
        },
      });

      pendingEdgeKey.add(key);
      result.proposed += 1;
    }
  } catch (err) {
    // Log the stack only: an error may carry the raw model payload. Record the
    // failure so it is distinguishable from a night that legitimately proposed nothing.
    result.llm_failed = 1;
    console.error(
      '[frontier_fill_nightly] LLM half failed (no proposals written)',
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
  }

  return result;
}

function dominantDomain(
  tree: Array<{ id: string; effective_domain: string | null }>,
  candidateSet: Set<string>,
): string | null {
  const counts = new Map<string, number>();
  for (const n of tree) {
    if (!candidateSet.has(n.id) || n.effective_domain === null) continue;
    counts.set(n.effective_domain, (counts.get(n.effective_domain) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [d, c] of counts) {
    if (c > bestCount) {
      bestCount = c;
      best = d;
    }
  }
  return best;
}

export function buildFrontierFillNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<JobYieldOutput> {
  return async () => {
    try {
      const result = await runFrontierFillAndWrite(db);
      console.log('[frontier_fill_nightly] result', result);
      // Gated nights report idle. `|| llm_failed` keeps a swallowed fault from ever
      // looking idle if a DB read is later inserted before the attempt flag.
      const attempted = result.llm_attempted || result.llm_failed ? 1 : 0;
      return reportJobYield('frontier_fill_nightly', {
        attempted,
        succeeded: attempted - result.llm_failed,
        failed: result.llm_failed,
      });
    } catch (err) {
      // Only pre-model DB faults reach here; rethrow so pg-boss retries.
      console.error('[frontier_fill_nightly] failed', err);
      throw err;
    }
  };
}
