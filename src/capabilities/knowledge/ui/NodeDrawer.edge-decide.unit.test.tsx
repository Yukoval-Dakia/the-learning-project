// @vitest-environment jsdom
// YUK-713 — deciding an AI edge proposal used to be `.then` with no `.catch`, so a
// 409/500 died as an unhandled rejection with no user feedback. The row must now show a
// retryable failure and re-enable the buttons.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeDrawer } from './NodeDrawer';
import type { EdgeProposalInboxRow, KnowledgeTreeNode } from './knowledge-api';

const mocks = vi.hoisted(() => ({
  decideEdgeProposal: vi.fn(),
  createEdge: vi.fn(),
  getNodePage: vi.fn(),
}));

vi.mock('./knowledge-api', async (importActual) => {
  const actual = await importActual<typeof import('./knowledge-api')>();
  return {
    ...actual,
    decideEdgeProposal: mocks.decideEdgeProposal,
    createEdge: mocks.createEdge,
    getNodePage: mocks.getNodePage,
  };
});

const NODE: KnowledgeTreeNode = {
  id: 'kn_1',
  name: '知识点甲',
  domain: null,
  parent_id: null,
  effective_domain: null,
  mastery: null,
  mastery_lo: null,
  mastery_hi: null,
  low_confidence: false,
  evidence_count: 0,
};
const NODE2: KnowledgeTreeNode = { ...NODE, id: 'kn_2', name: '知识点乙' };

const PROPOSAL: EdgeProposalInboxRow = {
  id: 'ev_1',
  status: 'pending',
  proposed_at: '2026-07-19T00:00:00Z',
  payload: {
    proposed_change: {
      edge_op: 'create',
      from_knowledge_id: 'kn_1',
      to_knowledge_id: 'kn_2',
      relation_type: 'related_to',
    },
  },
};

function renderDrawer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <NodeDrawer
        node={NODE}
        nodes={[NODE, NODE2]}
        edges={[]}
        edgeProposals={[PROPOSAL]}
        open
        onClose={vi.fn()}
        go={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getNodePage.mockResolvedValue({ interactive_artifacts: [] });
});

afterEach(cleanup);

describe('NodeDrawer edge-decide failure (YUK-713)', () => {
  it('surfaces a retryable failure when deciding a proposal rejects', async () => {
    mocks.decideEdgeProposal.mockRejectedValue(new Error('409'));
    const user = userEvent.setup();
    renderDrawer();

    const accept = await screen.findByRole('button', { name: '建立关系' });
    await user.click(accept);

    expect(await screen.findByText('操作失败，请重试。')).toBeTruthy();
    // busy is reset in .finally → the action stays retryable, not dead.
    expect((screen.getByRole('button', { name: '建立关系' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    // no false-success chip.
    expect(screen.queryByText('已建立')).toBeNull();
  });
});
