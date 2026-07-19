// @vitest-environment jsdom
// YUK-707 (P0F/3) — TeachingBriefBand interactions (jsdom/RTL): loading / error, the
// accept-dismiss CTA wiring through the canonical decideProposal pipeline, fail-closed
// inline error, the probe_ready single-card reveal, the [裁决 4] forward-only announce +
// focus move, and the getByRole heading/region a11y that SSR strings can't assert.

import { TOKEN_STORAGE_KEY } from '@/ui/lib/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeachingBriefBand } from './TeachingBrief';
import type {
  FindingTeachingBrief,
  OutcomeConfirmedTeachingBrief,
  ProbeReadyTeachingBrief,
} from './teaching-brief-api';

// Spy on the canonical decision pipeline; keep evidenceReadable real.
const { decideProposalMock } = vi.hoisted(() => ({ decideProposalMock: vi.fn() }));
vi.mock('./inbox-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./inbox-api')>();
  return { ...actual, decideProposal: decideProposalMock };
});

// Spy on the outcome ack caller; keep the wire types + getTeachingBrief real.
const { ackOutcomeMock } = vi.hoisted(() => ({ ackOutcomeMock: vi.fn() }));
vi.mock('./teaching-brief-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./teaching-brief-api')>();
  return { ...actual, ackTeachingBriefOutcome: ackOutcomeMock };
});

const FINDING_CLAIM = '你可能在复合层级增加时漏掉内层变化率。';
const PROBE_TEXT = '求 d/dx sin(x²)，并标出每一层变化率。';

function findingBrief(): FindingTeachingBrief {
  return {
    brief_id: 'evt_conj_01',
    state: 'finding',
    updated_at: '2026-07-18T15:10:00.000Z',
    expires_at: '2026-07-25T15:10:00.000Z',
    finding: {
      claim_md: FINDING_CLAIM,
      knowledge_id: 'kn_chain_rule',
      cause_category: 'concept_misunderstanding',
    },
    basis: {
      summary_md: '这个模式在最近几次相关作答中重复出现。',
      evidence_trace: [{ role: 'induction', kind: 'event', id: 'evt_attempt_a' }],
    },
    prepared_action: {
      kind: 'review_finding',
      proposal_id: 'evt_conj_01',
      probe_preview_md: PROBE_TEXT,
    },
    current_outcome: { status: 'awaiting_decision', summary_md: '这仍是一条待检验的判断。' },
  };
}

function probeReadyBrief(briefId = 'evt_conj_01'): ProbeReadyTeachingBrief {
  return {
    brief_id: briefId,
    state: 'probe_ready',
    updated_at: '2026-07-19T01:20:00.000Z',
    expires_at: null,
    finding: {
      claim_md: FINDING_CLAIM,
      knowledge_id: 'kn_chain_rule',
      cause_category: 'concept_misunderstanding',
    },
    basis: {
      summary_md: '这个模式在最近几次相关作答中重复出现。',
      evidence_trace: [
        { role: 'induction', kind: 'event', id: 'evt_attempt_a' },
        { role: 'probe', kind: 'question', id: 'q_probe_01' },
      ],
    },
    prepared_action: {
      kind: 'answer_probe',
      probe_question_id: 'q_probe_01',
      prompt_md: PROBE_TEXT,
    },
    current_outcome: {
      status: 'awaiting_answer',
      summary_md: '判别题已备好；完成后再更新这条判断。',
    },
  };
}

function outcomeBrief(): OutcomeConfirmedTeachingBrief {
  return {
    brief_id: 'evt_conj_01',
    state: 'outcome_confirmed',
    updated_at: '2026-07-19T02:05:00.000Z',
    expires_at: '2026-07-26T02:05:00.000Z',
    finding: {
      claim_md: FINDING_CLAIM,
      knowledge_id: 'kn_chain_rule',
      cause_category: 'concept_misunderstanding',
    },
    basis: {
      summary_md: '这个模式在最近几次相关作答中重复出现。',
      evidence_trace: [
        { role: 'induction', kind: 'event', id: 'evt_attempt_a' },
        { role: 'probe', kind: 'question', id: 'q_probe_01' },
        { role: 'outcome', kind: 'event', id: 'evt_probe_result_01' },
      ],
    },
    prepared_action: { kind: 'acknowledge_outcome', probe_result_event_id: 'evt_probe_result_01' },
    current_outcome: {
      status: 'confirmed',
      summary_md: '这条判断得到这次探针的支持；下一步可以针对这个点练习。',
      probe_question_id: 'q_probe_01',
      probe_result_event_id: 'evt_probe_result_01',
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
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => void store.delete(k),
    setItem: (k: string, v: string) => void store.set(k, v),
  };
}

function mkClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
}

