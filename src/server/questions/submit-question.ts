import { createHash } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, ne, or, sql } from 'drizzle-orm';
import {
  DEDUP_OVERLAP_THRESHOLD,
  canonicalQuestionContentHash,
  claimHttpSourceDuplicate,
  maxNgramOverlap,
  mergeExactQuestionDuplicateKnowledgeIds,
  runQuestionAdmissionChecks,
} from '@/capabilities/practice/public';
import { newId } from '@/core/ids';
import {
  validateExecutionPlan,
  validateResponseSpec,
  validateScoringBasis,
  validateStructure,
} from '@/core/schema/assessment';
import {
  Presentation,
  type PresentationT,
  defaultPresentation,
  validatePresentation,
} from '@/core/schema/assessment/presentation';
import { AdmissionEvidence } from '@/core/schema/assessment/publish';
import { AgentRef } from '@/core/schema/business';
import {
  QuestionDraftDocument,
  type QuestionDraftDocumentT,
  draftDocumentToStructuredQuestion,
  isDraftDocumentV2,
  isLegacyStructuredQuestion,
  structuredQuestionToDraftDocument,
} from '@/core/schema/question-draft';
import type { Db, Tx } from '@/db/client';
import { question, question_block, question_group_lifecycle, question_revision } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { publishedContractSeal } from '@/kernel/records/assessment-normalization';
import type {
  PublishAdmission,
  PublishQuestionGroupResult,
} from '@/kernel/records/assessment-publication';
import {
  dispatchPendingVerifyIntents,
  writeVerifyDispatchIntent,
} from '@/server/boss/verify-dispatch-outbox';
import { projectQuestionBlockGuarded } from '@/server/projections/question_block';
import { writeQuestionBlockLifecycleEvent } from '@/server/projections/question_block-lifecycle-event';
import {
  type DraftContract,
  applyScoringEditPlan,
  draftCanonicalIdentity,
  draftDocumentToContract,
  revisionToDraftDocument,
  scoringRoundTripIsFaithful,
} from '@/server/questions/draft-contract';
import { encodeDraftRef, parseDraftRef } from '@/server/questions/edit-question';
import { publishQuestionGroup } from '@/server/questions/publisher';

// submit_question: draft (v2 or adapted legacy) → four-layer contract →
// publishQuestionGroup, the only revision writer. CAS uses expected_draft_version and
// expected_revision. Content identity matches the legacy supply fingerprint
// (prompt/reference/choices/rubric, no source or knowledge ids); near-dup uses the same
// n-gram threshold.
//
// New questions stay withheld until an admission verdict exists. An admitted group keeps
// its evidence only while the scoring layers are unchanged. Stored and new contracts are
// normalized through the same draft encoding before comparison.

const DRAFT_SUBMIT_ACTION = 'experimental:question_draft_submit';

export type { EditQuestionInputT, EditQuestionResult } from './edit-question';
export {
  EditQuestionInput,
  parseDraftRef,
  probeDraftEdit,
  saveDraftEdit,
  validateDraftEdit,
} from './edit-question';
// Write facade: capabilities reach submit/edit/publish/draft-insert through this module.
export { publishQuestionGroupFromRow } from './publisher';
export { insertSourcedDraft } from './sourced-draft-insert';
export { sanitizeSourcedMarkup } from './sourced-markup';

type BlockRow = typeof question_block.$inferSelect;

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
  actorRef: string;
  actorKind: 'agent' | 'user' | 'system';
  sessionId?: string | null;
  taskRunId?: string;
  causedByEventId?: string | null;
  now?: Date;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.keys(v)
          .sort()
          .reduce<Record<string, unknown>>((acc, k) => {
            acc[k] = (v as Record<string, unknown>)[k];
            return acc;
          }, {})
      : v,
  );
}

// ---------- admission 钩子 ----------

export interface AdmissionCheckInput {
  doc: QuestionDraftDocumentT;
  unitSummary: { unit_id: string; judgeable_today: boolean; withheld_reason?: string }[];
  knowledgeIds: string[];
  groupId: string;
}

export interface AdmissionCheckResult {
  admission:
    | { state: 'withheld'; reason: 'unverified_rules' }
    | { state: 'admitted'; evidence: null };
  per_unit: SubmitUnitOutcome[];
  /** Group-level blockers such as dead_knowledge_node. */
  group_blockers: { code: string; detail: string }[];
}

/**
 * Scoring admission check. Submit carries no verdict, so a judgeable group stays
 * withheld; once question_admission_run supplies passing evidence, a group on live
 * knowledge nodes can be admitted. Dead knowledge nodes remain group blockers.
 */
export async function runAdmissionChecks(
  db: Db | Tx,
  input: AdmissionCheckInput,
): Promise<AdmissionCheckResult> {
  return runQuestionAdmissionChecks(db, {
    knowledgeIds: input.knowledgeIds,
    unitSummary: input.unitSummary,
  });
}

