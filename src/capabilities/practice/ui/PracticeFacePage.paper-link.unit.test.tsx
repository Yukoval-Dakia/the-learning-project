// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useCallback, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/ui/lib/api';
import PracticeFacePage from './PracticeFacePage';
import {
  type PaperDetail,
  type PaperSlot,
  type StreamView,
  getPaperDetail,
  getPapers,
  getStream,
  pausePaperSession,
  savePaperAnswer,
  startPaperSession,
  submitPaperSlot,
} from './practice-api';

vi.mock('./practice-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./practice-api')>()),
  getPaperDetail: vi.fn(),
  getPapers: vi.fn(),
  getStream: vi.fn(),
  pausePaperSession: vi.fn(),
  startPaperSession: vi.fn(),
  savePaperAnswer: vi.fn(),
  submitPaperSlot: vi.fn(),
  endPaperSession: vi.fn(),
}));

function slot(paperId: string, number: number): PaperSlot {
  const id = `${paperId}-q${number}`;
  return {
    question_id: id,
    part_ref: null,
    section_index: 0,
    question: {
      id,
      kind: 'derivation',
      prompt_md: `第 ${number} 题：一艘船顺水速度为 18 km/h，逆水速度为 12 km/h。列方程说明静水速度，并解释两个条件如何共同确定答案。`,
      notation: null,
      choices_md: null,
      difficulty: 3,
      parent_question_id: null,
      part_index: null,
      image_refs: [],
    },
    slot_state: { draft: null, submission: null },
    assessment: {
      issuance_id: `issued-${paperId}`,
      evaluation_group_id: `group-${paperId}`,
      idempotency_key: `submit-${id}`,
      save_epoch: 0,
      practice_dto: {
        issuance_id: `issued-${paperId}`,
        revision_id: `revision-${paperId}`,
        issued_at: '2026-10-07T00:00:00.000Z',
        materials: [],
        faces: [{ part_id: id, prompt_md: '同版冻结题面', material_ids: [] }],
        response_spec: {
          slots: [{ slot_id: `${id}-response`, part_id: id, kind: 'text', math_preview: false }],
        },
      },
      response_set: { entries: [] },
      group_evidence: [],
    },
  };
}

function paper(id: string, status: string | null = 'started'): PaperDetail {
  return {
    artifact_id: id,
    title: `冻结练习卷 ${id}`,
    generation_status: 'ready',
    intent_source: 'quiz_gen',
    session: status ? { id: `session-${id}`, status, pos: 0, right: 1, wrong: 1 } : null,
    sections: [
      {
        section_index: 0,
        knowledge_focus_names: ['一元一次方程'],
        slots: [slot(id, 1), slot(id, 2)],
      },
    ],
  };
}

function stream(scopeId?: string): StreamView {
  return {
    date: '2026-10-07',
    opening_line: scopeId ? '专项练习已准备。' : '今日练习已准备。',
    budget: { pace: 'medium', minutes: 20 },
    items: [],
    progress: {
      done: 0,
      total: 0,
      estimated_total_minutes: 0,
      estimated_remaining_minutes: 0,
    },
    ...(scopeId
      ? {
          scope: {
            kind: 'knowledge',
            id: scopeId,
            label: '一元一次方程',
            session_id: 'scope-session',
          },
        }
      : {}),
  };
}

