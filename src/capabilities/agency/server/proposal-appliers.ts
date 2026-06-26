// M4-T4 (YUK-319) — agency 包的提议 accept-applier 真身，从 dispatch 壳
// （actions.ts @ src/server/proposals）等价平移（搬迁不改逻辑）。壳退化为
// 纯 dispatch，按 kind 一行委托到这里。
//
// agency 声明归属的 proposal kinds（manifest.proposals.kinds）：
//   - learning_item → acceptLearningItemProposal（本文件）
//   - completion    → acceptCompletionProposal（本文件）
//   - relearn       → acceptRelearnProposal（本文件）
//   - goal_scope    → acceptGoalScopeProposal（./goals/accept，YUK-143 起就在
//     包内，壳 case 直接委托）
//   - defer         → 有 producer（defer 提议）但无 accept applier：accept 走
//     壳的 default throw（unsupported_proposal_kind），剩余 producer 语义归
//     YUK-44。归属声明与 applier 存在性解耦。
//
// import 环 gate：本文件不得 import producers/writer/actions（含 type-only）；
// 共享 helper 一律走 @/server/proposals/applier-helpers。

import { and, eq, inArray, isNull } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { artifact, completion_evidence, event, learning_item } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { ApiError } from '@/server/http/errors';
import {
  type LearningIntentMaterializeResult,
  acceptLearningIntent,
} from '@/server/orchestrator/learning_intent';
// YUK-471 W2 — learning_item projection seam (completion / relearn). The accept writes a dedicated
// subject-keyed action event (experimental:learning_item_complete / _relearn) so the transition is
// fold-visible via Q1 (the recommended route — no rate-payload side-channel reverse-lookup);
// projectionIsWriter('learning_item') gates ONLY who writes the ROW (projection write-through when
// ON, the imperative UPDATE when OFF + a write-time fold==row parity assert, applicability-gated).
import { projectLearningItemGuarded } from '@/server/projections/learning_item';
import { upsertMaterializedIdIndex } from '@/server/projections/materialized-id-index';
import {
  assertLearningItemParity,
  hasLearningItemGenesisAnchor,
  learningItemLiveRowToSnapshot,
} from '@/server/projections/parity';
import { projectionIsWriter } from '@/server/projections/sot-flag';
import {
  asPlainRecord,
  ensureAcceptOnly,
  existingAcceptRate,
  requiredString,
  stringArray,
} from '@/server/proposals/applier-helpers';
import type { ProposalInboxRow } from '@/server/proposals/inbox';
import {
  ensureProposalDecisionSignal,
  recordProposalDecisionSignal,
} from '@/server/proposals/signals';

// Structural-minimal opts: the dispatch shell's AcceptAiProposalOpts is
// structurally assignable to this (appliers only read decision/user_note).
interface AgencyApplierOpts {
  decision?: string;
  user_note?: string;
}

export interface LearningItemAcceptResult {
  kind: 'learning_item';
  /**
   * Rate event id chained to the proposal. For learning_item the rate event
   * is written by acceptLearningIntent() inside its own transaction, so this
   * field is filled by re-querying after materialization.
   */
  rate_event_id: string;
  hub_learning_item_id: string;
  atomic_learning_item_ids: string[];
  long_learning_item_ids: string[];
  hub_artifact_id: string;
  atomic_artifact_ids: string[];
  long_artifact_ids: string[];
  root_knowledge_id: string;
  created_knowledge_ids: string[];
  idempotent?: boolean;
}

export interface CompletionAcceptResult {
  kind: 'completion';
  rate_event_id: string;
  learning_item_id: string;
  idempotent?: boolean;
}

export interface RelearnAcceptResult {
  kind: 'relearn';
  rate_event_id: string;
  learning_item_id: string;
  idempotent?: boolean;
}

/**
 * YUK-19 / YUK-93 — learning_item accept materializes a 1-hub + child note
 * LearningItem hierarchy + paired note artifacts through the existing
 * acceptLearningIntent owner service (Phase 2B). acceptLearningIntent writes
 * its own rate event inside the same transaction as the hierarchy/artifact
 * inserts, so this branch must not write a second rate event.
 *
 * If the proposal already has an accept rate event (idempotency) we re-derive
 * the materialization result from the persisted rows. acceptLearningIntent's
 * own `proposal_already_rated` guard would otherwise throw on the second
 * call — we beat it to the punch.
 */