// ---------- question 行投影 ----------

const SOURCE_KIND_TO_QUESTION_SOURCE: Record<string, string> = {
  generated: 'quiz_gen',
  adapted: 'adapted',
  owner_material: 'manual',
  photo_ingest: 'photo_ingest',
  jyeoo_fetch: 'web_sourced',
  sourcing_web: 'web_sourced',
  manual: 'manual',
};

// Re-exported through this facade so source_verify reuses the same authoritative
// revision→flat projection without adding a capability→questions import edge.
export { draftCanonicalIdentity, revisionToDraftDocument } from './draft-contract';

export function deriveKind(doc: QuestionDraftDocumentT): string {
  const classes = new Set(doc.parts.flatMap((p) => p.units.map((u) => u.response_class)));
  if (doc.parts.length > 1 || classes.size > 1) return 'composite';
  const only = [...classes][0];
  if (only === 'select') return 'choice';
  if (only === 'blank') return 'fill_blank';
  if (only === 'free') return 'short_answer';
  return 'composite';
}

const NEAR_DUP_POOL_LIMIT = 100;

function draftCarriesFigure(doc: QuestionDraftDocumentT): boolean {
  return doc.materials.some((material) => material.kind === 'figure');
}

type ScoringRevision = Pick<
  typeof question_revision.$inferSelect,
  | 'revision_id'
  | 'group_id'
  | 'structure'
  | 'response_spec'
  | 'scoring_basis'
  | 'execution_plan'
  | 'presentation'
>;

/**
 * An admitted group keeps its evidence only while the scoring layers are unchanged.
 * Prompt, presentation and material text may change; a changed key/rule/executor or a
 * no-longer-judgeable unit returns the group to withheld. New groups never auto-admit.
 */
function conversionWithheld(contract: DraftContract, requestId: string): SubmitResult {
  return {
    status: 'withheld',
    published: false,
    detail: 'draft has unresolved conversion issues',
    issues: contract.conversion_issues.map((i) => ({
      code: i.code,
      detail: i.detail,
      ...(i.part_id != null ? { part_id: i.part_id } : {}),
      ...(i.unit_id != null ? { unit_id: i.unit_id } : {}),
    })),
    per_unit: contract.unit_summary.map((u) => ({
      unit_id: u.unit_id,
      status: 'withheld',
      ...(u.withheld_reason != null ? { reason: u.withheld_reason } : {}),
    })),
    request_id: requestId,
  };
}

function storedScoringCopied(revision: ScoringRevision, contract: DraftContract): boolean {
  return (
    canonicalJson(revision.response_spec) === canonicalJson(contract.response_spec) &&
    canonicalJson(revision.scoring_basis) === canonicalJson(contract.scoring_basis) &&
    canonicalJson(revision.execution_plan) === canonicalJson(contract.execution_plan)
  );
}

function admissionForContentEdit(
  lifecycle: typeof question_group_lifecycle.$inferSelect | undefined,
  checks: AdmissionCheckResult,
  revision: ScoringRevision | null,
  contract: DraftContract,
  knowledgeIds: string[],
): PublishAdmission {
  if (lifecycle?.scoring_admission_state !== 'admitted') return checks.admission;
  const copied = revision != null && storedScoringCopied(revision, contract);
  // A verbatim copied scoring layer did not introduce the encoder's human_review.
  if (!copied && checks.per_unit.some((unit) => unit.status === 'withheld')) {
    return checks.admission;
  }
  if (revision == null || !scoringLayersUnchanged(revision, contract, knowledgeIds)) {
    return checks.admission;
  }
  const parsed = AdmissionEvidence.safeParse(lifecycle.scoring_admission_evidence);
  if (!parsed.success || parsed.data.verification.structural_check_passed !== true) {
    return checks.admission;
  }
  const independent = parsed.data.verification.independent_verification;
  if (independent != null && independent.passed !== true) return checks.admission;
  return { state: 'admitted', evidence: parsed.data };
}

/**
 * Stored and new revisions may use different encodings (legacy option_set_key/
 * single_choice versus select_key/select), so run the stored revision through the same
 * draft round trip before comparing the three layers. Byte-identical published layers
 * count as unchanged even if the round trip is lossy; an unfaithful trip counts as changed.
 */
