import type { EnqueueLearningIntentNoteFn } from '@/capabilities/agency/public';
import type { ImageCandidateAcceptDeps } from '@/capabilities/ingestion/public';
import type { EnqueueVariantVerifyFn } from '@/capabilities/practice/public';
import type { ActivityRefT } from '@/core/schema/activity';
import type { RelationTypeSchemaT } from '@/core/schema/event/blocks';
import type { ProposalCorrectedPayload, ProposalLifecycleResult } from '@/kernel/proposals';

export type AcceptAiProposalResult = ProposalLifecycleResult;
export type DismissAiProposalResult = ProposalLifecycleResult;

export interface RetractAiProposalResult extends ProposalLifecycleResult {
  kind: 'retracted';
  correction_event_id: string;
}

export type AcceptAiProposalOpts = {
  user_note?: string;
  enqueueVariantVerify?: EnqueueVariantVerifyFn;
  enqueueLearningIntentNote?: EnqueueLearningIntentNoteFn;
  imageCandidateDeps?: ImageCandidateAcceptDeps;
} & (
  | {
      decision?: 'accept';
      new_relation_type?: never;
      corrected_payload?: ProposalCorrectedPayload;
    }
  | { decision: 'reverse'; new_relation_type?: never; corrected_payload?: never }
  | {
      decision: 'change_type';
      new_relation_type: RelationTypeSchemaT;
      corrected_payload?: never;
    }
);

export interface DismissAiProposalOpts {
  user_note?: string;
}

export interface RetractAiProposalOpts {
  reason_md?: string;
  affected_refs?: ActivityRefT[];
}