export async function acceptLearningItemProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: AgencyApplierOpts,
): Promise<LearningItemAcceptResult> {
  if (opts.decision && opts.decision !== 'accept') {
    throw new ApiError(
      'validation_error',
      `learning_item proposal only supports accept, got ${opts.decision}`,
      400,
    );
  }

  const existingRateRows = await db
    .select()
    .from(event)
    .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)))
    .limit(1);
  const existingRate = existingRateRows[0];
  if (existingRate) {
    const ratePayload = existingRate.payload as { rating?: string };
    if (ratePayload.rating !== 'accept') {
      throw new ApiError(
        'conflict',
        `proposal ${proposalId} already decided as ${ratePayload.rating}`,
        409,
      );
    }
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    const summary = await summarizeLearningItemMaterialization(db, proposalId);
    return {
      kind: 'learning_item',
      rate_event_id: existingRate.id,
      ...summary,
      idempotent: true,
    };
  }

  const result: LearningIntentMaterializeResult = await acceptLearningIntent({ db, proposalId });
  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);

  const rateRows = await db
    .select({ id: event.id })
    .from(event)
    .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)))
    .limit(1);
  const rateEventId = rateRows[0]?.id;
  if (!rateEventId) {
    throw new ApiError(
      'inconsistent_state',
      `acceptLearningIntent for ${proposalId} returned without writing a rate event`,
      500,
    );
  }

  return {
    kind: 'learning_item',
    rate_event_id: rateEventId,
    hub_learning_item_id: result.hub_learning_item_id,
    atomic_learning_item_ids: result.atomic_learning_item_ids,
    long_learning_item_ids: result.long_learning_item_ids,
    hub_artifact_id: result.hub_artifact_id,
    atomic_artifact_ids: result.atomic_artifact_ids,
    long_artifact_ids: result.long_artifact_ids,
    root_knowledge_id: result.root_knowledge_id,
    created_knowledge_ids: result.created_knowledge_ids,
  };
}

/**
 * Re-derive the LearningIntentMaterializeResult from persisted rows for the
 * idempotent return path. Hub is the row whose `parent_learning_item_id` is
 * null among the learning_items rooted at the proposal id; child note items are
 * split by artifact type. Artifacts mirror.
 */
async function summarizeLearningItemMaterialization(
  db: Db,
  proposalId: string,
): Promise<Omit<LearningIntentMaterializeResult, 'enqueued_note_generate_jobs'>> {
  const liRows = await db
    .select({
      id: learning_item.id,
      parent_learning_item_id: learning_item.parent_learning_item_id,
      primary_artifact_id: learning_item.primary_artifact_id,
      knowledge_ids: learning_item.knowledge_ids,
    })
    .from(learning_item)
    .where(eq(learning_item.source_ref, proposalId));
  const hub = liRows.find((row) => row.parent_learning_item_id === null);
  if (!hub) {
    throw new ApiError(
      'inconsistent_state',
      `no hub learning_item found for proposal ${proposalId}`,
      500,
    );
  }
  const childItems = liRows.filter((row) => row.id !== hub.id);

  const hubArtifactId = hub.primary_artifact_id ?? null;
  if (!hubArtifactId) {
    throw new ApiError(
      'inconsistent_state',
      `hub learning_item ${hub.id} has no primary_artifact_id`,
      500,
    );
  }
  const rootKnowledgeId = hub.knowledge_ids[0] ?? null;
  if (!rootKnowledgeId) {
    throw new ApiError(
      'inconsistent_state',
      `hub learning_item ${hub.id} has no knowledge_id`,
      500,
    );
  }

  const childArtifactIds = childItems
    .map((row) => row.primary_artifact_id)
    .filter((id): id is string => Boolean(id));
  const childArtifacts =
    childArtifactIds.length > 0
      ? await db
          .select({ id: artifact.id, type: artifact.type })
          .from(artifact)
          .where(inArray(artifact.id, childArtifactIds))
      : [];
  const artifactTypeById = new Map(childArtifacts.map((row) => [row.id, row.type]));
  const atomicItems = childItems.filter((row) => {
    const artifactId = row.primary_artifact_id;
    return !artifactId || artifactTypeById.get(artifactId) !== 'note_long';
  });
  const longItems = childItems.filter((row) => {
    const artifactId = row.primary_artifact_id;
    return artifactId ? artifactTypeById.get(artifactId) === 'note_long' : false;
  });

  return {
    hub_learning_item_id: hub.id,
    atomic_learning_item_ids: atomicItems.map((row) => row.id),
    long_learning_item_ids: longItems.map((row) => row.id),
    hub_artifact_id: hubArtifactId,
    atomic_artifact_ids: atomicItems
      .map((row) => row.primary_artifact_id)
      .filter((id): id is string => Boolean(id)),
    long_artifact_ids: longItems
      .map((row) => row.primary_artifact_id)
      .filter((id): id is string => Boolean(id)),
    root_knowledge_id: rootKnowledgeId,
    created_knowledge_ids: [],
  };
}

