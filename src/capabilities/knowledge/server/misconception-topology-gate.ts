// YUK-531 (A5 S4 / ADR-0034 §后果/风险 #45) — PARALLEL heterogeneous topology gate
// for misconception_edge writes.
//
// This is the RT1 counterpart the HOMOGENEOUS knowledge_edge gate (topology-gate.ts)
// explicitly punted ("the heterogeneous-edge / misconception-edge topology gate is
// RT1's"). It is NOT a clone of checkEdgeTopology: the cycle / direction / transitive
// checks there police a `prerequisite` learning-ORDER DAG over a single kind
// (knowledge_id ↔ knowledge_id). Those do not map onto misconception edges, which are
// CROSS-KIND (misconception → knowledge / event / misconception) and not ordered, so a
// cycle is meaningless. The structurally meaningful checks for these relations are:
//   ① endpoint-kind validity — a misconception edge MUST originate at a misconception,
//      and each relation pins its target kind (caused_by → knowledge, observed_in →
//      event, confusable_with → misconception|knowledge). `experimental:*` is the
//      ADR-0036 escape valve: from_kind is still pinned, but to_kind is unconstrained.
//   ② self-loop — a same-entity edge (from_kind==to_kind ∧ from_id==to_id) is the
//      degenerate "X confusable with itself" case → reject.
//   ③ symmetric redundancy — `confusable_with` is symmetric, so an inverse edge
//      (to → from, confusable_with) already in the graph makes the candidate redundant
//      → warn (mirrors the homogeneous gate's transitive_redundancy: warn, not reject).
//
// PURE: no DB, no LLM. The caller (PR-3 promotion writer / accept route) filters
// `existing` to the live (archived_at IS NULL) edge set and stacks this with the Zod
// vocabulary check (core/schema/misconception-edge.ts) and the soft-track red line.

import { CANONICAL_MISCONCEPTION_RELATIONS } from '@/core/schema/misconception-edge';

export interface MisconceptionTopologyEdge {
  from_kind: string;
  from_id: string;
  to_kind: string;
  to_id: string;
  relation_type: string;
}

// Stable discriminant carried in the verdict (mirrors TopologyGate in topology-gate.ts).
export type MisconceptionTopologyGate = 'endpoint_kind' | 'self_loop' | 'symmetric_redundancy';

export type MisconceptionTopologyVerdict =
  | { status: 'ok' }
  | { status: 'reject'; gate: MisconceptionTopologyGate; reason: string }
  | { status: 'warn'; gate: MisconceptionTopologyGate; reason: string };

// Every misconception edge originates at a misconception (RT1 invariant). knowledge /
// event only ever appear as the TARGET kind.
const FROM_KIND = 'misconception';

// Per-relation target-kind constraints. Keys MUST cover every canonical relation
// (asserted below); `experimental:*` is handled separately (from pinned, to free).
const ENDPOINT_RULES: Record<string, readonly string[]> = {
  caused_by: ['knowledge'], // 误区 → 它在哪个 KC 上致错 (the "指向此点" join)
  confusable_with: ['misconception', 'knowledge'], // 误区 ↔ 易混的误区/正确概念
  observed_in: ['event'], // 误区 → 观测到它的 event (provenance 回链)
};

// Fail-loud drift guard: if a canonical relation gains/loses membership without a
// matching ENDPOINT_RULES entry, this throws at module load rather than silently
// accepting an unconstrained relation.
for (const rel of CANONICAL_MISCONCEPTION_RELATIONS) {
  if (!Object.hasOwn(ENDPOINT_RULES, rel)) {
    throw new Error(
      `misconception-topology-gate: ENDPOINT_RULES missing canonical relation "${rel}"`,
    );
  }
}

// Mirrors the Zod regex (misconception-edge.ts /^experimental:.+/): an experimental
// relation requires a non-empty tag — a bare `experimental:` is NOT experimental and
// falls through to the unknown-relation reject (keeps the gate ≥ as strict as Zod).
function isExperimental(relationType: string): boolean {
  return /^experimental:.+/.test(relationType);
}

