// ====================================================================
// YUK-1568 S3 — submit 判定层（从 submit-question.ts 提取的完整原实现）。
//
// 职责边界：这里只放提交前的「读侧判定」——准入检查归口、判分层比对、
// 契约屏障、presentation 推导、来源归属与近似去重。不含行投影、发布 seam、
// 回执与 request 认领（那些在 shared-submit.ts 的事务内核）。
// submit-question.ts 的 facade 层复用本模块实现；工具/任务经 facade 再出口，
// 不新增 capability→server 边。
// ====================================================================

import { and, desc, eq, ne, or, sql } from 'drizzle-orm';
import {
  DEDUP_OVERLAP_THRESHOLD,
  maxNgramOverlap,
  runQuestionAdmissionChecks,
} from '@/capabilities/practice/public';
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
import type { QuestionDraftDocumentT } from '@/core/schema/question-draft';
import type { Db, Tx } from '@/db/client';
import { question, question_group_lifecycle, type question_revision } from '@/db/schema';
import type { PublishAdmission } from '@/kernel/records/assessment-publication';
import {
  type DraftContract,
  draftDocumentToContract,
  revisionToDraftDocument,
  scoringRoundTripIsFaithful,
} from '@/kernel/records/question-draft-contract';
import type { SubmitResult, SubmitUnitOutcome } from '@/server/questions/submit-question';

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

export const SOURCE_KIND_TO_QUESTION_SOURCE: Record<string, string> = {
  generated: 'quiz_gen',
  adapted: 'adapted',
  owner_material: 'manual',
  photo_ingest: 'photo_ingest',
  jyeoo_fetch: 'web_sourced',
  sourcing_web: 'web_sourced',
  manual: 'manual',
};

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

export function draftCarriesFigure(doc: QuestionDraftDocumentT): boolean {
  return doc.materials.some((material) => material.kind === 'figure');
}

export type ScoringRevision = Pick<
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
export function conversionWithheld(contract: DraftContract, requestId: string): SubmitResult {
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

export function storedScoringCopied(revision: ScoringRevision, contract: DraftContract): boolean {
  return (
    canonicalJson(revision.response_spec) === canonicalJson(contract.response_spec) &&
    canonicalJson(revision.scoring_basis) === canonicalJson(contract.scoring_basis) &&
    canonicalJson(revision.execution_plan) === canonicalJson(contract.execution_plan)
  );
}

export function admissionForContentEdit(
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
export function scoringLayersUnchanged(
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
export function contractBarrierIssues(
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

export function presentationForDraft(
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

export async function attributableSourceIssue(
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

export function nearDupComparableText(
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

export async function nearDuplicateInKnowledge(
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
