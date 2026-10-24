// evaluation_effective_head 初始行的同事务插入助手。
//
// 放在 db 层而不是 server 编排层：调用方 saveSubmission 属 practice capability，
// capability→server 的边被边界审计禁止，而本函数只写 schema 行、无业务编排。

import type { EvaluationGroupIdT, SubmissionIdT } from '@/core/schema/assessment';
import type { Tx } from '@/db/client';
import { evaluation_effective_head } from '@/db/schema';

/**
 * 建 submission/group 时【同事务】插入初始 head 行。调用方必须已在事务里调用，
 * 本函数不自带事务，保证「submission + group + head」单事务原子。
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
