// @vitest-environment jsdom
// YUK-895 QA lane — the /practice entry's 422 regression must run against the REAL
// PfSolo component (PracticeFacePage.mutation.unit.test.tsx mocks PfSolo away, and the
// other PfSolo tests only exercise pure functions). Inject an HTTP 422 on the advice
// path and lock: learner-facing copy, the submit button resetting from 判分中…, and the
// answer input surviving the failure.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOKEN_STORAGE_KEY } from '@/ui/lib/api';
import { PfSolo } from './PfSolo';
import type { StreamItem } from './practice-api';

const ITEM: StreamItem = {
  id: 'si_1',
  position: 0,
  item_kind: 'question',
  ref_id: 'q_1',
  source: 'decay',
  reasoning: '该复习了。',
  status: 'pending',
  estimated_minutes: 2,
  knowledge_name: '判断句',
  paper_title: null,
  verdict: null,
  completed_at: null,
  total_slots: null,
};

// Minimal but production-shaped question projection (the fields PfSolo reads).
const QUESTION = {
  id: 'q_1',
  kind: 'short',
  prompt_md: '用一句话解释导数。',
  reference_md: null,
  choices_md: null,
  labels: [{ id: 'kn_1', name: '导数' }],
  source: 'manual',
  committed_attempt: null,
  timeline: [],
};

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

function renderSolo(addToast: (text: string, tone?: 'info', icon?: string) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PfSolo
        item={ITEM}
        sessionId={null}
        pos={1}
        total={1}
        onDone={vi.fn()}
        onBack={vi.fn()}
        onCommittedBack={vi.fn()}
        addToast={addToast}
      />
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

describe('PfSolo — real-component 422 judge failure (YUK-895 QA lane)', () => {
  it('shows learner copy, resets the submit button, and keeps the answer on a 422', async () => {
    // Deferred advice response so the in-flight 判分中… state is observable before the
    // HTTP 422 lands (locks the finally-reset, not just the final state).
    let rejectAdvice!: (reason: Error) => void;
    const adviceGate = new Promise<Response>((_resolve, reject) => {
      rejectAdvice = reject;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/review/advice')) return adviceGate;
        if (url.includes('/api/questions/')) return Response.json(QUESTION);
        return Response.json({});
      }),
    );
    const addToast = vi.fn();
    const user = userEvent.setup();
    renderSolo(addToast);

    await screen.findByText('用一句话解释导数。');
    const answer = screen.getByRole('textbox', { name: '作答' });
    await user.type(answer, '导数表示变化率');
    await user.click(screen.getByRole('button', { name: '提交 · 即时判分' }));

    // In-flight: the button is loading and the answer is still mounted.
    expect(await screen.findByRole('button', { name: '判分中…' })).toBeTruthy();

    // Inject the HTTP 422 (the judge route rejects the answer).
    await act(async () => {
      rejectAdvice(new Error('unsupported_judge_route'));
    });

    // Learner-facing copy, no developer/API error text.
    expect(addToast).toHaveBeenCalledWith('判题失败，请稍后重试', 'info', 'alert');
    expect(addToast.mock.calls[0][0]).not.toContain('unsupported_judge_route');
    // Button reset from 判分中… back to the retryable submit.
    expect(screen.getByRole('button', { name: '提交 · 即时判分' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '判分中…' })).toBeNull();
    // The answer survives for retry.
    expect((answer as HTMLTextAreaElement).value).toBe('导数表示变化率');
  });
});
