import type { ActivityRefT } from '@/core/schema/activity';
import type { RelationTypeSchemaT } from '@/core/schema/event/blocks';
import type { AiProposalPayloadT } from '@/core/schema/proposal';

export interface ProposalAcceptProposal {
  id: string;
  payload: AiProposalPayloadT;
  status: 'pending' | 'accepted' | 'dismissed' | 'stale' | 'rubric_rejected';
  actor_ref: string;
}

export interface ProposalCorrectedPayload {
  readonly claim_md: string;
}

export interface ProposalLifecycleResult {
  readonly kind: string;
  readonly idempotent?: boolean;
  readonly [key: string]: unknown;
}

export function toProposalLifecycleResult(result: {
  readonly kind: string;
  readonly idempotent?: boolean;
}): ProposalLifecycleResult {
  return { ...result };
}

type ProposalAcceptDecision =
  | {
      decision?: 'accept';
      new_relation_type?: never;
      corrected_payload?: ProposalCorrectedPayload;
      /**
       * YUK-1404 — explicit learner confirmation for lossy accepts (today only
       * `block_merge`, whose accept is irreversible). Forwarded verbatim from
       * the canonical decision input; the capability applier owns enforcement
       * and the runtime seam can never supply or override it.
       */
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
    };

export type ProposalAcceptInput = {
  proposalId: string;
  proposal: ProposalAcceptProposal;
  user_note?: string;
} & ProposalAcceptDecision;

export interface ProposalAcceptResult {
  kind: string;
  /** Capability-owned public accept result; it must repeat the same `kind`. */
  result: ProposalLifecycleResult;
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
  correctedPayload?: true;
  /**
   * YUK-1404 — the kind owns a lossy accept (destructive, irreversible) and
   * therefore accepts the `confirm_lossy` input. Kinds without this flag
   * reject a misplaced confirm at the shared dispatch boundary.
   */
  confirmLossy?: true;
}

export interface ProposalDismissInput {
  proposalId: string;
  proposal: ProposalAcceptProposal;
  user_note?: string;
}

export interface ProposalDismissResult {
  kind: string;
  result: ProposalLifecycleResult;
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

/** Internal retry signal: the whole uncommitted correction must be discarded, never retimed. */
export class StaleProposalCorrectionClock extends Error {
  constructor(readonly requiredAt: Date) {
    super('Proposal correction must follow the locked target state');
    this.name = 'StaleProposalCorrectionClock';
  }
}

export function requireLaterProposalCorrection(correctionAt: Date, updatedAt: Date): void {
  if (correctionAt.getTime() <= updatedAt.getTime()) {
    throw new StaleProposalCorrectionClock(new Date(updatedAt.getTime() + 1));
  }
}

export type ProposalRetractApplier = (db: unknown, input: ProposalRetractInput) => Promise<void>;

export interface ProposalRetractDecl {
  load: () => Promise<ProposalRetractApplier>;
}
