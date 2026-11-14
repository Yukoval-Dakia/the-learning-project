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
import { getCorrectionStatusesWithReceipts } from '@/kernel/events';
import {
  lockEventCorrectionSource,
  lockEventCorrectionsAll,
} from '@/kernel/events/correction-lock';
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
  relabelled_original_learner_corrected:
    '这条改动回标过的原始判定后来被你更正过，撤销会覆盖那次更正，所以先保留了。',
  relabelled_replacement_learner_corrected:
    '这条改动写入的回标后来被你更正过，撤销会覆盖那次更正，所以先保留了。',
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
  /** Event ids this accept's own effect materialized; not "later" content. */
  readonly ownEventIds: ReadonlySet<string>;
  /** Original → replacement event pairs the accept wrote. */
  readonly relabelledPairs: readonly RelabelledPair[];
}

/** Own relabel rows are part of this accept; counting them as later use would block every undo. */
function ownRelabelEventIds(ratePayload: unknown): ReadonlySet<string> {
  const outcomes = (ratePayload as { relabel_outcomes?: unknown } | undefined)?.relabel_outcomes;
  const ids = new Set<string>();
  if (!Array.isArray(outcomes)) return ids;
  for (const outcome of outcomes) {
    if (!outcome || typeof outcome !== 'object') continue;
    for (const key of [
      'replacement_event_id',
      'correction_event_id',
      'original_event_id',
    ] as const) {
      const value = (outcome as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.length > 0) ids.add(value);
    }
  }
  return ids;
}

interface RelabelledPair {
  readonly originalId: string;
  readonly replacementId: string | null;
  readonly supersedeCorrectionId: string | null;
}

/** Original → replacement pairs this accept materialized, for the learner-correction block. */
function ownRelabelledPairs(ratePayload: unknown): RelabelledPair[] {
  const outcomes = (ratePayload as { relabel_outcomes?: unknown } | undefined)?.relabel_outcomes;
  const pairs: RelabelledPair[] = [];
  if (!Array.isArray(outcomes)) return pairs;
  for (const outcome of outcomes) {
    if (!outcome || typeof outcome !== 'object') continue;
    if ((outcome as { status?: unknown }).status !== 'relabelled') continue;
    const originalId = (outcome as Record<string, unknown>).original_event_id;
    const replacementId = (outcome as Record<string, unknown>).replacement_event_id;
    const supersedeCorrectionId = (outcome as Record<string, unknown>).correction_event_id;
    if (typeof originalId === 'string' && originalId.length > 0) {
      pairs.push({
        originalId,
        replacementId:
          typeof replacementId === 'string' && replacementId.length > 0 ? replacementId : null,
        supersedeCorrectionId:
          typeof supersedeCorrectionId === 'string' && supersedeCorrectionId.length > 0
            ? supersedeCorrectionId
            : null,
      });
    }
  }
  return pairs;
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
    checks.push({
      proposalId: input.proposalId,
      categoryId,
      ownEventIds: ownRelabelEventIds(input.ratePayload),
      relabelledPairs: ownRelabelledPairs(input.ratePayload),
    });
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
  const usedCategoryIds = new Map<string, Set<string>>();
  for (const check of checks) {
    const categoryId = check.categoryId;
    if (usedCategoryIds.has(categoryId)) continue;
    // The hit could be one of this accept's own replacement rows. A second scan
    // scoped to non-own rows distinguishes a genuinely-later independent
    // citation from the accept's own materialization — only the former blocks.
    const citingRows = await db
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
      );
    const ids = new Set(citingRows.map((row) => row.id));
    usedCategoryIds.set(categoryId, ids);
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
    const citingIds = usedCategoryIds.get(check.categoryId);
    const hasIndependentUse =
      citingIds !== undefined && [...citingIds].some((id) => !check.ownEventIds.has(id));
    if (hasIndependentUse) {
      verdicts.set(check.proposalId, block('cause_used_in_attribution'));
    }
    if (!verdicts.has(check.proposalId) && check.relabelledPairs.length > 0) {
      // Canonical fold, under the correction locks the retract applier also
      // holds: the winning receipt id per target. An original is safe to
      // restore only when its winning receipt is exactly this accept's own
      // supersede — any later learner mark_wrong/retract/restore makes a
      // different receipt the winner, and restoring over it would erase that
      // learner truth. A replacement is safe to retract only while it still
      // has no winning correction. Either case makes undo refuse.
      const targetIds = check.relabelledPairs.flatMap((pair) =>
        pair.replacementId ? [pair.originalId, pair.replacementId] : [pair.originalId],
      );
      const receipts = await getCorrectionStatusesWithReceipts(db, targetIds);
      const originalLearnerCorrected = check.relabelledPairs.some((pair) => {
        const receipt = receipts.get(pair.originalId);
        return (
          receipt?.status.state !== 'superseded' ||
          receipt.status.correction_event_id !== pair.supersedeCorrectionId ||
          receipt.winning_correction_event_id !== pair.supersedeCorrectionId
        );
      });
      if (originalLearnerCorrected) {
        verdicts.set(check.proposalId, block('relabelled_original_learner_corrected'));
      } else {
        const replacementLearnerCorrected = check.relabelledPairs.some((pair) => {
          const replacementId = pair.replacementId;
          if (!replacementId) return false;
          const receipt = receipts.get(replacementId);
          return receipt?.status.state !== 'active' || receipt.winning_correction_event_id !== null;
        });
        if (replacementLearnerCorrected) {
          verdicts.set(check.proposalId, block('relabelled_replacement_learner_corrected'));
        }
      }
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
  // Take the canonical correction locks for every event this accept's relabel
  // touched, in the same order the accept and writeEvents use. The in-transaction
  // inspect that follows reads correction state under these locks; a concurrent
  // learner correction on a superseded original or a replacement waits here
  // instead of sneaking past the recheck.
  const pairs = ownRelabelledPairs(input.ratePayload);
  const targetIds = [
    ...new Set(
      pairs.flatMap((pair) =>
        pair.replacementId ? [pair.originalId, pair.replacementId] : [pair.originalId],
      ),
    ),
  ].sort();
  if (targetIds.length > 0) {
    await lockEventCorrectionsAll(tx);
    for (const targetId of targetIds) {
      await lockEventCorrectionSource(tx, targetId);
    }
  }
}

export const causeCategoryUndoGuard: AutoAppliedUndoOwnerGuard = {
  inspect: inspectCauseCategories,
  lock: lockCauseCategory,
};
