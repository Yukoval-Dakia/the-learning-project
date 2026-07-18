import { describe, expect, it } from 'vitest';
import { type EdgeProposalInboxRow, edgeProposalOperation } from './knowledge-api';

function proposal(edgeOp?: 'create' | 'archive'): EdgeProposalInboxRow {
  return {
    id: 'proposal_1',
    status: 'pending',
    proposed_at: '2026-07-18T00:00:00.000Z',
    payload: {
      proposed_change: {
        ...(edgeOp ? { edge_op: edgeOp } : {}),
        from_knowledge_id: 'kc_from',
        to_knowledge_id: 'kc_to',
        relation_type: 'related_to',
      },
    },
  };
}

describe('edgeProposalOperation', () => {
  it('preserves explicit archive proposals for destructive UI treatment', () => {
    expect(edgeProposalOperation(proposal('archive'))).toBe('archive');
  });

  it('keeps legacy proposals without edge_op backward-compatible as create', () => {
    expect(edgeProposalOperation(proposal())).toBe('create');
    expect(edgeProposalOperation(proposal('create'))).toBe('create');
  });
});