function renderWith(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <TeachingBriefBand />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { value: memoryStorage(), configurable: true });
  window.localStorage.setItem(TOKEN_STORAGE_KEY, 'test-token');
  // ProbeAnswerCard's reveal path uses useAssetUrl → URL.createObjectURL (jsdom lacks it).
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:fake', configurable: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  decideProposalMock.mockReset();
  ackOutcomeMock.mockReset();
});

describe('TeachingBriefBand — loading / error (jsdom)', () => {
  it('loading: skeleton with an accessible label', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    renderWith(mkClient());
    const sk = await screen.findByLabelText('正在载入教研简报');
    expect(sk.getAttribute('aria-busy')).toBe('true');
  });

  it('error: route failure surfaces a retry, not a fake quiet night', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: 'boom' }), { status: 500 })),
    );
    renderWith(mkClient());
    expect(await screen.findByText('教研简报暂不可用。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});

describe('TeachingBriefBand — finding CTAs (jsdom)', () => {
  it('accept calls decideProposal(accept) and invalidates the wired keys', async () => {
    decideProposalMock.mockResolvedValue({});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ brief: null })),
    );
    const qc = mkClient();
    qc.setQueryData(['teaching-brief'], { brief: findingBrief() });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const user = userEvent.setup();
    renderWith(qc);

    await user.click(await screen.findByRole('button', { name: '就按这个方向验证' }));

    expect(decideProposalMock).toHaveBeenCalledWith('evt_conj_01', 'accept');
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['teaching-brief'] }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['overnight-digest'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['prep-desk-probes'] });
  });

  it('dismiss calls decideProposal(dismiss)', async () => {
    decideProposalMock.mockResolvedValue({});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ brief: null })),
    );
    const qc = mkClient();
    qc.setQueryData(['teaching-brief'], { brief: findingBrief() });
    const user = userEvent.setup();
    renderWith(qc);

    await user.click(await screen.findByRole('button', { name: '不太像' }));
    expect(decideProposalMock).toHaveBeenCalledWith('evt_conj_01', 'dismiss');
  });

  it('accept failure keeps the card and surfaces a non-blaming inline error', async () => {
    decideProposalMock.mockRejectedValue(new Error('boom'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ brief: null })),
    );
    const qc = mkClient();
    qc.setQueryData(['teaching-brief'], { brief: findingBrief() });
    const user = userEvent.setup();
    renderWith(qc);

    await user.click(await screen.findByRole('button', { name: '就按这个方向验证' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('操作失败，请重试');
    // Not optimistically removed — the finding is still on screen (contract §7).
    expect(screen.getByText(FINDING_CLAIM)).toBeTruthy();
    const accept = screen.getByRole('button', { name: '就按这个方向验证' }) as HTMLButtonElement;
    expect(accept.disabled).toBe(false);
  });
});

describe('TeachingBriefBand — probe_ready reveal (jsdom)', () => {
  it('reveals exactly one shared answer card in place', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ brief: null })),
    );
    const qc = mkClient();
    qc.setQueryData(['teaching-brief'], { brief: probeReadyBrief() });
    const user = userEvent.setup();
    renderWith(qc);

    const cta = await screen.findByRole('button', { name: '现在就试做这道题' });
    expect(cta.getAttribute('aria-expanded')).toBe('false');
    // No answer box before reveal.
    expect(screen.queryByPlaceholderText(/写下你的解答/)).toBeNull();

    await user.click(cta);

    expect(cta.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('button', { name: '提交作答' })).toHaveLength(1);
    expect(screen.getByPlaceholderText(/写下你的解答/)).toBeTruthy();
  });
});

