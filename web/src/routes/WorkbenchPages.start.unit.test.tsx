// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TodayPage from '@/capabilities/shell/ui/TodayPage';
import type { WorkbenchSummary } from '@/capabilities/shell/ui/workbench-api';
import {
  WorkbenchClientProvider,
  httpWorkbenchClient,
} from '@/capabilities/shell/ui/workbench-client';
import { TOKEN_STORAGE_KEY } from '@/ui/lib/api';
import { RootShell } from '../RootShell';

// External Copilot stream behavior has its own tests; this slice leaves it intact.
vi.mock('@/capabilities/copilot/ui-public', () => ({ CopilotDock: () => null }));
const summary: WorkbenchSummary = {
  proposals: {
    total: 2,
    decision_total: 1,
    by_kind: { note_update: 1, goal_scope: 1 },
    has_more: false,
    limit: 50_000,
    status: 'pending',
  },
  kpi: { due_count: 3, pending_attribution_count: 2, knowledge_count: 18, goal_count: 2 },
  cold_start: {
    is_empty: false,
    evidence: {
      active_goal: false,
      goal_history: true,
      knowledge: true,
      question: true,
      source_material: true,
      artifact: true,
      review_due: true,
      pending_attribution: true,
      practice_stream: true,
      proposal: true,
      learning_session: true,
      user_event: true,
    },
  },
  active_goal: null,
  active_sessions: [
    {
      id: 'retained-session',
      status: 'running',
      summary_md: '原有学习记录与帮助程度\n'.repeat(40),
      started_at: 1_791_415_800,
      ended_at: null,
      duration_ms: null,
      reviewed_count: 2,
    },
  ],
  week_heat: [
    { day: '2026-10-07', count: 3 },
    { day: '2026-10-08', count: 2 },
  ],
};
const overnight: Awaited<ReturnType<typeof httpWorkbenchClient.getOvernightDigest>> = {
  window: { from: '2026-10-06T16:00:00Z', to: '2026-10-07T16:00:00Z' },
  has_overnight_activity: false,
  runs: [],
  note_changes_count: 0,
  new_proposals_count: 0,
  new_conjectures_count: 0,
  agent_notes_count: 0,
  degraded_kinds: [],
  cost: {
    scope: 'all_activity',
    records: 1,
    details: [],
    by_currency: [
      {
        currency: 'USD',
        cost: 0,
        reported_cost: 0,
        estimated_cost: 0,
        legacy_cost: 0,
        reported_attempts: 0,
        estimated_attempts: 0,
        legacy_rows: 0,
        unknown_attempts: 1,
      },
    ],
  },
};
const cost: Awaited<ReturnType<typeof httpWorkbenchClient.getTodayCost>> = {
  window: { from: 1_791_302_400, to: 1_791_381_600, label: 'BJT today (from local midnight)' },
  today: {
    by_currency: [],
    tokens_in: 0,
    tokens_out: 0,
    ledger_rows: 0,
    unknown_attempts: 1,
    legacy_rows: 0,
    tool_calls: 2,
    by_truth: [],
    by_task: [],
  },
};
const responses = new Map<string, unknown>([
  ['/api/workbench/summary', summary],
  ['/api/workbench/overnight-digest', overnight],
  ['/api/cost/today', cost],
  ['/api/artifacts/ai-changes/recent', { rows: [], window_hours: 24 }],
  ['/api/agents/notes', { rows: [] }],
  ['/api/prep-desk/brief', { brief: null }],
  ['/api/prep-desk/probes', { probes: [] }],
]);
const clients: QueryClient[] = [];
function mount(client?: typeof httpWorkbenchClient) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(qc);
  const page = (
    <RootShell pathname="/today" navigate={() => {}}>
      <TodayPage navigate={() => {}} />
    </RootShell>
  );
  return render(
    <QueryClientProvider client={qc}>
      {client ? <WorkbenchClientProvider value={client}>{page}</WorkbenchClientProvider> : page}
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T00:00:00Z'));
  window.localStorage.setItem(TOKEN_STORAGE_KEY, 'fixture-token');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://isolated.test').pathname;
      if (!responses.has(path)) throw new Error(`unexpected request: ${path}`);
      return Response.json(responses.get(path));
    }),
  );
});
afterEach(() => {
  cleanup();
  for (const qc of clients.splice(0)) qc.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('Today and original RootShell Start ports', () => {
  it('renders identical settled markup, dedupes the shell summary, and replaces the primary HTTP consumers', async () => {
    const legacy = mount();
    await screen.findByRole('button', { name: '昨日 AI 用量与费用' });
    await waitFor(() => expect(legacy.container.textContent).toContain('AI 改动'));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBe(7));
    // React useId increments across roots; normalize only those linked IDs.
    const normalizeIds = (html: string) => html.replaceAll(/_r_\d+_/g, '_react-id_');
    const markup = normalizeIds(legacy.container.innerHTML);
    cleanup();
    clients[0].clear();
    vi.mocked(fetch).mockClear();
    const readSummary = vi.fn(async () => summary);
    const readOvernight = vi.fn(async () => overnight);
    const readCost = vi.fn(async () => cost);
    const readChanges = vi.fn(async () => ({ rows: [], window_hours: 24 as const }));
    const start = mount({
      ...httpWorkbenchClient,
      getWorkbenchSummary: readSummary,
      getOvernightDigest: readOvernight,
      getTodayCost: readCost,
      getRecentAiChanges: readChanges,
    });
    await screen.findByRole('button', { name: '昨日 AI 用量与费用' });
    await waitFor(() => expect(normalizeIds(start.container.innerHTML)).toBe(markup));
    expect(readSummary).toHaveBeenCalledOnce();
    expect(readOvernight).toHaveBeenCalledOnce();
    expect(readCost).toHaveBeenCalledOnce();
    expect(readChanges).toHaveBeenCalledOnce();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.map(([url]) => new URL(String(url), 'http://isolated.test').pathname)
        .sort(),
    ).toEqual(['/api/agents/notes', '/api/prep-desk/brief', '/api/prep-desk/probes']);
  });
  it('keeps the cold-start gate, including the notes-board read gate, under the canonical summary', async () => {
    const empty = { ...summary, cold_start: { ...summary.cold_start, is_empty: true } };
    const readSummary = vi.fn(async () => empty);
    mount({ ...httpWorkbenchClient, getWorkbenchSummary: readSummary });
    expect(await screen.findByText('先告诉我你想学什么')).toBeTruthy();
    expect(readSummary).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
});
