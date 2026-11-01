import {
  DEDUP_OVERLAP_THRESHOLD,
  claimHttpSourceDuplicate,
  embedQuestionTextForIngest,
  findVectorNearDuplicate,
  mergeExactQuestionDuplicateKnowledgeIds,
  vectorNearHoldMetadata,
} from '@/capabilities/practice/public';
import { encodeDraftRef } from '@/core/question-draft-ref';
import type { QuestionDraftDocumentT } from '@/core/schema/question-draft';
import type { Db, Tx } from '@/db/client';
import { isDirectProviderAttemptInvariantError } from '@/server/ai/direct-provider-attempt';
import { draftCarriesFigure, nearDuplicateInKnowledge } from './submit-decision';
import type { SubmitDraftInput, SubmitResult } from './submit-question';

type QuestionText = {
  prompt_md: string;
  reference_md: string | null;
  choices_md: string[] | null;
};

export interface DraftSubmitVector {
  blockId: string;
  draftVersion: number;
  canonicalHash: string;
  vector: number[] | null;
}

/** Leave the validation transaction before any embedding request. */
export class DraftSubmitVectorRequired extends Error {
  constructor(
    readonly draft: Omit<DraftSubmitVector, 'vector'>,
    readonly text: QuestionText,
  ) {
    super('draft submission requires an outside-transaction vector comparison');
    this.name = 'DraftSubmitVectorRequired';
  }
}

/** Source identity, exact merging and near-duplicate decisions share the insert transaction. */
export async function deduplicateNewDraftInTx(
  tx: Tx,
  params: {
    input: SubmitDraftInput;
    document: QuestionDraftDocumentT;
    groupId: string;
    blockId: string;
    draftVersion: number;
    canonicalHash: string;
    text: QuestionText;
    taskRunId?: string;
    now: Date;
    draftVector?: DraftSubmitVector;
  },
): Promise<
  | { conflict: Extract<SubmitResult, { status: 'conflict' }> }
  | { canonicalHash: string; metadata: Record<string, unknown> }
> {
  const { input, document: doc, groupId, blockId, draftVersion, text, taskRunId, now } = params;
  const sourceClaim =
    input.sourced?.source_claim ??
    (doc.source?.ref != null
      ? {
          source_url: doc.source.ref,
          actor_ref:
            doc.source.kind === 'jyeoo_fetch' ? ('jyeoo_fetch' as const) : ('sourcing' as const),
        }
      : null);
  if (sourceClaim != null) {
    const claimed = await claimHttpSourceDuplicate(tx, {
      sourceUrl: sourceClaim.source_url,
      knowledgeIds: doc.knowledge_ids,
      actorRef: sourceClaim.actor_ref,
      taskRunId,
      now,
      onTerminal: 'release',
    });
    if (claimed != null) {
      return {
        conflict: {
          status: 'conflict',
          reason: 'duplicate_source',
          detail: `同一来源网址命中既有题 ${claimed.existingQuestionId}；目标 KC 已并入`,
          question_id: claimed.existingQuestionId,
          existing_question_id: claimed.existingQuestionId,
          request_id: input.request_id,
        },
      };
    }
  }
  const canonicalHash = input.sourced?.canonical_content_hash ?? params.canonicalHash;
  const merged = await mergeExactQuestionDuplicateKnowledgeIds(tx, {
    canonicalContentHash: canonicalHash,
    knowledgeIds: doc.knowledge_ids,
    actorRef: 'sourcing',
    taskRunId,
    now,
  });
  if (merged?.disposition === 'merged') {
    return {
      conflict: {
        status: 'conflict',
        reason: 'duplicate_exact',
        detail: `canonical hash 命中既有题 ${merged.id}；目标 KC 已并入`,
        question_id: merged.id,
        existing_question_id: merged.id,
        request_id: input.request_id,
      },
    };
  }
  if (!draftCarriesFigure(doc)) {
    const near = await nearDuplicateInKnowledge(
      tx,
      doc.knowledge_ids,
      text.prompt_md,
      text.reference_md,
      text.choices_md,
      groupId,
    );
    if (near != null) {
      return {
        conflict: {
          status: 'conflict',
          reason: 'near_dup',
          detail: `n-gram overlap ${near.overlap.toFixed(3)} ≥ ${DEDUP_OVERLAP_THRESHOLD}（KC 池 ${near.poolSize} 题）`,
          request_id: input.request_id,
        },
      };
    }
  }
  let metadata: Record<string, unknown> = {};
  if (input.sourced == null) {
    const prepared = params.draftVector;
    if (prepared == null) {
      throw new DraftSubmitVectorRequired(
        { blockId, draftVersion, canonicalHash: params.canonicalHash },
        text,
      );
    }
    if (
      prepared.blockId !== blockId ||
      prepared.draftVersion !== draftVersion ||
      prepared.canonicalHash !== params.canonicalHash
    ) {
      return {
        conflict: {
          status: 'conflict',
          reason: 'draft_version_cas',
          detail: 'draft changed while preparing the vector comparison; reread before submitting',
          current_draft_ref: encodeDraftRef(blockId, draftVersion),
          current_draft_version: draftVersion,
          request_id: input.request_id,
        },
      };
    }
    if (prepared.vector != null) {
      const near = await findVectorNearDuplicate(tx, prepared.vector);
      if (near != null) metadata = vectorNearHoldMetadata(near);
    }
  }
  return { canonicalHash, metadata };
}

export async function prepareDraftSubmitVector(
  db: Db,
  required: DraftSubmitVectorRequired,
  requestId: string,
  caller: 'api' | 'worker',
): Promise<DraftSubmitVector> {
  let vector: number[] | null = null;
  try {
    vector = await embedQuestionTextForIngest(required.text, {
      db,
      caller,
      operationAnchor: `draft-submit-dedup:${requestId}`,
      deadlineAt: new Date(Date.now() + 20_000),
    });
  } catch (error) {
    if (isDirectProviderAttemptInvariantError(error)) throw error;
    // Match candidate ingestion: unavailable embeddings do not reject paid content.
    console.error('[submit_question] draft vector near-dup abstained:', error);
  }
  return { ...required.draft, vector };
}
