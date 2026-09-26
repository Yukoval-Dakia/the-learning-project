import { getDefaultRegistry } from '@/core/capability/judges';
import type { JudgeResultV2T } from '@/core/schema/capability';
import type { AnswerInput, JudgeResult } from './exact';

// YUK-374 — 'rubric' / 'ai_flexible' are union members with NO runner: they
// exist so a persisted judge_kind_override parses and fails loudly as
// `unsupported` (judgeRouterV2 below + the invoker dispatch both fail closed)
// instead of silently re-routing to a different judge. Runnable set =
// RUNNABLE_ROUTES; see UNIMPLEMENTED_JUDGE_ROUTES in question-contract.ts.
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

export {
  EvaluateSubmissionError,
  type EvaluateSubmissionRequest,
  type EvaluateSubmissionResult,
  type JevModelExecutorSpec,
  evaluateSubmission,
  resolveModelExecutor,
} from './evaluate-submission';
export {
  type ContractAttemptInput,
  type ContractAttemptOutcome,
  type ContractGradingRef,
  EVALUATION_ENTRY_POINTS,
  type EntryPointDisposition,
  type EvaluateAttemptInput,
  type EvaluateAttemptOutcome,
  type GradingEntryPoint,
  type LegacyAttemptInput,
  type LegacyAttemptOutcome,
  evaluateAttempt,
  projectEvaluationToJudgeResult,
} from './evaluation-authority';
export { judgeExact } from './exact';
export {
  type JudgeExecutionIdentity,
  deterministicExecutionProvenance,
  historicalUnknownExecutionProvenance,
  modelExecutionProvenance,
  resolveInvokedExecutionProvenance,
  suppliedUnverifiedExecutionProvenance,
} from './execution-provenance-resolve';
export { type JudgeInvokerOutput, createDefaultJudgeInvoker } from './invoker';
export {
  JUDGE_PROMPT_TEMPLATE_REVISION,
  sha256Canonical,
  taskInputHash,
} from './judge-execution-provenance';
export { judgeKeyword } from './keyword';
export {
  type MultimodalDirectImageFetchFn,
  type MultimodalDirectRunTaskFn,
  parseMultimodalDirectResult,
  runMultimodalDirectJudge,
} from './multimodal-direct-judge';
export {
  issueJudgePreviewProvenanceToken,
  judgeProvenanceSigningSecret,
  verifyJudgePreviewProvenanceToken,
} from './preview-provenance-token';
export {
  type JudgeAnswerParams,
  type JudgeAnswerResult,
  type JudgeQuestionRow,
  RUNNABLE_ROUTES,
  judgeAnswer,
  runSemanticJudge,
  semanticInput,
} from './question-contract';
export {
  IMAGE_CONSUMING_JUDGE_ROUTES,
  type JudgeRoute,
  type JudgeRouteQuestionRow,
  MODEL_BACKED_JUDGE_ROUTES,
  isModelBackedJudgeRoute,
  resolveQuestionJudgeRoute,
} from './route-resolve';
export { defaultImageFetch, runStepsJudge } from './steps-judge';
export type { AnswerInput, JudgeResult };
