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
import type { Db } from '@/db/client';
import { artifact, completion_evidence, event, learning_item } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { ApiError } from '@/server/http/errors';
import {
  type LearningIntentMaterializeResult,
  acceptLearningIntent,
} from '@/server/orchestrator/learning_intent';
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
      throw new ApiError('conflict', `learning_item ${learningItemId} concurrently modified`, 409);
    }

    await tx.insert(completion_evidence).values({
      id: newId(),
      learning_item_id: learningItemId,
      path: 'ai_propose',
      evidence_json: evidenceJson,
      user_overrode_low_evidence: false,
      decided_at: now,
    });

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
      throw new ApiError('conflict', `learning_item ${learningItemId} concurrently modified`, 409);
    }
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
  });

  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
  return { kind: 'relearn', rate_event_id: rateEventId, learning_item_id: learningItemId };
}
