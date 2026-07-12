// @vitest-environment jsdom
// YUK-567 slice-1 review-782 fix — decide error handling (jsdom/RTL). A failed
// accept/reject must NOT silently vanish (unhandled rejection): the card stays and
// a retry affordance surfaces. SSR can't cover the async catch → interaction test.

import { TOKEN_STORAGE_KEY } from '@/ui/lib/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrepDeskConjectures } from './PrepDeskConjectures';

const CONJ = {
  id: 'evt_c1',
  claim: '你把链式法则当成两个导数相乘',
  knowledge_id: 'kn_chain_rule',
  cause_category: 'concept_misunderstanding',
  probe_md: 'd/dx sin(x^2) = ?',
  recurrence_count: 3,
  discriminating: true,
  corrected_by_owner: false,
  evidence: [],
  proposed_at: '2026-07-12T00:00:00.000Z',
};

// GET /api/prep-desk/conjectures → the seeded card; POST …/decide → `decideStatus`.
function mockFetch(decideStatus: number) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST' && url.includes('/decide')) {
      return new Response(JSON.stringify({ ok: decideStatus < 400 }), { status: decideStatus });
    }
    return Response.json({ conjectures: [CONJ] });
  });
}

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => void store.delete(k),
    setItem: (k: string, v: string) => void store.set(k, v),
  };
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PrepDeskConjectures />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { value: memoryStorage(), configurable: true });
  window.localStorage.setItem(TOKEN_STORAGE_KEY, 'test-token');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PrepDeskConjectures — decide error handling (jsdom)', () => {
  it('surfaces a retry affordance and keeps the card when a decision fails', async () => {
    vi.stubGlobal('fetch', mockFetch(500));
    const user = userEvent.setup();
    renderPanel();

    // Card renders from the mocked GET.
    await screen.findByText('你把链式法则当成两个导数相乘');

    // Accept fails (POST decide → 500 → apiJson throws → caught).
    await user.click(screen.getByRole('button', { name: '对，往这个方向想' }));

    // Error is surfaced (not swallowed), and the card is NOT lost.
    expect(await screen.findByText('操作失败，请重试')).toBeTruthy();
    expect(screen.getByText('你把链式法则当成两个导数相乘')).toBeTruthy();
    // The accept button re-enables (finally cleared deciding) so retry is possible.
    const acceptBtn = screen.getByRole('button', {
      name: '对，往这个方向想',
    }) as HTMLButtonElement;
    expect(acceptBtn.disabled).toBe(false);
  });
});
