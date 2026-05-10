import { useQuery } from '@tanstack/react-query';

const INTERNAL_TOKEN = import.meta.env.VITE_INTERNAL_TOKEN ?? '';

interface CauseShape {
  primary_category: string;
  secondary_categories?: string[];
  ai_analysis_md?: string;
  confidence?: number;
  user_edited?: boolean;
  user_notes?: string | null;
}

interface MistakeRow {
  id: string;
  question_id: string;
  prompt_md: string;
  wrong_answer_md: string;
  knowledge_ids: string[];
  cause: CauseShape | null;
  created_at: number;
}

async function fetchRecent(): Promise<MistakeRow[]> {
  const res = await fetch('/api/mistakes/recent?limit=20', {
    headers: { 'x-internal-token': INTERNAL_TOKEN },
  });
  if (!res.ok) throw new Error(`fetch /api/mistakes/recent failed: ${res.status}`);
  const body = (await res.json()) as { rows: MistakeRow[] };
  return body.rows;
}

function fmtTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString('zh-CN', { hour12: false });
}

function CauseBadge({ cause, createdAt }: { cause: CauseShape | null; createdAt: number }) {
  if (cause === null) {
    const elapsedSec = Math.floor(Date.now() / 1000) - createdAt;
    if (elapsedSec < 30) {
      return (
        <span className="text-xs px-2 py-1 rounded bg-yellow-100 text-yellow-800">归因中...</span>
      );
    }
    return <span className="text-xs px-2 py-1 rounded bg-slate-200 text-slate-700">待归因</span>;
  }
  const isAi = cause.user_edited === false;
  const cls = isAi ? 'bg-blue-100 text-blue-800' : 'bg-green-100 text-green-800';
  const confidencePct = cause.confidence != null ? ` (${Math.round(cause.confidence * 100)}%)` : '';
  const label = isAi
    ? `AI · ${cause.primary_category}${confidencePct}`
    : `用户 · ${cause.primary_category}`;
  return <span className={`text-xs px-2 py-1 rounded ${cls}`}>{label}</span>;
}

export function MistakesList() {
  const recentQuery = useQuery({
    queryKey: ['/api/mistakes/recent'],
    queryFn: fetchRecent,
    refetchInterval: (query) => {
      const data = query.state.data as MistakeRow[] | undefined;
      const hasNull = data?.some((r) => r.cause === null) ?? false;
      return hasNull ? 5000 : false;
    },
  });
  const data = recentQuery.data ?? [];
  const pendingCount = data.filter((r) => r.cause === null).length;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold">错题列表</h1>
        <a href="/knowledge/proposals" className="text-sm underline text-slate-600">
          查看 AI 知识点提议 →
        </a>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        最近 20 条 ·{' '}
        {pendingCount > 0 ? (
          <span className="text-yellow-700">
            归因中 {pendingCount} / 已归因 {data.length - pendingCount}
          </span>
        ) : (
          <span>全部归因完毕（{data.length}）</span>
        )}
        {' · '}
        <a href="/capture" className="underline">
          + 录入新错题
        </a>
      </p>

      <a
        href="/review"
        className="inline-block mb-4 px-3 py-2 bg-slate-900 text-white rounded hover:bg-slate-800"
      >
        开始复习 →
      </a>

      {recentQuery.isLoading && <p className="text-sm text-slate-500">加载中...</p>}
      {recentQuery.isError && (
        <p className="text-sm text-red-600">加载失败: {String(recentQuery.error)}</p>
      )}

      <ul className="space-y-3">
        {data.map((row) => (
          <li key={row.id} className="border rounded p-3">
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-xs text-slate-400">{fmtTime(row.created_at)}</span>
              <CauseBadge cause={row.cause} createdAt={row.created_at} />
            </div>
            <p className="text-sm font-medium whitespace-pre-wrap">{row.prompt_md}</p>
            <p className="text-sm text-slate-700 mt-1">
              <span className="text-xs text-slate-400">错答:</span> {row.wrong_answer_md}
            </p>
            <p className="text-xs text-slate-500 mt-1">知识点: {row.knowledge_ids.join(', ')}</p>
            {row.cause?.ai_analysis_md && (
              <details className="mt-2">
                <summary className="text-xs text-slate-500 cursor-pointer">分析</summary>
                <p className="text-xs text-slate-600 mt-1 whitespace-pre-wrap">
                  {row.cause.ai_analysis_md}
                </p>
              </details>
            )}
          </li>
        ))}
      </ul>

      {!recentQuery.isLoading && data.length === 0 && (
        <p className="text-sm text-slate-500">
          还没有错题。
          <a href="/capture" className="underline">
            先录一条
          </a>
          。
        </p>
      )}
    </main>
  );
}