function renderPage(initialSearch: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const setQuery = vi.fn();
  let navigateSearch: (search: string) => void = () => {};
  let currentSearch = initialSearch;
  function Router() {
    const [search, setSearch] = useState(initialSearch);
    currentSearch = search;
    navigateSearch = setSearch;
    const getQuery = useCallback((key: string) => new URLSearchParams(search).get(key), [search]);
    const replaceQuery = useCallback((key: string, value: string | null) => {
      setQuery(key, value);
      setSearch((old) => {
        const params = new URLSearchParams(old);
        if (value === null) params.delete(key);
        else params.set(key, value);
        return params.toString();
      });
    }, []);
    return <PracticeFacePage navigate={vi.fn()} getQuery={getQuery} setQuery={replaceQuery} />;
  }
  render(
    <QueryClientProvider client={client}>
      <Router />
    </QueryClientProvider>,
  );
  return {
    setQuery,
    navigateSearch: (search: string) => act(() => navigateSearch(search)),
    query: () => new URLSearchParams(currentSearch),
    client,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getStream).mockImplementation(async (scopeId) => stream(scopeId));
  vi.mocked(getPapers).mockResolvedValue({ papers: [] });
  vi.mocked(getPaperDetail).mockImplementation(async (id) => paper(id));
  vi.mocked(pausePaperSession).mockImplementation(async (id) => ({
    id,
    type: 'review',
    previous_status: 'started',
    status: 'paused',
    changed: true,
    allowed_statuses: ['started', 'completed'],
  }));
  vi.mocked(savePaperAnswer).mockResolvedValue({
    answer_id: 'draft',
    created: true,
    save_epoch: 1,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage?.clear();
});

describe('YUK-1367 practice paper query selection', () => {
  it('loads an initial encoded paper ID into the real answering component and reuses its session', async () => {
    const id = '卷 A/?kc=other&paper=B';
    const page = renderPage(`paper=${encodeURIComponent(id)}&view=shelf`);
    expect(await screen.findByText(`冻结练习卷 ${id}`)).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '作答' })).toBeTruthy();
    expect(getPaperDetail).toHaveBeenCalledWith(id);
    expect(startPaperSession).not.toHaveBeenCalled();
    expect(page.query().get('paper')).toBe(id);
  });

  it('enters a paper after search-only navigation from the shelf', async () => {
    const page = renderPage('view=shelf');
    expect(await screen.findByRole('tab', { name: '卷架' })).toBeTruthy();
    page.navigateSearch('view=shelf&paper=B');
    expect(await screen.findByText('冻结练习卷 B')).toBeTruthy();
    expect(screen.queryByRole('tablist', { name: '练习视图' })).toBeNull();
  });

  it('remounts on A to B navigation so position, draft, and native save/session identity do not cross papers', async () => {
    const user = userEvent.setup();
    const page = renderPage('paper=A');
    await user.type(
      await screen.findByRole('textbox', { name: '作答' }),
      'A 的未保存草稿，包含条件与推导。',
    );
    await user.click(screen.getByRole('button', { name: '下一题' }));
    page.navigateSearch('paper=B');
    expect(await screen.findByText('冻结练习卷 B')).toBeTruthy();
    const answer = screen.getByRole('textbox', { name: '作答' });
    expect(answer).toHaveProperty('value', '');
    expect(screen.getByRole('tab', { name: '1' }).getAttribute('aria-selected')).toBe('true');
    await user.type(answer, 'v+c=18，v-c=12，相加得 v=15 km/h；水流速度为 3 km/h。');
    await user.click(screen.getByRole('button', { name: '退出 · 进度保留' }));
    await waitFor(() =>
      expect(pausePaperSession).toHaveBeenCalledWith('session-B', { keepalive: false }),
    );
    const bSaves = vi
      .mocked(savePaperAnswer)
      .mock.calls.filter(([artifactId]) => artifactId === 'B');
    expect(bSaves.length).toBeGreaterThan(0);
    expect(bSaves[0][1]).toMatchObject({
      session_id: 'session-B',
      question_id: 'B-q1',
      assessment: {
        issuance_id: 'issued-B',
        evaluation_group_id: 'group-B',
        response_set: {
          entries: [
            { slot_id: 'B-q1-response', kind: 'text', text_md: expect.stringContaining('v=15') },
          ],
        },
      },
    });
    expect(JSON.stringify(bSaves)).not.toContain('A 的未保存草稿');
  });

  it('opens completed papers in real review without mounting an editable response or starting a session', async () => {
    vi.mocked(getPaperDetail).mockImplementation(async (id) => paper(id, 'completed'));
    renderPage('paper=done');
    expect(await screen.findByText('冻结练习卷 done · 复盘')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: '作答' })).toBeNull();
    expect(startPaperSession).not.toHaveBeenCalled();
    expect(savePaperAnswer).not.toHaveBeenCalled();
    expect(submitPaperSlot).not.toHaveBeenCalled();
  });

  it('rechecks cached unfinished papers before entering review on a repeated deep link', async () => {
    const user = userEvent.setup();
    const page = renderPage('paper=A');
    await user.click(await screen.findByRole('button', { name: '退出 · 进度保留' }));
    expect(await screen.findByRole('heading', { name: '练习' })).toBeTruthy();
    vi.mocked(getPaperDetail).mockImplementation(async (id) => paper(id, 'completed'));
    page.navigateSearch('paper=A');
    expect(await screen.findByText('冻结练习卷 A · 复盘')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: '作答' })).toBeNull();
    expect(startPaperSession).not.toHaveBeenCalled();
  });

  it('creates a session through the existing paper consumer when a linked paper has none', async () => {
    let opened = false;
    vi.mocked(getPaperDetail).mockImplementation(async (id) =>
      paper(id, opened ? 'started' : null),
    );
    vi.mocked(startPaperSession).mockImplementation(async (id) => {
      opened = true;
      return { session_id: `session-${id}` };
    });
    renderPage('paper=new');
    expect(await screen.findByRole('textbox', { name: '作答' })).toBeTruthy();
    await waitFor(() => expect(startPaperSession).toHaveBeenCalledWith('new'));
    expect(startPaperSession).toHaveBeenCalledTimes(1);
  });

  it('clears the paper query on exit while preserving the KC scope and the scoped stream', async () => {
    const page = renderPage('kc=kc-equation&paper=A&view=shelf');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '退出 · 进度保留' }));
    expect(await screen.findByRole('heading', { name: '针对性练习' })).toBeTruthy();
    expect(await screen.findByText('知识点专项 · 一元一次方程')).toBeTruthy();
    expect(page.setQuery).toHaveBeenCalledWith('paper', null);
    expect(page.query().get('paper')).toBeNull();
    expect(page.query().get('kc')).toBe('kc-equation');
    expect(getStream).toHaveBeenLastCalledWith('kc-equation');
    expect(screen.queryByRole('tablist', { name: '练习视图' })).toBeNull();
  });

  it('returns a completed deep link to the shelf and removes its selection', async () => {
    vi.mocked(getPaperDetail).mockImplementation(async (id) => paper(id, 'completed'));
    const page = renderPage('paper=done');
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: '返回卷架' }))[0]);
    expect(await screen.findByRole('tab', { name: '卷架' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '卷架' }).getAttribute('aria-selected')).toBe('true');
    expect(page.query().get('paper')).toBeNull();
    expect(page.query().get('view')).toBe('shelf');
    expect(screen.queryByText('冻结练习卷 done · 复盘')).toBeNull();
  });

  it('returns to the requested list when navigation removes the paper query', async () => {
    const page = renderPage('paper=A');
    expect(await screen.findByRole('textbox', { name: '作答' })).toBeTruthy();
    page.navigateSearch('view=shelf');
    expect(await screen.findByRole('tab', { name: '卷架' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: '作答' })).toBeNull();
  });

  it('shows the existing loading state and ignores a late A result after navigating to B', async () => {
    let resolveA: (value: PaperDetail) => void = () => {};
    vi.mocked(getPaperDetail).mockImplementation((id) =>
      id === 'A'
        ? new Promise<PaperDetail>((resolve) => {
            resolveA = resolve;
          })
        : Promise.resolve(paper(id)),
    );
    const page = renderPage('paper=A');
    expect(screen.getByText('取卷中…')).toBeTruthy();
    expect(startPaperSession).not.toHaveBeenCalled();
    page.navigateSearch('paper=B');
    expect(await screen.findByText('冻结练习卷 B')).toBeTruthy();
    await act(async () => resolveA(paper('A', null)));
    expect(screen.queryByText('冻结练习卷 A')).toBeNull();
    expect(startPaperSession).not.toHaveBeenCalled();
  });

  it('offers retry for a load error before opening a session', async () => {
    vi.mocked(getPaperDetail).mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    renderPage('paper=A');
    expect((await screen.findByRole('alert')).textContent).toContain('试卷加载失败。');
    expect(startPaperSession).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('textbox', { name: '作答' })).toBeTruthy();
  });

  it('treats 404 as not found and clears selection on return without claiming saved progress', async () => {
    vi.mocked(getPaperDetail).mockRejectedValue(new ApiError('missing paper', 404));
    const user = userEvent.setup();
    const page = renderPage('paper=missing&view=shelf');
    expect(await screen.findByText('试卷不存在')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(startPaperSession).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '返回练习' }));
    expect(await screen.findByRole('tab', { name: '卷架' })).toBeTruthy();
    expect(page.query().get('paper')).toBeNull();
    expect(screen.queryByText(/进度已保留/)).toBeNull();
  });
});
