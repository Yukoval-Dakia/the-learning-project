/**
 * Background annotation backfill owner (YUK-1994 slice 3).
 *
 * A question enters the item bank even when attribution or annotation failed; this
 * single owner repairs both labels later:
 *   - knowledge: re-runs the same match-or-propose attribution the enroll path uses,
 *     and flips `ingestion_enrollment.knowledge` to `attributed` on success;
 *   - solution: generates the method annotation and flips `solution` to `annotated`.
 *
 * Retry contract: each paid call counts one bounded attempt on the question
 * metadata (`knowledge_attempts` / `solution_attempts`), and only model-output or
 * permanent failures consume it — a failure the provider-failure verdict names as
 * a provably unbilled refusal (5xx, 429, not-sent, etc.) is counted separately in
 * `*_infra_failures`, never against the model budget, and is retried on a later
 * sweep. Infra failures have their own cap so a permanently broken lane cannot
 * send forever; every resend is provably unbilled, so nothing can spend without
 * bound. A paid call that loses its CAS write still cost money — the counter is
 * merged back in a one-shot second write.
 *
 * Sweep scope: only questions enrolled after this marker existed
 * (`ingestion_enrollment.solution` present) and not `draft_status='draft'` are
 * selected. Historical pre-slice-3 inventory is deliberately NOT swept — that
 * backfill is a separate explicit action through `questionIds`, never the cron.
 *
 * Restricted usage policy (`answer_only`/`crisis`) skips the paid phases without
 * consuming attempts and re-evaluates every sweep so a consent change applies.
 * The task is text-only, so a question whose prompt cannot stand without its
 * figure is marked `solution: 'skipped'` rather than annotated from partial text.
 *
 * Triggers: (a) the auto_enroll job enqueues the just-enrolled question ids; (b) a
 * cron sweep picks up anything the immediate enqueue lost (worker crash, failed
 * send). Both call this function; the sweep is the durable owner.
 */
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { providerTransientVerdict } from '@/ai/provider-failure';
import { readStoredSolutionAnnotation } from '@/core/schema/solution-annotation';
import type { Db } from '@/db/client';
import { notDraftPredicate } from '@/db/predicates';
import { knowledge, learning_session, question, question_block } from '@/db/schema';
import {
  resolveDocumentDerivationPolicy,
  resolveSessionDerivationPolicy,
} from '@/kernel/read-models/usage-policy';
import {
  type AttributeIngestionKnowledgeParams,
  attributeIngestionKnowledge,
} from './knowledge-attribution';
import {
  type GenerateSolutionAnnotationParams,
  SolutionAnnotationPolicyError,
  generateSolutionAnnotation,
} from './solution-annotation';

export const ANNOTATION_MAX_ATTEMPTS = 3;
/**
 * Provider-refusal retries per phase. Verdict classes are provably unbilled, so
 * this caps futile sends, not spend; twelve sweeps is ~3h of a down lane.
 */
export const ANNOTATION_MAX_INFRA_FAILURES = 12;
export const ANNOTATION_MAX_PER_RUN = 10;
/**
 * A prompt shorter than this plus an attached figure cannot carry the question:
 * the figure is load-bearing and a text-only annotation would pretend otherwise.
 */
const FIGURE_DEPENDENT_PROMPT_MAX_CHARS = 30;

const ERROR_MAX_CHARS = 300;
/** Marker value for phases a restricted usage policy forbids (transient reason). */
const POLICY_BLOCKED_ERROR = 'usage_policy_restricted';
/** Marker on a paid call whose CAS write lost; the attempt was still billed. */
const PAID_CALL_LOST_WRITE_ERROR = 'write_contended_after_paid_call';

interface EnrollmentMetadata {
  knowledge?: 'attributed' | 'missing';
  solution?: 'annotated' | 'missing' | 'skipped';
  knowledge_attempts?: number;
  solution_attempts?: number;
  knowledge_infra_failures?: number;
  solution_infra_failures?: number;
  knowledge_last_error?: string | null;
  solution_last_error?: string | null;
  solution_skipped_reason?: string;
  [key: string]: unknown;
}

