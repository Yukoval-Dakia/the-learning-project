import type { ResponseSetT, SlotResponseT } from '@/core/schema/assessment';
// M2 练习面 — 卷模式（YUK-316）。
// 设计基准 docs/design/loom-refresh/project/pface-paper.jsx：§6.4 缓冲反馈——
// 作答全程零语义色（pip 只有「已答」的中性墨点），颜色在交卷瞬间才进场。
// 后端语义：草稿 PUT answer 自动保存；「交卷」= 未提交 slot 逐个 POST submit
//（judge-now-show-later，visible_to_user=false 缓冲）+ session end → 可见性解锁。

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import { REASONING_TRACE_MAX_LEN } from '@/kernel/limits';
import { AssetEvidencePreview } from '@/ui/components/response/AssetEvidencePreview';
import { ChoiceSetResponse } from '@/ui/components/response/ChoiceSetResponse';
import { EvaluationGroupPanel } from '@/ui/components/response/EvaluationGroupPanel';
import { EvidenceComposer } from '@/ui/components/response/EvidenceComposer';
// YUK-1051 — 卷面作答换成通用 response 组件族。§6.4 缓冲反馈：作答全程零语义色
// （ChoiceSetResponse 恒 feedback='none'，对错色只在交卷后的复盘出现）；草稿附件
// 走既有 image_refs wire（服务端早已接受，UI 此前丢弃）。
import { ResponseSlotField, nativeSlotFieldSpec } from '@/ui/components/response/ResponseSlotField';
import {
  type EvidenceAttachment,
  isSlotResponseAnswered,
  nativeResponseEntry,
  nativeResponseText,
  nativeResponseValue,
  optionsFromChoicesMd,
} from '@/ui/components/response/response-types';
import { SaveStateChip } from '@/ui/components/response/SaveStateChip';
import { SelfConfidenceField } from '@/ui/components/response/SelfConfidenceField';
import { StimulusFigure } from '@/ui/components/response/StimulusFigure';
import { usePagehideTransition } from '@/ui/hooks/usePagehideTransition';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { Btn } from '@/ui/primitives/Btn';
import { Card } from '@/ui/primitives/Card';
import { LoomIcon } from '@/ui/primitives/LoomIcon';

// YUK-784 — 采集判据与装配复用 PfSolo 先例（YUK-444 / #1069），不在本面重写判据：
// shouldOfferProcessBox 决定过程框挂不挂，buildCaptureFields 负责 trim 判空 + 防御性截断
// +「空值不发字段」。组件→组件引用，同 PfSolo 引 PfStream.PfSrcBadge 的先例。
import { buildCaptureFields, shouldOfferProcessBox } from './PfSolo';
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

// YUK-1051 — 证据绑定范围展开：slot_ids null = 整组（每个 slot 都带）；子集 = 仅列出的
// slot 带。草稿与提交共用同一展开（作答证据与判分引用同版资产，不多不少）。
export function evidenceIdsForSlot(evidence: readonly EvidenceAttachment[], key: string): string[] {
  return evidence
    .filter((a) => a.slot_ids === null || a.slot_ids.includes(key))
    .map((a) => a.asset_id);
}

// YUK-1051 — 草稿恢复：wire 只存各 slot 的 image_refs（绑定范围不持久化在旧契约里），
// 重建规则：出现在**每个** slot 的 id → 整组（null）；否则绑定到它出现的那些 slot。
// 恢复结果保守（宁可整组不丢证据），且绝不新造 wire 上没有的 asset id。
export function restoreEvidenceFromSlots(slots: readonly PaperSlot[]): EvidenceAttachment[] {
  const allKeys = slots.map(slotKey);
  const seen = new Map<string, string[]>();
  for (const s of slots) {
    const key = slotKey(s);
    const refs = s.assessment
      ? s.assessment.group_evidence.map((item) => item.evidence.asset.asset_id)
      : (s.slot_state.submission?.answer_image_refs ?? s.slot_state.draft?.image_refs ?? []);
    for (const id of refs) {
      const list = seen.get(id);
      if (list) list.push(key);
      else seen.set(id, [key]);
    }
  }
  return [...seen.entries()].map(([asset_id, keys]) => {
    const original = slots
      .flatMap((slot) => slot.assessment?.group_evidence ?? [])
      .find((item) => item.evidence.asset.asset_id === asset_id)?.evidence;
    return {
      asset_id,
      ...(original ? { original } : {}),
      // kind 留给 AssetEvidencePreview 按 content-type 解析（不猜）。
      slot_ids: allKeys.length > 0 && keys.length === allKeys.length ? null : keys,
    };
  });
}

const PAPER_TIMING_STORAGE_VERSION = 1;
const PAPER_TIMING_STORAGE_PREFIX = 'pf-paper-timing:v1';

type PaperTimingState = {
  version: 1;
  session_id: string;
  paper_id: string;
  slots: Record<string, number>;
};

function safeTimingMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function timingStorageKey(sessionId: string, paperId: string): string {
  return `${PAPER_TIMING_STORAGE_PREFIX}:${sessionId}:${paperId}`;
}

function readPaperTiming(sessionId: string, paperId: string): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(timingStorageKey(sessionId, paperId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PaperTimingState>;
    if (
      parsed.version !== PAPER_TIMING_STORAGE_VERSION ||
      parsed.session_id !== sessionId ||
      parsed.paper_id !== paperId ||
      !parsed.slots ||
      typeof parsed.slots !== 'object'
    )
      return {};
    return Object.fromEntries(
      Object.entries(parsed.slots).flatMap(([key, value]) => {
        const ms = safeTimingMs(value);
        return ms === null ? [] : [[key, ms]];
      }),
    );
  } catch {
    return {};
  }
}

