import { StepsLlmOutput, type StepsLlmOutputT } from '@/core/capability/judges/steps';
import { Rubric } from '@/core/schema/business';
import type { JudgeResultV2T } from '@/core/schema/capability';
import type { Db } from '@/db/client';
import { source_asset } from '@/db/schema';
import type { SubjectProfile } from '@/subjects/profile';
import { eq } from 'drizzle-orm';
import type { JudgeQuestionRow } from './question-contract';

const CAPABILITY_REF = { id: 'steps', version: '1.0.0' };
const STEP_WEIGHT_DEFAULT = 0.6;
const VERDICT_WEIGHT: Record<StepsLlmOutputT['signal_verdicts'][number]['verdict'], number> = {
  correct: 1,
  partial: 0.5,
  wrong: 0,
  skipped: 0,
};

export type StepsRunTaskFn = (
  kind: string,
  input: { text: string; images: Array<{ data: string; mediaType: string }> } | unknown,
  ctx: unknown,
) => Promise<{ text: string }>;

export type StepsImageFetchFn = (
  assetIds: string[],
  db: Db,
) => Promise<Array<{ data: string; mediaType: string }>>;

export interface RunStepsJudgeParams {
  db: Db;
  question: JudgeQuestionRow;
  answer_md: string;
  subjectProfile: SubjectProfile;
  runTaskFn?: StepsRunTaskFn;
  imageFetchFn?: StepsImageFetchFn;
}

function unsupportedResult(reason: string, evidence: Record<string, unknown>): JudgeResultV2T {
  return {
    score: null,
    score_meaning: 'steps_v1_weighted',
    coarse_outcome: 'unsupported',
    confidence: 0,
    capability_ref: CAPABILITY_REF,
    feedback_md: `steps@1 judge unsupported: ${reason}`,
    evidence_json: evidence,
  };
}

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

/**
 * Default R2 image fetcher: for each asset_id, look up storage_key + mime,
 * fetch bytes via getR2().get(key), base64-encode.
 *
 * Split as an injectable so tests can stub. Also reused by T9 sanity script.
 */
export async function defaultImageFetch(
  assetIds: string[],
  db: Db,
): Promise<Array<{ data: string; mediaType: string }>> {
  if (assetIds.length === 0) return [];
  const { getR2 } = await import('@/server/r2');
  const r2 = getR2();
  const out: Array<{ data: string; mediaType: string }> = [];
  for (const id of assetIds) {
    const [row] = await db
      .select({ storage_key: source_asset.storage_key, mime_type: source_asset.mime_type })
      .from(source_asset)
      .where(eq(source_asset.id, id));
    if (!row) continue;
    const bytes = await r2.get(row.storage_key);
    if (!bytes) continue;
    out.push({
      data: Buffer.from(bytes).toString('base64'),
      mediaType: row.mime_type,
    });
  }
  return out;
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
    throw new Error('steps judge output did not contain a JSON object');
  }
  return JSON.parse(text.slice(start, end + 1));
}

function composeJudgeResult(
  output: StepsLlmOutputT,
  stepWeight: number,
  imageRefs: string[],
): JudgeResultV2T {
  const N = output.signal_verdicts.length;
  const stepScoreRaw =
    N === 0
      ? 0
      : output.signal_verdicts.reduce((acc, sv) => acc + (VERDICT_WEIGHT[sv.verdict] ?? 0), 0) / N;
  const finalScore = output.final_answer_match ? 1 : 0;
  const score = stepWeight * stepScoreRaw + (1 - stepWeight) * finalScore;

  const evidence = {
    extracted_steps: output.extracted_steps,
    extracted_final_answer: output.extracted_final_answer,
    signal_verdicts: output.signal_verdicts,
    final_answer_comment: output.final_answer_comment,
    step_score_raw: stepScoreRaw,
    step_weight: stepWeight,
    image_refs: imageRefs,
  };

  if (score >= 0.85) {
    return {
      score: Math.min(1, Math.max(0.85, score)),
      score_meaning: 'steps_v1_weighted',
      coarse_outcome: 'correct',
      confidence: output.confidence,
      capability_ref: CAPABILITY_REF,
      feedback_md: output.final_answer_comment || '步骤与答案均合格。',
      evidence_json: evidence,
    };
  }
  if (score > 0) {
    return {
      score: Math.min(0.84, Math.max(0.01, score)),
      score_meaning: 'steps_v1_weighted',
      coarse_outcome: 'partial',
      confidence: output.confidence,
      capability_ref: CAPABILITY_REF,
      feedback_md: output.final_answer_comment || '部分步骤命中。',
      evidence_json: evidence,
    };
  }
  return {
    score: 0,
    score_meaning: 'steps_v1_weighted',
    coarse_outcome: 'incorrect',
    confidence: output.confidence,
    capability_ref: CAPABILITY_REF,
    feedback_md: output.final_answer_comment || '步骤与答案均未命中。',
    evidence_json: evidence,
  };
}

