import { dismissAiProposal } from '@/server/proposals/actions';
import { writeAiProposal } from '@/server/proposals/writer';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './route';

async function fetchTodayProposals(): Promise<Response> {
  return GET(new Request('http://localhost/api/today/proposals'));
}

describe('GET /api/today/proposals', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('summarizes pending proposal inbox rows through the shared reader', async () => {
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

    const res = await fetchTodayProposals();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      by_kind: Record<string, number>;
      status: string;
      has_more: boolean;
    };
    expect(body.status).toBe('pending');
    expect(body.total).toBe(2);
    expect(body.has_more).toBe(false);
    expect(body.by_kind.knowledge_node).toBe(1);
    expect(body.by_kind.knowledge_edge).toBe(1);
  });

  it('excludes dismissed proposals from the pending count', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'node_pending',
      payload: {
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: null },
        reason_md: 'still pending',
        evidence_refs: [],
        proposed_change: { mutation: 'propose_new', name: '通假字', parent_id: 'parent_1' },
      },
    });
    await writeAiProposal(db, {
      id: 'node_dismissed',
      payload: {
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: null },
        reason_md: 'will be dismissed',
        evidence_refs: [],
        proposed_change: { mutation: 'propose_new', name: '虚词', parent_id: 'parent_1' },
      },
    });
    await dismissAiProposal(db, 'node_dismissed', { user_note: 'not now' });

    const res = await fetchTodayProposals();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      by_kind: Record<string, number>;
      status: string;
    };
    expect(body.status).toBe('pending');
    expect(body.total).toBe(1);
    expect(body.by_kind.knowledge_node).toBe(1);
  });
});
