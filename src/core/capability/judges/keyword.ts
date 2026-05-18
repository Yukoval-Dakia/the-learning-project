import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';
import { z } from 'zod';
import type { JudgeCapabilityRunner, JudgeRunInput } from '../types';

const KeywordJudgeQuestion = z.object({
  keywords: z.array(z.string().min(1)).min(1),
});

const VERSION = '1.0.0';

const manifest: CapabilityManifestT = {
  id: 'keyword',
  kind: 'judge',
  version: VERSION,
  input_schema: 'KeywordJudgeInput { keywords: string[] }',
  output_schema: 'JudgeResultV2',
  cost_class: 'local',
  latency_class: 'sync',
  stability: 'stable',
};

const CAPABILITY_REF = { id: manifest.id, version: VERSION };

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

function classifyScore(score: number): 'correct' | 'partial' | 'incorrect' {
  if (score >= 0.85) return 'correct';
  if (score > 0) return 'partial';
  return 'incorrect';
}

function run(input: JudgeRunInput): JudgeResultV2T {
  const parsed = KeywordJudgeQuestion.safeParse(input.question);
  if (!parsed.success) {
    return {
      score: null,
      score_meaning: 'correctness',
      coarse_outcome: 'unsupported',
      confidence: 0,
      capability_ref: CAPABILITY_REF,
      feedback_md: `keyword judge input unsupported: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
      evidence_json: {
        validation_error: parsed.error.issues,
        question: input.question,
      },
    };
  }
  const { keywords } = parsed.data;
  const normalizedContent = normalize(input.answer.content);
  const hits = keywords.filter((keyword) => normalizedContent.includes(normalize(keyword)));
  const missing = keywords.filter((keyword) => !normalizedContent.includes(normalize(keyword)));
  const total = keywords.length;
  const score = total === 0 ? 0 : hits.length / total;
  const coarseOutcome = classifyScore(score);

  const feedback =
    missing.length === 0
      ? `命中所有关键词 (${hits.length}/${total})。`
      : `命中关键词 ${hits.length}/${total}：缺失 [${missing.join(', ')}]。`;
  const evidence = { hits, missing, total };

  if (coarseOutcome === 'correct') {
    return {
      score,
      score_meaning: 'correctness',
      coarse_outcome: 'correct',
      confidence: 1,
      capability_ref: CAPABILITY_REF,
      feedback_md: feedback,
      evidence_json: evidence,
    };
  }

  if (coarseOutcome === 'partial') {
    return {
      score,
      score_meaning: 'correctness',
      coarse_outcome: 'partial',
      confidence: 1,
      capability_ref: CAPABILITY_REF,
      feedback_md: feedback,
      evidence_json: evidence,
    };
  }

  return {
    score: 0,
    score_meaning: 'correctness',
    coarse_outcome: 'incorrect',
    confidence: 1,
    capability_ref: CAPABILITY_REF,
    feedback_md: feedback,
    evidence_json: evidence,
  };
}

export const keywordJudgeCapability: JudgeCapabilityRunner = {
  manifest,
  run,
};
