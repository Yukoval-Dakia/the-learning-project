/**
 * MistakeEnrollTask invoker — T-OC slice A1 (YUK-145).
 *
 * See `docs/superpowers/specs/2026-05-29-t-oc-ocr-rebuild-design.md` (OC-5) +
 * the A1 blueprint. Single-shot structured-output AI task (NOT multimodal):
 * given a captured, answered question_block (question text + the student's
 * answer), it drafts the mistake metadata a human currently fills by hand at
 * review time — the graded outcome, question kind, difficulty, and (on a wrong
 * answer) a cause draft. Mirrors `runTaggingTask` / `runStructureTask`: a pure
 * invoker with an injectable `runTaskFn` (no DB of its own), so tests stub the
 * LLM seam with no live call.
 *
 * A1 is OBSERVE-ONLY: the caller (auto-enroll observe branch) attaches the draft
 * to the `experimental:auto_enroll_observed` audit event; it NEVER writes a
 * domain row. The actual enroll wiring + the OC-5 review surface are deferred to
 * A2 (YUK-164) behind the OFF `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED` flag.
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

/**
 * Thrown when the MistakeEnrollTask cannot produce a usable draft (provider
 * down, unparseable / schema-invalid output). The observe caller swallows this
 * (logs + writes the audit event WITHOUT a draft) so one bad draft never aborts
 * the batch — exactly the posture TaggingTaskError gets in auto-enroll.
 */
export class MistakeEnrollTaskError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MistakeEnrollTaskError';
  }
}

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
  /** Inject in tests; defaults to the production runner. */
  runTaskFn?: MistakeEnrollRunTaskFn;
  /** Forwarded to runTask ctx (db / subjectProfile). */
  ctx?: unknown;
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new MistakeEnrollTaskError('MistakeEnrollTask output did not contain a JSON object');
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new MistakeEnrollTaskError('MistakeEnrollTask output was not valid JSON', { cause: err });
  }
}

async function defaultRunTaskFn(
  kind: string,
  input: MistakeEnrollInputT,
  ctx: unknown,
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
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
    input = MistakeEnrollInput.parse({
      question_md: params.questionMd,
      reference_md: params.referenceMd ?? null,
      student_answer_md: params.studentAnswerMd ?? null,
      allowed_cause_ids: allowedCauseIds,
      knowledge_ids: params.knowledgeIds ?? [],
    });
  } catch (err) {
    throw new MistakeEnrollTaskError('MistakeEnrollTask input was invalid', { cause: err });
  }

  const runTaskFn = params.runTaskFn ?? defaultRunTaskFn;
  let llmText: string;
  try {
    const result = await runTaskFn('MistakeEnrollTask', input, params.ctx ?? {});
    llmText = result.text;
  } catch (err) {
    throw new MistakeEnrollTaskError('MistakeEnrollTask LLM call failed', { cause: err });
  }

  let parsed: MistakeEnrollOutputT;
  try {
    parsed = MistakeEnrollOutput.parse(extractJsonObject(llmText));
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
  return parsed;
}
