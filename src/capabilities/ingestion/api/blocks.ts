// Phase 1c.2 Vision MVP — GET /api/ingestion/[id]/blocks
//
// Returns question_block rows attached to an ingestion session so the /record
// vision flow can list extracted candidates for the user to review + import.
//
// Wire shape (one row per block):
//   {
//     id,
//     ingestion_session_id,
//     source_asset_ids: string[],
//     page_spans: Array<{ page_index, bbox: {x,y,width,height}, role? }>,
//     extracted_prompt_md: string | null,
//     reference_md: string | null,
//     wrong_answer_md: string | null,
//     image_refs: string[],
//     figures: FigureRef[],
//     layout_quality: 'structured' | 'partial' | 'text_only',
//     extraction_confidence: number,
//     status: 'draft' | 'imported' | 'ignored' | 'auto_enrolled',
//     knowledge_hint: string | null,
//     imported_question_id: string | null,
//     imported_attempt_event_id: string | null,
//     auto_enroll_observation: {
//       event_id, outcome, mode, route, confidence, threshold, reasoning,
//       suggested_knowledge_ids, observed_at,
//       // mistake_draft is a tolerant projection of the judge's MistakeEnrollOutput
//       // (auto-enroll.ts:303 writes the raw output under payload.mistake_draft).
//       // Source field is `wrong_answer` (mistake_enroll.ts:39), NOT `outcome`.
//       mistake_draft: {
//         wrong_answer: 'failure' | 'partial' | 'success' | 'unanswered' | null,
//         difficulty: number | null,
//         cause: { primary_category, analysis_md } | null,
//       } | null,
//     } | null,
//     created_at: number, // unix sec
//   }

import { and, asc, eq, inArray } from 'drizzle-orm';

import { MistakeEnrollOutcome } from '@/core/schema/mistake_enroll';
import { db } from '@/db/client';
import { event, question_block } from '@/db/schema';
import { errorResponse } from '@/server/http/errors';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const sessionId = params.id;
    const rows = await db
      .select({
        id: question_block.id,
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
      .orderBy(asc(question_block.created_at));

    const blockIds = rows.map((r) => r.id);
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

    return Response.json({
      rows: rows.map((r) => {
        const observation = observationByBlockId.get(r.id);
        return {
          ...r,
          created_at: Math.floor(r.created_at.getTime() / 1000),
          auto_enroll_observation: observation ? toAutoEnrollObservation(observation) : null,
        };
      }),
    });
  } catch (err) {
    return errorResponse(err);
  }
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
    reasoning: stringOrNull(payload.reasoning),
    suggested_knowledge_ids: stringArray(payload.suggested_knowledge_ids),
    mistake_draft: toMistakeDraft(payload.mistake_draft),
    observed_at: row.created_at.toISOString(),
  };
}

// Tolerant projection of payload.mistake_draft (the judge's raw MistakeEnrollOutput,
// written at auto-enroll.ts:303). We deliberately do NOT safeParse the full
// MistakeEnrollOutput schema and null-on-any-mismatch — a strict parse would reject
// a historical/legacy event that predates a field and silently drop a draft that is
// "valid enough" for prefill. Instead we project only the fields slice-3 prefill
// needs and guard each defensively, so a partial event keeps its present fields
// (absent ones fall to null / today's defaults downstream).
// Derive the accepted set from the canonical MistakeEnrollOutcome enum so a future
// added outcome can never be silently projected to null by a stale hand-kept list
// (ocr-1: compile-time sync with mistake_enroll.ts). z.enum exposes `.options`.
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
  // analysis_md is the human-readable cause text the judge produced; slice-3
  // prefill maps it to cause_notes (NOT a nonexistent cause.user_notes).
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

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