export interface RunAnnotationBackfillParams {
  db: Db;
  /** Immediate post-enroll batch, or an explicit legacy backfill; omit for the global sweep. */
  questionIds?: string[];
  limit?: number;
  /** Test seams. Production omits them and uses the real attribution/annotation. */
  attributeFn?: (params: AttributeIngestionKnowledgeParams) => Promise<{ knowledgeIds: string[] }>;
  annotateFn?: (params: GenerateSolutionAnnotationParams) => Promise<unknown>;
  providerAttempt?: AttributeIngestionKnowledgeParams['providerAttempt'];
  now?: Date;
}

export interface AnnotationBackfillResult {
  scanned: number;
  knowledge_filled: number;
  /** Marker repaired from an already non-empty knowledge_ids; no model call. */
  knowledge_repaired: number;
  knowledge_failed: number;
  solution_filled: number;
  solution_failed: number;
  /** Rows whose derivation policy currently forbids model use (re-evaluated per run). */
  policy_blocked: number;
  /** Provider-refusal failures that did not consume the paid attempt budget. */
  infra_failures: number;
  /** Rows whose remaining phases are all at the attempt cap. */
  exhausted: number;
}

interface QuestionRow {
  id: string;
  version: number;
  prompt_md: string;
  kind: string;
  knowledge_ids: string[];
  metadata: Record<string, unknown> | null;
  draft_status: string | null;
  figures: unknown[] | null;
  embed_source_revision: number | null;
}

/** Where the question's ingest context lives; needed for hint, session, and policy. */
interface QuestionOrigin {
  sessionId: string | null;
  knowledgeHint: string | null;
  sourceDocumentId: string | null;
}