/**
 * A1 — genesis-IF-MISSING for a pre-W2 / un-backfilled learning_item, written BEFORE a
 * complete/relearn action event so fold(events) == live row holds. (Mirrors the inline
 * genesis-if-missing in the actions.ts retract block; shared here so the complete + relearn accept
 * paths cannot drift on the load-bearing clamp.)
 *
 * WHY: a complete/relearn action event on an UN-anchored item folds to NULL (no genesis base to
 * mutate). Two failure modes that fix:
 *   (a) OFF path — the imperative UPDATE flips the row fine, but a LATER backfill genesis (created
 *       AFTER the action) would sort AFTER it → the fold processes the action before the base and
 *       skips it → fold != live row (audit:projection drift the moment the backfill runs).
 *   (b) ON path — projectLearningItemGuarded folds null + (no anchor) keeps the imperative row, but
 *       the ON path NEVER writes the imperative row → the accept silently no-ops at the row level.
 *
 * Anchoring the item with a snapshot of its CURRENT (pre-mutation) state, with a created_at CLAMPED
 * strictly earlier than the action event (min(updated_at, actionAt - 1ms)), makes the genesis sort
 * BEFORE the action regardless of the cuid2 id coin-flip — so fold(genesis + action) reproduces the
 * transitioned row on BOTH paths. No-op when the item is already event-sourced (a later backfill is
 * then itself a no-op). Caller passes the SAME tx so genesis + action commit atomically.
 */
async function ensureLearningItemGenesisAnchor(
  tx: Db | Tx,
  item: typeof learning_item.$inferSelect,
  actionAt: Date,
): Promise<void> {
  if (await hasLearningItemGenesisAnchor(tx, item.id)) return;
  const genesisEventId = newId();
  // CLAMP strictly earlier than the action event (mirrors actions.ts retract review #1): the fold
  // sorts (created_at asc, id asc) and ids are non-temporal cuid2s, so if item.updated_at ==
  // actionAt (same-ms) the random action id could otherwise sort before the genesis.
  const genesisAt = new Date(Math.min(item.updated_at.getTime(), actionAt.getTime() - 1));
  await writeEvent(tx, {
    id: genesisEventId,
    actor_kind: 'system',
    actor_ref: 'genesis-backfill',
    action: 'experimental:genesis',
    subject_kind: 'learning_item',
    subject_id: item.id,
    outcome: 'success',
    payload: { row: learningItemLiveRowToSnapshot(item) },
    created_at: genesisAt,
    ingest_at: actionAt,
  });
  await upsertMaterializedIdIndex(tx, {
    materialized_id: item.id,
    anchor_event_id: genesisEventId,
    subject_kind: 'learning_item',
  });
}