function scoringLayersUnchanged(
  revision: ScoringRevision,
  contract: DraftContract,
  knowledgeIds: string[],
): boolean {
  if (storedScoringCopied(revision, contract)) return true;
  let canonical: DraftContract;
  try {
    canonical = draftDocumentToContract(
      revisionToDraftDocument(revision, { knowledge_ids: knowledgeIds }),
      revision.group_id,
    );
  } catch {
    return false;
  }
  if (canonical.conversion_issues.length > 0) return false;
  if (!scoringRoundTripIsFaithful(revision, canonical)) return false;
  return (
    canonicalJson(canonical.scoring_basis) === canonicalJson(contract.scoring_basis) &&
    canonicalJson(canonical.response_spec) === canonicalJson(contract.response_spec) &&
    canonicalJson(canonical.execution_plan) === canonicalJson(contract.execution_plan)
  );
}

/** Collect publish-seam contract errors up front; unadmitted model executors are allowed while withheld. */
function contractBarrierIssues(
  contract: DraftContract,
  presentation: PresentationT | null,
  admission: PublishAdmission,
): { code: string; detail: string }[] {
  const issues: { code: string; detail: string }[] = [];
  const push = (list: { code: string; detail: string }[]) => {
    for (const issue of list) issues.push({ code: issue.code, detail: issue.detail });
  };
  push(validateStructure(contract.structure));
  push(validateResponseSpec(contract.response_spec, contract.structure));
  push(validateScoringBasis(contract.scoring_basis, contract.response_spec, contract.structure));
  push(
    validateExecutionPlan(contract.execution_plan, contract.scoring_basis).filter(
      (issue) => !(issue.code === 'unadmitted_model_executor' && admission.state === 'withheld'),
    ),
  );
  if (presentation != null) {
    push(
      validatePresentation(
        presentation,
        contract.structure,
        contract.response_spec,
        contract.scoring_basis,
      ),
    );
  }
  return issues;
}

function presentationForDraft(
  doc: QuestionDraftDocumentT,
  contract: DraftContract,
): PresentationT | null {
  if (doc.presentation != null) {
    const shaped = Presentation.safeParse(doc.presentation);
    if (shaped.success) {
      const issues = validatePresentation(
        shaped.data,
        contract.structure,
        contract.response_spec,
        contract.scoring_basis,
      );
      if (issues.length === 0) return shaped.data;
    }
  }
  return defaultPresentation(contract.structure, contract.response_spec, contract.scoring_basis);
}

async function attributableSourceIssue(
  tx: Tx,
  doc: QuestionDraftDocumentT,
  isNew: boolean,
): Promise<{ code: string; detail: string } | null> {
  const source = doc.source;
  if (source == null) {
    if (!isNew) return null;
    return { code: 'missing_source', detail: 'document has no attributable source' };
  }
  if (source.kind !== 'adapted') return null;
  const from = source.adapted_from_question_id;
  if (from == null || from.length === 0) {
    return {
      code: 'missing_source',
      detail: 'adapted source requires adapted_from_question_id',
    };
  }
  const [row] = await tx
    .select({ id: question.id })
    .from(question)
    .where(eq(question.id, from))
    .limit(1);
  if (row == null) {
    return {
      code: 'missing_source',
      detail: `adapted_from_question_id '${from}' does not exist`,
    };
  }
  return null;
}

function nearDupComparableText(
  promptMd: string,
  referenceMd: string | null,
  choicesMd: readonly string[] | null,
): string {
  const choices = (choicesMd ?? [])
    .map((choice) => choice.trim())
    .filter((choice) => choice.length > 0);
  return [promptMd.trim(), referenceMd?.trim() ?? '', ...choices]
    .filter((part) => part.length > 0)
    .join('\n');
}

