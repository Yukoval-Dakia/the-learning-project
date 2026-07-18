// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProposalCard } from './ProposalCard';
import type { ProposalInboxRow } from './inbox-api';

afterEach(cleanup);

function proposal(): ProposalInboxRow {
  return {
    id: 'proposal_1',
    kind: 'learning_item',
    target: { subject_kind: 'learning_item', subject_id: 'item_1' },
    payload: {
      kind: 'learning_item',
      reason_md: '建议补一条学习主线。',
      evidence_refs: [
        { kind: 'event', id: 'evt_private' },
        { kind: 'knowledge', id: 'kn_visible' },
      ],
    },
    status: 'pending',
    proposed_at: '2026-07-18T00:00:00.000Z',
    decided_at: null,
    actor_ref: 'dreaming',
    task_run_id: null,
    cost_micro_usd: null,
    source_action: 'experimental:proposal',
    source_subject_kind: 'learning_item',
    signals: null,
  };
}

describe('ProposalCard evidence semantics', () => {
  it('renders only navigable evidence as an action and keeps raw ids private', async () => {
    const navigate = vi.fn();
    const { container } = render(
      <ProposalCard
        p={proposal()}
        index={0}
        resolved={null}
        nameOf={(id) => id}
        navigate={navigate}
        onResolve={() => {}}
        onError={() => {}}
      />,
    );

    const displayOnly = screen.getByText('源自一次 AI 判定事件').closest('.evidence-readable');
    expect(displayOnly?.tagName).toBe('SPAN');

    const actionable = screen.getByRole('button', { name: /源自一个知识点.*查看/ });
    await userEvent.click(actionable);
    expect(navigate).toHaveBeenCalledWith('/knowledge/kn_visible');

    expect(container.innerHTML).not.toContain('evt_private');
    expect(container.innerHTML).not.toContain('kn_visible');
  });
});
