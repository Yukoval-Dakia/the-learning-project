import { writeEvent } from '@/server/events/queries';
import { writeAiProposal } from '@/server/proposals/writer';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { GET } from './route';

async function getProposals(qs = ''): Promise<Response> {
  return GET(
    new Request(`http://localhost/api/proposals${qs ? `?${qs}` : ''}`, {
      method: 'GET',
    }),
  );
}

describe('GET /api/proposals', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns a mixed pending proposal queue from the shared reader', async () => {
    const db = testDb();
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
    await writeAiProposal(db, {
      id: 'edge_p1',
      payload: {
        kind: 'knowledge_edge',
        target: { subject_kind: 'knowledge_edge', subject_id: null },
        reason_md: 'Edge evidence',
        evidence_refs: [],
        proposed_change: {
          from_knowledge_id: 'k1',
          to_knowledge_id: 'k2',
          relation_type: 'prerequisite',
          weight: 0.7,
        },
      },
    });
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

    const res = await getProposals('status=pending');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ id: string; kind: string; status: string; payload: { kind: string } }>;
    };
    expect(body.rows.map((row) => row.id).sort()).toEqual(['edge_p1', 'learning_p1', 'node_p1']);
    expect(body.rows.map((row) => row.kind).sort()).toEqual([
      'knowledge_edge',
      'knowledge_node',
      'learning_item',
    ]);
    expect(body.rows.every((row) => row.status === 'pending')).toBe(true);
  });

  it('filters out proposals already rated or corrected', async () => {
    const db = testDb();
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
    await writeEvent(db, {
      id: 'rate_node_p1',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: 'node_p1',
      outcome: 'success',
      payload: { rating: 'accept' },
      caused_by_event_id: 'node_p1',
      created_at: new Date(),
    });

    const res = await getProposals('status=pending');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });

  it('returns 400 for an invalid status filter', async () => {
    const res = await getProposals('status=maybe');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });
});
