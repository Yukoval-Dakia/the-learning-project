// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProposalInboxRow, ProposalPageWire } from './inbox-api';

const mocks = vi.hoisted(() => ({
  decideProposal: vi.fn(),
  getTree: vi.fn(),
  listAutoApplied: vi.fn(),
  listDecisionProposalPage: vi.fn(),
  listObservationProposalPreview: vi.fn(),
}));

vi.mock('@/capabilities/knowledge/ui/knowledge-api', () => ({ getTree: mocks.getTree }));
vi.mock('./inbox-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./inbox-api')>();
  return {
    ...actual,
    decideProposal: mocks.decideProposal,
    listAutoApplied: mocks.listAutoApplied,
    listDecisionProposalPage: mocks.listDecisionProposalPage,
    listObservationProposalPreview: mocks.listObservationProposalPreview,
  };
});

import InboxPage from './InboxPage';

function proposal(id: string, reason: string): ProposalInboxRow {
  return {
    id,
    kind: 'learning_item',
    target: { subject_kind: 'learning_item', subject_id: `${id}_item` },
    payload: { kind: 'learning_item', reason_md: reason, evidence_refs: [] },
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

function page(rows: ProposalInboxRow[], nextCursor: string | null): ProposalPageWire {
  return { rows, next_cursor: nextCursor };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderInbox() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <InboxPage navigate={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.decideProposal.mockReset().mockResolvedValue({ ok: true });
  mocks.getTree.mockReset().mockResolvedValue({ rows: [] });
  mocks.listAutoApplied.mockReset().mockResolvedValue({
    rows: [],
    breaker: { tripped: false, level: 'ok', applied: 0, cap: 20, window: 3_600_000 },
  });
  mocks.listDecisionProposalPage.mockReset();
  mocks.listObservationProposalPreview.mockReset().mockResolvedValue(page([], null));
});

afterEach(cleanup);

describe('InboxPage progressive decision loading', () => {
  it('renders the first decision page while the continuation is still pending', async () => {
    const continuation = deferred<ProposalPageWire>();
    mocks.listDecisionProposalPage.mockImplementation((cursor: string | null) => {
      if (cursor === null) {
        return Promise.resolve(page([proposal('decision_1', '第一页待裁决')], 'd2'));
      }
      return continuation.promise;
    });

    renderInbox();

    expect(await screen.findByText('第一页待裁决')).toBeTruthy();
    expect(screen.queryByText('第二页待裁决')).toBeNull();
    expect(screen.getByText(/正在继续加载待裁决提议；已显示 1 条，可以先处理/)).toBeTruthy();
    await waitFor(() => {
      expect(mocks.listDecisionProposalPage.mock.calls.map(([cursor]) => cursor)).toEqual([
        null,
        'd2',
      ]);
    });

    continuation.resolve(page([proposal('decision_2', '第二页待裁决')], null));

    expect(await screen.findByText('第二页待裁决')).toBeTruthy();
  });

  it('keeps decisions actionable when the independent observation preview fails', async () => {
    mocks.listDecisionProposalPage.mockResolvedValue(
      page([proposal('decision_1', '仍然可以处理')], null),
    );
    mocks.listObservationProposalPreview.mockRejectedValue(new Error('preview unavailable'));

    renderInbox();

    expect(await screen.findByText('仍然可以处理')).toBeTruthy();
    expect(await screen.findByText(/AI 观察记录暂时无法加载/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '接受' })).toBeTruthy();
  });

  it('preserves a first-page decision when a later page refreshes the rendered list', async () => {
    const continuation = deferred<ProposalPageWire>();
    mocks.listDecisionProposalPage.mockImplementation((cursor: string | null) => {
      if (cursor === null) {
        return Promise.resolve(page([proposal('decision_1', '先处理这一条')], 'd2'));
      }
      return continuation.promise;
    });
    const user = userEvent.setup();

    renderInbox();
    await screen.findByText('先处理这一条');
    await user.click(screen.getByRole('button', { name: '接受' }));
    expect(await screen.findByText('已接受')).toBeTruthy();

    continuation.resolve(page([proposal('decision_2', '随后补齐这一条')], null));

    expect(await screen.findByText('随后补齐这一条')).toBeTruthy();
    expect(screen.getByText('已接受')).toBeTruthy();
    const acceptButtons = screen.getAllByRole('button', { name: '接受' }) as HTMLButtonElement[];
    expect(acceptButtons[0].disabled).toBe(true);
    expect(acceptButtons[1].disabled).toBe(false);
  });
});
