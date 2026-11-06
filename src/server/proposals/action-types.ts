import type { ActivityRefT } from '@/core/schema/activity';
import type { RelationTypeSchemaT } from '@/core/schema/event/blocks';
import type {
  ProposalCorrectedPayload,
  ProposalDecisionActor,
  ProposalLifecycleResult,
} from '@/kernel/proposals';

export type AcceptAiProposalResult = ProposalLifecycleResult;
export type DismissAiProposalResult = ProposalLifecycleResult;

export interface RetractAiProposalResult extends ProposalLifecycleResult {
  kind: 'retracted';
  correction_event_id: string;
}

export type AcceptAiProposalOpts = {
  user_note?: string;
  /**
   * Internal decision attribution. The HTTP decision route never forwards a
   * client field here, so external callers stay `user/self`; only the auto-apply
   * lane supplies the proposing agent's identity.
   */
  actor?: ProposalDecisionActor;
} & (
  | {
      decision?: 'accept';
      new_relation_type?: never;
      corrected_payload?: ProposalCorrectedPayload;
      /** YUK-1404 — explicit confirmation for lossy accepts (block_merge). */
      confirm_lossy?: boolean;
    }
  | {
      decision: 'reverse';
      new_relation_type?: never;
      corrected_payload?: never;
      confirm_lossy?: never;
    }
  | {
      decision: 'change_type';
      new_relation_type: RelationTypeSchemaT;
      corrected_payload?: never;
      confirm_lossy?: never;
    }
);

export interface DismissAiProposalOpts {
  user_note?: string;
}

export interface RetractAiProposalOpts {
  reason_md?: string;
  affected_refs?: ActivityRefT[];
}
