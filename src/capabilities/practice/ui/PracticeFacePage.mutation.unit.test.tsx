// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PracticeFacePage from './PracticeFacePage';
import {
  type StreamItem,
  type StreamStatus,
  type StreamView,
  advanceStreamItem,
  getStream,
} from './practice-api';

vi.mock('./practice-api', async (importOriginal) => {
  const original = await importOriginal<typeof import('./practice-api')>();
  return { ...original, getStream: vi.fn(), advanceStreamItem: vi.fn() };
});

vi.mock('./PfSolo', () => ({
  PfSolo: ({
    item,
    onDone,
    onCommittedBack,
  }: {
    item: StreamItem;
    onDone: () => void;
    onCommittedBack: () => void;
  }) => (
    <div>
      <span>solo:{item.id}</span>
      <button type="button" onClick={onDone}>
        完成此题
      </button>
      <button type="button" onClick={onCommittedBack}>
        完成并返回
      </button>
    </div>
  ),
}));
vi.mock('./PfPaper', () => ({ PfPaper: () => <div>paper view</div> }));
vi.mock('./PfRetro', () => ({ PfRetro: () => <div>retro view</div> }));
vi.mock('./PfShelf', () => ({ PfShelf: () => <div>shelf view</div> }));

const getStreamMock = vi.mocked(getStream);
const advanceMock = vi.mocked(advanceStreamItem);

function item(status: StreamStatus = 'pending'): StreamItem {
  return {
    id: 'si_1',
    position: 0,
    item_kind: 'question',
    ref_id: 'q_1',
    source: 'decay',
    reasoning: '该复习了。',
    status,
  };
}

function stream(status: StreamStatus = 'pending'): StreamView {
  const current = item(status);
  return {
    date: '2026-07-13',
    opening_line: '今天先做这一题。',
    items: [current],
    progress: { done: status === 'done' ? 1 : 0, total: 1 },
  };
}

function confirmed(status: StreamStatus) {
  return { item: item(status) };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PracticeFacePage getQuery={() => null} setQuery={() => {}} navigate={() => {}} />
    </QueryClientProvider>,
  );
  return queryClient;
}

beforeEach(() => {
  getStreamMock.mockReset();
  advanceMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('PracticeFacePage stream mutation failure handling', () => {
  it('开始失败时不进入作答面，并可显式重试', async () => {
    getStreamMock.mockResolvedValueOnce(stream());
    advanceMock
      .mockRejectedValueOnce(new Error('start offline'))
      .mockResolvedValueOnce(confirmed('in_progress'));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '开始作答' }));
    expect((await screen.findByRole('alert')).textContent).toContain('开始练习失败：start offline');
    expect(screen.queryByText('solo:si_1')).toBeNull();

    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('solo:si_1')).toBeTruthy();
  });

  it('完成失败时保留作答面，不展示完成态，并可重试', async () => {
    getStreamMock.mockResolvedValueOnce(stream()).mockResolvedValueOnce(stream('done'));
    advanceMock
      .mockResolvedValueOnce(confirmed('in_progress'))
      .mockRejectedValueOnce(new Error('finish offline'))
      .mockResolvedValueOnce(confirmed('done'));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '开始作答' }));
    await user.click(await screen.findByRole('button', { name: '完成此题' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      '完成练习失败：finish offline',
    );
    expect(screen.getByText('solo:si_1')).toBeTruthy();
    expect(screen.queryByText('已完成')).toBeNull();

    await user.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.queryByText('solo:si_1')).toBeNull());
    expect(await screen.findByText('已完成')).toBeTruthy();
  });

  it('跳过失败时保留 pending，并可重试到 skipped', async () => {
    getStreamMock.mockResolvedValueOnce(stream()).mockResolvedValueOnce(stream('skipped'));
    advanceMock
      .mockRejectedValueOnce(new Error('skip offline'))
      .mockResolvedValueOnce(confirmed('skipped'));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '跳过 · 流尾可回头' }));
    expect((await screen.findByRole('alert')).textContent).toContain('跳过练习失败：skip offline');
    expect(screen.getByRole('button', { name: '开始作答' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '捡回来' })).toBeNull();

    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('button', { name: '捡回来' })).toBeTruthy();
  });

  it('恢复失败时保留 skipped，并可重试到 pending', async () => {
    getStreamMock.mockResolvedValueOnce(stream('skipped')).mockResolvedValueOnce(stream());
    advanceMock
      .mockRejectedValueOnce(new Error('resume offline'))
      .mockResolvedValueOnce(confirmed('pending'));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '捡回来' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      '恢复练习失败：resume offline',
    );
    expect(screen.getByRole('button', { name: '捡回来' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('button', { name: '开始作答' })).toBeTruthy();
  });

  it('PATCH 已确认后即使 refresh 失败，也保留确认态', async () => {
    getStreamMock.mockResolvedValueOnce(stream()).mockRejectedValueOnce(new Error('refresh down'));
    advanceMock.mockResolvedValueOnce(confirmed('skipped'));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '跳过 · 流尾可回头' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      '刷新练习流失败：refresh down',
    );
    expect(screen.getByRole('button', { name: '捡回来' })).toBeTruthy();
  });
});