export async function runStepsJudge(params: RunStepsJudgeParams): Promise<JudgeResultV2T> {
  const refParsed = Rubric.safeParse(params.question.rubric_json);
  const referenceSolution = refParsed.success ? refParsed.data.reference_solution : null;
  if (!referenceSolution) {
    return unsupportedResult('reference_solution missing from rubric_json', {
      question_id: params.question.id,
    });
  }

  const imageRefs = params.question.image_refs ?? [];

  // Accelerator path — Spec §7.5 #2:
  // 学生主动打字 final_answer + 命中 answer_equivalents (或 final_answer 本身) → skip LLM.
  // Conservative: 没有 LLM 走过步骤，无法给 step credit。只按 final 部分计 (1−step_weight)*1.
  // 默认 step_weight=0.6 → score 0.4，落 partial。要 'correct' 必须走 LLM。
  const studentFinalText = params.answer_md.trim();
  if (studentFinalText.length > 0 && referenceSolution.answer_equivalents.length > 0) {
    const studentNorm = normalize(studentFinalText);
    const referenceNorm = normalize(referenceSolution.final_answer);
    const equivNorms = referenceSolution.answer_equivalents.map(normalize);
    const hit = referenceNorm === studentNorm || equivNorms.includes(studentNorm);
    if (hit) {
      const score = (1 - STEP_WEIGHT_DEFAULT) * 1;
      return {
        score: Math.min(0.84, Math.max(0.01, score)),
        score_meaning: 'steps_v1_weighted',
        coarse_outcome: 'partial',
        confidence: 0.9,
        capability_ref: CAPABILITY_REF,
        feedback_md:
          '最终答案匹配，但未提交步骤；仅按 final_answer 给分。完整批改需要看到推导过程。',
        evidence_json: {
          accelerator: 'final_answer_match',
          student_final_answer_text: studentFinalText,
          reference_final_answer: referenceSolution.final_answer,
          image_refs: imageRefs,
          step_score_raw: null,
          step_weight: STEP_WEIGHT_DEFAULT,
        },
      };
    }
  }

  // LLM path
  const imageFetchFn = params.imageFetchFn ?? defaultImageFetch;
  let images: Array<{ data: string; mediaType: string }> = [];
  try {
    images = await imageFetchFn(imageRefs, params.db);
  } catch (err) {
    return unsupportedResult('image fetch failed', {
      error: err instanceof Error ? err.message : String(err),
      image_refs: imageRefs,
    });
  }

  const llmTextPayload = JSON.stringify({
    prompt_md: params.question.prompt_md,
    reference_solution: referenceSolution,
    student_text_steps: undefined,
    student_final_answer_text: studentFinalText || undefined,
    step_weight: STEP_WEIGHT_DEFAULT,
    image_count: images.length,
  });

  const runTaskFn = params.runTaskFn ?? defaultRunTaskFn;
  let llmText: string;
  try {
    const result = await runTaskFn(
      'StepsJudgeTask',
      { text: llmTextPayload, images },
      { db: params.db, subjectProfile: params.subjectProfile },
    );
    llmText = result.text;
  } catch (err) {
    return unsupportedResult('LLM call failed', {
      error: err instanceof Error ? err.message : String(err),
      image_refs: imageRefs,
    });
  }

  let parsed: StepsLlmOutputT;
  try {
    parsed = StepsLlmOutput.parse(extractJsonObject(llmText));
  } catch (err) {
    return unsupportedResult('LLM output did not match StepsLlmOutput schema', {
      error: err instanceof Error ? err.message : String(err),
      raw_text: llmText,
    });
  }

  // Runtime invariant: signal_verdicts.length must equal expected_signals.length.
  // (Schema-level enforcement deferred to runner per steps.ts comment.)
  if (parsed.signal_verdicts.length !== referenceSolution.expected_signals.length) {
    return unsupportedResult('signal_verdicts length mismatch', {
      expected: referenceSolution.expected_signals.length,
      got: parsed.signal_verdicts.length,
      image_refs: imageRefs,
    });
  }

  return composeJudgeResult(parsed, STEP_WEIGHT_DEFAULT, imageRefs);
}
