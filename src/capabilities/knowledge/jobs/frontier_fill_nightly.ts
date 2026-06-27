// B3 frontier (YUK-349 scope #3, ADR-0037 #4) — empty-frontier prerequisite
// BOOTSTRAP fill. The cold-start half of the learnable-frontier story:
//
//   PR-1 (learnable-frontier.ts) reads the frontier from LIVE prerequisite edges.
//   On today's sparse graph there are no prerequisite edges → the frontier is
//   empty → the composer never surfaces a "learn this next" candidate. This
//   nightly job breaks that cold-start deadlock: WHEN the frontier is empty it
//   makes ONE LLM call proposing TEMPORARY prerequisite edges from curriculum/KC
//   semantics, PROPOSE-ONLY / low-confidence. The owner accepts edges in the
//   inbox; real edges replace the temps; the frontier activates.
//
// ════════════════════════════════════════════════════════════════════════════
// LOAD-BEARING INVARIANTS (the whole point):
//
//   ① PROPOSE-ONLY RED LINE. This job NEVER inserts a live `knowledge_edge` row.
//      It only calls writeAiProposal → a `propose` event. learnableFrontier (PR-1)
//      reads ONLY live non-archived edges, so a proposed edge has ZERO effect on
//      the frontier until a human accepts it in the inbox. There is NO
//      `.insert(knowledge_edge)` / createKnowledgeEdge anywhere below.
//
//   ② SPARSITY GATE (deterministic, pre-LLM, OUTSIDE the swallow). We only spend
//      an LLM call when learnableFrontier(db) is empty/sparse
//      (frontier.length <= FRONTIER_BOOTSTRAP_FLOOR). A non-empty/dense frontier
//      → no-op { skipped_dense: 1 }, ZERO LLM cost. The pre-LLM DB reads (the
//      frontier read + the candidate picker) run OUTSIDE the try/catch so a DB
//      fault RETHROWS (a legit retryable error → pg-boss retries), never a
//      swallowed proposed:0.
//
//   ③ SWALLOW-SAFE LLM HALF. The LLM call + parse + writes live inside try/catch:
//      an LLM/key/runner/parse failure → proposed:0, logged, NEVER throws out
//      (mirrors goal_scope/edge-propose's asymmetry: pre-LLM DB faults rethrow,
//      the LLM half swallows).
//
//   ④ DEDUP / ANTI-STORM. Reuse the EXISTING loadPendingEdgeProposalKeys: skip
//      (from,to,prerequisite) pairs already pending an unrated proposal, and skip
//      pairs that already have a LIVE prerequisite edge. Each proposal carries a
//      cooldown_key `knowledge_edge:${from}|${to}|prerequisite`.
//
//   ⑤ COST CAP. At most FRONTIER_FILL_MAX_PROPOSALS writes per run (clamp the LLM
//      output before writing).
// ════════════════════════════════════════════════════════════════════════════

import type { Job } from 'pg-boss';

import {
  EdgeProposalSchema,
  loadPendingEdgeProposalKeys,
} from '@/capabilities/knowledge/server/propose_edge';
// loadTreeSnapshot is the knowledge package's own tree reader (same-package import).
import { loadTreeSnapshot } from '@/capabilities/knowledge/server/tree';
// CROSS-PACKAGE seam (YUK-349): learnableFrontier is a practice-package read.
// This job lives in the KNOWLEDGE package because it PRODUCES knowledge_edge
// proposals (it is co-located with knowledge_edge_propose_nightly, the other
// graph-topology producer). It only READS the frontier as a deterministic gate
// signal — the same direction the agency goal_scope cron already crosses into
// knowledge (loadTreeSnapshot). Mirrors that documented precedent; flip if M5
// tightens package boundaries.
import { learnableFrontier } from '@/capabilities/practice/server/learnable-frontier';
import type { Db } from '@/db/client';
import { knowledge, knowledge_edge } from '@/db/schema';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { writeAiProposal } from '@/server/proposals/writer';
import { resolveSubjectProfile } from '@/subjects/profile';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

