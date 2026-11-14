import { QuestionDraftDocument, type QuestionDraftDocumentT } from '@/core/schema/question-draft';
import type { SourcedQuestionT } from '@/core/schema/sourcing';
import type { Db, Tx } from '@/db/client';
import type { question } from '@/db/schema';
import type { PublishQuestionGroupResult } from '@/kernel/records/assessment-publication';
import {
  type PublicationIdentity,
  type PublicationReceiptT,
  publicationReceiptFromSubmit,
} from '@/kernel/records/publication-receipt';
import { DraftSubmitVectorRequired, prepareDraftSubmitVector } from './draft-submit-dedup';
import {
  type DeclaredGroupDomainOutcome,
  SubmitTransactionAbort,
  drainSubmitVerifyIntents,
  submitDraftQuestionInTx,
} from './shared-submit';
import { sanitizeSourcedMarkup } from './sourced-markup';

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
  /** Supply demand that requested this question; recorded on the publication receipt. */
  demand_id?: string;
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
      /** Assessment publish event written in the submit transaction; the publication
       *  receipt's identity for progress and repair authorization. */
      publication_event_id?: string;
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
  signal?: AbortSignal;
  beforeWrite?: (tx: Tx) => Promise<void>;
  actorRef: string;
  actorKind: 'agent' | 'user' | 'system';
  sessionId?: string | null;
  taskRunId?: string;
  causedByEventId?: string | null;
  /** Server-bound publication anchor for a run whose content provenance is its ticket. */
  publicationCausedByEventId?: string | null;
  /** Server-bound gap-ticket scope; gates edits of existing questions. */
  ticketEventId?: string | null;
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
    try {
      out = await db.transaction((tx) =>
        submitDraftQuestionInTx(tx, input, ctx, { checkDraftVector: true }),
      );
    } catch (error) {
      if (!(error instanceof DraftSubmitVectorRequired)) throw error;
      const draftVector = await prepareDraftSubmitVector(
        db,
        error,
        input.request_id,
        ctx.taskRunId ? 'worker' : 'api',
        {
          signal: ctx.signal,
          beforeSend: ctx.beforeWrite
            ? () => db.transaction(async (tx) => ctx.beforeWrite?.(tx))
            : undefined,
        },
      );
      out = await db.transaction((tx) =>
        submitDraftQuestionInTx(tx, input, ctx, { checkDraftVector: true, draftVector }),
      );
    }
  } catch (error) {
    if (error instanceof SubmitTransactionAbort) return error.receipt;
    throw error;
  }
  await drainSubmitVerifyIntents(db, out);
  return out;
}

// Declared candidate → v2 draft document. Content text passes the same ingest markup
// sanitizer as the legacy flat writer (deterministic, no semantic change); answer keys
// (accepted/equivalent_forms) are cleaned the same way, because the flat path already
// cleaned reference_md before grading. Producer-declared structure/slots/ids/answer_shape/
// blank_order pass through verbatim — never re-minted or inferred.
export function declaredCandidateDocument(
  q: SourcedQuestionT,
  sourceRoute: 'jyeoo_fetch' | 'sourcing_web',
  knowledgeIds: string[],
): { document: QuestionDraftDocumentT; markupSanitized: boolean } {
  let markupSanitized = false;
  const clean = (text: string): string => {
    const next = sanitizeSourcedMarkup(text);
    if (next !== text) markupSanitized = true;
    return next;
  };
  const parts = (q.parts ?? []).map((part) => ({
    ...part,
    prompt_md: clean(part.prompt_md),
    ...(part.explanation_md != null ? { explanation_md: clean(part.explanation_md) } : {}),
    units: part.units.map((unit) => ({
      ...unit,
      ...(unit.reference_md != null ? { reference_md: clean(unit.reference_md) } : {}),
      ...(unit.key?.kind === 'blank'
        ? {
            key:
              unit.key.key.kind === 'text'
                ? {
                    ...unit.key,
                    key: { ...unit.key.key, accepted: unit.key.key.accepted.map(clean) },
                  }
                : unit.key.key.equivalent_forms != null
                  ? {
                      ...unit.key,
                      key: {
                        ...unit.key.key,
                        equivalent_forms: unit.key.key.equivalent_forms.map(clean),
                      },
                    }
                  : unit.key,
          }
        : {}),
      response_spec:
        unit.response_spec.kind === 'select'
          ? {
              ...unit.response_spec,
              items: unit.response_spec.items.map((item) => ({
                ...item,
                ...(item.label_md != null ? { label_md: clean(item.label_md) } : {}),
              })),
              ...(unit.response_spec.text != null ? { text: clean(unit.response_spec.text) } : {}),
            }
          : unit.response_spec,
      ...(unit.rubric != null
        ? {
            rubric: {
              ...unit.rubric,
              ...(unit.rubric.guidance_md != null
                ? { guidance_md: clean(unit.rubric.guidance_md) }
                : {}),
              criteria: unit.rubric.criteria.map((criterion) => ({
                ...criterion,
                ...(criterion.statement_md != null
                  ? { statement_md: clean(criterion.statement_md) }
                  : {}),
              })),
            },
          }
        : {}),
    })),
  }));
  const document = QuestionDraftDocument.parse({
    schema_version: 2,
    parts,
    materials: [],
    knowledge_ids: knowledgeIds,
    metadata: {},
    source: { kind: sourceRoute, ref: q.source_url, note: q.source_title },
  });
  return { document, markupSanitized };
}

