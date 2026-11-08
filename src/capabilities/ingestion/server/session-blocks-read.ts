// GET /api/ingestion/[id]/blocks
//
// Returns the session's question_block rows for the review/import UI, including the
// stored judge confidence and a tolerant projection of the auto-enroll observation
// when present.

import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { MistakeEnrollOutcome } from '@/core/schema/mistake_enroll';
import type { StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { event, knowledge, question, question_block } from '@/db/schema';
import { learnerVisibleKnowledgeIds } from '@/kernel/read-models/learner-knowledge-visibility';
import { readWorkflowJudgeConfidence } from '@/kernel/read-models/workflow-judge-confidence';
import { readRevertedBlockIds } from './block-revert-state';
import { blockHasPrompt } from './capture/question-text';

export async function readIngestionSessionBlocks(db: Db, params: { id: string }) {
  const sessionId = params.id;
  const rows = await db
    .select({
      id: question_block.id,
      version: question_block.version,
      ingestion_session_id: question_block.ingestion_session_id,
      source_asset_ids: question_block.source_asset_ids,
      page_spans: question_block.page_spans,
      extracted_prompt_md: question_block.extracted_prompt_md,
      structured: question_block.structured,
      reference_md: question_block.reference_md,
      wrong_answer_md: question_block.wrong_answer_md,
      image_refs: question_block.image_refs,
      figures: question_block.figures,
      layout_quality: question_block.layout_quality,
      extraction_confidence: question_block.extraction_confidence,
      status: question_block.status,
      knowledge_hint: question_block.knowledge_hint,
      imported_question_id: question_block.imported_question_id,
      imported_attempt_event_id: question_block.imported_attempt_event_id,
      created_at: question_block.created_at,
    })
    .from(question_block)
    .where(eq(question_block.ingestion_session_id, sessionId))
    // Reading order is the session ordinal; id tiebreaks historical collisions.
    .orderBy(asc(question_block.ordinal), asc(question_block.id));

  const blockIds = rows.map((r) => r.id);
  const enrollmentInFlight = await hasInflightAutoEnroll(db, sessionId);
  const revertedBlockIds = await readRevertedBlockIds(db, blockIds);
  const observations =
    blockIds.length === 0
      ? []
      : await db
          .select({
            id: event.id,
            subject_id: event.subject_id,
            outcome: event.outcome,
            payload: event.payload,
            created_at: event.created_at,
          })
          .from(event)
          .where(
            and(
              eq(event.action, 'experimental:auto_enroll_observed'),
              eq(event.subject_kind, 'question_block'),
              inArray(event.subject_id, blockIds),
            ),
          )
          .orderBy(asc(event.created_at));
  const observationByBlockId = new Map<string, (typeof observations)[number]>();
  for (const obs of observations) observationByBlockId.set(obs.subject_id, obs);

  // The judge confidence is stored on the enrolled question's metadata. Read it
  // back per block so the review surface can show the honest "把握不高" signal.
  const importedQuestionIds = [
    ...new Set(rows.map((r) => r.imported_question_id).filter((id): id is string => id !== null)),
  ];
  const judgeConfidenceByQuestionId = new Map<string, number | null>();
  const questionById = new Map<
    string,
    {
      draft_status: string | null;
      metadata: Record<string, unknown> | null;
      knowledge_ids: string[];
    }
  >();
  if (importedQuestionIds.length > 0) {
    const questionRows = await db
      .select({
        id: question.id,
        metadata: question.metadata,
        draft_status: question.draft_status,
        knowledge_ids: question.knowledge_ids,
      })
      .from(question)
      .where(inArray(question.id, importedQuestionIds));
    for (const row of questionRows) {
      judgeConfidenceByQuestionId.set(row.id, readWorkflowJudgeConfidence(row.metadata));
      questionById.set(row.id, {
        draft_status: row.draft_status,
        metadata: row.metadata,
        knowledge_ids: row.knowledge_ids ?? [],
      });
    }
  }
  const knowledgeNames = await loadKnowledgeNames(db, questionById);

  return {
    rows: rows.map((r) => {
      const observation = observationByBlockId.get(r.id);
      const projectedObservation = observation ? toAutoEnrollObservation(observation) : null;
      const recordedConfidence = r.imported_question_id
        ? (judgeConfidenceByQuestionId.get(r.imported_question_id) ?? null)
        : null;
      return {
        ...r,
        created_at: Math.floor(r.created_at.getTime() / 1000),
        workflow_judge_confidence: recordedConfidence ?? projectedObservation?.confidence ?? null,
        auto_enroll_observation: projectedObservation,
        ingestion_enrollment: toEnrollmentProjection(
          r,
          r.imported_question_id !== null ? questionById.get(r.imported_question_id) : undefined,
          enrollmentInFlight,
          revertedBlockIds.has(r.id),
          knowledgeNames,
        ),
      };
    }),
  };
}

/**
 * True while the session still has a queued/running auto_enroll delivery. pgboss.job is
 * pg-boss owned; to_regclass keeps this honest on databases that never reached it. A
 * missing/in-flight job is the only "waiting" signal — anything else means the session's
 * enrollment has finished and a still-draft block is a failure.
 */
export async function hasInflightAutoEnroll(db: Db, sessionId: string): Promise<boolean> {
  const probe = await db.execute<{ reg: string | null }>(
    sql`select to_regclass('pgboss.job') as reg`,
  );
  if (probe[0]?.reg == null) return false;
  const rows = await db.execute<{ one: number }>(sql`
    select 1 as one from pgboss.job
    where name = 'auto_enroll'
      and state in ('created','retry','active')
      and data->>'sessionId' = ${sessionId}
    limit 1
  `);
  return rows.length > 0;
}

/** How to read one block's enrollment without re-implementing the server gates. */
function toEnrollmentProjection(
  block: {
    status: string;
    extracted_prompt_md: string | null;
    structured: StructuredQuestionT | null;
  },
  enrolled:
    | {
        draft_status: string | null;
        metadata: Record<string, unknown> | null;
        knowledge_ids: string[];
      }
    | undefined,
  enrollmentInFlight: boolean,
  reverted: boolean,
  knowledgeNames: Map<string, string>,
) {
  // The block status is the ground truth about what happened to this capture:
  // imported/submitted/auto_enrolled all carry a question, ignored was an explicit
  // learner choice, and only draft means "not in the library (yet)".
  if (block.status === 'ignored') {
    return {
      state: 'ignored' as const,
      reason: null,
      knowledge: null,
      knowledge_ids: [] as string[],
      knowledge_labels: [] as Array<{ id: string; name: string }>,
      library_visible: false,
    };
  }
  if (block.status !== 'draft') {
    const markers = enrolled?.metadata?.ingestion_enrollment as { knowledge?: unknown } | undefined;
    // Synthetic ids (pending proposals, system nodes) are never learner-visible;
    // the read must not leak them as labels either.
    const knowledgeIds = learnerVisibleKnowledgeIds(enrolled?.knowledge_ids ?? []);
    return {
      state: 'in_library' as const,
      reason: null,
      knowledge:
        markers?.knowledge === 'attributed' ||
        markers?.knowledge === 'missing' ||
        markers?.knowledge === 'restricted'
          ? markers.knowledge
          : null,
      knowledge_ids: knowledgeIds,
      knowledge_labels: knowledgeIds.map((id) => ({
        id,
        name: knowledgeNames.get(id) ?? id,
      })),
      library_visible: enrolled ? enrolled.draft_status !== 'draft' : null,
    };
  }
  // Enrollment is automatic. A draft block with a prompt is still waiting while its
  // session has a queued/running auto_enroll delivery; once that has finished, the same
  // row is a failure. A block with no printed prompt never had anything to publish.
  if (reverted) {
    // A learner-reverted block is intentionally out of the library; it is not a failed
    // publication and the automatic worker will not touch it again.
    return {
      state: 'not_enrolled' as const,
      reason: 'reverted' as const,
      knowledge: null,
      knowledge_ids: [] as string[],
      knowledge_labels: [] as Array<{ id: string; name: string }>,
      library_visible: null,
    };
  }
  return {
    state: 'not_enrolled' as const,
    reason: blockHasPrompt(block)
      ? enrollmentInFlight
        ? ('pending' as const)
        : ('publish_failed' as const)
      : ('needs_text' as const),
    knowledge: null,
    knowledge_ids: [] as string[],
    knowledge_labels: [] as Array<{ id: string; name: string }>,
    library_visible: null,
  };
}

function toAutoEnrollObservation(row: {
  id: string;
  outcome: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}) {
  const payload = row.payload;
  return {
    event_id: row.id,
    outcome: row.outcome,
    mode: stringOrNull(payload.mode),
    route: stringOrNull(payload.route),
    confidence: numberOrNull(payload.confidence),
    threshold: numberOrNull(payload.threshold),
    // Only the TaggingTask observes a candidate grid, so only derive-mode events
    // carry this. Enroll-mode blocks have no grid to truncate.
    grid_truncated: booleanOrNull(payload.grid_truncated),
    reasoning: stringOrNull(payload.reasoning),
    suggested_knowledge_ids: learnerVisibleKnowledgeIds(
      stringArray(payload.suggested_knowledge_ids),
    ),
    mistake_draft: toMistakeDraft(payload.mistake_draft),
    observed_at: row.created_at.toISOString(),
  };
}

// Tolerant projection of payload.mistake_draft (the judge's raw MistakeEnrollOutput,
// written by the observe path in auto-enroll). We deliberately do NOT safeParse the
// full MistakeEnrollOutput schema and null-on-any-mismatch — a strict parse would
// reject a historical event that predates a field and silently drop a draft that is
// "valid enough" for prefill. Instead we project only the fields prefill needs and
// guard each defensively, so a partial event keeps its present fields (absent ones
// fall to null / today's defaults downstream).
// Derive the accepted set from the canonical MistakeEnrollOutcome enum so a future
// added outcome can never be silently projected to null by a stale hand-kept list
// (compile-time sync with mistake_enroll.ts). z.enum exposes `.options`.
const WRONG_ANSWER_VALUES = MistakeEnrollOutcome.options;
type WrongAnswer = (typeof WRONG_ANSWER_VALUES)[number];

function toMistakeDraft(value: unknown): {
  wrong_answer: WrongAnswer | null;
  difficulty: number | null;
  cause: { primary_category: string | null; analysis_md: string | null } | null;
} | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const draft = value as Record<string, unknown>;
  return {
    wrong_answer: wrongAnswerOrNull(draft.wrong_answer),
    difficulty: numberOrNull(draft.difficulty),
    cause: toMistakeDraftCause(draft.cause),
  };
}

function toMistakeDraftCause(
  value: unknown,
): { primary_category: string | null; analysis_md: string | null } | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const cause = value as Record<string, unknown>;
  // analysis_md is the human-readable cause text the judge produced; prefill
  // maps it to cause_notes (NOT a nonexistent cause.user_notes).
  return {
    primary_category: stringOrNull(cause.primary_category),
    analysis_md: stringOrNull(cause.analysis_md),
  };
}

function wrongAnswerOrNull(value: unknown): WrongAnswer | null {
  return typeof value === 'string' && (WRONG_ANSWER_VALUES as readonly string[]).includes(value)
    ? (value as WrongAnswer)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * One batched name lookup for every enrolled question's attributed KCs, so the block
 * read can label the knowledge point without an N+1 query. Missing/archived nodes fall
 * back to their id at the call site.
 */
async function loadKnowledgeNames(
  db: Db,
  questionById: Map<string, { knowledge_ids: string[] }>,
): Promise<Map<string, string>> {
  const ids = [...new Set([...questionById.values()].flatMap((row) => row.knowledge_ids))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name })
    .from(knowledge)
    .where(inArray(knowledge.id, ids));
  return new Map(rows.map((row) => [row.id, row.name]));
}