function writePaperTiming(sessionId: string, paperId: string, slots: Record<string, number>): void {
  try {
    const persisted = readPaperTiming(sessionId, paperId);
    const reconciled = { ...slots };
    for (const [key, value] of Object.entries(persisted)) {
      reconciled[key] = Math.max(reconciled[key] ?? 0, value);
    }
    window.localStorage.setItem(
      timingStorageKey(sessionId, paperId),
      JSON.stringify({
        version: PAPER_TIMING_STORAGE_VERSION,
        session_id: sessionId,
        paper_id: paperId,
        slots: reconciled,
      }),
    );
  } catch {
    // Timing capture is best-effort and must never block answering or submission.
  }
}

function clearPaperTiming(sessionId: string, paperId: string): void {
  try {
    window.localStorage.removeItem(timingStorageKey(sessionId, paperId));
  } catch {
    // A completed paper stays completed even when browser storage is unavailable.
  }
}

// Bounded wait for an in-flight draft to settle on exit before reporting: past this we treat
// the save as unsaved rather than hang the exit indefinitely. A late success only over-warns
// (a conservative, honesty-preserving direction), never a false 「进度保留」.
const EXIT_FLUSH_TIMEOUT_MS = 3000;

// YUK-1489 — a plain save waits at most this long for an earlier save of its slot (the
// pending chained pagehide save, or the slot's own in-flight save). A keepalive request that
// never settles must not hold every later save of the slot; past the cap the save goes out
// at the current epoch. A chain that lands after that is handled by re-saving (runSave).
const CHAIN_WAIT_CAP_MS = 8000;

// Resolves when the save settles or the cap passes, whichever comes first (never rejects).
function chainOrCap(save: Promise<boolean>): Promise<{ timedOut: boolean }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), CHAIN_WAIT_CAP_MS);
    void save.then(() => {
      clearTimeout(timer);
      resolve({ timedOut: false });
    });
  });
}

// 草稿初值：服务端 draft / 已提交 answer 回填（一次作答 visit 挂载时取一次）。
function restorePaperDraft(slots: readonly PaperSlot[]) {
  const answers: Record<string, string> = {};
  const nativeResponses: Record<string, ResponseSetT> = {};
  const nativeEpochs: Record<string, number> = {};
  for (const slot of slots) {
    const key = slotKey(slot);
    answers[key] = slot.slot_state.submission?.answer_md ?? slot.slot_state.draft?.content_md ?? '';
    if (slot.assessment) {
      nativeResponses[key] = slot.assessment.response_set;
      nativeEpochs[key] = slot.assessment.save_epoch;
    }
  }
  // YUK-1051 — 证据附件回填（草稿 image_refs / 已提交 answer_image_refs）。
  return { answers, nativeResponses, nativeEpochs, evidence: restoreEvidenceFromSlots(slots) };
}

interface PfPaperProps {
  artifactId: string;
  // unsavedFailures lets the host tell an honest exit story: 0 → 「进度已保留」, >0 → a
  // non-blaming 「有 N 处草稿未保存」instead of a false success promise.
  onExit: (info?: { unsavedFailures: number }) => void;
  onSubmitted: () => void;
  addToast: (text: string, tone?: PfToast['tone'], icon?: string) => void;
}

// YUK-1483 — the host keys PfPaper by artifactId, and this component keys one answering
// visit by the paper's native occurrence. A new paper or a new occurrence therefore starts
// from a fresh visit (empty timers, restored drafts, new session handling) instead of an
// effect resetting a reused one; the old visit's late save results land on an unmounted
// visit and cannot touch the new one. Background refetches of the same occurrence keep
// the visit and never overwrite local edits.
export function PfPaper(props: PfPaperProps) {
  const { artifactId, onExit } = props;
  const detailQ = useQuery({
    queryKey: ['paper', artifactId],
    queryFn: () => getPaperDetail(artifactId),
  });
  const detail: PaperDetail | null = detailQ.data ?? null;
  const slots = useMemo(() => detail?.sections.flatMap((s) => s.slots) ?? [], [detail]);
  const nativeOccurrenceId = slots[0]?.assessment?.issuance_id;
  // A same-paper occurrence replaced by another (X → Y) invalidates the stored timing for
  // the session; the next visit clears it before reading. Render-time state adjustment.
  const [occurrence, setOccurrence] = useState({ id: nativeOccurrenceId, replaced: false });
  if (occurrence.id !== nativeOccurrenceId) {
    setOccurrence({
      id: nativeOccurrenceId,
      replaced: occurrence.id !== undefined && nativeOccurrenceId !== undefined,
    });
  }

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
  return (
    <PaperVisit
      key={nativeOccurrenceId ?? ''}
      {...props}
      detail={detail}
      slots={slots}
      clearStaleTiming={occurrence.replaced}
    />
  );
}