export async function runAnnotationBackfill(
  params: RunAnnotationBackfillParams,
): Promise<AnnotationBackfillResult> {
  const limit = Math.max(1, Math.trunc(params.limit ?? ANNOTATION_MAX_PER_RUN));
  const attributeFn = params.attributeFn ?? attributeIngestionKnowledge;
  const annotateFn = params.annotateFn ?? generateSolutionAnnotation;

  const selected = await params.db
    .select({
      id: question.id,
      version: question.version,
      prompt_md: question.prompt_md,
      kind: question.kind,
      knowledge_ids: question.knowledge_ids,
      metadata: question.metadata,
      draft_status: question.draft_status,
      figures: question.figures,
      embed_source_revision: question.embed_source_revision,
    })
    .from(question)
    .where(
      params.questionIds !== undefined
        ? inArray(question.id, params.questionIds)
        : sweepPredicate(),
    )
    .orderBy(asc(question.created_at), asc(question.id))
    .limit(limit);

  const result: AnnotationBackfillResult = {
    scanned: selected.length,
    knowledge_filled: 0,
    knowledge_repaired: 0,
    knowledge_failed: 0,
    solution_filled: 0,
    solution_failed: 0,
    policy_blocked: 0,
    infra_failures: 0,
    exhausted: 0,
  };

  for (const row of selected) {
    const now = params.now ?? new Date();
    let current: QuestionRow = row;
    let metadata = readMetadata(current.metadata);
    // Only ingestion-enrolled questions carry the repair markers. An explicit-id
    // payload must not annotate arbitrary bank rows.
    if (!('ingestion_enrollment' in metadata)) continue;
    let enrollment: EnrollmentMetadata = {
      ...readRecord(metadata.ingestion_enrollment),
    };
    // A draft question has no usable prompt yet; edits that activate it let the
    // next sweep retry — skipping without a mark keeps that path open.
    if (current.draft_status === 'draft') continue;

    /**
     * Metadata-only repair write. `embed_source_revision` rides forward with the
     * version bump when it was current: the embed source columns (prompt_md /
     * reference_md / choices_md) are untouched by this writer, so the stored
     * vector stays computed-from-this-revision and vector retrieval, ingest dedup
     * and the quiz pool must not drop the row. A stale or NULL revision keeps its
     * provenance — a stale vector is never re-blessed by metadata churn.
     */
    const write = async (patch: {
      enrollment: EnrollmentMetadata;
      knowledgeIds?: string[];
      solution?: unknown;
    }): Promise<boolean> => {
      const nextMetadata: Record<string, unknown> = {
        ...metadata,
        ingestion_enrollment: patch.enrollment,
        ...(patch.solution !== undefined ? { solution_annotation: patch.solution } : {}),
      };
      const nextVersion = current.version + 1;
      const written = await params.db
        .update(question)
        .set({
          metadata: nextMetadata,
          ...(patch.knowledgeIds !== undefined ? { knowledge_ids: patch.knowledgeIds } : {}),
          version: nextVersion,
          ...(current.embed_source_revision === current.version
            ? { embed_source_revision: nextVersion }
            : {}),
          updated_at: now,
        })
        .where(and(eq(question.id, current.id), eq(question.version, current.version)))
        .returning({ id: question.id });
      if (written.length !== 1) return false; // a concurrent editor won; next sweep re-reads
      metadata = nextMetadata;
      enrollment = patch.enrollment;
      current = {
        ...current,
        version: nextVersion,
        embed_source_revision:
          current.embed_source_revision === current.version
            ? nextVersion
            : current.embed_source_revision,
        knowledge_ids: patch.knowledgeIds ?? current.knowledge_ids,
      };
      return true;
    };

    /**
     * A paid call that lost its CAS is still a paid call: merge `attempts + 1`
     * into the winning row once so contention cannot launder unbounded retries.
     * A second loss (two concurrent writers landing the same revision again) is
     * the documented tail — one uncounted paid call per doubly-lost CAS.
     */
    const countPaidAttemptAfterCasLoss = async (phase: 'knowledge' | 'solution'): Promise<void> => {
      const key = phase === 'knowledge' ? 'knowledge_attempts' : 'solution_attempts';
      const errorKey = phase === 'knowledge' ? 'knowledge_last_error' : 'solution_last_error';
      const [fresh] = await params.db
        .select({
          version: question.version,
          metadata: question.metadata,
          embed_source_revision: question.embed_source_revision,
        })
        .from(question)
        .where(eq(question.id, current.id))
        .limit(1);
      if (!fresh) return;
      const freshMetadata = readMetadata(fresh.metadata);
      const freshEnrollment: EnrollmentMetadata = {
        ...readRecord(freshMetadata.ingestion_enrollment),
      };
      const nextVersion = fresh.version + 1;
      const written = await params.db
        .update(question)
        .set({
          metadata: {
            ...freshMetadata,
            ingestion_enrollment: {
              ...freshEnrollment,
              [key]: (freshEnrollment[key] ?? 0) + 1,
              [errorKey]: PAID_CALL_LOST_WRITE_ERROR,
            },
          },
          version: nextVersion,
          ...(fresh.embed_source_revision === fresh.version
            ? { embed_source_revision: nextVersion }
            : {}),
          updated_at: now,
        })
        .where(and(eq(question.id, current.id), eq(question.version, fresh.version)))
        .returning({ id: question.id });
      if (written.length !== 1) {
        console.warn(
          `[annotation_backfill] ${phase} attempt counter lost twice on ${current.id}; bound: one uncounted paid call`,
        );
      }
      // Keep the local view honest even when the merge won on a different version.
      const [reread] = await params.db
        .select({
          version: question.version,
          metadata: question.metadata,
          embed_source_revision: question.embed_source_revision,
        })
        .from(question)
        .where(eq(question.id, current.id))
        .limit(1);
      if (reread) {
        current = {
          ...current,
          version: reread.version,
          embed_source_revision: reread.embed_source_revision,
        };
        metadata = readMetadata(reread.metadata);
        enrollment = { ...readRecord(metadata.ingestion_enrollment) };
      }
    };

    // The origin block owns the ingest context: knowledge hint, bound session and
    // (through it) the source document and its live derivation policy.
    const origin = await readQuestionOrigin(params.db, current.id, metadata);
    const derivationPolicy = origin.sessionId
      ? await resolveSessionDerivationPolicy(params.db, origin.sessionId)
      : origin.sourceDocumentId
        ? await resolveDocumentDerivationPolicy(params.db, origin.sourceDocumentId)
        : 'allow';
    const policyRestricted = derivationPolicy !== 'allow';
    if (policyRestricted) result.policy_blocked += 1;

    /**
     * Attempt accounting shared by both phases: a verdict-named provider refusal
     * bills nothing and keeps the paid budget; anything else consumes one
     * attempt. Policy blocks mark the transient reason without any send.
     */
    const markFailure = async (input: {
      phase: 'knowledge' | 'solution';
      err: unknown;
    }): Promise<void> => {
      const errText = errorText(input.err);
      if (input.err instanceof SolutionAnnotationPolicyError) {
        await write({
          enrollment: { ...enrollment, [`${input.phase}_last_error`]: POLICY_BLOCKED_ERROR },
        });
        return;
      }
      const verdict = transientVerdict(input.err);
      if (verdict !== undefined) {
        result.infra_failures += 1;
        await write({
          enrollment: {
            ...enrollment,
            [`${input.phase}_infra_failures`]:
              readCount(enrollment[`${input.phase}_infra_failures`]) + 1,
            [`${input.phase}_last_error`]: `provider:${verdict.class} ${errText}`.slice(
              0,
              ERROR_MAX_CHARS,
            ),
          },
        });
        return;
      }
      await write({
        enrollment: {
          ...enrollment,
          [`${input.phase}_attempts`]: readCount(enrollment[`${input.phase}_attempts`]) + 1,
          [`${input.phase}_last_error`]: errText,
        },
      });
    };

    const phaseRetryable = (phase: 'knowledge' | 'solution'): boolean =>
      readCount(enrollment[`${phase}_attempts`]) < ANNOTATION_MAX_ATTEMPTS &&
      readCount(enrollment[`${phase}_infra_failures`]) < ANNOTATION_MAX_INFRA_FAILURES;

    // ---- knowledge phase -------------------------------------------------
    if (enrollment.knowledge !== 'attributed') {
      if (current.knowledge_ids.length > 0) {
        if (await write({ enrollment: { ...enrollment, knowledge: 'attributed' } })) {
          result.knowledge_repaired += 1;
        }
      } else if (!policyRestricted && phaseRetryable('knowledge')) {
        try {
          const attributed = await attributeFn({
            db: params.db,
            questionMd: current.prompt_md,
            knowledgeHint: origin.knowledgeHint,
            providerAttempt: params.providerAttempt,
            sessionId: origin.sessionId,
            sourceRef: { kind: 'question', id: current.id },
            ctx: { db: params.db },
          });
          if (attributed.knowledgeIds.length === 0) {
            throw new Error('attribution returned no knowledge id');
          }
          if (
            await write({
              enrollment: {
                ...enrollment,
                knowledge: 'attributed',
                knowledge_attempts: (enrollment.knowledge_attempts ?? 0) + 1,
                knowledge_last_error: null,
              },
              knowledgeIds: attributed.knowledgeIds,
            })
          ) {
            result.knowledge_filled += 1;
          } else {
            await countPaidAttemptAfterCasLoss('knowledge');
          }
        } catch (err) {
          await markFailure({ phase: 'knowledge', err });
          result.knowledge_failed += 1;
        }
      } else if (policyRestricted && enrollment.knowledge_last_error !== POLICY_BLOCKED_ERROR) {
        await write({
          enrollment: { ...enrollment, knowledge_last_error: POLICY_BLOCKED_ERROR },
        });
      }
    }

    // ---- solution phase --------------------------------------------------
    const alreadyAnnotated = readStoredSolutionAnnotation(metadata.solution_annotation) !== null;
    if (alreadyAnnotated) {
      if (enrollment.solution !== 'annotated') {
        await write({ enrollment: { ...enrollment, solution: 'annotated' } });
      }
    } else if (enrollment.solution === 'skipped') {
      // Terminal honest state; nothing to do.
    } else if (policyRestricted) {
      if (enrollment.solution_last_error !== POLICY_BLOCKED_ERROR) {
        await write({
          enrollment: { ...enrollment, solution_last_error: POLICY_BLOCKED_ERROR },
        });
      }
    } else if (isFigureDependent(current)) {
      // The task is text-only; a figure-dependent prompt would be annotated from
      // text that cannot carry the question. 'skipped' is the honest terminal.
      await write({
        enrollment: {
          ...enrollment,
          solution: 'skipped',
          solution_skipped_reason: 'figure_dependent',
          solution_last_error: null,
        },
      });
    } else if (phaseRetryable('solution')) {
      try {
        const knowledgeLabel = await readKnowledgeLabel(params.db, current.knowledge_ids);
        const annotation = await annotateFn({
          db: params.db,
          promptMd: current.prompt_md,
          kind: current.kind,
          knowledgeLabel,
          usage: { sessionId: origin.sessionId, sourceDocumentId: origin.sourceDocumentId },
        });
        if (
          await write({
            enrollment: {
              ...enrollment,
              solution: 'annotated',
              solution_attempts: (enrollment.solution_attempts ?? 0) + 1,
              solution_last_error: null,
            },
            solution: annotation,
          })
        ) {
          result.solution_filled += 1;
        } else {
          await countPaidAttemptAfterCasLoss('solution');
        }
      } catch (err) {
        await markFailure({ phase: 'solution', err });
        result.solution_failed += 1;
      }
    }

    // A row is exhausted when a still-missing label has burned its attempt budget.
    const knowledgeDone = enrollment.knowledge === 'attributed' || current.knowledge_ids.length > 0;
    const solutionDone =
      readStoredSolutionAnnotation(metadata.solution_annotation) !== null ||
      enrollment.solution === 'skipped';
    if (
      (!knowledgeDone && !phaseRetryable('knowledge')) ||
      (!solutionDone && !policyRestricted && !phaseRetryable('solution'))
    ) {
      result.exhausted += 1;
    }
  }

  return result;
}

