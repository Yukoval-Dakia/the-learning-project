import { judgeExact } from './exact';
import { judgeKeyword } from './keyword';
import type { AnswerInput, JudgeResult } from './exact';

export type JudgeKind =
  | 'exact'
  | 'keyword'
  | 'semantic'
  | 'rubric'
  | 'steps'
  | 'multimodal_direct'
  | 'ai_flexible';

export interface JudgeRouterInput {
  kind: JudgeKind;
  question: { reference?: string; keywords?: string[]; [k: string]: unknown };
  answer: AnswerInput;
}

export function judgeRouter(input: JudgeRouterInput): JudgeResult {
  switch (input.kind) {
    case 'exact':
      if (typeof input.question.reference !== 'string') {
        throw new Error('judgeExact requires question.reference');
      }
      return judgeExact({ reference: input.question.reference }, input.answer);
    case 'keyword':
      if (!Array.isArray(input.question.keywords)) {
        throw new Error('judgeKeyword requires question.keywords[]');
      }
      return judgeKeyword({ keywords: input.question.keywords }, input.answer);
    case 'semantic':
    case 'rubric':
    case 'steps':
    case 'multimodal_direct':
    case 'ai_flexible':
      throw new Error(`Judge kind '${input.kind}' not implemented (Phase 2 / quiz feature work)`);
    default: {
      const _exhaustive: never = input.kind;
      void _exhaustive;
      throw new Error(`Unknown judge kind: ${String(input.kind)}`);
    }
  }
}

export { judgeExact, judgeKeyword };
export type { JudgeResult, AnswerInput };
