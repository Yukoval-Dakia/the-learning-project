import {
  PEDAGOGY_METHOD_LIBRARY,
  type PedagogyMethodDefinitionT,
  type PedagogyMethodIdT,
  PedagogyState,
  type PedagogyStateT,
  type StateGuardT,
} from './method-library';

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

export function matchesStateGuard(state: PedagogyStateT, guard: StateGuardT): boolean {
  if (guard.theta_band && !guard.theta_band.includes(state.theta_band)) return false;
  if (guard.precision_band && !guard.precision_band.includes(state.precision_band)) return false;
  if (
    guard.misconception_present !== undefined &&
    guard.misconception_present !== state.misconception_present
  ) {
    return false;
  }
  if (guard.kc_is_rule_based !== undefined && guard.kc_is_rule_based !== state.kc_is_rule_based) {
    return false;
  }
  return true;
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
