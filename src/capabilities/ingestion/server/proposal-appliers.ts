// M4-T4 (YUK-319) — ingestion 包的 proposal accept applier。block_merge 从
// dispatch 壳（actions.ts @ src/server/proposals）等价平移至此（搬迁不改逻辑）。
// image_candidate 的 applier 真身在 ./image-candidate-accept（YUK-227 S3
// Slice C，早于 T4 已是独立文件，随包迁入）；壳层 accept case 只路由到本包。

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { writeEvent } from '@/server/events/queries';
import { ApiError } from '@/server/http/errors';
import { ensureAcceptOnly, existingAcceptRate } from '@/server/proposals/applier-helpers';
import type { ProposalInboxRow } from '@/server/proposals/inbox';
import {
  ensureProposalDecisionSignal,
  recordProposalDecisionSignal,
} from '@/server/proposals/signals';
// YUK-202 / BlockAssembly path-B (design 2026-06-02 §4) — accept reuses the
// verified YUK-195 `mergeQuestions` primitive; no auto-merge path is added.
import { mergeQuestions } from './block-structured-edit';

// 结构最小化（与 practice / agency 包同模式）：只声明本包 applier 实际读取的
// 字段；壳层 AcceptAiProposalOpts 结构可赋值，调用点无需收窄。
export interface IngestionApplierOpts {
  decision?: string;
  user_note?: string;
}

// YUK-202 / BlockAssembly path-B (design 2026-06-02 §4) — accept reuses the
// YUK-195 `mergeQuestions` primitive (no auto-merge — hard safety boundary, §5).
// `rate_event_id` / `merged_count` are set only on a successful `'written'`
// merge; `idempotent` on a second accept (already rated); `stale` + `skip_reason`
// when `mergeQuestions` soft-rejects (a block left draft before accept), so the
// UI can show a "proposal is stale" notice instead of throwing.
export interface BlockMergeAcceptResult {
  kind: 'block_merge';
  rate_event_id?: string;
  primary_block_id: string;
  merged_count?: number;
  idempotent?: boolean;
  stale?: boolean;
  skip_reason?: string;
}

/**
 * YUK-202 / BlockAssembly path-B (design 2026-06-02 §4) — accept a block_merge
 * proposal by reusing the verified YUK-195 `mergeQuestions` primitive. AI only
 * proposes; the merge runs ONLY here, on explicit user accept (§5 hard boundary
 * — no auto-merge path exists).
 *
 * Atomicity (§4, locked): `mergeQuestions` opens its OWN `db.transaction`, so we
 * use the TWO-STEP shape — run the merge (self-tx) first, THEN write the rate
 * event — rather than nesting or adding a tx-override to the verified primitive.
 * The crash window between the two is tiny, and `existingAcceptRate` makes a
 * retry idempotent (a re-accept after a crash finds the merged blocks no longer
 * draft → `mergeQuestions` soft-rejects → stale, no double-merge).
 *
 * Stale handling (§4): `mergeQuestions` returns a discriminated status. Any
 * `skipped:*` (a block already manually merged / imported → no longer draft, or
 * a same-session/structured precondition no longer holds) means we do NOT write
 * the accept rate; we return `{ stale: true, skip_reason }` so the inbox shows a
 * stale notice instead of throwing. This also covers dedup / accept races.
 */
export async function acceptBlockMergeProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: IngestionApplierOpts,
): Promise<BlockMergeAcceptResult> {
  ensureAcceptOnly('block_merge', opts);
  // The inbox row's payload is the typed AiProposalPayloadT; narrow on the
  // discriminant to read the block_merge proposed_change with full types.
  if (proposal.payload.kind !== 'block_merge') {
    throw new ApiError(
      'validation_error',
      `proposal ${proposalId} is not a block_merge proposal (kind=${proposal.payload.kind})`,
      400,
    );
  }
  const change = proposal.payload.proposed_change;
  const primaryBlockId = change.primary_block_id;
  const mergeBlockIds = change.merge_block_ids;
  // Report what mergeQuestions ACTUALLY merges, not the raw payload. The
  // block_merge schema does not refine merge_block_ids for uniqueness / exclude
  // the primary, and proposals are not validated, so a hallucinating producer
  // can emit duplicates or the primary id. mergeQuestions dedups + strips the
  // primary before merging (block-structured-edit.ts:420-422 — source of truth);
  // mirror that here so merged_count + the rate event's merged_block_ids match
  // the block's merged_from_block_ids (consumed by the inbox UI + accept KPI).
  const effectiveMergeIds = [...new Set(mergeBlockIds)].filter((id) => id !== primaryBlockId);

  // Idempotency (§4): an existing accept rate means we already ran the merge;
  // do NOT merge again. existingAcceptRate throws 409 if a non-accept decision
  // already exists.
  const existingRate = await existingAcceptRate(db, proposalId);
  if (existingRate) {
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    return {
      kind: 'block_merge',
      rate_event_id: existingRate.id,
      primary_block_id: primaryBlockId,
      merged_count: effectiveMergeIds.length,
      idempotent: true,
    };
  }

  // Step 1 — run the merge in its own self-tx (cannot nest in the rate-event tx).
  const merge = await mergeQuestions(db, {
    actorRef: 'proposal:accept',
    primaryBlockId,
    mergeBlockIds,
  });

  // A soft-reject (block no longer draft / cross-session / null structured /
  // not found) means the proposal is stale: no rate event, no decision signal.
  if (merge.status !== 'written') {
    return {
      kind: 'block_merge',
      primary_block_id: primaryBlockId,
      stale: true,
      skip_reason: merge.status,
    };
  }

  // Step 2 — the merge committed; write the accept rate event chained to the
  // proposal (mirrors the other accept fns) + decision signal.
  const now = new Date();
  const rateEventId = newId();
  await writeEvent(db, {
    id: rateEventId,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: proposalId,
    outcome: 'success',
    payload: {
      rating: 'accept',
      primary_block_id: primaryBlockId,
      merged_block_ids: effectiveMergeIds,
      ...(opts.user_note ? { user_note: opts.user_note } : {}),
    },
    caused_by_event_id: proposalId,
    created_at: now,
  });
  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
  return {
    kind: 'block_merge',
    rate_event_id: rateEventId,
    primary_block_id: primaryBlockId,
    merged_count: effectiveMergeIds.length,
  };
}
