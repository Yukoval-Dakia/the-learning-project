'use client';

import {
  type ReviewRatingCounts,
  ReviewSessionRibbon,
  SessionEndSummary,
} from '@/ui/components/ReviewSessionChrome';
import { ApiAuthError, apiJson } from '@/ui/lib/api';
import {
  type SlimSubjectProfile,
  resolveSubjectRenderModel,
  subjectContentProps,
} from '@/ui/lib/subject';
import { Badge, type BadgeTone } from '@/ui/primitives/Badge';
import { CauseBadge } from '@/ui/primitives/CauseBadge';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

type CauseCategory =
  | 'concept'
  | 'knowledge_gap'
  | 'calculation'
  | 'reading'
  | 'memory'
  | 'expression'
  | 'method'
  | 'carelessness'
  | 'time_pressure'
  | 'other';

interface PlanQueueItem {
  question_id: string;
  prompt_md: string;
  reference_md: string | null;
  knowledge_ids: string[];
  fsrs_state: unknown;
  cause: CauseCategory | null;
  priority: 1 | 2 | 3 | 4 | 5;
  rationale: string;
  last_failure_at: number | null;
  subject_profile: SlimSubjectProfile;
}

interface ReviewPlan {
  queue: PlanQueueItem[];
  session_intent: string | null;
  window: { computed_at: number; limit: number };
}

type Phase = 'answering' | 'feedback';
type Rating = 'again' | 'hard' | 'good';

const RATING_LABELS: Record<Rating, string> = {
  again: '不会',
  hard: '模糊',
  good: '会了',
};

const RATING_CLASS: Record<Rating, string> = {
  again: 'again',
  hard: 'hard',
  good: 'good',
};

const RATING_KEY: Record<Rating, string> = {
  again: '1',
  hard: '2',
  good: '3',
};

const PRIORITY_TONE: Record<1 | 2 | 3 | 4 | 5, BadgeTone> = {
  5: 'coral',
  4: 'hard',
  3: 'info',
  2: 'neutral',
  1: 'neutral',
};

const PRIORITY_LABEL: Record<1 | 2 | 3 | 4 | 5, string> = {
  5: 'P5 · 最优先',
  4: 'P4 · 优先',
  3: 'P3 · 常规',
  2: 'P2 · 弱',
  1: 'P1 · 弱',
};

