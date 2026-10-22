// YUK-1473 — the practice submission engine, shared by every view of one stream item.
// Extracted unchanged from the old PfSolo view (YUK-1483/1484/1485/1487/1489). Its view is now
// the practice page (solo/PracticeSolo.tsx); PfPaper shares only buildCaptureFields and
// shouldOfferProcessBox. The hook owns everything that is not drawing: the issuance command,
// the draft and its restore, autosave (conflict hold, keepalive pagehide flush), the draft
// conflict choice, 「返回流」 with its 8s cap, judge/submit/appeal, the 202-pending poll,
// the self-rated mode, and two window listeners owned by ref callbacks. A view renders from
// the returned state and wires the returned actions and ref callbacks; it never re-implements
// any of them.

import { queryOptions, useQuery } from '@tanstack/react-query';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ResponseSetT, SlotResponseT } from '@/core/schema/assessment';
import { PartialUnknownJudgeResult } from '@/core/schema/capability';
import { REASONING_TRACE_MAX_LEN } from '@/kernel/limits';
import {
  type EvidenceAttachment,
  isSlotResponseAnswered,
  nativeResponseText,
  nativeResponseValue,
} from '@/ui/components/response/response-types';
import { type JudgeRunPollingState, useJudgeRunPolling } from '@/ui/hooks/useJudgeRunPolling';
import { usePagehideTransition } from '@/ui/hooks/usePagehideTransition';
import { useResponseDraftAutosave } from '@/ui/hooks/useResponseDraftAutosave';
import { ApiError } from '@/ui/lib/api';
import { toAttemptTimelineEvents } from './attempt-timeline-adapter';
import { useCustomBlocksReady } from './blocks/CustomBlock';
import { customBlocksOf, summarizeAnswers } from './blocks/custom-sandbox';
import { boundSlots, entriesForSubmit } from './blocks/envelope';
import { type EntriesUpdate, parsePresentation } from './blocks/PresentationBlocks';
import type { PfToast } from './PracticeFacePage';
import {
  type JudgePreview,
  type QuestionFullDetail,
  type StreamItem,
  type SubmitResult,
  type SubmitReviewInput,
  computeLatencyMs,
  fileAppeal,
  getAdvice,
  getIssuanceState,
  getQuestionFull,
  isSubmitPending,
  issueAssessment,
  submitReview,
} from './practice-api';
import { usePracticeClient } from './practice-client';

export type Rating = 'again' | 'hard' | 'good';
type IssuanceMode = 'auto_score' | 'manual';
type IssuanceState = Awaited<ReturnType<typeof getIssuanceState>>;
export type JudgeFeedback = Pick<
  JudgePreview,
  'route' | 'coarse_outcome' | 'confidence' | 'feedback_md' | 'suggested_rating'
> & {
  partial_units?: Extract<JudgePreview, { coarse_outcome: 'partial_unknown' }>['partial_units'];
};

const PartialUnknownFeedback = PartialUnknownJudgeResult.pick({
  coarse_outcome: true,
  score: true,
  partial_units: true,
});

const INTERVENTION_DIAGNOSTIC_SOURCE = 'intervention_diagnostic';
const JUDGE_FAILURE_MESSAGE = '判题失败，请稍后重试';

export function isInterventionDiagnosticSource(source: string): boolean {
  return source === INTERVENTION_DIAGNOSTIC_SOURCE;
}

export function feedbackFromCommittedAttempt(result: SubmitResult): JudgeFeedback {
  if (!result.judge) {
    throw new Error('诊断提交没有返回服务端判分');
  }
  return {
    route: result.judge.route,
    coarse_outcome: result.judge.coarse_outcome,
    ...(result.judge.coarse_outcome === 'partial_unknown'
      ? { partial_units: result.judge.partial_units }
      : {}),
    confidence: result.judge.confidence,
    feedback_md: result.judge.feedback_md,
    // auto_rate 的正常回执恒带 suggested_rating；旧/滚动部署响应若漏掉，
    // review_event.rating 仍是服务端最终实际采用的评级，不能在 UI 侧猜。
    suggested_rating:
      result.judge.coarse_outcome === 'partial_unknown'
        ? null
        : (result.judge.suggested_rating ??
          ('rating' in result.review_event ? result.review_event.rating : null)),
  };
}

export function feedbackFromCommittedDiagnosticAttempt(
  result: NonNullable<QuestionFullDetail['committed_attempt']>,
): JudgeFeedback {
  return {
    route: result.judge.route,
    coarse_outcome: result.judge.coarse_outcome,
    confidence: result.judge.confidence,
    feedback_md: result.judge.feedback_md,
    suggested_rating: result.judge.suggested_rating,
  };
}

export const VERDICT_OF: Record<JudgePreview['coarse_outcome'], { label: string; tone: Rating }> = {
  correct: { label: '对', tone: 'good' },
  partial: { label: '部分对', tone: 'hard' },
  partial_unknown: { label: '部分正确', tone: 'hard' },
  incorrect: { label: '错', tone: 'again' },
  unsupported: { label: '暂时没法自动判', tone: 'hard' },
};

// YUK-432 — 客观题判别（OWNER DECISION A：客观题自动判分 + 自动评级，跳过手动 again/hard/good）。
//
// gate 的判据：judge 预览 route 是确定性客观路由（exact/keyword）。**只看 route，不看题型 kind。**
// 必须逐字对齐后端 label gate：后端 src/server/mastery/personalized-difficulty.ts 的
// isObjectiveJudgeRoute(judgeRoute) 仅在 route ∈ OBJECTIVE_JUDGE_ROUTES={exact,keyword} 时才写
// difficulty_calibration_label（键于 judge route，与 kind 无关）。UI auto-rate gate 与之同源——
// UI 发 auto_rate:true ⟺ 后端会写 label。
//
// 为何不能再用 kind-OR 兜底（Bugbot Medium 修复）：一道**题型客观但判分路由非客观**的题（例如
// choice/true_false/fill_blank 携带 judge_kind_override=semantic、路由到 semantic）会在旧的 kind-OR
// 下过 UI gate → auto_rate:true 自动 commit、跳过手动评级 —— 但后端 route gate=false → **不写 label**。
// 结果：用户走完自动流，B1 label 从未落库（firm-up 链仍冻结），且一道被语义判分的题被错误跳过手动
// 评级。route-only gate 消除这个 mismatch：semantic-override 的客观题型回到手动评级流（它确实在被
// 语义判分，而非确定性判分），正常 choice/true_false/fill_blank（其 route 本就是 exact/keyword）继续
// auto-rate。
//
// 客观题：preview 回来后直接以 suggested_rating + auto_rate:true 自动 commit（让客观判分流过后端
// difficulty_calibration_label hook 产标签，解冻 B1 难度 firm-up 链）；用户仍看到判定反馈卡再前进。
// 开放题（含 semantic-override 的客观题型）维持现有手动评级流（字节不变）。
const OBJECTIVE_JUDGE_ROUTES = new Set(['exact', 'keyword']);

export function isObjectiveQuestion(route: string): boolean {
  return OBJECTIVE_JUDGE_ROUTES.has(route);
}

// YUK-589 — reshape a judge preview into the exact JudgeResultV2 the submit
// re-parses. The advice endpoint signed result_digest over the judge's real
// result, so every digested field (crucially score_meaning, which varies by
// route: steps_v1_weighted / unit_dimension_v1 / correctness) MUST be echoed
// verbatim — hardcoding any of them breaks the digest match at submit and drops
// the result to supplied_unverified while persisting a falsified score meaning.
export function toSubmittedJudgeResult(
  pv: JudgePreview,
): NonNullable<SubmitReviewInput['judge_result_v2']> {
  const common = {
    score_meaning: pv.score_meaning,
    confidence: pv.confidence,
    feedback_md: pv.feedback_md,
    evidence_json: pv.evidence_json,
    capability_ref: pv.capability_ref,
  };
  switch (pv.coarse_outcome) {
    case 'correct':
    case 'partial':
      if (pv.score === null) throw new Error(`${pv.coarse_outcome} judge result requires score`);
      return { ...common, coarse_outcome: pv.coarse_outcome, score: pv.score };
    case 'partial_unknown':
      if (pv.score !== null || pv.partial_units.length === 0) {
        throw new Error('partial_unknown judge result requires score=null and partial units');
      }
      return {
        ...common,
        coarse_outcome: 'partial_unknown',
        score: null,
        partial_units: pv.partial_units,
      };
    case 'incorrect':
      if (pv.score !== 0) throw new Error('incorrect judge result requires score=0');
      return { ...common, coarse_outcome: 'incorrect', score: 0 };
    case 'unsupported':
      if (pv.score !== null || pv.confidence !== 0) {
        throw new Error('unsupported judge result requires score=null and confidence=0');
      }
      return { ...common, coarse_outcome: 'unsupported', score: null, confidence: 0 };
  }
}

