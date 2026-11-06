// Creation-time tier marker for the proposal auto-apply lane.
//
// The marker records the kind strength at the moment the propose event is
// written. That is both the eligibility signal for the sweep and the
// non-retroactive switch: proposals written before a kind flips to A carry no
// marker and stay pending for human review.

import { type AiProposalPayloadT, kindStrength } from '@/core/schema/proposal';

/** Version of the tier policy stamped on proposals at creation time. */
export const AUTO_APPLY_POLICY = 'strength_a_v1';

export interface ProposalAutoApplyMarker {
  readonly eligible: true;
  readonly policy: typeof AUTO_APPLY_POLICY;
}

export function proposalAutoApplyMarker(
  kind: AiProposalPayloadT['kind'],
): ProposalAutoApplyMarker | undefined {
  return kindStrength(kind) === 'A' ? { eligible: true, policy: AUTO_APPLY_POLICY } : undefined;
}
