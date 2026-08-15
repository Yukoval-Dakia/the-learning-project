// 内核 judge facade（薄壳，YUK-589）— re-export Practice capability 的 sanctioned 判题面。
// Capability 包只依赖 @/kernel/*（src/capabilities/AGENTS.md 依赖规则），所以代理/录入/科目
// fixture 的 judge 调用统一从这里取。不承载业务逻辑，只 re-export 下方显式清单里的判题面；
// 清单覆盖当前全部真实消费符号——新增出口必须显式加入清单，禁止 export *。
export {
  createDefaultJudgeInvoker,
  type JudgeInvokerOutput,
} from '@/capabilities/practice/server/judge';
export {
  type JudgeKind,
  type JudgeRouterInput,
  judgeRouter,
  judgeRouterV2,
} from '@/capabilities/practice/server/judge';
export {
  type JudgeAnswerParams,
  type JudgeAnswerResult,
  type JudgeQuestionRow,
  judgeAnswer,
} from '@/capabilities/practice/server/judge';
export type { AnswerInput, JudgeResult } from '@/capabilities/practice/server/judge';
export {
  type MultimodalDirectImageFetchFn,
  type MultimodalDirectRunTaskFn,
  runMultimodalDirectJudge,
} from '@/capabilities/practice/server/judge';
export { defaultImageFetch } from '@/capabilities/practice/server/judge';
export {
  IMAGE_CONSUMING_JUDGE_ROUTES,
  isModelBackedJudgeRoute,
  type JudgeRoute,
  type JudgeRouteQuestionRow,
  MODEL_BACKED_JUDGE_ROUTES,
  resolveQuestionJudgeRoute,
} from '@/capabilities/practice/server/judge';
