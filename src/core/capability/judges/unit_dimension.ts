import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';
import type { JudgeCapabilityRunner, JudgeRunInput } from '../types';

const VERSION = '1.0.0';

const manifest: CapabilityManifestT = {
  id: 'unit_dimension',
  kind: 'judge',
  version: VERSION,
  input_schema: 'UnitDimensionJudgeInput (P2)',
  output_schema: 'JudgeResultV2 (score_meaning=unit_dimension_v1)',
  cost_class: 'local',
  latency_class: 'sync',
  stability: 'experimental',
};

const CAPABILITY_REF = { id: manifest.id, version: VERSION };

function run(input: JudgeRunInput): JudgeResultV2T {
  return {
    score: null,
    score_meaning: 'unit_dimension_v1',
    coarse_outcome: 'unsupported',
    confidence: 0,
    capability_ref: CAPABILITY_REF,
    feedback_md:
      'unit_dimension@1 judge skeleton: deterministic unit/dimension implementation ships in P2.',
    evidence_json: {
      phase: 'P1-skeleton',
      reason: 'capability registered but run() not yet implemented',
      question: input.question,
    },
  };
}

export const unitDimensionV1Capability: JudgeCapabilityRunner = { manifest, run };
