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
import { assembleCoachContext } from './coach';
import { assembleCompanionContext } from './companion';

type DbLike = Db | Tx;

export async function loadLearnerContext(
  db: DbLike,
  input: LearnerContextInput,
): Promise<LearnerContextResult> {
  const view: ContextViewName = input.view;
  switch (view) {
    case 'curator':
    case 'companion':
      return assembleCompanionContext(db, {
        now: input.now ?? new Date(),
        budget: view === 'curator' ? 800 : 1000,
        view,
      });
    case 'coach':
      // YUK-1790 LIGHT — the planner's own view; it does not borrow companion/curator.
      return assembleCoachContext(db, { now: input.now ?? new Date() });
    default:
      // Every declared view must have an assembler here.
      throw new Error(`learner-context: unregistered view '${String(view)}'`);
  }
}
