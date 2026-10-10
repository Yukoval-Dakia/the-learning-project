import { createId } from '@paralleldrive/cuid2';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decideKnowledgeEdgeProposal } from '@/capabilities/knowledge/public';
import {
  artifact,
  completion_evidence,
  edge_reconciliation_log,
  event,
  knowledge,
  knowledge_edge,
  learning_item,
  proposal_signals,
} from '@/db/schema';
import { writeAiProposal } from '@/kernel/proposals/writer';
import {
  gatherAndFoldKnowledgeEdge,
  gatherAndFoldKnowledgeNode,
  gatherAndFoldLearningItem,
} from '@/server/projections/gather';
import {
  hasLearningItemGenesisAnchor,
  knowledgeLiveRowToSnapshot,
  learningItemLiveRowToSnapshot,
} from '@/server/projections/parity';
import { backfillKnowledgeEdgeGenesis } from '../../../scripts/backfill-genesis-events';
import { migrateCanonicalProjections } from '../../../scripts/migrate-canonical-projections';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  type ProposalLifecycleResult,
  acceptAiProposal,
  dismissAiProposal,
  retractAiProposal,
} from './actions';
import { acquireProposalDecisionLock } from './applier-helpers';

const KNOWLEDGE_BASE = {
  domain: 'yuwen',
  parent_id: null,
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
};

function paragraphBlock(id: string, text: string) {
  return {
    type: 'paragraph',
    attrs: { id },
    content: [{ type: 'text', text }],
  };
}

function acceptedKnowledgeNodeId(result: ProposalLifecycleResult): string {
  const ownerResult = result.result;
  if (
    result.kind !== 'knowledge_node' ||
    typeof ownerResult !== 'object' ||
    ownerResult === null ||
    !('kind' in ownerResult) ||
    ownerResult.kind !== 'propose_new_applied' ||
    !('new_node_id' in ownerResult) ||
    typeof ownerResult.new_node_id !== 'string'
  ) {
    throw new Error('expected a materialized knowledge_node result');
  }
  return ownerResult.new_node_id;
}

