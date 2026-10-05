import { z } from 'zod';

import { AttemptQuestionSnapshot } from '../schema/question-evidence-snapshot';

// ====================================================================
// YUK-1048 — 历史冻结输入/判词的契约校验（review 终轮 P1-1）
// ====================================================================
//
// 「complete」必须建立在【被识别且自洽】的冻结输入与判词上，不接受
// 存在性检查：
//   - durable 冻结输入：镜像生产契约 FrozenQuestionSnapshotSchema
//     （src/capabilities/practice/server/judge-run-payload.ts:103–119）。
//     core 不得 import capability，故在此逐字段镜像；镜像与生产 schema 的
//     一致性由 src/capabilities/practice/server/frozen-snapshot-parity.db.test.ts
//     （同语料双方 safeParse 必须同判）钉死 —— 那个测试住在 capability 侧
//     （可 import 生产 schema），漂移即红。
//   - attempt/review 事件快照：直接用 core 的 AttemptQuestionSnapshot。
//   - 判词：直接用 core 的 JudgeResultV2 判别式域（coarse_outcome × score
//     必须成对落在真实分支上 —— {score:false, coarse_outcome:'bogus'} 这类
//     存在性冒充在此被拒）。
//   - 快照身份绑定 occurrence：attempt 的快照 question_id 必须等于其
//     subject_id；durable pending 的 submit.question_id 必须等于回填 review
//     的 subject_id（跨题快照不可用作 issuance）。

const JsonObjectSchema = z.record(z.string(), z.unknown());

/**
 * 生产契约 FrozenQuestionSnapshotSchema 的迁移侧镜像（逐字段一致；parity
 * 测试钉死）。作答当下的题面冻结子集 —— durable 判分输入的 issued snapshot。
 */
export const FrozenQuestionSnapshotMigration = z.object({
  kind: z.string(),
  prompt_md: z.string(),
  reference_md: z.string().nullable(),
  rubric_json: JsonObjectSchema.nullable(),
  choices_md: z.array(z.string()).nullable(),
  judge_kind_override: z.string().nullable(),
  knowledge_ids: z.array(z.string()),
  difficulty: z.number(),
  metadata: JsonObjectSchema.nullable(),
  figures: z.array(JsonObjectSchema),
  image_refs: z.array(z.string()),
  structured: JsonObjectSchema.nullable(),
  version: z.number(),
  updated_at: z.string(),
});
export type FrozenQuestionSnapshotMigrationT = z.infer<typeof FrozenQuestionSnapshotMigration>;

export type ValidationIssue = { ok: boolean; reason: string };

export const OK: ValidationIssue = { ok: true, reason: '' };

/** attempt/solve_tutor 事件的 issued snapshot：真实契约 + 身份绑定。 */
export function validateAttemptSnapshot(
  snapshot: unknown,
  anchorQuestionId: string,
): ValidationIssue {
  if (snapshot == null) {
    return { ok: false, reason: 'attempt payload 无 question_snapshot —— 缺 issued snapshot' };
  }
  const parsed = AttemptQuestionSnapshot.safeParse(snapshot);
  if (!parsed.success) {
    return {
      ok: false,
      reason:
        'question_snapshot 不符合 AttemptQuestionSnapshot 冻结契约（question-evidence-snapshot.ts）—— 形状不识别',
    };
  }
  if (parsed.data.question.question_id !== anchorQuestionId) {
    return {
      ok: false,
      reason: `快照身份不绑定本次 occurrence：snapshot.question.question_id='${parsed.data.question.question_id}' ≠ attempt.subject_id='${anchorQuestionId}'（跨题快照不可用作 issuance）`,
    };
  }
  return OK;
}

/** durable pending 输入的冻结 snapshot：镜像契约 + 身份绑定。 */
export function validateDurableSnapshot(
  pendingPayload: { submit?: unknown },
  anchorQuestionId: string,
): ValidationIssue {
  const submit =
    pendingPayload.submit !== null && typeof pendingPayload.submit === 'object'
      ? (pendingPayload.submit as Record<string, unknown>)
      : {};
  const snapshot = submit.question_snapshot;
  if (snapshot == null) {
    return {
      ok: false,
      reason:
        'durable pending 输入无冻结 question_snapshot（pre-snapshot payload —— worker 曾按【当前】题行判分，judge-run-payload legacy 读活行路径）—— 无法重构当时 issuance',
    };
  }
  const parsed = FrozenQuestionSnapshotMigration.safeParse(snapshot);
  if (!parsed.success) {
    return {
      ok: false,
      reason:
        'durable 冻结 snapshot 不符合 FrozenQuestionSnapshot 契约（judge-run-payload.ts 镜像；字段不全/类型不符）',
    };
  }
  const submitQuestionId = submit.question_id;
  if (typeof submitQuestionId !== 'string' || submitQuestionId !== anchorQuestionId) {
    return {
      ok: false,
      reason: `durable 输入身份不绑定回填锚：submit.question_id='${String(submitQuestionId)}' ≠ review.subject_id='${anchorQuestionId}'`,
    };
  }
  return OK;
}

export type VerdictStatus = 'valid' | 'invalid' | 'absent';

/**
 * 判词校验（真实值域，P1-1）：coarse_outcome × score 必须成对落在
 * JudgeResultV2 的判别分支上：
 *   correct: score ∈ [0.85,1]；partial: score ∈ (0,0.85)；
 *   incorrect: score === 0；unsupported: score null/缺省。
 * 存在性冒充（coarse_outcome:'bogus'、score:false）⇒ invalid —— 判分记录
 * 视为损坏，不可作为 complete/head 依据。
 */
export function verdictStatus(payload: {
  coarse_outcome?: unknown;
  score?: unknown;
}): VerdictStatus {
  const coarse = payload.coarse_outcome;
  const score = payload.score;
  const coarsePresent = coarse !== undefined && coarse !== null;
  const scorePresent = score !== undefined && score !== null;
  if (!coarsePresent && !scorePresent) return 'absent';

  const branchOk = (expected: string, scoreCheck: (s: unknown) => boolean): boolean =>
    coarse === expected &&
    (score === undefined || score === null ? expected === 'unsupported' : scoreCheck(score));

  const valid =
    typeof coarse === 'string' &&
    (branchOk('correct', (s) => typeof s === 'number' && s >= 0.85 && s <= 1) ||
      branchOk('partial', (s) => typeof s === 'number' && s > 0 && s < 0.85) ||
      branchOk('incorrect', (s) => typeof s === 'number' && s === 0) ||
      branchOk('unsupported', () => false));
  if (valid) return 'valid';

  // score 单独在而 coarse_outcome 缺：判分事件 payload 契约（JudgeOnEvent）以
  // coarse_outcome 为判别式 —— 仅 score 不能构成可迁移判词。
  return 'invalid';
}

/**
 * embedded judge 块判词校验：块内 coarse_outcome × score 同样过 JudgeResultV2
 * 分支（solve_tutor 的 judge_score 与块内 coarse_outcome 配对）。
 */
export function embeddedVerdictStatus(
  judgeBlock: { coarse_outcome?: unknown; score?: unknown } | null | undefined,
  extraScore?: unknown,
): VerdictStatus {
  const block = judgeBlock ?? {};
  const coarse = block.coarse_outcome;
  const score = block.score !== undefined && block.score !== null ? block.score : extraScore;
  return verdictStatus({ coarse_outcome: coarse, score });
}
