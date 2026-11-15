// Post-answer incremental rerank (softmax_mfi only), extracted from stream-store.ts.
// Answering moves θ̂ for the sealed KCs (legacy: question knowledge_ids), changing the MFI weight
// p(1−p), p=σ(θ̂−b), of pending non-due diagnostic items. Rerank those items with the
// fresh θ̂ using the statistical sampler only: no whole-stream rebuild and no LLM call
// (LLM item weights are not persisted, so recomputing mfiScore is the cheapest correct
// weight).
// Scope and shape:
// - The candidate pool uses compose's eligible variant/new_check sources, restricted
// to affected KCs and excluding frozen refs. targetCount is the number of replaceable pending
// slots, not the pool size, so sampling is real IPPS (π_i < 1).
// - Only items touching the answered question's KCs are reranked. Unrelated pending
// items, paper rows, recall-locked rows, and done/in_progress/skipped rows stay
// frozen: not deleted, not moved, not re-sampled. Only legacy completion also
// retires stale pending decay rows before rerank.
// - A row whose snapshot is not recall-locked but whose fresh classification is recall
// stays in place (fail-closed); never drop it into a freed slot.
// - Sample sizes fluctuate. Delete only slots that will actually be refilled
// (min(new refs, replaceable slots), lowest position first) and keep the rest, so the
// stream never shrinks or leaves position holes.
// - Record π_i only for rows that really inserted (post-commit, best-effort); kept slots
// reuse their original observation.
// - Reuse the `stream:compose:<date>` advisory lock, so rerank never races compose.
// - Frozen and kept rows keep their exact positions; new items fill freed slots first,
// then append after max(position). This deliberately differs from materializeStream's
// full renumber, which recompose semantics allow.

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { practice_stream_item, question } from '@/db/schema';
import { lockPracticeStreamPartition } from '@/kernel/locks/practice-stream';
import { DEFAULT_TEMPERATURE } from '../../server/selection-constants';
import { type CollectedSignal, collectCandidateSignals } from './candidate-signals';
import {
  type SelectionObservationInput,
  recordSelectionObservation,
} from './selection-observations';
import { sampleByWeight } from './selection-sampler';
import { statisticalWeights } from './selection-weights';
import { withdrawStalePendingDueLines } from './stale-due-lines';
import { collectComposerInputs } from './stream-inputs';
import { presentNonDueQuestion } from './stream-item-presentation';
import { planStreamReplacement, prepareStreamReplacement } from './stream-replacement-plan';
import { readStreamSelectionCandidates } from './stream-selection-candidates';
import { isUploadPracticeRow } from './upload-ready';

type DbLike = Db | Tx;

interface ComposeOutcome {
  added: number;
  observations: SelectionObservationInput[];
}

// Same physical-partition predicate as stale-due-lines.ts and stream-store.ts:
// session_id selects the scoped partition, NULL the daily one. Duplicated
// rather than imported so this module stays a leaf (stream-store re-exports
// reRankAfterAnswer for the existing import path).
function streamPartitionPredicate(date: string, sessionId?: string | null) {
  return sessionId
    ? and(eq(practice_stream_item.date, date), eq(practice_stream_item.session_id, sessionId))
    : and(eq(practice_stream_item.date, date), isNull(practice_stream_item.session_id));
}

async function writeObservationsBestEffort(
  db: DbLike,
  observations: SelectionObservationInput[],
): Promise<void> {
  for (const obs of observations) {
    try {
      await recordSelectionObservation(db, obs);
    } catch (err) {
      console.error('[stream-store] recordSelectionObservation failed (post-commit, best-effort)', {
        refId: obs.refId,
        pi: obs.inclusionProbability,
        err,
      });
    }
  }
}

/** 从 practice_stream_item.signals 快照读 recallLocked。 */
function rowIsRecallLocked(signals: unknown): boolean {
  return (signals as { recallLocked?: unknown } | null)?.recallLocked === true;
}

/**
 * Bounded statistical rerank with fresh theta, without LLM work. Database failures
 * propagate to the caller's transaction/recovery boundary; no affected slots is a no-op.
 *
 * @param opts.affectedKnowledgeIds Settlement callers supply sealed, actually updated KCs.
 * Omission preserves the legacy question-label lookup.
 * @param opts.rng 注入 rng（测试确定化）；省略 → sampleByWeight 默认 Math.random。
 * @returns 本轮新物化（重抽样落库）的非到期项数；no-op 时 0。
 */
