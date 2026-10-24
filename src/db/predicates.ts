// Shared `question.draft_status` pool-visibility predicate.
//
// AUDIT-DRAFT-READS: canonical-definition
//   ^ sentinel marker — scripts/audit-draft-status-reads.ts excludes this file from the
//   read-side F1 scan by HELPER_DEF_FILES and reverse-checks THIS marker still exists, so a
//   rename that forgets to update the audit's constant fails loud. Do NOT remove this line.
//
// The fail-open pool-visibility rule (NULL≡active) has one definition here; the read-side
// audit keeps new SELECTs routing through it. See
// docs/design/2026-07-05-draft-status-pool-predicate-dedup-spec.md.

import { type Column, type SQL, isNull, ne, or, sql } from 'drizzle-orm';

import { LEGACY_DRAFT_STATUS } from '@/core/schema/assessment/lifecycle';
import { type question, question_group_lifecycle } from '@/db/schema';

/**
 * 家族-1 fail-open 池可见性谓词（红线-4）：NULL≡active。只有字面 'draft' 不可见，
 * legacy 'active'/'final' 与 NULL 都可见。
 *
 * 不适用于家族-2 精确匹配闸（`=== 'active'` / `=== 'draft'` / `eq(col,'active'|'draft')`，
 * 用于 FSRS 入组 / 编辑权限 / promote / demote / draft-review 池 SELECT），不要合并进来
 * （见 spec §2.2/§2.5）。
 */
export function notDraftPredicate(col: Column): SQL {
  return or(isNull(col), ne(col, LEGACY_DRAFT_STATUS.DRAFT)) as SQL;
}

/**
 * notDraftPredicate 的 JS 孪生：内存行同样只把字面 'draft' 排除在外。
 *
 * 不要用于家族-2 的 promote/入组守卫（那里 `row.draft_status !== 'draft'` 是 fail-closed
 * 状态闸，不是池过滤，spec §2.5）。
 */
export function isPoolVisible(row: { draft_status: string | null }): boolean {
  return row.draft_status !== LEGACY_DRAFT_STATUS.DRAFT;
}

/**
 * 契约准入闸（§3.3）：池候选题不得属于 verify-suspended 或 withdrawn 的 lifecycle group。
 * 读取 `question_group_lifecycle`，按题的 GROUP ROOT id 关联（`COALESCE(parent_question_id, id)`，
 * 与 publishQuestionGroupFromRow 的 root 解析一致，组合题按父组判定）。
 *
 * 切换前桥接语义：缺 lifecycle 行 ⇒ legacy 行 ⇒ 仍由 `draft_status` 单独把关（NOT EXISTS
 * 通过，绝不硬排除未迁移行）。suspend/withdraw 目前都伴随 draft_status='draft'，所以本谓词
 * 在 notDraftPredicate 站点只是双保险；只有非 draft 的 suspended 态落地后才承重。
 *
 * 不适用于必须仍显示 suspended 行的审阅面读取（draft-review、inventory quarantine）。
 */
export function questionSuspendedPredicate(questionTable: typeof question): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${question_group_lifecycle} AS l
    WHERE l.group_id = COALESCE(${questionTable.parent_question_id}, ${questionTable.id})
      AND (l.suspended = true OR l.withdrawn = true)
  )` as SQL;
}