/**
 * Only the post-slice-3 marker makes a row eligible for the paid sweep: the
 * `solution` key did not exist on earlier `ingestion_enrollment` writes, so
 * `? 'solution'` is exactly "enrolled after the marker shipped". Historical
 * rows are reached only by an explicit `questionIds` run — never the cron.
 */
function sweepPredicate() {
  const enrollment = sql`${question.metadata}->'ingestion_enrollment'`;
  const knowledgeAttempts = sql`(case when jsonb_typeof(${enrollment}->'knowledge_attempts') = 'number' then (${enrollment}->>'knowledge_attempts')::int else 0 end)`;
  const solutionAttempts = sql`(case when jsonb_typeof(${enrollment}->'solution_attempts') = 'number' then (${enrollment}->>'solution_attempts')::int else 0 end)`;
  const knowledgeInfra = sql`(case when jsonb_typeof(${enrollment}->'knowledge_infra_failures') = 'number' then (${enrollment}->>'knowledge_infra_failures')::int else 0 end)`;
  const solutionInfra = sql`(case when jsonb_typeof(${enrollment}->'solution_infra_failures') = 'number' then (${enrollment}->>'solution_infra_failures')::int else 0 end)`;
  return and(
    sql`${question.metadata} ? 'ingestion_enrollment'`,
    sql`${enrollment} ? 'solution'`,
    notDraftPredicate(question.draft_status),
    sql`(
      (${enrollment}->>'knowledge' = 'missing'
        and (jsonb_array_length(${question.knowledge_ids}) > 0
          or (${knowledgeAttempts} < ${ANNOTATION_MAX_ATTEMPTS}
            and ${knowledgeInfra} < ${ANNOTATION_MAX_INFRA_FAILURES})))
      or (coalesce(${enrollment}->>'solution', 'missing') = 'missing'
        and ${solutionAttempts} < ${ANNOTATION_MAX_ATTEMPTS}
        and ${solutionInfra} < ${ANNOTATION_MAX_INFRA_FAILURES})
    )`,
  );
}