async function seedKnowledge(ids: string[]): Promise<void> {
  const db = testDb();
  const now = new Date();
  for (const id of ids) {
    await db.insert(knowledge).values({
      id,
      name: id,
      archived_at: null,
      created_at: now,
      updated_at: now,
      ...KNOWLEDGE_BASE,
    });
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function observesBlockedDatabaseSession(): Promise<boolean> {
  const db = testDb();
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const rows = await db.execute(
      sql.raw(`SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
      ) AS blocked`),
    );
    if (rows[0]?.blocked === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

describe('proposal lifecycle owner service', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('acceptAiProposal applies an edge_op:supersede proposal atomically after user approval', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2', 'k3']);
    await db.insert(knowledge_edge).values({
      id: 'edge_superseded',
      from_knowledge_id: 'k2',
      to_knowledge_id: 'k1',
      relation_type: 'related_to',
      weight: 1,
      created_by: { actor_kind: 'user', actor_ref: 'self' } as never,
      created_at: new Date(),
    });
    await writeAiProposal(db, {
      id: 'edge_supersede_p1',
      payload: {
        kind: 'knowledge_edge',
        target: { subject_kind: 'knowledge_edge', subject_id: 'edge_superseded' },
        reason_md: 'the candidate corrects the old edge',
        evidence_refs: [{ kind: 'event', id: 'attempt_1' }],
        proposed_change: {
          edge_op: 'supersede',
          from_knowledge_id: 'k1',
          to_knowledge_id: 'k3',
          relation_type: 'contrasts_with',
          weight: 0.8,
          archive_edge_id: 'edge_superseded',
          supersede_confidence: 0.91,
          supersede_neighbor_index: 0,
          supersede_affected_refs: [{ kind: 'question', id: 'question_1' }],
        },
        cooldown_key: 'knowledge_edge_supersede:edge_superseded:k1|k3|contrasts_with',
      },
    });

    const before = await db
      .select()
      .from(knowledge_edge)
      .where(eq(knowledge_edge.id, 'edge_superseded'));
    expect(before[0].archived_at).toBeNull();

    await backfillKnowledgeEdgeGenesis(db);
    const result = await acceptAiProposal(db, 'edge_supersede_p1');
    expect(result.kind).toBe('knowledge_edge');
    if (result.kind !== 'knowledge_edge') throw new Error('unexpected result');
    expect(result.edge_id).not.toBe('edge_superseded');

    const oldEdge = await db
      .select()
      .from(knowledge_edge)
      .where(eq(knowledge_edge.id, 'edge_superseded'));
    expect(oldEdge[0].archived_at).not.toBeNull();
    const replacement = await db
      .select()
      .from(knowledge_edge)
      .where(and(eq(knowledge_edge.from_knowledge_id, 'k1'), isNull(knowledge_edge.archived_at)));
    expect(replacement).toHaveLength(1);
    expect(replacement[0].to_knowledge_id).toBe('k3');
    const foldedReplacement = await gatherAndFoldKnowledgeEdge(db, replacement[0].id);
    expect(foldedReplacement).toEqual(replacement[0]);

    const logs = await db.select().from(edge_reconciliation_log);
    expect(logs).toHaveLength(1);
    expect(logs[0].superseded_edge_id).toBe('edge_superseded');
    expect(logs[0].applied_at).not.toBeNull();
    const corrections = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'correct'), eq(event.subject_kind, 'event')));
    expect(corrections).toHaveLength(1);
    expect(corrections[0].actor_kind).toBe('user');
    expect(corrections[0].actor_ref).toBe('self');

    const replay = await acceptAiProposal(db, 'edge_supersede_p1');
    expect(replay.kind).toBe('knowledge_edge');
    if (replay.kind !== 'knowledge_edge') throw new Error('unexpected result');
    expect(replay.idempotent).toBe(true);
    expect(replay.edge_id).toBe(result.edge_id);
    expect(await db.select().from(edge_reconciliation_log)).toHaveLength(1);
  });

  it('allows one of two racing archive proposals to append the sole fold-visible archive event', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    await db.insert(knowledge_edge).values({
      id: 'edge_archive_race',
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'related_to',
      weight: 1,
      created_by: { actor_kind: 'user', actor_ref: 'self' } as never,
      created_at: new Date(),
    });
    await backfillKnowledgeEdgeGenesis(db);
    for (const suffix of ['a', 'b']) {
      await writeAiProposal(db, {
        id: `edge_archive_race_${suffix}`,
        payload: {
          kind: 'knowledge_edge',
          target: { subject_kind: 'knowledge_edge', subject_id: 'edge_archive_race' },
          reason_md: `archive contender ${suffix}`,
          evidence_refs: [],
          proposed_change: {
            edge_op: 'archive',
            from_knowledge_id: 'k1',
            to_knowledge_id: 'k2',
            relation_type: 'related_to',
            weight: 1,
            archive_edge_id: 'edge_archive_race',
          },
          cooldown_key: `knowledge_edge_archive:edge_archive_race:${suffix}`,
        },
      });
    }

    const settled = await Promise.allSettled([
      acceptAiProposal(db, 'edge_archive_race_a'),
      acceptAiProposal(db, 'edge_archive_race_b'),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const archiveEvents = (
      await db
        .select()
        .from(event)
        .where(
          and(
            eq(event.action, 'generate'),
            eq(event.subject_kind, 'knowledge_edge'),
            eq(event.subject_id, 'edge_archive_race'),
          ),
        )
    ).filter((row) => (row.payload as { edge_op?: string }).edge_op === 'archive');
    expect(archiveEvents).toHaveLength(1);
    const [row] = await db
      .select()
      .from(knowledge_edge)
      .where(eq(knowledge_edge.id, 'edge_archive_race'));
    expect(row.archived_at?.getTime()).toBe(archiveEvents[0].created_at.getTime());
  });

  it('rolls back note materialization and rate when the decision signal write fails', async () => {
    const db = testDb();
    const now = new Date();
    const cooldownKey = 'note_update:atomic_signal_failure';
    await db.insert(artifact).values({
      id: 'artifact_note_atomic',
      type: 'note_atomic',
      title: '原子接受',
      parent_artifact_id: null,
      knowledge_ids: [],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      source_ref: null,
      body_blocks: {
        type: 'doc',
        content: [paragraphBlock('b1', '原文')],
      } as never,
      attrs: {} as never,
      tool_kind: null,
      tool_state: null,
      generation_status: 'ready',
      verification_status: 'verified',
      verification_summary: null,
      generated_by: { by: 'ai', task_kind: 'NoteGenerateTask' } as never,
      verified_by: null,
      history: [],
      archived_at: null,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await writeAiProposal(db, {
      id: 'note_update_atomic_p1',
      payload: {
        kind: 'note_update',
        target: { subject_kind: 'artifact', subject_id: 'artifact_note_atomic' },
        reason_md: 'Atomic Living Note patch',
        evidence_refs: [{ kind: 'artifact', id: 'artifact_note_atomic' }],
        proposed_change: {
          artifact_id: 'artifact_note_atomic',
          source: 'note_refine',
          patch: {
            ops: [{ kind: 'append_block', block: paragraphBlock('b2', '不应落地') }],
          },
          summary: { ops_count: 1, new_blocks: 1 },
        },
        cooldown_key: cooldownKey,
      },
    });
    // Force the final signal increment to fail deterministically. PostgreSQL
    // integer overflow happens after the patch + rate writes inside the tx,
    // proving those earlier writes roll back with it.
    await db.insert(proposal_signals).values({
      id: 'signal_at_integer_max',
      kind: 'note_update',
      cooldown_key: cooldownKey,
      accept_count: 2_147_483_647,
      dismiss_count: 0,
      acceptance_rate: 1,
      created_at: now,
      updated_at: now,
    });

    await expect(acceptAiProposal(db, 'note_update_atomic_p1')).rejects.toThrow(
      /INSERT INTO proposal_signals/,
    );

    const [unchanged] = await db
      .select()
      .from(artifact)
      .where(eq(artifact.id, 'artifact_note_atomic'));
    expect(unchanged.version).toBe(0);
    expect(
      (
        unchanged.body_blocks as {
          content: Array<{ attrs?: { id?: string } }>;
        }
      ).content.some((node) => node.attrs?.id === 'b2'),
    ).toBe(false);
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'note_update_atomic_p1')));
    expect(rateRows).toHaveLength(0);
    const applyRows = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:note_refine_apply'),
          eq(event.caused_by_event_id, 'note_update_atomic_p1'),
        ),
      );
    expect(applyRows).toHaveLength(0);
  });

  // ADR-0040 决定1 (YUK-358) — the undo chain. Retracting an APPLIED note_update
  // proposal must restore the artifact's prior body_blocks + version from the
  // reverse payload that persistNoteRefineApply stored at apply time. Without the
  // retract-side consumer the undo chain is broken in half (apply writes the
  // reverse payload but nothing reverses it).
  it('retractAiProposal restores prior body_blocks when retracting an APPLIED note_update', async () => {
    const db = testDb();
    const now = new Date();
    const originalBody = {
      type: 'doc',
      content: [paragraphBlock('b1', '原文')],
    };
    await db.insert(artifact).values({
      id: 'artifact_undo',
      type: 'note_atomic',
      title: '之的用法',
      parent_artifact_id: null,
      knowledge_ids: [],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      source_ref: null,
      body_blocks: originalBody as never,
      attrs: {} as never,
      tool_kind: null,
      tool_state: null,
      generation_status: 'ready',
      verification_status: 'verified',
      verification_summary: null,
      generated_by: { by: 'ai', task_kind: 'NoteGenerateTask' } as never,
      verified_by: null,
      history: [],
      archived_at: null,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await writeAiProposal(db, {
      id: 'note_undo_p1',
      payload: {
        kind: 'note_update',
        target: { subject_kind: 'artifact', subject_id: 'artifact_undo' },
        reason_md: 'Living Note patch',
        evidence_refs: [{ kind: 'artifact', id: 'artifact_undo' }],
        proposed_change: {
          artifact_id: 'artifact_undo',
          source: 'note_refine',
          patch: {
            ops: [{ kind: 'append_block', block: paragraphBlock('b2', '新增') }],
          },
          summary: { ops_count: 1, new_blocks: 1 },
        },
      },
    });

    // Apply: bumps to version 1 with b2 appended.
    await acceptAiProposal(db, 'note_undo_p1');
    const [applied] = await db.select().from(artifact).where(eq(artifact.id, 'artifact_undo'));
    expect(applied.version).toBe(1);
    expect(
      (applied.body_blocks as { content: Array<{ attrs?: { id?: string } }> }).content.some(
        (node) => node.attrs?.id === 'b2',
      ),
    ).toBe(true);

    // Retract: must restore the prior body_blocks (b2 gone) and bump version again.
    await retractAiProposal(db, 'note_undo_p1', { reason_md: 'mistaken refine' });
    const [restored] = await db.select().from(artifact).where(eq(artifact.id, 'artifact_undo'));
    expect(
      (restored.body_blocks as { content: Array<{ attrs?: { id?: string } }> }).content.some(
        (node) => node.attrs?.id === 'b2',
      ),
    ).toBe(false);
    // Body content matches the pre-apply state exactly (byte-restore).
    expect((restored.body_blocks as { content: unknown[] }).content).toEqual(originalBody.content);
    // version: 0 (seed) → 1 (apply) → 2 (undo restore). Restore is a new revision,
    // not a rollback of the counter.
    expect(restored.version).toBe(2);

    // The undo event must be written (apply event id → undo).
    const undoRows = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:note_refine_undo'));
    expect(undoRows).toHaveLength(1);
  });

  // The non-applied (still-proposed) retract path must be untouched: no rate
  // event ever materialized an apply, so there is nothing to reverse and the
  // artifact stays at its seed state.
  it('retractAiProposal leaves the artifact untouched when retracting a NON-applied note_update', async () => {
    const db = testDb();
    const now = new Date();
    const originalBody = {
      type: 'doc',
      content: [paragraphBlock('b1', '原文')],
    };
    await db.insert(artifact).values({
      id: 'artifact_noapply',
      type: 'note_atomic',
      title: '之的用法',
      parent_artifact_id: null,
      knowledge_ids: [],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      source_ref: null,
      body_blocks: originalBody as never,
      attrs: {} as never,
      tool_kind: null,
      tool_state: null,
      generation_status: 'ready',
      verification_status: 'verified',
      verification_summary: null,
      generated_by: { by: 'ai', task_kind: 'NoteGenerateTask' } as never,
      verified_by: null,
      history: [],
      archived_at: null,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await writeAiProposal(db, {
      id: 'note_noapply_p1',
      payload: {
        kind: 'note_update',
        target: { subject_kind: 'artifact', subject_id: 'artifact_noapply' },
        reason_md: 'Living Note patch',
        evidence_refs: [{ kind: 'artifact', id: 'artifact_noapply' }],
        proposed_change: {
          artifact_id: 'artifact_noapply',
          source: 'note_refine',
          patch: {
            ops: [{ kind: 'append_block', block: paragraphBlock('b2', '新增') }],
          },
          summary: { ops_count: 1, new_blocks: 1 },
        },
      },
    });

    // Retract WITHOUT ever accepting — the proposal was never applied.
    const result = await retractAiProposal(db, 'note_noapply_p1', { reason_md: 'never wanted it' });
    expect(result.kind).toBe('retracted');

    const [unchanged] = await db.select().from(artifact).where(eq(artifact.id, 'artifact_noapply'));
    // Still at seed version with the original body — no spurious revert.
    expect(unchanged.version).toBe(0);
    expect((unchanged.body_blocks as { content: unknown[] }).content).toEqual(originalBody.content);
    const undoRows = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:note_refine_undo'));
    expect(undoRows).toHaveLength(0);
  });

  it('decideKnowledgeEdgeProposal treats generic rate events as idempotent decisions', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    await writeAiProposal(db, {
      id: 'edge_p1',
      payload: {
        kind: 'knowledge_edge',
        target: { subject_kind: 'knowledge_edge', subject_id: null },
        reason_md: 'k1 unlocks k2',
        evidence_refs: [],
        proposed_change: {
          from_knowledge_id: 'k1',
          to_knowledge_id: 'k2',
          relation_type: 'prerequisite',
          weight: 1,
        },
      },
    });
    await db.insert(event).values({
      id: 'rate_edge_p1',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: 'edge_p1',
      outcome: 'success',
      payload: { rating: 'accept' },
      caused_by_event_id: 'edge_p1',
      created_at: new Date(),
    });
    await db.insert(event).values({
      id: 'gen_edge_p1',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'generate',
      subject_kind: 'knowledge_edge',
      subject_id: 'edge_existing',
      outcome: 'success',
      payload: { propose_event_id: 'edge_p1' },
      caused_by_event_id: 'edge_p1',
      created_at: new Date(),
    });

    const result = await decideKnowledgeEdgeProposal(db, 'edge_p1', { decision: 'accept' });

    expect(result).toMatchObject({
      rate_event_id: 'rate_edge_p1',
      generate_event_id: 'gen_edge_p1',
      edge_id: 'edge_existing',
      idempotent: true,
    });
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'edge_p1')));
    expect(rateRows).toHaveLength(1);
  });

  it('serializes concurrent Agency dismisses into one rate event and one signal increment', async () => {
    const db = testDb();
    const proposalId = 'learning_dismiss_race';
    await writeAiProposal(db, {
      id: proposalId,
      payload: {
        kind: 'learning_item',
        target: { subject_kind: 'learning_item', subject_id: null },
        reason_md: 'Create a focused review item',
        evidence_refs: [],
        proposed_change: { title: '并发复习' },
        cooldown_key: 'learning_item:并发复习',
      },
    });

    const lockAcquired = deferred();
    const releaseLock = deferred();
    const holder = db.transaction(async (tx) => {
      await acquireProposalDecisionLock(tx, proposalId);
      lockAcquired.resolve();
      await releaseLock.promise;
    });
    await lockAcquired.promise;

    const concurrentDismisses = [
      dismissAiProposal(db, proposalId, { user_note: 'not now' }),
      dismissAiProposal(db, proposalId, { user_note: 'not now' }),
    ];
    const observedBlocked = await observesBlockedDatabaseSession();
    releaseLock.resolve();
    await holder;
    const results = await Promise.all(concurrentDismisses);

    expect(observedBlocked).toBe(true);
    expect(results.filter((result) => result.idempotent === true)).toHaveLength(1);
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)));
    expect(rateRows).toHaveLength(1);
    expect(await db.select().from(proposal_signals)).toMatchObject([
      { kind: 'learning_item', accept_count: 0, dismiss_count: 1 },
    ]);

    const replay = await dismissAiProposal(db, proposalId, { user_note: 'not now' });
    expect(replay).toMatchObject({ idempotent: true, rate_event_id: rateRows[0].id });
    expect(
      await db
        .select()
        .from(event)
        .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId))),
    ).toHaveLength(1);
    expect(await db.select().from(proposal_signals)).toMatchObject([
      { kind: 'learning_item', accept_count: 0, dismiss_count: 1 },
    ]);
  });

  it('dismiss retry backfills a missing signal after the rate event already exists', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'learning_p1',
      payload: {
        kind: 'learning_item',
        target: { subject_kind: 'learning_item', subject_id: null },
        reason_md: 'Create a focused review item',
        evidence_refs: [],
        proposed_change: { title: '虚词复习' },
        cooldown_key: 'learning_item:虚词复习',
      },
    });
    await db.insert(event).values({
      id: createId(),
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: 'learning_p1',
      outcome: 'success',
      payload: { rating: 'dismiss', user_note: 'first try' },
      caused_by_event_id: 'learning_p1',
      created_at: new Date(),
    });

    const result = await dismissAiProposal(db, 'learning_p1');
    expect(result).toMatchObject({ kind: 'dismissed', idempotent: true });

    const signals = await db.select().from(proposal_signals);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: 'learning_item',
      cooldown_key: 'learning_item:虚词复习',
      dismiss_count: 1,
      accept_count: 0,
    });
  });
});