function PaperVisit({
  artifactId,
  onExit,
  onSubmitted,
  addToast,
  detail,
  slots,
  clearStaleTiming,
}: PfPaperProps & {
  detail: PaperDetail;
  slots: PaperSlot[];
  clearStaleTiming: boolean;
}) {
  const qc = useQueryClient();
  const hasNativeBindings = slots.every((slot) => slot.assessment != null);
  // The visit's restored drafts, computed once at mount (pure).
  const [restored] = useState(() => restorePaperDraft(slots));
  const [pos, setPos] = useState(0);
  // Mirror of `pos` for listeners and the session-ready callback; written by goPos.
  const posRef = useRef(0);
  const [answers, setAnswers] = useState<Record<string, string>>(restored.answers);
  const [nativeResponses, setNativeResponses] = useState<Record<string, ResponseSetT>>(
    restored.nativeResponses,
  );
  const nativeResponsesRef = useRef<Record<string, ResponseSetT>>(restored.nativeResponses);
  const nativeEpochs = useRef<Record<string, number>>({ ...restored.nativeEpochs });
  // YUK-1051 — 卷级证据附件（整页解题照默认绑定整个 evaluation group=本卷；可在
  // EvaluationGroupPanel 改绑子集）。slot 草稿/提交的 image_refs 从这里按绑定范围展开。
  const [evidence, setEvidence] = useState<EvidenceAttachment[]>(restored.evidence);
  // YUK-1094 — 附件上传中：交卷入口并入 upload-pending（disable），否则交卷会以旧 evidence
  // 展开 image_refs（刚上传的附件丢掉）。由 EvidenceComposer 的 onUploadingChange 上报。
  const [uploading, setUploading] = useState(false);
  // answersRef 同款的同步镜像：pagehide/退出 flush 读 ref（渲染闭包可能滞后一拍）。
  // Written by the evidence handlers together with setEvidence.
  const evidenceRef = useRef<EvidenceAttachment[]>(restored.evidence);
  // YUK-784 — 过程框采集：per-slot 过程文本与展开态（组卷面多题连续作答，切换不丢；
  // 交卷时随该 slot 的提交一并发出）。不进草稿自动保存——answer-draft wire 无此字段，
  // 中途退出会丢过程文本，这是已知且诚实的取舍（采集是可选 meta，不值得为此扩草稿契约）。
  const [trace, setTrace] = useState<Record<string, string>>({});
  const [traceOpen, setTraceOpen] = useState<Record<string, boolean>>({});
  // Owner decision Q-922: optional 1–5 self-confidence is per question (not per paper).
  // Observe-only metadata: it never affects judging, rating, or FSRS. The value is carried
  // through the paper submission wire (submitPaperSlot → buildPaperSubmissionBody
  // self_confidence) and lands on AttemptOnQuestion.payload.self_confidence at submit time.
  // Absent when untouched → byte-identical for slots the learner did not self-rate.
  const [selfConfidence, setSelfConfidence] = useState<Record<string, number>>({});
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
  // Per visit: another paper or occurrence is a new visit with its own counters, so a save
  // that outlives its visit can only touch the unmounted one.
  const saveSeq = useRef<Record<string, number>>({});
  // 已有 session 复用；没有则在 visit 挂上页面时开卷（见 attachVisit）。
  const sessionRef = useRef<string | null>(detail.session?.id ?? null);
  const sessionOpenRef = useRef(
    detail.session ? ['started', 'paused'].includes(detail.session.status) : false,
  );
  // This visit's single startPaperSession request (reused if React re-attaches the visit).
  const sessionStart = useRef<Promise<void> | null>(null);
  const staleTimingCleared = useRef(false);
  // Per-slot debounce timers. A shared timer would let typing in slot B cancel slot A's
  // pending save, silently dropping A's last keystrokes while the UI still claims saved.
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Draft saves dispatched but not yet settled (latest promise per slot key). The debounce
  // timer is deleted the instant it fires, so without this an exit during the in-flight POST
  // window would see no pending timer and neither await nor keepalive-resend the save — a
  // slow-net / teardown cancel would then be reported as 「进度保留」. Cleared per paper.
  const inFlightSaves = useRef<Map<string, Promise<boolean>>>(new Map());
  // YUK-1487 — the pending chained (pagehide) save per slot; deleted when it settles. At most
  // one per slot: two chains at the same acked + 1 could land oldest-last.
  const chainedSaves = useRef<Record<string, Promise<boolean> | undefined>>({});
  // YUK-1489 — chains a plain save stopped waiting for (cap passed). Each gets one re-save.
  const cappedChains = useRef(new WeakSet<Promise<boolean>>());
  // Guards exitPaper against a double-click during its flush/settle window (up to
  // EXIT_FLUSH_TIMEOUT_MS): the ref blocks re-entry synchronously (so two clicks in one tick
  // can't both call onExit); `exiting` disables the button so a second click can't even fire.
  const exitingRef = useRef(false);
  const [exiting, setExiting] = useState(false);
  // Mirror of `answers`, updated synchronously on every keystroke. The pagehide/exit flush
  // reads THIS, not the render-closure `answers` (which can lag the final keystroke by a
  // frame), so the last typed text is never flushed as a stale/empty value.
  const answersRef = useRef<Record<string, string>>({ ...restored.answers });
  // Mutual exclusion with exitPaper: a submit and an exit must not both fire a terminal
  // transition (double onSubmitted/onExit). Synchronous, like exitingRef.
  const submittingRef = useRef(false);
  const timingMsRef = useRef<Record<string, number>>({});
  const timingSegmentRef = useRef<{ key: string; startedAt: number } | null>(null);
  const submittedDuringAttemptsRef = useRef<Set<string>>(new Set());
  const componentActiveRef = useRef(false);

  const persistTiming = useCallback(() => {
    const sid = sessionRef.current;
    if (sid) writePaperTiming(sid, artifactId, timingMsRef.current);
  }, [artifactId]);

  const stopTimingSegment = useCallback(() => {
    const segment = timingSegmentRef.current;
    if (!segment) return;
    timingSegmentRef.current = null;
    const elapsed = Math.max(0, Math.trunc(performance.now() - segment.startedAt));
    timingMsRef.current[segment.key] = Math.min(
      Number.MAX_SAFE_INTEGER,
      (timingMsRef.current[segment.key] ?? 0) + elapsed,
    );
    persistTiming();
  }, [persistTiming]);

  const startTimingSegment = useCallback((key: string, submitted: boolean) => {
    if (submitted || document.visibilityState === 'hidden') return;
    timingSegmentRef.current = { key, startedAt: performance.now() };
  }, []);

  // The freshest slots for listeners and the session-ready callback: the cached detail
  // (same occurrence; this visit is replaced when the occurrence changes), else the
  // slots this visit mounted with.
  const [mountSlots] = useState(slots);
  const latestSlots = useCallback((): PaperSlot[] => {
    const cached = qc.getQueryData<PaperDetail>(['paper', artifactId]);
    const fromCache = cached?.sections.flatMap((s) => s.slots) ?? [];
    return fromCache.length > 0 ? fromCache : mountSlots;
  }, [qc, artifactId, mountSlots]);

  // Open the timing segment for the slot on screen (submitted slots are not timed).
  const startCurrentSegment = useCallback(() => {
    const current = latestSlots();
    const slot = current[Math.min(posRef.current, current.length - 1)];
    if (slot) startTimingSegment(slotKey(slot), Boolean(slot.slot_state.submission?.submitted));
  }, [latestSlots, startTimingSegment]);

  // Session known: load its stored timing (cleared first when this visit replaced another
  // occurrence of the same paper), drop submitted slots' time, and start timing the slot
  // on screen.
  const beginTiming = useCallback(
    (sessionId: string) => {
      if (clearStaleTiming && !staleTimingCleared.current) {
        staleTimingCleared.current = true;
        clearPaperTiming(sessionId, artifactId);
      }
      timingMsRef.current = readPaperTiming(sessionId, artifactId);
      for (const slot of latestSlots()) {
        if (slot.slot_state.submission?.submitted) delete timingMsRef.current[slotKey(slot)];
      }
      persistTiming();
      startCurrentSegment();
    },
    [clearStaleTiming, artifactId, latestSlots, persistTiming, startCurrentSegment],
  );

  // YUK-1483 — the visit's root element owns the visit's browser resources, replacing the
  // old mount/session/timing/visibility effects:
  //   - attach: mark active; reuse the paper's session or open one (once per visit — a
  //     re-attach reuses the same request, an accepted open is never re-POSTed); start
  //     timing; listen for visibility changes (hidden pauses timing, visible resumes it).
  //   - detach: mark inactive, close the timing segment (its time is persisted once) and
  //     drop unfired debounces. Detach never claims an unacknowledged draft was saved;
  //     explicit exit and pagehide keep their own flush and failure counting.
  const attachVisit = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return undefined;
      componentActiveRef.current = true;
      const sid = sessionRef.current;
      if (sid) beginTiming(sid);
      else
        sessionStart.current ??= startPaperSession(artifactId).then(
          (r) => {
            sessionRef.current = r.session_id;
            sessionOpenRef.current = true;
            if (componentActiveRef.current) beginTiming(r.session_id);
            else timingMsRef.current = readPaperTiming(r.session_id, artifactId);
            void qc.invalidateQueries({ queryKey: ['paper', artifactId] });
          },
          (e) => {
            // The open was not accepted: let a later attach of this visit try again.
            sessionStart.current = null;
            if (componentActiveRef.current)
              addToast(`开卷失败：${(e as Error).message}`, 'info', 'alert');
          },
        );
      const onVisibilityChange = () => {
        if (document.visibilityState === 'hidden') {
          stopTimingSegment();
          return;
        }
        startCurrentSegment();
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
      const timers = saveTimers.current;
      return () => {
        componentActiveRef.current = false;
        document.removeEventListener('visibilitychange', onVisibilityChange);
        stopTimingSegment();
        for (const k of Object.keys(timers)) {
          clearTimeout(timers[k]);
          delete timers[k];
        }
      };
    },
    [artifactId, qc, addToast, beginTiming, startCurrentSegment, stopTimingSegment],
  );

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
  const nativePayloadFor = (key: string) => {
    const bound = slots.find((slot) => slotKey(slot) === key)?.assessment;
    if (!bound) return undefined;
    return {
      issuance_id: bound.issuance_id,
      evaluation_group_id: bound.evaluation_group_id,
      idempotency_key: bound.idempotency_key,
      response_set: nativeResponsesRef.current[key] ?? bound.response_set,
      group_evidence: evidenceRef.current
        .filter((item) => item.slot_ids === null || item.slot_ids.includes(key))
        .flatMap((item) =>
          item.original
            ? [
                {
                  evidence: item.original,
                  target: bound.group_evidence.find(
                    (saved) => saved.evidence.asset.asset_id === item.asset_id,
                  )?.target ?? { scope: 'all_units' as const },
                },
              ]
            : [],
        ),
    };
  };

  const runSave = (
    key: string,
    questionId: string,
    partRef: PaperSlot['part_ref'],
    v: string,
    keepalive = false,
    // YUK-1051 — 该 slot 绑定范围内的证据附件 ids（缺席 = 按当前 evidenceRef 现算）。
    imageRefs?: string[],
    // YUK-1487 — this save supersedes one still in flight (pagehide resend): see draftEpoch.
    chained = false,
  ): Promise<boolean> => {
    const refs = imageRefs ?? evidenceIdsForSlot(evidenceRef.current, key);
    const seq = (saveSeq.current[key] ?? 0) + 1;
    saveSeq.current[key] = seq;
    // Only this visit's newest request for the slot may touch the flag. A save that outlives
    // its visit settles on the unmounted visit and can't rewrite the next paper's state.
    const isLatest = () => saveSeq.current[key] === seq;
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
      // Reads the epoch when it actually sends, so a save queued behind a chain uses its ACK.
      const send = (): Promise<boolean> => {
        try {
          return savePaperAnswer(
            artifactId,
            {
              session_id: sid,
              question_id: questionId,
              part_ref: partRef,
              answer_md: v,
              image_refs: refs,
              assessment: nativePayloadFor(key),
              expected_save_epoch: draftEpoch(key, chained),
            },
            { keepalive },
          )
            .then((ack) => {
              if (ack?.save_epoch !== undefined)
                nativeEpochs.current[key] = Math.max(
                  nativeEpochs.current[key] ?? 0,
                  ack.save_epoch,
                );
              if (isLatest()) setSaveFailed((f) => (f[key] ? { ...f, [key]: false } : f));
              return true;
            })
            .catch((err) => {
              console.error('[PfPaper] draft save failed', { key, err });
              if (isLatest()) setSaveFailed((f) => ({ ...f, [key]: true }));
              return false;
            });
        } catch (err) {
          // savePaperAnswer threw synchronously (e.g. a 401 cleared the token → ApiAuthError
          // before the fetch even starts). Convert it to a resolved failure so no caller — the
          // exit/pagehide flush included — can be stranded on an unhandled throw, and flag the
          // slot so the exit count still records it as unsaved.
          console.error('[PfPaper] draft save threw', { key, err });
          if (isLatest()) setSaveFailed((f) => ({ ...f, [key]: true }));
          return Promise.resolve(false);
        }
      };
      // YUK-1487 — while a chained save for this slot is pending, a plain save waits for it
      // to settle (it never rejects) and then sends at the epoch its ACK left: sent earlier at
      // the old acked epoch, it could land first and let the chain's older text overwrite it.
      // YUK-1489 — it also waits for the slot's own in-flight plain save (so it reads that
      // save's ACK instead of drawing a needless 409), each wait capped at CHAIN_WAIT_CAP_MS.
      // A chain still pending at the cap may land after this save and store its older text
      // over it; when that chain later reports stored, re-save the slot's latest text once —
      // the chain's ACK raised the acked epoch, so the re-save passes and the newest text wins.
      // Not after the visit ended (unmounted, exiting, submitting) or once the slot is
      // submitted: then the draft is no longer this visit's to write.
      const earlier = chained ? undefined : inFlightSaves.current.get(key);
      const waitEarlier = async () => {
        if (earlier && earlier !== chainedSaves.current[key]) await chainOrCap(earlier);
        const pendingChain = chainedSaves.current[key];
        if (!pendingChain) return;
        const { timedOut } = await chainOrCap(pendingChain);
        if (!timedOut || cappedChains.current.has(pendingChain)) return;
        cappedChains.current.add(pendingChain);
        void pendingChain.then((stored) => {
          if (!stored || !componentActiveRef.current) return;
          if (exitingRef.current || submittingRef.current) return;
          const slot = slots.find((s) => slotKey(s) === key);
          if (!slot || slot.slot_state.submission?.submitted) return;
          void runSave(key, slot.question_id, slot.part_ref, answersRef.current[key] ?? '');
        });
      };
      done = (chained ? send() : waitEarlier().then(send)).then(deregister);
      if (chained) {
        const chain = done;
        chainedSaves.current[key] = chain;
        void chain.then(() => {
          if (chainedSaves.current[key] === chain) delete chainedSaves.current[key];
        });
      }
    }
    // Track as in-flight so an exit/pagehide during the POST window can await or re-send it.
    inFlightSaves.current.set(key, done);
    return done;
  };

  // Epoch a draft save expects. A resend chained past an in-flight save sends acked + 1: the
  // server rejects only when stored > expected and stores existing + 1, so whichever of the
  // two lands second, the older text is the one rejected (YUK-1487). Reusing the in-flight
  // epoch would let an in-flight save that lands first reject the newer resend instead.
  const draftEpoch = (key: string, chained: boolean) => {
    const acked = nativeEpochs.current[key];
    return chained && acked !== undefined ? acked + 1 : acked;
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
      chained: boolean;
    }[] = [];
    for (const key of keys) {
      // A chain for this slot is still pending (pagehide again after a bfcache restore): send
      // nothing for it — a second chain could be overwritten by the first. Its timer stays.
      if (opts.includeInFlight && chainedSaves.current[key]) continue;
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
        // Only the pagehide resend chains: two chained saves in flight for one slot could
        // still land oldest-last, so the exit flush keeps its plain epoch.
        chained: opts.includeInFlight === true && inFlightSaves.current.has(key),
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
              image_refs: evidenceIdsForSlot(evidenceRef.current, d.key),
              assessment: nativePayloadFor(d.key),
              expected_save_epoch: draftEpoch(d.key, d.chained),
            }),
          ),
        )
      : dirty.map(() => false);
    dirty.forEach((d, i) => {
      void runSave(
        d.key,
        d.questionId,
        d.partRef,
        d.answer,
        keepaliveFlags[i],
        undefined,
        d.chained,
      );
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
  // still in flight (a normal POST the teardown may cancel); that resend is chained at
  // acked + 1 (draftEpoch) so the older in-flight text cannot win. Then pause the session.
  // YUK-1483: armed by the paper header's ref (always mounted with the visit); it is
  // re-armed with this render's closure on each commit, so it flushes the latest drafts.
  const attachPagehide = usePagehideTransition(() => {
    stopTimingSegment();
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
    stopTimingSegment();
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

  const cur = slots[Math.min(pos, slots.length - 1)];
  const curKey = slotKey(cur);
  const isChoice = (cur.question.choices_md?.length ?? 0) > 0;
  const submittedKeys = new Set(
    slots.filter((s) => s.slot_state.submission?.submitted).map(slotKey),
  );
  // YUK-1051 — stable option ids（内容派生）；作答 pip 的「已答」包含绑定到该 slot 的证据。
  const curOptions = optionsFromChoicesMd(cur.question.choices_md ?? [], cur.question_id);
  const curAnswerText = answers[curKey] ?? '';
  const curSelectedIds = curOptions.filter((o) => o.text_md === curAnswerText).map((o) => o.id);
  const answeredCount = slots.filter(
    (s) =>
      (nativeResponses[slotKey(s)]?.entries.some((entry) =>
        isSlotResponseAnswered(nativeResponseValue(entry)),
      ) ??
        false) ||
      (answers[slotKey(s)] ?? '').trim().length > 0 ||
      evidenceIdsForSlot(evidence, slotKey(s)).length > 0,
  ).length;
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

  // YUK-1051 — 证据附件的增/删/改绑也要触发草稿自动保存（附件变更不经 setAnswer 的
  // 击键 debounce）。只重存绑定范围实际变化的未提交 slot。
  const scheduleEvidenceSave = (changedKeys: Iterable<string>) => {
    for (const key of changedKeys) {
      const slot = slots.find((s) => slotKey(s) === key);
      if (!slot || slot.slot_state.submission?.submitted) continue;
      if (saveTimers.current[key]) clearTimeout(saveTimers.current[key]);
      saveTimers.current[key] = setTimeout(() => {
        delete saveTimers.current[key];
        void runSave(key, slot.question_id, slot.part_ref, answersRef.current[key] ?? '');
      }, 800);
    }
  };

  // EvidenceComposer 的附件列表回调：diff 出增/删，各自按绑定范围调度保存。
  const onEvidenceChange = (next: EvidenceAttachment[]) => {
    const prev = evidenceRef.current;
    const prevById = new Map(prev.map((a) => [a.asset_id, a]));
    const nextIds = new Set(next.map((a) => a.asset_id));
    const added = next.filter((a) => !prevById.has(a.asset_id));
    const removed = prev.filter((a) => !nextIds.has(a.asset_id));
    evidenceRef.current = next;
    setEvidence(next);
    const allOpen = slots.filter((s) => !s.slot_state.submission?.submitted).map(slotKey);
    const affected = new Set<string>();
    for (const a of added) for (const k of a.slot_ids ?? allOpen) affected.add(k);
    for (const a of removed) for (const k of a.slot_ids ?? allOpen) affected.add(k);
    scheduleEvidenceSave(affected);
  };

  // EvaluationGroupPanel 的改绑回调：新旧绑定范围的对称差集内 slot 各重存一轮。
  const onEvidenceRebind = (assetId: string, nextAtt: EvidenceAttachment) => {
    const prevAtt = evidenceRef.current.find((a) => a.asset_id === assetId);
    const next = evidenceRef.current.map((a) => (a.asset_id === assetId ? nextAtt : a));
    evidenceRef.current = next;
    setEvidence(next);
    if (!prevAtt) return;
    const allKeys = slots.map(slotKey);
    const prevScope = prevAtt.slot_ids ?? allKeys;
    const nextScope = nextAtt.slot_ids ?? allKeys;
    const changed = new Set([...prevScope, ...nextScope]);
    scheduleEvidenceSave(changed);
  };

  // Switching question closes the previous question's timing segment (persisting its time
  // once) and opens one for the new question, unless it is already submitted.
  const goPos = (n: number) => {
    setConfirm(false);
    const next = Math.max(0, Math.min(slots.length - 1, n));
    setPos(next);
    if (next === posRef.current) return;
    posRef.current = next;
    stopTimingSegment();
    if (sessionRef.current) startCurrentSegment();
  };

  const submitAll = async () => {
    const sid = sessionRef.current;
    // Mutual exclusion with exitPaper (submittingRef/exitingRef are synchronous): a submit and
    // an exit must not both fire a terminal transition.
    if (!hasNativeBindings || !sid || submittingRef.current || exitingRef.current || uploading)
      return;
    submittingRef.current = true;
    setSubmitting(true);
    stopTimingSegment();
    // Claim the terminal transition before any network request so pagehide cannot
    // race a completion attempt with a competing pause PATCH.
    sessionOpenRef.current = false;
    let completionCommitted = false;
    try {
      for (const s of slots) {
        const key = slotKey(s);
        if (submittedKeys.has(key) || submittedDuringAttemptsRef.current.has(key)) continue;
        // YUK-784 — 该 slot 的过程文本随提交发出（空值/纯空白不发字段，截断在
        // buildCaptureFields；server 侧 conditional-spread 落 AttemptOnQuestion.payload）。
        // YUK-1051 / Q-922 — 同步自评：capture.self_confidence 非空时随该 slot 提交发出，
        // 落同一 attempt payload（observe-only，不进判分）。
        const capture = buildCaptureFields({
          reasoningTrace: trace[key] ?? '',
          selfConfidence: selfConfidence[key] ?? null,
        });
        await submitPaperSlot(artifactId, {
          session_id: sid,
          question_id: s.question_id,
          part_ref: s.part_ref,
          answer_md: answers[key] ?? '',
          assessment: nativePayloadFor(key),
          // YUK-1051 — 该 slot 绑定范围内的证据附件随提交冻结（与草稿同源展开）。
          image_refs: evidenceIdsForSlot(evidenceRef.current, key),
          latency_ms: timingMsRef.current[key] ?? 0,
          ...(capture.reasoning_trace ? { reasoning_trace: capture.reasoning_trace } : {}),
          ...(capture.self_confidence === undefined
            ? {}
            : { self_confidence: capture.self_confidence }),
        });
        submittedDuringAttemptsRef.current.add(key);
      }
      await endPaperSession(sid);
      completionCommitted = true;
      clearPaperTiming(sid, artifactId);
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
      if (!completionCommitted) {
        sessionOpenRef.current = true;
        const current = slots[Math.min(pos, slots.length - 1)];
        if (
          current &&
          componentActiveRef.current &&
          document.visibilityState !== 'hidden' &&
          !submittedKeys.has(slotKey(current)) &&
          !submittedDuringAttemptsRef.current.has(slotKey(current))
        ) {
          startTimingSegment(slotKey(current), false);
        }
      }
      addToast(`交卷失败：${(e as Error).message}`, 'info', 'alert');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="pfp" data-screen-label={`卷模式 · ${artifactId}`} ref={attachVisit}>
      <div className="pfp-top" ref={attachPagehide}>
        <Btn
          size="sm"
          variant="ghost"
          icon="arrowL"
          onClick={exitPaper}
          disabled={exiting || submitting}
        >
          {exiting ? '保存中…' : anySaveFailed || !hasNativeBindings ? '退出' : '退出 · 进度保留'}
        </Btn>
        <span className="pfp-title">{detail.title}</span>
        {/* YUK-1051 — 保存状态 chip 换成组件族 SaveStateChip（同文案/同重试交互）；
            saved 仅在 server ack 后出现的纪律由组件族承载。 */}
        {hasNativeBindings && (
          <SaveStateChip
            state={anySaveFailed ? 'error' : 'idle'}
            onRetry={anySaveFailed ? retryFailedSaves : undefined}
            retrying={retrying}
          />
        )}
      </div>

      <div className="pfp-buffer">
        <LoomIcon name="clock" size={14} className="ico" />
        <span>
          {hasNativeBindings
            ? '反馈缓冲：这张卷不给即时对错——交卷后统一判分。和散题的节奏是反着的，刻意的。'
            : detail.session
              ? '这份历史试卷缺少原始发题记录，当前只能查看。'
              : '正在准备题目，请稍候。'}
        </span>
      </div>

      <div className="pfp-pips" role="tablist" aria-label="题目导航">
        {slots.map((s, i) => {
          // YUK-1051 — pip 的「已答」中性墨点也把绑定到该 slot 的证据算上（仍零语义色）。
          const has =
            (nativeResponses[slotKey(s)]?.entries.some((entry) =>
              isSlotResponseAnswered(nativeResponseValue(entry)),
            ) ??
              false) ||
            (answers[slotKey(s)] ?? '').trim().length > 0 ||
            evidenceIdsForSlot(evidence, slotKey(s)).length > 0;
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
        {/* YUK-1051 — 结构化配图/共享材料与题面同版渲染（wire image_refs 恢复后）。 */}
        {cur.assessment ? (
          <>
            {cur.assessment.practice_dto.materials.map((material) => (
              <div key={material.material_id}>
                {material.content_md !== undefined ? (
                  <MathMarkdown notation={cur.question.notation}>
                    {material.content_md}
                  </MathMarkdown>
                ) : (
                  <AssetEvidencePreview
                    assetId={material.asset_id}
                    label={material.caption ?? material.alt_text}
                  />
                )}
              </div>
            ))}
            {cur.assessment.practice_dto.faces.map((face) => (
              <MathMarkdown
                key={face.part_id}
                notation={cur.question.notation}
                className="pfs-stem"
              >
                {face.prompt_md}
              </MathMarkdown>
            ))}
          </>
        ) : (
          <>
            {(cur.question.image_refs ?? []).map((assetId) => (
              <StimulusFigure key={assetId} assetId={assetId} />
            ))}
            <MathMarkdown notation={cur.question.notation} className="pfs-stem">
              {cur.question.prompt_md}
            </MathMarkdown>
          </>
        )}

        {/* YUK-1051 — 作答控件换组件族。§6.4 缓冲反馈：恒 feedback='none'，作答全程
            零对错色（导航 pip 只有「已答」中性墨点）；对错色只属于交卷后的 PfRetro。 */}
        {cur.assessment ? (
          <>
            {cur.assessment.practice_dto.response_spec.slots.map((slot) => {
              const spec = nativeSlotFieldSpec(slot);
              if (!spec) return null;
              const entry = nativeResponses[curKey]?.entries.find(
                (item) => item.slot_id === slot.slot_id,
              );
              return (
                <ResponseSlotField
                  key={slot.slot_id}
                  spec={spec}
                  value={nativeResponseValue(entry)}
                  label={slot.placement?.label}
                  notation={cur.question.notation}
                  feedback="none"
                  ariaLabel={slot.placement?.label ?? '作答'}
                  disabled={!hasNativeBindings || submittedKeys.has(curKey) || exiting}
                  onChange={(value) => {
                    const updated: SlotResponseT = nativeResponseEntry(slot, value, entry);
                    const response: ResponseSetT = {
                      entries: [
                        ...(nativeResponsesRef.current[curKey]?.entries ?? []).filter(
                          (item) => item.slot_id !== slot.slot_id,
                        ),
                        updated,
                      ],
                    };
                    nativeResponsesRef.current = {
                      ...nativeResponsesRef.current,
                      [curKey]: response,
                    };
                    setNativeResponses(nativeResponsesRef.current);
                    setAnswer(
                      response.entries
                        .map((item) =>
                          nativeResponseText(
                            item,
                            cur.assessment?.practice_dto.response_spec.slots.find(
                              (field) => field.slot_id === item.slot_id,
                            ),
                          ),
                        )
                        .join('\n'),
                    );
                  }}
                />
              );
            })}
            <EvidenceComposer
              text=""
              onTextChange={() => {}}
              showText={false}
              attachments={evidence}
              onAttachmentsChange={onEvidenceChange}
              disabled={!hasNativeBindings || submittedKeys.has(curKey) || exiting}
              onUploadingChange={setUploading}
              slotLabels={Object.fromEntries(
                slots.map((slot, i) => [slotKey(slot), `第 ${i + 1} 题`]),
              )}
            />
          </>
        ) : isChoice ? (
          <ChoiceSetResponse
            options={curOptions}
            mode="single"
            // null = 未作答；草稿文本与选项对不上（遗留数据）→ [] 显式空集合，不假装选中。
            value={curAnswerText ? curSelectedIds : null}
            onChange={(ids) => {
              const opt = curOptions.find((o) => o.id === ids[0]);
              setAnswer(opt?.text_md ?? '');
            }}
            disabled={!hasNativeBindings || submittedKeys.has(curKey) || exiting}
            notation={cur.question.notation}
            feedback="none"
            ariaLabel="选项"
          />
        ) : (
          // 开放作答：通用文字 + 卷级证据附件（默认绑定整组=本卷 evaluation group，
          // 子集在下方 EvaluationGroupPanel 可改）。
          <EvidenceComposer
            text={answers[curKey] ?? ''}
            onTextChange={setAnswer}
            attachments={evidence}
            onAttachmentsChange={onEvidenceChange}
            disabled={!hasNativeBindings || submittedKeys.has(curKey) || exiting}
            notation={cur.question.notation}
            placeholder="写下你的解答。交卷前都可以改。"
            ariaLabel="作答"
            slotLabels={Object.fromEntries(slots.map((s, i) => [slotKey(s), `第 ${i + 1} 题`]))}
            onUploadingChange={setUploading}
          />
        )}
        {hasNativeBindings &&
          !isChoice &&
          evidence.length > 0 &&
          !submittedKeys.has(curKey) &&
          !exiting && (
            <EvaluationGroupPanel
              slots={slots.map((s, i) => ({ id: slotKey(s), label: `第 ${i + 1} 题` }))}
              attachments={evidence}
              onAttachmentChange={onEvidenceRebind}
            />
          )}

        {/* YUK-784 — 过程框「记下你的思路」扩到组卷面（镜像 PfSolo #1069 先例）：仅开放/文本
            作答题（shouldOfferProcessBox 复用，不重写判据）、默认折叠 opt-in、零强制——不挡
            交卷、折叠即跳过、空值不发字段（submitAll 里 buildCaptureFields trim 判空）。与散题
            不同点：组卷面多题连续作答，采集是 per-slot 状态，换题不丢，交卷时随各自 slot 发出。
            已提交 slot / 退出 flush 期间不渲染（作答面已冻结，采集无处可挂）。 */}
        {hasNativeBindings &&
          shouldOfferProcessBox(isChoice) &&
          !submittedKeys.has(curKey) &&
          !exiting && (
            <div className="pfs-trace">
              {traceOpen[curKey] ? (
                <div className="composer pfs-trace-composer">
                  <textarea
                    rows={2}
                    value={trace[curKey] ?? ''}
                    // 硬闸同 PfSolo：maxLength 挡越界输入撞 400 软死锁，buildCaptureFields
                    // 发送前再防御性截断兜底粘贴/IME 绕过。
                    maxLength={REASONING_TRACE_MAX_LEN}
                    placeholder="随手记下你是怎么想的——不评分，也可以留空。"
                    onChange={(e) => setTrace((t) => ({ ...t, [curKey]: e.target.value }))}
                    aria-label="解题思路（可选）"
                  />
                </div>
              ) : (
                <button
                  type="button"
                  className="pfs-trace-toggle"
                  onClick={() => setTraceOpen((o) => ({ ...o, [curKey]: true }))}
                >
                  ＋ 记下你的思路（可选）
                </button>
              )}
            </div>
          )}
        {hasNativeBindings && !submittedKeys.has(curKey) && !exiting && (
          <SelfConfidenceField
            value={selfConfidence[curKey]}
            onChange={(next) =>
              setSelfConfidence((values) => {
                if (next === null) {
                  const copy = { ...values };
                  delete copy[curKey];
                  return copy;
                }
                return { ...values, [curKey]: next };
              })
            }
            ariaLabel={`第 ${pos + 1} 题信心自评`}
          />
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
              disabled={!hasNativeBindings || submitting || exiting || uploading}
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
            disabled={!hasNativeBindings || submitting || exiting || uploading}
            onClick={() => (unanswered > 0 ? setConfirm(true) : void submitAll())}
          >
            {submitting ? '判分中…' : '交卷 · 统一判分'}
          </Btn>
        )}
      </div>
      <div className="key-hints mono" style={{ marginTop: 'var(--s-3)' }}>
        {!hasNativeBindings
          ? '历史作答保留，当前不可提交。'
          : anySaveFailed
            ? '有草稿没保存上——退出前先点「保存失败 · 重试」'
            : '中途退出进度保留 · 交卷后到复盘看逐题判定'}
      </div>
    </div>
  );
}
