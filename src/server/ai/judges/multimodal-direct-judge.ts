import { tasks } from '@/ai/registry';
import {
  MultimodalDirectLlmOutput,
  type MultimodalDirectLlmOutputT,
} from '@/core/capability/judges/multimodal_direct';
import type { JudgeResultV2T } from '@/core/schema/capability';
import type { Db } from '@/db/client';
import { zodToJsonSchemaOutputFormat } from '@/server/ai/output-format';
import type { RunTaskCtx } from '@/server/ai/runner';
import { visionJudgeProviderOverride } from '@/server/ai/vision-judge-config';
import type { SubjectProfile } from '@/subjects/profile';
import type { JudgeQuestionRow } from './question-contract';
// Reuse the steps@1 R2 image fetcher verbatim — no R2 logic duplicated here.
import { defaultImageFetch } from './steps-judge';

const CAPABILITY_REF = { id: 'multimodal_direct', version: '1.0.0' };

// YUK-591 — the SDK structured-output envelope, built ONCE from the registry's
// declared schema so the registry declaration (audited by §7) is the single,
// load-bearing source. The ternary keeps the un-declared case typed; in practice
// MultimodalDirectJudgeTask always declares it (the audit enforces exactly that).
const outputSchema = tasks.MultimodalDirectJudgeTask.structuredOutputSchema;
const OUTPUT_FORMAT = outputSchema ? zodToJsonSchemaOutputFormat(outputSchema) : undefined;

/** Widened (YUK-591) to carry the SDK `structured_output` passthrough. */
export type MultimodalDirectRunTaskFn = (
  kind: string,
  input: { text: string; images: Array<{ data: string; mediaType: string }> } | unknown,
  ctx: unknown,
) => Promise<{ text: string; structured_output?: unknown }>;

export type MultimodalDirectImageFetchFn = (
  assetIds: string[],
  db: Db,
) => Promise<Array<{ data: string; mediaType: string }>>;

export interface RunMultimodalDirectJudgeParams {
  db: Db;
  question: JudgeQuestionRow;
  answer_md: string;
  /** Student-submitted answer images (NOT question.image_refs which are prompt figures). */
  student_image_refs?: string[];
  subjectProfile: SubjectProfile;
  runTaskFn?: MultimodalDirectRunTaskFn;
  imageFetchFn?: MultimodalDirectImageFetchFn;
}

