import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { learnerLocalDay } from '@/core/learner-day';
import type { Db } from '@/db/client';
import { event, learning_item } from '@/db/schema';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import {
  completionReceiptSummary,
  readStoredCompletionReceipt,
} from '@/kernel/proposals/completion-receipt';
import { readCompletionProposalHistory } from '@/kernel/proposals/inbox';
import { writeAiProposal } from '@/kernel/proposals/writer';
import {
  rethrowNativeMasteryBusy,
  withFencedNativeMasteryRead,
} from '@/kernel/read-models/native-mastery-basis';
import {
  originalCompletionEvidenceStillCurrent,
  readCompletionReceipt,
} from './learning-item-completion-policy';

export async function proposeComputedCompletion(
  db: Db,
  itemId: string,
  caller: { actorRef: string; taskRunId?: string | null; causedByEventId?: string | null },
) {
  return db
    .transaction(
      (tx) =>
        withFencedNativeMasteryRead(tx, async (reader) => {
          const now = new Date();
          const history = await readCompletionProposalHistory(tx);
          // Unverified legacy pending cards cannot claim a v1 slot; real human
          // terminal decisions still constrain consent and re-proposal.
          const sameItem = history.filter(
            (h) => h.itemId === itemId && (h.verifiedReceipt || h.status !== 'pending'),
          );
          const pending = sameItem.find((h) => h.status === 'pending');
          if (pending)
            return {
              status: 'skipped:duplicate_pending' as const,
              proposal_id: pending.id,
              learning_item_id: itemId,
            };
          if (
            history.filter(
              (h) => h.verifiedReceipt && learnerLocalDay(h.proposedAt) === learnerLocalDay(now),
            ).length >= 3
          )
            return { status: 'skipped:budget' as const, learning_item_id: itemId };
          let actionable = 0;
          for (const pending of history.filter((h) => h.status === 'pending')) {
            const original = await readStoredCompletionReceipt(tx, pending.id);
            if (!original) continue;
            const current = await readCompletionReceipt(
              tx,
              reader,
              pending.itemId,
              now,
              original.sources.nodes,
            );
            if (
              current &&
              originalCompletionEvidenceStillCurrent(original, current) &&
              Object.entries(original.sources.epochs).every(
                ([id, epoch]) => current.sources.epochs[id] === epoch,
              )
            )
              actionable++;
            if (actionable >= 3)
              return { status: 'skipped:budget' as const, learning_item_id: itemId };
          }
          const receipt = await readCompletionReceipt(tx, reader, itemId, now);
          if (!receipt)
            return { status: 'skipped:not_eligible' as const, learning_item_id: itemId };
          const latest = sameItem.at(-1);
          if (latest) {
            const previouslyQualified = new Set(sameItem.flatMap((h) => h.qualifyingGroups));
            const newEvidence = receipt.knowledge.some((k) =>
              k.evidence.some(
                (e) =>
                  e.correct &&
                  !previouslyQualified.has(`${k.id}:${e.groupId}`) &&
                  (latest.verifiedReceipt ||
                    (latest.decidedAt !== null && new Date(e.occurredAt) > latest.decidedAt)),
              ),
            );
            if (
              !latest.decidedAt ||
              now.getTime() - latest.decidedAt.getTime() < 7 * 86_400_000 ||
              !newEvidence
            )
              return { status: 'skipped:cooldown' as const, learning_item_id: itemId };
          }
          const proposalId = `completion:${sha256CanonicalJson({ itemId, policy: receipt.policy_version, evidence: receipt.evidence_identity_digest, terminal: latest?.id ?? null })}`;
          const [existing] = await tx
            .select({ id: event.id })
            .from(event)
            .where(eq(event.id, proposalId));
          if (existing) throw new Error('completion identity collision outside decision history');
          await writeAiProposal(tx, {
            id: proposalId,
            actor_ref: caller.actorRef,
            auto_apply_eligible: false,
            payload: {
              kind: 'completion',
              target: { subject_kind: 'learning_item', subject_id: itemId },
              reason_md: completionReceiptSummary(receipt),
              learner_summary: completionReceiptSummary(receipt),
              evidence_refs: [],
              proposed_change: { learning_item_id: itemId, receipt },
              rollback_plan: {
                action:
                  'restore prior learning item state and remove this proposal completion evidence',
              },
              cooldown_key: `completion:${itemId}`,
            },
            task_run_id: caller.taskRunId ?? null,
            caused_by_event_id: caller.causedByEventId ?? null,
            created_at: now,
          });
          return {
            status: 'proposed' as const,
            proposal_id: proposalId,
            learning_item_id: itemId,
            auto_applied: false,
          };
        }),
      { isolationLevel: 'read committed', accessMode: 'read write' },
    )
    .catch(rethrowNativeMasteryBusy);
}

/** Candidate snapshots are only an optimization; each command rechecks under its own fences. */
export async function runLearningItemCompletionNightly(db: Db) {
  let cursor: { id: string; created_at: Date } | undefined;
  let considered = 0;
  let proposed = 0;
  for (;;) {
    const after = cursor;
    const items = await db.transaction(
      (tx) =>
        tx
          .select({ id: learning_item.id, created_at: learning_item.created_at })
          .from(learning_item)
          .where(
            and(
              isNull(learning_item.archived_at),
              inArray(learning_item.status, ['pending', 'in_progress']),
              after
                ? or(
                    gt(learning_item.created_at, after.created_at),
                    and(
                      eq(learning_item.created_at, after.created_at),
                      gt(learning_item.id, after.id),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(asc(learning_item.created_at), asc(learning_item.id))
          .limit(32),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    if (!items.length) return { considered, proposed };
    for (const item of items) {
      const result = await proposeComputedCompletion(db, item.id, {
        actorRef: 'learning_item_completion_nightly',
      });
      considered += 1;
      if (result.status === 'proposed') proposed += 1;
      if (result.status === 'skipped:budget') return { considered, proposed };
    }
    cursor = items.at(-1);
  }
}
