import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { decideKnowledgeEdgeProposal } from '@/capabilities/knowledge/server/edge-proposal-accept';
import { createKnowledgeNodeFromEvents } from '@/capabilities/knowledge/server/node-creation';
import {
  acceptProposal,
  writeKnowledgeProposeEvent,
} from '@/capabilities/knowledge/server/proposals';
import { event, knowledge, materialized_id_index } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { migrateCanonicalProjections } from '../../../scripts/migrate-canonical-projections';
import { resetDb, testDb } from '../../../tests/helpers/db';

async function acceptedGraph() {
  const db = testDb();
  await db.transaction(async (tx) => {
    for (const id of ['root', 'source'])
      await createKnowledgeNodeFromEvents(
        tx,
        {
          id,
          name: id === 'root' ? '条件概率及独立性' : '贝叶斯公式与先验后验',
          domain: 'math',
          parent_id: id === 'root' ? null : 'root',
          proposed_by_ai: false,
          created_at: new Date(),
        },
        { actorRef: 'migration-fixture' },
      );
  });
  const proposal = await writeKnowledgeProposeEvent(db, {
    payload: { mutation: 'propose_new', name: '全概率与条件概率的联系', parent_id: 'root' },
    reasoning: '保留概率条件、来源归因与完整接受链。',
  });
  const minted = await acceptProposal(db, proposal);
  if (minted.kind !== 'propose_new_applied') throw new Error('unexpected creation result');
  const merge = await writeKnowledgeProposeEvent(db, {
    payload: {
      mutation: 'merge',
      into_id: minted.new_node_id,
      from_ids: ['source'],
      expected_versions: { source: 0 },
    },
    reasoning: '验证间接创建和合并来源的历史完整性。',
  });
  await acceptProposal(db, merge);
  return { db, proposal, minted: minted.new_node_id };
}

describe('knowledge deployment history', () => {
  beforeEach(resetDb);

  it('accepts indirect creation and merge-from history without adding replacement genesis', async () => {
    const { db } = await acceptedGraph();
    const before = await db.select().from(event).orderBy(event.id);
    const report = await migrateCanonicalProjections(db);
    expect(report.knowledge).toEqual({ seeded: 0, skipped: 3, checked: 3 });
    expect(await db.select().from(event).orderBy(event.id)).toEqual(before);
  });

  it.each(['acceptance', 'index', 'merge source base', 'proposal and index'])(
    'rejects missing %s without manufacturing a new baseline',
    async (failure) => {
      const { db, proposal, minted } = await acceptedGraph();
      if (failure === 'acceptance') {
        await db
          .delete(event)
          .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposal)));
      } else if (failure === 'index') {
        await db
          .delete(materialized_id_index)
          .where(eq(materialized_id_index.materialized_id, minted));
      } else if (failure === 'proposal and index') {
        await db
          .delete(materialized_id_index)
          .where(eq(materialized_id_index.materialized_id, minted));
        await db.delete(event).where(eq(event.id, proposal));
      } else {
        await db
          .delete(materialized_id_index)
          .where(eq(materialized_id_index.materialized_id, 'source'));
        await db
          .delete(event)
          .where(and(eq(event.action, 'experimental:genesis'), eq(event.subject_id, 'source')));
      }
      const before = await db.select().from(event).orderBy(event.id);
      const nodes = await db.select().from(knowledge).orderBy(knowledge.id);
      await expect(migrateCanonicalProjections(db)).rejects.toThrow(/history|anchor|index|base/);
      expect(await db.select().from(event).orderBy(event.id)).toEqual(before);
      expect(await db.select().from(knowledge).orderBy(knowledge.id)).toEqual(nodes);
    },
  );

  it('accepts split children anchored to their source proposal and later acceptance', async () => {
    const { db, minted } = await acceptedGraph();
    const proposal = await writeKnowledgeProposeEvent(db, {
      payload: {
        mutation: 'split',
        from_id: minted,
        expected_version: 1,
        into: [
          { name: '条件概率的定义域', parent_id: 'root' },
          { name: '全概率公式的互斥完备条件', parent_id: 'root' },
        ],
      },
      reasoning: '将混合概念拆为两个可复习节点，保留来源历史。',
    });
    const result = await acceptProposal(db, proposal);
    expect(result.kind).toBe('split_applied');
    expect((await migrateCanonicalProjections(db)).knowledge).toEqual({
      seeded: 0,
      skipped: 5,
      checked: 5,
    });
  });

  it('does not mistake a pending proposal for legacy row mutation history', async () => {
    const db = testDb();
    await db.insert(knowledge).values({
      id: 'legacy-root',
      name: '概率',
      domain: 'math',
      created_at: new Date(),
      updated_at: new Date(),
    });
    await writeKnowledgeProposeEvent(db, {
      payload: { mutation: 'propose_new', name: '尚未接受的条件概率', parent_id: 'legacy-root' },
      reasoning: '只提出建议，不应阻止旧数据准备。',
    });
    expect((await migrateCanonicalProjections(db)).knowledge.seeded).toBe(1);
    expect((await migrateCanonicalProjections(db)).knowledge.seeded).toBe(0);
  });

  it('validates the actual edge decision envelope and refuses loss of its generated effect', async () => {
    const { db, minted } = await acceptedGraph();
    await writeEvent(db, {
      id: 'edge-proposal',
      actor_kind: 'agent',
      actor_ref: 'agent:test',
      action: 'propose',
      subject_kind: 'knowledge_edge',
      subject_id: minted,
      outcome: 'partial',
      payload: {
        from_knowledge_id: 'separate',
        to_knowledge_id: minted,
        relation_type: 'related_to',
        weight: 0.7,
        reasoning: '关联概率概念，验证真实接受链。',
      },
    });
    // A direct tree pair is forbidden for all relations; use a separate leaf endpoint.
    await db.transaction((tx) =>
      createKnowledgeNodeFromEvents(
        tx,
        {
          id: 'separate',
          name: '独立性与条件概率反例',
          domain: 'math',
          parent_id: null,
          proposed_by_ai: false,
          created_at: new Date(),
        },
        { actorRef: 'migration-fixture' },
      ),
    );
    const decision = await decideKnowledgeEdgeProposal(db, 'edge-proposal', { decision: 'accept' });
    expect((await migrateCanonicalProjections(db)).knowledge_edge.checked).toBe(1);
    if (!decision.generate_event_id) throw new Error('missing generated edge');
    await db.delete(event).where(eq(event.id, decision.generate_event_id));
    await expect(migrateCanonicalProjections(db)).rejects.toThrow(/missing accepted edge effect/);
  });

  it('refuses an archive-only edge history even when its fold could synthesize a tombstone', async () => {
    const db = testDb();
    await writeEvent(db, {
      id: 'orphan-archive',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'generate',
      subject_kind: 'knowledge_edge',
      subject_id: 'orphan-edge',
      outcome: 'success',
      payload: {
        edge_op: 'archive',
        from_knowledge_id: 'a',
        to_knowledge_id: 'b',
        relation_type: 'related_to',
      },
    });
    await expect(migrateCanonicalProjections(db)).rejects.toThrow(/without a creation base/);
  });
});
