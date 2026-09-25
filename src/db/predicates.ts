// Shared `question.draft_status` pool-visibility predicate (YUK-569 / YUK-538 #14).
//
// AUDIT-DRAFT-READS: canonical-definition
//   ^ sentinel marker — scripts/audit-draft-status-reads.ts excludes this file from the
//   read-side F1 scan by HELPER_DEF_FILES and reverse-checks THIS marker still exists, so a
//   rename that forgets to update the audit's constant fails loud instead of silently
//   re-flagging (or missing) the canonical predicate. Do NOT remove this line.
//
// The fail-open pool-visibility rule (红线-4, NULL≡active) is a single invariant that was
// hand-copied across 19 code sites in 4 dialects with zero shared export. This module is its
// one definition; the read-side audit keeps new SELECTs routing through it. See
// docs/design/2026-07-05-draft-status-pool-predicate-dedup-spec.md.

import { type Column, type SQL, isNull, ne, or, sql } from 'drizzle-orm';

import { type question, question_group_lifecycle } from '@/db/schema';

/**
 * Family-1 fail-open pool-visibility predicate (红线-4): NULL≡active.
 * A row is POOL-VISIBLE unless it is literally 'draft'. Legacy 'active'/'final'
 * and NULL all stay visible.
 *
 * NOT for family-2 exact-match gates — `=== 'active'` / `=== 'draft'` /
 * `eq(col,'active'|'draft')` — which gate FSRS-enroll / edit-perm / promote /
 * demote / draft-review-pool SELECT. Never fold those in (see
 * docs/design/2026-07-05-draft-status-pool-predicate-dedup-spec.md §2.2/§2.5).
 */
export function notDraftPredicate(col: Column): SQL {
  return or(isNull(col), ne(col, 'draft')) as SQL;
}

/**
 * JS twin of notDraftPredicate: an in-memory row is POOL-VISIBLE (红线-4,
 * NULL≡active, only literal 'draft' excluded).
 *
 * Do NOT apply to family-2 promote/enroll guards that also read
 * `row.draft_status !== 'draft'` — those are fail-closed state gates, not
 * pool filters (spec §2.5).
 */
export function isPoolVisible(row: { draft_status: string | null }): boolean {
  return row.draft_status !== 'draft';
}

/**
 * YUK-1045 — contract admission gate (§3.3): a pool-candidate question must not
 * belong to a lifecycle group that is verify-suspended or withdrawn. Reads
 * consult `question_group_lifecycle` (joined on the question's GROUP ROOT id —
 * `COALESCE(parent_question_id, id)` so composite parts gate on their parent
 * group, matching publishQuestionGroupFromRow's root resolution).
 *
 * Bridge semantics pre-cutover (YUK-1059): absent lifecycle row ⇒ legacy row ⇒
 * `draft_status` remains the sole gate (NOT EXISTS passes — never hard-exclude
 * un-migrated rows). suspend/withdraw always pairs with draft_status='draft'
 * today, so this predicate is belt-and-braces inside notDraftPredicate sites —
 * it becomes load-bearing only if a non-draft suspended state ever lands.
 *
 * NOT for review-surface reads (draft-review, inventory quarantine display)
 * that must still SHOW suspended rows.
 */
export function questionSuspendedPredicate(questionTable: typeof question): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${question_group_lifecycle} AS l
    WHERE l.group_id = COALESCE(${questionTable.parent_question_id}, ${questionTable.id})
      AND (l.suspended = true OR l.withdrawn = true)
  )` as SQL;
}