/**
 * Run the pure heterogeneous topology checks for one candidate misconception_edge
 * against the live (already filtered to archived_at IS NULL by the caller) edge set.
 *
 * reject takes priority over warn, numbered in run order:
 *   ① from_kind not 'misconception' / target kind wrong for the relation → reject (endpoint_kind)
 *   ② same-entity self-loop                                              → reject (self_loop)
 *   ③ confusable_with inverse already exists                            → warn   (symmetric_redundancy)
 *   - otherwise                                                          → ok
 */
export function checkMisconceptionEdgeTopology(
  candidate: MisconceptionTopologyEdge,
  existing: readonly MisconceptionTopologyEdge[],
): MisconceptionTopologyVerdict {
  const { from_kind, from_id, to_kind, to_id, relation_type } = candidate;

  // ① endpoint-kind validity — from MUST be a misconception (RT1 invariant).
  if (from_kind !== FROM_KIND) {
    return {
      status: 'reject',
      gate: 'endpoint_kind',
      reason: `misconception_edge must originate at a misconception; got from_kind="${from_kind}"`,
    };
  }

  // ① (cont.) target kind must match the relation. experimental:* pins from_kind
  // (checked above) but leaves to_kind unconstrained (ADR-0036 escape valve).
  if (!isExperimental(relation_type)) {
    // Object.hasOwn (NOT bracket truthiness) so a prototype-chain key like
    // 'constructor' / 'toString' / '__proto__' hits this defensive reject instead of
    // resolving to an inherited member and throwing on `.includes` below. Vocabulary
    // is Zod-validated upstream; reaching here means an unknown relation slipped
    // through — reject defensively (a defense layer must reject, never crash).
    if (!Object.hasOwn(ENDPOINT_RULES, relation_type)) {
      return {
        status: 'reject',
        gate: 'endpoint_kind',
        reason: `unknown misconception relation_type "${relation_type}" has no endpoint rule`,
      };
    }
    const allowedTo = ENDPOINT_RULES[relation_type];
    if (!allowedTo.includes(to_kind)) {
      return {
        status: 'reject',
        gate: 'endpoint_kind',
        reason: `relation "${relation_type}" requires to_kind ∈ {${allowedTo.join(', ')}}; got to_kind="${to_kind}"`,
      };
    }
  }

  // ② self-loop — degenerate same-entity edge (only possible when kinds match, e.g.
  // a misconception confusable_with itself).
  if (from_kind === to_kind && from_id === to_id) {
    return {
      status: 'reject',
      gate: 'self_loop',
      reason: `self-loop: ${from_kind} ${from_id} cannot relate to itself via "${relation_type}"`,
    };
  }

  // ③ symmetric redundancy — `confusable_with` is symmetric, so an inverse edge
  // (to → from, same relation) already in the live graph makes the candidate
  // redundant. Warn (caller decides to fold/downweight), do not reject.
  // NOTE: this is reachable ONLY for misc↔misc confusable_with. The inverse match
  // needs e.from_kind === to_kind, and the RT1 invariant pins every live edge's
  // from_kind to 'misconception' — so a misc→knowledge confusable_with candidate can
  // never have a legal inverse in `existing` (returns ok, no false warn). misc↔misc
  // exact-forward dups + canonical ordering are the PR-3 writer's job (DB unique idx).
  if (relation_type === 'confusable_with') {
    const inverseExists = existing.some(
      (e) =>
        e.relation_type === 'confusable_with' &&
        e.from_kind === to_kind &&
        e.from_id === to_id &&
        e.to_kind === from_kind &&
        e.to_id === from_id,
    );
    if (inverseExists) {
      return {
        status: 'warn',
        gate: 'symmetric_redundancy',
        reason: `symmetric redundancy: an inverse confusable_with edge (${to_kind} ${to_id} → ${from_kind} ${from_id}) already exists; ${from_kind} ${from_id} → ${to_kind} ${to_id} is redundant`,
      };
    }
  }

  return { status: 'ok' };
}
