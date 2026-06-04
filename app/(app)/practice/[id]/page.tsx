'use client';

// /practice/[id] — 做卷答题页 (paper answering page).
// Design authority: docs/superpowers/plans/2026-06-05-u5-paper-model.md §5.
// Markup uses production CSS classes only (review-stage, answer-compose,
// feedback-split, feedback-prose, label-mono, qbody, etc.) — no phantom
// class names. Practice-specific chrome (session bar, paper progress bar)
// uses .practice-loom scoped rules appended in globals.css.
//
// session.type is always 'review' (RL1). No `type='paper'` string ships here.
//
// Answering flow (per orchestrator ruling §4.10 Q8-addendum):
//   1. GET /api/practice/[id] → paper detail (sections + slots + question faces)
//   2. If paper.session === null → POST /api/practice { artifact_id } → session_id
//   3. Re-GET /api/practice/[id] to pick up draft state
//   4. Render slots in section order; active slot = first unsubmitted
//   5. User types → autosave (debounce 500 ms, POST /api/practice/[id]/answer)
//   6. User submits → POST /api/practice/[id]/submit
//   7. submission.visible_to_user:true  → show outcome + feedback
//      submission.visible_to_user:false → show "反馈已缓冲" placeholder
//   8. All slots submitted → end session (completed) → re-GET → reveal all buffered
//
// Session lifecycle mirrors review/page.tsx (ADR-0013):
//   - pagehide → sendBeacon completed (unless paused)
//   - pause/resume via /api/review/sessions/[id]/{pause,resume}

import type { PaperDetailResult, PaperDetailSlot } from '@/server/review/paper-detail';
import { apiJson } from '@/ui/lib/api';
import { Btn } from '@/ui/primitives/Btn';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SkLines } from '@/ui/primitives/SkLines';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

// ── slot display state ────────────────────────────────────────────────────────

type SlotPhase = 'answering' | 'feedback';

interface SlotLocalState {
  answer: string;
  phase: SlotPhase;
  // result echoed from the submit response (visible slots only)
  submitResult: SubmitResult | null;
  autosavePending: boolean;
}

interface SubmitResult {
  visible_to_user: boolean;
  coarse_outcome: string | null;
  // score is [0,1]; multiply by 100 for display as percentage
  score: number | null;
  feedback_buffered?: boolean;
}

// ── outcome display helpers ───────────────────────────────────────────────────

const OUTCOME_LABEL: Record<string, string> = {
  correct: '完整正确',
  partial: '部分正确',
  incorrect: '错误',
  unsupported: '无法判分',
  unknown: '—',
};

const OUTCOME_TONE: Record<string, string> = {
  correct: 'tone-good',
  partial: 'tone-hard',
  incorrect: 'tone-coral',
  unsupported: 'tone-neutral',
  unknown: 'tone-neutral',
};

// ── component ────────────────────────────────────────────────────────────────

