// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AdminReadClient,
  httpAdminClient,
} from '@/capabilities/observability/ui/admin-client';
import { AdminCostSurface } from '@/capabilities/observability/ui/admin-cost';
import { AdminFailuresSurface } from '@/capabilities/observability/ui/admin-failures';
import { AdminRunsSurface } from '@/capabilities/observability/ui/admin-runs';
import { AdminConjectureScoresSurface } from '@/capabilities/observability/ui/conjecture-scores';
import { AdminCoverageLatticeSurface } from '@/capabilities/observability/ui/coverage-lattice';
import { TOKEN_STORAGE_KEY } from '@/ui/lib/api';
import {
  adminConjectures,
  adminCost,
  adminCoverage,
  adminDetail,
  adminFailures,
  adminRuns,
} from '../../../server/start/admin-test-fixtures';
import { TokenGate } from '../TokenGate';

const clients: QueryClient[] = [];
const injected = () => ({
  getRuns: vi.fn<AdminReadClient['getRuns']>().mockResolvedValue(adminRuns),
  getRunDetail: vi
    .fn<AdminReadClient['getRunDetail']>()
    .mockImplementation(async ({ id }) => ({ ...adminDetail, run: { ...adminDetail.run, id } })),
  getCost: vi.fn<AdminReadClient['getCost']>().mockResolvedValue(adminCost),
  getFailures: vi.fn<AdminReadClient['getFailures']>().mockResolvedValue(adminFailures),
  getCoverage: vi.fn<AdminReadClient['getCoverage']>().mockResolvedValue(adminCoverage),
  getConjectureScores: vi
    .fn<AdminReadClient['getConjectureScores']>()
    .mockResolvedValue(adminConjectures),
});
type Page = ComponentType<{ navigate: (to: string) => void; client?: AdminReadClient }>;
const pages: Array<{ Page: Page; method: keyof AdminReadClient; path: string; ready: string }> = [
  { Page: AdminRunsSurface, method: 'getRuns', path: 'runs', ready: 'read_evidence' },
  { Page: AdminCostSurface, method: 'getCost', path: 'cost', ready: 'Daily trend' },
  {
    Page: AdminFailuresSurface,
    method: 'getFailures',
    path: 'failures',
    ready: 'Ambiguous evidence',
  },
  {
    Page: AdminCoverageLatticeSurface,
    method: 'getCoverage',
    path: 'coverage-lattice',
    ready: 'kc-ambiguous',
  },
  {
    Page: AdminConjectureScoresSurface,
    method: 'getConjectureScores',
    path: 'conjecture-scores',
    ready: 'kc-ambiguous',
  },
];
function mount(Page: Page, client?: AdminReadClient, gate = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(qc);
  const navigate = vi.fn();
  const page = <Page navigate={navigate} client={client} />;
  return {
    ...render(
      <QueryClientProvider client={qc}>
        {gate ? <TokenGate>{page}</TokenGate> : page}
      </QueryClientProvider>,
    ),
    navigate,
    qc,
  };
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
}
beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(TOKEN_STORAGE_KEY, 'fixture-token');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://isolated.test').pathname;
      if (path === '/api/admin/runs') return Response.json(adminRuns);
      if (path.startsWith('/api/admin/runs/')) return Response.json(adminDetail);
      if (path === '/api/admin/cost') return Response.json(adminCost);
      if (path === '/api/admin/failures') return Response.json(adminFailures);
      if (path === '/api/admin/coverage-lattice') return Response.json(adminCoverage);
      if (path === '/api/admin/conjecture-scores') return Response.json(adminConjectures);
      throw new Error(`Unexpected HTTP ${path}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  for (const qc of clients) qc.clear();
  clients.length = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('existing admin page DOM with optional injected clients', () => {
  it.each(pages)(
    'retains $path settled DOM, navigation and default HTTP client',
    async ({ Page, path, ready }) => {
      const legacy = mount(Page);
      await screen.findAllByText(ready);
      await settle();
      const expected = legacy.container.innerHTML;
      cleanup();
      vi.mocked(fetch).mockClear();
      const client = injected();
      const current = mount(Page, client);
      await screen.findAllByText(ready);
      await settle();
      expect(current.container.innerHTML).toBe(expected);
      expect(fetch).not.toHaveBeenCalled();
      const link = current.container.querySelector('a[href="/admin/subjects"]');
      if (!link) throw new Error(`Expected original admin links on ${path}`);
      fireEvent.click(link);
      expect(current.navigate).toHaveBeenCalledWith('/admin/subjects');
    },
  );
  it('preserves selection, refreshes both reads and falls back with a disappearance notice', async () => {
    const client = injected();
    mount(AdminRunsSurface, client);
    await waitFor(() =>
      expect(client.getRunDetail).toHaveBeenCalledWith({ id: adminRuns.rows[0].id }),
    );
    fireEvent.click(screen.getByText('RunningTask'));
    await waitFor(() =>
      expect(client.getRunDetail).toHaveBeenCalledWith({ id: adminRuns.rows[1].id }),
    );
    client.getRuns.mockClear();
    client.getRunDetail.mockClear();
    fireEvent.click(screen.getByText('刷新'));
    await waitFor(() => expect(client.getRuns).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(client.getRunDetail).toHaveBeenCalledWith({ id: adminRuns.rows[1].id }),
    );
    client.getRuns.mockResolvedValue({
      ...adminRuns,
      rows: [adminRuns.rows[0]],
      data: [adminRuns.rows[0]],
    });
    fireEvent.click(screen.getByText('刷新'));
    await screen.findByText(/刷新后已离开当前列表/);
    await waitFor(() =>
      expect(client.getRunDetail).toHaveBeenLastCalledWith({ id: adminRuns.rows[0].id }),
    );
  });
  it('keeps list and detail errors separate and manual refresh recovers both', async () => {
    const client = injected();
    client.getRunDetail.mockRejectedValueOnce(new Error('detail unavailable'));
    mount(AdminRunsSurface, client);
    await screen.findByText('detail unavailable');
    expect(screen.getByText('EvidenceAnalysis')).toBeTruthy();
    fireEvent.click(screen.getByText('刷新'));
    await screen.findByText('read_evidence');
    client.getRuns.mockRejectedValueOnce(new Error('list unavailable'));
    fireEvent.click(screen.getByText('刷新'));
    await screen.findByText('list unavailable');
    fireEvent.click(screen.getByText('刷新'));
    await screen.findByText('read_evidence');
  });
  it.each(pages.slice(0, 3))(
    'keeps 60s polling and manual refresh for $path',
    async ({ Page, method, ready }) => {
      const client = injected();
      mount(Page, client);
      await screen.findAllByText(ready);
      expect(client[method]).toHaveBeenCalledOnce();
      vi.useFakeTimers();
      // React Query schedules the existing interval at mount; advance only after a refetch reschedules it.
      fireEvent.click(screen.getByText('刷新'));
      await act(() => vi.advanceTimersByTimeAsync(100));
      const count = client[method].mock.calls.length;
      await act(() => vi.advanceTimersByTimeAsync(59_000));
      expect(client[method].mock.calls.length).toBe(count);
      await act(() => vi.advanceTimersByTimeAsync(1_000));
      expect(client[method].mock.calls.length).toBe(count + 1);
    },
  );
  it('keeps coverage scan loading/disable, retry and no polling', async () => {
    const client = injected();
    client.getCoverage.mockRejectedValueOnce(new Error('scan unavailable'));
    mount(AdminCoverageLatticeSurface, client);
    await screen.findByText('coverage lattice 加载失败。');
    fireEvent.click(screen.getByText('重试'));
    await screen.findAllByText('kc-ambiguous');
    let finish: ((value: typeof adminCoverage) => void) | undefined;
    client.getCoverage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByText('重新扫描'));
    await waitFor(() => expect(screen.getByText('扫描中…').hasAttribute('disabled')).toBe(true));
    await act(async () => {
      finish?.(adminCoverage);
    });
    await screen.findByText('重新扫描');
    vi.useFakeTimers();
    const count = client.getCoverage.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(client.getCoverage).toHaveBeenCalledTimes(count);
  });
  it('keeps conjecture initial load, explicit retry, diagnostics/nulls and no polling', async () => {
    const client = injected();
    client.getConjectureScores.mockRejectedValueOnce(new Error('scores unavailable'));
    mount(AdminConjectureScoresSurface, client);
    await screen.findByText('conjecture scores 加载失败。');
    fireEvent.click(screen.getByText('重试'));
    await screen.findAllByText('kc-ambiguous');
    expect(screen.getAllByText(/丢弃/).length).toBeGreaterThan(0);
    expect(screen.queryByText('刷新')).toBeNull();
    vi.useFakeTimers();
    const count = client.getConjectureScores.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(client.getConjectureScores).toHaveBeenCalledTimes(count);
  });
  it.each(pages)(
    'does not load $path before TokenGate validates stored authority',
    async ({ Page, method }) => {
      const client = injected();
      window.localStorage.clear();
      mount(Page, client, true);
      await screen.findByLabelText('访问令牌');
      expect(client[method]).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each(pages.slice(3))(
    'never schedules polling for $path from mount onward',
    async ({ Page, method }) => {
      vi.useFakeTimers();
      const client = injected();
      mount(Page, client);
      await act(() => vi.advanceTimersByTimeAsync(100));
      expect(client[method]).toHaveBeenCalledOnce();
      await act(() => vi.advanceTimersByTimeAsync(120_000));
      expect(client[method]).toHaveBeenCalledOnce();
    },
  );
  it.each(pages)('re-gates and clears cached $path data after a read 401', async ({ Page }) => {
    vi.mocked(fetch).mockImplementation(async (input) =>
      String(input) === '/api/auth/check'
        ? Response.json({ ok: true })
        : Response.json({ error: 'unauthorized' }, { status: 401 }),
    );
    const mounted = mount(Page, undefined, true);
    await screen.findByLabelText('访问令牌');
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(mounted.qc.getQueryCache().getAll()).toHaveLength(0);
  });
  it.each(pages)(
    'loads no $path reader while stored-token validation is epoch fenced',
    async ({ Page, method }) => {
      vi.mocked(fetch).mockResolvedValueOnce(
        Response.json({ error: 'contract_epoch_fenced' }, { status: 503 }),
      );
      const client = injected();
      mount(Page, client, true);
      await screen.findByLabelText('访问令牌');
      expect(client[method]).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledOnce();
      expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('fixture-token');
    },
  );
  it('keeps development HTTP query bounds', async () => {
    await httpAdminClient.getRuns({ limit: '100' });
    await httpAdminClient.getCost({ days: '30' });
    await httpAdminClient.getFailures({ limit: '200' });
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([
      '/api/admin/runs?limit=100',
      '/api/admin/cost?days=30',
      '/api/admin/failures?limit=200',
    ]);
  });
  it.each(pages)(
    'registers a real non-SSR Start route and production document handoff for $path',
    ({ path }) => {
      const route = readFileSync(`server/start/routes/admin.${path}.tsx`, 'utf8');
      expect(route).toContain(`createFileRoute('/admin/${path}')`);
      expect(route).toContain('ssr: false');
      expect(route).toContain('client={startAdminClient}');
      expect(route).toContain('<StartWorkbenchShell');
      const router = readFileSync('web/src/router.tsx', 'utf8');
      expect(router.match(/import.meta.env.PROD\s*\? StartPageEntry/g)?.length).toBe(12);
    },
  );
});