// Reuse the per-proposal EdgeProposalSchema but WITHOUT the array `.max(5)` cap
// (the cost cap is enforced on the write side via FRONTIER_FILL_MAX_PROPOSALS, so
// an over-long model output is clamped, not hard-rejected). Mirrors
// parseEdgeProposeOutput's JSON-slice extraction.
const FrontierOutputSchema = z.object({ proposals: z.array(EdgeProposalSchema) });

function parseFrontierProposals(text: string): z.infer<typeof FrontierOutputSchema> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseFrontierProposals: no JSON object found in text');
  }
  return FrontierOutputSchema.parse(JSON.parse(text.slice(start, end + 1)));
}

/**
 * Frontier emptiness threshold for the sparsity gate. We bootstrap ONLY when the
 * learnable frontier has at most this many KCs — 0 means "literally no learnable
 * frontier" (true cold-start), the most conservative gate. Raise to a small
 * positive value to keep filling while the frontier is merely SPARSE; the
 * skipped_dense no-op path is unchanged either way.
 */
export const FRONTIER_BOOTSTRAP_FLOOR = 0;

/** Hard cap on proposals written per run (cost cap / anti-storm). */
export const FRONTIER_FILL_MAX_PROPOSALS = 5;

/**
 * Weight stamped on every bootstrap prerequisite proposal. LOW on purpose: these
 * are TEMPORARY, low-confidence placeholder edges meant to be confirmed (or
 * replaced by a real edge) by the owner in the inbox — never authoritative.
 */
export const FRONTIER_TEMP_WEIGHT = 0.4;

const RELATION_PREREQUISITE = 'prerequisite' as const;

type DepsOverride = {
  runTaskFn?: TaskTextRunFn;
};

export interface FrontierFillResult {
  /** Number of candidate KCs (lacking prereq coverage) considered for the LLM input. */
  considered: number;
  /** Number of propose events actually written (≤ FRONTIER_FILL_MAX_PROPOSALS). */
  proposed: number;
  /** 1 when the frontier was non-empty/dense → no-op, no LLM call. */
  skipped_dense: number;
  /** 1 when the frontier was empty but no KC lacks prereq coverage → no-op, no LLM call. */
  skipped_no_candidate: number;
  /** Proposals dropped because an identical (from,to,prerequisite) pair is already pending. */
  skipped_duplicate_pending: number;
  /** Proposals dropped because a LIVE prerequisite edge already exists for the pair. */
  skipped_duplicate_edge: number;
  /** Proposals dropped for self-loop / unknown-node / non-candidate-target reasons. */
  skipped_invalid: number;
  /** Proposals dropped by the FRONTIER_FILL_MAX_PROPOSALS clamp. */
  skipped_over_cap: number;
}

function emptyResult(): FrontierFillResult {
  return {
    considered: 0,
    proposed: 0,
    skipped_dense: 0,
    skipped_no_candidate: 0,
    skipped_duplicate_pending: 0,
    skipped_duplicate_edge: 0,
    skipped_invalid: 0,
    skipped_over_cap: 0,
  };
}

function edgeKey(fromId: string, toId: string): string {
  return `${fromId}|${toId}|${RELATION_PREREQUISITE}`;
}

/**
 * Candidate picker — KC ids with NO incoming LIVE prerequisite edge (anti-join).
 * These are the bootstrap targets: nodes the frontier cannot yet reach because
 * nothing declares what must be learned before them. Pure READ (runs pre-LLM,
 * faults rethrow).
 */
