// agency 包的 proposal accept-applier 真身；dispatch 壳按 kind 一行委托到这里。
//
// agency 声明归属的 proposal kinds（manifest.proposals.kinds）：
//   - learning_item / completion / relearn → 本文件
//   - goal_scope → acceptGoalScopeProposal（./goals/accept）
//   - defer → 有 producer 但无 accept applier：accept 走壳的 default throw
//     （unsupported_proposal_kind）。归属声明与 applier 存在性解耦。
//
// import 环 gate：本文件不得 import producers/writer/actions（含 type-only）；
// 裁决事务走 @/kernel/proposals/decision-protocol，其余共享 helper 走
// @/kernel/proposals/applier-helpers。

import { and, eq, inArray, isNull } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { artifact, completion_evidence, learning_item } from '@/db/schema';
import { nextProjectionEventTime, writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import {
  asPlainRecord,
  ensureAcceptOnly,
  requiredString,
  stringArray,
} from '@/kernel/proposals/applier-helpers';
import {
  type ProposalAcceptEffectOutcome,
  type RecordedProposalRate,
  runProposalAccept,
} from '@/kernel/proposals/decision-protocol';
import type { ProposalAcceptInput } from '@/kernel/proposals/types';
// Completion/relearn record subject-keyed actions, then materialize through the
// single structural writer. Approval and row locking stay in this owner transaction.
import {
  hasLearningItemGenesisAnchor,
  projectLearningItemGuarded,
} from '@/kernel/records/learning-items';
import {
  type AcceptLearningIntentParams,
  type CreateLearningIntentKnowledgeNodeFn,
  type LearningIntentMaterializeResult,
  acceptLearningIntent,
} from './learning-intent';
import type { ProposalInboxRow } from './proposal-lifecycle';

export interface AgencyApplierOpts {
  decision?: string;
  user_note?: string;
  /** Auto-apply passes the proposing agent's identity; omitted = human `user/self`. */
  actor?: ProposalAcceptInput['actor'];
  enqueueLearningIntentNote?: EnqueueLearningIntentNoteFn;
  createLearningIntentKnowledgeNode?: CreateLearningIntentKnowledgeNodeFn;
  createLearningIntentNote?: AcceptLearningIntentParams['createNote'];
}

export interface LearningItemAcceptResult {
  kind: 'learning_item';
  /** Rate event id chained to the proposal. */
  rate_event_id: string;
  hub_learning_item_id: string;
  atomic_learning_item_ids: string[];
  long_learning_item_ids: string[];
  hub_artifact_id: string;
  atomic_artifact_ids: string[];
  long_artifact_ids: string[];
  root_knowledge_id: string;
  created_knowledge_ids: string[];
  enqueued_note_generate_jobs: number;
  idempotent?: boolean;
}

export type EnqueueLearningIntentNoteFn = (artifactId: string) => Promise<boolean>;

export async function enqueueLearningIntentNotes(
  db: Db,
  artifactIds: string[],
  enqueue?: EnqueueLearningIntentNoteFn,
): Promise<number> {
  if (artifactIds.length === 0 || !enqueue) return 0;

  const pending = await db
    .select({ id: artifact.id })
    .from(artifact)
    .where(and(inArray(artifact.id, artifactIds), eq(artifact.generation_status, 'pending')));
  let enqueued = 0;
  for (const row of pending) {
    try {
      if (await enqueue(row.id)) enqueued += 1;
    } catch (err) {
      console.warn(`note_generate enqueue failed for artifact ${row.id}:`, err);
    }
  }
  return enqueued;
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
 * learning_item accept materializes the 1-hub + child note hierarchy through the
 * acceptLearningIntent effect inside the kernel decision transaction, which writes the one
 * rate event. A recorded accept re-derives the materialization result from persisted rows.
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

  const run = await runProposalAccept(db, proposalId, {
    proposal,
    userNote: opts.user_note,
    ...(opts.actor ? { actor: opts.actor } : {}),
    signal: 'after_commit',
    replay: async (rate: RecordedProposalRate): Promise<LearningItemAcceptResult> => {
      const summary = await summarizeLearningItemMaterialization(db, proposalId);
      const enqueued = await enqueueLearningIntentNotes(
        db,
        [...summary.atomic_artifact_ids, ...summary.long_artifact_ids],
        opts.enqueueLearningIntentNote,
      );
      return {
        kind: 'learning_item',
        rate_event_id: rate.id,
        ...summary,
        enqueued_note_generate_jobs: enqueued,
        idempotent: true,
      };
    },
    prepare: async () => {
      const { createLearningIntentKnowledgeNode, createLearningIntentNote } = opts;
      if (!createLearningIntentKnowledgeNode || !createLearningIntentNote) {
        throw new ApiError(
          'inconsistent_state',
          'learning intent owner commands were not composed',
          500,
        );
      }
      return {
        createKnowledgeNode: createLearningIntentKnowledgeNode,
        createNote: createLearningIntentNote,
      };
    },
    effect: async (
      { tx, writeRate },
      commands,
    ): Promise<ProposalAcceptEffectOutcome<LearningItemAcceptResult>> => {
      let rateEventId = '';
      const materialized = await acceptLearningIntent({
        tx,
        proposalId,
        ...commands,
        writeRate: async (rate) => {
          rateEventId = await writeRate(rate);
          return rateEventId;
        },
      });
      return {
        status: 'accepted',
        result: {
          kind: 'learning_item',
          rate_event_id: rateEventId,
          hub_learning_item_id: materialized.hub_learning_item_id,
          atomic_learning_item_ids: materialized.atomic_learning_item_ids,
          long_learning_item_ids: materialized.long_learning_item_ids,
          hub_artifact_id: materialized.hub_artifact_id,
          atomic_artifact_ids: materialized.atomic_artifact_ids,
          long_artifact_ids: materialized.long_artifact_ids,
          root_knowledge_id: materialized.root_knowledge_id,
          created_knowledge_ids: materialized.created_knowledge_ids,
          enqueued_note_generate_jobs: 0,
        },
      };
    },
  });
  if (run.outcome !== 'accepted') return run.result;

  const enqueued = await enqueueLearningIntentNotes(
    db,
    [...run.result.atomic_artifact_ids, ...run.result.long_artifact_ids],
    opts.enqueueLearningIntentNote,
  );
  return { ...run.result, enqueued_note_generate_jobs: enqueued };
}

/**
 * Re-derive the materialization result from persisted rows for the idempotent return path.
 * The hub is the row whose `parent_learning_item_id` is null among the learning_items rooted
 * at the proposal id; child items are split by artifact type.
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

type LearningItemRow = typeof learning_item.$inferSelect;

async function readUnarchivedLearningItem(
  db: Db,
  learningItemId: string,
): Promise<LearningItemRow | undefined> {
  return (
    await db
      .select()
      .from(learning_item)
      .where(and(eq(learning_item.id, learningItemId), isNull(learning_item.archived_at)))
      .limit(1)
  )[0];
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

  const { result } = await runProposalAccept(db, proposalId, {
    proposal,
    userNote: opts.user_note,
    signal: 'after_commit',
    replay: async (rate: RecordedProposalRate): Promise<CompletionAcceptResult> => ({
      kind: 'completion',
      rate_event_id: rate.id,
      learning_item_id: learningItemId,
      idempotent: true,
    }),
    prepare: async () => {
      const item = await readUnarchivedLearningItem(db, learningItemId);
      if (!item) throw new ApiError('not_found', `learning_item ${learningItemId} not found`, 404);
      if (item.status !== 'pending' && item.status !== 'in_progress') {
        throw new ApiError(
          'conflict',
          `completion proposal ${proposalId} expected pending/in_progress item, got ${item.status}`,
          409,
        );
      }
      return item;
    },
    effect: async (
      { tx, writeRate },
      item,
    ): Promise<ProposalAcceptEffectOutcome<CompletionAcceptResult>> => {
      const evidenceJson = {
        ...asPlainRecord(change.evidence_json),
        proposal_id: proposalId,
        triggering_signals: stringArray(change.triggering_signals),
      };
      // Serialize the state check, event append and projection on the same row lock.
      const [current] = await tx
        .select()
        .from(learning_item)
        .where(and(eq(learning_item.id, learningItemId), isNull(learning_item.archived_at)))
        .for('update');
      if (!current || current.version !== item.version || current.status !== item.status) {
        throw new ApiError('conflict', 'learning_item changed before proposal acceptance', 409);
      }
      if (!(await hasLearningItemGenesisAnchor(tx, learningItemId))) {
        throw new Error('learning_item requires canonical projection migration before mutation');
      }
      const now = await nextProjectionEventTime(tx, 'learning_item', learningItemId, new Date());
      // One clock for the action, evidence and decision. Derived fields remain untouched.
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

      // The accept `rate` event is the proposal-decision signal. It is
      // subject_kind='event' (chained to the proposal), NOT subject_kind='learning_item', so the
      // learning_item Q1 fold never gathers it; it is the proposal inbox's decision marker.
      const rateEventId = await writeRate({
        created_at: now,
        payload: {
          materialized_learning_item_id: learningItemId,
          // Pin the EXACT pre-accept state so retract restores it instead of guessing.
          // completion accepts pending|in_progress; record which (and the prior completed_at,
          // normally null) here.
          materialized_prior_status: item.status,
          materialized_prior_completed_at: item.completed_at
            ? item.completed_at.toISOString()
            : null,
        },
      });
      // Materialize canonical structural state from the events in this transaction.
      await projectLearningItemGuarded(tx, learningItemId);
      return {
        status: 'accepted',
        result: {
          kind: 'completion',
          rate_event_id: rateEventId,
          learning_item_id: learningItemId,
        },
      };
    },
  });
  return result;
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

  const { result } = await runProposalAccept(db, proposalId, {
    proposal,
    userNote: opts.user_note,
    signal: 'after_commit',
    replay: async (rate: RecordedProposalRate): Promise<RelearnAcceptResult> => ({
      kind: 'relearn',
      rate_event_id: rate.id,
      learning_item_id: learningItemId,
      idempotent: true,
    }),
    prepare: async () => {
      const item = await readUnarchivedLearningItem(db, learningItemId);
      if (!item) throw new ApiError('not_found', `learning_item ${learningItemId} not found`, 404);
      if (item.status !== 'done' && item.status !== 'resting') {
        throw new ApiError(
          'conflict',
          `relearn proposal ${proposalId} expected done/resting item, got ${item.status}`,
          409,
        );
      }
      return item;
    },
    effect: async (
      { tx, writeRate },
      item,
    ): Promise<ProposalAcceptEffectOutcome<RelearnAcceptResult>> => {
      // Serialize the state check, event append and projection on the same row lock.
      const [current] = await tx
        .select()
        .from(learning_item)
        .where(and(eq(learning_item.id, learningItemId), isNull(learning_item.archived_at)))
        .for('update');
      if (!current || current.version !== item.version || current.status !== item.status) {
        throw new ApiError('conflict', 'learning_item changed before proposal acceptance', 409);
      }
      if (!(await hasLearningItemGenesisAnchor(tx, learningItemId))) {
        throw new Error('learning_item requires canonical projection migration before mutation');
      }
      const now = await nextProjectionEventTime(tx, 'learning_item', learningItemId, new Date());
      // One clock for the action, evidence and decision. Derived fields remain untouched.
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
      // The accept `rate` event is a proposal decision, not a subject-keyed item mutation.
      const rateEventId = await writeRate({
        created_at: now,
        payload: {
          materialized_learning_item_id: learningItemId,
          // Pin the EXACT pre-accept state. relearn accepts done|resting and clears
          // completed_at; without both fields, retract cannot tell a `resting` item
          // (completed_at already null) from a `done` one and would corrupt it into `done`
          // with a fabricated completed_at.
          materialized_prior_status: item.status,
          materialized_prior_completed_at: item.completed_at
            ? item.completed_at.toISOString()
            : null,
        },
      });
      // Materialize canonical structural state from the events in this transaction.
      await projectLearningItemGuarded(tx, learningItemId);
      return {
        status: 'accepted',
        result: { kind: 'relearn', rate_event_id: rateEventId, learning_item_id: learningItemId },
      };
    },
  });
  return result;
}
