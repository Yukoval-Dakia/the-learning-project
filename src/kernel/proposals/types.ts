import type { RelationTypeSchemaT } from '@/core/schema/event/blocks';
import type { AiProposalPayloadT } from '@/core/schema/proposal';

export interface ProposalAcceptProposal {
  id: string;
  payload: AiProposalPayloadT;
  status: 'pending' | 'accepted' | 'dismissed' | 'stale' | 'rubric_rejected';
  actor_ref: string;
}

type ProposalAcceptDecision =
  | { decision?: 'accept'; new_relation_type?: never }
  | { decision: 'reverse'; new_relation_type?: never }
  | { decision: 'change_type'; new_relation_type: RelationTypeSchemaT };

export type ProposalAcceptInput = {
  proposalId: string;
  proposal: ProposalAcceptProposal;
  user_note?: string;
} & ProposalAcceptDecision;

export interface ProposalAcceptResult {
  kind: string;
  result?: unknown;
  idempotent?: boolean;
}

export type ProposalAcceptApplier = (
  db: unknown,
  input: ProposalAcceptInput,
) => Promise<ProposalAcceptResult>;

export interface ProposalAcceptDecl {
  load: () => Promise<ProposalAcceptApplier>;
}
