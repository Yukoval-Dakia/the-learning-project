import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';

const INTERNAL_TOKEN = import.meta.env.VITE_INTERNAL_TOKEN ?? '';

interface Cause {
  primary_category: string;
  ai_analysis_md?: string;
  confidence?: number;
  user_edited?: boolean;
}

interface FsrsState {
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: 'new' | 'learning' | 'review' | 'relearning';
  last_review: string | null;
}

interface DueRow {
  id: string;
  question_id: string;
  prompt_md: string;
  reference_md: string | null;
  knowledge_ids: string[];
  cause: Cause | null;
  fsrs_state: FsrsState | null;
  created_at: number;
}

type Rating = 'again' | 'hard' | 'good';

async function fetchDue(): Promise<DueRow[]> {
  const res = await fetch('/api/review/due?limit=50', {
    headers: { 'x-internal-token': INTERNAL_TOKEN },
  });
  if (!res.ok) throw new Error(`GET /api/review/due ${res.status}`);
  const body = (await res.json()) as { rows: DueRow[] };
  return body.rows;
}

async function postSubmit(payload: {
  mistake_id: string;
  rating: Rating;
  response_md: string | null;
  latency_ms: number;
}): Promise<{ next_due_at: number }> {
  const res = await fetch('/api/review/submit', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-token': INTERNAL_TOKEN,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST /api/review/submit ${res.status}: ${text}`);
  }
  return (await res.json()) as { next_due_at: number };
}

export function ReviewSession() {
  const dueQuery = useQuery({ queryKey: ['/api/review/due'], queryFn: fetchDue });
  const data = dueQuery.data ?? [];

  const [currentIndex, setCurrentIndex] = useState(0);
  const [responseMd, setResponseMd] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const startTimeRef = useRef<number>(performance.now());

  const currentMistake = data[currentIndex];

  useEffect(() => {
    setResponseMd('');
    setErrorMsg(null);
    startTimeRef.current = performance.now();
  }, [currentIndex]);

  const submitMutation = useMutation({
    mutationFn: postSubmit,
    onSuccess: () => {
      setCurrentIndex((i) => i + 1);
    },
    onError: (err: Error) => setErrorMsg(err.message),
  });

  function submit(rating: Rating) {
    if (!currentMistake || submitMutation.isPending) return;
    const latency_ms = Math.round(performance.now() - startTimeRef.current);
    submitMutation.mutate({
      mistake_id: currentMistake.id,
      rating,
      response_md: responseMd.trim() === '' ? null : responseMd,
      latency_ms,
    });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && target.tagName === 'TEXTAREA') return;
      if (e.key === '1') { e.preventDefault(); submit('again'); }
      else if (e.key === '2') { e.preventDefault(); submit('hard'); }
      else if (e.key === '3') { e.preventDefault(); submit('good'); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentIndex, submitMutation.isPending]);

  if (dueQuery.isLoading) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <p className="text-sm text-slate-500">加载中...</p>
      </main>
    );
  }

  if (dueQuery.isError) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <p className="text-sm text-red-600">
          加载失败: {String(dueQuery.error)}。请刷新重试。
        </p>
      </main>
    );
  }

  if (data.length === 0) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <p className="text-lg font-medium mb-4">今天没有要复习的，太好了</p>
        <div className="flex gap-4 text-sm">
          <a href="/capture" className="underline">+ 录新错题</a>
          <a href="/mistakes" className="underline">看历史 →</a>
        </div>
      </main>
    );
  }

  if (currentIndex >= data.length) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <p className="text-lg font-medium mb-4">今日复习完毕（{data.length} 条）</p>
        <a href="/mistakes" className="underline">看错题历史 →</a>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold">复习</h1>
        <span className="text-sm text-slate-500">{currentIndex + 1} / {data.length}</span>
      </div>

      <p className="text-xs text-slate-500 mb-2">
        知识点: {currentMistake.knowledge_ids.join(', ')}
        {currentMistake.cause && (
          <>
            {' · '}
            <span>错因: {currentMistake.cause.primary_category}
              {currentMistake.cause.confidence != null && ` (${Math.round(currentMistake.cause.confidence * 100)}%)`}
            </span>
          </>
        )}
      </p>

      <div className="mb-4">
        <p className="text-xs text-slate-400 mb-1">题面</p>
        <p className="whitespace-pre-wrap font-medium">{currentMistake.prompt_md}</p>
      </div>

      {currentMistake.reference_md && (
        <details className="mb-4">
          <summary className="text-xs text-slate-500 cursor-pointer">参考答案（点开看）</summary>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{currentMistake.reference_md}</p>
        </details>
      )}

      {currentMistake.cause?.ai_analysis_md && (
        <details className="mb-4">
          <summary className="text-xs text-slate-500 cursor-pointer">AI 错因分析</summary>
          <p className="mt-1 whitespace-pre-wrap text-xs text-slate-600">{currentMistake.cause.ai_analysis_md}</p>
        </details>
      )}

      <label className="block mb-4">
        <span className="text-xs text-slate-500">你这次的答案 (可空)</span>
        <textarea
          value={responseMd}
          onChange={(e) => setResponseMd(e.target.value)}
          rows={3}
          className="mt-1 w-full border rounded p-2 font-mono text-sm"
        />
      </label>

      {errorMsg && <p className="text-sm text-red-600 mb-2">{errorMsg}</p>}

      <div className="flex gap-3">
        <button
          type="button"
          disabled={submitMutation.isPending}
          onClick={() => submit('again')}
          className="flex-1 px-4 py-3 bg-red-100 hover:bg-red-200 text-red-900 rounded disabled:opacity-50"
        >
          不会 (1)
        </button>
        <button
          type="button"
          disabled={submitMutation.isPending}
          onClick={() => submit('hard')}
          className="flex-1 px-4 py-3 bg-yellow-100 hover:bg-yellow-200 text-yellow-900 rounded disabled:opacity-50"
        >
          模糊 (2)
        </button>
        <button
          type="button"
          disabled={submitMutation.isPending}
          onClick={() => submit('good')}
          className="flex-1 px-4 py-3 bg-green-100 hover:bg-green-200 text-green-900 rounded disabled:opacity-50"
        >
          会了 (3)
        </button>
      </div>
    </main>
  );
}