// =============================================================================
// YUK-471 (retract fold/rollback) — retractAiProposal now reverses the kinds it
// previously only marked: completion / relearn (imperative learning_item row
// reversal) and knowledge_node (soft-delete the created node + keep fold==row).
// =============================================================================

describe('retractAiProposal — completion / relearn row reversal (YUK-471)', () => {
  afterEach(async () => {
    for (const item of await testDb().select().from(learning_item)) {
      if (await hasLearningItemGenesisAnchor(testDb(), item.id)) {
        expect(await gatherAndFoldLearningItem(testDb(), item.id)).toEqual(
          learningItemLiveRowToSnapshot(item),
        );
      }
    }
  });
  beforeEach(async () => {
    await resetDb();
  });

  it('retracting an ACCEPTED completion re-opens the item + deletes the ai_propose evidence', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(learning_item).values({
      id: 'li_done',
      source: 'manual',
      title: '完成候选',
      content: 'content',
      knowledge_ids: [],
      status: 'in_progress',
      created_at: now,
      updated_at: now,
    });
    await migrateCanonicalProjections(db);
    await writeAiProposal(db, {
      id: 'completion_retract_p1',
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'li_done' },
        reason_md: 'item appears mastered',
        evidence_refs: [],
        proposed_change: {
          learning_item_id: 'li_done',
          triggering_signals: ['check_all_passed'],
          evidence_json: {},
        },
        cooldown_key: 'completion:li_done',
      },
    });
    await acceptAiProposal(db, 'completion_retract_p1');

    // Sanity: accept landed.
    let item = (
      await db.select().from(learning_item).where(eq(learning_item.id, 'li_done')).limit(1)
    )[0];
    expect(item.status).toBe('done');
    expect(item.completed_at).toBeInstanceOf(Date);
    expect(
      await db
        .select()
        .from(completion_evidence)
        .where(eq(completion_evidence.learning_item_id, 'li_done')),
    ).toHaveLength(1);

    const result = await retractAiProposal(db, 'completion_retract_p1', {
      reason_md: 'completion was premature',
    });
    expect(result.kind).toBe('retracted');

    // The item is re-opened (not done), completed_at cleared, version bumped.
    item = (
      await db.select().from(learning_item).where(eq(learning_item.id, 'li_done')).limit(1)
    )[0];
    expect(item.status).toBe('in_progress');
    expect(item.completed_at).toBeNull();
    expect(item.version).toBe(2); // accept bumped 0→1, retract bumped 1→2

    // The ai_propose evidence row this proposal created is gone.
    expect(
      await db
        .select()
        .from(completion_evidence)
        .where(eq(completion_evidence.learning_item_id, 'li_done')),
    ).toHaveLength(0);

    // The correction event was chained.
    const correctionRows = await db
      .select()
      .from(event)
      .where(eq(event.id, result.correction_event_id));
    expect(correctionRows[0]).toMatchObject({
      action: 'correct',
      subject_id: 'completion_retract_p1',
    });
  });

  it('retracting a completion that was never accepted is a no-op on the item (only the correct event)', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(learning_item).values({
      id: 'li_open',
      source: 'manual',
      title: '未完成',
      content: 'content',
      knowledge_ids: [],
      status: 'in_progress',
      created_at: now,
      updated_at: now,
    });
    await writeAiProposal(db, {
      id: 'completion_noacc_p1',
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'li_open' },
        reason_md: 'item appears mastered',
        evidence_refs: [],
        proposed_change: { learning_item_id: 'li_open', triggering_signals: [], evidence_json: {} },
        cooldown_key: 'completion:li_open',
      },
    });

    await retractAiProposal(db, 'completion_noacc_p1', { reason_md: 'never wanted it' });

    const item = (
      await db.select().from(learning_item).where(eq(learning_item.id, 'li_open')).limit(1)
    )[0];
    expect(item.status).toBe('in_progress');
    expect(item.completed_at).toBeNull();
    expect(item.version).toBe(0); // untouched
  });

  it('retracting an ACCEPTED relearn restores the item to done', async () => {
    const db = testDb();
    const completedAt = new Date('2026-05-20T00:00:00.000Z');
    await db.insert(learning_item).values({
      id: 'li_relearn_r',
      source: 'manual',
      title: '复学候选',
      content: 'content',
      knowledge_ids: [],
      status: 'done',
      completed_at: completedAt,
      created_at: completedAt,
      updated_at: completedAt,
    });
    await migrateCanonicalProjections(db);
    await writeAiProposal(db, {
      id: 'relearn_retract_p1',
      payload: {
        kind: 'relearn',
        target: { subject_kind: 'learning_item', subject_id: 'li_relearn_r' },
        reason_md: 'mastery decayed',
        evidence_refs: [],
        proposed_change: { learning_item_id: 'li_relearn_r' },
        cooldown_key: 'relearn:li_relearn_r',
      },
    });
    await acceptAiProposal(db, 'relearn_retract_p1');

    let item = (
      await db.select().from(learning_item).where(eq(learning_item.id, 'li_relearn_r')).limit(1)
    )[0];
    expect(item.status).toBe('in_progress');
    expect(item.completed_at).toBeNull();

    const result = await retractAiProposal(db, 'relearn_retract_p1', {
      reason_md: 'still mastered',
    });
    expect(result.kind).toBe('retracted');

    item = (
      await db.select().from(learning_item).where(eq(learning_item.id, 'li_relearn_r')).limit(1)
    )[0];
    expect(item.status).toBe('done');
    // The EXACT prior completed_at is restored from the captured prior-state (NOT `now`).
    expect(item.completed_at?.getTime()).toBe(completedAt.getTime());
    expect(item.version).toBe(2); // accept 0→1, retract 1→2
  });

  it('retracting an ACCEPTED relearn of a RESTING item restores resting (no fabricated completed_at)', async () => {
    const db = testDb();
    const now = new Date();
    // resting item: completed_at is null (decayed, not freshly done).
    await db.insert(learning_item).values({
      id: 'li_resting',
      source: 'manual',
      title: '休眠候选',
      content: 'content',
      knowledge_ids: [],
      status: 'resting',
      completed_at: null,
      created_at: now,
      updated_at: now,
    });
    await migrateCanonicalProjections(db);
    await writeAiProposal(db, {
      id: 'relearn_resting_p1',
      payload: {
        kind: 'relearn',
        target: { subject_kind: 'learning_item', subject_id: 'li_resting' },
        reason_md: 'resurface resting item',
        evidence_refs: [],
        proposed_change: { learning_item_id: 'li_resting' },
        cooldown_key: 'relearn:li_resting',
      },
    });
    await acceptAiProposal(db, 'relearn_resting_p1');

    let item = (
      await db.select().from(learning_item).where(eq(learning_item.id, 'li_resting')).limit(1)
    )[0];
    expect(item.status).toBe('in_progress');

    await retractAiProposal(db, 'relearn_resting_p1', { reason_md: 'leave it resting' });

    item = (
      await db.select().from(learning_item).where(eq(learning_item.id, 'li_resting')).limit(1)
    )[0];
    // REGRESSION GUARD: must restore to 'resting' (NOT 'done'), and must NOT fabricate a
    // completed_at — the prior state was resting/null.
    expect(item.status).toBe('resting');
    expect(item.completed_at).toBeNull();
  });

  it('double-retract of completion is idempotent (second retract is a no-op)', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(learning_item).values({
      id: 'li_dr_completion',
      source: 'manual',
      title: '幂等完成',
      content: 'content',
      knowledge_ids: [],
      status: 'pending',
      created_at: now,
      updated_at: now,
    });
    await migrateCanonicalProjections(db);
    await writeAiProposal(db, {
      id: 'completion_dr_p1',
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'li_dr_completion' },
        reason_md: 'mastered',
        evidence_refs: [],
        proposed_change: {
          learning_item_id: 'li_dr_completion',
          triggering_signals: [],
          evidence_json: {},
        },
        cooldown_key: 'completion:li_dr_completion',
      },
    });
    await acceptAiProposal(db, 'completion_dr_p1');

    await retractAiProposal(db, 'completion_dr_p1', { reason_md: 'first' });
    const afterFirst = (
      await db.select().from(learning_item).where(eq(learning_item.id, 'li_dr_completion')).limit(1)
    )[0];
    // Restored to the captured prior status (pending), not in_progress.
    expect(afterFirst.status).toBe('pending');
    expect(afterFirst.completed_at).toBeNull();

    await retractAiProposal(db, 'completion_dr_p1', { reason_md: 'second' });
    const afterSecond = (
      await db.select().from(learning_item).where(eq(learning_item.id, 'li_dr_completion')).limit(1)
    )[0];
    // Second retract must NOT touch the item again (status no longer 'done' → guard skips).
    expect(afterSecond.status).toBe('pending');
    expect(afterSecond.version).toBe(afterFirst.version);
    expect(afterSecond.updated_at.getTime()).toBe(afterFirst.updated_at.getTime());
    // The evidence row stays gone (no resurrection).
    expect(
      await db
        .select()
        .from(completion_evidence)
        .where(eq(completion_evidence.learning_item_id, 'li_dr_completion')),
    ).toHaveLength(0);
  });

  it('double-retract of relearn is idempotent (second retract is a no-op)', async () => {
    const db = testDb();
    const completedAt = new Date('2026-05-20T00:00:00.000Z');
    await db.insert(learning_item).values({
      id: 'li_dr_relearn',
      source: 'manual',
      title: '幂等复学',
      content: 'content',
      knowledge_ids: [],
      status: 'done',
      completed_at: completedAt,
      created_at: completedAt,
      updated_at: completedAt,
    });
    await migrateCanonicalProjections(db);
    await writeAiProposal(db, {
      id: 'relearn_dr_p1',
      payload: {
        kind: 'relearn',
        target: { subject_kind: 'learning_item', subject_id: 'li_dr_relearn' },
        reason_md: 'decayed',
        evidence_refs: [],
        proposed_change: { learning_item_id: 'li_dr_relearn' },
        cooldown_key: 'relearn:li_dr_relearn',
      },
    });
    await acceptAiProposal(db, 'relearn_dr_p1');

    await retractAiProposal(db, 'relearn_dr_p1', { reason_md: 'first' });
    const afterFirst = (
      await db.select().from(learning_item).where(eq(learning_item.id, 'li_dr_relearn')).limit(1)
    )[0];
    expect(afterFirst.status).toBe('done');

    await retractAiProposal(db, 'relearn_dr_p1', { reason_md: 'second' });
    const afterSecond = (
      await db.select().from(learning_item).where(eq(learning_item.id, 'li_dr_relearn')).limit(1)
    )[0];
    // Second retract is a no-op (status no longer 'in_progress' → guard skips).
    expect(afterSecond.status).toBe('done');
    expect(afterSecond.version).toBe(afterFirst.version);
    expect(afterSecond.completed_at?.getTime()).toBe(afterFirst.completed_at?.getTime());
  });
});