/** The declared path's runtime reason vocabulary is wider than the facade's own
 *  SubmitResult union (the tool boundary has always cast it); keep the cast in one place. */
const callerReceipt = (receipt: object): SubmitResult => receipt as SubmitResult;

/** Canonical caller receipt for one declared-group outcome. Publication identity is
 *  the owner receipt, never a re-derivation from the tool response. */
export function declaredCandidateReceipt(
  outcome: DeclaredGroupDomainOutcome,
  requestId: string,
  identity: PublicationIdentity,
): { receipt: SubmitResult; publication: PublicationReceiptT | null } {
  if (outcome.status === 'declaration_failed') {
    return {
      receipt: callerReceipt({
        status: 'conflict',
        reason: 'invalid_declaration',
        detail: 'declared identity binding failed',
        issues: outcome.issues,
        request_id: requestId,
      }),
      publication: null,
    };
  }
  const save = outcome.save;
  if (outcome.status === 'save_failed' || (save.status !== 'saved' && save.status !== 'noop')) {
    if (save.status === 'conflict') {
      return {
        receipt: callerReceipt({
          status: 'conflict',
          reason: save.reason,
          detail: save.detail,
          request_id: requestId,
        }),
        publication: null,
      };
    }
    if (save.status === 'rejected') {
      return {
        receipt: callerReceipt({
          status: 'conflict',
          reason: 'invalid_declaration',
          detail: save.reason,
          issues: save.issues,
          request_id: requestId,
        }),
        publication: null,
      };
    }
    return {
      receipt: callerReceipt({
        status: 'conflict',
        reason: 'invalid_request',
        detail: `unexpected draft save status '${save.status}'`,
        request_id: requestId,
      }),
      publication: null,
    };
  }
  const submit = outcome.submit;
  if (submit.status === 'conflict') {
    return {
      receipt: callerReceipt({
        status: 'conflict',
        reason: submit.reason,
        detail: submit.detail,
        ...(submit.existing_question_id != null
          ? { existing_question_id: submit.existing_question_id }
          : {}),
        request_id: requestId,
      }),
      publication: null,
    };
  }
  if ('published' in submit) {
    return {
      receipt: callerReceipt({
        status: 'withheld',
        published: false,
        reason: 'draft_unpublishable',
        detail: submit.detail,
        issues: submit.issues,
        per_unit: submit.per_unit,
        current_draft_ref: save.draft_ref,
        current_draft_version: save.draft_version,
        request_id: requestId,
      }),
      publication: null,
    };
  }
  // A replayed :submit receipt refers to an earlier committed publication; the owner
  // returns no block for it, so the caller receipt never claims a second publication.
  const publication = publicationReceiptFromSubmit(
    {
      publish_status: submit.publish_status,
      replayed: submit.replayed === true,
      group_id: submit.group_id,
      question_id: submit.question_id,
      revision_id: submit.revision_id,
      publication_event_id: submit.publication_event_id,
    },
    identity,
  );
  return { receipt: submit, publication };
}
