// M2 练习面 — 卷模式（YUK-316）。
// 设计基准 docs/design/loom-refresh/project/pface-paper.jsx：§6.4 缓冲反馈——
// 作答全程零语义色（pip 只有「已答」的中性墨点），颜色在交卷瞬间才进场。
// 后端语义：草稿 PUT answer 自动保存；「交卷」= 未提交 slot 逐个 POST submit
//（judge-now-show-later，visible_to_user=false 缓冲）+ session end → 可见性解锁。

import { usePagehideTransition } from '@/ui/hooks/usePagehideTransition';
import { Btn } from '@/ui/primitives/Btn';
import { Card } from '@/ui/primitives/Card';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { PfToast } from './PracticeFacePage';
import {
  type PaperDetail,
  type PaperSlot,
  allocateKeepaliveBudget,
  endPaperSession,
  getPaperDetail,
  paperAnswerDraftBodyBytes,
  pausePaperSession,
  savePaperAnswer,
  startPaperSession,
  submitPaperSlot,
} from './practice-api';

function slotKey(s: PaperSlot): string {
  return `${s.question_id}::${s.part_ref ?? ''}`;
}

// Bounded wait for an in-flight draft to settle on exit before reporting: past this we treat
// the save as unsaved rather than hang the exit indefinitely. A late success only over-warns
// (a conservative, honesty-preserving direction), never a false 「进度保留」.
const EXIT_FLUSH_TIMEOUT_MS = 3000;

