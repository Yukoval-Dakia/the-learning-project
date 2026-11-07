import { z } from 'zod';
import {
  compareLegacyExactAnswer,
  foldLegacyExactAnswer,
} from '@/core/schema/assessment/answer-compare';
import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';
import type { JudgeCapabilityRunner, JudgeRunInput } from '../types';

const ExactJudgeQuestion = z.object({
  reference: z.string().min(1),
  // Option texts resolve letters and text both ways for choice questions. Null is
  // normalized to [] so a raw DB row still judges as plain exact, not unsupported.
  choices_md: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? []),
});

const VERSION = '1.0.0';

const manifest: CapabilityManifestT = {
  id: 'exact',
  kind: 'judge',
  version: VERSION,
  input_schema: 'ExactJudgeInput { reference: string; choices_md?: string[] | null }',
  output_schema: 'JudgeResultV2',
  cost_class: 'local',
  latency_class: 'sync',
  stability: 'stable',
};

const CAPABILITY_REF = { id: manifest.id, version: VERSION };

function unsupportedResult(input: JudgeRunInput, issue: string): JudgeResultV2T {
  return {
    score: null,
    score_meaning: 'correctness',
    coarse_outcome: 'unsupported',
    confidence: 0,
    capability_ref: CAPABILITY_REF,
    feedback_md: `exact judge input unsupported: ${issue}`,
    evidence_json: {
      validation_error: issue,
      question: input.question,
    },
  };
}

function run(input: JudgeRunInput): JudgeResultV2T {
  const parsed = ExactJudgeQuestion.safeParse(input.question);
  if (!parsed.success) {
    return unsupportedResult(
      input,
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  const question = parsed.data;
  const normalizedReference = foldLegacyExactAnswer(question.reference);
  const normalizedAnswer = foldLegacyExactAnswer(input.answer.content);

  // 比较归 answer-compare（与 V1 exact judge 同一实现）：选项字母↔选项文本、
  // 答案头、过程作答的明示终态。本 judge 只把判定落成 V2 outcome/evidence。
  const comparison = compareLegacyExactAnswer({
    reference: question.reference,
    answer: input.answer.content,
    choices: question.choices_md,
  });
  const { finalAnswer } = comparison;

  // Record how the match was decided and the indices; otherwise differing raw texts
  // make the stored evidence look self-contradictory.
  const matchType: 'choice_index' | 'text' = comparison.choiceMatch ? 'choice_index' : 'text';
  const choiceEvidence = {
    match_type: matchType,
    answer_choice_indices: comparison.answerChoiceIndices,
    reference_choice_indices: comparison.referenceChoiceIndices,
  };
  // Record extracted heads when a tail was stripped, for the same reason.
  const headEvidence = {
    ...(comparison.answerHead !== input.answer.content.normalize('NFKC').trim()
      ? { answer_head: comparison.answerHead }
      : {}),
    ...(comparison.referenceHead !== question.reference.normalize('NFKC').trim()
      ? { reference_answer_head: comparison.referenceHead }
      : {}),
  };

  if (comparison.match) {
    return {
      score: 1,
      score_meaning: 'correctness',
      coarse_outcome: 'correct',
      confidence: 1,
      capability_ref: CAPABILITY_REF,
      feedback_md: `正确答案：${question.reference}。`,
      evidence_json: {
        match: comparison.match,
        normalized_answer: normalizedAnswer,
        normalized_reference: normalizedReference,
        ...choiceEvidence,
        ...headEvidence,
        ...(finalAnswer?.kind === 'found'
          ? { final_answer: { value: finalAnswer.values[0] ?? '', marker: finalAnswer.marker } }
          : {}),
      },
    };
  }

  // After a head miss, the comparison already tried the explicit final answer
  // ("推导…S5=11" vs "11"). If it cannot be resolved, report unsupported rather
  // than pretend a zero score.
  if (comparison.processUnresolvable) {
    return {
      score: null,
      score_meaning: 'correctness',
      coarse_outcome: 'unsupported',
      confidence: 0,
      capability_ref: CAPABILITY_REF,
      feedback_md:
        finalAnswer?.kind === 'found'
          ? 'extracted final answer does not match the reference — equivalence beyond the exact comparator contract'
          : finalAnswer?.kind === 'ambiguous'
            ? `conflicting explicit final answers (${finalAnswer.candidates.join(' / ')}) — exact comparator cannot adjudicate`
            : 'worked/process answer carries no unambiguous final answer — beyond the exact comparator contract',
      evidence_json: {
        match: false,
        reason: 'process_answer_unresolvable',
        normalized_answer: normalizedAnswer,
        normalized_reference: normalizedReference,
        ...(finalAnswer?.kind === 'found'
          ? { final_answer: { value: finalAnswer.values[0] ?? '', marker: finalAnswer.marker } }
          : {}),
        ...(finalAnswer?.kind === 'ambiguous'
          ? { final_answer_candidates: finalAnswer.candidates }
          : {}),
        ...choiceEvidence,
        ...headEvidence,
      },
    };
  }

  return {
    score: 0,
    score_meaning: 'correctness',
    coarse_outcome: 'incorrect',
    confidence: 1,
    capability_ref: CAPABILITY_REF,
    feedback_md: `参考答案：${question.reference}。你的答案：${input.answer.content}。`,
    evidence_json: {
      match: false,
      normalized_answer: normalizedAnswer,
      normalized_reference: normalizedReference,
      ...(finalAnswer?.kind === 'found'
        ? { final_answer: { value: finalAnswer.values[0] ?? '', marker: finalAnswer.marker } }
        : {}),
      ...choiceEvidence,
      ...headEvidence,
    },
  };
}

export const exactJudgeCapability: JudgeCapabilityRunner = { manifest, run };