export default function ReviewPage() {
  const qc = useQueryClient();

  // ADR-0013 — open a learning_session(type='review') on mount; close on
  // pagehide via sendBeacon (so it survives tab close).
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [sessionStatus, setSessionStatus] = useState<'started' | 'completed'>('started');
  const sessionClosedRef = useRef(false);
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
        setSessionStartedAt(Date.now());
      } catch {
        // Session couldn't be opened — review still works without one.
      }
    })();
    const onPageHide = () => {
      if (!createdId || sessionClosedRef.current) return;
      sessionClosedRef.current = true;
      const body = new Blob([JSON.stringify({ status: 'completed' })], {
        type: 'application/json',
      });
      navigator.sendBeacon(`/api/review/sessions/${createdId}/end`, body);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      cancelled = true;
      window.removeEventListener('pagehide', onPageHide);
      if (createdId && !sessionClosedRef.current) {
        sessionClosedRef.current = true;
        void apiJson(`/api/review/sessions/${createdId}/end`, {
          method: 'POST',
          body: JSON.stringify({ status: 'completed' }),
        }).catch(() => {});
      }
    };
  }, []);

  // Phase 2A — Review Orchestrator. Two fetches so the queue can render in
  // ~50ms while the LLM session_intent (mimo, ~15-20s) loads in the background.
  // `?intent=skip` short-circuits the LLM call inside the orchestrator.
  const planQ = useQuery({
    queryKey: ['review-plan'],
    queryFn: () => apiJson<ReviewPlan>('/api/review/plan?limit=50&intent=skip'),
  });
  const intentQ = useQuery({
    queryKey: ['review-intent'],
    queryFn: () => apiJson<ReviewPlan>('/api/review/plan?limit=50').then((p) => p.session_intent),
    // Only chase the intent once the queue exists + is non-empty.
    enabled: !!planQ.data && (planQ.data.queue?.length ?? 0) > 0,
    staleTime: 1000 * 60 * 5,
  });

  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>('answering');
  const [answer, setAnswer] = useState('');
  const [showRef, setShowRef] = useState(false);
  const [ratingCounts, setRatingCounts] = useState<ReviewRatingCounts>({
    again: 0,
    hard: 0,
    good: 0,
  });
  const [knowledgeTouched, setKnowledgeTouched] = useState<string[]>([]);

  const rows = planQ.data?.queue ?? [];
  const total = rows.length;
  const current = rows[index];
  const isDone = total > 0 && index >= total;
  const intent = intentQ.data ?? planQ.data?.session_intent ?? null;

  // Per-question wall-clock timer. Reset every time we land on a new question
  // (index changes OR the queue loads for the first time). Posted as
  // `latency_ms` to /api/review/submit which writes it to event.payload.duration_ms.
  // useRef → no re-render churn while the user reads + types.
  const questionShownAtRef = useRef<number>(Date.now());
  useEffect(() => {
    if (current) questionShownAtRef.current = Date.now();
  }, [current]);

  const submitM = useMutation({
    mutationFn: (rating: Rating) => {
      if (!current) throw new Error('no current question');
      const latencyMs = Math.max(0, Date.now() - questionShownAtRef.current);
      return apiJson<{ next_due_at: number }>('/api/review/submit', {
        method: 'POST',
        body: JSON.stringify({
          mistake_id: current.question_id,
          rating,
          response_md: answer || null,
          session_id: sessionId,
          latency_ms: latencyMs,
          referenced_knowledge_ids: current.knowledge_ids,
        }),
      });
    },
    onSuccess: (_data, rating) => {
      setRatingCounts((counts) => ({ ...counts, [rating]: counts[rating] + 1 }));
      setKnowledgeTouched((prev) => {
        const next = new Set(prev);
        for (const kid of current?.knowledge_ids ?? []) next.add(kid);
        return [...next];
      });
      setIndex((i) => i + 1);
      setPhase('answering');
      setAnswer('');
      setShowRef(false);
      qc.invalidateQueries({ queryKey: ['review-plan'] });
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, submitM.isPending, handleReveal, handleRate]);

  const cause = current?.cause ?? null;
  const currentSubjectModel = resolveSubjectRenderModel(current?.subject_profile ?? null);
  const qbodyProps = subjectContentProps(currentSubjectModel, { className: 'qbody' });
  const answerInputProps = subjectContentProps(currentSubjectModel);
  const refTextProps = subjectContentProps(currentSubjectModel, { className: 'ref-text' });
  const reviewedCount = Math.min(index, total);
  const session = sessionId
    ? { id: sessionId, status: isDone ? 'completed' : sessionStatus, started_at: sessionStartedAt }
    : null;

  useEffect(() => {
    if (!isDone || !sessionId || sessionClosedRef.current) return;
    sessionClosedRef.current = true;
    setSessionStatus('completed');
    void apiJson(`/api/review/sessions/${sessionId}/end`, {
      method: 'POST',
      body: JSON.stringify({ status: 'completed' }),
    }).catch(() => {});
  }, [isDone, sessionId]);

  const eyebrow =
    total > 0 && !isDone
      ? `REVIEW · session=${sessionId ?? '—'} · ${Math.min(index + 1, total)} / ${total}`
      : 'REVIEW';

  return (
    <main className="page prose">
      <PageHeader
        title="复习"
        eyebrow={eyebrow}
        sub="按下 1 / 2 / 3 写一条 action=review 事件，FSRS 状态投影表同事务更新。"
      />

      {intent && (
        <div className="review-intent" aria-label="session intent">
          {intent}
        </div>
      )}

      <ReviewSessionRibbon session={session} reviewedCount={reviewedCount} totalCount={total} />

      {planQ.isLoading && (
        <section className="review-stage">
          <p className="empty">正在加载复习队列…</p>
        </section>
      )}

      {planQ.isError && (
        <section className="review-stage">
          <p className="empty" style={{ color: 'var(--again-ink)' }}>
            {planQ.error instanceof ApiAuthError
              ? `${planQ.error.message} — 请重新进入页面输入 token`
              : `加载失败：${(planQ.error as Error).message}`}
          </p>
        </section>
      )}

      {planQ.isSuccess && total === 0 && (
        <section className="review-stage">
          <p className="empty">今天没有要复习的，太好了。</p>
        </section>
      )}

      {planQ.isSuccess && isDone && (
        <SessionEndSummary
          session={session}
          reviewedCount={total}
          ratings={ratingCounts}
          durationSec={
            sessionStartedAt ? Math.max(0, Math.floor((Date.now() - sessionStartedAt) / 1000)) : 0
          }
          knowledgeTouched={knowledgeTouched}
        />
      )}

      {current && !isDone && (
        <section className="review-stage">
          <div className="progress">
            <span>
              {index + 1} / {total} · FSRS
              {` · ${currentSubjectModel.displayName}`}
              {current.knowledge_ids[0] && ` · ${current.knowledge_ids[0]}`}
            </span>
            <span>{cause && `上次归因 ${cause}`}</span>
          </div>

          <div className="review-card-meta">
            <Badge tone={PRIORITY_TONE[current.priority]}>{PRIORITY_LABEL[current.priority]}</Badge>
            <span className="rationale">{current.rationale}</span>
          </div>

          <div {...qbodyProps}>{current.prompt_md}</div>

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
                {...answerInputProps}
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
                <div {...refTextProps}>{current.reference_md ?? '(无)'}</div>
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
                  <p
                    {...subjectContentProps(currentSubjectModel, {
                      className: `feedback-prose${answer.trim() ? '' : ' muted'}`,
                    })}
                  >
                    {answer.trim() || '（空）'}
                  </p>
                </div>
                <div>
                  <div className="label-mono">参考答案</div>
                  <p
                    {...subjectContentProps(currentSubjectModel, {
                      className: `feedback-prose${current.reference_md ? '' : ' muted'}`,
                    })}
                  >
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
                          actor_kind: 'agent',
                          primary: cause,
                          secondary: [],
                          confidence: null,
                        }
                      : null
                  }
                />
                {!cause && <span className="label-mono">暂无归因记录</span>}
              </div>

              <div className="rating-row">
                {(['again', 'hard', 'good'] as Rating[]).map((r) => (
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
