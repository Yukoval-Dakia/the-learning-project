// @vitest-environment jsdom
// YUK-895 QA lane — the /practice entry's 422 regression must run against the REAL
// PfSolo component (PracticeFacePage.mutation.unit.test.tsx mocks PfSolo away, and the
// other PfSolo tests only exercise pure functions). Inject an HTTP 422 on the advice
// path and lock: learner-facing copy, the submit button resetting from 判分中…, and the
// answer input surviving the failure.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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

// YUK-784 — 流式面的采集回归钉：PfStream 列表本身无作答面（点「开始作答」进的是本组件），
// 散题采集已在 #1069 落在 PfSolo 上；本 describe 在交互层钉住「流发起的作答全过程两采集面
// 都在场 + wire 带值」，防止后续重构无声掉采集。green-on-arrival（行为已存在）。
describe('PfSolo — stream answering capture regression pin (YUK-784)', () => {
  const adviceJudge = {
    route: 'semantic',
    score: 0.9,
    score_meaning: 'correctness',
    coarse_outcome: 'correct',
    confidence: 0.9,
    feedback_md: '答得好。',
    evidence_json: {},
    capability_ref: { id: 'cap_sem', version: '1' },
    suggested_rating: 'good',
  };

  function attemptRequestBody(calls: unknown[][]): Record<string, unknown> {
    const init = calls[0]?.[1] as RequestInit | undefined;
    return JSON.parse((init?.body as string) ?? '{}');
  }

  it('过程框 + 信心自评插拍都在场，commit wire 带上 reasoning_trace / self_confidence', async () => {
    const attemptCalls: unknown[][] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/api/review/advice'))
          return Response.json({
            activity_ref: { id: 'act_1' },
            question_id: 'q_1',
            judge: adviceJudge,
            advice: { rating: 'good', reason: 'ok', evidence_score: null },
          });
        if (url.includes('/api/attempts')) {
          attemptCalls.push([url, init]);
          return Response.json({
            next_due_at: 1,
            new_state: {
              due: '2026-01-02T00:00:00.000Z',
              stability: 1,
              difficulty: 5,
              elapsed_days: 0,
              scheduled_days: 1,
              learning_steps: 0,
              reps: 1,
              lapses: 0,
              state: 'review',
              last_review: '2026-01-01T00:00:00.000Z',
            },
            review_event: {
              id: 're_1',
              activity_ref: { id: 'act_1' },
              question_id: 'q_1',
              rating: 'good',
              fsrs_subject_kind: 'question',
              fsrs_subject_ids: ['q_1'],
              response_md: '导数表示变化率',
              latency_ms: null,
              fsrs_state_after: {
                due: '2026-01-02T00:00:00.000Z',
                stability: 1,
                difficulty: 5,
                elapsed_days: 0,
                scheduled_days: 1,
                learning_steps: 0,
                reps: 1,
                lapses: 0,
                state: 'review',
                last_review: '2026-01-01T00:00:00.000Z',
              },
              due_at_next: '2026-01-02T00:00:00.000Z',
              created_at: '2026-01-01T00:00:00.000Z',
              correction_state: {
                original_event_id: 're_1',
                state: 'active',
                terminal_state: 'active',
              },
            },
            judge: null,
          });
        }
        if (url.includes('/api/questions/')) return Response.json(QUESTION);
        return Response.json({});
      }),
    );
    const onDone = vi.fn();
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <PfSolo
          item={ITEM}
          sessionId={null}
          pos={1}
          total={1}
          onDone={onDone}
          onBack={vi.fn()}
          onCommittedBack={vi.fn()}
          addToast={vi.fn()}
        />
      </QueryClientProvider>,
    );

    // 过程框：提交前在场、默认折叠、零强制。
    await screen.findByText('用一句话解释导数。');
    const traceToggle = screen.getByRole('button', { name: '＋ 记下你的思路（可选）' });
    await user.click(traceToggle);
    await user.type(screen.getByRole('textbox', { name: '解题思路（可选）' }), '先想变化率');

    // 作答 + 提交。
    await user.type(screen.getByRole('textbox', { name: '作答' }), '导数表示变化率');
    await user.click(screen.getByRole('button', { name: '提交 · 即时判分' }));

    // 信心自评插拍：判定揭晓前在场，判定卡不在场（推迟揭晓）。
    expect(await screen.findByText('看答案之前——你有几分把握？')).toBeTruthy();
    expect(screen.queryByText('答得好。')).toBeNull();

    // 选 3 分 → 揭晓判定卡。
    await user.click(screen.getByRole('button', { name: '把握 3 分（共 5 分）' }));
    expect(await screen.findByText('答得好。')).toBeTruthy();

    // 确认评级 → commit wire 带上两个采集字段。
    await user.click(screen.getByRole('button', { name: '确认评级 · 下一项' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const init = attemptRequestBody(attemptCalls);
    expect(init.reasoning_trace).toBe('先想变化率');
    expect(init.self_confidence).toBe(3);
  });
});
