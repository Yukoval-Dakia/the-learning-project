// @vitest-environment jsdom
// YUK-567 slice-2 — ProbeAnswers 交互 (jsdom/RTL). Covers the paths SSR can't: a text
// answer → verdict; an IMAGE answer (owner requirement) → the uploaded asset ref rides
// in the submit; and a failed submit → retry surfaced, probe kept (fail-closed).

import { TOKEN_STORAGE_KEY } from '@/ui/lib/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProbeAnswerCard, ProbeAnswers } from './ProbeAnswers';

const PROBE = {
  probe_question_id: 'q_probe1',
  prompt_md: '求 d/dx sin(x^2)。',
  knowledge_id: 'kn_chain_rule',
};

interface CapturedAnswer {
  answer_md: string;
  answer_image_refs: string[];
}

// Routes by url + method: probes list, asset upload/content, and the answer POST
// (whose body is captured). `answerStatus` drives the answer route's status.
function mockFetch(opts: { answerStatus?: number; captured?: CapturedAnswer[] } = {}) {
  const answerStatus = opts.answerStatus ?? 200;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/api/prep-desk/probes')) return Response.json({ probes: [PROBE] });
    if (url.includes('/api/assets/') && url.includes('/content')) {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    if (url.includes('/api/assets') && method === 'POST') {
      return Response.json({
        asset: {
          id: 'asset_1',
          storage_key: 'k',
          mime_type: 'image/png',
          byte_size: 3,
          sha256: 'x',
        },
      });
    }
    if (url.includes('/answer') && method === 'POST') {
      opts.captured?.push(JSON.parse(String(init?.body)) as CapturedAnswer);
      if (answerStatus >= 400)
        return new Response(JSON.stringify({ error: 'fail-closed' }), { status: answerStatus });
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
      <ProbeAnswers />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { value: memoryStorage(), configurable: true });
  window.localStorage.setItem(TOKEN_STORAGE_KEY, 'test-token');
  // jsdom lacks URL.createObjectURL (used by the thumbnail via useAssetUrl).
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:fake', configurable: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ProbeAnswers — answer interaction (jsdom)', () => {
  it('submits a text answer and surfaces the verdict', async () => {
    const captured: CapturedAnswer[] = [];
    vi.stubGlobal('fetch', mockFetch({ captured }));
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText('求 d/dx sin(x^2)。');
    await user.type(screen.getByPlaceholderText(/写下你的解答/), '2x·cos(x^2)');
    await user.click(screen.getByRole('button', { name: '提交作答' }));

    expect(await screen.findByText(/答对了/)).toBeTruthy(); // retired verdict, gently framed
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({ answer_md: '2x·cos(x^2)', answer_image_refs: [] });
  });

  it('carries an uploaded image ref in a photo-only answer (owner requirement)', async () => {
    const captured: CapturedAnswer[] = [];
    vi.stubGlobal('fetch', mockFetch({ captured }));
    const user = userEvent.setup();
    const { container } = renderPanel();

    await screen.findByText('求 d/dx sin(x^2)。');
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, new File(['bytes'], 'handwriting.png', { type: 'image/png' }));

    // Photo-only: no text typed, submit rides on the image alone.
    await user.click(screen.getByRole('button', { name: '提交作答' }));

    expect(await screen.findByText(/答对了|这块确实卡了/)).toBeTruthy();
    expect(captured).toHaveLength(1);
    expect(captured[0].answer_image_refs).toEqual(['asset_1']);
    expect(captured[0].answer_md).toBe('');
  });

  it('surfaces a retry and keeps the probe when the submit fails (fail-closed)', async () => {
    vi.stubGlobal('fetch', mockFetch({ answerStatus: 500 }));
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText('求 d/dx sin(x^2)。');
    await user.type(screen.getByPlaceholderText(/写下你的解答/), '试答');
    await user.click(screen.getByRole('button', { name: '提交作答' }));

    expect(await screen.findByText(/这次没判清/)).toBeTruthy();
    expect(screen.getByText('求 d/dx sin(x^2)。')).toBeTruthy(); // probe not lost
  });
});

// YUK-707 · [裁决 2/3] — the shared ProbeAnswerCard is reused by the teaching brief. A
// recorded verdict must additionally invalidate ['teaching-brief'] (so a mounted brief
// advances in place) and call onAnswered; onDismiss must keep touching ONLY the probe
// queue, never the brief.
describe('ProbeAnswerCard — teaching brief coupling (jsdom)', () => {
  function renderCard(onAnswered?: (resolution: 'confirmed' | 'retired') => void) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    render(
      <QueryClientProvider client={qc}>
        <ProbeAnswerCard probe={PROBE} onAnswered={onAnswered} />
      </QueryClientProvider>,
    );
    return { invalidateSpy };
  }

  it('invalidates the teaching brief and calls onAnswered on a recorded verdict', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const onAnswered = vi.fn();
    const user = userEvent.setup();
    const { invalidateSpy } = renderCard(onAnswered);

    await user.type(screen.getByPlaceholderText(/写下你的解答/), '2x·cos(x^2)');
    await user.click(screen.getByRole('button', { name: '提交作答' }));

    expect(await screen.findByText(/答对了/)).toBeTruthy();
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['teaching-brief'] }),
    );
    expect(onAnswered).toHaveBeenCalledWith('retired');
  });

  it('onDismiss invalidates only the probe queue, never the teaching brief', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const user = userEvent.setup();
    const { invalidateSpy } = renderCard();

    await user.type(screen.getByPlaceholderText(/写下你的解答/), '2x·cos(x^2)');
    await user.click(screen.getByRole('button', { name: '提交作答' }));
    await screen.findByText(/答对了/);
    invalidateSpy.mockClear();

    await user.click(screen.getByRole('button', { name: '知道了' }));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['prep-desk-probes'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['teaching-brief'] });
  });
});
