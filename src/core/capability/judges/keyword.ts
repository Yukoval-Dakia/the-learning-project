import type {
  CapabilityManifestT,
  JudgeResultV2T,
} from '@/core/schema/capability';
import { z } from 'zod';
import type { JudgeCapabilityRunner, JudgeRunInput } from '../types';

const KeywordJudgeQuestion = z.object({
  keywords: z.array(z.string().min(1)),
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
  return value.trim().toLowerCase();
}

function classifyScore(score: number): JudgeResultV2T['coarse_outcome'] {
  if (score >= 0.85) return 'correct';
  if (score > 0) return 'partial';
  return 'incorrect';
}

function run(input: JudgeRunInput): JudgeResultV2T {
  const { keywords } = KeywordJudgeQuestion.parse(input.question);
  const normalizedContent = normalize(input.answer.content);
  const hits = keywords.filter((keyword) =>
    normalizedContent.includes(normalize(keyword)),
  );
  const missing = keywords.filter(
    (keyword) => !normalizedContent.includes(normalize(keyword)),
  );
  const total = keywords.length;
  const score = total === 0 ? 0 : hits.length / total;
  const coarseOutcome = classifyScore(score);

  return {
    score,
    score_meaning: 'correctness',
    coarse_outcome: coarseOutcome,
    confidence: 1,
    capability_ref: CAPABILITY_REF,
    feedback_md:
      total === 0
        ? '没有配置关键词。'
        : missing.length === 0
          ? `命中所有关键词 (${hits.length}/${total})。`
          : `命中关键词 ${hits.length}/${total}：缺失 [${missing.join(', ')}]。`,
    evidence_json: {
      hits,
      missing,
      total,
    },
  };
}

export const keywordJudgeCapability: JudgeCapabilityRunner = {
  manifest,
  run,
};
