import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

const INTERNAL_TOKEN = import.meta.env.VITE_INTERNAL_TOKEN ?? '';

interface ToolCallLogRow {
  id: string;
  task_run_id: string;
  task_kind: string;
  tool_name: string;
  input_json: string;
  output_json: string;
  iteration: number;
  latency_ms: number;
  cost: number;
  occurred_at: number;
}

interface CostLedgerRow {
  bucket: string;
  task_kind: string;
  model: string;
  cost_sum: number;
  tokens_in_sum: number;
  tokens_out_sum: number;
  call_count: number;
}

async function fetchLogs<T>(path: string): Promise<{ rows: T[] }> {
  const res = await fetch(`/api/_/logs/${path}`, {
    headers: { 'x-internal-token': INTERNAL_TOKEN },
  });
  if (!res.ok) throw new Error(`logs fetch failed: ${res.status}`);
  return (await res.json()) as { rows: T[] };
}

function ToolCallLogTab() {
  const [taskKindFilter, setTaskKindFilter] = useState('');
  const params = new URLSearchParams({ limit: '50' });
  if (taskKindFilter) params.set('task_kind', taskKindFilter);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['tool_calls', taskKindFilter],
    queryFn: () => fetchLogs<ToolCallLogRow>(`tool_calls?${params}`),
  });

  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center">
        <label className="text-sm text-slate-600">Filter task_kind:</label>
        <input
          type="text"
          value={taskKindFilter}
          onChange={(e) => setTaskKindFilter(e.target.value)}
          placeholder="(any)"
          className="border px-2 py-1 text-sm rounded"
        />
        <button
          type="button"
          onClick={() => refetch()}
          className="px-2 py-1 bg-slate-200 text-sm rounded"
        >
          Refresh
        </button>
      </div>

      {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {error && (
        <p className="text-sm text-red-600">Error: {(error as Error).message}</p>
      )}
      {data && (
        <table className="w-full text-xs border-collapse">
          <thead className="bg-slate-100">
            <tr>
              <th className="text-left p-2">When</th>
              <th className="text-left p-2">Task</th>
              <th className="text-left p-2">Tool</th>
              <th className="text-right p-2">Iter</th>
              <th className="text-right p-2">Latency (ms)</th>
              <th className="text-left p-2">Input → Output</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={6} className="p-4 text-center text-slate-500">
                  No tool call logs yet.
                </td>
              </tr>
            )}
            {data.rows.map((r) => (
              <tr key={r.id} className="border-t align-top">
                <td className="p-2 text-slate-500 whitespace-nowrap">
                  {new Date(r.occurred_at * 1000).toLocaleString()}
                </td>
                <td className="p-2 whitespace-nowrap">{r.task_kind}</td>
                <td className="p-2 font-mono whitespace-nowrap">{r.tool_name}</td>
                <td className="p-2 text-right">{r.iteration}</td>
                <td className="p-2 text-right">{r.latency_ms}</td>
                <td className="p-2 font-mono text-[10px] max-w-md truncate">
                  <details>
                    <summary>view</summary>
                    <pre className="whitespace-pre-wrap break-all">
                      input: {r.input_json}
                      {'\n'}output: {r.output_json}
                    </pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CostLedgerTab() {
  const [range, setRange] = useState<'day' | 'week' | 'month'>('day');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['cost', range],
    queryFn: () =>
      fetchLogs<CostLedgerRow>(`cost?range=${range}`) as Promise<{
        rows: CostLedgerRow[];
        range: string;
      }>,
  });

  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center">
        <label className="text-sm text-slate-600">Range:</label>
        {(['day', 'week', 'month'] as const).map((r) => (
          <button
            type="button"
            key={r}
            onClick={() => setRange(r)}
            className={`px-2 py-1 text-sm rounded ${
              range === r ? 'bg-slate-900 text-white' : 'bg-slate-200'
            }`}
          >
            {r}
          </button>
        ))}
        <button
          type="button"
          onClick={() => refetch()}
          className="px-2 py-1 bg-slate-200 text-sm rounded"
        >
          Refresh
        </button>
      </div>

      {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {error && (
        <p className="text-sm text-red-600">Error: {(error as Error).message}</p>
      )}
      {data && (
        <table className="w-full text-xs border-collapse">
          <thead className="bg-slate-100">
            <tr>
              <th className="text-left p-2">Bucket</th>
              <th className="text-left p-2">Task</th>
              <th className="text-left p-2">Model</th>
              <th className="text-right p-2">Calls</th>
              <th className="text-right p-2">Tokens in</th>
              <th className="text-right p-2">Tokens out</th>
              <th className="text-right p-2">Cost</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={7} className="p-4 text-center text-slate-500">
                  No cost ledger entries yet.
                </td>
              </tr>
            )}
            {data.rows.map((r, idx) => (
              <tr key={`${r.bucket}-${r.task_kind}-${r.model}-${idx}`} className="border-t">
                <td className="p-2 whitespace-nowrap">{r.bucket}</td>
                <td className="p-2 whitespace-nowrap">{r.task_kind}</td>
                <td className="p-2 font-mono whitespace-nowrap">{r.model}</td>
                <td className="p-2 text-right">{r.call_count}</td>
                <td className="p-2 text-right">{r.tokens_in_sum}</td>
                <td className="p-2 text-right">{r.tokens_out_sum}</td>
                <td className="p-2 text-right">${r.cost_sum.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function Inspect() {
  const [tab, setTab] = useState<'tool_calls' | 'cost'>('tool_calls');
  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-xl font-semibold mb-4">/_/inspect</h1>
      <p className="text-sm text-slate-500 mb-1">
        Other admin pages: <a href="/record" className="underline">/record</a> ·{' '}
        <a href="/ingest" className="underline">/ingest</a> ·{' '}
        <a href="/mistakes" className="underline">/mistakes</a> ·{' '}
        <a href="/review" className="underline">/review</a> ·{' '}
        <a href="/learning-items" className="underline">/learning-items</a> ·{' '}
        <a href="/knowledge" className="underline">/knowledge</a> ·{' '}
        <a href="/knowledge/proposals" className="underline">/knowledge/proposals</a>
      </p>
      <p className="text-sm text-slate-500 mb-4">
        Recent ToolCallLog + CostLedger from D1. Manual refresh; no auto-poll.
      </p>

      <div className="flex gap-2 mb-4 border-b">
        <button
          type="button"
          onClick={() => setTab('tool_calls')}
          className={`px-3 py-2 text-sm border-b-2 ${
            tab === 'tool_calls'
              ? 'border-slate-900 font-semibold'
              : 'border-transparent text-slate-500'
          }`}
        >
          ToolCallLog
        </button>
        <button
          type="button"
          onClick={() => setTab('cost')}
          className={`px-3 py-2 text-sm border-b-2 ${
            tab === 'cost'
              ? 'border-slate-900 font-semibold'
              : 'border-transparent text-slate-500'
          }`}
        >
          CostLedger
        </button>
      </div>

      {tab === 'tool_calls' ? <ToolCallLogTab /> : <CostLedgerTab />}
    </main>
  );
}
