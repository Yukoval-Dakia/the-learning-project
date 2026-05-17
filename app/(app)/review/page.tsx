'use client';

import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { Badge } from '@/ui/primitives/Badge';
import { CauseBadge } from '@/ui/primitives/CauseBadge';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

interface DueRow {
  id: string;
  question_id: string;
  prompt_md: string;
  reference_md: string | null;
  knowledge_ids: string[];
  fsrs_state: unknown;
}

interface MistakeRow {
  question_id: string;
  cause: {
    source?: 'user' | 'agent';
    primary_category: string;
    secondary_categories?: string[];
    user_notes: string | null;
    confidence?: number | null;
  } | null;
}

type Phase = 'answering' | 'feedback';
type Rating = 'again' | 'hard' | 'good' | 'easy';

const RATING_LABELS: Record<Rating, string> = {
  again: '不会',
  hard: '勉强',
  good: '会',
  easy: '熟练',
};

const RATING_CLASS: Record<Rating, string> = {
  again: 'again',
  hard: 'hard',
  good: 'good',
  easy: 'coral',
};

const RATING_KEY: Record<Rating, string> = {
  again: '1',
  hard: '2',
  good: '3',
  easy: '4',
};

export default function ReviewPage() {
  const qc = useQueryClient();

  // ADR-0013 — open a learning_session(type='review') on mount; close on
  // pagehide via sendBeacon (so it survives tab close).
  const [sessionId, setSessionId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let createdId: string | null = null;
    (async () => {
      try {
        const data = await apiJson<{ session_id: string }>('/api/review/sessions', {
          method: 'POST',
        });
        if (cancelled) {
          void apiJson(`/api/review/sessions/${data.session_id}/end`, {
            method: 'POST',
            body: JSON.stringify({ status: 'abandoned' }),
          }).catch(() => {});
          return;
        }
        createdId = data.session_id;
        setSessionId(data.session_id);
      } catch {
        // Session couldn't be opened — review still works without one.
      }
    })();
    const onPageHide = () => {
      if (!createdId) return;
      const body = new Blob([JSON.stringify({ status: 'completed' })], {
        type: 'application/json',
      });
      navigator.sendBeacon(`/api/review/sessions/${createdId}/end`, body);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      cancelled = true;
      window.removeEventListener('pagehide', onPageHide);
      if (createdId) {
        void apiJson(`/api/review/sessions/${createdId}/end`, {
          method: 'POST',
          body: JSON.stringify({ status: 'completed' }),
        }).catch(() => {});
      }
    };
  }, []);

  const dueQ = useQuery({
    queryKey: ['review-due'],
    queryFn: () => apiJson<{ rows: DueRow[] }>('/api/review/due?limit=50'),
  });

  const causeMapQ = useQuery({
    queryKey: ['review-cause-map'],
    queryFn: async () => {
      const data = await apiJson<{ rows: MistakeRow[] }>('/api/mistakes?limit=200');
      const map = new Map<string, MistakeRow['cause']>();
      for (const r of data.rows) {
        if (!map.has(r.question_id)) map.set(r.question_id, r.cause);
      }
      return map;
    },
  });

  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>('answering');
  const [answer, setAnswer] = useState('');
  const [showRef, setShowRef] = useState(false);

  const rows = dueQ.data?.rows ?? [];
  const total = rows.length;
  const current = rows[index];
  const isDone = total > 0 && index >= total;

  const submitM = useMutation({
    mutationFn: (rating: Rating) => {
      if (!current) throw new Error('no current question');
      return apiJson<{ next_due_at: number }>('/api/review/submit', {
        method: 'POST',
        body: JSON.stringify({
          mistake_id: current.question_id,
          rating,
          response_md: answer || null,
          session_id: sessionId,
        }),
      });
    },
    onSuccess: () => {
      setIndex((i) => i + 1);
      setPhase('answering');
      setAnswer('');
      setShowRef(false);
      qc.invalidateQueries({ queryKey: ['review-due'] });
    },
  });

  const handleReveal = useCallback(() => {
    if (phase === 'answering' && current) setPhase('feedback');
  }, [phase, current]);

  const handleRate = useCallback(
    (r: Rating) => {
      if (phase !== 'feedback' || submitM.isPending) return;
      submitM.mutate(r);
    },
    [phase, submitM],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phase === 'answering' && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleReveal();
        return;
      }
      if (phase === 'feedback' && !submitM.isPending) {
        if (e.key === '1') handleRate('again');
        else if (e.key === '2') handleRate('hard');
        else if (e.key === '3') handleRate('good');
        else if (e.key === '4') handleRate('easy');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, submitM.isPending, handleReveal, handleRate]);

  const cause = current ? (causeMapQ.data?.get(current.question_id) ?? null) : null;

  const eyebrow =
    total > 0 && !isDone
      ? `REVIEW · session=${sessionId ?? '—'} · ${Math.min(index + 1, total)} / ${total}`
      : 'REVIEW';

  return (
    <main className="page prose">
      <PageHeader
        title="复习"
        eyebrow={eyebrow}
        sub="按下 1 / 2 / 3 / 4 写一条 action=review 事件，FSRS 状态投影表同事务更新。"
      />

      {dueQ.isLoading && (
        <section className="review-stage">
          <p className="empty">正在加载复习队列…</p>
        </section>
      )}

      {dueQ.isError && (
        <section className="review-stage">
          <p className="empty" style={{ color: 'var(--again-ink)' }}>
            {dueQ.error instanceof ApiAuthError
              ? `${dueQ.error.message} — 请重新进入页面输入 token`
              : `加载失败：${(dueQ.error as Error).message}`}
          </p>
        </section>
      )}

      {dueQ.isSuccess && total === 0 && (
        <section className="review-stage">
          <p className="empty">今天没有要复习的，太好了。</p>
        </section>
      )}

      {dueQ.isSuccess && isDone && (
        <section className="review-stage">
          <p className="empty">本轮 {total} 道全部复习完毕。FSRS 已根据评分更新到期时间。</p>
        </section>
      )}

      {current && !isDone && (
        <section className="review-stage">
          <div className="progress">
            <span>
              {index + 1} / {total} · FSRS
              {current.knowledge_ids[0] && ` · ${current.knowledge_ids[0]}`}
            </span>
            <span>{cause && `上次归因 ${cause.primary_category}`}</span>
          </div>

          <div className="qbody">{current.prompt_md}</div>

          {current.knowledge_ids.length > 0 && (
            <div className="knowledge-chips">
              {current.knowledge_ids.map((kid) => (
                <Badge key={kid} tone="neutral">
                  {kid}
                </Badge>
              ))}
            </div>
          )}

          {phase === 'answering' && (
            <>
              <div className="label-mono">你的答案</div>
              <textarea
                placeholder="不看参考，先答…… Cmd/Ctrl + Enter 进入对照"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
              />
              <details
                className="ref-reveal"
                open={showRef}
                onToggle={(e) => setShowRef((e.target as HTMLDetailsElement).open)}
              >
                <summary>参考答 ▾（提前看会减分）</summary>
                <div className="ref-text">{current.reference_md ?? '(无)'}</div>
              </details>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button type="button" className="btn-rating coral" onClick={handleReveal}>
                  <span>进入对照</span>
                  <kbd>⌘↵</kbd>
                </button>
              </div>
            </>
          )}

          {phase === 'feedback' && (
            <>
              <div className="feedback-split">
                <div>
                  <div className="label-mono">你的答案</div>
                  <p className={`feedback-prose${answer.trim() ? '' : ' muted'}`}>
                    {answer.trim() || '（空）'}
                  </p>
                </div>
                <div>
                  <div className="label-mono">参考答案</div>
                  <p className={`feedback-prose${current.reference_md ? '' : ' muted'}`}>
                    {current.reference_md ?? '（无）'}
                  </p>
                </div>
              </div>

              <div className="cause-row">
                <span className="label-mono">归因</span>
                <CauseBadge
                  cause={
                    cause
                      ? {
                          actor_kind: cause.source === 'user' ? 'user' : 'agent',
                          primary: cause.primary_category,
                          secondary: cause.secondary_categories ?? [],
                          confidence: cause.confidence ?? null,
                        }
                      : null
                  }
                />
                {!cause && <span className="label-mono">暂无归因记录</span>}
              </div>

              <div className="rating-row">
                {(['again', 'hard', 'good', 'easy'] as Rating[]).map((r) => (
                  <button
                    type="button"
                    key={r}
                    className={`btn-rating ${RATING_CLASS[r]}`}
                    onClick={() => handleRate(r)}
                    disabled={submitM.isPending}
                  >
                    <span>{RATING_LABELS[r]}</span>
                    <kbd>{RATING_KEY[r]}</kbd>
                  </button>
                ))}
              </div>
              {submitM.isError && (
                <p className="empty" style={{ color: 'var(--again-ink)' }}>
                  提交失败：{(submitM.error as Error).message}
                </p>
              )}
            </>
          )}
        </section>
      )}
    </main>
  );
}
