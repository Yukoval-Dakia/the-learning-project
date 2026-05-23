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

export async function judgeRouterV2(input: JudgeRouterInput): Promise<JudgeResultV2T> {
  const registry = getDefaultRegistry();
  const runner = registry.resolveJudge(input.kind);
  if (!runner) {
    throw new Error(
      `Judge kind '${input.kind}' not found in capability registry (not implemented)`,
    );
  }
  return await runner.run({ question: input.question, answer: input.answer });
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

export async function judgeRouter(input: JudgeRouterInput): Promise<JudgeResult> {
  return downgradeToV1(await judgeRouterV2(input));
}

export { judgeExact } from './exact';
export { judgeKeyword } from './keyword';
export type { JudgeResult, AnswerInput };
