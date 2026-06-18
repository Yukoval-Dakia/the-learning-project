// ADR-0034 §2 — write-time structural consistency gate (TOPOLOGY layer).
//
// Spec: docs/adr/0034-knowledge-structure-consistency-gate-supersedes-bitemporal.md §2
//
// Three PURE graph checks on a candidate knowledge_edge write (no DB, no LLM):
//   ① cycle detection         — a `prerequisite` edge must not close a cycle in
//                               the learning-order graph → hard-reject.
//   ② direction contradiction — A prereq B already exists AND the candidate is
//                               B prereq A → hard-reject (the 2-node back-edge
//                               case, called out separately from the generic
//                               cycle per the ADR).
//   ③ transitive redundancy   — A→…→C is already reachable along prerequisite
//                               edges and a DIRECT A→C is proposed → warn
//                               (rejected-or-downweighted; this layer warns and
//                               lets the caller decide to fold/downweight).
//
// This is the TOPOLOGY gate ONLY. It is orthogonal to the SEMANTIC gate
// (rubric-validator.ts, §4.x evidence/relation predicates); both run on the edge
// propose-and-write path and stack. The write-time reconciliation ring (ADR-0034
// §3, blockedBy YUK-342) is a separate follow-up and is NOT implemented here.
//
// SCOPING: the cycle/direction/transitive checks apply to the `prerequisite`
// relation only — it is the load-bearing learning-ORDER relation the ADR names
// ("prerequisite 边不得成环"). `related_to` / `contrasts_with` are symmetric /
// non-ordering (cycles are meaningless). `derived_from` / `applied_in` are
// directional but the ADR scopes the topology gate to `prerequisite`; extending
// it to other directed relations is a deliberate non-goal of this lane (the
// heterogeneous-edge / misconception-edge topology gate is RT1's, ADR-0034 §
// 后果/风险). A non-prerequisite candidate always returns { status: 'ok' } from
// this gate (its semantic checks live in rubric-validator.ts).

export interface TopologyEdge {
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: string;
}

// The stable topology gate string set. Mirrors the RubricGate convention in
// rubric-validator.ts (a stable discriminant carried in the verdict).
export type TopologyGate = 'cycle' | 'direction_contradiction' | 'transitive_redundancy';

export type TopologyVerdict =
  | { status: 'ok' }
  | { status: 'reject'; gate: TopologyGate; reason: string }
  | { status: 'warn'; gate: TopologyGate; reason: string };

// The relation this gate governs. Only learning-ORDER edges form a meaningful
// DAG; the ADR names `prerequisite` explicitly.
const ORDERED_RELATION = 'prerequisite';

/**
 * Adjacency map (from → set of direct successors) built from the live
 * prerequisite edges. Non-prerequisite edges are ignored — they are not part of
 * the learning-order graph.
 */
function buildPrerequisiteAdjacency(existing: readonly TopologyEdge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const e of existing) {
    if (e.relation_type !== ORDERED_RELATION) continue;
    let succ = adj.get(e.from_knowledge_id);
    if (!succ) {
      succ = new Set<string>();
      adj.set(e.from_knowledge_id, succ);
    }
    succ.add(e.to_knowledge_id);
  }
  return adj;
}

/**
 * Is `target` reachable from `start` following prerequisite edges in `adj`?
 * Iterative DFS with a visited set — terminates even if the existing graph
 * already contains a cycle (defensive: a prior bad write should not hang us).
 */
function isReachable(adj: Map<string, Set<string>>, start: string, target: string): boolean {
  if (start === target) return true;
  const seen = new Set<string>();
  const stack: string[] = [start];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === target) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const succ = adj.get(cur);
    if (!succ) continue;
    for (const next of succ) {
      if (!seen.has(next)) stack.push(next);
    }
  }
  return false;
}

/**
 * Run the three pure topological checks for one candidate edge against the live
 * (already filtered to `archived_at IS NULL` by the caller) edge set.
 *
 * Returns a single verdict with reject taking priority over warn:
 *   - self-loop                       → reject (degenerate cycle)
 *   - direction contradiction (B→A)   → reject (more specific than the generic
 *                                       cycle for the 2-node case)
 *   - new edge closes a cycle         → reject
 *   - direct edge duplicates a path   → warn
 *   - otherwise                       → ok
 *
 * Non-prerequisite candidates are out of this gate's scope → { status: 'ok' }.
 */
export function checkEdgeTopology(
  candidate: TopologyEdge,
  existing: readonly TopologyEdge[],
): TopologyVerdict {
  // Out of scope: only the learning-order relation forms a DAG to police here.
  if (candidate.relation_type !== ORDERED_RELATION) {
    return { status: 'ok' };
  }

  const from = candidate.from_knowledge_id;
  const to = candidate.to_knowledge_id;

  // ① cycle — self-loop is the degenerate 1-node cycle.
  if (from === to) {
    return {
      status: 'reject',
      gate: 'cycle',
      reason: 'prerequisite self-loop: from_knowledge_id equals to_knowledge_id',
    };
  }

  const adj = buildPrerequisiteAdjacency(existing);

  // ② direction contradiction — the exact inverse edge already exists. This is
  // the 2-node back-edge special case; surface the more specific gate before the
  // generic cycle check (a 2-node cycle would also be caught by ① below).
  const inverseSuccessors = adj.get(to);
  if (inverseSuccessors?.has(from)) {
    return {
      status: 'reject',
      gate: 'direction_contradiction',
      reason: `direction contradiction: a prerequisite edge ${to} → ${from} already exists; ${from} → ${to} reverses it`,
    };
  }

  // ① cycle (general) — adding from → to creates a cycle iff `from` is already
  // reachable FROM `to` along existing prerequisite edges (i.e. a path to → … →
  // from already exists, and the new edge would close it).
  if (isReachable(adj, to, from)) {
    return {
      status: 'reject',
      gate: 'cycle',
      reason: `prerequisite cycle: ${to} already reaches ${from}; adding ${from} → ${to} closes a cycle`,
    };
  }

  // ③ transitive redundancy — a DIRECT from → to edge whose target is ALREADY
  // reachable from the source via an intermediate node (length ≥ 2 path). Warn,
  // do not reject (ADR §2: "rejected-or-downweighted (warning)").
  const directSuccessors = adj.get(from);
  const alreadyDirect = directSuccessors?.has(to) ?? false;
  if (!alreadyDirect && isReachableViaIntermediate(adj, from, to)) {
    return {
      status: 'warn',
      gate: 'transitive_redundancy',
      reason: `transitive redundancy: ${to} is already reachable from ${from} via an intermediate prerequisite path; a direct ${from} → ${to} edge is redundant`,
    };
  }

  return { status: 'ok' };
}

/**
 * Is `target` reachable from `start` along a path of LENGTH ≥ 2 (i.e. through at
 * least one intermediate node)? Distinguishes transitive redundancy from a plain
 * direct edge: a direct from→to is not "redundant", an A→B→C path making A→C
 * redundant is. Implemented by checking reachability from each direct successor
 * of `start` (every such path has length ≥ 2).
 */
function isReachableViaIntermediate(
  adj: Map<string, Set<string>>,
  start: string,
  target: string,
): boolean {
  const directSuccessors = adj.get(start);
  if (!directSuccessors) return false;
  for (const mid of directSuccessors) {
    if (mid === target) continue; // the direct edge itself, not an intermediate path
    if (isReachable(adj, mid, target)) return true;
  }
  return false;
}
