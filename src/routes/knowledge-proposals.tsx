import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

const INTERNAL_TOKEN = import.meta.env.VITE_INTERNAL_TOKEN ?? '';

interface ProposalRow {
  id: string;
  kind: string;
  payload: string;
  reasoning: string;
  status: string;
  proposed_at: number;
  decided_at: number | null;
}

interface ProposeNewPayload {
  mutation: 'propose_new';
  name: string;
  parent_id: string | null;
}

async function fetchProposals(): Promise<{ rows: ProposalRow[] }> {
  const res = await fetch('/api/knowledge/proposals?status=pending', {
    headers: { 'x-internal-token': INTERNAL_TOKEN },
  });
  if (!res.ok) throw new Error(`proposals fetch failed: ${res.status}`);
  return (await res.json()) as { rows: ProposalRow[] };
}

async function decide(id: string, decision: 'accept' | 'reject'): Promise<void> {
  const res = await fetch(`/api/knowledge/proposals/${id}/decide`, {
    method: 'POST',
    headers: {
      'x-internal-token': INTERNAL_TOKEN,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ decision }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `decide failed: ${res.status}`);
  }
}

export function KnowledgeProposals() {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['knowledge-proposals'],
    queryFn: fetchProposals,
  });
  const decideMutation = useMutation({
    mutationFn: (args: { id: string; decision: 'accept' | 'reject' }) =>
      decide(args.id, args.decision),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-proposals'] });
      queryClient.invalidateQueries({ queryKey: ['knowledge'] });
    },
  });

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">/knowledge/proposals</h1>
        <button
          type="button"
          onClick={() => refetch()}
          className="px-2 py-1 bg-slate-200 text-sm rounded"
        >
          Refresh
        </button>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        Pending knowledge mutations. PR A 仅 propose_new；reparent/merge/split/archive 在 PR B。
      </p>

      {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {error && (
        <p className="text-sm text-red-600">Error: {(error as Error).message}</p>
      )}
      {decideMutation.error && (
        <p className="text-sm text-red-600 mb-2">
          Decide failed: {(decideMutation.error as Error).message}
        </p>
      )}
      {data && data.rows.length === 0 && (
        <p className="text-sm text-slate-500">No pending proposals.</p>
      )}
      {data && data.rows.map((r) => {
        let parsed: { mutation?: string; name?: string; parent_id?: string | null };
        try {
          parsed = JSON.parse(r.payload) as ProposeNewPayload;
        } catch {
          parsed = { mutation: 'unknown' };
        }
        const isProposeNew = parsed.mutation === 'propose_new';
        return (
          <div key={r.id} className="border rounded p-3 mb-3">
            <div className="text-xs text-slate-500 mb-1">
              {new Date(r.proposed_at * 1000).toLocaleString()}
            </div>
            <div className="text-sm font-mono mb-2">
              {parsed.mutation ?? 'unknown'}
              {isProposeNew && (
                <>
                  {' '}→ name=<b>{parsed.name}</b>, parent_id=
                  <code>{parsed.parent_id ?? '(root)'}</code>
                </>
              )}
            </div>
            <div className="text-xs text-slate-700 mb-2">Why: {r.reasoning}</div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!isProposeNew || decideMutation.isPending}
                onClick={() => decideMutation.mutate({ id: r.id, decision: 'accept' })}
                className="px-2 py-1 bg-emerald-600 text-white text-sm rounded disabled:opacity-50"
              >
                Accept
              </button>
              <button
                type="button"
                disabled={decideMutation.isPending}
                onClick={() => decideMutation.mutate({ id: r.id, decision: 'reject' })}
                className="px-2 py-1 bg-slate-200 text-sm rounded disabled:opacity-50"
              >
                Reject
              </button>
              {!isProposeNew && (
                <span className="text-xs text-amber-700 self-center">
                  PR B 才支持此 mutation 类型
                </span>
              )}
            </div>
          </div>
        );
      })}
    </main>
  );
}
