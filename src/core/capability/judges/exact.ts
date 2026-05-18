import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';
import { z } from 'zod';
import type { JudgeCapabilityRunner, JudgeRunInput } from '../types';

const ExactJudgeQuestion = z.object({
  reference: z.string().min(1),
});

const VERSION = '1.0.0';

const manifest: CapabilityManifestT = {
  id: 'exact',
  kind: 'judge',
  version: VERSION,
  input_schema: 'ExactJudgeInput { reference: string }',
  output_schema: 'JudgeResultV2',
  cost_class: 'local',
  latency_class: 'sync',
  stability: 'stable',
};

const CAPABILITY_REF = { id: manifest.id, version: VERSION };

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

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
  const normalizedReference = normalize(question.reference);
  const normalizedAnswer = normalize(input.answer.content);
  const match = normalizedAnswer === normalizedReference;

  if (match) {
    return {
      score: 1,
      score_meaning: 'correctness',
      coarse_outcome: 'correct',
      confidence: 1,
      capability_ref: CAPABILITY_REF,
      feedback_md: `正确答案：${question.reference}。`,
      evidence_json: {
        match,
        normalized_answer: normalizedAnswer,
        normalized_reference: normalizedReference,
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
      match,
      normalized_answer: normalizedAnswer,
      normalized_reference: normalizedReference,
    },
  };
}

export const exactJudgeCapability: JudgeCapabilityRunner = { manifest, run };
