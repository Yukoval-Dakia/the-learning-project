import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

const INTERNAL_TOKEN = import.meta.env.VITE_INTERNAL_TOKEN ?? '';

interface KnowledgeNode {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
  archived_at: number | null;
  effective_domain: string | null;
}

async function fetchKnowledge(): Promise<{ rows: KnowledgeNode[] }> {
  const res = await fetch('/api/knowledge', {
    headers: { 'x-internal-token': INTERNAL_TOKEN },
  });
  if (!res.ok) throw new Error(`knowledge fetch failed: ${res.status}`);
  return (await res.json()) as { rows: KnowledgeNode[] };
}

async function* triggerReview(): AsyncGenerator<string, void, void> {
  const res = await fetch('/api/knowledge/review', {
    method: 'POST',
    headers: {
      'x-internal-token': INTERNAL_TOKEN,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  if (!res.ok || !res.body) {
    throw new Error(`review failed: ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      const tail = decoder.decode();
      if (tail) yield tail;
      return;
    }
    yield decoder.decode(value, { stream: true });
  }
}

export function KnowledgeTree() {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['knowledge'],
    queryFn: fetchKnowledge,
  });
  const [reviewText, setReviewText] = useState('');
  const reviewMutation = useMutation({
    mutationFn: async () => {
      setReviewText('');
      let buf = '';
      for await (const chunk of triggerReview()) {
        buf += chunk;
        setReviewText(buf);
      }
      return buf;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-proposals'] });
      queryClient.invalidateQueries({ queryKey: ['knowledge'] });
    },
  });

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">/knowledge</h1>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => reviewMutation.mutate()}
            disabled={reviewMutation.isPending}
            className="px-2 py-1 bg-slate-900 text-white text-sm rounded disabled:opacity-50"
          >
            {reviewMutation.isPending ? 'AI reviewing…' : 'AI review my tree'}
          </button>
          <button
            type="button"
            onClick={() => refetch()}
            className="px-2 py-1 bg-slate-200 text-sm rounded"
          >
            Refresh
          </button>
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        Knowledge tree (read-only). Effective domain inherited from parent chain. AI review triggers
        KnowledgeReviewTask, which writes proposals to{' '}
        <a href="/knowledge/proposals" className="underline">
          /knowledge/proposals
        </a>
        .
      </p>

      {reviewMutation.error && (
        <p className="text-sm text-red-600 mb-2">
          Review failed: {(reviewMutation.error as Error).message}
        </p>
      )}
      {(reviewMutation.isPending || reviewText) && (
        <pre className="bg-slate-50 border rounded p-3 text-xs whitespace-pre-wrap mb-4 max-h-64 overflow-auto">
          {reviewText || '(waiting for first chunk)'}
        </pre>
      )}

      {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {error && <p className="text-sm text-red-600">Error: {(error as Error).message}</p>}
      {data && (
        <table className="w-full text-xs border-collapse">
          <thead className="bg-slate-100">
            <tr>
              <th className="text-left p-2">id</th>
              <th className="text-left p-2">name</th>
              <th className="text-left p-2">parent_id</th>
              <th className="text-left p-2">domain</th>
              <th className="text-left p-2">effective_domain</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={5} className="p-4 text-center text-slate-500">
                  No knowledge nodes yet. POST /api/_/seed to seed wenyan top-level.
                </td>
              </tr>
            )}
            {data.rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="p-2 font-mono text-[10px]">{r.id}</td>
                <td className="p-2">{r.name}</td>
                <td className="p-2 font-mono text-[10px] text-slate-500">{r.parent_id ?? '—'}</td>
                <td className="p-2 text-slate-500">{r.domain ?? '(inherit)'}</td>
                <td className="p-2">{r.effective_domain ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
