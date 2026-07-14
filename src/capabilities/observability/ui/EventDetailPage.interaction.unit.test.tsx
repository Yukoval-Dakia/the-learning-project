// @vitest-environment jsdom

import { TOKEN_STORAGE_KEY } from '@/ui/lib/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EventDetailPage from './EventDetailPage';
import type { EventDetailResponse, EventDetailRow } from './event-detail-model';

const ACTIVE = {
  state: 'active' as const,
  correction_event_id: null,
  replacement_event_id: null,
};

function eventRow(overrides: Partial<EventDetailRow> = {}): EventDetailRow {
  return {
    id: 'evt_focus',
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q1',
    outcome: 'failure',
    payload: { answer_md: '错答' },
    created_at: '2026-07-13T08:00:00Z',
    correction_status: ACTIVE,
    ...overrides,
  };
}

function successBody(): EventDetailResponse {
  return {
    event: eventRow(),
    correction_status: ACTIVE,
    chain: {
      caused_by: null,
      caused_events: [
        eventRow({
          id: 'evt_judge',
          actor_kind: 'agent',
          action: 'judge',
          subject_kind: 'event',
          subject_id: 'evt_focus',
          outcome: 'success',
        }),
      ],
      corrections: [],
    },
  };
}

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => void store.delete(key),
    setItem: (key, value) => void store.set(key, value),
  };
}

function renderPage(navigate = vi.fn(), onBack = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    ...render(
      <QueryClientProvider client={client}>
        <EventDetailPage id="evt_focus" navigate={navigate} onBack={onBack} />
      </QueryClientProvider>,
    ),
    navigate,
    onBack,
  };
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { value: memoryStorage(), configurable: true });
  window.localStorage.setItem(TOKEN_STORAGE_KEY, 'test-token');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('EventDetailPage', () => {
  it('renders a readable chain and navigates to the downstream event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(successBody())),
    );
    const { navigate, container } = renderPage();

    expect(await screen.findByText('作答 · 失败')).toBeTruthy();
    expect(screen.getByText('之后发生 · 1 条')).toBeTruthy();
    expect(screen.getByText('判题 · 另一条记录 · 成功')).toBeTruthy();
    expect(container.querySelector('details')?.open).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: /AI\s*判题 · 另一条记录 · 成功/ }));
    expect(navigate).toHaveBeenCalledWith('/events/evt_judge');
  });

  it('shows explicit not-found and forbidden states', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'not_found', message: 'missing' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'forbidden', message: 'hidden' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const first = renderPage();
    expect(await screen.findByText('这条证据不存在')).toBeTruthy();
    first.unmount();

    renderPage();
    expect(await screen.findByText('无法查看这条证据')).toBeTruthy();
  });

  it('submits a real correction contract and keeps the reason until success', async () => {
    const posts: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posts.push(JSON.parse(String(init.body)));
          return Response.json({ correction_event_id: 'evt_correction' });
        }
        return Response.json(successBody());
      }),
    );
    renderPage();
    const user = userEvent.setup();

    await screen.findByText('作答 · 失败');
    const reason = screen.getByLabelText('说明原因');
    await user.type(reason, '这次记录不准确');
    await user.click(screen.getByRole('button', { name: '撤回记录' }));

    expect(await screen.findByText('纠正已记录。')).toBeTruthy();
    expect(posts).toEqual([
      {
        correction_kind: 'retract',
        reason_md: '这次记录不准确',
        affected_refs: [{ kind: 'question', id: 'q1' }],
      },
    ]);
  });
});