export async function acceptCompletionProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: AgencyApplierOpts,
): Promise<CompletionAcceptResult> {
  ensureAcceptOnly('completion', opts);
  const change = asPlainRecord(proposal.payload.proposed_change);
  const learningItemId = requiredString(change.learning_item_id, 'learning_item_id', proposalId);

  const existingRate = await existingAcceptRate(db, proposalId);
  if (existingRate) {
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    return {
      kind: 'completion',
      rate_event_id: existingRate.id,
      learning_item_id: learningItemId,
      idempotent: true,
    };
  }

  const item = (
    await db
      .select()
      .from(learning_item)
      .where(and(eq(learning_item.id, learningItemId), isNull(learning_item.archived_at)))
      .limit(1)
  )[0];
  if (!item) throw new ApiError('not_found', `learning_item ${learningItemId} not found`, 404);
  if (item.status !== 'pending' && item.status !== 'in_progress') {
    throw new ApiError(
      'conflict',
      `completion proposal ${proposalId} expected pending/in_progress item, got ${item.status}`,
      409,
    );
  }

  const now = new Date();
  const rateEventId = newId();
  const evidenceJson = {
    ...asPlainRecord(change.evidence_json),
    proposal_id: proposalId,
    triggering_signals: stringArray(change.triggering_signals),
  };

  await db.transaction(async (tx) => {
    // A1 — genesis-IF-MISSING for a pre-W2 / un-backfilled item, written BEFORE the complete action
    // event (clamped strictly earlier) so the action has a base to fold from. Fixes both the OFF
    // later-backfill-drift case AND the ON silent-row-no-op case (see the helper doc). No-op for an
    // already-event-sourced item.
    await ensureLearningItemGenesisAnchor(tx, item, now);
    // YUK-471 W2 — write the dedicated complete action event (subject_kind='learning_item',
    // subject_id=itemId, created_at=now) so the fold (when the flag is ON) sees the transition via
    // Q1 in the same tx. created_at=now is the SINGLE CLOCK (HIGH-1): the reducer derives the row's
    // completed_at + updated_at from THIS event's created_at, and the imperative UPDATE below reuses
    // the SAME `now`, so fold(events) == live row deterministically (a second `new Date()` would
    // drift by a cross-ms delta). ingest_at=now → outbox opt-out (a status flip is not a
    // memory-worthy activity; mirrors the goal/variant seams).
    await writeEvent(tx, {
      id: newId(),
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:learning_item_complete',
      subject_kind: 'learning_item',
      subject_id: learningItemId,
      outcome: 'success',
      payload: {},
      caused_by_event_id: proposalId,
      created_at: now,
      ingest_at: now,
    });

    await tx.insert(completion_evidence).values({
      id: newId(),
      learning_item_id: learningItemId,
      path: 'ai_propose',
      evidence_json: evidenceJson,
      decided_at: now,
    });

    // The accept `rate` event (proposal-decision signal) — kept regardless of the flag. It is
    // subject_kind='event' (chained to the proposal), NOT subject_kind='learning_item', so the
    // learning_item Q1 fold never gathers it; it is the proposal inbox's decision marker.
    await writeEvent(tx, {
      id: rateEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: proposalId,
      outcome: 'success',
      payload: {
        rating: 'accept',
        materialized_learning_item_id: learningItemId,
        ...(opts.user_note ? { user_note: opts.user_note } : {}),
      },
      caused_by_event_id: proposalId,
      created_at: now,
    });

    // ROW writer — gated on the per-entity flag (critic A1, defer-flip-not-build): ON →
    // projectLearningItemGuarded folds (genesis + complete → done) + writes through; OFF → the
    // imperative UPDATE (current behavior — status→done, completed_at=now, version+1; the SAME `now`
    // the complete event carries) + a write-time fold==row parity assert.
    //
    // A2 (DEFERRED follow-up — concurrency-semantics gap behind an OFF-by-default flag, NOT
    // data-loss): the ON branch upserts via onConflictDoUpdate with NO version/FOR-UPDATE check,
    // whereas the OFF branch uses eq(version, item.version) optimistic locking + 409, and the status
    // precondition runs OUTSIDE the tx. So under the flag two concurrent accepts both project (no
    // 409 for the loser, duplicate complete/evidence/rate events). The fold's terminal-status guard
    // keeps the FINAL row deterministic (status→done is idempotent), so this never loses data — it
    // only diverges the concurrency semantics from the OFF path. Adding an in-tx FOR-UPDATE re-check
    // + version guard to the ON path broadens this lane meaningfully (new locking semantics + a
    // dedicated concurrency test), so it is left for a follow-up rather than over-engineered here.
    if (projectionIsWriter('learning_item')) {
      await projectLearningItemGuarded(tx, learningItemId);
    } else {
      const updated = await tx
        .update(learning_item)
        .set({
          status: 'done',
          completed_at: now,
          updated_at: now,
          version: item.version + 1,
        })
        .where(and(eq(learning_item.id, learningItemId), eq(learning_item.version, item.version)))
        .returning({ id: learning_item.id });
      if (updated.length !== 1) {
        throw new ApiError(
          'conflict',
          `learning_item ${learningItemId} concurrently modified`,
          409,
        );
      }
      // The item is event-sourced this tx (ensureLearningItemGenesisAnchor + complete), so it always
      // re-folds — assert fold(events) == the updated row UNCONDITIONALLY (mirrors the retract OFF
      // branch; the prior hasLearningItemGenesisAnchor gate is now always true after A1).
      const [written] = await tx
        .select()
        .from(learning_item)
        .where(eq(learning_item.id, learningItemId))
        .limit(1);
      await assertLearningItemParity(
        tx,
        learningItemId,
        written ? learningItemLiveRowToSnapshot(written) : null,
      );
    }
  });

  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
  return { kind: 'completion', rate_event_id: rateEventId, learning_item_id: learningItemId };
}

