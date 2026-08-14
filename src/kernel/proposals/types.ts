import type { ActivityRefT } from '@/core/schema/activity';
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
  /** Capability-owned public accept result; it must repeat the same `kind`. */
  result: unknown;
  idempotent?: boolean;
  lifecycle_outcome?: 'accepted' | 'dismissed';
}

export type ProposalAcceptApplier = (
  db: unknown,
  input: ProposalAcceptInput,
  /**
   * Composition-only runtime seams (for example network/job fakes). This is
   * never proposal data and never crosses into the kernel-owned input contract.
   */
  runtime?: unknown,
) => Promise<ProposalAcceptResult>;

export interface ProposalAcceptDecl {
  load: () => Promise<ProposalAcceptApplier>;
}

export interface ProposalDismissInput {
  proposalId: string;
  proposal: ProposalAcceptProposal;
  user_note?: string;
}

export interface ProposalDismissResult {
  kind: string;
  result: unknown;
}

export type ProposalDismissApplier = (
  db: unknown,
  input: ProposalDismissInput,
) => Promise<ProposalDismissResult>;

export interface ProposalDismissDecl {
  load: () => Promise<ProposalDismissApplier>;
}

export interface ProposalRetractInput {
  proposalId: string;
  proposal: ProposalAcceptProposal;
  correction_at: Date;
  reason_md?: string;
  affected_refs?: ActivityRefT[];
}

export type ProposalRetractApplier = (db: unknown, input: ProposalRetractInput) => Promise<void>;

export interface ProposalRetractDecl {
  load: () => Promise<ProposalRetractApplier>;
}
