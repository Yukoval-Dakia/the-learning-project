// YUK-1468 — compat shim。`store_sourced_question` 工具面已并入 `submit_question`
// （./submit-question.ts，注册名 `submit_question`）；本模块只为既有内部函数
// 调用方（question-supply/plan-executor、jyeoo-backfill、db 测试）保留
// `executeStoreSourcedQuestion` / `StoreSourcedQuestionDeps` 的 import 位。
// 不再有 `store_sourced_question` DomainTool 注册或 allowlist 授权。

export {
  type StoreSourcedQuestionDeps,
  executeStoreSourcedQuestion,
  submitQuestionTool,
} from './submit-question';
