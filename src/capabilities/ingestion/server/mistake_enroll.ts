import {
  MistakeEnrollTaskError,
  parseMistakeEnrollOutput,
} from '@/capabilities/ingestion/tasks/mistake-enroll';
/**
 * MistakeEnrollTask invoker: a single-shot, text-only task that drafts the mistake
 * metadata a human would fill in review (outcome, kind, difficulty, and cause for a
 * wrong answer). It holds no DB and takes an injectable runner for tests.
 *
 * Observe mode only attaches the draft to the audit event; it never writes a domain
 * row. Enrollment behind the off-by-default flag uses the same draft.
 */
import {
  type CauseProfileLike,
  getAllowedCauseIds,
  validateCauseAgainstProfile,
} from '@/core/schema/cause';
import {
  MistakeEnrollInput,
  type MistakeEnrollInputT,
  MistakeEnrollOutput,
  type MistakeEnrollOutputT,
} from '@/core/schema/mistake_enroll';
import type { Db } from '@/db/client';
import { makeRunTaskTextFn } from '@/server/ai/runner-fn';
import { redactIngestionText } from './privacy-guard';

/**
 * Thrown when the MistakeEnrollTask cannot produce a usable draft (provider
 * down, unparseable / schema-invalid output). The observe caller swallows this
 * (logs + writes the audit event WITHOUT a draft) so one bad draft never aborts
 * the batch — exactly the posture TaggingTaskError gets in auto-enroll.
 */
export { MistakeEnrollTaskError };

export type MistakeEnrollRunTaskFn = (
  kind: string,
  input: MistakeEnrollInputT,
  ctx: unknown,
) => Promise<{ text: string }>;

export interface RunMistakeEnrollTaskParams {
  /** The question text (rendered from structured upstream). */
  questionMd: string;
  /** Reference/model answer if extraction surfaced one. */
  referenceMd?: string | null;
  /** The student's captured answer; blank/null → 'unanswered'. */
  studentAnswerMd?: string | null;
  /** Knowledge ids the judge accepted, for cause grounding. */
  knowledgeIds?: string[];
  /** Subject taxonomy — supplies allowed cause ids (input) + the server clamp. */
  profile: CauseProfileLike;
  /** Database bound by the production runner; tests may inject runTaskFn instead. */
  db?: Db;
  /** Inject in tests; defaults to the production runner. */
  runTaskFn?: MistakeEnrollRunTaskFn;
  /** Forwarded to runTask ctx (subjectProfile only). */
  ctx?: unknown;
}

/**
 * Runs the MistakeEnrollTask. Returns a validated draft with the cause clamped to
 * the subject taxonomy. Deterministic guarantees regardless of model output: a
 * blank student answer forces outcome 'unanswered' + cause null, and a cause is
 * kept only for a 'failure' outcome. On provider failure / unparseable /
 * schema-invalid output throws `MistakeEnrollTaskError`.
 */
export async function runMistakeEnrollTask(
  params: RunMistakeEnrollTaskParams,
): Promise<MistakeEnrollOutputT> {
  const studentAnswer = params.studentAnswerMd?.trim() ?? '';
  const allowedCauseIds = [...getAllowedCauseIds(params.profile)];
  if (allowedCauseIds.length === 0) {
    throw new MistakeEnrollTaskError('MistakeEnrollTask requires a non-empty cause taxonomy');
  }

  let input: MistakeEnrollInputT;
  try {
    // Redact question and answer text; the cause taxonomy and KC ids are internal.
    input = MistakeEnrollInput.parse({
      question_md: redactIngestionText(params.questionMd).text,
      reference_md:
        params.referenceMd == null ? null : redactIngestionText(params.referenceMd).text,
      student_answer_md:
        params.studentAnswerMd == null ? null : redactIngestionText(params.studentAnswerMd).text,
      allowed_cause_ids: allowedCauseIds,
      knowledge_ids: params.knowledgeIds ?? [],
    });
  } catch (err) {
    throw new MistakeEnrollTaskError('MistakeEnrollTask input was invalid', { cause: err });
  }

  if (params.runTaskFn === undefined && params.db === undefined) {
    throw new MistakeEnrollTaskError(
      'runMistakeEnrollTask requires db when using the default runner (inject runTaskFn in tests)',
    );
  }

  const runTaskFn = params.runTaskFn ?? makeRunTaskTextFn(params.db as Db);
  let llmText: string;
  try {
    const result = await runTaskFn('MistakeEnrollTask', input, params.ctx ?? {});
    llmText = result.text;
  } catch (err) {
    throw new MistakeEnrollTaskError('MistakeEnrollTask LLM call failed', { cause: err });
  }

  let parsed: MistakeEnrollOutputT;
  try {
    parsed = parseMistakeEnrollOutput(llmText);
  } catch (err) {
    if (err instanceof MistakeEnrollTaskError) throw err;
    throw new MistakeEnrollTaskError('MistakeEnrollTask output did not match MistakeEnrollOutput', {
      cause: err,
    });
  }

  // ---- Deterministic normalization (independent of model output) ----
  // Blank answer → unanswered: there is nothing to grade or attribute.
  if (studentAnswer.length === 0) {
    return { ...parsed, wrong_answer: 'unanswered', cause: null };
  }
  // A cause is meaningful only for a wrong answer; drop it otherwise.
  if (parsed.wrong_answer !== 'failure') {
    return { ...parsed, cause: null };
  }
  // Failure with a cause → clamp to the subject taxonomy (anti-hallucination).
  if (parsed.cause) {
    return { ...parsed, cause: validateCauseAgainstProfile(parsed.cause, params.profile) };
  }
  // Failure WITHOUT a cause is a valid drafted state (the model may lack
  // confidence to attribute one) — A2 consumers must handle cause === null on a
  // 'failure' draft. We pass it through rather than inventing a cause.
  return parsed;
}
