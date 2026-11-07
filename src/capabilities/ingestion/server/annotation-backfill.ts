/**
 * Background annotation backfill owner (YUK-1994 slice 3).
 *
 * A question enters the item bank even when attribution or annotation failed; this
 * single owner repairs both labels later:
 *   - knowledge: re-runs the same match-or-propose attribution the enroll path uses,
 *     and flips `ingestion_enrollment.knowledge` to `attributed` on success;
 *   - solution: generates the method annotation and flips `solution` to `annotated`.
 *
 * Retry contract: each phase counts a bounded number of paid attempts on the question
 * metadata (`knowledge_attempts` / `solution_attempts`). The sweep never selects a
 * phase at its cap, so a permanently failing row stops costing money and stays visibly
 * `missing`. A single row's failure never aborts the batch.
 *
 * Triggers: (a) the auto_enroll job enqueues the just-enrolled question ids; (b) a
 * cron sweep picks up anything the immediate enqueue lost (worker crash, failed send).
 * Both call this function; the sweep is the durable owner.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { readStoredSolutionAnnotation } from '@/core/schema/solution-annotation';
import type { Db } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import {
  type AttributeIngestionKnowledgeParams,
  attributeIngestionKnowledge,
} from './knowledge-attribution';
import {
  type GenerateSolutionAnnotationParams,
  generateSolutionAnnotation,
} from './solution-annotation';

export const ANNOTATION_MAX_ATTEMPTS = 3;
export const ANNOTATION_MAX_PER_RUN = 10;

const ERROR_MAX_CHARS = 300;

interface EnrollmentMetadata {
  knowledge?: 'attributed' | 'missing';
  solution?: 'annotated' | 'missing';
  knowledge_attempts?: number;
  solution_attempts?: number;
  knowledge_last_error?: string | null;
  solution_last_error?: string | null;
  [key: string]: unknown;
}

export interface RunAnnotationBackfillParams {
  db: Db;
  /** Immediate post-enroll batch; omit for the global sweep. */
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
    exhausted: 0,
  };

  for (const row of selected) {
    const now = params.now ?? new Date();
    let current: QuestionRow = row;
    let metadata = readMetadata(current.metadata);
    let enrollment: EnrollmentMetadata = {
      ...readRecord(metadata.ingestion_enrollment),
    };

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
      const written = await params.db
        .update(question)
        .set({
          metadata: nextMetadata,
          ...(patch.knowledgeIds !== undefined ? { knowledge_ids: patch.knowledgeIds } : {}),
          version: current.version + 1,
          updated_at: now,
        })
        .where(and(eq(question.id, current.id), eq(question.version, current.version)))
        .returning({ id: question.id });
      if (written.length !== 1) return false; // a concurrent editor won; next sweep re-reads
      metadata = nextMetadata;
      enrollment = patch.enrollment;
      current = {
        ...current,
        version: current.version + 1,
        knowledge_ids: patch.knowledgeIds ?? current.knowledge_ids,
      };
      return true;
    };

    // ---- knowledge phase -------------------------------------------------
    if (enrollment.knowledge !== 'attributed') {
      if (current.knowledge_ids.length > 0) {
        if (await write({ enrollment: { ...enrollment, knowledge: 'attributed' } })) {
          result.knowledge_repaired += 1;
        }
      } else if ((enrollment.knowledge_attempts ?? 0) < ANNOTATION_MAX_ATTEMPTS) {
        try {
          const attributed = await attributeFn({
            db: params.db,
            questionMd: current.prompt_md,
            knowledgeHint: null,
            providerAttempt: params.providerAttempt,
            sessionId: readSessionId(metadata),
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
          }
        } catch (err) {
          const attempts = (enrollment.knowledge_attempts ?? 0) + 1;
          await write({
            enrollment: {
              ...enrollment,
              knowledge_attempts: attempts,
              knowledge_last_error: errorText(err),
            },
          });
          result.knowledge_failed += 1;
        }
      }
    }

    // ---- solution phase --------------------------------------------------
    const alreadyAnnotated = readStoredSolutionAnnotation(metadata.solution_annotation) !== null;
    if (alreadyAnnotated) {
      if (enrollment.solution !== 'annotated') {
        await write({ enrollment: { ...enrollment, solution: 'annotated' } });
      }
    } else if ((enrollment.solution_attempts ?? 0) < ANNOTATION_MAX_ATTEMPTS) {
      try {
        const knowledgeLabel = await readKnowledgeLabel(params.db, current.knowledge_ids);
        const annotation = await annotateFn({
          db: params.db,
          promptMd: current.prompt_md,
          kind: current.kind,
          knowledgeLabel,
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
        }
      } catch (err) {
        await write({
          enrollment: {
            ...enrollment,
            solution_attempts: (enrollment.solution_attempts ?? 0) + 1,
            solution_last_error: errorText(err),
          },
        });
        result.solution_failed += 1;
      }
    }

    // A row is exhausted when a still-missing label has burned its attempt budget.
    const knowledgeDone = enrollment.knowledge === 'attributed' || current.knowledge_ids.length > 0;
    const solutionDone = readStoredSolutionAnnotation(metadata.solution_annotation) !== null;
    if (
      (!knowledgeDone && (enrollment.knowledge_attempts ?? 0) >= ANNOTATION_MAX_ATTEMPTS) ||
      (!solutionDone && (enrollment.solution_attempts ?? 0) >= ANNOTATION_MAX_ATTEMPTS)
    ) {
      result.exhausted += 1;
    }
  }

  return result;
}

function sweepPredicate() {
  const enrollment = sql`${question.metadata}->'ingestion_enrollment'`;
  const knowledgeAttempts = sql`(case when jsonb_typeof(${enrollment}->'knowledge_attempts') = 'number' then (${enrollment}->>'knowledge_attempts')::int else 0 end)`;
  const solutionAttempts = sql`(case when jsonb_typeof(${enrollment}->'solution_attempts') = 'number' then (${enrollment}->>'solution_attempts')::int else 0 end)`;
  return and(
    sql`${question.metadata} ? 'ingestion_enrollment'`,
    sql`(
      (${enrollment}->>'knowledge' = 'missing'
        and (jsonb_array_length(${question.knowledge_ids}) > 0 or ${knowledgeAttempts} < ${ANNOTATION_MAX_ATTEMPTS}))
      or (coalesce(${enrollment}->>'solution', 'missing') <> 'annotated'
        and ${solutionAttempts} < ${ANNOTATION_MAX_ATTEMPTS})
    )`,
  );
}

function readMetadata(raw: Record<string, unknown> | null): Record<string, unknown> {
  return raw != null && typeof raw === 'object' ? { ...raw } : {};
}

function readRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readSessionId(metadata: Record<string, unknown>): string | null {
  const value = metadata.ingestion_session_id;
  return typeof value === 'string' ? value : null;
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