export default function PracticeAnswerPage() {
  const { id: artifactId } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();

  // ── session lifecycle (same pattern as review/page.tsx, ADR-0013) ──────────
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<'started' | 'paused' | 'completed'>('started');
  const sessionStatusRef = useRef<'started' | 'paused' | 'completed'>('started');
  const sessionClosedRef = useRef(false);

  const updateStatus = useCallback((next: 'started' | 'paused' | 'completed') => {
    sessionStatusRef.current = next;
    setSessionStatus(next);
  }, []);

  // ── load paper detail (with session + draft state) ─────────────────────────
  const detailQ = useQuery({
    queryKey: ['practice-detail', artifactId],
    queryFn: () => apiJson<PaperDetailResult>(`/api/practice/${artifactId}`),
    // refetch after session start so draft state reflects the linked session
    refetchOnWindowFocus: false,
  });

  const paper = detailQ.data;

  // ── start session if not already linked ────────────────────────────────────
  const [startingSession, setStartingSession] = useState(false);
  const startedRef = useRef(false); // prevent double-start in React StrictMode

  useEffect(() => {
    if (!paper || startedRef.current) return;
    if (paper.session) {
      // adopt the existing session
      setSessionId(paper.session.id);
      const st = paper.session.status;
      const mapped: 'started' | 'paused' | 'completed' =
        st === 'completed' ? 'completed' : st === 'paused' ? 'paused' : 'started';
      updateStatus(mapped);
      startedRef.current = true;
      return;
    }
    // start a new session
    startedRef.current = true;
    setStartingSession(true);
    apiJson<{ session_id: string }>('/api/practice', {
      method: 'POST',
      body: JSON.stringify({ artifact_id: artifactId }),
    })
      .then((data) => {
        setSessionId(data.session_id);
        updateStatus('started');
        setStartingSession(false);
        // re-fetch to pick up draft state with the new session
        void qc.invalidateQueries({ queryKey: ['practice-detail', artifactId] });
      })
      .catch(() => {
        setStartingSession(false);
      });
  }, [paper, artifactId, updateStatus, qc]);

  // ── pagehide beacon (same as review/page.tsx) ──────────────────────────────
  useEffect(() => {
    const sid = sessionId;
    if (!sid) return;
    const onPageHide = () => {
      if (sessionClosedRef.current) return;
      if (sessionStatusRef.current === 'paused') return;
      sessionClosedRef.current = true;
      const body = new Blob([JSON.stringify({ status: 'completed' })], {
        type: 'application/json',
      });
      navigator.sendBeacon(`/api/review/sessions/${sid}/end`, body);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      if (sid && !sessionClosedRef.current && sessionStatusRef.current !== 'paused') {
        sessionClosedRef.current = true;
        void apiJson(`/api/review/sessions/${sid}/end`, {
          method: 'POST',
          body: JSON.stringify({ status: 'completed' }),
        }).catch(() => {});
      }
    };
  }, [sessionId]);

  // ── pause / resume mutations ───────────────────────────────────────────────
  const pauseM = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error('no session');
      await apiJson(`/api/review/sessions/${sessionId}/pause`, { method: 'POST' });
    },
    onSuccess: () => updateStatus('paused'),
  });

  const resumeM = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error('no session');
      await apiJson(`/api/review/sessions/${sessionId}/resume`, { method: 'POST' });
    },
    onSuccess: () => updateStatus('started'),
  });

  // ── slots + local state ────────────────────────────────────────────────────
  const allSlots: PaperDetailSlot[] = (paper?.sections ?? []).flatMap((s) => s.slots);
  const totalSlots = allSlots.length;

  // initialise per-slot local state from server-returned slot_state
  const [slotStates, setSlotStates] = useState<Record<string, SlotLocalState>>({});

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — re-init only on paper change, not allSlots identity
  useEffect(() => {
    if (!paper) return;
    setSlotStates((prev) => {
      const next: Record<string, SlotLocalState> = {};
      for (const slot of allSlots) {
        const key = slotKey(slot);
        const existing = prev[key];
        const serverDraft = slot.slot_state.draft;
        const serverSub = slot.slot_state.submission;
        // SHOULD-FIX #2: server visible_to_user:true (revealed after session end)
        // must override stale local buffered result — always prefer server sub when visible.
        const serverResult = serverSubToResult(serverSub);
        const localResult = existing?.submitResult ?? null;
        const mergedResult = serverResult?.visible_to_user
          ? serverResult
          : (localResult ?? serverResult);
        next[key] = {
          answer: existing?.answer ?? serverDraft?.content_md ?? '',
          phase: serverSub ? 'feedback' : (existing?.phase ?? 'answering'),
          submitResult: mergedResult,
          autosavePending: false,
        };
      }
      return next;
    });
  }, [paper]);

  // current active slot = first unsubmitted
  const [activeSlotIdx, setActiveSlotIdx] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — reset to first unsubmitted only on paper load
  useEffect(() => {
    if (allSlots.length === 0) return;
    const firstUnsubmitted = allSlots.findIndex((s) => !slotStates[slotKey(s)]?.submitResult);
    setActiveSlotIdx(firstUnsubmitted >= 0 ? firstUnsubmitted : allSlots.length - 1);
  }, [paper]);

  // count submitted slots
  const submittedCount = allSlots.filter((s) => !!slotStates[slotKey(s)]?.submitResult).length;
  const allDone = totalSlots > 0 && submittedCount >= totalSlots;

  // ── end session when all slots submitted ──────────────────────────────────
  useEffect(() => {
    if (!allDone || !sessionId || sessionClosedRef.current) return;
    if (sessionStatus === 'completed') return; // already ended
    sessionClosedRef.current = true;
    updateStatus('completed');
    void apiJson(`/api/review/sessions/${sessionId}/end`, {
      method: 'POST',
      body: JSON.stringify({ status: 'completed' }),
    })
      .then(() => {
        // refetch to reveal all buffered feedback (§4.9: completed → all visible)
        return qc.invalidateQueries({ queryKey: ['practice-detail', artifactId] });
      })
      .catch(() => {});
  }, [allDone, sessionId, sessionStatus, updateStatus, qc, artifactId]);

  // ── autosave debounce ──────────────────────────────────────────────────────
  const autosaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // SHOULD-FIX #3: cleanup all pending autosave timers on unmount
  useEffect(() => {
    const timers = autosaveTimers.current;
    return () => {
      for (const id of Object.values(timers)) clearTimeout(id);
    };
  }, []);

  function scheduleAutosave(slot: PaperDetailSlot, answer: string) {
    const key = slotKey(slot);
    clearTimeout(autosaveTimers.current[key]);
    autosaveTimers.current[key] = setTimeout(() => {
      if (!sessionId) return;
      void apiJson(`/api/practice/${artifactId}/answer`, {
        method: 'POST',
        body: JSON.stringify({
          session_id: sessionId,
          question_id: slot.question_id,
          part_ref: slot.part_ref ?? null,
          content_md: answer,
        }),
      }).catch(() => {});
      setSlotStates((prev) => ({
        ...prev,
        [key]: { ...prev[key], autosavePending: false },
      }));
    }, 500);
  }

  function handleAnswerChange(slot: PaperDetailSlot, value: string) {
    const key = slotKey(slot);
    setSlotStates((prev) => ({
      ...prev,
      [key]: { ...prev[key], answer: value, autosavePending: true },
    }));
    scheduleAutosave(slot, value);
  }

  // ── per-slot submit ────────────────────────────────────────────────────────
  const submitM = useMutation({
    mutationFn: async ({ slot, answerMd }: { slot: PaperDetailSlot; answerMd: string }) => {
      if (!sessionId) throw new Error('no session');
      return await apiJson<{
        attempt_event_id: string;
        judge_event_id: string;
        answer_id: string;
        visible_to_user: boolean;
        coarse_outcome: string;
        score: number | null;
      }>(`/api/practice/${artifactId}/submit`, {
        method: 'POST',
        body: JSON.stringify({
          session_id: sessionId,
          question_id: slot.question_id,
          part_ref: slot.part_ref ?? null,
          answer_md: answerMd,
        }),
      });
    },
    onSuccess: (data, vars) => {
      const key = slotKey(vars.slot);
      const result: SubmitResult = {
        visible_to_user: data.visible_to_user,
        coarse_outcome: data.coarse_outcome,
        score: data.score ?? null,
        feedback_buffered: !data.visible_to_user,
      };
      setSlotStates((prev) => ({
        ...prev,
        [key]: { ...prev[key], phase: 'feedback', submitResult: result },
      }));
    },
  });

  function handleSubmit(slot: PaperDetailSlot) {
    const key = slotKey(slot);
    // SHOULD-FIX #4: guard against double-submit from Cmd+Enter race
    if (submitM.isPending || slotStates[key]?.submitResult) return;
    const answer = slotStates[key]?.answer ?? '';
    submitM.mutate({ slot, answerMd: answer });
  }

  function handleNext() {
    setActiveSlotIdx((i) => Math.min(i + 1, totalSlots - 1));
  }

  // ── keyboard contract (screen-review.jsx:38-54) ───────────────────────────
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: handleSubmit is stable via closure; intentionally omitted to avoid re-registering listeners on every state tick
  useEffect(() => {
    const activeSlot = allSlots[activeSlotIdx];
    if (!activeSlot) return;
    const key = slotKey(activeSlot);
    const phase = slotStates[key]?.phase ?? 'answering';

    const onKey = (e: KeyboardEvent) => {
      if (sessionStatus === 'paused' || allDone) return;
      const meta = e.ctrlKey || e.metaKey;
      if (phase === 'answering' && meta && e.key === 'Enter') {
        e.preventDefault();
        handleSubmit(activeSlot);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeSlotIdx, slotStates, sessionStatus, allDone, allSlots]);

  // ── render ─────────────────────────────────────────────────────────────────

  const isPaused = sessionStatus === 'paused';

  if (detailQ.isLoading || startingSession) {
    return (
      <div className="page view practice-loom">
        <div
          style={{
            marginTop: 'var(--s-6)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--s-4)',
          }}
        >
          {[1, 2].map((i) => (
            <LoomCard key={i} pad>
              <SkLines rows={3} />
            </LoomCard>
          ))}
        </div>
      </div>
    );
  }

  if (detailQ.isError || !paper) {
    return (
      <div className="page view practice-loom">
        <p className="empty" style={{ color: 'var(--again-ink)' }}>
          {detailQ.isError
            ? `加载失败：${(detailQ.error as Error).message}`
            : `试卷 ${artifactId} 未找到`}
        </p>
      </div>
    );
  }

  const progressPct = totalSlots > 0 ? Math.round((submittedCount / totalSlots) * 100) : 0;

  return (
    <div className="page view practice-loom">
      {/* ── session status bar ─────────────────────────────────────────────── */}
      <div className="paper-session-bar">
        <span className="badge tone-neutral">
          <span className={`dot${isPaused ? '' : ' pulse'}`} />
          {isPaused ? '已暂停' : sessionStatus === 'completed' ? '已完成' : '进行中'}
        </span>
        {sessionId && <span className="mono">{sessionId.slice(0, 8)}…</span>}
        <span className="dot-sep">·</span>
        <span>URL 可恢复</span>
        <span className="topbar-spacer" />
        {isPaused ? (
          <Btn size="sm" variant="primary" icon="review" onClick={() => resumeM.mutate()}>
            恢复
          </Btn>
        ) : sessionStatus !== 'completed' ? (
          <Btn size="sm" variant="ghost" icon="clock" onClick={() => pauseM.mutate()}>
            暂停
          </Btn>
        ) : null}
      </div>

      {/* ── paper-level progress bar ──────────────────────────────────────── */}
      <div className="paper-answering-prog">
        <span className="prog-label tnum">
          {submittedCount}/{totalSlots}
        </span>
        <div className="bar">
          <span style={{ width: `${progressPct}%` }} />
        </div>
        <span className="prog-label">{paper.title}</span>
      </div>

      {/* ── paused overlay ───────────────────────────────────────────────── */}
      {isPaused && (
        <section className="review-stage" aria-label="paused">
          <p className="empty">⏸ Session 已暂停。继续答题点下方恢复。</p>
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 'var(--s-2)' }}>
            <Btn variant="primary" onClick={() => resumeM.mutate()}>
              继续答题
            </Btn>
          </div>
        </section>
      )}

      {/* ── completed summary ─────────────────────────────────────────────── */}
      {!isPaused && allDone && (
        <section className="review-stage">
          <LoomCard pad style={{ maxWidth: 'var(--cap-prose)', margin: '0 auto' }}>
            <span
              className="card-icon accent"
              style={{ margin: '0 auto var(--s-4)', width: 56, height: 56 }}
            >
              <LoomIcon name="checkCircle" size={28} />
            </span>
            <h1 className="page-title serif" style={{ textAlign: 'center' }}>
              整卷作答完成
            </h1>
            <p
              className="page-lead"
              style={{ textAlign: 'center', margin: 'var(--s-3) 0 var(--s-6)' }}
            >
              共 {totalSlots} 题 · {paper.session?.right ?? 0} 对 {paper.session?.wrong ?? 0} 错
              {paper.session && paper.session.right + paper.session.wrong > 0
                ? ` · 正确率 ${Math.round((paper.session.right / (paper.session.right + paper.session.wrong)) * 100)}%`
                : ''}
            </p>
            <div className="hero-cta" style={{ justifyContent: 'center' }}>
              <Btn variant="primary" icon="today" onClick={() => router.push('/today')}>
                回到今日
              </Btn>
              <Btn variant="secondary" icon="review" onClick={() => router.push('/practice')}>
                练习列表
              </Btn>
            </div>
          </LoomCard>
        </section>
      )}

      {/* ── slot list ─────────────────────────────────────────────────────── */}
      {!isPaused &&
        !allDone &&
        paper.sections.map((section) => (
          <div key={section.section_index}>
            {/* section header — only shown when paper has multiple sections */}
            {paper.sections.length > 1 && (
              <div className="section-divider">
                <span className="badge tone-neutral">
                  <LoomIcon name="layers" size={12} />第 {section.section_index + 1} 节
                </span>
                {section.knowledge_focus.map((k) => (
                  <span key={k} className="chip chip-k mono">
                    {k}
                  </span>
                ))}
              </div>
            )}

            {section.slots.map((slot) => {
              const globalIdx = allSlots.indexOf(slot);
              const key = slotKey(slot);
              const localState = slotStates[key] ?? {
                answer: slot.slot_state.draft?.content_md ?? '',
                phase: slot.slot_state.submission ? 'feedback' : 'answering',
                submitResult: serverSubToResult(slot.slot_state.submission),
                autosavePending: false,
              };
              const isActive = globalIdx === activeSlotIdx;
              const isSubmitted = !!localState.submitResult;
              const phase = localState.phase;

              return (
                <section
                  key={key}
                  className="review-stage"
                  style={isActive ? undefined : { opacity: 0.65 }}
                  aria-current={isActive ? 'true' : undefined}
                >
                  {/* slot meta */}
                  <div className="progress">
                    <span>
                      {globalIdx + 1} / {totalSlots}
                      {slot.knowledge_focus.map((k) => (
                        <span
                          key={k}
                          className="chip chip-k mono"
                          style={{ marginLeft: 'var(--s-2)' }}
                        >
                          {k}
                        </span>
                      ))}
                      {slot.part_ref && (
                        <span className="badge tone-neutral" style={{ marginLeft: 'var(--s-2)' }}>
                          {slot.part_ref}
                        </span>
                      )}
                    </span>
                    {!isActive && !isSubmitted && (
                      <button
                        type="button"
                        className="btn-sm"
                        onClick={() => setActiveSlotIdx(globalIdx)}
                      >
                        跳到此题
                      </button>
                    )}
                  </div>

                  {/* question body */}
                  <div className="qbody wenyan">{slot.question.prompt_md || '（题面加载中）'}</div>

                  {/* answering phase */}
                  {isActive && phase === 'answering' && !isSubmitted && (
                    <>
                      <div className="label-mono">你的作答</div>
                      <div className="answer-compose">
                        <div className="answer-compose__editor">
                          <textarea
                            id={`answer-input-${key}`}
                            ref={taRef}
                            rows={3}
                            value={localState.answer}
                            placeholder="先用你自己的话作答，再提交……"
                            onChange={(e) => handleAnswerChange(slot, e.target.value)}
                            aria-label="作答"
                          />
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)' }}>
                        <Btn
                          variant="primary"
                          icon="check"
                          onClick={() => handleSubmit(slot)}
                          disabled={submitM.isPending}
                        >
                          提交
                        </Btn>
                        <span className="label-mono" style={{ color: 'var(--ink-5)' }}>
                          ⌘/Ctrl+Enter 提交
                        </span>
                        {localState.autosavePending && (
                          <span className="label-mono" style={{ color: 'var(--ink-5)' }}>
                            草稿保存中…
                          </span>
                        )}
                      </div>
                      {submitM.isError && (
                        <p
                          className="empty"
                          style={{ color: 'var(--again-ink)', marginTop: 'var(--s-2)' }}
                        >
                          提交失败：{(submitM.error as Error).message}
                        </p>
                      )}
                    </>
                  )}

                  {/* feedback phase */}
                  {phase === 'feedback' && isSubmitted && (
                    <>
                      {/* answer vs reference — feedback-split is a production class */}
                      <div className="feedback-split">
                        <div>
                          <div className="label-mono">
                            <LoomIcon name="pencil" size={13} /> 你的作答
                          </div>
                          <div className="wenyan" style={{ marginTop: 'var(--s-2)' }}>
                            {localState.answer || <span className="quiet-empty">（未作答）</span>}
                          </div>
                        </div>
                        <div>
                          <div className="label-mono">
                            <LoomIcon name="check" size={13} /> 参考答案
                          </div>
                          <div
                            className="wenyan feedback-prose muted"
                            style={{ marginTop: 'var(--s-2)' }}
                          >
                            {/* reference_md not included in server response (anti-cheat);
                                revealed in learning-session view after completion. */}
                            提交后可在学习会话中查看
                          </div>
                        </div>
                      </div>

                      {/* judge outcome / buffered placeholder */}
                      {localState.submitResult?.visible_to_user ? (
                        <div className="feedback-prose">
                          <span
                            className={`badge ${OUTCOME_TONE[localState.submitResult.coarse_outcome ?? 'unknown']}`}
                          >
                            {OUTCOME_LABEL[localState.submitResult.coarse_outcome ?? 'unknown']}
                          </span>
                          {localState.submitResult.score != null && (
                            <span className="label-mono" style={{ marginLeft: 'var(--s-2)' }}>
                              {/* score is [0,1]; display as percentage */}
                              得分 {Math.round(localState.submitResult.score * 100)}%
                            </span>
                          )}
                        </div>
                      ) : (
                        /* feedback_buffered placeholder (§4.9) */
                        <div className="feedback-buffered">
                          <LoomIcon name="clock" size={14} />
                          <span>反馈已缓冲</span>
                          <span className="label-mono" style={{ color: 'var(--ink-5)' }}>
                            整卷完成后揭示
                          </span>
                        </div>
                      )}

                      {/* next slot button */}
                      {isActive && globalIdx < totalSlots - 1 && (
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'flex-end',
                            marginTop: 'var(--s-1)',
                          }}
                        >
                          <Btn variant="primary" iconEnd="arrow" onClick={handleNext}>
                            下一题
                          </Btn>
                        </div>
                      )}
                    </>
                  )}
                </section>
              );
            })}
          </div>
        ))}
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

function slotKey(slot: PaperDetailSlot): string {
  return `${slot.question_id}::${slot.part_ref ?? ''}`;
}

type ServerSubmission = PaperDetailSlot['slot_state']['submission'];

function serverSubToResult(sub: ServerSubmission): SubmitResult | null {
  if (!sub) return null;
  if (sub.visible_to_user) {
    return {
      visible_to_user: true,
      coarse_outcome: sub.outcome,
      score: sub.score ?? null,
    };
  }
  return {
    visible_to_user: false,
    coarse_outcome: null,
    score: null,
    feedback_buffered: true,
  };
}
