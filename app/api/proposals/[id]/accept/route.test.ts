import { event, knowledge, knowledge_edge } from '@/db/schema';
import { writeAiProposal } from '@/server/proposals/writer';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { POST } from './route';

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

async function acceptProposal(id: string, body: unknown = {}): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/proposals/${id}/accept`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe('POST /api/proposals/[id]/accept', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('accepts a knowledge_node proposal through the generic route', async () => {
    const db = testDb();
    await seedKnowledge(['parent_1']);
    await writeAiProposal(db, {
      id: 'node_p1',
      payload: {
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: null },
        reason_md: 'New node evidence',
        evidence_refs: [],
        proposed_change: { mutation: 'propose_new', name: '通假字', parent_id: 'parent_1' },
      },
    });

    const res = await acceptProposal('node_p1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe('knowledge_node');

    const knowledgeRows = await db.select().from(knowledge).where(eq(knowledge.name, '通假字'));
    expect(knowledgeRows).toHaveLength(1);
  });

  it('accepts a knowledge_edge proposal and creates the edge', async () => {
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

    const res = await acceptProposal('edge_p1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; edge_id: string };
    expect(body.kind).toBe('knowledge_edge');
    const edges = await db.select().from(knowledge_edge).where(eq(knowledge_edge.id, body.edge_id));
    expect(edges).toHaveLength(1);
  });

  it('returns 400 for future proposal kinds without owner-service semantics', async () => {
    // `completion` accept is not implemented yet (YUK-19 ships learning_item only).
    await writeAiProposal(testDb(), {
      id: 'completion_p1',
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'li_xx' },
        reason_md: 'item appears mastered',
        evidence_refs: [],
        proposed_change: {
          learning_item_id: 'li_xx',
          triggering_signals: ['mastery_high_persisted_14d'],
          evidence_json: {},
        },
      },
    });

    const res = await acceptProposal('completion_p1');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unsupported_proposal_kind');

    const rates = await testDb().select().from(event).where(eq(event.action, 'rate'));
    expect(rates).toHaveLength(0);
  });
});
