import type { Db, Tx } from '@/db/client';
import type { question } from '@/db/schema';
import type { PublishQuestionGroupResult } from '@/kernel/records/assessment-publication';
import {
  SubmitTransactionAbort,
  drainSubmitVerifyIntents,
  submitDraftQuestionInTx,
} from './shared-submit';

// submit_question: draft (v2 or adapted legacy) → four-layer contract →
// publishQuestionGroup, the only revision writer. CAS uses expected_draft_version and
// expected_revision. Content identity matches the legacy supply fingerprint
// (prompt/reference/choices/rubric, no source or knowledge ids); near-dup uses the same
// n-gram threshold.
//
// New questions stay withheld until an admission verdict exists. An admitted group keeps
// its evidence only while the scoring layers are unchanged. Stored and new contracts are
// normalized through the same draft encoding before comparison.

export type { EditQuestionInputT, EditQuestionResult } from './edit-question';
export {
  EditQuestionInput,
  probeDraftEdit,
  saveDraftEdit,
  validateDraftEdit,
} from './edit-question';
// Write facade: capabilities reach submit/edit/draft-insert through this module.
export type { DeclaredGroupDomainOutcome } from './shared-submit';
export {
  claimSubmitRequestId,
  findSubmitReceipt,
  persistDeclaredQuestionGroup,
  writeSubmitReceiptEvent,
} from './shared-submit';
export { insertSourcedDraft } from './sourced-draft-insert';
export { sanitizeSourcedMarkup } from './sourced-markup';
export { canonicalJson, deriveKind } from './submit-decision';

export interface SubmitDraftInput {
  draft_ref: string;
  /** CAS：缺省 = 以 draft_ref 里的 version 为期望。 */
  expected_draft_version?: number;
  /** CAS：已发布组的当前 revision（qrev1 ref 或裸 id；null = 期望尚无发布）。 */
  expected_revision?: string | null;
  request_id: string;
  /** 覆盖文档 knowledge_ids（缺省 = 文档自带）。 */
  knowledge_ids?: string[];
  /** 覆盖来源声明（缺省 = 文档 source）。 */
  availability?: 'general_pool' | 'container_only';
  /**
   * Trusted system injection for sourcing_web / jyeoo_fetch candidates: row projection
   * and source evidence that land in the same publish transaction, because source_verify
   * needs extract. Only valid on the first submit of a new group.
   */
  sourced?: {
    /** Flat content fingerprint, identical to the legacy canonical_content_hash. */
    canonical_content_hash: string;
    /** question.created_by (AgentRef jsonb). */
    created_by: (typeof question.$inferInsert)['created_by'];
    /** Producer-declared difficulty; column default is 3. */
    difficulty?: number;
    /** System keys merged into question.metadata (provenance, supply, attribution). */
    metadata: Record<string, unknown>;
    /** Supply trace, opaque to this seam; verify_dispatch owns its attribution. */
    supply_trace?: unknown;
    /** Terminal claim for a one-page-one-question source URL, serialized with the row
     * INSERT so concurrent candidates for the same URL cannot both insert. */
    source_claim?: {
      source_url: string;
      actor_ref: 'sourcing' | 'jyeoo_fetch';
    };
  };
}

export interface SubmitUnitOutcome {
  unit_id: string;
  status: 'admitted' | 'withheld' | 'pending' | 'skipped';
  reason?: string;
}

export type SubmitResult =
  | {
      status: 'admitted' | 'withheld' | 'pending';
      question_id: string;
      group_id: string;
      revision_id?: string;
      revision_ref?: string;
      revision_ordinal?: number;
      publish_status?: PublishQuestionGroupResult['status'];
      /** Per-unit admission outcome with the real withholding reason. */
      per_unit: SubmitUnitOutcome[];
      verify_enqueued?: boolean;
      issues?: { code: string; detail: string; part_id?: string; unit_id?: string }[];
      request_id: string;
      replayed?: boolean;
    }
  | {
      status: 'conflict';
      reason:
        | 'draft_version_cas'
        | 'revision_cas'
        | 'request_id_reused'
        | 'not_a_draft'
        | 'invalid_request'
        | 'duplicate_exact'
        | 'duplicate_source'
        | 'near_dup'
        | 'publish_conflict';
      detail: string;
      question_id?: string;
      existing_question_id?: string | null;
      current_draft_ref?: string;
      current_draft_version?: number;
      current_revision_ref?: string | null;
      request_id: string;
      replayed?: boolean;
    }
  | {
      status: 'withheld';
      published: false;
      detail: string;
      issues: { code: string; detail: string; part_id?: string; unit_id?: string }[];
      per_unit: SubmitUnitOutcome[];
      request_id: string;
      replayed?: boolean;
    };

interface SubmitContext {
  beforeWrite?: (tx: Tx) => Promise<void>;
  actorRef: string;
  actorKind: 'agent' | 'user' | 'system';
  sessionId?: string | null;
  taskRunId?: string;
  causedByEventId?: string | null;
  now?: Date;
}

/** Public transaction boundary: rollback publication failures, then dispatch durable intents after commit. */
export async function submitDraftQuestion(
  db: Db,
  input: SubmitDraftInput,
  ctx: SubmitContext,
): Promise<SubmitResult> {
  let out: SubmitResult;
  try {
    out = await db.transaction((tx) => submitDraftQuestionInTx(tx, input, ctx));
  } catch (error) {
    if (error instanceof SubmitTransactionAbort) return error.receipt;
    throw error;
  }
  await drainSubmitVerifyIntents(db, out);
  return out;
}