// YUK-432 (Bugbot FINDING 1) — 客观题自动 commit 后退出回流（「返回流」）时是否必须把 slot 标 done。
// auto-commit 后 review 已落库（slot 实质 done）；此时点「返回流」若只 onBack（host 仅回列表、不 PATCH
// slot 状态）会留下「已判分但 slot 卡 in_progress」的不一致态。autoCommitted===true → 走
// onCommittedBack（标 done + 回列表）；未自动 commit（作答中 / 开放题手动流）→ false → 走原 onBack
// （review 未提交，slot 应留 in_progress 供 resume）。纯谓词，供单测固定不变式。
export function shouldMarkSlotDoneOnBack(autoCommitted: boolean): boolean {
  return autoCommitted;
}

// YUK-432 (Bugbot FINDING 2) — 反馈卡上「不服判」入口是否可用。客观题自动 commit 同样落了独立 judge
// 锚点 event（后端 submit.ts:550 在 judge_route ∈ JudgeKind {exact,keyword,…} 时写，并经响应
// judge.judge_event_id 回传），故 deterministic 判定**可申诉**（如 exact-match 误拒了等价答案）。
// 入口在反馈相位、当前未展开申诉框、且拿得到锚点 id 时可用——与 autoCommitted 无关（旧实现错误地用
// autoCommitted 隐藏了它）。手动流锚点在用户提交申诉那刻随 commit 落（res.judge.judge_event_id），客观
// 流锚点在 auto-commit 时已落（同一响应字段），暂存后供此谓词判定。
export function appealEntryAvailable(opts: {
  // YUK-444 — 三相后 phase 可为 'confidence'（judge 结果暂存、判定未揭晓）。入参放宽到含它，
  // 语义上申诉入口只在 'feedback' 可用，'confidence'/'answering' 皆经下面首行 guard 返回 false
  // （'confidence' 相位无已揭晓判定可申诉）。放宽入参即便调用点未被 phase==='feedback' 收窄也可赋值。
  phase: 'answering' | 'confidence' | 'feedback';
  appealOpen: boolean;
  autoCommitted: boolean;
  autoCommitJudgeEventId: string | null;
}): boolean {
  if (opts.phase !== 'feedback' || opts.appealOpen) return false;
  // 自动 commit 流：仅当拿到了可申诉锚点才显示入口（无锚点的判定无可申诉对象）。
  if (opts.autoCommitted) return opts.autoCommitJudgeEventId !== null;
  // 手动流：入口恒可见，锚点在用户提交申诉那一刻随 commit 落库（既有行为，不变）。
  return true;
}

// YUK-562 (过程框可见性) — 「记下你的思路」采集框只对开放/文本作答题显示，客观（选择）题隐藏。
// 判据是**作答面形态**（isChoice）而非 judge route：过程框在作答相位、提交前渲染，此刻 getAdvice
// 尚未跑、route 未知，无法用 route gate；而「开放/文本作答题」在本组件里恰等价于「渲染 textarea 作答
// 面」= !isChoice（选择题渲染 radio、无 composer，过程框无处可挂）。故 isChoice 是唯一可用且语义对齐
// 的信号。零强制红线：即便显示也默认折叠、可完全忽略、空值不发字段。
export function shouldOfferProcessBox(isChoice: boolean): boolean {
  return !isChoice;
}

// YUK-444 (信心自评插拍 gate) — 提交后「先自评再看结果」的 1-5 interstitial 只在**非客观**判分流插入。
// 客观题（route ∈ {exact, keyword}）preview 回来即 auto-commit（advance:false 直接渲判定卡），不插拍
// （与「客观题跳过」约束一致）。gate 与 isObjectiveQuestion 同源取反：只看 route，不看 kind。
export function shouldOfferConfidenceGate(route: string): boolean {
  return !isObjectiveQuestion(route);
}

// YUK-444 (推迟揭晓时序不变式) — PfSolo 三相由两个 judge-preview slot 派生：
//   - preview===null && pending===null → answering（作答，判定未跑）
//   - preview===null && pending!==null → confidence（judge 结果已到但**暂存未揭晓**，插信心自评拍）
//   - preview!==null                    → feedback（判定卡揭晓）
// 关键不变式：只要 pending 有值而 preview 仍 null，就停在 confidence（判定卡不渲染）——揭晓**必须**
// 经 revealVerdict 把 pending 提上 preview。preview 一旦有值即优先 feedback（揭晓后 pending 已清）。
// 纯函数，供单测固定「先自评、后揭晓」的相位时序。
export function derivePhase(
  preview: JudgePreview | null,
  pendingPreview: JudgePreview | null,
): 'answering' | 'confidence' | 'feedback' {
  if (preview !== null) return 'feedback';
  if (pendingPreview !== null) return 'confidence';
  return 'answering';
}

// YUK-562 / YUK-444 (采集字段装配 · 零强制「空值不发字段」) — 把 UI 侧的过程文本 / 信心自评装配成
// submitReview 的可选 wire 字段。**空值绝不发**：reasoning_trace 仅在 trim 后非空才带（挡纯空白噪声）；
// self_confidence 仅在用户实际选了 1-5（非 null / 跳过）才带。两者缺省 → wire body 无该键 → server
// conditional-spread 保持 event payload byte-identical。纯函数，供单测固定「空值不发」不变式。
export function buildCaptureFields(input: {
  reasoningTrace: string;
  selfConfidence: number | null;
}): { reasoning_trace?: string; self_confidence?: number } {
  const out: { reasoning_trace?: string; self_confidence?: number } = {};
  if (input.reasoningTrace.trim()) {
    // YUK-562 (PR #1065 thread 修复) — 发送前防御性截断到 REASONING_TRACE_MAX_LEN。textarea 的
    // maxLength 是 UX 侧硬闸，但粘贴 / IME / 代理调用仍可能越界；若原样发超界文本，server 端
    // zod .max() 会抛 400，且此刻 UI 已进 feedback/confidence 相位无法回改 → 软死锁。这里 slice
    // 与 zod 同按 UTF-16 code unit 计长，截断后恒过 .max()（宁可少几字，不吞整次提交）。
    out.reasoning_trace = input.reasoningTrace.slice(0, REASONING_TRACE_MAX_LEN);
  }
  if (input.selfConfidence !== null) out.self_confidence = input.selfConfidence;
  return out;
}

// Uploaded attachments as the native group evidence the draft and submission carry.
function nativeGroupEvidence(evidence: readonly EvidenceAttachment[]) {
  return evidence.flatMap((item) =>
    item.original
      ? [
          {
            evidence: item.original,
            target: item.originalTarget ?? { scope: 'all_units' as const },
          },
        ]
      : [],
  );
}

type ServerAnswer = IssuanceState['submissions'][number] | NonNullable<IssuanceState['draft']>;

// A stored answer's attachments as the composer's attachment list (restore and conflict).
function evidenceFromServer(answer: ServerAnswer | null | undefined): EvidenceAttachment[] {
  return (answer?.group_evidence ?? []).map((item) => ({
    asset_id: item.evidence.asset.asset_id,
    original: item.evidence,
    originalTarget: item.target,
    slot_ids: null,
  }));
}

// YUK-1489 — a draft conflict waits on the learner: this visit's text and the server's
// current version are shown side by side until one is chosen. `submitted` = the server
// already accepted an answer for this question, so only its version can be kept.
export type DraftConflict =
  | { status: 'loading' }
  | { status: 'failed' }
  | {
      status: 'ready';
      state: IssuanceState;
      answer: ServerAnswer | null;
      epoch: number;
      submitted: boolean;
    };

/** One side of a draft conflict, in the learner's words. */
export interface DraftSummary {
  text: string;
  files: readonly string[];
}

/** YUK-1489 — what the conflict panel shows, and its choices. */
export interface PracticeDraftConflictView {
  conflict: DraftConflict;
  mine: DraftSummary;
  server: (DraftSummary & { savedAt: string | null }) | null;
  /** 「用服务器上的」 / 「载入交过的作答」. */
  keepServer: () => void;
  /** 「保留我的」 (not offered once the server holds a submitted answer). */
  keepMine: () => void;
  /** 「再读一次」 after the server's version could not be read. */
  reload: () => void;
}

