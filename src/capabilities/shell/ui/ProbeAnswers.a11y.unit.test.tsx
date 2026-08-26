// @vitest-environment jsdom
// YUK-911 — a failed judge submit used to render the SAME failure message into BOTH a
// role="alert" region (inline .pa-error) and a role="status" live region (.pa-toast),
// so screen readers announced 判题失败 twice. The alert region carries the failure
// semantics; exactly ONE live region may contain the judge-failure message, and the
// success path must keep its existing (non-live-region) verdict announcement.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOKEN_STORAGE_KEY } from '@/ui/lib/api';

import { ProbeAnswers } from './ProbeAnswers';

const PROBE = {
  probe_question_id: 'q_probe1',
  prompt_md: '求 d/dx sin(x^2)。',
  knowledge_id: 'kn_chain_rule',
};

const JUDGE_FAILURE = '判题失败，请稍后重试';

function mockFetch(answerStatus: number) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/api/prep-desk/probes')) return Response.json({ probes: [PROBE] });
    if (url.includes('/answer') && method === 'POST') {
      if (answerStatus >= 400) {
        return new Response(JSON.stringify({ error: 'fail-closed' }), { status: answerStatus });
      }
      return Response.json({
        status: 'retired',
        resolution: 'retired',
        outcome: 1,
        probe_result_event_id: 'ev_pr',
        coarse_outcome: 'correct',
        idempotent: false,
      });
    }
    return Response.json({});
  });
}

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => store.get(k) ?? null,
    key: (i) => [...store.keys()][i] ?? null,
    removeItem: (k) => void store.delete(k),
    setItem: (k, v) => void store.set(k, v),
  };
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProbeAnswers />
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

describe('ProbeAnswers judge-failure live regions (YUK-911)', () => {
  it('announces a judge failure through exactly one live region (no status duplicate)', async () => {
    vi.stubGlobal('fetch', mockFetch(422));
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText('求 d/dx sin(x^2)。');
    await user.type(screen.getByPlaceholderText(/写下你的解答/), '试答');
    await user.click(screen.getByRole('button', { name: '提交作答' }));

    // The alert region carries the failure semantics.
    expect((await screen.findByRole('alert')).textContent).toContain(JUDGE_FAILURE);
    // No polite/status region may double-announce the same message.
    const duplicatingStatus = screen
      .queryAllByRole('status')
      .filter((el) => el.textContent?.includes(JUDGE_FAILURE));
    expect(duplicatingStatus).toEqual([]);
  });

  it('keeps the success verdict out of failure live regions', async () => {
    vi.stubGlobal('fetch', mockFetch(200));
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText('求 d/dx sin(x^2)。');
    await user.type(screen.getByPlaceholderText(/写下你的解答/), '2x·cos(x^2)');
    await user.click(screen.getByRole('button', { name: '提交作答' }));

    expect(await screen.findByText(/答对了/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    // The verdict <output> keeps its implicit role="status" polite announcement —
    // exactly one status region, carrying the verdict (not the failure message).
    const statuses = screen.queryAllByRole('status');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.textContent).toContain('答对了');
  });
});
