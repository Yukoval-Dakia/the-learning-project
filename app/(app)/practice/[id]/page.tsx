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
import { PracticeChoiceOptions } from '@/ui/components/PracticeChoiceOptions';
import {
  answerMdToSelection,
  deriveMultiSelect,
  selectionToAnswerMd,
} from '@/ui/components/practice-choice-logic';
import { apiJson, getInternalToken } from '@/ui/lib/api';
import { Btn } from '@/ui/primitives/Btn';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SkLines } from '@/ui/primitives/SkLines';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

// ── keepalive fetch helper ────────────────────────────────────────────────────
// sendBeacon cannot carry custom headers (→ 401). Use fetch with keepalive:true
// instead so the request survives navigation / unload while still passing the
// x-internal-token header required by middleware.ts.
function keepaliveFetch(url: string, body?: string): void {
  const token = getInternalToken();
  if (!token) return;
  const headers: HeadersInit = { 'x-internal-token': token };
  if (body !== undefined) headers['content-type'] = 'application/json';
  void fetch(url, {
    method: 'POST',
    keepalive: true,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
}

// ── slot display state ────────────────────────────────────────────────────────

type SlotPhase = 'answering' | 'feedback';

interface SlotLocalState {
  answer: string;
  phase: SlotPhase;
  // result echoed from the submit response (visible slots only)
  submitResult: SubmitResult | null;
  autosavePending: boolean;
  // set when the last autosave POST failed; cleared on next successful save
  autosaveFailed?: boolean;
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
      const st = paper.session.status;
      if (st === 'abandoned') {
        // Fix 1 (CR Round-2 #3359476199): reopen abandoned session; if reopen
        // fails, fall back to creating a brand-new session. If both fail, reset
        // startedRef so the user can retry rather than being stuck with no session.
        const abandonedSessionId = paper.session.id; // capture before async
        startedRef.current = true;
        setStartingSession(true);
        apiJson(`/api/review/sessions/${abandonedSessionId}/reopen`, { method: 'POST' })
          .then(() => {
            setSessionId(abandonedSessionId);
            updateStatus('started');
            setStartingSession(false);
            void qc.invalidateQueries({ queryKey: ['practice-detail', artifactId] });
          })
          .catch(() => {
            // reopen failed — fall back to a new session for this paper
            apiJson<{ session_id: string }>('/api/practice', {
              method: 'POST',
              body: JSON.stringify({ artifact_id: artifactId }),
            })
              .then((data) => {
                setSessionId(data.session_id);
                updateStatus('started');
                setStartingSession(false);
                void qc.invalidateQueries({ queryKey: ['practice-detail', artifactId] });
              })
              .catch(() => {
                // both paths failed: reset guard so user can retry
                startedRef.current = false;
                setStartingSession(false);
              });
          });
        return;
      }
      // adopt existing started / paused / completed session
      setSessionId(paper.session.id);
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
        // CR Round-5 #3359720378: reset guard so user can retry (symmetric with
        // the abandoned-fallback double-failure path above).
        startedRef.current = false;
        setStartingSession(false);
      });
  }, [paper, artifactId, updateStatus, qc]);

  // ── pagehide beacon ────────────────────────────────────────────────────────
  // pagehide only pauses — never completes — to prevent premature feedback
  // reveal on a partially-answered paper. Complete fires exclusively from the
  // allDone effect when the user has submitted all slots.
  //
  // CR Round-2 #3359486404: navigator.sendBeacon cannot carry custom headers
  // so it gets a 401 from middleware. Use keepalive fetch instead.
  //
  // CR Round-3 #3359561300: flush pending draft autosaves before pausing so
  // no in-flight answer is lost on navigation. flushPendingDrafts uses stable
  // sessionIdRef/artifactIdRef refs so it is safe to call from this closure
  // even though it is defined later in the component body.
  useEffect(() => {
    const sid = sessionId;
    if (!sid) return;
    const onPageHide = () => {
      if (sessionClosedRef.current) return;
      if (sessionStatusRef.current === 'paused' || sessionStatusRef.current === 'completed') return;
      flushPendingDrafts.current();
      keepaliveFetch(`/api/review/sessions/${sid}/pause`);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
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

  // Fix 3: init activeSlotIdx only once per paper (artifact_id), not on every
  // refetch. Using artifactId as dependency (stable) + ref guard prevents the
  // post-submit invalidate from resetting activeSlotIdx back to slot 0.
  // Advancement after each submit is handled explicitly in submitM.onSuccess.
  const activeSlotInitRef = useRef<string | null>(null);
  useEffect(() => {
    if (allSlots.length === 0 || activeSlotInitRef.current === artifactId) return;
    activeSlotInitRef.current = artifactId;
    const firstUnsubmitted = allSlots.findIndex((s) => !s.slot_state.submission);
    setActiveSlotIdx(firstUnsubmitted >= 0 ? firstUnsubmitted : allSlots.length - 1);
  }, [allSlots, artifactId]);

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

  // Tracks the pending draft payload for each slot key so the unmount cleanup
  // can flush unsaved answers without needing access to React state.
  // CR Round-2 #3359486408: unmount must flush rather than silently drop drafts.
  const pendingDrafts = useRef<
    Record<string, { question_id: string; part_ref: string | null; content_md: string }>
  >({});

  // Per-slot monotonic sequence for immediate choice-draft POSTs. Rapid clicks
  // (A then B) fire two un-debounced POSTs whose responses can land out of order;
  // each flush stamps the latest seq for its slot and only honours its own
  // .then()/.catch() if it is still the latest (stale responses are ignored), so a
  // late-landing earlier POST can't clobber UI state or drop the newer draft's
  // unload-retry. (codex/CodeRabbit/OCR round: flushChoiceDraft ordering guard.)
  const choiceFlushSeq = useRef<Record<string, number>>({});

  // Flush all pending draft autosaves using keepalive fetch (survives unload).
  // Called from both the unmount cleanup and the pagehide handler.
  //
  // CR Round-5 #3359720375: iterate pendingDrafts (not autosaveTimers) so that
  // drafts whose timer already fired but whose POST failed (timer deleted, draft
  // retained) are also retried. Outstanding timers are cancelled as a side-effect.
  const flushPendingDrafts = useRef(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const timers = autosaveTimers.current;
    const drafts = pendingDrafts.current;
    for (const key of Object.keys(drafts)) {
      // Cancel any outstanding timer (no-op if already fired/deleted).
      clearTimeout(timers[key]);
      delete timers[key];
      keepaliveFetch(
        `/api/practice/${artifactIdRef.current}/answer`,
        JSON.stringify({ session_id: sid, ...drafts[key] }),
      );
      delete drafts[key];
    }
  });

  // Stable refs for artifactId and sessionId so the flush closure above can
  // read the latest values without being re-created on every render.
  const artifactIdRef = useRef(artifactId);
  artifactIdRef.current = artifactId;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // CR Round-2 #3359486408: on unmount flush pending drafts before clearing timers.
  useEffect(() => {
    return () => {
      flushPendingDrafts.current();
    };
  }, []);

  function scheduleAutosave(slot: PaperDetailSlot, answer: string) {
    const key = slotKey(slot);
    clearTimeout(autosaveTimers.current[key]);
    // Track the latest draft payload so flushPendingDrafts can send it on unmount.
    pendingDrafts.current[key] = {
      question_id: slot.question_id,
      part_ref: slot.part_ref ?? null,
      content_md: answer,
    };
    autosaveTimers.current[key] = setTimeout(() => {
      if (!sessionId) return;
      // CR Round-4 #3359642328: only clear pending state on success; preserve on
      // failure so flushPendingDrafts can retry on unmount/pagehide.
      void apiJson(`/api/practice/${artifactId}/answer`, {
        method: 'POST',
        body: JSON.stringify({
          session_id: sessionId,
          question_id: slot.question_id,
          part_ref: slot.part_ref ?? null,
          content_md: answer,
        }),
      })
        .then(() => {
          setSlotStates((prev) => ({
            ...prev,
            [key]: { ...prev[key], autosavePending: false, autosaveFailed: false },
          }));
          delete autosaveTimers.current[key];
          delete pendingDrafts.current[key];
        })
        .catch(() => {
          // Save failed — clear the timer entry (it already fired) but keep the
          // draft in pendingDrafts so flush on unmount/pagehide can retry it.
          // Signal failure in UI; autosavePending cleared so indicator doesn't
          // stay "saving…" forever.
          setSlotStates((prev) => ({
            ...prev,
            [key]: { ...prev[key], autosavePending: false, autosaveFailed: true },
          }));
          delete autosaveTimers.current[key];
        });
    }, 500);
  }

  function handleAnswerChange(slot: PaperDetailSlot, value: string) {
    const key = slotKey(slot);
    setSlotStates((prev) => ({
      ...prev,
      [key]: { ...prev[key], answer: value, autosavePending: true, autosaveFailed: false },
    }));
    scheduleAutosave(slot, value);
  }

  // YUK-261: click-to-stage for choice options. A click is a discrete choice, so
  // persist the draft immediately (no 500ms debounce) rather than waiting like the
  // free-text textarea. Cancels any pending debounced timer for the slot first so
  // the two paths don't race. Still the AUTOSAVE channel — never the submit path
  // (owner ruling: 点选 ≠ 提交). On failure the retry-on-unload path still applies
  // via pendingDrafts (set by scheduleAutosave above before this fires).
  function flushChoiceDraft(slot: PaperDetailSlot, value: string) {
    const key = slotKey(slot);
    clearTimeout(autosaveTimers.current[key]);
    delete autosaveTimers.current[key];
    if (!sessionId) return;
    // Stamp this flush so a later click's POST always wins regardless of which
    // response lands first. Stale completions below are ignored.
    const seq = (choiceFlushSeq.current[key] ?? 0) + 1;
    choiceFlushSeq.current[key] = seq;
    const isLatest = () => choiceFlushSeq.current[key] === seq;
    void apiJson(`/api/practice/${artifactId}/answer`, {
      method: 'POST',
      body: JSON.stringify({
        session_id: sessionId,
        question_id: slot.question_id,
        part_ref: slot.part_ref ?? null,
        content_md: value,
      }),
    })
      .then(() => {
        if (!isLatest()) return; // a newer click superseded this one — ignore.
        setSlotStates((prev) => ({
          ...prev,
          [key]: { ...prev[key], autosavePending: false, autosaveFailed: false },
        }));
        // Only drop the unload-retry entry if it still holds the value WE saved;
        // a newer click may have re-seeded pendingDrafts with a different draft.
        if (pendingDrafts.current[key]?.content_md === value) {
          delete pendingDrafts.current[key];
        }
      })
      .catch(() => {
        if (!isLatest()) return; // stale failure for a superseded click — ignore.
        // Keep pendingDrafts[key] (set by scheduleAutosave) so the unload flush retries.
        setSlotStates((prev) => ({
          ...prev,
          [key]: { ...prev[key], autosavePending: false, autosaveFailed: true },
        }));
      });
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
      // CR Round-4 #3359642338: for visible submissions, immediately refetch so
      // the reference_md (only in server slot_state) is available before the
      // session completes. For buffered submissions the refetch at session-end
      // (allDone effect) is sufficient.
      if (data.visible_to_user) {
        void qc.invalidateQueries({ queryKey: ['practice-detail', artifactId] });
      }
      // Fix 3: explicitly advance to the next unsubmitted slot after submit.
      // This must happen after setSlotStates so the newly submitted slot is
      // excluded; using functional update pattern to read current allSlots.
      setActiveSlotIdx((currentIdx) => {
        const submittedSlotIdx = allSlots.indexOf(vars.slot);
        // Find next unsubmitted slot after the just-submitted one
        for (let i = submittedSlotIdx + 1; i < allSlots.length; i++) {
          if (!allSlots[i].slot_state.submission) return i;
        }
        // No next slot: stay on the submitted slot to show its feedback
        return currentIdx;
      });
    },
  });

  function handleSubmit(slot: PaperDetailSlot) {
    const key = slotKey(slot);
    if (submitM.isPending || slotStates[key]?.submitResult) return;
    // Cancel pending autosave timer and synchronously clear the pending flag
    // (CR Round-2 #3359476204: without this, "草稿保存中…" sticks after submit failure).
    clearTimeout(autosaveTimers.current[key]);
    delete autosaveTimers.current[key];
    delete pendingDrafts.current[key];
    setSlotStates((prev) => ({
      ...prev,
      [key]: { ...prev[key], autosavePending: false },
    }));
    const answer = slotStates[key]?.answer ?? '';
    // YUK-261 grading fix: choice slots stage a letter string ('B') in the draft,
    // but the exact judge does a plain normalized string compare against the
    // reference_md, which stores the option TEXT ('苏洵'). Expand the staged letters
    // to the matching option text(s) before submitting so a correct click grades
    // correct. Non-choice slots (no choices_md) submit the raw answer unchanged.
    const choices = slot.question.choices_md;
    const answerMd = choices && choices.length > 0 ? selectionToAnswerMd(answer, choices) : answer;
    submitM.mutate({ slot, answerMd });
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
  // Read-only mode: session is completed (either adopted from server or just ended here).
  // In read-only mode the slot list renders without composer/autosave — purely for review.
  const isReadOnly = sessionStatus === 'completed';

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
      {/* Rendered in both active and completed (read-only review) modes.      */}
      {/* In read-only mode: no composer, no autosave — purely for review.     */}
      {!isPaused &&
        paper.sections.map((section) => (
          <div key={section.section_index}>
            {/* section header — only shown when paper has multiple sections */}
            {paper.sections.length > 1 && (
              <div className="section-divider">
                <span className="badge tone-neutral">
                  <LoomIcon name="layers" size={12} />第 {section.section_index + 1} 节
                </span>
                {section.knowledge_focus.map((id, i) => (
                  <span key={id} className="chip chip-k mono">
                    {section.knowledge_focus_names[i] ?? id}
                  </span>
                ))}
              </div>
            )}

            {/* Build id→name map from section's parallel arrays for slot-level chips. */}
            {(() => {
              const sectionNameMap = new Map<string, string>(
                section.knowledge_focus.map((id, i) => [
                  id,
                  section.knowledge_focus_names[i] ?? id,
                ]),
              );
              return section.slots.map((slot) => {
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
                        {slot.knowledge_focus.map((id) => (
                          <span
                            key={id}
                            className="chip chip-k mono"
                            style={{ marginLeft: 'var(--s-2)' }}
                          >
                            {sectionNameMap.get(id) ?? id}
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
                    <div className="qbody wenyan">
                      {slot.question.prompt_md || '（题面加载中）'}
                    </div>

                    {/* choice options (YUK-261) — clickable option cards for both
                        active answering and read-only / feedback review. Click only
                        writes the normalized letter string to the autosave draft
                        channel (click-to-stage, no 500ms debounce); SUBMIT stays on
                        the explicit 提交 button below (owner ruling: 点选 ≠ 提交). */}
                    {slot.question.choices_md &&
                      slot.question.choices_md.length > 0 &&
                      (() => {
                        const choices = slot.question.choices_md;
                        const choiceReference =
                          slot.slot_state.submission && 'reference_md' in slot.slot_state.submission
                            ? slot.slot_state.submission.reference_md
                            : null;
                        const choiceFeedback =
                          isSubmitted || (isReadOnly && !!slot.slot_state.submission);
                        // In feedback / read-only mode the frozen answer lives in
                        // submission.answer_md (option TEXT after the submit-time
                        // expansion), and draft is usually null — derive the lit cards
                        // from the submission, not the (empty) draft. While answering,
                        // the staged letter-string draft is the source of truth.
                        const submittedAnswerMd = slot.slot_state.submission?.answer_md ?? null;
                        const choiceValue =
                          choiceFeedback && submittedAnswerMd
                            ? answerMdToSelection(submittedAnswerMd, choices)
                            : localState.answer;
                        return (
                          <PracticeChoiceOptions
                            choices={choices}
                            value={choiceValue}
                            // Persisted question.kind is canonical 'choice' (single/multi
                            // collapsed by question-kind.ts) — derive multi-select from the
                            // reference shape instead of the never-true 'multiple_choice'.
                            multiSelect={deriveMultiSelect(choiceReference, choices)}
                            disabled={isReadOnly}
                            feedback={choiceFeedback}
                            reference={choiceReference}
                            // Click-to-stage: same autosave channel as the textarea, but
                            // immediate (no debounce) since a click is a discrete choice.
                            onSelect={(contentMd) => {
                              handleAnswerChange(slot, contentMd);
                              flushChoiceDraft(slot, contentMd);
                            }}
                          />
                        );
                      })()}

                    {/* answering phase — active, not yet submitted, session not completed */}
                    {!isReadOnly && isActive && phase === 'answering' && !isSubmitted && (
                      <>
                        <div className="label-mono">你的作答</div>
                        <div className="answer-compose">
                          <div className="answer-compose__editor">
                            <textarea
                              id={`answer-input-${key}`}
                              ref={taRef}
                              rows={3}
                              value={localState.answer}
                              placeholder={
                                slot.question.choices_md?.length
                                  ? '点击选项填入，或直接输入…'
                                  : '先用你自己的话作答，再提交……'
                              }
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
                          {!localState.autosavePending && localState.autosaveFailed && (
                            <span className="label-mono" style={{ color: 'var(--again-ink)' }}>
                              保存失败，将重试
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

                    {/* feedback phase — submitted, or read-only review of completed paper */}
                    {(phase === 'feedback' && isSubmitted) ||
                    (isReadOnly && !!slot.slot_state.submission) ? (
                      <>
                        {/* answer vs reference — feedback-split is a production class */}
                        {(() => {
                          // Submission is guaranteed non-null when this block renders.
                          const sub = slot.slot_state.submission;
                          // "你的作答": always use submission.answer_md (frozen at submit time).
                          const answerText = sub?.answer_md ?? localState.answer;
                          // "参考答案" resolution (§4.9 + CR Round-4 #3359642338):
                          //   sub present + visible variant → sub.reference_md (may be null = no ref)
                          //   sub present + buffered variant → structurally no reference_md field
                          //   sub absent + local result visible (refetch gap) → show loading text
                          //   sub absent + local result buffered / null → show buffered placeholder
                          // Do NOT use 'reference_md' in sub to distinguish visible/buffered when
                          // sub is absent — fall back to localState.submitResult.visible_to_user.
                          let refMdNode: React.ReactNode;
                          if (sub && 'reference_md' in sub) {
                            // server data available: use it authoritatively
                            refMdNode =
                              sub.reference_md === null ? '本题无参考答案' : sub.reference_md;
                          } else if (localState.submitResult?.visible_to_user) {
                            // visible submit, server refetch pending (CR Round-4 #3359642338)
                            refMdNode = (
                              <span className="label-mono" style={{ color: 'var(--ink-5)' }}>
                                参考答案加载中…
                              </span>
                            );
                          } else {
                            // buffered variant: reference_md structurally absent
                            refMdNode = '提交后可在学习会话中查看';
                          }
                          return (
                            <div className="feedback-split">
                              <div>
                                <div className="label-mono">
                                  <LoomIcon name="pencil" size={13} /> 你的作答
                                </div>
                                <div className="wenyan" style={{ marginTop: 'var(--s-2)' }}>
                                  {answerText || <span className="quiet-empty">（未作答）</span>}
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
                                  {refMdNode}
                                </div>
                              </div>
                            </div>
                          );
                        })()}

                        {/* judge outcome — in read-only mode prefer server slot_state;
                            fall back to localState.submitResult for the brief window
                            between allDone→completed and the refetch arriving
                            (CR Round-3 #3359561301). Server data overwrites local on
                            the next render once invalidateQueries resolves. */}
                        {(() => {
                          const result = isReadOnly
                            ? (serverSubToResult(slot.slot_state.submission) ??
                              localState.submitResult)
                            : localState.submitResult;
                          if (result?.visible_to_user) {
                            return (
                              <div className="feedback-prose">
                                <span
                                  className={`badge ${OUTCOME_TONE[result.coarse_outcome ?? 'unknown']}`}
                                >
                                  {OUTCOME_LABEL[result.coarse_outcome ?? 'unknown']}
                                </span>
                                {result.score != null && (
                                  <span className="label-mono" style={{ marginLeft: 'var(--s-2)' }}>
                                    {/* score is [0,1]; display as percentage */}
                                    得分 {Math.round(result.score * 100)}%
                                  </span>
                                )}
                              </div>
                            );
                          }
                          return (
                            /* feedback_buffered placeholder (§4.9) */
                            <div className="feedback-buffered">
                              <LoomIcon name="clock" size={14} />
                              <span>反馈已缓冲</span>
                              <span className="label-mono" style={{ color: 'var(--ink-5)' }}>
                                整卷完成后揭示
                              </span>
                            </div>
                          );
                        })()}

                        {/* next slot button — only in active answering mode, not read-only */}
                        {!isReadOnly && isActive && globalIdx < totalSlots - 1 && (
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
                    ) : null}
                  </section>
                );
              });
            })()}
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
