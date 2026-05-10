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
        <label htmlFor="task_kind_filter" className="text-sm text-slate-600">
          Filter task_kind:
        </label>
        <input
          id="task_kind_filter"
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
      {error && <p className="text-sm text-red-600">Error: {(error as Error).message}</p>}
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
      <fieldset className="flex gap-2 items-center border-0 p-0 m-0">
        <legend className="text-sm text-slate-600">Range:</legend>
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
      </fieldset>

      {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {error && <p className="text-sm text-red-600">Error: {(error as Error).message}</p>}
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

function DataTab() {
  const [downloading, setDownloading] = useState(false);
  const [downloadBytes, setDownloadBytes] = useState(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [importStatus, setImportStatus] = useState<string | null>(null);

  async function downloadExport(includeAssets: boolean) {
    setDownloading(true);
    setDownloadBytes(0);
    setDownloadError(null);
    const url = includeAssets ? '/api/_/export?include_assets=1' : '/api/_/export';
    try {
      const res = await fetch(url, { headers: { 'x-internal-token': INTERNAL_TOKEN } });
      if (!res.ok || !res.body) {
        const text = res.ok ? 'no body' : await res.text();
        setDownloadError(`${res.status}: ${text}`);
        return;
      }
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        bytes += value.length;
        setDownloadBytes(bytes);
      }
      const blob = new Blob(chunks as BlobPart[], { type: 'application/zip' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `loom-backup-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  }

  async function runImport() {
    if (!importFile) return;
    if (confirmText !== 'wipe') {
      setImportStatus('请先在 confirm 框内输入 "wipe" 字样');
      return;
    }
    setImportStatus('清空 + 还原中...');
    try {
      const ab = await importFile.arrayBuffer();
      const res = await fetch('/api/_/import?confirm=wipe-and-reload', {
        method: 'POST',
        headers: {
          'x-internal-token': INTERNAL_TOKEN,
          'content-type': 'application/zip',
        },
        body: ab,
      });
      if (res.ok) {
        const body = (await res.json()) as {
          ok: boolean;
          stats: unknown;
          assets_uploaded: number;
          assets_failed: number;
          failed_keys?: string[];
        };
        const failureNote =
          body.assets_failed > 0
            ? ` ⚠ ${body.assets_failed} 个 R2 资源上传失败：${(body.failed_keys ?? []).join(', ').slice(0, 200)}`
            : '';
        setImportStatus(
          `${body.ok ? '完成' : '完成（含失败）'}。assets uploaded: ${body.assets_uploaded}${failureNote}。3 秒后刷新页面...`,
        );
        setTimeout(() => window.location.reload(), 3000);
      } else {
        const text = await res.text();
        setImportStatus(`失败: ${res.status} ${text}`);
      }
    } catch (err) {
      setImportStatus(`失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-base font-medium">下载备份</h2>
        <div className="flex gap-2 mt-2">
          <button
            type="button"
            onClick={() => downloadExport(false)}
            disabled={downloading}
            className="px-3 py-1.5 bg-slate-900 text-white text-sm rounded disabled:opacity-50"
          >
            data only (refs)
          </button>
          <button
            type="button"
            onClick={() => downloadExport(true)}
            disabled={downloading}
            className="px-3 py-1.5 bg-slate-700 text-white text-sm rounded disabled:opacity-50"
          >
            full (含 R2 图片)
          </button>
        </div>
        {downloading && (
          <p className="text-sm text-slate-600 mt-2">
            已下载 {(downloadBytes / 1024 / 1024).toFixed(1)} MB
          </p>
        )}
        {downloadError && <p className="text-sm text-red-600 mt-2">{downloadError}</p>}
      </section>

      <section>
        <h2 className="text-base font-medium text-red-700">还原（清空式）</h2>
        <p className="text-xs text-slate-500 mt-1">
          这个动作会删除所有 D1 数据 + R2 图片，然后从你上传的 ZIP 重装。先 export 当前再 import
          新的；没 UNDO。
        </p>
        <div className="mt-2 space-y-2">
          <input
            type="file"
            accept=".zip"
            onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
          />
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder='输入 "wipe" 确认'
            className="border px-2 py-1 text-sm rounded block"
          />
          <button
            type="button"
            onClick={runImport}
            disabled={!importFile || confirmText !== 'wipe'}
            className="px-3 py-1.5 bg-red-700 text-white text-sm rounded disabled:opacity-40"
          >
            清空并还原
          </button>
          {importStatus && <p className="text-sm text-slate-600">{importStatus}</p>}
        </div>
      </section>
    </div>
  );
}

export function Inspect() {
  const [tab, setTab] = useState<'tool_calls' | 'cost' | 'data'>('tool_calls');
  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-xl font-semibold mb-4">/_/inspect</h1>
      <p className="text-sm text-slate-500 mb-1">
        Other admin pages:{' '}
        <a href="/capture" className="underline">
          /capture
        </a>{' '}
        ·{' '}
        <a href="/mistakes" className="underline">
          /mistakes
        </a>{' '}
        ·{' '}
        <a href="/review" className="underline">
          /review
        </a>{' '}
        ·{' '}
        <a href="/learning-items" className="underline">
          /learning-items
        </a>{' '}
        ·{' '}
        <a href="/knowledge" className="underline">
          /knowledge
        </a>{' '}
        ·{' '}
        <a href="/knowledge/proposals" className="underline">
          /knowledge/proposals
        </a>
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
            tab === 'cost' ? 'border-slate-900 font-semibold' : 'border-transparent text-slate-500'
          }`}
        >
          CostLedger
        </button>
        <button
          type="button"
          onClick={() => setTab('data')}
          className={`px-3 py-2 text-sm border-b-2 ${
            tab === 'data' ? 'border-slate-900 font-semibold' : 'border-transparent text-slate-500'
          }`}
        >
          Data
        </button>
      </div>

      {tab === 'tool_calls' && <ToolCallLogTab />}
      {tab === 'cost' && <CostLedgerTab />}
      {tab === 'data' && <DataTab />}
    </main>
  );
}