describe('retractAiProposal — knowledge_node soft-delete + fold==row (YUK-471)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('retracting an ACCEPTED knowledge_node archives the created node AND keeps fold==row', async () => {
    const db = testDb();
    await seedKnowledge(['parent_node']);
    await writeAiProposal(db, {
      id: 'knode_retract_p1',
      payload: {
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: null },
        reason_md: 'a useful KC',
        evidence_refs: [],
        proposed_change: {
          mutation: 'propose_new',
          name: '待撤回节点',
          parent_id: 'parent_node',
        },
        cooldown_key: 'knowledge_node:parent_node:待撤回节点',
      },
    });

    const accept = await acceptAiProposal(db, 'knode_retract_p1');
    const newNodeId = acceptedKnowledgeNodeId(accept);
    expect(newNodeId).not.toBe('');

    // After accept: node is live, and fold==row.
    let liveRows = await db.select().from(knowledge).where(eq(knowledge.id, newNodeId));
    expect(liveRows[0].archived_at).toBeNull();
    let fold = await gatherAndFoldKnowledgeNode(db, newNodeId);
    expect(fold).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above.
    expect(fold).toEqual(knowledgeLiveRowToSnapshot(liveRows[0]!));

    await retractAiProposal(db, 'knode_retract_p1', { reason_md: 'wrong node' });

    // After retract: node is soft-deleted (archived_at set), version bumped.
    liveRows = await db.select().from(knowledge).where(eq(knowledge.id, newNodeId));
    expect(liveRows[0].archived_at).toBeInstanceOf(Date);
    expect(liveRows[0].version).toBe(1);
    // It no longer shows up among live (archived_at IS NULL) nodes.
    const stillLive = await db
      .select()
      .from(knowledge)
      .where(and(eq(knowledge.id, newNodeId), isNull(knowledge.archived_at)));
    expect(stillLive).toHaveLength(0);

    // CRITICAL: fold(events) still equals the row after the retract reversal.
    fold = await gatherAndFoldKnowledgeNode(db, newNodeId);
    expect(fold).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above.
    expect(fold).toEqual(knowledgeLiveRowToSnapshot(liveRows[0]!));
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above.
    expect(fold!.archived_at).toBeInstanceOf(Date);
  });

  it('retracting a knowledge_node twice is idempotent (no double archive bump)', async () => {
    const db = testDb();
    await seedKnowledge(['parent_node2']);
    await writeAiProposal(db, {
      id: 'knode_retract_p2',
      payload: {
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: null },
        reason_md: 'a KC',
        evidence_refs: [],
        proposed_change: { mutation: 'propose_new', name: '幂等节点', parent_id: 'parent_node2' },
        cooldown_key: 'knowledge_node:parent_node2:幂等节点',
      },
    });
    const accept = await acceptAiProposal(db, 'knode_retract_p2');
    const newNodeId = acceptedKnowledgeNodeId(accept);

    await retractAiProposal(db, 'knode_retract_p2', { reason_md: 'first retract' });
    const afterFirst = (
      await db.select().from(knowledge).where(eq(knowledge.id, newNodeId)).limit(1)
    )[0];
    await retractAiProposal(db, 'knode_retract_p2', { reason_md: 'second retract' });
    const afterSecond = (
      await db.select().from(knowledge).where(eq(knowledge.id, newNodeId)).limit(1)
    )[0];

    // Second retract must NOT re-archive / bump version again.
    expect(afterSecond.version).toBe(afterFirst.version);
    expect(afterSecond.archived_at?.getTime()).toBe(afterFirst.archived_at?.getTime());
    // And fold==row still holds.
    const fold = await gatherAndFoldKnowledgeNode(db, newNodeId);
    expect(fold).toEqual(knowledgeLiveRowToSnapshot(afterSecond));
  });

  it('ATOMICITY: a reversal throw rolls back the WHOLE retract (no orphan correct event)', async () => {
    const db = testDb();
    await seedKnowledge(['parent_atomic']);
    await writeAiProposal(db, {
      id: 'knode_atomic_p1',
      payload: {
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: null },
        reason_md: 'a KC',
        evidence_refs: [],
        proposed_change: { mutation: 'propose_new', name: '原子节点', parent_id: 'parent_atomic' },
        cooldown_key: 'knowledge_node:parent_atomic:原子节点',
      },
    });
    const accept = await acceptAiProposal(db, 'knode_atomic_p1');
    const newNodeId = acceptedKnowledgeNodeId(accept);

    // Corrupt the node row OUT OF BAND (rename it without an event) so the in-tx parity
    // assert (fold != row) THROWS during the knowledge_node retract reversal. In test env
    // a parity mismatch throws (dev/test-throws switch). This makes the reversal fail AFTER
    // the correct event was queued inside the SAME tx — proving the single-tx wrap rolls the
    // whole thing back.
    await db
      .update(knowledge)
      .set({ name: 'out-of-band-rename', version: 99 })
      .where(eq(knowledge.id, newNodeId));

    await expect(
      retractAiProposal(db, 'knode_atomic_p1', { reason_md: 'should roll back' }),
    ).rejects.toThrow();

    // The correct (retract) event must NOT have been committed — the whole tx rolled back.
    const correctEvents = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'correct'),
          eq(event.subject_kind, 'event'),
          eq(event.subject_id, 'knode_atomic_p1'),
        ),
      );
    expect(correctEvents).toHaveLength(0);

    // And the node was NOT archived (the applyArchive UPDATE rolled back too).
    const node = (await db.select().from(knowledge).where(eq(knowledge.id, newNodeId)).limit(1))[0];
    expect(node.archived_at).toBeNull();
  });
});
