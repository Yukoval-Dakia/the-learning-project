import {
  PEDAGOGY_METHOD_LIBRARY,
  type PedagogyMethodDefinitionT,
  type PedagogyMethodIdT,
  PedagogyState,
  type PedagogyStateT,
  matchesStateGuard,
} from './method-library';

export { matchesStateGuard } from './method-library';

export type PedagogyExclusionReason = 'contraindicated' | 'not_indicated';

export interface PedagogyPolicyExclusion {
  method_id: PedagogyMethodIdT;
  reason: PedagogyExclusionReason;
}

export interface PedagogyPolicyResult {
  state: PedagogyStateT;
  candidate_ids: PedagogyMethodIdT[];
  candidates: PedagogyMethodDefinitionT[];
  excluded: PedagogyPolicyExclusion[];
}

/**
 * Deterministically narrows the closed palette. A later panel may select one of
 * these candidates, but it cannot restore a method excluded by this boundary.
 */
export function selectPedagogyCandidates(input: PedagogyStateT): PedagogyPolicyResult {
  const state = PedagogyState.parse(input);
  const candidates: PedagogyMethodDefinitionT[] = [];
  const excluded: PedagogyPolicyExclusion[] = [];

  for (const method of PEDAGOGY_METHOD_LIBRARY) {
    if (method.contraindicated_when.some((guard) => matchesStateGuard(state, guard))) {
      excluded.push({ method_id: method.id, reason: 'contraindicated' });
      continue;
    }
    if (!method.indicated_when.some((guard) => matchesStateGuard(state, guard))) {
      excluded.push({ method_id: method.id, reason: 'not_indicated' });
      continue;
    }
    candidates.push(method);
  }

  if (candidates.length === 0) {
    throw new Error(
      `pedagogy policy produced no legal candidates for state: ${JSON.stringify(state)}`,
    );
  }

  return {
    state,
    candidate_ids: candidates.map((method) => method.id),
    candidates,
    excluded,
  };
}