/**
 * The ingest context the paid phases need: the block's knowledge hint, the bound
 * session, and through it the source document. `metadata.question_block_id` is
 * stamped by the capture path; `imported_question_id` is the link on rows whose
 * metadata predates or lost that key.
 */
async function readQuestionOrigin(
  db: Db,
  questionId: string,
  metadata: Record<string, unknown>,
): Promise<QuestionOrigin> {
  const blockId =
    typeof metadata.question_block_id === 'string' ? metadata.question_block_id : null;
  const [origin] = await db
    .select({
      sessionId: question_block.ingestion_session_id,
      knowledgeHint: question_block.knowledge_hint,
      sourceDocumentId: learning_session.source_document_id,
    })
    .from(question_block)
    .leftJoin(learning_session, eq(learning_session.id, question_block.ingestion_session_id))
    .where(
      blockId !== null
        ? or(eq(question_block.id, blockId), eq(question_block.imported_question_id, questionId))
        : eq(question_block.imported_question_id, questionId),
    )
    .orderBy(asc(question_block.id))
    .limit(1);
  if (origin) {
    return {
      sessionId: origin.sessionId,
      knowledgeHint: origin.knowledgeHint,
      sourceDocumentId: origin.sourceDocumentId,
    };
  }
  // Metadata-only fallback for rows with no resolvable block (e.g. a deleted
  // block): the session/document ids stamped at capture still bind policy.
  const sessionId =
    typeof metadata.ingestion_session_id === 'string' ? metadata.ingestion_session_id : null;
  let sourceDocumentId =
    typeof metadata.source_document_id === 'string' ? metadata.source_document_id : null;
  if (sessionId !== null && sourceDocumentId === null) {
    const [session] = await db
      .select({ source_document_id: learning_session.source_document_id })
      .from(learning_session)
      .where(eq(learning_session.id, sessionId))
      .limit(1);
    sourceDocumentId = session?.source_document_id ?? null;
  }
  return { sessionId, knowledgeHint: null, sourceDocumentId };
}

/** A verdict-named provider refusal — the provably unbilled class — or undefined. */
function transientVerdict(err: unknown) {
  let cur: unknown = err;
  for (let depth = 0; depth < 3 && cur != null; depth += 1) {
    const verdict = providerTransientVerdict({ error: cur });
    if (verdict !== undefined) return verdict;
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return undefined;
}

function isFigureDependent(row: QuestionRow): boolean {
  return (
    row.prompt_md.trim().length < FIGURE_DEPENDENT_PROMPT_MAX_CHARS &&
    Array.isArray(row.figures) &&
    row.figures.length > 0
  );
}

function readMetadata(raw: Record<string, unknown> | null): Record<string, unknown> {
  return raw != null && typeof raw === 'object' ? { ...raw } : {};
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function readKnowledgeLabel(db: Db, knowledgeIds: string[]): Promise<string | null> {
  if (knowledgeIds.length === 0) return null;
  const [row] = await db
    .select({ name: knowledge.name })
    .from(knowledge)
    .where(inArray(knowledge.id, knowledgeIds))
    .limit(1);
  return row?.name ?? null;
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, ERROR_MAX_CHARS);
}
