import { getDefaultRegistry } from '@/core/capability/judges';
import type { JudgeResultV2T } from '@/core/schema/capability';
import type { AnswerInput, JudgeResult } from './exact';

export type JudgeKind =
  | 'exact'
  | 'keyword'
  | 'semantic'
  | 'rubric'
  | 'steps'
  | 'unit_dimension'
  | 'multimodal_direct'
  | 'ai_flexible';

export interface JudgeRouterInput {
  kind: JudgeKind;
  question: { reference?: string; keywords?: string[]; [k: string]: unknown };
  answer: AnswerInput;
}

export function judgeRouterV2(input: JudgeRouterInput): JudgeResultV2T {
  const registry = getDefaultRegistry();
  const runner = registry.resolveJudge(input.kind);
  if (!runner) {
    throw new Error(
      `Judge kind '${input.kind}' not found in capability registry (not implemented)`,
    );
  }
  return runner.run({ question: input.question, answer: input.answer });
}

function downgradeToV1(result: JudgeResultV2T): JudgeResult {
  const verdictMap: Record<JudgeResultV2T['coarse_outcome'], JudgeResult['verdict']> = {
    correct: 'correct',
    partial: 'partial',
    incorrect: 'incorrect',
    unsupported: 'incorrect',
  };

  return {
    verdict: verdictMap[result.coarse_outcome],
    score: result.score ?? 0,
    feedback_md: result.feedback_md,
    evidence_json: result.evidence_json,
  };
}

export function judgeRouter(input: JudgeRouterInput): JudgeResult {
  return downgradeToV1(judgeRouterV2(input));
}

export { judgeExact } from './exact';
export { judgeKeyword } from './keyword';
export type { JudgeResult, AnswerInput };
