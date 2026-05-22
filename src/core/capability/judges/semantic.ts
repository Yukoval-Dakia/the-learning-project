import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';
import type { JudgeCapabilityRunner, JudgeRunInput } from '../types';

const VERSION = '1.0.0';

const manifest: CapabilityManifestT = {
  id: 'semantic',
  kind: 'judge',
  version: VERSION,
  input_schema: 'SemanticJudgeTask input',
  output_schema: 'JudgeResultV2',
  cost_class: 'cheap_llm',
  latency_class: 'async',
  stability: 'experimental',
};

function run(input: JudgeRunInput): JudgeResultV2T {
  return {
    score: null,
    score_meaning: 'correctness',
    coarse_outcome: 'unsupported',
    confidence: 0,
    capability_ref: { id: manifest.id, version: VERSION },
    feedback_md:
      'semantic@1 is an async server judge. Use judgeAnswer(), which invokes SemanticJudgeTask with DB/runtime context.',
    evidence_json: {
      reason: 'semantic judge requires async LLM runtime context',
      question: input.question,
    },
  };
}

export const semanticJudgeCapability: JudgeCapabilityRunner = { manifest, run };
