// @vitest-environment jsdom
// YUK-707 round-2 [major] — the 待你试做 probe queue is driven by its own
// ['prep-desk-probes'] query and must NOT be gated by the overnight-digest query's
// loading/error state (nor hidden behind the collapsed activity disclosure). This locks
// the regression: a served probe stays one-click reachable even when the digest errors.

import { TOKEN_STORAGE_KEY } from '@/ui/lib/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OvernightDigestBand } from './TodayPage';

const PROBE = {
  probe_question_id: 'q_probe1',
  prompt_md: '求 d/dx sin(x^2)。',
  knowledge_id: 'kn_chain_rule',
};

// overnight-digest → 500 (error); prep-desk-probes → one served probe.
function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/workbench/overnight-digest')) {
      return new Response(JSON.stringify({ message: 'boom' }), { status: 500 });
    }
    if (url.includes('/api/prep-desk/probes')) return Response.json({ probes: [PROBE] });
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

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { value: memoryStorage(), configurable: true });
  window.localStorage.setItem(TOKEN_STORAGE_KEY, 'test-token');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('OvernightDigestBand — probe queue independence (jsdom)', () => {
  it('keeps 待你试做 one-click reachable even when the overnight digest query errors', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <OvernightDigestBand navigate={() => {}} />
      </QueryClientProvider>,
    );

    // The digest query surfaces its own error state inside the card…
    expect(await screen.findByText('夜链交班暂不可用。')).toBeTruthy();
    // …yet the probe queue — its own ['prep-desk-probes'] query — is still directly
    // visible (not swallowed by the digest error, not buried behind an activity toggle).
    expect(await screen.findByRole('button', { name: /待你试做/ })).toBeTruthy();
  });
});