export async function acceptRelearnProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: AgencyApplierOpts,
): Promise<RelearnAcceptResult> {
  ensureAcceptOnly('relearn', opts);
  const change = asPlainRecord(proposal.payload.proposed_change);
  const learningItemId = requiredString(change.learning_item_id, 'learning_item_id', proposalId);

  const existingRate = await existingAcceptRate(db, proposalId);
  if (existingRate) {
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    return {
      kind: 'relearn',
      rate_event_id: existingRate.id,
      learning_item_id: learningItemId,
      idempotent: true,
    };
  }

  const item = (
    await db
      .select()
      .from(learning_item)
      .where(and(eq(learning_item.id, learningItemId), isNull(learning_item.archived_at)))
      .limit(1)
  )[0];
  if (!item) throw new ApiError('not_found', `learning_item ${learningItemId} not found`, 404);
  if (item.status !== 'done' && item.status !== 'resting') {
    throw new ApiError(
      'conflict',
      `relearn proposal ${proposalId} expected done/resting item, got ${item.status}`,
      409,
    );
  }

  const now = new Date();
  const rateEventId = newId();
  await db.transaction(async (tx) => {
    // A1 — genesis-IF-MISSING for a pre-W2 / un-backfilled item, written BEFORE the relearn action
    // event (clamped strictly earlier) so the action has a base to fold from. Fixes both the OFF
    // later-backfill-drift case AND the ON silent-row-no-op case (see the helper doc). No-op for an
    // already-event-sourced item.
    await ensureLearningItemGenesisAnchor(tx, item, now);
    // YUK-471 W2 — write the dedicated relearn action event (subject_kind='learning_item',
    // created_at=now) so the fold sees the transition via Q1. created_at=now is the SINGLE CLOCK
    // (HIGH-1): the reducer derives updated_at from THIS event's created_at and clears completed_at,
    // and the imperative UPDATE below reuses the SAME `now`. ingest_at=now → outbox opt-out.
    await writeEvent(tx, {
      id: newId(),
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:learning_item_relearn',
      subject_kind: 'learning_item',
      subject_id: learningItemId,
      outcome: 'success',
      payload: {},
      caused_by_event_id: proposalId,
      created_at: now,
      ingest_at: now,
    });
    // The accept `rate` event (proposal-decision signal) — kept regardless of the flag (subject_kind
    // ='event', NOT gathered by the learning_item fold).
    await writeEvent(tx, {
      id: rateEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: proposalId,
      outcome: 'success',
      payload: {
        rating: 'accept',
        materialized_learning_item_id: learningItemId,
        ...(opts.user_note ? { user_note: opts.user_note } : {}),
      },
      caused_by_event_id: proposalId,
      created_at: now,
    });
    // ROW writer — gated on the per-entity flag (critic A1): ON → projectLearningItemGuarded folds
    // (genesis + … + relearn → in_progress, completed_at cleared) + writes through; OFF → the
    // imperative UPDATE (current behavior — status→in_progress, completed_at=null, version+1; the
    // SAME `now` the relearn event carries) + a write-time fold==row parity assert.
    //
    // A2 (DEFERRED follow-up — same OFF-by-default concurrency-semantics gap as the completion path:
    // the ON branch has no version/FOR-UPDATE check vs the OFF optimistic lock + out-of-tx status
    // precondition; the terminal-status guard keeps the final row deterministic so this is not
    // data-loss). Left for a follow-up rather than bolting OFF-path locking onto the ON path here.
    if (projectionIsWriter('learning_item')) {
      await projectLearningItemGuarded(tx, learningItemId);
    } else {
      const updated = await tx
        .update(learning_item)
        .set({
          status: 'in_progress',
          completed_at: null,
          updated_at: now,
          version: item.version + 1,
        })
        .where(and(eq(learning_item.id, learningItemId), eq(learning_item.version, item.version)))
        .returning({ id: learning_item.id });
      if (updated.length !== 1) {
        throw new ApiError(
          'conflict',
          `learning_item ${learningItemId} concurrently modified`,
          409,
        );
      }
      // The item is event-sourced this tx (ensureLearningItemGenesisAnchor + relearn), so it always
      // re-folds — assert fold(events) == the updated row UNCONDITIONALLY (mirrors the retract OFF
      // branch; the prior hasLearningItemGenesisAnchor gate is now always true after A1).
      const [written] = await tx
        .select()
        .from(learning_item)
        .where(eq(learning_item.id, learningItemId))
        .limit(1);
      await assertLearningItemParity(
        tx,
        learningItemId,
        written ? learningItemLiveRowToSnapshot(written) : null,
      );
    }
  });

  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
  return { kind: 'relearn', rate_event_id: rateEventId, learning_item_id: learningItemId };
}
