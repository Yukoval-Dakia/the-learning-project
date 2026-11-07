// Later-content rules for undoing an auto-applied `cause_category`.
//
// The overlay row is the only thing accept writes, so the guard reads that row
// and then asks failure-learning's own attribution ledger whether a later judge
// or user-cause decision already cites the category. A cited category is
// load-bearing history: retracting it makes later variant generation treat the
// cause as not targetable.

import { and, eq, inArray, sql } from 'drizzle-orm';

import type { AiProposalPayloadT } from '@/core/schema/proposal';
import type { Tx } from '@/db/client';
import { event } from '@/db/schema';
import { cause_category_overlay } from '@/db/schema/knowledge';
import {
  AUTO_APPLIED_UNDO_CLEAR,
  type AutoAppliedUndoBlock,
  type AutoAppliedUndoGuardInput,
  type AutoAppliedUndoGuardVerdict,
  type AutoAppliedUndoOwnerGuard,
  type DbLike,
  genericUndoBlock,
} from '@/kernel/proposals/auto-applied-undo';

const REASONS = {
  cause_not_found: '这个错因类目已经找不到了。',
  cause_not_owned: '这个错因类目已经不由这条改动负责，不能再撤销。',
  cause_already_archived: '这个错因类目已经被归档，不需要再撤销。',
  cause_not_active: '这个错因类目当前不在词表里，不能撤销。',
  cause_used_in_attribution: '已经有错因判定用了这个类目，撤销会让这些判定失去解释，所以先保留了。',
} as const;

type CauseBlockCode = keyof typeof REASONS;

function block(code: CauseBlockCode): AutoAppliedUndoBlock {
  return { status: 'blocked', code, reason_md: REASONS[code] };
}

function categoryIdOf(payload: AiProposalPayloadT): string | null {
  if (payload.kind !== 'cause_category') return null;
  const change = payload.proposed_change;
  const value =
    change && typeof change === 'object'
      ? (change as Record<string, unknown>).category_id
      : undefined;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

interface CauseCheck {
  readonly proposalId: string;
  readonly categoryId: string;
}

async function inspectCauseCategories(
  db: DbLike,
  inputs: readonly AutoAppliedUndoGuardInput[],
): Promise<Map<string, AutoAppliedUndoGuardVerdict>> {
  const verdicts = new Map<string, AutoAppliedUndoGuardVerdict>();
  const checks: CauseCheck[] = [];
  for (const input of inputs) {
    const categoryId = categoryIdOf(input.payload);
    if (!categoryId) {
      verdicts.set(input.proposalId, genericUndoBlock('failed', 'apply_record_missing'));
      continue;
    }
    checks.push({ proposalId: input.proposalId, categoryId });
  }
  if (checks.length === 0) return verdicts;

  const categoryIds = [...new Set(checks.map((check) => check.categoryId))];
  const rows = await db
    .select({
      id: cause_category_overlay.id,
      status: cause_category_overlay.status,
      archivedAt: cause_category_overlay.archived_at,
      proposalEventId: cause_category_overlay.proposal_event_id,
    })
    .from(cause_category_overlay)
    .where(inArray(cause_category_overlay.id, categoryIds));
  const rowById = new Map(rows.map((row) => [row.id, row]));

  // Judge events store the cause under `cause`; manual user causes store it at
  // the payload root.
  const usedCategoryIds = new Set<string>();
  for (const categoryId of categoryIds) {
    const [hit] = await db
      .select({ id: event.id })
      .from(event)
      .where(
        and(
          inArray(event.action, ['judge', 'experimental:user_cause']),
          sql`(
            ${event.payload} -> 'cause' ->> 'primary_category' = ${categoryId}
            OR ${event.payload} -> 'cause' -> 'secondary_categories' ? ${categoryId}
            OR ${event.payload} ->> 'primary_category' = ${categoryId}
          )`,
        ),
      )
      .limit(1);
    if (hit) usedCategoryIds.add(categoryId);
  }

  for (const check of checks) {
    const row = rowById.get(check.categoryId);
    if (!row) {
      verdicts.set(check.proposalId, block('cause_not_found'));
      continue;
    }
    if (row.proposalEventId !== check.proposalId) {
      verdicts.set(check.proposalId, block('cause_not_owned'));
      continue;
    }
    if (row.archivedAt !== null) {
      verdicts.set(check.proposalId, block('cause_already_archived'));
      continue;
    }
    if (row.status !== 'active') {
      verdicts.set(check.proposalId, block('cause_not_active'));
      continue;
    }
    if (usedCategoryIds.has(check.categoryId)) {
      verdicts.set(check.proposalId, block('cause_used_in_attribution'));
    }
    if (!verdicts.has(check.proposalId)) {
      verdicts.set(check.proposalId, AUTO_APPLIED_UNDO_CLEAR);
    }
  }
  return verdicts;
}

async function lockCauseCategory(tx: Tx, input: AutoAppliedUndoGuardInput): Promise<void> {
  const categoryId = categoryIdOf(input.payload);
  if (!categoryId) return;
  await tx
    .select({ id: cause_category_overlay.id })
    .from(cause_category_overlay)
    .where(eq(cause_category_overlay.id, categoryId))
    .for('update');
}

export const causeCategoryUndoGuard: AutoAppliedUndoOwnerGuard = {
  inspect: inspectCauseCategories,
  lock: lockCauseCategory,
};
