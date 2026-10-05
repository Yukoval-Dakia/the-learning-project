// YUK-1052 — evaluation_effective_head 初始行的同事务插入助手。
//
// 原在 src/server/assessment/activate.ts；该模块属 server 编排层，而调用方之一
// saveSubmission 属 practice capability —— capability→server 边界审计禁止此边。
// 本函数只做 schema 行写入（无业务编排），下沉到 db 层后两侧都合法：server
// (activate.ts re-export + activate.db.test.ts) 与 capability (submit.ts) 都经
// @/db/* 引入，不再出现 practice→server 边。

import type { EvaluationGroupIdT, SubmissionIdT } from '@/core/schema/assessment';
import type { Tx } from '@/db/client';
import { evaluation_effective_head } from '@/db/schema';

/**
 * 建 submission/group 时【同事务】插入初始 head 行（§11 首条不变量）。
 * 调用方必须在自己的事务里调用 —— 本函数不自带事务，保证
 * 「submission + group + head」单事务原子。
 */
export async function insertInitialEvaluationHead(
  tx: Tx,
  input: { evaluation_group_id: EvaluationGroupIdT; submission_id: SubmissionIdT; now?: Date },
): Promise<void> {
  await tx.insert(evaluation_effective_head).values({
    evaluation_group_id: input.evaluation_group_id,
    submission_id: input.submission_id,
    effective_evaluation_id: null,
    generation: 0,
    updated_at: input.now ?? new Date(),
  });
}
