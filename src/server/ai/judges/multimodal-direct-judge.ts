import {
  MultimodalDirectLlmOutput,
  type MultimodalDirectLlmOutputT,
} from '@/core/capability/judges/multimodal_direct';
import type { JudgeResultV2T } from '@/core/schema/capability';
import type { Db } from '@/db/client';
import type { SubjectProfile } from '@/subjects/profile';
import type { JudgeQuestionRow } from './question-contract';
// Reuse the steps@1 R2 image fetcher verbatim — no R2 logic duplicated here.
import { defaultImageFetch } from './steps-judge';

const CAPABILITY_REF = { id: 'multimodal_direct', version: '1.0.0' };

export type MultimodalDirectRunTaskFn = (
  kind: string,
  input: { text: string; images: Array<{ data: string; mediaType: string }> } | unknown,
  ctx: unknown,
) => Promise<{ text: string }>;

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
  ctx: unknown,
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
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
  let llmText: string;
  try {
    const result = await runTaskFn(
      'MultimodalDirectJudgeTask',
      { text: llmTextPayload, images },
      { db: params.db, subjectProfile: params.subjectProfile },
    );
    llmText = result.text;
  } catch (err) {
    return unsupportedResult('LLM call failed', {
      error: err instanceof Error ? err.message : String(err),
      prompt_image_refs: promptImageRefs,
      student_image_refs: studentImageRefs,
    });
  }

  let parsed: MultimodalDirectLlmOutputT;
  try {
    parsed = MultimodalDirectLlmOutput.parse(extractJsonObject(llmText));
  } catch (err) {
    return unsupportedResult('LLM output did not match MultimodalDirectLlmOutput schema', {
      error: err instanceof Error ? err.message : String(err),
      raw_text: llmText,
    });
  }

  return composeJudgeResult(parsed, {
    prompt_image_count: promptImages.length,
    student_image_count: studentImages.length,
  });
}
