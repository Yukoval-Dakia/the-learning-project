import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptProposal,
  writeKnowledgeProposeEvent,
} from '@/capabilities/knowledge/server/proposals';
import { event, knowledge, materialized_id_index } from '@/db/schema';
import { createKnowledgeNodeFromEvents } from '@/kernel/records/knowledge-node-birth';
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
});