export async function reRankAfterAnswer(
  db: DbLike,
  opts: {
    date: string;
    sessionId?: string | null;
    answeredQuestionId: string;
    affectedKnowledgeIds?: readonly string[];
    observations?: SelectionObservationInput[];
    rng?: () => number;
  },
): Promise<number> {
  const { date, sessionId, answeredQuestionId } = opts;

  let affected = opts.affectedKnowledgeIds;
  if (affected === undefined) {
    const [answered] = await db
      .select({ knowledge_ids: question.knowledge_ids })
      .from(question)
      .where(eq(question.id, answeredQuestionId))
      .limit(1);
    affected = answered?.knowledge_ids ?? [];
  }
  const affectedKnowledgeIds = new Set(affected.filter(Boolean));

  const { added, observations } = await db.transaction(async (tx) => {
    // Same key as every compose path, so rerank cannot race lazy/recompose/nightly.
    await lockPracticeStreamPartition(tx, date, sessionId);
    // Legacy completion also retires stale due rows. Settlement delivery changes
    // only diagnostic slots and preserves the rest of the partition.
    if (opts.affectedKnowledgeIds === undefined)
      await withdrawStalePendingDueLines(tx, date, sessionId);

    const rows = await tx
      .select()
      .from(practice_stream_item)
      .where(streamPartitionPredicate(date, sessionId))
      .orderBy(asc(practice_stream_item.position));
    if (affectedKnowledgeIds.size === 0 || rows.length === 0) {
      return { added: 0, observations: [] } satisfies ComposeOutcome;
    }

    // Rerank scope: pending question items from variant/new_check whose snapshot is not
    // recall-locked. Frontier items are sampled at compose time but excluded here:
    // frontier signals structural reachability, not θ̂ diagnostics, so answering must
    // not churn them. Changing either side must preserve that split.
    const allPendingNonDue = rows.filter(
      (r) =>
        r.status === 'pending' &&
        r.ref_id !== answeredQuestionId &&
        r.item_kind === 'question' &&
        (r.source === 'variant' || r.source === 'new_check') &&
        !rowIsRecallLocked(r.signals) &&
        !isUploadPracticeRow(r),
    );
    // 无待做非到期诊断行 → no-op（不动流、不写观测）。
    if (allPendingNonDue.length === 0)
      return { added: 0, observations: [] } satisfies ComposeOutcome;

    // Narrow scope to rows touching the answered question's KCs. Answering KC-A must not
    // churn an unrelated KC-B slot; untouched pending rows stay frozen.
    const pendingNonDueQids = [...new Set(allPendingNonDue.map((r) => r.ref_id))];
    const pendingQRows =
      pendingNonDueQids.length === 0
        ? []
        : await tx
            .select({ id: question.id, knowledge_ids: question.knowledge_ids })
            .from(question)
            .where(inArray(question.id, pendingNonDueQids));
    const pendingKidsByQid = new Map(pendingQRows.map((q) => [q.id, q.knowledge_ids ?? []]));
    const pendingNonDue = allPendingNonDue.filter((r) =>
      (pendingKidsByQid.get(r.ref_id) ?? []).some((k) => affectedKnowledgeIds.has(k)),
    );
    // 答完题的 KC 不触及任何待做非到期行 → 无可重排的 slot → no-op（不 churn 无关 slot）。
    if (pendingNonDue.length === 0) return { added: 0, observations: [] } satisfies ComposeOutcome;

    // Candidate pool is the full eligible non-due pool from compose; due and paper rows
    // stay frozen.
    const composerInputs = await collectComposerInputs(tx, date);
    const poolRaws = [
      ...composerInputs.variantItems.map((v) => ({
        questionId: v.questionId,
        source: 'variant' as const,
        knowledgeLabel: v.knowledgeLabel,
      })),
      ...composerInputs.newCheckItems.map((n) => ({
        questionId: n.questionId,
        source: 'new_check' as const,
        knowledgeLabel: n.knowledgeLabel,
      })),
    ];

    // Everything outside the affected pending non-due scope is frozen: excluded from the
    // pool and never moved or re-sampled.
    const pendingNonDueRefs = new Set(pendingNonDue.map((r) => r.ref_id));
    const frozenRefs = new Set(
      rows.filter((r) => !pendingNonDueRefs.has(r.ref_id)).map((r) => r.ref_id),
    );

    // Exclude frozen refs and dedup in memory; the unique index is the backstop.
    const seenPool = new Set<string>();
    const eligibleRaws = poolRaws.filter(
      (r) =>
        !frozenRefs.has(r.questionId) && !seenPool.has(r.questionId) && seenPool.add(r.questionId),
    );
    if (eligibleRaws.length === 0) return { added: 0, observations: [] } satisfies ComposeOutcome;

    const candidates = await readStreamSelectionCandidates(
      tx,
      eligibleRaws.map((r) => ({ questionId: r.questionId, role: r.source })),
    );
    const candidateInputs = candidates.filter((candidate) =>
      (candidate.knowledgeIds ?? []).some((k) => affectedKnowledgeIds.has(k)),
    );

    // Rerank only when the eligible pool touches an affected KC.
    const poolTouchesAffected = candidateInputs.some((candidate) =>
      (candidate.knowledgeIds ?? []).some((k) => affectedKnowledgeIds.has(k)),
    );
    if (!poolTouchesAffected) return { added: 0, observations: [] } satisfies ComposeOutcome;

    // Fresh θ̂: collectCandidateSignals reads current mastery_state.
    const sourceByRef = new Map(eligibleRaws.map((r) => [r.questionId, r.source]));
    const labelByRef = new Map(eligibleRaws.map((r) => [r.questionId, r.knowledgeLabel]));
    const signals: CollectedSignal[] = await collectCandidateSignals(tx, candidateInputs);
    const signalByRef = new Map(signals.map((s) => [s.refId, s]));

    const basis = prepareStreamReplacement(rows, pendingNonDue, signals);
    if (basis === null) return { added: 0, observations: [] } satisfies ComposeOutcome;

    // Statistical sampler with fresh θ̂. targetCount is the replaceable slot count, not the
    // pool size, so sampling is real IPPS (π_i < 1).
    const weighted = statisticalWeights(basis.samplable);
    const sampled =
      weighted.length === 0
        ? []
        : sampleByWeight(weighted, {
            temperature: DEFAULT_TEMPERATURE,
            targetCount: basis.targetCount,
            rng: opts.rng,
          });

    const plan = planStreamReplacement(basis, sampled);
    if (plan === null) return { added: 0, observations: [] } satisfies ComposeOutcome;

    // Delete only slots that will be refilled; frozen and kept rows stay untouched.
    await tx
      .delete(practice_stream_item)
      .where(
        and(
          streamPartitionPredicate(date, sessionId),
          inArray(practice_stream_item.id, plan.deleteIds),
        ),
      );

    // Fill vacated positions first, then append after max(position). Skip refs kept in the
    // stream, and record π_i only for rows that actually insert.
    const maxPosition = rows.reduce((m, r) => Math.max(m, r.position), 0);
    let tailPos = maxPosition + 1;
    let slot = 0;
    const now = new Date();
    const observations: SelectionObservationInput[] = [];
    let added = 0;
    for (const s of plan.insertCandidates) {
      const pos = slot < plan.vacatedPositions.length ? plan.vacatedPositions[slot] : tailPos++;
      slot++;
      const signal = signalByRef.get(s.refId);
      const presentation = presentNonDueQuestion(sourceByRef.get(s.refId), labelByRef.get(s.refId));
      const newRowId = newId();
      const inserted = await tx
        .insert(practice_stream_item)
        .values({
          id: newRowId,
          date,
          session_id: sessionId ?? null,
          position: pos,
          item_kind: 'question' as const,
          ref_id: s.refId,
          source: presentation.source,
          status: 'pending' as const,
          // Rerank changes order only; keep the original reasoning template.
          reasoning: presentation.reasoning,
          added_by: 'composer_live' as const,
          signals: toSignalsJson(signal),
          created_at: now,
          updated_at: now,
        })
        // Swallowed inserts report nothing, so they are neither counted nor observed.
        .onConflictDoNothing()
        .returning({ id: practice_stream_item.id });
      // A swallowed row did not occupy the slot; let the next pick use it.
      if (inserted.length === 0) {
        slot--; // 没真占用空位，让回 slot 游标（下一个抽中项可填这个 position）。
        continue;
      }
      added++;
      observations.push({
        date,
        streamItemId: newRowId,
        refKind: 'question',
        refId: s.refId,
        policy: 'softmax_mfi',
        selected: true,
        inclusionProbability: s.inclusionProbability,
        signals: toSignalsJson(signal),
      });
    }

    return { added, observations };
  });

  // An enclosing settlement-delivery transaction publishes telemetry after its commit.
  if (opts.observations) opts.observations.push(...observations);
  else await writeObservationsBestEffort(db, observations);
  return added;
}

function toSignalsJson(signal: CollectedSignal | undefined): Record<string, unknown> {
  return { ...signal };
}
