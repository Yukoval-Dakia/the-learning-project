import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';

import type { JudgeCapabilityRunner, JudgeRunInput } from '../types';
import { runAccelerator } from './unit_dimension/accelerator';
import { type RunTaskFn, runLlmFallback } from './unit_dimension/llm-fallback';
import { composeScore } from './unit_dimension/score';
import type { LlmFallbackOutputT } from './unit_dimension/types';

const VERSION = '1.0.0';

const manifest: CapabilityManifestT = {
  id: 'unit_dimension',
  kind: 'judge',
  version: VERSION,
  input_schema: 'UnitDimensionJudgeInput',
  output_schema: 'JudgeResultV2 (score_meaning=unit_dimension_v1)',
  cost_class: 'local',
  latency_class: 'async',
  stability: 'experimental',
};

const CAPABILITY_REF = { id: manifest.id, version: VERSION };

interface RunDeps {
  runTaskFn?: RunTaskFn;
  runTaskCtx?: unknown;
}

interface UnitDimensionMetadata {
  reference_value?: number;
  reference_unit?: string;
  reference_tolerance?: number;
}

export async function runUnitDimensionJudge(
  input: JudgeRunInput,
  deps: RunDeps = {},
): Promise<JudgeResultV2T> {
  const student = input.answer.content;
  const meta = getMetadata(input.question.metadata);
  const refValue = meta?.reference_value;
  const refUnit = meta?.reference_unit;
  const refTolerance = meta?.reference_tolerance ?? 0.05;

  if (typeof refValue !== 'number' || typeof refUnit !== 'string') {
    return unsupported('question.metadata 缺 reference_value/reference_unit', {
      question: input.question,
    });
  }

  const reference = { value: refValue, unit: refUnit, tolerance: refTolerance };
  const accelerator = runAccelerator({
    student_answer: student,
    reference,
  });

  let fallback: LlmFallbackOutputT | undefined;
  let fallback_error: string | undefined;
  if (!accelerator.parsed && accelerator.signal === 'unparseable') {
    try {
      fallback = await runLlmFallback({
        student_answer: student,
        reference: { value: refValue, unit: refUnit },
        question_context_md:
          typeof input.question.prompt_md === 'string' ? input.question.prompt_md : undefined,
        runTaskFn: deps.runTaskFn,
        runTaskCtx: deps.runTaskCtx,
      });
    } catch (err) {
      fallback_error = err instanceof Error ? err.message : String(err);
    }
  }

  return composeScore({
    accelerator,
    fallback,
    reference,
    evidence: {
      input_summary: { student, refValue, refUnit },
      fallback_error,
    },
  });
}

function getMetadata(raw: unknown): UnitDimensionMetadata | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  return raw as UnitDimensionMetadata;
}

function unsupported(reason: string, evidence: Record<string, unknown>): JudgeResultV2T {
  return {
    score: null,
    score_meaning: 'unit_dimension_v1',
    coarse_outcome: 'unsupported',
    confidence: 0,
    capability_ref: CAPABILITY_REF,
    feedback_md: `unit_dimension@1: ${reason}`,
    evidence_json: evidence,
  };
}

export const unitDimensionV1Capability: JudgeCapabilityRunner = {
  manifest,
  run: runUnitDimensionJudge,
};