export function PfPaper({
  artifactId,
  onExit,
  onSubmitted,
  addToast,
}: {
  artifactId: string;
  // unsavedFailures lets the host tell an honest exit story: 0 → 「进度已保留」, >0 → a
  // non-blaming 「有 N 处草稿未保存」instead of a false success promise.
  onExit: (info?: { unsavedFailures: number }) => void;
  onSubmitted: () => void;
  addToast: (text: string, tone?: PfToast['tone'], icon?: string) => void;
}) {
  const qc = useQueryClient();
  const detailQ = useQuery({
    queryKey: ['paper', artifactId],
    queryFn: () => getPaperDetail(artifactId),
  });
  const detail: PaperDetail | null = detailQ.data ?? null;
  const slots = useMemo(() => detail?.sections.flatMap((s) => s.slots) ?? [], [detail]);

  const [pos, setPos] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Per-slot autosave-failed flags. While any is set the top chip stops claiming
  // 「草稿自动保存」and the exit / foot copy drop their 「进度保留」promise, since the
  // last draft PUT for that slot never landed.
  const [saveFailed, setSaveFailed] = useState<Record<string, boolean>>({});
  // Disables the retry chip while a retry batch is in flight (avoids redundant PUTs).
  const [retrying, setRetrying] = useState(false);
  // Concurrent draft PUTs for one slot can settle out of order; only the LATEST
  // request may update that slot's failed flag, or an old success would clear a
  // newer failure (and vice versa).
  const saveSeq = useRef<Record<string, number>>({});
  // Paper generation: bumped whenever artifactId changes. Because saveSeq resets per
  // paper, paper A's in-flight save could otherwise share a seq with paper B's first save
  // for the same slot key and let A's late settle rewrite B's flag. The gen captured at
  // dispatch must still match at settle, so a save outlives its paper as a no-op.
  const saveGen = useRef(0);
  const sessionRef = useRef<string | null>(null);
  const sessionOpenRef = useRef(false);
  // Per-slot debounce timers. A shared timer would let typing in slot B cancel slot A's
  // pending save, silently dropping A's last keystrokes while the UI still claims saved.
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Draft saves dispatched but not yet settled (latest promise per slot key). The debounce
  // timer is deleted the instant it fires, so without this an exit during the in-flight POST
  // window would see no pending timer and neither await nor keepalive-resend the save — a
  // slow-net / teardown cancel would then be reported as 「进度保留」. Cleared per paper.
  const inFlightSaves = useRef<Map<string, Promise<boolean>>>(new Map());
  // Guards exitPaper against a double-click during its flush/settle window (up to
  // EXIT_FLUSH_TIMEOUT_MS): the ref blocks re-entry synchronously (so two clicks in one tick
  // can't both call onExit); `exiting` disables the button so a second click can't even fire.
  const exitingRef = useRef(false);
  const [exiting, setExiting] = useState(false);
  // Mirror of `answers`, updated synchronously on every keystroke. The pagehide/exit flush
  // reads THIS, not the render-closure `answers` (which can lag the final keystroke by a
  // frame), so the last typed text is never flushed as a stale/empty value.
  const answersRef = useRef<Record<string, string>>({});
  // Mutual exclusion with exitPaper: a submit and an exit must not both fire a terminal
  // transition (double onSubmitted/onExit). Synchronous, like exitingRef.
  const submittingRef = useRef(false);

  // Fresh paper (route param reuse) → drop per-slot state so a recycled slot key can't
  // carry a stale 「保存失败」or another paper's answer into this one; clear pending timers
  // in place (keep the map identity so the unmount cleanup below always sees live timers).
  // answers must reset too: the backfill effect only fills undefined keys, so without this
  // a shared slot key would keep paper A's answer and skip paper B's server draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: artifactId is the reset trigger (reset-on-prop-change), not read in the body.
  useEffect(() => {
    setAnswers({});
    setSaveFailed({});
    setRetrying(false);
    setExiting(false);
    setSubmitting(false);
    exitingRef.current = false;
    submittingRef.current = false;
    answersRef.current = {};
    saveSeq.current = {};
    saveGen.current += 1;
    // Drop the previous paper's session so a pre-session autosave on the new paper flags
    // 「保存失败」honestly instead of PUTting a draft with the old paper's session id.
    sessionRef.current = null;
    sessionOpenRef.current = false;
    for (const k of Object.keys(saveTimers.current)) {
      clearTimeout(saveTimers.current[k]);
      delete saveTimers.current[k];
    }
    // Drop the old paper's in-flight tracking so a new paper's exit can't await A's saves
    // (their late settle is already a no-op via the bumped saveGen).
    inFlightSaves.current.clear();
  }, [artifactId]);

  // Clear any pending debounce timers on unmount (no setState after teardown).
  useEffect(() => {
    const timers = saveTimers.current;
    return () => {
      for (const t of Object.values(timers)) clearTimeout(t);
    };
  }, []);

  // 已有 session 复用；没有则开卷即建（answer/submit 都需要 session_id）。
  useEffect(() => {
    if (!detail) return;
    if (detail.session) {
      sessionRef.current = detail.session.id;
      sessionOpenRef.current = ['started', 'paused'].includes(detail.session.status);
      return;
    }
    // Guard the async open against a paper switch: capture the generation at dispatch and
    // discard a resolve/reject that lands after the user moved to another paper, so a stale
    // open can't write its session id (or an error toast) back onto the new paper.
    const gen = saveGen.current;
    void startPaperSession(artifactId)
      .then((r) => {
        if (saveGen.current !== gen) return;
        sessionRef.current = r.session_id;
        sessionOpenRef.current = true;
      })
      .catch((e) => {
        if (saveGen.current !== gen) return;
        addToast(`开卷失败：${(e as Error).message}`, 'info', 'alert');
      });
  }, [detail, artifactId, addToast]);

  // 草稿初值：服务端 draft / 已提交 answer 回填。
  useEffect(() => {
    if (slots.length === 0) return;
    setAnswers((cur) => {
      const next = { ...cur };
      for (const s of slots) {
        const k = slotKey(s);
        if (next[k] !== undefined) continue;
        next[k] = s.slot_state.submission?.answer_md ?? s.slot_state.draft?.content_md ?? '';
      }
      return next;
    });
    // Seed answersRef from the server backfill (only unset keys, so a keystroke that landed
    // before this effect isn't clobbered). answersRef is the flush source of truth.
    for (const s of slots) {
      const k = slotKey(s);
      if (answersRef.current[k] === undefined) {
        answersRef.current[k] =
          s.slot_state.submission?.answer_md ?? s.slot_state.draft?.content_md ?? '';
      }
    }
  }, [slots]);

  const pauseCurrentSession = useCallback((keepalive = false) => {
    const sid = sessionRef.current;
    if (!sid || !sessionOpenRef.current) return Promise.resolve();
    // Claim the transition before starting the request so duplicate pagehide
    // events and the explicit exit button cannot emit parallel PATCHes.
    sessionOpenRef.current = false;
    return pausePaperSession(sid, { keepalive }).catch((error) => {
      sessionOpenRef.current = true;
      throw error;
    });
  }, []);

  // 草稿 PUT：成功清掉该 slot 的失败标记，失败则点亮——不再静默吞掉错误。返回本次是否
  // 落库（true=成功/无需保存，false=失败），供退出/关页 flush 如实计数未保存草稿。
  // Defined above the early return so the pagehide handler and exitPaper can reach it.
  const runSave = (
    key: string,
    questionId: string,
    partRef: PaperSlot['part_ref'],
    v: string,
    keepalive = false,
  ): Promise<boolean> => {
    const gen = saveGen.current;
    const seq = (saveSeq.current[key] ?? 0) + 1;
    saveSeq.current[key] = seq;
    // Only the latest save of THIS paper may touch the flag: the paper must be unchanged
    // (gen) and this must be its newest request (seq). A save that outlives its paper is a
    // no-op — it can't rewrite the next paper's state.
    const isLatest = () => saveGen.current === gen && saveSeq.current[key] === seq;
    // Deregister this entry when it settles, unless a newer save has already replaced it.
    const deregister = (ok: boolean) => {
      if (inFlightSaves.current.get(key) === done) inFlightSaves.current.delete(key);
      return ok;
    };
    let done: Promise<boolean>;
    const sid = sessionRef.current;
    if (!sid) {
      // Session still opening or startPaperSession failed — do NOT drop the draft silently.
      // Flag the slot AND register a failed in-flight result on the SAME track as real saves,
      // so exit/pagehide accounting sees this failure; a bare `Promise.resolve(false)` here
      // would be invisible to settleInFlightSaves and (with a stale saveFailed closure) let
      // exit report 0 — a false 「进度保留」over input that never left the page.
      if (isLatest()) setSaveFailed((f) => ({ ...f, [key]: true }));
      done = Promise.resolve(false).then(deregister);
    } else {
      try {
        done = savePaperAnswer(
          artifactId,
          {
            session_id: sid,
            question_id: questionId,
            part_ref: partRef,
            answer_md: v,
          },
          { keepalive },
        )
          .then(() => {
            if (isLatest()) setSaveFailed((f) => (f[key] ? { ...f, [key]: false } : f));
            return true;
          })
          .catch((err) => {
            console.error('[PfPaper] draft save failed', { key, err });
            if (isLatest()) setSaveFailed((f) => ({ ...f, [key]: true }));
            return false;
          })
          .then(deregister);
      } catch (err) {
        // savePaperAnswer threw synchronously (e.g. a 401 cleared the token → ApiAuthError
        // before the fetch even starts). Convert it to a resolved failure so no caller — the
        // exit/pagehide flush included — can be stranded on an unhandled throw, and flag the
        // slot so the exit count still records it as unsaved.
        console.error('[PfPaper] draft save threw', { key, err });
        if (isLatest()) setSaveFailed((f) => ({ ...f, [key]: true }));
        done = Promise.resolve(false).then(deregister);
      }
    }
    // Track as in-flight so an exit/pagehide during the POST window can await or re-send it.
    inFlightSaves.current.set(key, done);
    return done;
  };

  // Single flush path for exit and pagehide. Fires every not-yet-fired debounce so its draft
  // joins the in-flight set; with includeInFlight it also re-issues a save for slots whose
  // POST is still open (pagehide teardown may cancel the original). keepalive keeps the PUT
  // alive across page teardown. runSave itself is the single-track owner of in-flight state.
  const flushDirtySlots = (opts: { keepalive?: boolean; includeInFlight?: boolean } = {}) => {
    const keys = new Set<string>(Object.keys(saveTimers.current));
    if (opts.includeInFlight) for (const k of inFlightSaves.current.keys()) keys.add(k);
    // First pass: collect dirty slots and clear their timers, reading the LATEST text from
    // answersRef (the render-closure `answers` can lag the final keystroke on a fast pagehide).
    const dirty: {
      key: string;
      questionId: string;
      partRef: PaperSlot['part_ref'];
      answer: string;
    }[] = [];
    for (const key of keys) {
      if (saveTimers.current[key]) {
        clearTimeout(saveTimers.current[key]);
        delete saveTimers.current[key];
      }
      const slot = slots.find((s) => slotKey(s) === key);
      // A submitted (or vanished) slot needs no draft write.
      if (!slot || slot.slot_state.submission?.submitted) continue;
      dirty.push({
        key,
        questionId: slot.question_id,
        partRef: slot.part_ref,
        answer: answersRef.current[key] ?? '',
      });
    }
    // keepalive bodies share ONE page-level budget, so allocate it cumulatively across the
    // batch: slots that don't fit fall back to a normal (best-effort) fetch rather than
    // making the later fetch() throw and lose their drafts. Non-keepalive flushes skip this.
    const keepaliveFlags = opts.keepalive
      ? allocateKeepaliveBudget(
          dirty.map((d) =>
            paperAnswerDraftBodyBytes(artifactId, {
              session_id: sessionRef.current ?? '',
              question_id: d.questionId,
              part_ref: d.partRef,
              answer_md: d.answer,
            }),
          ),
        )
      : dirty.map(() => false);
    dirty.forEach((d, i) => {
      void runSave(d.key, d.questionId, d.partRef, d.answer, keepaliveFlags[i]);
    });
  };

  // Wait (bounded) for every in-flight draft save to settle so the exit count reflects real
  // outcomes rather than an optimistic timer or a still-open POST. Returns key→saved.
  const settleInFlightSaves = (): Promise<Map<string, boolean>> => {
    const entries = [...inFlightSaves.current.entries()];
    const results = new Map<string, boolean>();
    if (entries.length === 0) return Promise.resolve(results);
    return Promise.all(
      entries.map(
        ([key, promise]) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              results.set(key, false);
              resolve();
            }, EXIT_FLUSH_TIMEOUT_MS);
            void promise.then(
              (ok) => {
                clearTimeout(timer);
                results.set(key, ok);
                resolve();
              },
              () => {
                clearTimeout(timer);
                results.set(key, false);
                resolve();
              },
            );
          }),
      ),
    ).then(() => results);
  };

  // Hard tab-close / reload: the page is tearing down, so awaiting is useless. Re-send the
  // latest draft with keepalive for every slot that is either pending (unfired debounce) or
  // still in flight (a normal POST the teardown may cancel). Idempotent — the draft PUT is
  // last-write-wins, so re-sending the newest text is safe. Then pause the session.
  usePagehideTransition(() => {
    // Guard the flush so a throw can't skip the session pause — the orphan sweep is the only
    // other backstop for a session left open on teardown.
    try {
      flushDirtySlots({ keepalive: true, includeInFlight: true });
    } catch (err) {
      console.error('[PfPaper] pagehide flush failed', err);
    }
    return pauseCurrentSession(true);
  });

  const exitPaper = async () => {
    // Reentrancy + mutual exclusion: the flush/settle window below can span up to
    // EXIT_FLUSH_TIMEOUT_MS, so a double-click (or a click while the button hasn't re-rendered
    // disabled yet) must not start a second exit and call onExit twice; and an in-flight
    // submit must not race an exit into a double terminal transition. The ref checks are
    // synchronous; `exiting`/`submitting` also disable the buttons.
    if (exitingRef.current || submittingRef.current) return;
    exitingRef.current = true;
    setExiting(true);
    // Fire any not-yet-fired debounce, then wait for ALL in-flight saves — those just fired
    // AND any POST already open from a debounce that fired moments ago (its timer key is
    // gone, so only in-flight tracking catches it). The host's 「进度保留」story then reflects
    // what actually persisted, not an optimistic timer or an unsettled POST.
    let outcome = new Map<string, boolean>();
    try {
      flushDirtySlots();
      outcome = await settleInFlightSaves();
    } catch (err) {
      // Exit must never be blockable by a save error: on any flush failure fall back to an
      // empty outcome (the count below then leans on the standing 保存失败 flags — a
      // conservative estimate) and still exit, rather than strand the learner on the page.
      console.error('[PfPaper] exit flush failed', err);
    }
    void pauseCurrentSession().catch(() => {});
    // Count slots left genuinely unsaved: a slot that just settled uses its real outcome; an
    // untouched slot keeps whatever standing 保存失败 flag it had. Submitted slots never count
    // (submitAll captured their answer regardless of the draft PUT).
    const unsavedFailures = slots.filter((s) => {
      if (s.slot_state.submission?.submitted) return false;
      const k = slotKey(s);
      const ok = outcome.get(k);
      return ok === undefined ? (saveFailed[k] ?? false) : !ok;
    }).length;
    // Never let a throwing host onExit surface as an unhandled rejection out of this async
    // handler — the exit work is already done; a bad host callback shouldn't crash it.
    try {
      onExit({ unsavedFailures });
    } catch (err) {
      console.error('[PfPaper] onExit threw', err);
      // The host didn't navigate away, so unlock the page (ref + state) to let the learner
      // retry exiting. The SUCCESS path deliberately does NOT reset: the parent unmounts us,
      // and resetting would flash the button re-enabled for a frame.
      exitingRef.current = false;
      setExiting(false);
    }
  };

  if (detailQ.isLoading) return <p className="quiet-empty">取卷中…</p>;
  if (detailQ.isError || !detail || slots.length === 0)
    return (
      <div className="pfp">
        <Btn size="sm" variant="ghost" icon="arrowL" onClick={() => onExit()}>
          返回流
        </Btn>
        <p className="quiet-empty">卷加载失败或没有题。</p>
      </div>
    );

  const cur = slots[Math.min(pos, slots.length - 1)];
  const curKey = slotKey(cur);
  const isChoice = (cur.question.choices_md?.length ?? 0) > 0;
  const submittedKeys = new Set(
    slots.filter((s) => s.slot_state.submission?.submitted).map(slotKey),
  );
  const answeredCount = slots.filter((s) => (answers[slotKey(s)] ?? '').trim().length > 0).length;
  const unanswered = slots.length - answeredCount;

  // A submitted slot's draft no longer needs saving, so a lingering failure flag on it
  // must NOT keep the retry chip lit (submitAll captures the latest answer regardless of
  // whether the draft PUT landed).
  const anySaveFailed = slots.some((s) => saveFailed[slotKey(s)] && !submittedKeys.has(slotKey(s)));
  const retryFailedSaves = () => {
    if (retrying) return;
    // Drop failure flags on any slot submitted since it failed, so the chip can't stay
    // lit with nothing left to retry.
    setSaveFailed((f) => {
      const next = { ...f };
      let changed = false;
      for (const s of slots) {
        const k = slotKey(s);
        if (f[k] && submittedKeys.has(k)) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : f;
    });
    // Skip already-submitted slots — a draft PUT to a submitted slot has undefined
    // backend behaviour (setAnswer guards the same way).
    const pending = slots
      .filter((s) => saveFailed[slotKey(s)] && !submittedKeys.has(slotKey(s)))
      .map((s) => {
        const k = slotKey(s);
        // Cancel any still-pending debounce for this slot so a stale timer can't fire
        // after the retry and overwrite it with older text.
        if (saveTimers.current[k]) {
          clearTimeout(saveTimers.current[k]);
          delete saveTimers.current[k];
        }
        return runSave(k, s.question_id, s.part_ref, answers[k] ?? '');
      });
    if (pending.length === 0) return;
    setRetrying(true);
    void Promise.allSettled(pending).finally(() => setRetrying(false));
  };

  const setAnswer = (v: string) => {
    setAnswers((a) => ({ ...a, [curKey]: v }));
    // Mirror synchronously into answersRef so a pagehide/exit flush firing before React
    // commits this state update still sees the latest keystroke, not a stale value.
    answersRef.current[curKey] = v;
    // 草稿自动保存（防抖 800ms；已提交的 slot 不再写草稿）。
    if (submittedKeys.has(curKey)) return;
    const key = curKey;
    const questionId = cur.question_id;
    const partRef = cur.part_ref;
    if (saveTimers.current[key]) clearTimeout(saveTimers.current[key]);
    // Drop the key when the debounce fires so saveTimers.current holds ONLY not-yet-fired
    // saves. Otherwise an already-autosaved slot stays "pending" and the exit/pagehide
    // flush re-saves it — a redundant PUT whose transient failure would falsely report
    // unsavedFailures, the exact opposite of the honesty this fix is for.
    saveTimers.current[key] = setTimeout(() => {
      delete saveTimers.current[key];
      void runSave(key, questionId, partRef, v);
    }, 800);
  };

  const goPos = (n: number) => {
    setConfirm(false);
    setPos(Math.max(0, Math.min(slots.length - 1, n)));
  };

  const submitAll = async () => {
    const sid = sessionRef.current;
    // Mutual exclusion with exitPaper (submittingRef/exitingRef are synchronous): a submit and
    // an exit must not both fire a terminal transition.
    if (!sid || submittingRef.current || exitingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    // Claim the terminal transition before any network request so pagehide cannot
    // race a completion attempt with a competing pause PATCH.
    sessionOpenRef.current = false;
    let completionCommitted = false;
    try {
      for (const s of slots) {
        if (submittedKeys.has(slotKey(s))) continue;
        await submitPaperSlot(artifactId, {
          session_id: sid,
          question_id: s.question_id,
          part_ref: s.part_ref,
          answer_md: answers[slotKey(s)] ?? '',
        });
      }
      await endPaperSession(sid);
      completionCommitted = true;
      // Every slot is now submitted — no draft can still be unsaved, so drop any lingering
      // failure flags (and pending debounces) rather than leave the retry chip stuck.
      setSaveFailed({});
      for (const k of Object.keys(saveTimers.current)) {
        clearTimeout(saveTimers.current[k]);
        delete saveTimers.current[k];
      }
      await qc.invalidateQueries({ queryKey: ['paper', artifactId] });
      onSubmitted();
    } catch (e) {
      // The page is still alive, so let a retry or explicit exit own the session.
      if (!completionCommitted) sessionOpenRef.current = true;
      addToast(`交卷失败：${(e as Error).message}`, 'info', 'alert');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="pfp" data-screen-label={`卷模式 · ${artifactId}`}>
      <div className="pfp-top">
        <Btn
          size="sm"
          variant="ghost"
          icon="arrowL"
          onClick={exitPaper}
          disabled={exiting || submitting}
        >
          {exiting ? '保存中…' : anySaveFailed ? '退出' : '退出 · 进度保留'}
        </Btn>
        <span className="pfp-title">{detail.title}</span>
        {anySaveFailed ? (
          <button
            type="button"
            className="pfp-saved is-failed"
            onClick={retryFailedSaves}
            disabled={retrying}
          >
            <LoomIcon name="alert" size={12} />
            {retrying ? '重试中…' : '保存失败 · 重试'}
          </button>
        ) : (
          <span className="pfp-saved">
            <LoomIcon name="check" size={12} />
            草稿自动保存
          </span>
        )}
      </div>

      <div className="pfp-buffer">
        <LoomIcon name="clock" size={14} className="ico" />
        <span>反馈缓冲：这张卷不给即时对错——交卷后统一判分。和散题的节奏是反着的，刻意的。</span>
      </div>

      <div className="pfp-pips" role="tablist" aria-label="题目导航">
        {slots.map((s, i) => {
          const has = (answers[slotKey(s)] ?? '').trim().length > 0;
          return (
            <button
              type="button"
              key={slotKey(s)}
              role="tab"
              aria-selected={i === pos}
              className={`pfp-pip${i === pos ? ' current' : ''}${has ? ' answered' : ''}`}
              onClick={() => goPos(i)}
            >
              {i + 1}
            </button>
          );
        })}
      </div>

      <Card pad="lg">
        <div className="nowrap-meta" style={{ marginBottom: 'var(--s-2)' }}>
          <span className="meta mono">
            {cur.question_id.slice(0, 12)} · {pos + 1}/{slots.length}
          </span>
        </div>
        <div className="pfs-stem">{cur.question.prompt_md}</div>

        {isChoice ? (
          <div className="pfs-opts" role="radiogroup" aria-label="选项">
            {(cur.question.choices_md ?? []).map((c, i) => (
              <button
                type="button"
                key={c}
                // biome-ignore lint/a11y/useSemanticElements: 设计稿卡片式选项
                // （pfs-opt 布局）；native <input type="radio"> 无法承载该布局，
                // 真 <button> + radiogroup ARIA 模式语义完整（同 PracticeChoiceOptions）。
                role="radio"
                aria-checked={answers[curKey] === c}
                className={`pfs-opt${answers[curKey] === c ? ' is-sel' : ''}`}
                disabled={submittedKeys.has(curKey) || exiting}
                onClick={() => setAnswer(c)}
              >
                <span className="k mono">{String.fromCharCode(65 + i)}</span>
                <span className="t">{c}</span>
              </button>
            ))}
          </div>
        ) : (
          <div style={{ marginTop: 'var(--s-5)' }}>
            <div className="composer answer-composer">
              <textarea
                rows={3}
                value={answers[curKey] ?? ''}
                disabled={submittedKeys.has(curKey) || exiting}
                placeholder="写下你的解答。交卷前都可以改。"
                onChange={(e) => setAnswer(e.target.value)}
                aria-label="作答"
              />
            </div>
          </div>
        )}
      </Card>

      <div className="pfp-foot">
        <Btn
          size="sm"
          variant="secondary"
          icon="arrowL"
          disabled={pos === 0}
          onClick={() => goPos(pos - 1)}
        >
          上一题
        </Btn>
        <Btn
          size="sm"
          variant="secondary"
          iconEnd="arrow"
          disabled={pos === slots.length - 1}
          onClick={() => goPos(pos + 1)}
        >
          下一题
        </Btn>
        <span className="pfp-count tnum">
          已答 {answeredCount} / {slots.length}
        </span>
        {confirm ? (
          <span className="nowrap-meta">
            <span className="meta">还有 {unanswered} 题空着——仍要交？</span>
            <Btn
              size="sm"
              variant="primary"
              icon="send"
              disabled={submitting || exiting}
              onClick={() => void submitAll()}
            >
              {submitting ? '判分中…' : '交卷'}
            </Btn>
            <Btn size="sm" variant="ghost" onClick={() => setConfirm(false)}>
              再看看
            </Btn>
          </span>
        ) : (
          <Btn
            size="sm"
            variant="primary"
            icon="send"
            disabled={submitting || exiting}
            onClick={() => (unanswered > 0 ? setConfirm(true) : void submitAll())}
          >
            {submitting ? '判分中…' : '交卷 · 统一判分'}
          </Btn>
        )}
      </div>
      <div className="key-hints mono" style={{ marginTop: 'var(--s-3)' }}>
        {anySaveFailed
          ? '有草稿没保存上——退出前先点「保存失败 · 重试」'
          : '中途退出进度保留 · 交卷后到复盘看逐题判定'}
      </div>
    </div>
  );
}
