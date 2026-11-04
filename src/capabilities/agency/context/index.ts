// Context 模块唯一读口（YUK-1794 B1）：按 agent 分 view 的 learner-context 装配。
// 非 agency 消费方走 kernel 端口 `read-models/learner-context`（启动时由
// installAgencyHostOperations 绑定，不产生跨 capability 依赖边）；agency 内
// 部（host-operations、query_context 工具）直接引用本文件。

import type { ContextViewName } from '@/ai/task-spec';
import type { Db, Tx } from '@/db/client';
import type {
  LearnerContextInput,
  LearnerContextResult,
} from '@/kernel/read-models/learner-context';
import { assembleCompanionContext } from './companion';

type DbLike = Db | Tx;

export async function loadLearnerContext(
  db: DbLike,
  input: LearnerContextInput,
): Promise<LearnerContextResult> {
  const view: ContextViewName = input.view;
  switch (view) {
    case 'companion':
      return assembleCompanionContext(db, { now: input.now ?? new Date() });
    default:
      // CONTEXT_VIEWS 目前只有 companion；B2/B3 扩 view 时在同一 switch 上落。
      throw new Error(`learner-context: unregistered view '${String(view)}'`);
  }
}
