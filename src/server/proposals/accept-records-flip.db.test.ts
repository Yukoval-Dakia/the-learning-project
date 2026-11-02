// YUK-1578 — accept→records: the post-commit learning-record flip is
// best-effort bookkeeping; its failure must not report the committed accept
// as a failed decision. Only markRecordsActioned is overridden; everything
// else (including the writer's markRecordsLinked) stays real.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/kernel/records/record-processing', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/kernel/records/record-processing')>();
  return {
    ...original,
    markRecordsActioned: async () => {
      throw new Error('records flip failed');
    },
  };
});

import { knowledge, knowledge_edge } from '@/db/schema';
import { getProposalInboxRow } from '@/kernel/proposals/inbox';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { backfillKnowledgeEdgeGenesis } from '../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { acceptAiProposal } from './actions';

const KNOWLEDGE_BASE = {
  domain: 'yuwen',
  parent_id: null,
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
};

describe('acceptAiProposal records-flip degradation', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // @invariant data: an accept whose evidence records fail to actionize still returns the committed accept result with the proposal accepted, instead of surfacing the post-commit flip as a failed decision
  // @fails-if the post-commit markRecordsActioned exception propagates out of acceptAiProposal, so the API reports the committed accept as a failure
  it('returns the committed accept when the records flip fails', async () => {
    const db = testDb();
    const now = new Date();
    for (const id of ['k1', 'k2', 'k3']) {
      await db
        .insert(knowledge)
        .values({ id, name: id, ...KNOWLEDGE_BASE, created_at: now, updated_at: now });
    }
    await db.insert(knowledge_edge).values({
      id: 'edge_flip_superseded',
      from_knowledge_id: 'k2',
      to_knowledge_id: 'k1',
      relation_type: 'related_to',
      weight: 1,
      created_by: { actor_kind: 'user', actor_ref: 'self' } as never,
      created_at: now,
    });
    await writeAiProposal(db, {
      id: 'edge_flip_p1',
      payload: {
        kind: 'knowledge_edge',
        target: { subject_kind: 'knowledge_edge', subject_id: 'edge_flip_superseded' },
        reason_md: 'the candidate corrects the old edge',
        evidence_refs: [{ kind: 'record', id: 'rec_1' }],
        proposed_change: {
          edge_op: 'supersede',
          from_knowledge_id: 'k1',
          to_knowledge_id: 'k3',
          relation_type: 'contrasts_with',
          weight: 0.8,
          archive_edge_id: 'edge_flip_superseded',
          supersede_confidence: 0.91,
          supersede_neighbor_index: 0,
          supersede_affected_refs: [{ kind: 'question', id: 'question_1' }],
        },
        cooldown_key: 'knowledge_edge_supersede:edge_flip_superseded:k1|k3|contrasts_with',
      },
    });
    await backfillKnowledgeEdgeGenesis(db);

    const result = await acceptAiProposal(db, 'edge_flip_p1');
    expect(result.kind).toBe('knowledge_edge');
    expect((await getProposalInboxRow(db, 'edge_flip_p1'))?.status).toBe('accepted');
  });
});
