// Topology gate for misconception edges. Unlike the prerequisite DAG gate, these edges
// are cross-kind and unordered, so cycles are meaningless. The meaningful checks are:
// endpoint kinds, self-loops, and symmetric redundancy for confusable_with.
//
// Experimental relations still pin the source kind but leave the target free. Pure: the
// caller supplies live neighbors and stacks this with schema validation.

import {
  CANONICAL_MISCONCEPTION_RELATIONS,
  EXPERIMENTAL_RELATION,
} from '@/core/schema/misconception-edge';

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

// Every misconception edge originates at a misconception; knowledge and event are
// targets only.
const FROM_KIND = 'misconception';

// Target-kind constraints per relation; experimental relations are handled separately.
const ENDPOINT_RULES: Record<string, readonly string[]> = {
  caused_by: ['knowledge'],
  confusable_with: ['misconception', 'knowledge'],
  observed_in: ['event'],
};

// Drift guard: a new canonical relation without a rule fails at module load.
for (const rel of CANONICAL_MISCONCEPTION_RELATIONS) {
  if (!Object.hasOwn(ENDPOINT_RULES, rel)) {
    throw new Error(
      `misconception-topology-gate: ENDPOINT_RULES missing canonical relation "${rel}"`,
    );
  }
}

// Same regex as Zod. A bare `experimental:` is not experimental; it falls through to
// the unknown-relation reject so the gate stays at least as strict as the schema.
function isExperimental(relationType: string): boolean {
  return EXPERIMENTAL_RELATION.test(relationType);
}

/**
 * Check one candidate against live neighbors. Endpoint-kind and self-loop failures
 * reject; an existing inverse confusable_with only warns.
 */
export function checkMisconceptionEdgeTopology(
  candidate: MisconceptionTopologyEdge,
  existing: readonly MisconceptionTopologyEdge[],
): MisconceptionTopologyVerdict {
  const { from_kind, from_id, to_kind, to_id, relation_type } = candidate;

  if (from_kind !== FROM_KIND) {
    return {
      status: 'reject',
      gate: 'endpoint_kind',
      reason: `misconception_edge must originate at a misconception; got from_kind="${from_kind}"`,
    };
  }

  // Target kind must match the relation unless the relation is experimental.
  if (!isExperimental(relation_type)) {
    // hasOwn, not truthiness, so a prototype key rejects instead of crashing.
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

  if (from_kind === to_kind && from_id === to_id) {
    return {
      status: 'reject',
      gate: 'self_loop',
      reason: `self-loop: ${from_kind} ${from_id} cannot relate to itself via "${relation_type}"`,
    };
  }

  // An inverse confusable_with already states the same relation. Only misc-to-misc
  // can have one, since live edges always originate at a misconception.
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
