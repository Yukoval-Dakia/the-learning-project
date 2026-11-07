// Creation-time tier marker for the proposal auto-apply lane.
//
// The marker records the kind strength at the moment the propose event is
// written. That is both the eligibility signal for the sweep and the
// non-retroactive switch: proposals written before a kind flips to A carry no
// marker and stay pending for human review.

import { getConfigFlag } from '@/core/config/store';
import { type AiProposalPayloadT, kindStrength } from '@/core/schema/proposal';

/** Version of the tier policy stamped on proposals at creation time. */
export const AUTO_APPLY_POLICY = 'strength_a_v1';

/** Hot switch for the whole lane; default off in every environment. */
export const PROPOSAL_AUTO_APPLY_ENABLED_KEY = 'PROPOSAL_AUTO_APPLY_ENABLED';

/**
 * Read from the hydrated config snapshot (DB override first, then env, then the
 * registry default). Off means no marker at creation and no sweep work, so
 * rows written while off can never be auto-applied retroactively.
 */
export function proposalAutoApplyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getConfigFlag(PROPOSAL_AUTO_APPLY_ENABLED_KEY, env);
}

export interface ProposalAutoApplyMarker {
  readonly eligible: true;
  readonly policy: typeof AUTO_APPLY_POLICY;
}

export function proposalAutoApplyMarker(
  kind: AiProposalPayloadT['kind'],
): ProposalAutoApplyMarker | undefined {
  return kindStrength(kind) === 'A' ? { eligible: true, policy: AUTO_APPLY_POLICY } : undefined;
}

/**
 * The exact predicate writeAiProposal applies before stamping the marker
 * (producer opt-out aside): a proposal of this kind written right now gets
 * the marker. Callers that need the fact without writing (tool output, reply
 * finalization) read this instead of re-deriving flag + strength.
 */
export function proposalAutoApplies(
  kind: AiProposalPayloadT['kind'],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return proposalAutoApplyEnabled(env) && proposalAutoApplyMarker(kind) !== undefined;
}
