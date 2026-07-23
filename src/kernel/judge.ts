// 内核 judge facade（薄壳，YUK-589）— 包装遗留 @/server/judge/*。Capability 包
// 只依赖 @/kernel/*（src/capabilities/AGENTS.md 依赖规则），所以练习/代理域的
// judge 调用统一从这里取 invoker / route 解析 / 执行 provenance / preview token。
// 不承载业务逻辑，只 re-export 被 sanctioned 的判题面。
export {
  createDefaultJudgeInvoker,
  type JudgeInvokerOutput,
} from '@/server/judge/invoker';
export {
  deterministicExecutionProvenance,
  historicalUnknownExecutionProvenance,
  type JudgeExecutionIdentity,
  modelExecutionProvenance,
  suppliedUnverifiedExecutionProvenance,
} from '@/server/judge/execution-provenance-resolve';
export {
  sha256Canonical,
  taskInputHash,
} from '@/server/judge/judge-execution-provenance';
export {
  issueJudgePreviewProvenanceToken,
  judgeProvenanceSigningSecret,
  verifyJudgePreviewProvenanceToken,
} from '@/server/judge/preview-provenance-token';
export {
  IMAGE_CONSUMING_JUDGE_ROUTES,
  type JudgeRoute,
  type JudgeRouteQuestionRow,
  resolveQuestionJudgeRoute,
} from '@/server/judge/route-resolve';
