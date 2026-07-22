import type { RelationTypeSchemaT } from '@/core/schema/event/blocks';
import type { AiProposalPayloadT } from '@/core/schema/proposal';
import type { Db } from '@/db/client';

export interface ProposalAcceptProposal {
  id: string;
  kind: AiProposalPayloadT['kind'];
  target: AiProposalPayloadT['target'];
  payload: AiProposalPayloadT;
  status: 'pending' | 'accepted' | 'dismissed' | 'stale' | 'rubric_rejected';
  actor_ref: string;
}

export interface ProposalAcceptInput {
  proposalId: string;
  proposal: ProposalAcceptProposal;
  decision?: 'accept' | 'reverse' | 'change_type';
  new_relation_type?: RelationTypeSchemaT;
  user_note?: string;
}

export interface ProposalAcceptResult {
  kind: string;
  idempotent?: boolean;
}

export type ProposalAcceptApplier = (
  db: Db,
  input: ProposalAcceptInput,
) => Promise<ProposalAcceptResult>;

export interface ProposalAcceptDecl {
  load: () => Promise<ProposalAcceptApplier>;
}
