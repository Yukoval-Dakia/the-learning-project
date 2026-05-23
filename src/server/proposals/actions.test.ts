import { event, knowledge, knowledge_edge } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  acceptAiProposal,
  decideKnowledgeEdgeProposal,
  dismissAiProposal,
  retractAiProposal,
} from './actions';
import { writeAiProposal } from './writer';

const KNOWLEDGE_BASE = {
  domain: 'wenyan',
  parent_id: null,
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
};

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

describe('proposal lifecycle owner service', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('acceptAiProposal materializes a knowledge_node proposal through the knowledge owner service', async () => {
    const db = testDb();
    await seedKnowledge(['parent_1']);
    await writeAiProposal(db, {
      id: 'node_p1',
      payload: {
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: null },
        reason_md: 'New node evidence',
        evidence_refs: [],
        proposed_change: {
          mutation: 'propose_new',
          name: '通假字',
          parent_id: 'parent_1',
        },
      },
    });

    const result = await acceptAiProposal(db, 'node_p1');
    expect(result.kind).toBe('knowledge_node');

    const knowledgeRows = await db.select().from(knowledge).where(eq(knowledge.name, '通假字'));
    expect(knowledgeRows).toHaveLength(1);
    expect(knowledgeRows[0].parent_id).toBe('parent_1');

    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'node_p1')));
    expect(rateRows).toHaveLength(1);
    expect((rateRows[0].payload as { rating?: string }).rating).toBe('accept');
  });

  it('acceptAiProposal materializes a knowledge_edge proposal through the edge owner service', async () => {
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
          weight: 0.7,
        },
      },
    });

    const result = await acceptAiProposal(db, 'edge_p1');
    expect(result.kind).toBe('knowledge_edge');
    if (result.kind !== 'knowledge_edge') throw new Error('unexpected result');
    expect(result.edge_id).toBeTruthy();
    expect(result.rate_event_id).toBeTruthy();
    if (!result.edge_id) throw new Error('missing edge_id');

    const edges = await db
      .select()
      .from(knowledge_edge)
      .where(eq(knowledge_edge.id, result.edge_id));
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'prerequisite',
      weight: 0.7,
    });
  });

  it('decideKnowledgeEdgeProposal preserves reverse/change_type decisions for edge proposals', async () => {
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

    const result = await decideKnowledgeEdgeProposal(db, 'edge_p1', { decision: 'reverse' });
    expect(result.edge_id).toBeTruthy();
    if (!result.edge_id) throw new Error('missing edge_id');
    const edges = await db
      .select()
      .from(knowledge_edge)
      .where(eq(knowledge_edge.id, result.edge_id));
    expect(edges[0].from_knowledge_id).toBe('k2');
    expect(edges[0].to_knowledge_id).toBe('k1');
  });

  it('dismissAiProposal records a generic RateEvent for future proposal kinds', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'learning_p1',
      payload: {
        kind: 'learning_item',
        target: { subject_kind: 'learning_item', subject_id: null },
        reason_md: 'Create a focused review item',
        evidence_refs: [],
        proposed_change: { title: '虚词复习' },
      },
    });

    const result = await dismissAiProposal(db, 'learning_p1', { user_note: 'not now' });
    expect(result.kind).toBe('dismissed');

    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'learning_p1')));
    expect(rateRows).toHaveLength(1);
    expect(rateRows[0].subject_kind).toBe('event');
    expect(rateRows[0].payload).toMatchObject({ rating: 'dismiss', user_note: 'not now' });
  });

  it('retractAiProposal writes a CorrectEvent chained to the proposal event', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'learning_p1',
      payload: {
        kind: 'learning_item',
        target: { subject_kind: 'learning_item', subject_id: null },
        reason_md: 'Create a focused review item',
        evidence_refs: [],
        proposed_change: { title: '虚词复习' },
      },
    });

    const result = await retractAiProposal(db, 'learning_p1', { reason_md: 'bad suggestion' });
    expect(result.kind).toBe('retracted');

    const correctionRows = await db
      .select()
      .from(event)
      .where(eq(event.id, result.correction_event_id));
    expect(correctionRows).toHaveLength(1);
    expect(correctionRows[0]).toMatchObject({
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'learning_p1',
      caused_by_event_id: 'learning_p1',
    });
    expect(correctionRows[0].payload).toMatchObject({
      correction_kind: 'retract',
      reason_md: 'bad suggestion',
    });
  });

  it('acceptAiProposal rejects future proposal kinds until their owner services exist', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'learning_p1',
      payload: {
        kind: 'learning_item',
        target: { subject_kind: 'learning_item', subject_id: null },
        reason_md: 'Create a focused review item',
        evidence_refs: [],
        proposed_change: { title: '虚词复习' },
      },
    });

    await expect(acceptAiProposal(db, 'learning_p1')).rejects.toMatchObject({
      code: 'unsupported_proposal_kind',
      status: 400,
    });
  });
});
