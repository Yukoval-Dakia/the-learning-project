import type {
  CompletionAcceptResult,
  ConjectureAcceptResult,
  EnqueueLearningIntentNoteFn,
  GoalScopeAcceptResult,
  LearningItemAcceptResult,
  RelearnAcceptResult,
} from '@/capabilities/agency/public';
import type {
  BlockMergeAcceptResult,
  ImageCandidateAcceptDeps,
  ImageCandidateAcceptResult,
  RecordLinksAcceptResult,
  RecordPromotionAcceptResult,
} from '@/capabilities/ingestion/public';
import type {
  KnowledgeAcceptResult,
  KnowledgeEdgeProposalDecisionResult,
} from '@/capabilities/knowledge/public';
import type { NoteUpdateAcceptResult } from '@/capabilities/notes/public';
import type {
  EnqueueVariantVerifyFn,
  QuestionDraftAcceptResult,
  QuestionEditAcceptResult,
  VariantQuestionAcceptResult,
} from '@/capabilities/practice/public';
import type { ActivityRefT } from '@/core/schema/activity';
import type { RelationTypeSchemaT } from '@/core/schema/event/blocks';

export type AcceptAiProposalResult =
  | {
      kind: 'knowledge_node';
      result: KnowledgeAcceptResult | null;
      idempotent?: boolean;
    }
  | {
      kind: 'knowledge_mutation';
      result: KnowledgeAcceptResult | null;
      idempotent?: boolean;
    }
  | KnowledgeEdgeProposalDecisionResult
  | VariantQuestionAcceptResult
  | LearningItemAcceptResult
  | CompletionAcceptResult
  | RelearnAcceptResult
  | NoteUpdateAcceptResult
  | RecordLinksAcceptResult
  | RecordPromotionAcceptResult
  | GoalScopeAcceptResult
  | BlockMergeAcceptResult
  | ImageCandidateAcceptResult
  | QuestionDraftAcceptResult
  | QuestionEditAcceptResult
  | ConjectureAcceptResult;

export type DismissAiProposalResult =
  | KnowledgeEdgeProposalDecisionResult
  | {
      kind: 'dismissed';
      rate_event_id: string | null;
      idempotent?: boolean;
    };

export interface RetractAiProposalResult {
  kind: 'retracted';
  correction_event_id: string;
}

export type AcceptAiProposalOpts = {
  user_note?: string;
  enqueueVariantVerify?: EnqueueVariantVerifyFn;
  enqueueLearningIntentNote?: EnqueueLearningIntentNoteFn;
  imageCandidateDeps?: ImageCandidateAcceptDeps;
  corrected_payload?: { claim_md: string };
} & (
  | { decision?: 'accept'; new_relation_type?: never }
  | { decision: 'reverse'; new_relation_type?: never }
  | { decision: 'change_type'; new_relation_type: RelationTypeSchemaT }
);

export interface DismissAiProposalOpts {
  user_note?: string;
}

export interface RetractAiProposalOpts {
  reason_md?: string;
  affected_refs?: ActivityRefT[];
}
