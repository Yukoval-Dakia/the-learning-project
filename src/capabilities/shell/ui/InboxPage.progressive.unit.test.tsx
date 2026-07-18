// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProposalInboxRow, ProposalPageWire } from './inbox-api';

const mocks = vi.hoisted(() => ({
  decideProposal: vi.fn(),
  getTree: vi.fn(),
  listAutoApplied: vi.fn(),
  listDecisionProposalPage: vi.fn(),
  listObservationProposalPreview: vi.fn(),
  retractProposal: vi.fn(),
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
    retractProposal: mocks.retractProposal,
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

function edgeProposal(
  id: string,
  reason: string,
  operation?: 'create' | 'archive',
  includeArchiveTarget = true,
): ProposalInboxRow {
  return {
    ...proposal(id, reason),
    kind: 'knowledge_edge',
    target: { subject_kind: 'knowledge_edge', subject_id: `${id}_edge` },
    payload: {
      kind: 'knowledge_edge',
      reason_md: reason,
      evidence_refs: [],
      proposed_change: {
        ...(operation ? { edge_op: operation } : {}),
        ...(operation === 'archive' && includeArchiveTarget
          ? { archive_edge_id: `${id}_edge` }
          : {}),
        from_knowledge_id: 'kc_from',
        to_knowledge_id: 'kc_to',
        relation_type: 'prerequisite',
        weight: 1,
      },
    },
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
  mocks.retractProposal.mockReset().mockResolvedValue({ ok: true });
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

  it('refreshes only the auto-applied digest after a retract', async () => {
    const appliedAt = new Date().toISOString();
    mocks.listDecisionProposalPage.mockResolvedValue(
      page([proposal('decision_1', '待裁决保持原位')], null),
    );
    mocks.listAutoApplied
      .mockResolvedValueOnce({
        rows: [
          {
            proposal_id: 'auto_1',
            learning_item_id: 'li_1',
            title: '已自动完成',
            applied_at: appliedAt,
            level: 'ok',
            reverted: false,
          },
        ],
        breaker: { tripped: false, level: 'ok', applied: 1, cap: 20, window: 3_600_000 },
      })
      .mockResolvedValueOnce({
        rows: [
          {
            proposal_id: 'auto_1',
            learning_item_id: 'li_1',
            title: '已自动完成',
            applied_at: appliedAt,
            level: 'ok',
            reverted: true,
          },
        ],
        breaker: { tripped: false, level: 'ok', applied: 1, cap: 20, window: 3_600_000 },
      });
    const user = userEvent.setup();

    renderInbox();
    await screen.findByText('已自动完成');
    await user.click(screen.getByRole('button', { name: '撤销' }));

    expect(await screen.findByText(/已撤销 · 恢复到应用前/)).toBeTruthy();
    expect(mocks.retractProposal).toHaveBeenCalledWith('auto_1');
    expect(mocks.listAutoApplied).toHaveBeenCalledTimes(2);
    expect(mocks.listDecisionProposalPage).toHaveBeenCalledTimes(1);
    expect(mocks.listObservationProposalPreview).toHaveBeenCalledTimes(1);
  });

  it('renders archive edge proposals as destructive accept/dismiss-only decisions', async () => {
    mocks.listDecisionProposalPage.mockResolvedValue(
      page([edgeProposal('archive_1', '旧关系已被更准确的边取代', 'archive')], null),
    );
    const user = userEvent.setup();

    renderInbox();

    const reason = await screen.findByText('旧关系已被更准确的边取代');
    const card = reason.closest('.proposal');
    expect(card).not.toBeNull();
    const archiveCard = within(card as HTMLElement);
    expect(archiveCard.getByText('归档知识关系')).toBeTruthy();
    expect(archiveCard.getByText('将归档')).toBeTruthy();
    expect(archiveCard.queryByRole('button', { name: '改方向' })).toBeNull();
    expect(archiveCard.queryByRole('button', { name: '改关系' })).toBeNull();
    expect(archiveCard.getByRole('button', { name: '保留关系' })).toBeTruthy();

    await user.click(archiveCard.getByRole('button', { name: '确认归档' }));

    expect(mocks.decideProposal).toHaveBeenCalledWith('archive_1', 'accept', {});
    expect(await archiveCard.findByText('已归档')).toBeTruthy();
  });

  it('keeps legacy edge proposals on explicit create semantics', async () => {
    mocks.listDecisionProposalPage.mockResolvedValue(
      page([edgeProposal('create_1', '建议补充前置关系')], null),
    );

    renderInbox();

    const reason = await screen.findByText('建议补充前置关系');
    const card = reason.closest('.proposal');
    expect(card).not.toBeNull();
    const createCard = within(card as HTMLElement);
    expect(createCard.getByText('新增知识关系')).toBeTruthy();
    expect(createCard.getByText('将新增')).toBeTruthy();
    expect(createCard.getByRole('button', { name: '建立关系' })).toBeTruthy();
    expect(createCard.getByRole('button', { name: '改方向' })).toBeTruthy();
    expect(createCard.getByRole('button', { name: '改关系' })).toBeTruthy();
  });

  it('fails closed when an archive proposal has no archive target', async () => {
    mocks.listDecisionProposalPage.mockResolvedValue(
      page([edgeProposal('archive_invalid', '缺少归档目标', 'archive', false)], null),
    );

    renderInbox();

    const reason = await screen.findByText('缺少归档目标');
    const card = reason.closest('.proposal');
    expect(card).not.toBeNull();
    const archiveCard = within(card as HTMLElement);
    expect(archiveCard.getByText('归档目标缺失')).toBeTruthy();
    expect(archiveCard.getByRole<HTMLButtonElement>('button', { name: '确认归档' }).disabled).toBe(
      true,
    );
    expect(archiveCard.getByRole('button', { name: '保留关系' })).toBeTruthy();
  });
});
