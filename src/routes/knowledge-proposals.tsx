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

type AnyMutation =
  | { mutation: 'propose_new'; name: string; parent_id: string | null }
  | { mutation: 'reparent'; node_id: string; new_parent_id: string | null; expected_version: number }
  | { mutation: 'merge'; from_ids: string[]; into_id: string; expected_versions: Record<string, number> }
  | { mutation: 'split'; from_id: string; into: Array<{ name: string; parent_id: string | null }>; expected_version: number }
  | { mutation: 'archive'; node_id: string; expected_version: number };

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
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (res.status === 409 && body.error === 'stale') {
      throw new Error('STALE: knowledge changed since AI proposed this. Re-run AI review.');
    }
    throw new Error(body.message ?? `decide failed: ${res.status}`);
  }
}

function PayloadPreview({ p }: { p: AnyMutation }) {
  switch (p.mutation) {
    case 'propose_new':
      return (
        <span>
          new node <b>{p.name}</b> under <code>{p.parent_id ?? '(root)'}</code>
        </span>
      );
    case 'reparent':
      return (
        <span>
          move <code>{p.node_id}</code> → under <code>{p.new_parent_id ?? '(root, rejected)'}</code>{' '}
          <span className="text-slate-500">(v{p.expected_version})</span>
        </span>
      );
    case 'merge':
      return (
        <span>
          merge <code>[{p.from_ids.join(', ')}]</code> → into <code>{p.into_id}</code>
        </span>
      );
    case 'split':
      return (
        <span>
          split <code>{p.from_id}</code> →{' '}
          {p.into.map((c, i) => (
            <span key={i}>
              <b>{c.name}</b>(under <code>{c.parent_id ?? '(root)'}</code>)
              {i < p.into.length - 1 ? ', ' : ''}
            </span>
          ))}
        </span>
      );
    case 'archive':
      return (
        <span>
          archive <code>{p.node_id}</code>{' '}
          <span className="text-slate-500">(v{p.expected_version})</span>
        </span>
      );
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
        Pending knowledge mutations (5 kinds: propose_new / reparent / merge / split / archive).
        Approve to apply; reject to dismiss. Stale = tree changed since AI proposed; re-run AI
        review.
      </p>

      {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {error && (
        <p className="text-sm text-red-600">Error: {(error as Error).message}</p>
      )}
      {decideMutation.error && (
        <p className="text-sm text-amber-700 mb-2">
          {(decideMutation.error as Error).message}
        </p>
      )}
      {data && data.rows.length === 0 && (
        <p className="text-sm text-slate-500">No pending proposals.</p>
      )}
      {data && data.rows.map((r) => {
        let parsed: AnyMutation | null;
        try {
          parsed = JSON.parse(r.payload) as AnyMutation;
        } catch {
          parsed = null;
        }
        return (
          <div key={r.id} className="border rounded p-3 mb-3">
            <div className="text-xs text-slate-500 mb-1">
              {new Date(r.proposed_at * 1000).toLocaleString()}
            </div>
            <div className="text-sm font-mono mb-2">
              {parsed ? (
                <>
                  <span className="text-slate-700 mr-2">[{parsed.mutation}]</span>
                  <PayloadPreview p={parsed} />
                </>
              ) : (
                <span className="text-red-600">unparseable payload</span>
              )}
            </div>
            <div className="text-xs text-slate-700 mb-2">Why: {r.reasoning}</div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!parsed || decideMutation.isPending}
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
            </div>
          </div>
        );
      })}
    </main>
  );
}