async function nearDuplicateInKnowledge(
  tx: Tx,
  knowledgeIds: string[],
  promptMd: string,
  referenceMd: string | null,
  choicesMd: string[] | null,
  excludeQuestionId: string,
): Promise<{ overlap: number; poolSize: number } | null> {
  if (knowledgeIds.length === 0) return null;
  const predicates = knowledgeIds.map(
    (id) => sql`${question.knowledge_ids} @> ${JSON.stringify([id])}::jsonb`,
  );
  const rows = await tx
    .select({
      prompt_md: question.prompt_md,
      reference_md: question.reference_md,
      choices_md: question.choices_md,
    })
    .from(question)
    .where(
      and(
        or(...predicates),
        ne(question.id, excludeQuestionId),
        sql`(${question.metadata} ->> 'archived_at') IS NULL`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${question_group_lifecycle} AS l
          WHERE l.group_id = COALESCE(${question.parent_question_id}, ${question.id})
            AND l.withdrawn = true
        )`,
      ),
    )
    .orderBy(desc(question.created_at))
    .limit(NEAR_DUP_POOL_LIMIT);
  const overlap = maxNgramOverlap(
    nearDupComparableText(promptMd, referenceMd, choicesMd),
    rows.map((row) => nearDupComparableText(row.prompt_md, row.reference_md, row.choices_md)),
  );
  if (overlap < DEDUP_OVERLAP_THRESHOLD) return null;
  return { overlap, poolSize: rows.length };
}

// ---------- 主入口 ----------

export async function submitDraftQuestion(
  db: Db,
  input: SubmitDraftInput,
  ctx: SubmitContext,
): Promise<SubmitResult> {
  const requestId = input.request_id;
  if (requestId == null || requestId.length === 0) {
    return {
      status: 'conflict',
      reason: 'not_a_draft',
      detail: 'request_id is required for submit idempotency',
      request_id: '',
    };
  }
  const parsedRef = parseDraftRef(input.draft_ref);
  if (parsedRef == null) {
    return {
      status: 'conflict',
      reason: 'not_a_draft',
      detail: `invalid draft_ref '${input.draft_ref}' (expected qdraft1:<block>:<version>)`,
      request_id: requestId,
    };
  }
  const expectedRevisionRaw = input.expected_revision;
  // Shape check: qrev1:<id>:<digest> or a bare revision_id. Malformed values reject;
  // undefined defers to doc.base.revision_id, null expects no published revision.
  let expectedRevisionId: string | null | undefined;
  if (expectedRevisionRaw === undefined) {
    expectedRevisionId = undefined;
  } else if (expectedRevisionRaw === null) {
    expectedRevisionId = null;
  } else if (
    expectedRevisionRaw.length === 0 ||
    (expectedRevisionRaw.includes(':') && !expectedRevisionRaw.startsWith('qrev1:'))
  ) {
    return {
      status: 'conflict',
      reason: 'invalid_request',
      detail: `malformed expected_revision '${expectedRevisionRaw}' (expected qrev1:<id>:<digest> or a bare revision_id, or null)`,
      request_id: requestId,
    };
  } else {
    expectedRevisionId = parseExpectedRevision(expectedRevisionRaw);
  }

  // request_id idempotency: same content replays the receipt, different content rejects.
  const fingerprint = `sha256:${createHash('sha256')
    .update(
      canonicalJson({
        draft_ref: input.draft_ref,
        expected_draft_version: input.expected_draft_version,
        expected_revision: expectedRevisionRaw,
        knowledge_ids: input.knowledge_ids,
        availability: input.availability,
        // Identity fields bind the replay; metadata is bookkeeping with timestamps that
        // drift across retries, so it stays out of the fingerprint.
        sourced:
          input.sourced != null
            ? {
                canonical_content_hash: input.sourced.canonical_content_hash,
                created_by: input.sourced.created_by,
                difficulty: input.sourced.difficulty ?? null,
                // source_claim is deterministic (URL + actor), so it participates;
                // metadata and supply_trace still do not.
                source_claim:
                  input.sourced.source_claim != null
                    ? {
                        source_url: input.sourced.source_claim.source_url,
                        actor_ref: input.sourced.source_claim.actor_ref,
                      }
                    : null,
              }
            : null,
      }),
    )
    .digest('hex')}`;
  const now = ctx.now ?? new Date();
  const out = await db.transaction(async (tx): Promise<SubmitResult> => {
    // Serialize same-request_id submissions, then look for a replay inside the lock.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${requestId}))`);
    const existing = await findSubmitReceipt(tx, requestId);
    if (existing != null) {
      if (existing.fingerprint === fingerprint) {
        return { ...(existing.receipt as SubmitResult), replayed: true };
      }
      return {
        status: 'conflict',
        reason: 'request_id_reused',
        detail: `request_id '${requestId}' was used with different content`,
        request_id: requestId,
      };
    }

    const [block] = await tx
      .select()
      .from(question_block)
      .where(eq(question_block.id, parsedRef.blockId))
      .for('update')
      .limit(1);
    if (block == null) {
      return {
        status: 'conflict',
        reason: 'not_a_draft',
        detail: `draft '${parsedRef.blockId}' not found`,
        request_id: requestId,
      };
    }
    if (block.status !== 'draft') {
      return {
        status: 'conflict',
        reason: 'not_a_draft',
        detail: `draft '${block.id}' status '${block.status}' (already submitted/retired)`,
        request_id: requestId,
      };
    }
    const expectedDraftVersion = input.expected_draft_version ?? parsedRef.version;
    if (block.version !== expectedDraftVersion) {
      return {
        status: 'conflict',
        reason: 'draft_version_cas',
        detail: `draft '${block.id}' version is ${block.version}, expected ${expectedDraftVersion}`,
        current_draft_ref: encodeDraftRef(block.id, block.version),
        current_draft_version: block.version,
        request_id: requestId,
      };
    }
    const doc = documentOfBlock(block);
    if (doc == null) {
      return {
        status: 'conflict',
        reason: 'not_a_draft',
        detail: `draft '${block.id}' has no v2 document or adaptable legacy tree`,
        request_id: requestId,
      };
    }
    if (input.knowledge_ids != null) doc.knowledge_ids = input.knowledge_ids;

    // Default CAS uses the draft's pinned base revision; explicit expected_revision
    // overrides it. Keep null distinct from undefined or the CAS turns off.
    const pinnedBaseRevision =
      doc.base == null || doc.base.revision_id === undefined ? undefined : doc.base.revision_id;
    const effectiveExpectedRevision =
      expectedRevisionId !== undefined ? expectedRevisionId : pinnedBaseRevision;

    const groupId = doc.base?.question_id ?? block.imported_question_id ?? createId();
    let contract = draftDocumentToContract(doc, groupId);
    const editingExisting = doc.base?.question_id != null || block.imported_question_id != null;

    // New questions fail fast on conversion issues; edits wait for the scoring plan,
    // because a verbatim copy of the stored layers may clear them.
    if (!editingExisting && contract.conversion_issues.length > 0) {
      return conversionWithheld(contract, requestId);
    }

    // Group state (CAS + lifecycle snapshot); the publish seam rechecks the token.
    const [lifecycle] = await tx
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, groupId))
      .for('update')
      .limit(1);
    const currentRevisionId = lifecycle?.current_revision_id ?? null;
    if (
      effectiveExpectedRevision !== undefined &&
      effectiveExpectedRevision !== currentRevisionId
    ) {
      return {
        status: 'conflict',
        reason: 'revision_cas',
        detail: `group '${groupId}' current revision is ${currentRevisionId ?? 'none'}, expected ${effectiveExpectedRevision ?? 'none'}`,
        current_draft_ref: encodeDraftRef(block.id, block.version),
        current_draft_version: block.version,
        current_revision_ref: currentRevisionId,
        request_id: requestId,
      };
    }

    // Admission hook: dual-solve/calibration lanes extend this decision.
    const admission = await runAdmissionChecks(tx, {
      doc,
      unitSummary: contract.unit_summary,
      knowledgeIds: doc.knowledge_ids,
      groupId,
    });
    if (admission.group_blockers.length > 0) {
      const withheld: SubmitResult = {
        status: 'withheld',
        published: false,
        detail: admission.group_blockers.map((b) => `${b.code}: ${b.detail}`).join('; '),
        issues: admission.group_blockers.map((b) => ({ code: b.code, detail: b.detail })),
        per_unit: admission.per_unit,
        request_id: requestId,
      };
      return withheld;
    }

    // question is the working-copy projection; the revision remains scoring truth.
    const identity = draftCanonicalIdentity(doc);
    const canonicalHash = canonicalQuestionContentHash(identity);
    const structuredProjection = draftDocumentToStructuredQuestion(doc);
    const promptMd = identity.promptMd;
    const referenceMd = identity.referenceMd;
    const choicesMd = identity.choicesMd;
    // Row presence drives insert vs update; an empty lifecycle does not mean no row.
    const [existingRow] = await tx
      .select({ id: question.id, source: question.source })
      .from(question)
      .where(eq(question.id, groupId))
      .limit(1);
    const isNew = existingRow == null;
    // System injection is valid only on a new group's first submit; reject misuse
    // instead of silently dropping it.
    if (input.sourced != null && !isNew) {
      const conflict: SubmitResult = {
        status: 'conflict',
        reason: 'invalid_request',
        detail: 'sourced projection is only valid for the first submit of a new group',
        request_id: requestId,
      };
      await writeSubmitReceiptEvent(
        tx,
        { kind: 'question_block', id: block.id },
        requestId,
        fingerprint,
        conflict,
        ctx,
        now,
      );
      return conflict;
    }
    const sourceIssue = await attributableSourceIssue(tx, doc, isNew);
    if (sourceIssue != null) {
      const withheld: SubmitResult = {
        status: 'withheld',
        published: false,
        detail: sourceIssue.detail,
        issues: [sourceIssue],
        per_unit: admission.per_unit,
        request_id: requestId,
      };
      return withheld;
    }
    const questionSource =
      doc.source != null
        ? (SOURCE_KIND_TO_QUESTION_SOURCE[doc.source.kind] ?? 'quiz_gen')
        : (existingRow?.source ?? 'manual');
    const [currentRevision] =
      currentRevisionId == null
        ? []
        : await tx
            .select({
              revision_id: question_revision.revision_id,
              group_id: question_revision.group_id,
              structure: question_revision.structure,
              response_spec: question_revision.response_spec,
              scoring_basis: question_revision.scoring_basis,
              execution_plan: question_revision.execution_plan,
              presentation: question_revision.presentation,
            })
            .from(question_revision)
            .where(eq(question_revision.revision_id, currentRevisionId))
            .limit(1);
    if (currentRevision != null) {
      const applied = applyScoringEditPlan(currentRevision, doc, contract);
      if (applied.plan.action === 'refuse') {
        return {
          status: 'withheld',
          published: false,
          detail: applied.plan.detail,
          issues: [{ code: applied.plan.code, detail: applied.plan.detail }],
          per_unit: admission.per_unit,
          request_id: requestId,
        };
      }
      contract = applied.contract;
    }
    // Unresolved conversion means no revision. Withheld results are not receipted:
    // a deterministic request_id would otherwise replay the failure forever.
    if (contract.conversion_issues.length > 0) {
      return conversionWithheld(contract, requestId);
    }
    const effectiveAdmission = admissionForContentEdit(
      lifecycle,
      admission,
      currentRevision ?? null,
      contract,
      doc.knowledge_ids,
    );
    const presentation = presentationForDraft(doc, contract);
    const barrierIssues = contractBarrierIssues(contract, presentation, effectiveAdmission);
    if (barrierIssues.length > 0) {
      const withheld: SubmitResult = {
        status: 'withheld',
        published: false,
        detail: barrierIssues.map((issue) => `${issue.code}: ${issue.detail}`).join('; '),
        issues: barrierIssues,
        per_unit: admission.per_unit,
        request_id: requestId,
      };
      return withheld;
    }
    const integrityDigest = publishedContractSeal({
      structure: contract.structure,
      response_spec: contract.response_spec,
      scoring_basis: contract.scoring_basis,
      execution_plan: contract.execution_plan,
      ...(presentation != null ? { presentation } : {}),
    }).canonical;
    if (isNew) {
      // Claim the source URL in this transaction so concurrent candidates serialize;
      // a hit becomes duplicate_source with a receipt rather than a dropped claim.
      if (input.sourced?.source_claim != null) {
        const claimedSource = await claimHttpSourceDuplicate(tx, {
          sourceUrl: input.sourced.source_claim.source_url,
          knowledgeIds: doc.knowledge_ids,
          actorRef: input.sourced.source_claim.actor_ref,
          taskRunId: ctx.taskRunId,
          now,
          onTerminal: 'release',
        });
        if (claimedSource != null) {
          const conflict: SubmitResult = {
            status: 'conflict',
            reason: 'duplicate_source',
            detail: `同一来源网址命中既有题 ${claimedSource.existingQuestionId}；目标 KC 已并入`,
            question_id: claimedSource.existingQuestionId,
            existing_question_id: claimedSource.existingQuestionId,
            request_id: requestId,
          };
          await writeSubmitReceiptEvent(
            tx,
            { kind: 'question_block', id: block.id },
            requestId,
            fingerprint,
            conflict,
            ctx,
            now,
          );
          return conflict;
        }
      }
      // The injected flat fingerprint wins so exact dedup matches legacy flat rows.
      const hashForDedup = input.sourced?.canonical_content_hash ?? canonicalHash;
      // Live dedup claim: merge into the canonical-hash holder, else insert.
      const merged = await mergeExactQuestionDuplicateKnowledgeIds(tx, {
        canonicalContentHash: hashForDedup,
        knowledgeIds: doc.knowledge_ids,
        actorRef: 'sourcing',
        taskRunId: ctx.taskRunId,
        now,
      });
      if (merged?.disposition === 'merged') {
        const conflict: SubmitResult = {
          status: 'conflict',
          reason: 'duplicate_exact',
          detail: `canonical hash 命中既有题 ${merged.id}；目标 KC 已并入`,
          question_id: merged.id,
          existing_question_id: merged.id,
          request_id: requestId,
        };
        await writeSubmitReceiptEvent(
          tx,
          { kind: 'question_block', id: block.id },
          requestId,
          fingerprint,
          conflict,
          ctx,
          now,
        );
        return conflict;
      }
      if (!draftCarriesFigure(doc)) {
        const near = await nearDuplicateInKnowledge(
          tx,
          doc.knowledge_ids,
          promptMd,
          referenceMd,
          choicesMd,
          groupId,
        );
        if (near != null) {
          const conflict: SubmitResult = {
            status: 'conflict',
            reason: 'near_dup',
            detail: `n-gram overlap ${near.overlap.toFixed(3)} ≥ ${DEDUP_OVERLAP_THRESHOLD}（KC 池 ${near.poolSize} 题）`,
            request_id: requestId,
          };
          await writeSubmitReceiptEvent(
            tx,
            { kind: 'question_block', id: block.id },
            requestId,
            fingerprint,
            conflict,
            ctx,
            now,
          );
          return conflict;
        }
      }
      await tx.insert(question).values({
        id: groupId,
        kind: deriveKind(doc),
        prompt_md: promptMd,
        reference_md: referenceMd,
        choices_md: choicesMd,
        knowledge_ids: doc.knowledge_ids,
        source: questionSource,
        source_ref: doc.source?.ref ?? null,
        draft_status: 'draft',
        structured: structuredProjection,
        // Sourcing provenance when injected, otherwise submit_question's own system ref.
        created_by:
          input.sourced?.created_by ?? AgentRef.parse({ by: 'ai', task_kind: 'submit_question' }),
        metadata: {
          draft_block_id: block.id,
          submit_source: doc.source ?? null,
          schema_version: 2,
          // System provenance/supply metadata; source_verify depends on it.
          ...(input.sourced?.metadata ?? {}),
        },
        created_at: now,
        updated_at: now,
        canonical_content_hash: hashForDedup,
        ...(input.sourced?.difficulty != null ? { difficulty: input.sourced.difficulty } : {}),
      });
    } else {
      // Editing a published question: a hash held by another row is a conflict.
      const hashHolder = await tx
        .select({ id: question.id })
        .from(question)
        .where(eq(question.canonical_content_hash, canonicalHash))
        .limit(1);
      if (hashHolder[0] != null && hashHolder[0].id !== groupId) {
        return {
          status: 'conflict',
          reason: 'duplicate_exact',
          detail: `canonical hash 被 ${hashHolder[0].id} 占用`,
          existing_question_id: hashHolder[0].id,
          request_id: requestId,
        };
      }
      // The row projects the currently admitted revision. Unpublishable edits keep the
      // previous content and mark the row draft; only admitted edits update content.
      if (effectiveAdmission.state === 'admitted') {
        await tx
          .update(question)
          .set({
            prompt_md: promptMd,
            reference_md: referenceMd,
            choices_md: choicesMd,
            knowledge_ids: doc.knowledge_ids,
            structured: structuredProjection,
            canonical_content_hash: canonicalHash,
            kind: deriveKind(doc),
            updated_at: now,
            version: sql`${question.version} + 1`,
          })
          .where(eq(question.id, groupId));
      } else if (lifecycle?.scoring_admission_state === 'admitted') {
        await tx
          .update(question)
          .set({
            draft_status: 'draft',
            updated_at: now,
            version: sql`${question.version} + 1`,
          })
          .where(eq(question.id, groupId));
      }
    }

    // The single publish seam.
    const publishResult = await publishQuestionGroup(tx, {
      group_id: groupId,
      contract: {
        structure: contract.structure,
        response_spec: contract.response_spec,
        scoring_basis: contract.scoring_basis,
        execution_plan: contract.execution_plan,
        integrity_digest: integrityDigest,
        ...(presentation != null ? { presentation } : {}),
      },
      expectedCurrentRevision: currentRevisionId,
      expectedAdmissionGeneration: lifecycle?.scoring_admission_generation ?? null,
      availability:
        input.availability ??
        lifecycle?.availability ??
        (questionSource === 'web_sourced' || questionSource === 'quiz_gen'
          ? 'general_pool'
          : 'container_only'),
      admission: effectiveAdmission,
      actorRef: `submit_question:${ctx.actorRef}`,
      publishedBy: AgentRef.parse({ by: 'ai', task_kind: 'submit_question' }),
      now,
    });
    if (publishResult.status === 'conflict') {
      return {
        status: 'conflict',
        reason: 'publish_conflict',
        detail: `publish seam conflict (${publishResult.reason})`,
        question_id: groupId,
        current_revision_ref: publishResult.current_revision_id,
        request_id: requestId,
      };
    }
    const revisionId =
      publishResult.status === 'published' || publishResult.status === 'noop'
        ? ((publishResult as { revision_id?: string }).revision_id ??
          (publishResult as { current_revision_id?: string }).current_revision_id)
        : undefined;

    // Draft terminal state + verify outbox for fetched sources.
    const nextBlockVersion = block.version + 1;
    await writeQuestionBlockLifecycleEvent(tx, {
      blockId: block.id,
      op: 'set_status',
      status: 'submitted',
      importedQuestionId: groupId,
      importedAttemptEventId: undefined,
      nextVersion: nextBlockVersion,
      actorKind: ctx.actorKind === 'system' ? 'system' : ctx.actorKind,
      actorRef: ctx.actorRef,
      now,
    });
    await projectQuestionBlockGuarded(tx, block.id);

    let verifyEnqueued: boolean | undefined;
    const sourceKind = doc.source?.kind;
    if (sourceKind === 'jyeoo_fetch' || sourceKind === 'sourcing_web') {
      await writeVerifyDispatchIntent(tx, {
        questionId: groupId,
        verifier: 'source_verify',
        createdAt: now,
        ...(input.sourced?.supply_trace != null ? { supplyTrace: input.sourced.supply_trace } : {}),
      });
      verifyEnqueued = true;
    }

    const receipt: SubmitResult = {
      // Priority: withheld (gate) > pending (awaiting verify) > admitted.
      status:
        effectiveAdmission.state === 'withheld'
          ? 'withheld'
          : verifyEnqueued === true
            ? 'pending'
            : 'admitted',
      question_id: groupId,
      group_id: groupId,
      ...(revisionId != null ? { revision_id: revisionId } : {}),
      ...(publishResult.status === 'published'
        ? {
            revision_ref: `qrev1:${publishResult.revision_id}:${(publishResult.revision_digest ?? '').replace('sha256:', '').slice(0, 12)}`,
            revision_ordinal: publishResult.revision_ordinal,
          }
        : {}),
      publish_status: publishResult.status,
      per_unit: admission.per_unit,
      ...(verifyEnqueued != null ? { verify_enqueued: verifyEnqueued } : {}),
      request_id: requestId,
    };
    await writeSubmitReceiptEvent(
      tx,
      { kind: 'question_block', id: block.id },
      requestId,
      fingerprint,
      receipt,
      ctx,
      now,
    );
    return receipt;
  });

  // Dispatch verify intents after commit; failures leave a durable intent. Dispatch
  // keys on the emitted intent, not receipt.status: new sourced drafts are withheld
  // but still need immediate verification, not a delayed worker recover.
  const verifyIntent =
    'verify_enqueued' in out && out.verify_enqueued === true ? out.question_id : null;
  if (verifyIntent != null) {
    try {
      const dispatch = await dispatchPendingVerifyIntents(db, {
        questionIds: [verifyIntent],
        enqueue: async (verifier, ids, options) => {
          if (verifier !== 'source_verify') {
            throw new Error(`submit_question outbox received unexpected verifier '${verifier}'`);
          }
          const { getStartedBoss } = await import('@/server/boss/client');
          const boss = await getStartedBoss();
          await boss.send('source_verify', { question_ids: ids }, options);
        },
      });
      if (dispatch.failed > 0) {
        console.error(
          '[submit_question] source_verify enqueue failed; durable intent left:',
          verifyIntent,
        );
      }
    } catch (err) {
      console.error('[submit_question] verify dispatch failed (durable intent remains):', err);
    }
  }
  return out;
}