describe('TeachingBriefBand — outcome ack (jsdom, YUK-708)', () => {
  it('知道了 acks the outcome result and invalidates the wired keys', async () => {
    ackOutcomeMock.mockResolvedValue({
      brief_acknowledgement_event_id: 'ack_1',
      probe_result_event_id: 'evt_probe_result_01',
      brief_id: 'evt_conj_01',
      idempotent: false,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ brief: null })),
    );
    const qc = mkClient();
    qc.setQueryData(['teaching-brief'], { brief: outcomeBrief() });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const user = userEvent.setup();
    renderWith(qc);

    await user.click(await screen.findByRole('button', { name: '知道了' }));

    // Acks the very result event carried by prepared_action.
    expect(ackOutcomeMock).toHaveBeenCalledWith('evt_probe_result_01');
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['teaching-brief'] }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['overnight-digest'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['prep-desk-probes'] });
  });

  it('ack failure keeps the outcome and surfaces a non-blaming retry (contract §7)', async () => {
    ackOutcomeMock.mockRejectedValue(new Error('boom'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ brief: null })),
    );
    const qc = mkClient();
    const brief = outcomeBrief();
    qc.setQueryData(['teaching-brief'], { brief });
    const user = userEvent.setup();
    renderWith(qc);

    await user.click(await screen.findByRole('button', { name: '知道了' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('操作失败，请重试');
    // Not optimistically dismissed — the outcome conclusion is still on screen.
    expect(screen.getByText(brief.current_outcome.summary_md)).toBeTruthy();
    const ack = screen.getByRole('button', { name: '知道了' }) as HTMLButtonElement;
    expect(ack.disabled).toBe(false);
  });
});

describe('TeachingBriefBand — forward announce + focus ([裁决 4])', () => {
  it('does not steal focus or announce on initial mount', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ brief: null })),
    );
    const qc = mkClient();
    qc.setQueryData(['teaching-brief'], { brief: findingBrief() });
    renderWith(qc);

    const prepared = await screen.findByRole('heading', { level: 3, name: '已经为你备好' });
    expect(document.activeElement).not.toBe(prepared);
    expect(document.querySelector('.tb-live')?.textContent).toBe('');
  });

  it('finding→probe_ready (same brief_id): announces once + focuses 已经为你备好', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ brief: null })),
    );
    const qc = mkClient();
    qc.setQueryData(['teaching-brief'], { brief: findingBrief() });
    renderWith(qc);
    await screen.findByRole('heading', { level: 3, name: '已经为你备好' });

    const next = probeReadyBrief();
    await act(async () => {
      qc.setQueryData(['teaching-brief'], { brief: next });
    });

    const prepared = screen.getByRole('heading', { level: 3, name: '已经为你备好' });
    await waitFor(() => expect(document.activeElement).toBe(prepared));
    expect(document.querySelector('.tb-live')?.textContent).toBe(next.current_outcome.summary_md);
  });

  it('probe_ready→outcome (same brief_id): announces + focuses 当前结果', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ brief: null })),
    );
    const qc = mkClient();
    qc.setQueryData(['teaching-brief'], { brief: probeReadyBrief() });
    renderWith(qc);
    await screen.findByRole('heading', { level: 3, name: '当前结果' });

    const next = outcomeBrief();
    await act(async () => {
      qc.setQueryData(['teaching-brief'], { brief: next });
    });

    const outcome = screen.getByRole('heading', { level: 3, name: '当前结果' });
    await waitFor(() => expect(document.activeElement).toBe(outcome));
    expect(document.querySelector('.tb-live')?.textContent).toBe(next.current_outcome.summary_md);
  });

  it('brief_id swap does NOT announce or move focus', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ brief: null })),
    );
    const qc = mkClient();
    qc.setQueryData(['teaching-brief'], { brief: findingBrief() });
    renderWith(qc);
    await screen.findByRole('heading', { level: 3, name: '已经为你备好' });

    // A different brief_id, also in probe_ready — a candidate swap, not a forward advance.
    await act(async () => {
      qc.setQueryData(['teaching-brief'], { brief: probeReadyBrief('evt_conj_99') });
    });

    const prepared = screen.getByRole('heading', { level: 3, name: '已经为你备好' });
    expect(document.activeElement).not.toBe(prepared);
    expect(document.querySelector('.tb-live')?.textContent).toBe('');
  });
});

describe('TeachingBriefBand — a11y landmarks (jsdom)', () => {
  it('exposes navigable headings/regions and a verify-not-confirm accept name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ brief: null })),
    );
    const qc = mkClient();
    qc.setQueryData(['teaching-brief'], { brief: findingBrief() });
    renderWith(qc);

    await screen.findByRole('heading', { level: 2, name: '为你而备' });
    for (const name of ['教研团在检验什么', '为什么这么判断', '已经为你备好', '当前结果']) {
      expect(screen.getByRole('heading', { level: 3, name })).toBeTruthy();
      expect(screen.getByRole('region', { name })).toBeTruthy();
    }
    const accept = screen.getByRole('button', { name: '就按这个方向验证' });
    expect(accept.textContent).toContain('验证');
    expect(accept.textContent).not.toContain('确认弱点');
    expect(accept.textContent).not.toContain('加进复习');
  });
});
