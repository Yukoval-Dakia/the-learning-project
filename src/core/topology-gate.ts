// ADR-0034 §2 — write-time topology gate. Pure graph checks on a candidate
// knowledge_edge; no DB or LLM. Checks run in this order:
//   ① self-loop (any relation type) → reject;
//   ② direct parent-child pair already in the tree → reject;
//   ③ inverse directed edge already exists → reject (specific 2-node back-edge);
//   ④ new prerequisite closes a cycle → reject;
//   ⑤ direct edge duplicates an existing ≥2-hop path → warn.
//
// Ordering relations policed beyond ①: `prerequisite` (②–⑤, the ADR-0034 scope)
// and `derived_from` (③ only — a mutual derivation pair is a 2-cycle in the
// derivation DAG, YUK-1601). related_to/contrasts_with are non-ordering;
// applied_in stays out of scope. A self-edge is never meaningful for any type
// (merge rewire collapses them as degenerate). Semantic checks live in
// rubric-validator.ts and stack with this gate.

export interface TopologyEdge {
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: string;
}

export interface TreeParentLink {
  child_id: string;
  parent_id: string;
}

export function isDirectTreePair(
  from: string,
  to: string,
  treeParentLinks: readonly TreeParentLink[],
): boolean {
  return treeParentLinks.some(
    (link) =>
      (link.child_id === from && link.parent_id === to) ||
      (link.child_id === to && link.parent_id === from),
  );
}

// Stable verdict discriminants, mirroring rubric-validator's gate convention.
export type TopologyGate =
  | 'cycle'
  | 'direction_contradiction'
  | 'transitive_redundancy'
  | 'tree_redundancy';

export type TopologyVerdict =
  | { status: 'ok' }
  | { status: 'reject'; gate: TopologyGate; reason: string }
  | { status: 'warn'; gate: TopologyGate; reason: string };

// The learning-order relation the ADR names; ②–⑤ apply to it.
const ORDERED_RELATION = 'prerequisite';

/** Adjacency (from → direct successors) over live prerequisite edges only. */
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
 * Reachability along prerequisite edges. Iterative DFS with a visited set, so an
 * already-corrupt graph cannot hang the check.
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
 * Run the checks for one candidate against the live edge set. Reject wins over
 * warn; non-prerequisite candidates return ok.
 *
 *   ① self-loop (any relation type) → reject
 *   ② tree parent pair → reject (prerequisite)
 *   ③ inverse directed edge → reject (prerequisite / derived_from)
 *   ④ closes a cycle → reject (prerequisite)
 *   ⑤ duplicates a path → warn (prerequisite)
 */
export function checkEdgeTopology(
  candidate: TopologyEdge,
  existing: readonly TopologyEdge[],
  treeParentLinks: readonly TreeParentLink[],
): TopologyVerdict {
  const from = candidate.from_knowledge_id;
  const to = candidate.to_knowledge_id;
  const relationType = candidate.relation_type;

  // ① Self-loop — degenerate one-node cycle, never meaningful for any relation.
  if (from === to) {
    return {
      status: 'reject',
      gate: 'cycle',
      reason: `${relationType} self-loop: from_knowledge_id equals to_knowledge_id`,
    };
  }

  if (relationType === 'derived_from') {
    // ③ (derived_from scope) — a mutual derivation pair is a 2-cycle in the
    // derivation DAG (ADR-0010: from 派生自 to).
    const inverseExists = existing.some(
      (e) =>
        e.relation_type === 'derived_from' &&
        e.from_knowledge_id === to &&
        e.to_knowledge_id === from,
    );
    if (inverseExists) {
      return {
        status: 'reject',
        gate: 'direction_contradiction',
        reason: `direction contradiction: a derived_from edge ${to} → ${from} already exists; ${from} → ${to} reverses it (mutual derivation is a 2-cycle)`,
      };
    }
    return { status: 'ok' };
  }

  // Out of scope beyond ①: only the learning-order relation is policed here.
  if (relationType !== ORDERED_RELATION) {
    return { status: 'ok' };
  }

  // ② Tree is the structural backbone; the mesh must not store a second copy of a
  // direct parent-child pair. Direction is irrelevant.
  const repeatsTreeLink = isDirectTreePair(from, to, treeParentLinks);
  if (repeatsTreeLink) {
    return {
      status: 'reject',
      gate: 'tree_redundancy',
      reason: `tree redundancy: ${from} and ${to} already form a direct parent-child relationship`,
    };
  }

  const adj = buildPrerequisiteAdjacency(existing);

  // ③ Inverse edge already exists; report this more specific gate before the generic
  // cycle check, which would also catch it.
  const inverseSuccessors = adj.get(to);
  if (inverseSuccessors?.has(from)) {
    return {
      status: 'reject',
      gate: 'direction_contradiction',
      reason: `direction contradiction: a prerequisite edge ${to} → ${from} already exists; ${from} → ${to} reverses it`,
    };
  }

  // ④ The new edge closes a cycle iff `from` is already reachable from `to`.
  if (isReachable(adj, to, from)) {
    return {
      status: 'reject',
      gate: 'cycle',
      reason: `prerequisite cycle: ${to} already reaches ${from}; adding ${from} → ${to} closes a cycle`,
    };
  }

  // ⑤ A direct edge over an existing ≥2-hop path warns; the caller decides.
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
 * Reachability over a path of length ≥ 2: check each direct successor, skipping the
 * direct edge itself.
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
