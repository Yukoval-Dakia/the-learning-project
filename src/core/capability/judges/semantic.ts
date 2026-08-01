import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';
import { z } from 'zod';
import type { JudgeCapabilityRunner, JudgeRunInput } from '../types';

/**
 * SDK-native output contract for SemanticJudgeTask.
 *
 * Kept in core so the AI task registry and the server-side semantic judge parse
 * the exact same schema without introducing a registry -> server/ai cycle.
 */
export const SemanticJudgeOutput = z.object({
  score: z.number().min(0).max(1),
  coarse_outcome: z.enum(['correct', 'partial', 'incorrect']),
  confidence: z.number().min(0).max(1),
  feedback_md: z.string().min(1),
  evidence_json: z.object({
    matched_points: z.array(z.string()).default([]),
    missing_points: z.array(z.string()).default([]),
    notes: z.string().optional(),
  }),
});

export type SemanticJudgeOutputT = z.infer<typeof SemanticJudgeOutput>;

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
