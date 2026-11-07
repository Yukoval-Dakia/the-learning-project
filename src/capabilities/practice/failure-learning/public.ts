// 错因学习 owner 的稳定业务操作。practice 内其它 owner 只经本文件引用本 owner
// （`pnpm audit:practice-subowners`）；条目随本 owner 的文件迁入。
// task spec 静态导出，供 tasks/index 组合（task 目录不得初始化服务端运行时）；
// 服务端操作在调用时才加载。
export type { FailureLearningBossSend } from './jobs/failure-learning-jobs';
export type {
  ProposeFailureVariantInput,
  VariantProposalResult,
} from './server/failure-learning-public';
export { attributionRerankTaskSpec, attributionTaskSpec } from './tasks/attribution';
export { causeCategoryProposeTaskSpec } from './tasks/cause-category-propose';
export { variantGenTaskSpec } from './tasks/variant-gen';

export const proposeFailureVariant: typeof import('./server/failure-learning-public').proposeFailureVariant =
  async (...args) =>
    (await import('./server/failure-learning-public')).proposeFailureVariant(...args);

export const resolveAdviceCauseForQuestion: typeof import('./server/cause-context').resolveAdviceCauseForQuestion =
  async (...args) =>
    (await import('./server/cause-context')).resolveAdviceCauseForQuestion(...args);

export const backtraceContext: typeof import('./server/backtrace-read').backtraceContext = async (
  ...args
) => (await import('./server/backtrace-read')).backtraceContext(...args);
export { causeCategoryUndoGuard } from './server/cause-category-undo-guard';
export { knowledgeNodesWithMisconceptionEdges } from './server/undo-usage';