/** YUK-1484 — the issuance command's state for one visit, as a view renders it. */
export type PracticeIssuance =
  | {
      /** Render a placeholder whose ref is `attach`; its attach runs the command once. */
      status: 'pending';
      attach: (node: HTMLElement | null) => (() => void) | undefined;
    }
  | {
      status: 'failed';
      error: unknown;
      /** 「重试」: bring the placeholder back (read first, POST only on 404). */
      retry: () => void;
      /** 「按自行评级练习」 for a question that is not admitted for auto-scoring. */
      startSelfRated: () => void;
    }
  | {
      status: 'ready';
      id: string;
      mode: IssuanceMode;
      frozen: NonNullable<IssuanceState['practice_dto']>;
      accepted: IssuanceState['submissions'][number] | undefined;
      /** The issuance's stored answer has been restored; answer fields may render. */
      restored: boolean;
    };

// Waits up to `ms` for a save; false when it failed, conflicted or did not answer in time.
function settleWithin(save: Promise<boolean>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    save.then(
      (ok) => {
        clearTimeout(timer);
        resolve(ok);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

// How long 「返回流」 waits for the last draft save before leaving anyway.
const BACK_FLUSH_TIMEOUT_MS = 8000;
// YUK-1497 — answers from a custom (sandbox) block: the first one is saved at once, later ones at
// most this often (trailing), so a block that then hangs the tab loses nothing already accepted.
const SANDBOX_SAVE_THROTTLE_MS = 300;

/**
 * The practice page's question read: one GET of /api/questions/:id (Practice projection). Shared
 * with the host's prefetch of the next question (YUK-1473, M13), so the prefetched data lands in
 * this very cache entry. A read only: issuing the question is the attach-time command below.
 */
export function questionDetailQuery(refId: string) {
  return queryOptions({
    queryKey: ['question-detail', refId],
    // Explicit Practice projection lets product-owned diagnostics expose only
    // learner-safe prompt/options while the question-bank surface remains 404.
    queryFn: () => getQuestionFull(refId, { surface: 'practice' }),
  });
}

export type PracticeToast = (text: string, tone?: PfToast['tone'], icon?: string) => void;

export interface UsePracticeSubmitOptions {
  item: StreamItem;
  /** YUK-535 — server-resolved KC-scoped review session; null for the daily stream. */
  sessionId?: string | null;
  onDone: () => void;
  onBack: () => void;
  // YUK-432 (Bugbot FINDING 1) — 客观题自动 commit 后的「返回流」出口：host 标 slot done + 回列表
  // （不自动推进到下一题）。仅 autoCommitted 时走它；未提供时回落 onBack（向后兼容旧调用方）。
  onCommittedBack?: () => void;
  addToast: PracticeToast;
  /** While true the ⌘/Ctrl+Enter submit hotkey is ignored (e.g. a hint drawer is open). */
  hotkeysSuspended: boolean;
}

/** A copy of `set` with `key` present or absent; the same set when nothing changes. */
function withKey(set: ReadonlySet<string>, key: string, on: boolean): ReadonlySet<string> {
  if (set.has(key) === on) return set;
  const next = new Set(set);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}

export function usePracticeSubmit({
  item,
  sessionId,
  onDone,
  onBack,
  onCommittedBack,
  addToast,
  hotkeysSuspended,
}: UsePracticeSubmitOptions) {
  const { saveResponseDraft, readJudgeRunStatus } = usePracticeClient();
  // 题面聚合 /api/questions/:id（getQuestionFull）。注意 getQuestion 与 getQuestionFull 命中同一
  // URL、同一 loadQuestionDetail 全聚合——「轻」query 只是类型窄了子集，服务端并不更省；故这里直接
  // 用全投影，YUK-617 W1 的 timeline 从同一份 data.timeline 白拿，不再二次请求（避免同题双取全聚合）。
  const qQ = useQuery(questionDetailQuery(item.ref_id));
  // YUK-1051 — 选项身份从数组下标换成内容派生的 stable option id（response-types）：
  // 重渲染 / 草稿恢复 / 复盘里同一选项文本恒同 id；选项数不硬编码（1–9 数字键随选项数）。
  const [nativeResponses, setNativeResponses] = useState<ResponseSetT>({ entries: [] });
  const [issuanceMode, setIssuanceMode] = useState<IssuanceMode>('auto_score');
  // YUK-1051 (D10) — 开放作答的证据附件（通用文字+附件）；asset ids 随提交走
  // answer_image_refs（CreateAttempt 契约早就有，UI 此前丢弃）。
  const [evidence, setEvidence] = useState<EvidenceAttachment[]>([]);
  // YUK-1094 — 附件上传中：上传批次未 settle 前禁止提交，否则判分/提交跑的是旧 evidence
  // （刚选的附件丢掉）。由 EvidenceComposer 的 onUploadingChange 上报。
  // YUK-1497 — a block question has several composers (the page's, plus one per free_area), so
  // each reports under its own key; 提交 waits until none has an upload in flight.
  const [uploadsInFlight, setUploadsInFlight] = useState<ReadonlySet<string>>(() => new Set());
  const uploading = uploadsInFlight.size > 0;
  const trackUpload = (key: string, on: boolean) =>
    setUploadsInFlight((prev) => withKey(prev, key, on));
  const setUploading = (on: boolean) => trackUpload('page', on);
  // YUK-1497 — free_area attachments that came back without a full receipt, per slot. They stay
  // visible and block 提交, as the page-level attachments without `original` do.
  const [unreceipted, setUnreceipted] = useState<Readonly<Record<string, EvidenceAttachment[]>>>(
    {},
  );
  const setSlotUnreceipted = (slotId: string, next: EvidenceAttachment[]) =>
    setUnreceipted((prev) => ({ ...prev, [slotId]: next }));
  // YUK-1051 — 202-pending：提交被分到 durable lane 时的 run 锚点；轮询直到终态，
  // 绝不重交同一答案。null = 非 pending（同步回执 / 未提交）。
  const [pendingRun, setPendingRun] = useState<{ runId: string; pollUrl: string } | null>(null);
  const [judging, setJudging] = useState(false);
  const [preview, setPreview] = useState<JudgePreview | null>(null);
  const activationIntent = useRef<SubmitReviewInput['activation_intent']>(undefined);
  const committedAppealKind = useRef<'judge' | 'evaluation'>('judge');
  // intervention_diagnostic skips the repeatable advice preview and is committed
  // by the first /api/attempts call. Its response is sufficient for the feedback
  // card, but intentionally lacks advice-only provenance fields used by commit().
  const [committedPreview, setCommittedPreview] = useState<JudgeFeedback | null>(null);
  // YUK-562 (过程框) — reasoningTrace 是可选过程文本。零强制：不挡提交、空值不发字段（buildCaptureFields）。
  const [reasoningTrace, setReasoningTrace] = useState('');
  // YUK-444 (信心自评 · 推迟揭晓) — 开放题提交后判定揭晓前，先渲 1-5 自评 interstitial。judge 结果
  // 暂存在 pendingPreview（不 setPreview → 判定卡不渲染），确认/跳过后才 setPreview 揭晓（元认知语义：
  // 先自评再看结果）。selfConfidence=null 表示未选 / 跳过 → 不发 self_confidence。客观题 auto-commit
  // 流不经此（不插拍）。
  const [pendingPreview, setPendingPreview] = useState<JudgePreview | null>(null);
  const [selfConfidence, setSelfConfidence] = useState<number | null>(null);
  const [rating, setRating] = useState<Rating | null>(null);
  const [appealOpen, setAppealOpen] = useState(false);
  const [appealText, setAppealText] = useState('');
  const [committing, setCommitting] = useState(false);
  const [returning, setReturning] = useState(false);
  const returningRef = useRef(false);
  // YUK-432 — 客观题在 preview 回来时已自动 commit（auto_rate:true）。记下来：反馈卡保留判定，
  // 「下一项」只 onDone() 推进（不再二次 commit）。开放题恒 false → 现有手动流不变。
  const [autoCommitted, setAutoCommitted] = useState(false);
  // YUK-432 (Bugbot FINDING 2) — 客观题自动 commit 那次 submitReview 回执的 judge 锚点 id。后端为
  // 客观判分（route ∈ JudgeKind）写了独立 judge event 并回传 judge.judge_event_id；存下来，让反馈卡上
  // 的「不服判」入口在自动 commit 后仍能对这个锚点直接发 appeal（不再二次 submit——review 已落库）。
  // null = 这次自动判定没有可申诉锚点（理论上 exact/keyword 恒有，留 null 兜底 → 入口自动隐藏）。
  const [autoCommitJudgeEventId, setAutoCommitJudgeEventId] = useState<string | null>(null);
  // YUK-433 — solo 路径 RT capture：题面变可见那刻的墙钟时间戳。commit 时 now - 它 = 这次作答用时
  // （computeLatencyMs clamp 后作为 latency_ms 发出，server 映射成事件 payload 的 duration_ms）。下面
  // 的 effect 在新题就绪时 RESET（keyed on q?.id），保证 re-answer / next-item 都从干净的零点起算。
  // null = 题面尚未就绪（计时器未起）→ computeLatencyMs 返回 null → 略过 latency_ms（不发噪声）。
  const questionShownAtRef = useRef<number | null>(null);

  const q = qQ.data ?? null;
  const isInterventionDiagnostic = isInterventionDiagnosticSource(q?.source ?? '');
  const committedDiagnosticQuestionId = q?.id;
  // YUK-617 W1 — 本题 attempt·review 历史，从题面聚合 data.timeline 直接派生（同一份请求，无二次取）。
  // 取自题面加载那刻 → 恒是本次作答**之前**的历史（不含刚提交的这次，客观题自动 commit 也不竞态），
  // 正合「卡在同一误区」信号意图。反馈卡里 length>0 才渲染。
  const timelineEvents = q ? toAttemptTimelineEvents(q.timeline) : [];
  const issuanceId = `iss_stream_${item.id}`;
  // YUK-1484 — issuing is a write, so it is a command, not a query: nothing may re-run it
  // on retry, focus, reconnect, invalidation, remount or StrictMode. The issuance
  // placeholder owns it (attachIssuance): when it attaches, this visit reads its issuance
  // and POSTs one only if the server has none (404). One request per visit and mode — a
  // re-attach reuses it, an accepted issuance is never re-POSTed; a rejected request is
  // dropped so a later attach (e.g. after switching to self-rated mode) can try again.
  // The result lives in local state; there is no cached issuance query to refetch.
  const issueRequests = useRef(new Map<string, Promise<IssuanceState>>());
  const [issuance, setIssuance] = useState<{
    mode: IssuanceMode;
    state: IssuanceState | null;
    error: unknown;
  } | null>(null);
  const attachIssuance = useCallback(
    (node: HTMLElement | null) => {
      if (!node || !q) return undefined;
      const mode = issuanceMode;
      const key = `${issuanceId}:${mode}`;
      const requests = issueRequests.current;
      let request = requests.get(key);
      if (!request) {
        const started = (async () => {
          try {
            return await getIssuanceState(issuanceId);
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 404) throw error;
          }
          await issueAssessment({
            issuance_id: issuanceId,
            group_id: q.parent_question_id ?? q.id,
            ...(q.parent_question_id ? { part_ids: [q.id] } : {}),
            mode,
          });
          return getIssuanceState(issuanceId);
        })();
        requests.set(key, started);
        // Not accepted: forget it so a later attach of this visit can try again.
        started.catch(() => {
          if (requests.get(key) === started) requests.delete(key);
        });
        request = started;
      }
      let detached = false;
      request.then(
        (state) => {
          if (!detached) setIssuance({ mode, state, error: null });
        },
        (error: unknown) => {
          if (!detached) setIssuance({ mode, state: null, error });
        },
      );
      return () => {
        detached = true;
      };
    },
    [q, issuanceId, issuanceMode],
  );
  // The command's settled result for the current mode; null while it is in flight.
  const issued = issuance?.mode === issuanceMode ? issuance : null;
  const issuedState = issued?.state ?? null;
  const frozen = issuedState?.practice_dto;
  // YUK-1497 — the issuance's frozen presentation (old revisions have none: drawn per slot).
  const rawPresentation = frozen?.presentation;
  const presentation = useMemo(() => parsePresentation(rawPresentation), [rawPresentation]);
  const customBlocks = useMemo(
    () => (presentation ? customBlocksOf(presentation) : []),
    [presentation],
  );
  // Every custom block verified and loaded, none failed (or there are none).
  const customReady = useCustomBlocksReady(customBlocks);
  // Save epoch: the restored draft's epoch until the first ACK, then the latest ACK's.
  const [restoredEpoch, setRestoredEpoch] = useState<number | undefined>(undefined);
  const ackedEpoch = useRef<number | undefined>(undefined);
  const [restoredIssuanceId, setRestoredIssuanceId] = useState<string | null>(null);
  // The state comes from this visit's own issuance read, never from a cache. Restore it
  // once per issuance, then keep later reads (a mode switch's) from replacing local
  // edits. YUK-1483: this is the render-time "adjust state when the input changes" step
  // (own state only, no effect); the answer fields are not rendered until it has run,
  // so autosave never starts from an empty placeholder.
  if (issuedState?.issuance && restoredIssuanceId !== issuedState.issuance.issuance_id) {
    const restored = issuedState.submissions[0] ?? issuedState.draft;
    setNativeResponses(restored?.response_set ?? { entries: [] });
    setEvidence(evidenceFromServer(restored));
    setRestoredEpoch(issuedState.draft?.save_epoch);
    setRestoredIssuanceId(issuedState.issuance.issuance_id);
  }
  const nativeEvidence = useMemo(() => nativeGroupEvidence(evidence), [evidence]);
  const accepted = issuedState?.submissions[0];
  // YUK-1501 — an accepted answer that /api/attempts already recorded is read-only review:
  // nothing on this page may submit it again. Recorded = the question's timeline holds an
  // attempt for its evaluation group that is settled (an effective evaluation) or whose
  // background judge is still queued (no original evaluation yet). Accepted alone is not
  // enough: /api/review/advice also accepts the answer without recording an attempt
  // (「自己评一下」 after a verdict that could not be graded, or a visit left before rating),
  // and an attempt recorded as review_required (original evaluation, nothing effective) is
  // not scheduled yet — both must stay committable so the learner can still rate them.
  const answerRecorded =
    !!accepted &&
    (q?.timeline ?? []).some(
      (entry) =>
        entry.kind === 'attempt' &&
        entry.assessment?.evaluation_group_id === accepted.evaluation_group_id &&
        (entry.assessment.effective_evaluation_id !== null ||
          entry.assessment.original_evaluation_id === null),
    );
  // A cached question read may predate the commit (back, then reopen); until it is
  // refreshed it cannot clear an accepted answer, so submitting waits for it.
  const acceptedUnconfirmed = !!accepted && (answerRecorded || qQ.isFetching);
  const assessmentInput = {
    issuance_id: issuanceId,
    evaluation_group_id: accepted?.evaluation_group_id ?? `group_stream_${item.id}`,
    submission_id: accepted?.submission_id ?? `submission_stream_${item.id}`,
    idempotency_key: accepted?.idempotency_key ?? `submit_stream_${item.id}`,
    // YUK-1497 — a block-drawn question hands in every bound select / blank slot still empty as
    // an active blank (spec §1.2.2); the draft itself never holds those entries.
    response_set:
      presentation && frozen
        ? {
            entries: entriesForSubmit(
              presentation,
              frozen.response_spec.slots,
              nativeResponses.entries,
            ),
          }
        : nativeResponses,
    group_evidence: nativeEvidence,
  };
  const draftValue = useMemo(
    () => ({ response_set: nativeResponses, group_evidence: nativeEvidence }),
    [nativeResponses, nativeEvidence],
  );
  // YUK-1483 — autosave is driven by the edit events below. It is armed only while
  // answering: the fields render after the issuance is restored and are disabled once
  // an answer is accepted; judging/committing call hold(), and returning to answering
  // after a failure calls resume().
  const draftGroupRef = assessmentInput.evaluation_group_id;
  const saveDraft = useCallback(
    async (value: typeof draftValue, ctx: { keepalive: boolean; chained: boolean }) => {
      // YUK-1487 — always send an epoch (0 = no draft yet): without one the server skips the
      // stale check, and an older in-flight save could overwrite a newer chained one. A save
      // chained past an in-flight one sends acked + 1 so whichever lands second loses only
      // if it is the older text (contract in useResponseDraftAutosave).
      const acked = ackedEpoch.current ?? restoredEpoch ?? 0;
      const ack = await saveResponseDraft(
        issuanceId,
        {
          ...value,
          evaluation_group_ref: draftGroupRef,
          expected_save_epoch: ctx.chained ? acked + 1 : acked,
        },
        { keepalive: ctx.keepalive },
      );
      // ACKs of an in-flight and a chained save can arrive in either order; keep the newest.
      ackedEpoch.current = Math.max(ackedEpoch.current ?? 0, ack.save_epoch);
    },
    [issuanceId, draftGroupRef, restoredEpoch, saveResponseDraft],
  );
  // YUK-1489 — on a conflict autosave stops and the server's current version is read, so the
  // learner can compare and choose (panel below). Each read is tagged; only the newest lands.
  const [draftConflict, setDraftConflict] = useState<DraftConflict | null>(null);
  const conflictRead = useRef(0);
  const readServerVersion = useCallback(() => {
    const read = ++conflictRead.current;
    setDraftConflict({ status: 'loading' });
    getIssuanceState(issuanceId).then(
      (state) => {
        if (conflictRead.current !== read) return;
        const submitted = state.submissions.length > 0;
        setDraftConflict({
          status: 'ready',
          state,
          answer: state.submissions[0] ?? state.draft,
          epoch: state.draft?.save_epoch ?? 0,
          submitted,
        });
      },
      () => {
        if (conflictRead.current === read) setDraftConflict({ status: 'failed' });
      },
    );
  }, [issuanceId]);
  const autosave = useResponseDraftAutosave({
    save: saveDraft,
    holdOnConflict: true,
    onConflict: readServerVersion,
  });
  // YUK-1485 — tab close / reload inside the 800ms debounce: flush the pending draft with
  // keepalive, as ScreenPlacement does. The controller holds the latest edited value, so this
  // sends the last keystrokes; while held (judging/committing) or after an accepted answer it
  // sends nothing. Newer text than an in-flight save carries goes out as one chained keepalive
  // save (YUK-1487). Armed by the answering root below.
  const { flush: flushDraft } = autosave;
  const flushOnPagehide = useCallback(() => flushDraft({ keepalive: true }), [flushDraft]);
  const attachPagehide = usePagehideTransition(flushOnPagehide);
  // YUK-1497 — iOS may kill a backgrounded tab without pagehide: flush the same way when the page
  // is hidden. Same owner node as the pagehide listener.
  const attachPagehideFlush = useCallback(
    (node: HTMLElement | null) => {
      const detachPagehide = attachPagehide(node);
      if (!node) return detachPagehide;
      const owner = node.ownerDocument;
      const onVisibility = () => {
        if (owner.visibilityState === 'hidden') void flushOnPagehide();
      };
      owner.addEventListener('visibilitychange', onVisibility);
      return () => {
        detachPagehide?.();
        owner.removeEventListener('visibilitychange', onVisibility);
      };
    },
    [attachPagehide, flushOnPagehide],
  );
  // Latest edited draft, written synchronously by every edit handler (never during render).
  // A handler captured by an older render — e.g. EvidenceComposer finishing an upload after
  // an await — must build on this, not on its render's answer, or it would hand autosave a
  // pre-upload answer and the save would drop newer typing. Tagged with the issuance it was
  // edited under, so it is only used for the issuance currently restored.
  const latestDraft = useRef<{ issuanceId: string; value: typeof draftValue } | null>(null);
  const currentDraft = () =>
    latestDraft.current?.issuanceId === restoredIssuanceId ? latestDraft.current.value : draftValue;
  const editDraft = (next: typeof draftValue) => {
    const from = currentDraft();
    if (restoredIssuanceId) latestDraft.current = { issuanceId: restoredIssuanceId, value: next };
    autosave.change(next, from);
  };
  const updateNativeResponse = (entry: SlotResponseT) => {
    const draft = currentDraft();
    const response_set = {
      entries: [
        ...draft.response_set.entries.filter((item) => item.slot_id !== entry.slot_id),
        entry,
      ],
    };
    setNativeResponses(response_set);
    editDraft({ response_set, group_evidence: draft.group_evidence });
  };
  // YUK-1497 — sandbox answers: first save immediate, then a trailing throttle. Per issuance.
  const sandboxSave = useRef<{
    issuanceId: string | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ issuanceId: null, timer: null });
  const saveSandboxAnswer = () => {
    const pace = sandboxSave.current;
    if (pace.issuanceId !== restoredIssuanceId) {
      if (pace.timer) clearTimeout(pace.timer);
      sandboxSave.current = { issuanceId: restoredIssuanceId, timer: null };
      void autosave.flush();
      return;
    }
    if (pace.timer) return;
    pace.timer = setTimeout(() => {
      pace.timer = null;
      void autosave.flush();
    }, SANDBOX_SAVE_THROTTLE_MS);
  };
  // YUK-1497 — presentation blocks edit the envelope list through an updater (a block may also
  // remove its entry: an emptied blank or selection is "not answered" in the draft). `immediate`
  // (custom blocks) skips an unchanged envelope and saves without waiting for the debounce.
  const updateNativeResponses = (update: EntriesUpdate, opts?: { immediate?: boolean }) => {
    const draft = currentDraft();
    const entries = update(draft.response_set.entries);
    if (opts?.immediate && JSON.stringify(entries) === JSON.stringify(draft.response_set.entries)) {
      return;
    }
    const response_set = { entries };
    setNativeResponses(response_set);
    editDraft({ response_set, group_evidence: draft.group_evidence });
    if (opts?.immediate) saveSandboxAnswer();
  };
  const updateEvidence = (next: EvidenceAttachment[]) => {
    setEvidence(next);
    editDraft({
      response_set: currentDraft().response_set,
      group_evidence: nativeGroupEvidence(next),
    });
  };
  const isChoice =
    !!frozen?.response_spec.slots.length &&
    frozen.response_spec.slots.every(
      (slot) => slot.kind === 'single_choice' || slot.kind === 'multi_choice',
    );
  const imageRefs = useMemo(() => evidence.map((a) => a.asset_id), [evidence]);
  // YUK-1489 — what a draft says, in the learner's words: each answered slot's text in
  // question order, plus its attachments. Used to compare this visit with the server.
  const answerText = (value: typeof draftValue) =>
    (frozen?.response_spec.slots ?? [])
      .flatMap((slot) => {
        const entry = value.response_set.entries.find((e) => e.slot_id === slot.slot_id);
        const text = entry ? nativeResponseText(entry, slot).trim() : '';
        return text ? [text] : [];
      })
      .join('\n');
  const serverDraft = (answer: ServerAnswer | null) => ({
    response_set: answer?.response_set ?? { entries: [] },
    group_evidence: nativeGroupEvidence(evidenceFromServer(answer)),
  });
  const draftSummary = (value: typeof draftValue) => ({
    text: answerText(value),
    files: value.group_evidence.map((item) => item.evidence.asset.asset_id),
  });
  const sameAsServer = (answer: ServerAnswer | null) => {
    const mine = draftSummary(currentDraft());
    const server = draftSummary(serverDraft(answer));
    return mine.text === server.text && mine.files.join() === server.files.join();
  };
  // 「用服务器上的」: restore the server's version as if this visit had just opened it, and
  // continue from its epoch. Autosave restarts with that version as the saved baseline.
  const keepServerVersion = () => {
    if (draftConflict?.status !== 'ready') return;
    const { state, answer, epoch, submitted } = draftConflict;
    // YUK-1501 — an answer submitted elsewhere: re-read the question so its timeline (and the
    // read-only gate above) reflects that submission.
    if (submitted) void qQ.refetch();
    ackedEpoch.current = epoch;
    latestDraft.current = null;
    setIssuance({ mode: issuanceMode, state, error: null });
    setRestoredIssuanceId(null);
    setDraftConflict(null);
    void autosave.rebase(serverDraft(answer), 'server');
  };
  // 「保留我的」: save this visit's text expecting the epoch just read. A write that lands
  // after that read raises the stored epoch, so this save gets 409 and the panel returns.
  const keepMyVersion = () => {
    if (draftConflict?.status !== 'ready' || draftConflict.submitted) return;
    ackedEpoch.current = draftConflict.epoch;
    setDraftConflict(null);
    void autosave.rebase(serverDraft(draftConflict.answer), 'mine');
  };
  const answerMd = nativeResponses.entries
    .map((entry) =>
      nativeResponseText(
        entry,
        frozen?.response_spec.slots.find((slot) => slot.slot_id === entry.slot_id),
      ),
    )
    .join('\n');
  // YUK-1497 — bound select / blank slots may stay empty on a block-drawn question (they go out
  // as active blanks), but the answer as a whole may not be empty. A question with custom
  // (sandbox) blocks is handed in only when every one of them is verified and loaded.
  const bound = presentation ? boundSlots(presentation) : [];
  const blankableSlotIds = new Set(
    bound
      .filter((b) => b.response_class === 'blank' || b.response_class === 'select')
      .map((b) => b.slot_id),
  );
  // 「你的作答」 for the custom-bound slots: plain text from the validated draft, beside 提交.
  const customSummary =
    customBlocks.length > 0 && frozen
      ? summarizeAnswers(
          customBlocks.flatMap((block) => block.binds),
          new Map(frozen.response_spec.slots.map((slot) => [slot.slot_id, slot] as const)),
          nativeResponses.entries,
        )
      : [];
  // A free_area block keeps its photos on the open entry itself; they answer that slot.
  const entryAnswered = (entry: SlotResponseT | undefined) =>
    isSlotResponseAnswered(nativeResponseValue(entry)) ||
    (entry?.kind === 'open' && entry.evidence.length > 0);
  const anyAnswered = nativeResponses.entries.some(entryAnswered) || nativeEvidence.length > 0;
  const canSubmit =
    !!frozen &&
    customReady &&
    !acceptedUnconfirmed &&
    !returning &&
    !draftConflict &&
    !judging &&
    !pendingRun &&
    !uploading &&
    evidence.every((item) => item.original !== undefined) &&
    Object.values(unreceipted).every((list) => list.length === 0) &&
    (issuanceMode === 'manual'
      ? anyAnswered
      : (!presentation || anyAnswered) &&
        frozen.response_spec.slots
          .filter((slot) => slot.kind !== 'table')
          .every((slot) => {
            const entry = nativeResponses.entries.find((entry) => entry.slot_id === slot.slot_id);
            if (entryAnswered(entry)) return true;
            if (blankableSlotIds.has(slot.slot_id)) return true;
            const units = frozen.response_requirements?.find(
              (requirement) => requirement.slot_id === slot.slot_id,
            )?.evidence_unit_ids;
            return (
              !!units?.length &&
              units.every((unitId) =>
                nativeEvidence.some(
                  (item) =>
                    item.target.scope === 'all_units' ||
                    item.target.scoring_unit_ids.includes(unitId),
                ),
              )
            );
          }));
  // YUK-444 — 三相：answering（作答）→ confidence（judge 结果暂存、信心自评插拍、判定未揭晓）→
  // feedback（判定卡）。confidence 只在非客观流出现；客观题 answering 直接跳到 feedback（auto-commit）。
  const phase = committedPreview ? 'feedback' : derivePhase(preview, pendingPreview);
  // YUK-432 (Bugbot FINDING 1) — 「返回流」出口：自动 commit 后必须标 slot done（onCommittedBack），
  // 否则只 onBack 会留下「已判分但 slot 卡 in_progress」的不一致。未自动 commit → 原 onBack。
  const handleBack = async () => {
    if (returningRef.current || uploading || judging || committing) return;
    returningRef.current = true;
    setReturning(true);
    try {
      // YUK-1489 — leaving is never blocked by the draft. During a conflict nothing is
      // saved (autosave is held); otherwise the last edit gets up to 8s. Either way, say
      // plainly what did not make it.
      if (draftConflict) {
        if (!(draftConflict.status === 'ready' && sameAsServer(draftConflict.answer))) {
          addToast(
            draftConflict.status !== 'ready'
              ? '你这次写的没有保存，再打开时以服务器上的为准。'
              : draftConflict.submitted
                ? '已返回。你这次写的没有保存：这道题已经在别处交过了，记录的是交过的那一份。'
                : '已返回。你这次写的没有保存：这道题在别处存了另一份作答，再打开时看到的是那一份。',
            'info',
            'alert',
          );
        }
      } else if (!(await settleWithin(autosave.flush(), BACK_FLUSH_TIMEOUT_MS))) {
        addToast(
          '已返回。最后的修改可能没有保存上，再打开这道题时以已保存的内容为准。',
          'info',
          'alert',
        );
      }
      if (shouldMarkSlotDoneOnBack(autoCommitted) && onCommittedBack) onCommittedBack();
      else onBack();
    } finally {
      returningRef.current = false;
      setReturning(false);
    }
  };

  // YUK-433 — solo 路径 RT capture：题面就绪（q 拿到）那刻起算计时器，per 题 RESET。host 给每个 StreamItem
  // 复用本组件实例（query 的 key 含 item.ref_id）。依赖列表只用 q?.id 即足够且更准：换题时 queryKey 变 →
  // qQ.data 先短暂仍是上一题（缓存）→ 新题数据回来 q?.id 才变，正是「这道题的题面真正可见」的那一刻；re-answer
  // 同一题重取也会让 q?.id 重新落定 → 重新 stamp Date.now()，保证下一次 commit 算的是这次作答的墙钟用时。
  // 纯 ref 写入，无 state/DOM 变更 → 零视觉/渲染 delta（instrumentation only）。
  // 用 useLayoutEffect（非 useEffect）：layout 阶段在浏览器 paint **之前**同步跑，stamp 更贴近题面真正
  // 变可见的时刻——useEffect 在 paint 之后异步跑会系统性低估 latency（PR review timing-accuracy note）。
  useLayoutEffect(() => {
    if (q?.id) questionShownAtRef.current = Date.now();
  }, [q?.id]);

  // A successful one-shot is already retired server-side. Restore its
  // canonical review/judge projection on mount so refresh or a lost response
  // returns to the settled feedback card rather than a dead loading state.
  // YUK-1483: applied in render when the server's committed attempt changes (own state
  // only, no effect); a later local result keeps winning until the server one changes.
  const committedDiagnostic =
    committedDiagnosticQuestionId && isInterventionDiagnostic
      ? (q?.committed_attempt ?? null)
      : null;
  const [appliedDiagnostic, setAppliedDiagnostic] = useState<typeof committedDiagnostic>(null);
  if (appliedDiagnostic !== committedDiagnostic) {
    setAppliedDiagnostic(committedDiagnostic);
    if (committedDiagnostic) {
      const feedback = feedbackFromCommittedDiagnosticAttempt(committedDiagnostic);
      setCommittedPreview(feedback);
      setRating(feedback.suggested_rating);
      setAutoCommitted(true);
      setAutoCommitJudgeEventId(committedDiagnostic.judge.judge_event_id);
    } else {
      setCommittedPreview(null);
      setAutoCommitted(false);
      setAutoCommitJudgeEventId(null);
    }
  }

  // YUK-1051 — 202-pending 轮询：同一次 submission 的 run 继续查询（poll_url 纯读 GET），
  // 终态 done → 用回传的终态判词揭晓反馈卡（与同步回执同一渲染路径）；failed → 诚实
  // 告知「作答已存住，会自动补判」，可先行推进（solo 202 可继续，不阻塞流）。
  // YUK-1483: the poller reports each run's terminal state once (onSettled); the
  // feedback is claimed there, not by an effect watching the snapshot.
  const onPendingSettled = useCallback(
    (settled: JudgeRunPollingState) => {
      if (settled.status !== 'done') return;
      const r = settled.result;
      if (r?.status === 'review_required') {
        setCommittedPreview({
          route: 'durable',
          coarse_outcome: 'unsupported',
          confidence: 0,
          feedback_md: typeof r.feedback_md === 'string' ? r.feedback_md : '',
          suggested_rating: null,
        });
        setAutoCommitted(false);
        setAutoCommitJudgeEventId(null);
        setPendingRun(null);
        addToast('作答已保存，暂时没法自动判；可以自己评一下来安排复习。', 'info', 'clock');
        return;
      }
      const outcome =
        r && typeof r.coarse_outcome === 'string' && r.coarse_outcome in VERDICT_OF
          ? (r.coarse_outcome as keyof typeof VERDICT_OF)
          : null;
      const partial = outcome === 'partial_unknown' ? PartialUnknownFeedback.safeParse(r) : null;
      if (partial && !partial.success) {
        setCommittedPreview({
          route: 'durable',
          coarse_outcome: 'unsupported',
          confidence: 0,
          feedback_md: '',
          suggested_rating: null,
        });
        setRating(null);
        setAutoCommitted(true);
        setAutoCommitJudgeEventId(null);
        setPendingRun(null);
        addToast('作答已保存，但部分判定信息不完整，请稍后查看。', 'info', 'clock');
        return;
      }
      const fr =
        outcome === 'partial_unknown' || r?.final_rating === null
          ? null
          : r &&
              typeof r.final_rating === 'string' &&
              ['again', 'hard', 'good'].includes(r.final_rating)
            ? (r.final_rating as Rating)
            : 'hard';
      if (outcome) {
        setCommittedPreview({
          route: typeof r?.route === 'string' && r.route ? r.route : 'durable',
          coarse_outcome: outcome,
          ...(partial?.success ? { partial_units: partial.data.partial_units } : {}),
          confidence: typeof r?.confidence === 'number' ? r.confidence : 0,
          feedback_md: typeof r?.feedback_md === 'string' ? r.feedback_md : '',
          suggested_rating: fr,
        });
        setRating(fr);
        setAutoCommitted(true);
        committedAppealKind.current = r?.assessment ? 'evaluation' : 'judge';
        setAutoCommitJudgeEventId(
          r?.assessment
            ? (r.assessment.effective_evaluation_id ?? r.assessment.candidate_id)
            : typeof r?.judge_event_id === 'string'
              ? r.judge_event_id
              : null,
        );
      }
      setPendingRun(null);
    },
    [addToast],
  );
  const pendingPoll = useJudgeRunPolling({
    runId: pendingRun?.runId ?? null,
    pollUrl: pendingRun?.pollUrl ?? null,
    readStatus: readJudgeRunStatus,
    onSettled: onPendingSettled,
  });

  // commit 接受显式 rating + autoRate：客观题自动流不依赖手动 `rating` state（直接用 judge 的
  // suggested_rating + auto_rate:true）；手动流（开放题/申诉）走 body.rating + auto_rate 缺省 false。
  // previewOverride：客观题自动 commit 在 setPreview 同一 tick 内触发，闭包里的 `preview` 仍是旧的
  // null（state 尚未 re-render），故 runJudge 把 fresh judge preview 直接传进来（手动流省略 → 用
  // 已落 state 的 `preview`）。
  const commit = async (opts: {
    withAppeal: boolean;
    rating: Rating;
    autoRate?: boolean;
    advance?: boolean;
    previewOverride?: JudgePreview;
  }) => {
    const pv = opts.previewOverride ?? preview;
    if (returningRef.current || !q || (!pv && issuanceMode !== 'manual') || committing) return;
    if (answerRecorded) {
      addToast('这道题已经交过了，不能再交一次。', 'info', 'alert');
      return;
    }
    setCommitting(true);
    autosave.hold();
    try {
      const res = await submitReview({
        question_id: q.id,
        assessment: assessmentInput,
        activation_intent: issuanceMode === 'manual' ? undefined : activationIntent.current,
        self_report: issuanceMode === 'manual',
        session_id: sessionId ?? undefined,
        rating: opts.rating,
        response_md: answerMd,
        referenced_knowledge_ids: q.labels.map((l) => l.id),
        // YUK-372 L2 — 被答 practice_stream_item.id（流作答的 π_i 直 join 判别子，server hook
        // 用它精确取放置该 slot 的随机抽样事件的 π_i）。
        stream_item_id: item.id,
        // YUK-562 / YUK-444 — 过程文本 + 信心自评的可选采集字段（空值不发，见 buildCaptureFields）。
        // 单一 commit 路径 → 手动流与客观题 auto_rate 自动 commit 都覆盖：客观题 selfConfidence 恒 null
        // （不插拍）故只可能带 reasoning_trace（若 fill_blank 文本面填了）；开放题两者都可能带。
        // server 侧 observe-only 落 review event payload，绝不进 rating / FSRS / θ̂。
        ...buildCaptureFields({ reasoningTrace, selfConfidence }),
        // YUK-432 — 客观题自动判分+自动评级：server 用 judge 的 suggested rating 覆盖 body.rating，
        // 并让客观判分流过 difficulty_calibration_label hook 产标签（B1 难度 firm-up 链解冻）。
        // Unknown points must never become a user rating; the server settles with rating=null.
        auto_rate: pv?.coarse_outcome === 'partial_unknown' ? true : opts.autoRate,
        // YUK-433 — solo 路径 RT capture：这次作答的墙钟用时（题面就绪 → 此刻 commit）。在单一 commit()
        // 路径里 stamp，故**两条提交分支都覆盖**：手动评级 commit（开放题）与客观题 auto_rate:true 自动
        // commit 都经此。computeLatencyMs clamp 到 [0, 3_600_000]（对齐 server zod）；shownAt 为 null →
        // 略过（不发噪声）。server 映射成事件 payload 的 duration_ms（无后端改动）。墙钟含 idle，已知噪声源。
        latency_ms: computeLatencyMs(questionShownAtRef.current, Date.now()),
        // YUK-1051 (D10) — 开放作答的证据附件随提交冻结；空值不发（既有 wire 逐字不变）。
        ...(imageRefs.length > 0 ? { answer_image_refs: imageRefs } : {}),
      });
      // YUK-1051 — 202-pending 是返回 union（不是错误）：答案已随提交持久化，判分走
      // durable lane。记下 run 锚点进 pending 卡；轮询到终态再揭晓反馈（见 pendingPoll effect）。
      // 带申诉的提交在 pending 下先把提交落定——申诉锚点要等终态判词回来才有，故 pending
      // 分支暂不发 appeal（反馈卡出现后「不服判」入口照常可用）。
      if (isSubmitPending(res)) {
        setPendingRun({ runId: res.run_id, pollUrl: res.backfill.poll_url });
        return;
      }
      if ('status' in res && res.status === 'review_required') {
        addToast('作答已保存，暂时没法自动判；可以自己评一下来安排复习。', 'info', 'clock');
        return;
      }
      if (opts.withAppeal) {
        const anchor = res.judge
          ? 'assessment' in res
            ? res.assessment.candidate_id
            : res.judge.judge_event_id
          : null;
        if (anchor) {
          await fileAppeal(anchor, appealText.trim(), 'assessment' in res ? 'evaluation' : 'judge');
          addToast('已提交重判，在后台进行，结果回来会提醒你。', 'info', 'clock');
        } else {
          addToast('这次判定没有可以申诉的记录。', 'info', 'alert');
        }
      }
      // 客观题自动 commit 成功 → 标记 autoCommitted（反馈卡隐藏手动评级、「下一项」只推进）+ 暂存
      // 这次判定的 judge 锚点 id（FINDING 2：让「不服判」入口在自动 commit 后仍能对它发 appeal）。
      // 只在写入成功后置位：失败时保持手动评级行可见，用户可重试/手动评级（不丢答）。
      if (opts.autoRate && opts.advance === false) {
        setAutoCommitted(true);
        committedAppealKind.current = 'assessment' in res ? 'evaluation' : 'judge';
        setAutoCommitJudgeEventId(
          res.judge
            ? 'assessment' in res
              ? res.assessment.candidate_id
              : res.judge.judge_event_id
            : null,
        );
      }
      // advance=false（客观题自动 commit）→ 留在反馈卡让用户先看判定，「下一项」再 onDone()。
      if (opts.advance !== false) onDone();
    } catch {
      setPreview(null);
      setPendingPreview(null);
      setCommittedPreview(null);
      setRating(null);
      setAutoCommitted(false);
      setAutoCommitJudgeEventId(null);
      addToast(JUDGE_FAILURE_MESSAGE, 'info', 'alert');
      // Back to answering: unsaved edits resume autosaving.
      autosave.resume();
    } finally {
      setCommitting(false);
    }
  };

  // YUK-432 (Bugbot FINDING 2) — 客观题自动 commit 后的「不服判」。review 已落库，不能再走 commit（会
  // 重复 submit 一条 review event）；直接对自动 commit 时暂存的 judge 锚点发 appeal。无锚点 → 入口本
  // 就被 appealEntryAvailable 隐藏，这里再兜底一次。
  const submitAutoCommitAppeal = async () => {
    if (!autoCommitJudgeEventId || committing) return;
    setCommitting(true);
    try {
      await fileAppeal(autoCommitJudgeEventId, appealText.trim(), committedAppealKind.current);
      addToast('已提交重判，在后台进行，结果回来会提醒你。', 'info', 'clock');
      setAppealOpen(false);
    } catch {
      addToast('提交重判没有成功，稍后再试一次。', 'info', 'alert');
    } finally {
      setCommitting(false);
    }
  };

  const runJudge = async () => {
    if (returningRef.current || !q || !canSubmit || issuanceMode === 'manual') return;
    setJudging(true);
    autosave.hold();
    try {
      if (isInterventionDiagnostic) {
        // One-shot measurement integrity: do not call the repeatable advice
        // endpoint. The canonical attempt owns the first and only server judge,
        // atomically claims the diagnostic, persists the learner answer, settles
        // the probe, and uses its suggested rating via auto_rate.
        const res = await submitReview({
          question_id: q.id,
          assessment: assessmentInput,
          session_id: sessionId ?? undefined,
          // Required wire fallback only; auto_rate replaces it with the server
          // judge's suggested rating before persistence.
          rating: 'hard',
          response_md: answerMd,
          referenced_knowledge_ids: q.labels.map((l) => l.id),
          stream_item_id: item.id,
          ...buildCaptureFields({ reasoningTrace, selfConfidence }),
          auto_rate: true,
          latency_ms: computeLatencyMs(questionShownAtRef.current, Date.now()),
          // YUK-1051 (D10) — 证据附件随一次性提交冻结（同 commit 路径纪律）。
          ...(imageRefs.length > 0 ? { answer_image_refs: imageRefs } : {}),
        });
        // YUK-1051 — 202-pending union：作答已被原子认领并持久化，判分在 durable lane；
        // 进 pending 卡轮询，终态回揭反馈。绝不提示重交同一答案。
        if (isSubmitPending(res)) {
          setPendingRun({ runId: res.run_id, pollUrl: res.backfill.poll_url });
          return;
        }
        const feedback = feedbackFromCommittedAttempt(res);
        setCommittedPreview(feedback);
        setRating(feedback.suggested_rating);
        setAutoCommitted(true);
        setAutoCommitJudgeEventId(res.judge?.judge_event_id ?? null);
        return;
      }
      const r = await getAdvice(q.id, answerMd, imageRefs, assessmentInput);
      activationIntent.current = r.activation_intent;
      // YUK-444 (PR #1069 thread 修复) — 分流判据是 shouldOfferConfidenceGate(route) 本体，不再在这里
      // 重新拼一遍 isObjectiveQuestion(route)。两者语义严格互补（gate = !isObjectiveQuestion，见上方定义
      // 与 capture 单测的互补断言），但**判据必须只有一处**：单测断言的正是这个生产分支所调的谓词，
      // 否则谓词被单独测绿、生产路径却走另一份拷贝 = 假绿（本 PR review finding）。
      if (!r.automatic_commit || r.judge.suggested_rating === null) {
        // YUK-444 — 开放题（含 semantic-override 的客观题型）：推迟揭晓。judge 结果暂存 pendingPreview
        // → 进 confidence 相位渲 1-5 自评 interstitial，**不 setPreview**（判定卡不渲染）。用户选 1-5 或
        // 「跳过」后经 revealVerdict 才 setPreview 揭晓（先自评再看结果的元认知语义）。评级仍走既有手动流。
        setPendingPreview(r.judge);
      } else {
        // YUK-432 — 客观题（route exact/keyword，与后端 isObjectiveJudgeRoute 同源；不看 kind）：preview
        // 回来即自动 commit（auto_rate:true + suggested_rating），跳过手动 again/hard/good。advance:false 让
        // 用户仍看到判定反馈卡，再按「下一项」推进（commit 成功内部置 autoCommitted）。信心自评插拍**跳过**
        // （auto-commit 流不插；此分支 ⟺ shouldOfferConfidenceGate=false ⟺ isObjectiveQuestion=true）。
        setPreview(r.judge);
        setRating(r.judge.suggested_rating);
        await commit({
          withAppeal: false,
          rating: r.judge.suggested_rating,
          autoRate: true,
          advance: false,
          previewOverride: r.judge, // 闭包里的 preview state 此刻仍 null，传 fresh judge。
        });
      }
    } catch (e) {
      if (isInterventionDiagnostic && e instanceof ApiError && e.status === 409) {
        const restored = await qQ.refetch();
        const committed = restored.data?.committed_attempt;
        if (committed) {
          const feedback = feedbackFromCommittedDiagnosticAttempt(committed);
          setCommittedPreview(feedback);
          setRating(feedback.suggested_rating);
          setAutoCommitted(true);
          setAutoCommitJudgeEventId(committed.judge.judge_event_id);
          return;
        }
      }
      addToast(JUDGE_FAILURE_MESSAGE, 'info', 'alert');
      // Still answering after a failed judge: unsaved edits resume autosaving.
      autosave.resume();
    } finally {
      setJudging(false);
    }
  };

  // YUK-444 — 信心自评确认（选了 1-5）或「跳过」（confidence=null）→ 揭晓判定：把暂存的 judge 结果
  // 提上 preview（触发判定卡渲染）+ 落 suggested_rating 到手动评级默认值。selfConfidence 存进 state，
  // 待用户「确认评级 · 下一项」时随 commit 的 buildCaptureFields 一并发出（跳过 → null → 不发字段）。
  const revealVerdict = (confidence: number | null) => {
    if (!pendingPreview) return;
    setSelfConfidence(confidence);
    setRating(pendingPreview.suggested_rating);
    setPreview(pendingPreview);
    setPendingPreview(null);
  };

  // 键盘：⌘/Ctrl+Enter 提交。选项数字键（1–9，随选项数）已移进 ChoiceSetResponse 的
  // hotkeys（YUK-1051 组件族一般化，不再硬编码 1–4）；这里不再重复监听。
  // YUK-1483：监听挂在 window（文本框里和题面上都能按），但归一个 DOM 节点所有——节点挂上才监听、
  // 卸下即摘；每次提交 React 摘旧挂新，回调读的是本次提交的 phase/hotkeysSuspended。
  // YUK-1473：与 pagehide 落盘分开——视图把它挂在只在作答时存在的节点上（作答操作栏），
  // pagehide 则挂在整个作答面的根上。重复按键不会重复提交：runJudge 已有 judging/canSubmit 互斥。
  const attachSubmitHotkey = (node: HTMLElement | null) => {
    if (!node) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (phase !== 'answering' || hotkeysSuspended) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void runJudge();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  };

  // 「自己评一下」 from an unsupported verdict: back to answering in self-rated mode.
  const startSelfRate = () => {
    setIssuanceMode('manual');
    setPreview(null);
    setPendingPreview(null);
    activationIntent.current = undefined;
    // Back to answering (self-rated): unsaved edits resume autosaving.
    autosave.resume();
  };

  // YUK-1484 — the issuance as a view sees it. Only the pending state carries the attach ref, so
  // the command can only run from the placeholder that stands in for an unsettled issuance.
  // 「按自行评级练习」 re-issues in self-rated mode; 「重试」 brings the placeholder back, whose
  // attach re-runs the command (read first, POST only on 404; the failed request was dropped).
  let issuanceView: PracticeIssuance;
  if (!issued) {
    issuanceView = { status: 'pending', attach: attachIssuance };
  } else if (issued.error || !frozen) {
    issuanceView = {
      status: 'failed',
      error: issued.error,
      retry: () => setIssuance(null),
      startSelfRated: () => setIssuanceMode('manual'),
    };
  } else {
    issuanceView = {
      status: 'ready',
      id: issuanceId,
      mode: issuanceMode,
      frozen,
      accepted,
      restored: restoredIssuanceId === issuanceId,
    };
  }

  // YUK-1489 — the conflict panel's two sides, in the learner's words, and its three choices.
  const conflict: PracticeDraftConflictView | null = draftConflict
    ? {
        conflict: draftConflict,
        mine: draftSummary(draftValue),
        server:
          draftConflict.status === 'ready'
            ? {
                ...draftSummary(serverDraft(draftConflict.answer)),
                savedAt:
                  draftConflict.answer && 'updated_at' in draftConflict.answer
                    ? draftConflict.answer.updated_at
                    : draftConflict.answer && 'submitted_at' in draftConflict.answer
                      ? draftConflict.answer.submitted_at
                      : null,
              }
            : null,
        keepServer: keepServerVersion,
        keepMine: keepMyVersion,
        reload: readServerVersion,
      }
    : null;

  return {
    question: { query: qQ, data: q, isInterventionDiagnostic, timelineEvents },
    issuance: issuanceView,
    draft: {
      responses: nativeResponses,
      evidence,
      isChoice,
      /** YUK-1497 — the frozen presentation when it parses; null = draw per slot. */
      presentation,
      updateResponse: updateNativeResponse,
      updateResponses: updateNativeResponses,
      updateEvidence,
      uploading,
      setUploading,
      /** YUK-1497 — per-composer upload reporting for presentation blocks (key = slot). */
      trackUpload,
      unreceipted,
      setSlotUnreceipted,
      autosave,
    },
    conflict,
    submit: {
      phase,
      canSubmit,
      /** YUK-1497 — 「你的作答」 for custom (sandbox) blocks, plain text; empty when none. */
      customSummary,
      /** YUK-1501 — this issuance's answer is already recorded: read-only review. */
      answerRecorded,
      judging,
      committing,
      returning,
      pendingRun,
      pendingPoll,
      displayedPreview: preview ?? committedPreview,
      committedPreview,
      rating,
      setRating,
      autoCommitted,
      autoCommitJudgeEventId,
      selfConfidence,
      reasoningTrace,
      setReasoningTrace,
      runJudge,
      commit,
      revealVerdict,
      startSelfRate,
    },
    appeal: {
      open: appealOpen,
      setOpen: setAppealOpen,
      text: appealText,
      setText: setAppealText,
      /** After an automatic commit: appeal the stored anchor without submitting again. */
      submitAfterAutoCommit: submitAutoCommitAppeal,
    },
    /** 「返回流」: never blocked by the draft; waits at most 8s for the last save (YUK-1489). */
    handleBack,
    /** Ref for the answering surface's root: keepalive draft flush on pagehide / page hidden. */
    attachPagehideFlush,
    /** Ref for an element that exists only while answering: the ⌘/Ctrl+Enter submit hotkey. */
    attachSubmitHotkey,
  };
}