async function loadKcsLackingPrereq(db: Db): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT k.id AS id
    FROM ${knowledge} k
    LEFT JOIN ${knowledge_edge} e
      ON e.to_knowledge_id = k.id
      AND e.relation_type = ${RELATION_PREREQUISITE}
      AND e.archived_at IS NULL
    WHERE e.id IS NULL
      AND k.archived_at IS NULL
    ORDER BY k.id
  `)) as unknown as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Empty-frontier prerequisite bootstrap. See the INVARIANT BLOCK at the top.
 *
 * @param db Db
 * @param deps.runTaskFn DI seam for the LLM call (tests inject a fake → no real LLM).
 */
export async function runFrontierFillAndWrite(
  db: Db,
  deps: DepsOverride = {},
): Promise<FrontierFillResult> {
  const result = emptyResult();

  // ── ② SPARSITY GATE (pre-LLM, OUTSIDE the swallow). A throw here is a legit
  //    retryable DB fault → propagates to the builder's rethrow → pg-boss retries.
  //    Do NOT wrap in a catch-all (would mask a DB fault behind proposed:0).
  const frontier = await learnableFrontier(db);
  if (frontier.length > FRONTIER_BOOTSTRAP_FLOOR) {
    return { ...result, skipped_dense: 1 };
  }

  // ── Candidate picker (pre-LLM, faults rethrow). KCs lacking prereq coverage are
  //    the bootstrap targets. None → no-op, NO LLM call.
  const candidateIds = await loadKcsLackingPrereq(db);
  if (candidateIds.length === 0) {
    return { ...result, skipped_no_candidate: 1 };
  }
  result.considered = candidateIds.length;

  // Tree snapshot (LLM context) + dedup sets — all pre-LLM reads (faults rethrow).
  const tree = await loadTreeSnapshot(db);
  const validNodeIds = new Set(tree.map((n) => n.id));
  const candidateSet = new Set(candidateIds);

  // ④ DEDUP — pending proposals (reuse the EXISTING anti-storm reader) + live edges.
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

  // The dominant effective_domain among candidates → LLM `domain` context hint.
  const domain = dominantDomain(tree, candidateSet);

  // ── ③ SWALLOW-SAFE LLM HALF. Everything from here (LLM call + parse + writes)
  //    is inside try/catch: an LLM/key/runner/parse fault → proposed:0, logged,
  //    NEVER throws out (mirror goal_scope / edge-propose).
  try {
    const runTaskFn = deps.runTaskFn ?? defaultRunTaskFn;
    const taskResult = await runTaskFn(
      'FrontierPrerequisiteTask',
      {
        tree_snapshot: tree.map((n) => ({
          id: n.id,
          name: n.name,
          parent_id: n.parent_id,
          effective_domain: n.effective_domain,
        })),
        kcs_lacking_prereq: candidateIds,
        domain,
      },
      { db, env: process.env, subjectProfile: resolveSubjectProfile(domain) },
    );

    const parsed = parseFrontierProposals(taskResult.text);

    for (const p of parsed.proposals) {
      // ⑤ COST CAP — clamp to at most FRONTIER_FILL_MAX_PROPOSALS writes per run.
      if (result.proposed >= FRONTIER_FILL_MAX_PROPOSALS) {
        result.skipped_over_cap += 1;
        continue;
      }

      const from = p.from_knowledge_id;
      const to = p.to_knowledge_id;

      // Validity: no self-loop; both endpoints real; `to` must be a candidate
      // (a KC actually lacking prereq coverage — we never gate an already-covered
      // KC with another temp edge).
      if (
        from === to ||
        !validNodeIds.has(from) ||
        !validNodeIds.has(to) ||
        !candidateSet.has(to)
      ) {
        result.skipped_invalid += 1;
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

      // ① PROPOSE-ONLY — writeAiProposal writes a `propose` event for the
      //    knowledge_edge, NOT a live knowledge_edge row. relation_type is FORCED
      //    to 'prerequisite' (this job only bootstraps the prereq topology) and
      //    weight to the LOW temp weight regardless of the LLM's suggestion.
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

      // Suppress an immediate intra-batch duplicate of the same pair.
      pendingEdgeKey.add(key);
      result.proposed += 1;
    }
  } catch (err) {
    // ③ Swallow-safe: log message only (an LLM-payload-carrying error must not be
    //    serialized whole into logs), return proposed:0. NEVER rethrow.
    console.error(
      '[frontier_fill_nightly] LLM half failed (no proposals written)',
      err instanceof Error ? err.message : String(err),
    );
  }

  return result;
}

/** Most common non-null effective_domain among the candidate KCs (LLM context hint). */
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

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<Awaited<ReturnType<TaskTextRunFn>>> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return result;
}

export function buildFrontierFillNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const result = await runFrontierFillAndWrite(db);
      console.log('[frontier_fill_nightly] result', result);
    } catch (err) {
      // Only pre-LLM DB faults reach here (the LLM half is swallowed inside
      // runFrontierFillAndWrite). Rethrow so pg-boss retries the DB fault.
      console.error('[frontier_fill_nightly] failed', err);
      throw err;
    }
  };
}