function parseExpectedRevision(raw: string): string | null {
  const parts = raw.split(':');
  if (parts.length === 3 && parts[0] === 'qrev1') return parts[1];
  return raw;
}

function documentOfBlock(block: BlockRow): QuestionDraftDocumentT | null {
  const structured = block.structured;
  if (structured == null) return null;
  if (isDraftDocumentV2(structured)) {
    const parsed = QuestionDraftDocument.safeParse(structured);
    return parsed.success ? parsed.data : null;
  }
  if (isLegacyStructuredQuestion(structured)) {
    return structuredQuestionToDraftDocument(structured, block.figures ?? []);
  }
  return null;
}

async function findSubmitReceipt(
  db: Db | Tx,
  requestId: string,
): Promise<{ fingerprint: string; receipt: SubmitResult } | null> {
  const { event } = await import('@/db/schema');
  const rows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, DRAFT_SUBMIT_ACTION),
        sql`${event.payload} ->> 'request_id' = ${requestId}`,
      ),
    )
    .orderBy(desc(event.created_at))
    .limit(1);
  const payload = rows[0]?.payload as { fingerprint?: string; receipt?: SubmitResult } | undefined;
  if (payload?.fingerprint == null || payload.receipt == null) return null;
  return { fingerprint: payload.fingerprint, receipt: payload.receipt };
}

