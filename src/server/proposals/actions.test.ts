import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  proposeComputedCompletion,
  runLearningItemCompletionNightly,
} from '@/capabilities/agency/server/learning-item-completion-producer';
import { completion_evidence, event, knowledge, learning_item } from '@/db/schema';
import { writeAiProposal } from '@/kernel/proposals/writer';
import {
  gatherAndFoldLearningItem,
  hasLearningItemGenesisAnchor,
} from '@/kernel/records/learning-items';
import { learningItemLiveRowToSnapshot } from '@/server/projections/parity';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  seedCompletionLearningItem,
  seedCompletionProposal,
} from '../../../tests/helpers/native-completion';
import {
  type ProposalLifecycleResult,
  acceptAiProposal,
  dismissAiProposal,
  retractAiProposal,
} from './actions';

const KNOWLEDGE_BASE = {
  domain: 'yuwen',
  parent_id: null,
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
};

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

  // @invariant concurrency: retries claim one verified completion slot beside unverified pending cards, while human dismissal still gates re-proposal
  // @fails-if legacy pending consumes v1 dedupe or budget, retries duplicate v1, or a terminal dismissal is ignored
  it('creates one verified completion beside legacy pending and respects human dismissal', async () => {
    const db = testDb();
    await seedCompletionLearningItem(db, 'legacy-item');
    for (let i = 0; i < 3; i++) {
      await writeAiProposal(db, {
        id: `legacy-${i}`,
        actor_ref: 'synthetic-fixture',
        payload: {
          kind: 'completion',
          target: { subject_kind: 'learning_item', subject_id: 'legacy-item' },
          reason_md: '旧格式建议',
          evidence_refs: [],
          proposed_change: { learning_item_id: 'legacy-item' },
        },
      });
    }
    const propose = () =>
      proposeComputedCompletion(db, 'legacy-item', { actorRef: 'synthetic-fixture' });
    const first = await propose();
    expect(first.status).toBe('proposed');
    if (first.status !== 'proposed') throw new Error('expected verified completion');
    expect(await propose()).toMatchObject({
      status: 'skipped:duplicate_pending',
      proposal_id: first.proposal_id,
    });
    expect((await runLearningItemCompletionNightly(db)).proposed).toBe(0);
    await expect(acceptAiProposal(db, 'legacy-0')).rejects.toMatchObject({ status: 409 });
    await dismissAiProposal(db, first.proposal_id);
    expect(await propose()).toMatchObject({ status: 'skipped:cooldown' });
    expect(
      await db.select().from(event).where(eq(event.action, 'experimental:proposal')),
    ).toHaveLength(4);
    expect(await db.select().from(completion_evidence)).toHaveLength(0);
  });

  // @invariant data: retracting an accepted completion restores the learning item and removes the proposal evidence
  // @fails-if retract leaves the item completed, or leaves the ai_propose/evidence event behind
  it('retracting an ACCEPTED completion re-opens the item + deletes the ai_propose evidence', async () => {
    const db = testDb();
    await seedCompletionLearningItem(db, 'li_done');
    await seedCompletionProposal(db, 'completion_retract_p1', 'li_done');
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
    expect(item.status).toBe('pending');
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
});

describe('retractAiProposal — knowledge_node soft-delete + fold==row (YUK-471)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // @invariant data: a reversal failure rolls back the whole retract, leaving no orphan correct event
  // @fails-if a failed reversal commits a partial retract or leaves an orphan correct event
  it('ATOMICITY: a reversal throw rolls back the WHOLE retract (no orphan correct event)', async () => {
    const db = testDb();
    await seedKnowledge(['parent_atomic']);
    await writeAiProposal(db, {
      actor_ref: 'dreaming',
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
