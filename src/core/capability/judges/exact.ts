import type {
  CapabilityManifestT,
  JudgeResultV2T,
} from '@/core/schema/capability';
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
  return value.trim().toLowerCase();
}

function run(input: JudgeRunInput): JudgeResultV2T {
  const question = ExactJudgeQuestion.parse(input.question);
  const normalizedReference = normalize(question.reference);
  const normalizedAnswer = normalize(input.answer.content);
  const match = normalizedAnswer === normalizedReference;

  return {
    score: match ? 1 : 0,
    score_meaning: 'correctness',
    coarse_outcome: match ? 'correct' : 'incorrect',
    confidence: 1,
    capability_ref: CAPABILITY_REF,
    feedback_md: match
      ? `正确答案：${question.reference}。`
      : `参考答案：${question.reference}。你的答案：${input.answer.content}。`,
    evidence_json: {
      match,
      normalized_answer: normalizedAnswer,
      normalized_reference: normalizedReference,
    },
  };
}

export const exactJudgeCapability: JudgeCapabilityRunner = { manifest, run };