/** Claim a request_id after acquiring pg_advisory_xact_lock(hashtext(request_id));
 * shared with candidate/compat submit paths. */
export async function claimSubmitRequestId(
  tx: Tx,
  requestId: string,
  fingerprint: string,
): Promise<
  | { status: 'claimed' }
  | { status: 'replay'; receipt: SubmitResult }
  | { status: 'reused'; existing: { fingerprint: string } }
> {
  const existing = await findSubmitReceipt(tx, requestId);
  if (existing == null) return { status: 'claimed' };
  if (existing.fingerprint === fingerprint) return { status: 'replay', receipt: existing.receipt };
  return { status: 'reused', existing };
}

/** Submit receipt event: draft submits target question_block, candidate submits question. */
export async function writeSubmitReceiptEvent(
  tx: Tx,
  subject: { kind: 'question_block' | 'question'; id: string },
  requestId: string,
  fingerprint: string,
  receipt: SubmitResult,
  ctx: SubmitContext,
  now: Date,
): Promise<void> {
  await writeEvent(tx, {
    id: newId(),
    actor_kind: ctx.actorKind === 'system' ? 'system' : ctx.actorKind,
    actor_ref: ctx.actorRef,
    action: DRAFT_SUBMIT_ACTION,
    subject_kind: subject.kind,
    subject_id: subject.id,
    outcome: 'success',
    payload: { request_id: requestId, fingerprint, receipt },
    created_at: now,
    ingest_at: now,
  });
}
