'use client';

import type { JudgeResultV2T } from '@/core/schema/capability';
import { JudgeResultPanel } from '@/ui/components/JudgeResultPanel';
import {
  type ReviewRatingCounts,
  ReviewSessionRibbon,
  SessionEndSummary,
} from '@/ui/components/ReviewSessionChrome';
import {
  CorrectionStateRenderer,
  type CorrectionStateSnapshot,
} from '@/ui/correction/CorrectionStateRenderer';
import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import {
  type SlimSubjectProfile,
  resolveSubjectRenderModel,
  subjectContentProps,
} from '@/ui/lib/subject';
import { Badge, type BadgeTone } from '@/ui/primitives/Badge';
import { Button } from '@/ui/primitives/Button';
import { CauseBadge } from '@/ui/primitives/CauseBadge';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
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

type ActivityRef = {
  kind:
    | 'question'
    | 'question_part'
    | 'record'
    | 'recall_prompt'
    | 'practice_log'
    | 'project_milestone'
    | 'open_inquiry';
  id: string;
};

interface PlanQueueItem {
  activity_ref: ActivityRef;
  question_id: string;
  prompt_md: string;
  reference_md: string | null;
  knowledge_ids: string[];
  fsrs_state: unknown;
  cause: CauseCategory | null;
  priority: 1 | 2 | 3 | 4 | 5;
  rationale: string;
  last_failure_at: number | null;
  last_failure_event: { id: string; correction_state: CorrectionStateSnapshot } | null;
  subject_profile: SlimSubjectProfile;
}

interface ReviewPlan {
  queue: PlanQueueItem[];
  session_intent: string | null;
  window: { computed_at: number; limit: number };
}

type Phase = 'answering' | 'feedback';
type Rating = 'again' | 'hard' | 'good';

// YUK-56 — server-returned judge metadata. Mirrors the `judge` field on
// `POST /api/review/submit`'s response shape (route.ts JudgeResponse).
interface SubmitJudgeResponse {
  route: string;
  score: number | null;
  coarse_outcome: 'correct' | 'partial' | 'incorrect' | 'unsupported';
  confidence: number;
  feedback_md: string;
  evidence_json: Record<string, unknown>;
  capability_ref: { id: string; version: string };
  suggested_rating: Rating | null;
  auto_rated: boolean;
}

