import { eq } from 'drizzle-orm';
import {
  INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
  InterventionDiagnosticQuestionMetadata,
} from '@/core/schema/intervention';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { readQuestionServing } from '@/kernel/read-models/question-serving';
import { QuestionParamsSchema } from '../api/question-solve-contracts';
import { loadCommittedInterventionDiagnosticAttempt } from './intervention-diagnostics';
import { loadQuestionDetail } from './question-detail';

const DEFAULT_TIMELINE_LIMIT = 10;
const MAX_TIMELINE_LIMIT = 50;

function parseTimelineLimit(raw: string | null): number {
  if (raw === null || raw === '') return DEFAULT_TIMELINE_LIMIT;
  // Strict positive-integer match — Number.parseInt is too lenient and would
  // accept partial-numeric input ('10abc' → 10, '1.5' → 1). Require the WHOLE
  // string to be a positive integer before parsing.
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new ApiError('validation_error', `invalid timeline_limit '${raw}'`, 400);
  }
  const parsed = Number.parseInt(raw, 10);
  return Math.min(parsed, MAX_TIMELINE_LIMIT);
}

export async function readQuestionDetail(
  db: Db,
  params: Record<string, string>,
  query: { timelineLimit: string | null; surface: string | null },
) {
  const parsed = QuestionParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('validation_error', 'question id is required', 400);
  }
  const timelineLimit = parseTimelineLimit(query.timelineLimit);
  const surface = query.surface;
  if (surface !== null && surface !== 'practice') {
    throw new ApiError('validation_error', `invalid question surface '${surface}'`, 400);
  }

  const detail = await loadQuestionDetail(db, parsed.data.id, timelineLimit);
  if (
    !detail ||
    (detail.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE && surface !== 'practice')
  ) {
    throw new ApiError('not_found', `question ${parsed.data.id} not found`, 404);
  }
  // same serving projection as the list items (a part row reports
  // its own per-part verdict with the group's shared hold facts).
  const serving =
    (await readQuestionServing(db, [detail.id])).byId.get(detail.id) ??
    ({
      servable: false,
      hold_reason: null,
      held_since: null,
      next_action: null,
      pending_action: null,
    } as const);
  if (detail.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE) {
    const [diagnosticRow] = await db
      .select({
        draft_status: question.draft_status,
        metadata: question.metadata,
      })
      .from(question)
      .where(eq(question.id, detail.id))
      .limit(1);
    const schedule = InterventionDiagnosticQuestionMetadata.safeParse(
      diagnosticRow?.metadata?.intervention_diagnostic,
    );
    const committedAttempt = await loadCommittedInterventionDiagnosticAttempt(db, detail.id);
    // `surface=practice` is client-controlled, so it is not a fence by itself.
    // Only the current active one-shot may be read after its immutable due
    // time. A retired one-shot is readable only when its canonical committed
    // result exists, allowing refresh/response-loss recovery without reopening
    // the submission gate. Derived future IDs reveal neither prompt nor timing.
    if (
      !schedule.success ||
      (diagnosticRow?.draft_status === 'draft' && committedAttempt === null) ||
      (diagnosticRow?.draft_status !== 'draft' &&
        Date.now() < new Date(schedule.data.due_at).getTime())
    ) {
      throw new ApiError('not_found', `question ${parsed.data.id} not found`, 404);
    }
    // The Practice face needs the prompt/options/labels to render the scheduled
    // one-shot, but must not receive any answer-bearing material before the
    // canonical /api/attempts submission has been judged. Keep the question-bank
    // GET behavior above (404) and expose only this explicit learner-safe view.
    return {
      ...detail,
      reference_md: null,
      rubric_json: null,
      source_ref: null,
      // Diagnostic metadata contains the response-aware judge contract
      // (`probe_spec`), including gold and target-error signatures. The
      // learner surface needs none of it; expose no metadata rather than
      // attempting an answer-field denylist that can drift with the schema.
      metadata: {},
      backlinks: [],
      backlinks_by_intent_source: {},
      timeline: [],
      committed_attempt: committedAttempt,
      serving,
    };
  }
  if (surface === 'practice') {
    return {
      ...detail,
      reference_md: null,
      rubric_json: null,
      metadata: {},
      source_ref: null,
      backlinks: [],
      backlinks_by_intent_source: {},
      serving,
    };
  }
  return { ...detail, serving };
}