function unsupportedResult(reason: string, evidence: Record<string, unknown>): JudgeResultV2T {
  return {
    score: null,
    score_meaning: 'correctness',
    coarse_outcome: 'unsupported',
    confidence: 0,
    capability_ref: CAPABILITY_REF,
    feedback_md: `multimodal_direct judge unsupported: ${reason}`,
    evidence_json: evidence,
  };
}

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: RunTaskCtx,
): Promise<{ text: string; structured_output?: unknown }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx);
  return { text: result.text, structured_output: result.structured_output };
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('multimodal_direct judge output did not contain a JSON object');
  }
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * YUK-591 — three-state dispatch over the task result (mirrors variant_verify's
 * parseVariantVerifyResult). Exported so the unit test can feed constructed
 * results directly.
 *   (A) structured_output present (endpoint honoured outputFormat) → parse it
 *       through the SAME Zod schema. The Zod pass is NOT optional: outputFormat
 *       only guarantees JSON shape, not the app-level enum/range constraints, so
 *       a shape-valid-but-constraint-violating payload still throws (→ the
 *       caller's `unsupported` fallback, byte-identical bucket to today).
 *   (B) structured_output absent/null (mimo ignores outputFormat, or the model
 *       fell back to text) → the existing char-scan extractJsonObject path, so
 *       the default mimo lane is byte-identical to pre-migration.
 * `.parse` (throwing) is kept over safeParse so the thrown message is identical
 * to the pre-migration text path (`extractJsonObject` "did not contain a JSON
 * object" / ZodError), preserving the caller's evidence_json.error contract.
 */
export function parseMultimodalDirectResult(result: {
  text: string;
  structured_output?: unknown;
}): MultimodalDirectLlmOutputT {
  if (result.structured_output !== undefined && result.structured_output !== null) {
    return MultimodalDirectLlmOutput.parse(result.structured_output);
  }
  return MultimodalDirectLlmOutput.parse(extractJsonObject(result.text));
}

/**
 * Compose a JudgeResultV2 from the LLM output. score_meaning='correctness' and
 * the discriminated-union clamping mirrors the semantic / steps judges:
 *   - correct   → score ∈ [0.85, 1]
 *   - partial   → score ∈ [0.01, 0.84]
 *   - incorrect → score = 0
 * The clamp is driven by the LLM's coarse_outcome (not its raw score), so a
 * mislabeled score can never produce a JudgeResultV2 that fails the union.
 */
function composeJudgeResult(
  output: MultimodalDirectLlmOutputT,
  refs: { prompt_image_count: number; student_image_count: number },
): JudgeResultV2T {
  const evidence = {
    observed_md: output.evidence.observed_md,
    matched_points: output.evidence.matched_points,
    missing_points: output.evidence.missing_points,
    prompt_image_count: refs.prompt_image_count,
    student_image_count: refs.student_image_count,
  };

  if (output.coarse_outcome === 'correct') {
    return {
      score: Math.min(1, Math.max(0.85, output.score)),
      score_meaning: 'correctness',
      coarse_outcome: 'correct',
      confidence: output.confidence,
      capability_ref: CAPABILITY_REF,
      feedback_md: output.feedback_md,
      evidence_json: evidence,
    };
  }
  if (output.coarse_outcome === 'partial') {
    return {
      score: Math.min(0.84, Math.max(0.01, output.score)),
      score_meaning: 'correctness',
      coarse_outcome: 'partial',
      confidence: output.confidence,
      capability_ref: CAPABILITY_REF,
      feedback_md: output.feedback_md,
      evidence_json: evidence,
    };
  }
  return {
    score: 0,
    score_meaning: 'correctness',
    coarse_outcome: 'incorrect',
    confidence: output.confidence,
    capability_ref: CAPABILITY_REF,
    feedback_md: output.feedback_md,
    evidence_json: evidence,
  };
}

export async function runMultimodalDirectJudge(
  params: RunMultimodalDirectJudgeParams,
): Promise<JudgeResultV2T> {
  const promptImageRefs = params.question.image_refs ?? [];
  const studentImageRefs = params.student_image_refs ?? [];
  const studentFinalText = params.answer_md.trim();

  // Guard: with neither images nor a typed answer there is nothing to judge.
  if (
    promptImageRefs.length === 0 &&
    studentImageRefs.length === 0 &&
    studentFinalText.length === 0
  ) {
    return unsupportedResult('no images and no answer text to judge', {
      question_id: params.question.id,
      prompt_image_refs: promptImageRefs,
      student_image_refs: studentImageRefs,
    });
  }

  const imageFetchFn = params.imageFetchFn ?? defaultImageFetch;
  let promptImages: Array<{ data: string; mediaType: string }> = [];
  let studentImages: Array<{ data: string; mediaType: string }> = [];
  try {
    promptImages = promptImageRefs.length > 0 ? await imageFetchFn(promptImageRefs, params.db) : [];
    studentImages =
      studentImageRefs.length > 0 ? await imageFetchFn(studentImageRefs, params.db) : [];
  } catch (err) {
    return unsupportedResult('image fetch failed', {
      error: err instanceof Error ? err.message : String(err),
      prompt_image_refs: promptImageRefs,
      student_image_refs: studentImageRefs,
    });
  }
  // Concat order: prompt figures first, then student answer photos (matches the
  // text payload field order so the LLM can align images to their description).
  const images = [...promptImages, ...studentImages];

  const llmTextPayload = JSON.stringify({
    prompt_md: params.question.prompt_md,
    reference_md: params.question.reference_md ?? null,
    prompt_image_refs: promptImageRefs,
    student_image_refs: studentImageRefs,
    student_final_answer_text: studentFinalText || undefined,
    image_present: images.length > 0,
    prompt_image_count: promptImages.length,
    student_image_count: studentImages.length,
  });

  const runTaskFn = params.runTaskFn ?? defaultRunTaskFn;
  let taskResult: { text: string; structured_output?: unknown };
  try {
    // YUK-482 Lane C ③: route the vision judge to a configured provider (e.g.
    // Opus 4.8 via anthropic-sub) when VISION_JUDGE_PROVIDER is set; default
    // unset → undefined → registry mimo default (byte-identical to today). The
    // override is merged into ctx here (the call site), so an injected test
    // runTaskFn still receives it and can assert on ctx.override.
    //
    // YUK-576 — enableTransientRetry: true, same rationale + boundaries as
    // steps-judge.ts (sync-route sensor, no durable backstop; single module-level
    // call site covers all callers; operator-pinned routing turns retry off).
    //
    // YUK-591 — outputFormat: the SDK structured-output envelope (built from the
    // registry-declared MultimodalDirectLlmOutput). Threaded in ctx here so an
    // injected test runTaskFn can assert on it. A structured-output-capable
    // endpoint constrains + SDK-retries the model to the schema; mimo ignores it
    // and the dispatch falls back to the char-scan text parse (zero-loss).
    const result = await runTaskFn(
      'MultimodalDirectJudgeTask',
      { text: llmTextPayload, images },
      {
        db: params.db,
        subjectProfile: params.subjectProfile,
        override: visionJudgeProviderOverride(),
        enableTransientRetry: true,
        outputFormat: OUTPUT_FORMAT,
      },
    );
    taskResult = result;
  } catch (err) {
    return unsupportedResult('LLM call failed', {
      error: err instanceof Error ? err.message : String(err),
      prompt_image_refs: promptImageRefs,
      student_image_refs: studentImageRefs,
    });
  }

  let parsed: MultimodalDirectLlmOutputT;
  try {
    parsed = parseMultimodalDirectResult(taskResult);
  } catch (err) {
    return unsupportedResult('LLM output did not match MultimodalDirectLlmOutput schema', {
      error: err instanceof Error ? err.message : String(err),
      // Structured-fail evidence: on a structured-output endpoint the offending payload
      // lives in structured_output (text may be empty) — record it, truncated; fall back
      // to the text path's raw output otherwise (PR #1042 OCR).
      raw_text:
        taskResult.structured_output != null
          ? JSON.stringify(taskResult.structured_output).slice(0, 4000)
          : taskResult.text,
    });
  }

  return composeJudgeResult(parsed, {
    prompt_image_count: promptImages.length,
    student_image_count: studentImages.length,
  });
}