interface SubmitResponse {
  next_due_at: number;
  judge?: SubmitJudgeResponse | null;
}

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
  const searchParams = useSearchParams();
  const resumeIdParam = searchParams.get('session');

  // ADR-0013 — open a learning_session(type='review') on mount; close on
  // pagehide via sendBeacon (so it survives tab close).
  //
  // YUK-57: status union extended with 'paused'. sessionStatusRef mirrors the
  // React state so the pagehide listener (called from a closure) reads the
  // latest status synchronously — without the ref, paused sessions would
  // incorrectly fire a completion beacon on tab close.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [sessionStatus, setSessionStatus] = useState<'started' | 'paused' | 'completed'>('started');
  const sessionStatusRef = useRef<'started' | 'paused' | 'completed'>('started');
  const updateStatus = useCallback((next: 'started' | 'paused' | 'completed') => {
    sessionStatusRef.current = next;
    setSessionStatus(next);
  }, []);
  const sessionClosedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    let createdId: string | null = null;
    (async () => {
      // YUK-57: ?session=<id> resume path. Verify the session exists + is in
      // paused state before adopting it; otherwise fall through to eager-create.
      if (resumeIdParam) {
        try {
          const existing = await apiJson<{ id: string; type: string; status: string }>(
            `/api/learning-sessions/${resumeIdParam}`,
          );
          if (existing.type === 'review' && existing.status === 'paused') {
            await apiJson(`/api/review/sessions/${resumeIdParam}/resume`, { method: 'POST' });
            if (cancelled) return;
            createdId = resumeIdParam;
            setSessionId(resumeIdParam);
            setSessionStartedAt(Date.now());
            updateStatus('started');
            return;
          }
          // type=review but status != paused (already completed/abandoned, or
          // currently started in another tab). Fall through to fresh session.
        } catch {
          // 404 / unauthorised / network — fall through to fresh session.
        }
      }
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
        updateStatus('started');
      } catch {
        // Session couldn't be opened — review still works without one.
      }
    })();
    const onPageHide = () => {
      if (!createdId || sessionClosedRef.current) return;
      // YUK-57: do NOT fire the completion beacon when the session is paused.
      // The user explicitly stepped away; the orphan cron (6h) decides when
      // it counts as abandoned. Without this guard, closing a tab on a paused
      // session would silently complete it (PR #122 stale issue).
      if (sessionStatusRef.current === 'paused') return;
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
      // Skip the explicit close call when paused — same reasoning as the
      // pagehide guard above.
      if (createdId && !sessionClosedRef.current && sessionStatusRef.current !== 'paused') {
        sessionClosedRef.current = true;
        void apiJson(`/api/review/sessions/${createdId}/end`, {
          method: 'POST',
          body: JSON.stringify({ status: 'completed' }),
        }).catch(() => {});
      }
    };
  }, [resumeIdParam, updateStatus]);

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
  // YUK-56 — preview judge result for the *current* question. Set after a
  // submit returns judge != null; cleared when the next question loads. Used
  // both to show the JudgeResultPanel briefly before advance AND to surface
  // "judge couldn't auto-rate, rate manually" when auto_rate returns 422.
  const [lastJudge, setLastJudge] = useState<SubmitJudgeResponse | null>(null);
  const [autoRateError, setAutoRateError] = useState<string | null>(null);

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

  // YUK-56 — submit accepts both manual ratings (auto_rate=false; server still
  // runs judge for telemetry + suggestion) and "自动判分" mode (auto_rate=true;
  // server's suggested rating is the final rating). On 422 unsupported, surface
  // a message + keep the user in feedback phase so they can rate manually.
  const submitM = useMutation({
    mutationFn: async (input: { rating: Rating; autoRate: boolean }) => {
      if (!current) throw new Error('no current question');
      const latencyMs = Math.max(0, Date.now() - questionShownAtRef.current);
      return await apiJson<SubmitResponse>('/api/review/submit', {
        method: 'POST',
        body: JSON.stringify({
          activity_ref: current.activity_ref,
          rating: input.rating,
          response_md: answer || null,
          session_id: sessionId,
          latency_ms: latencyMs,
          referenced_knowledge_ids: current.knowledge_ids,
          auto_rate: input.autoRate,
        }),
      });
    },
    onSuccess: (data, input) => {
      // YUK-56 — final rating may differ from input.rating when auto_rate=true.
      // Trust the server's judge.suggested_rating if present; otherwise fall
      // back to the request rating.
      const finalRating: Rating =
        input.autoRate && data.judge?.suggested_rating ? data.judge.suggested_rating : input.rating;
      setRatingCounts((counts) => ({ ...counts, [finalRating]: counts[finalRating] + 1 }));
      setKnowledgeTouched((prev) => {
        const next = new Set(prev);
        for (const kid of current?.knowledge_ids ?? []) next.add(kid);
        return [...next];
      });
      setLastJudge(data.judge ?? null);
      setAutoRateError(null);
      // YUK-56 — auto_rate path: don't auto-advance. User needs to see the
      // judge result + reasoning before moving on (it's the basis for the
      // rating they didn't pick). They press "下一题" / Enter to advance.
      //
      // Manual rating path: auto-advance as before (existing UX). The
      // judge result is informational and gets cleared by the index-change
      // useEffect.
      if (input.autoRate && data.judge) {
        setPhase('feedback');
        // Stay on current question; UI shows JudgeResultPanel + "下一题".
      } else {
        setIndex((i) => i + 1);
        setPhase('answering');
        setAnswer('');
        setShowRef(false);
      }
      qc.invalidateQueries({ queryKey: ['review-plan'] });
    },
    onError: (err) => {
      // YUK-56 — 422 unsupported_judge_route in auto_rate mode: keep the user
      // in feedback phase so they can rate manually. Distinguished by message
      // shape (errorResponse() formats as `${error}: ${message}`).
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('unsupported_judge_route')) {
        setAutoRateError('无法自动判分，请手动评分');
      }
    },
  });

  const handleReveal = useCallback(() => {
    if (phase === 'answering' && current) setPhase('feedback');
  }, [phase, current]);

  const handleRate = useCallback(
    (r: Rating) => {
      if (phase !== 'feedback' || submitM.isPending) return;
      submitM.mutate({ rating: r, autoRate: false });
    },
    [phase, submitM],
  );

  // YUK-56 — "自动判分" CTA: server runs judge + uses suggested rating as final.
  // Sends rating='good' as placeholder (server ignores it under auto_rate=true).
  const handleAutoRate = useCallback(() => {
    if (phase !== 'feedback' || submitM.isPending) return;
    setAutoRateError(null);
    submitM.mutate({ rating: 'good', autoRate: true });
  }, [phase, submitM]);

  // YUK-56 — after auto-rate save, user presses Enter / clicks "下一题" to
  // advance. Mutation already committed the review; this is pure UI navigation.
  const handleNext = useCallback(() => {
    setIndex((i) => i + 1);
    setPhase('answering');
    setAnswer('');
    setShowRef(false);
    setLastJudge(null);
    setAutoRateError(null);
  }, []);

  // YUK-57 — Skip: pure UI state advance. Does NOT call /api/review/submit, so
  // no event row is written and FSRS state is untouched. Semantics: "I don't
  // know but don't want to mark fail". User can still come back to the
  // question later if it's due again per the existing scheduler.
  const handleSkip = useCallback(() => {
    if (!current || submitM.isPending) return;
    setIndex((i) => i + 1);
    setPhase('answering');
    setAnswer('');
    setShowRef(false);
    setLastJudge(null);
    setAutoRateError(null);
  }, [current, submitM.isPending]);

  // YUK-57 — Pause: started -> paused. Suppresses the pagehide completion
  // beacon (via sessionStatusRef). The session stays in paused state until
  // user resumes, sendBeacon-completes via abandon button, or orphan cron
  // hits the 6h cutoff.
  const pauseM = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error('no session');
      await apiJson(`/api/review/sessions/${sessionId}/pause`, { method: 'POST' });
    },
    onSuccess: () => {
      updateStatus('paused');
    },
  });

  // YUK-57 — Resume: paused -> started. Re-enables the pagehide completion
  // beacon path.
  const resumeM = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error('no session');
      await apiJson(`/api/review/sessions/${sessionId}/resume`, { method: 'POST' });
    },
    onSuccess: () => {
      updateStatus('started');
    },
  });

  // YUK-56 — clear judge preview + auto-rate error when the next question loads
  // so we don't carry stale state into the next attempt. `index` is the trigger;
  // biome's exhaustive-deps doesn't see the index-as-trigger pattern.
  // biome-ignore lint/correctness/useExhaustiveDependencies: index drives this effect, setters are stable
  useEffect(() => {
    setLastJudge(null);
    setAutoRateError(null);
  }, [index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // YUK-57 — don't intercept keystrokes inside text inputs / textareas.
      // (`s` / `p` would otherwise stop users from typing those letters in
      // their answer.)
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isTyping =
        tag === 'INPUT' || tag === 'TEXTAREA' || (target?.isContentEditable ?? false);

      if (phase === 'answering' && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleReveal();
        return;
      }
      // YUK-57 — 's' to skip the current question (answering phase only).
      if (phase === 'answering' && !isTyping && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        handleSkip();
        return;
      }
      if (phase === 'feedback' && !submitM.isPending) {
        // YUK-56 — when judge result is shown after auto-rate, Enter advances.
        // (Avoid eating Enter when typing in an answer; phase guard handles it.)
        if (lastJudge && e.key === 'Enter') {
          e.preventDefault();
          handleNext();
          return;
        }
        if (e.key === '1') handleRate('again');
        else if (e.key === '2') handleRate('hard');
        else if (e.key === '3') handleRate('good');
        // YUK-56 — "a" / "A" key triggers auto-judge (mnemonic: auto)
        else if (e.key === 'a' || e.key === 'A') handleAutoRate();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    phase,
    submitM.isPending,
    lastJudge,
    handleReveal,
    handleRate,
    handleAutoRate,
    handleNext,
    handleSkip,
  ]);

  const cause = current?.cause ?? null;
  const currentSubjectModel = resolveSubjectRenderModel(current?.subject_profile ?? null);
  const qbodyProps = subjectContentProps(currentSubjectModel, { className: 'qbody' });
  const answerInputProps = subjectContentProps(currentSubjectModel);
  const refTextProps = subjectContentProps(currentSubjectModel, { className: 'ref-text' });
  const reviewedCount = Math.min(index, total);
  // YUK-57 — paused takes precedence over isDone in the ribbon so the user
  // sees the explicit pause state rather than auto-flipping to "completed".
  const ribbonStatus: string =
    sessionStatus === 'paused' ? 'paused' : isDone ? 'completed' : sessionStatus;
  const session = sessionId
    ? { id: sessionId, status: ribbonStatus, started_at: sessionStartedAt }
    : null;
  const isPaused = sessionStatus === 'paused';

  useEffect(() => {
    // YUK-57 — don't auto-complete from paused (user may resume, finish or
    // re-pause; queue exhaustion isn't a meaningful signal while paused).
    if (!isDone || !sessionId || sessionClosedRef.current || isPaused) return;
    sessionClosedRef.current = true;
    updateStatus('completed');
    void apiJson(`/api/review/sessions/${sessionId}/end`, {
      method: 'POST',
      body: JSON.stringify({ status: 'completed' }),
    }).catch(() => {});
  }, [isDone, sessionId, isPaused, updateStatus]);

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

      {/* YUK-57 — paused overlay. Hides the question/feedback view so the
         user explicitly chooses to resume; ?session= URL param is the
         alternate path that auto-resumes on next visit. */}
      {isPaused && (
        <section className="review-stage" aria-label="paused">
          <p className="empty">
            ⏸ Session 已暂停。继续刷题点下面恢复，或者直接离开 — cron 6h 兜底。
          </p>
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 'var(--s-2)' }}>
            <Button variant="primary" onClick={() => resumeM.mutate()} disabled={resumeM.isPending}>
              继续刷题
            </Button>
          </div>
        </section>
      )}

      {!isPaused && planQ.isLoading && (
        <section className="review-stage">
          <p className="empty">正在加载复习队列…</p>
        </section>
      )}

      {!isPaused && planQ.isError && (
        <section className="review-stage">
          <p className="empty" style={{ color: 'var(--again-ink)' }}>
            {planQ.error instanceof ApiAuthError
              ? `${planQ.error.message} — 请重新进入页面输入 token`
              : `加载失败：${(planQ.error as Error).message}`}
          </p>
        </section>
      )}

      {!isPaused && planQ.isSuccess && total === 0 && (
        <section className="review-stage">
          <p className="empty">今天没有要复习的，太好了。</p>
        </section>
      )}

      {!isPaused && planQ.isSuccess && isDone && (
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

      {!isPaused && current && !isDone && (
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
            <CorrectionStateRenderer state={current.last_failure_event?.correction_state} compact />
            {/* YUK-57 — Pause button. Lives in the card meta row so it's
               always reachable regardless of phase. Disabled when there's
               no session row to pause against (rare; e.g. eager-create
               failed). */}
            <span style={{ marginLeft: 'auto' }}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => pauseM.mutate()}
                disabled={!sessionId || pauseM.isPending}
                title="暂停 session（已答题进度保留）"
              >
                暂停
              </Button>
            </span>
          </div>

          <MathMarkdown
            notation={
              (currentSubjectModel.renderConfig.notation ?? undefined) as
                | 'latex'
                | 'wenyan'
                | 'plaintext'
                | 'code'
                | undefined
            }
            {...qbodyProps}
          >
            {current.prompt_md}
          </MathMarkdown>

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
                {current.reference_md ? (
                  <MathMarkdown
                    notation={
                      (currentSubjectModel.renderConfig.notation ?? undefined) as
                        | 'latex'
                        | 'wenyan'
                        | 'plaintext'
                        | 'code'
                        | undefined
                    }
                    {...refTextProps}
                  >
                    {current.reference_md}
                  </MathMarkdown>
                ) : (
                  <div {...refTextProps}>(无)</div>
                )}
              </details>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 'var(--s-2)',
                  alignItems: 'center',
                }}
              >
                {/* YUK-57 — Skip button. Pure UI advance (no submit / no
                   FSRS write). Mnemonic: 's' key shortcut. */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleSkip}
                  disabled={!current || submitM.isPending}
                  title="跳过这道题（不记录、不影响 FSRS）"
                >
                  跳过
                </Button>
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
                  {current.reference_md ? (
                    <MathMarkdown
                      notation={
                        (currentSubjectModel.renderConfig.notation ?? undefined) as
                          | 'latex'
                          | 'wenyan'
                          | 'plaintext'
                          | 'code'
                          | undefined
                      }
                      {...subjectContentProps(currentSubjectModel, {
                        className: 'feedback-prose',
                      })}
                    >
                      {current.reference_md}
                    </MathMarkdown>
                  ) : (
                    <p
                      {...subjectContentProps(currentSubjectModel, {
                        className: 'feedback-prose muted',
                      })}
                    >
                      （无）
                    </p>
                  )}
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

              {/* YUK-56 — judge result panel + auto-rate feedback. Mounts:
                 - whenever a previous submit returned judge != null (manual rating: shown briefly until index changes; auto-rate: shown until 下一题).
                 - explicit unsupported message when auto-rate returned 422. */}
              {lastJudge && (
                <JudgeResultPanel
                  result={
                    {
                      score: lastJudge.score,
                      score_meaning: 'correctness',
                      coarse_outcome: lastJudge.coarse_outcome,
                      confidence: lastJudge.confidence,
                      capability_ref: lastJudge.capability_ref,
                      feedback_md: lastJudge.feedback_md,
                      evidence_json: lastJudge.evidence_json,
                    } as JudgeResultV2T
                  }
                  expectedSignals={[]}
                  appealable={false}
                  notation={
                    (currentSubjectModel.renderConfig.notation ?? undefined) as
                      | 'latex'
                      | 'wenyan'
                      | 'plaintext'
                      | 'code'
                      | undefined
                  }
                />
              )}
              {autoRateError && (
                <p className="empty" style={{ color: 'var(--again-ink)' }}>
                  {autoRateError}
                </p>
              )}

              <div className="rating-row">
                {/* YUK-56 — "自动判分" CTA. Disabled after a successful auto-rate
                   (lastJudge from auto path) — UI is in "下一题" state.
                   Disabled when no answer typed (judge can't run). */}
                <button
                  type="button"
                  className="btn-rating coral"
                  onClick={handleAutoRate}
                  disabled={submitM.isPending || !answer.trim() || lastJudge !== null}
                  title={
                    answer.trim()
                      ? '让 AI 判分（exact / keyword 本地秒回；semantic 走 LLM）'
                      : '需要先填答案才能自动判分'
                  }
                >
                  <span>自动判分</span>
                  <kbd>A</kbd>
                </button>
                {(['again', 'hard', 'good'] as Rating[]).map((r) => {
                  const isSuggested = lastJudge?.suggested_rating === r;
                  return (
                    <button
                      type="button"
                      key={r}
                      className={`btn-rating ${RATING_CLASS[r]}`}
                      onClick={() => handleRate(r)}
                      disabled={submitM.isPending || lastJudge !== null}
                      // YUK-56 — soft hint: outline the rating the judge suggested
                      style={
                        isSuggested
                          ? { boxShadow: '0 0 0 2px var(--info-ink)', position: 'relative' }
                          : undefined
                      }
                      title={isSuggested ? 'AI 建议此评分' : undefined}
                    >
                      <span>{RATING_LABELS[r]}</span>
                      <kbd>{RATING_KEY[r]}</kbd>
                    </button>
                  );
                })}
              </div>

              {/* YUK-56 — after auto-rate save, "下一题" CTA replaces rating row UX. */}
              {lastJudge && (
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="button" className="btn-rating good" onClick={handleNext}>
                    <span>下一题</span>
                    <kbd>↵</kbd>
                  </button>
                </div>
              )}

              {submitM.isError && !autoRateError && (
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
