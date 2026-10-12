// YUK-1473 — the solo practice submit/judge flow, shared by PfSolo (retained page) and
// PracticeNextSolo (new design language). Moved verbatim out of PfSolo: same API calls, same
// query keys, same submission / idempotency ids (`submit_stream_<item>`), same phase rules.
// Only rendering differs between the two consumers.
//
// 数据流（两段式）：作答 → POST /api/review/advice（判分预览，不写事件）→
// 反馈卡 + 评级三档（默认=建议）→「确认评级 · 下一项」→ POST /api/attempts
// （judge_result_v2 复用预览判分，不重跑 judge；事件 + FSRS + 判定锚点落库）。
// intervention_diagnostic 是刻意的一段式例外：首份答案直接 POST /api/attempts +
// auto_rate，由服务端真实 judge 原子认领并结算；绝不先打可重复的 advice 预览。
// 不服判：提交重判 = 先 submit（当前评级生效）拿锚点 judge_event_id → appeal
// → 流继续（设计稿「重判中 · 不阻塞，先继续」；改判回执经 M4 工作台/通知回流）。

import { useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ResponseSetT, SlotResponseT } from '@/core/schema/assessment';
import { PartialUnknownJudgeResult } from '@/core/schema/capability';
// 边界（PR #1069 review 修复）：capability 包只依赖 @/kernel/* + 自身 + 共享 UI 件；
// 长度常量走 @/kernel/limits 窄 facade（见 src/kernel/limits.ts 头注释的实测表）。
import { REASONING_TRACE_MAX_LEN } from '@/kernel/limits';
import {
  type EvidenceAttachment,
  isSlotResponseAnswered,
  nativeResponseText,
  nativeResponseValue,
} from '@/ui/components/response/response-types';
import { useJudgeRunPolling } from '@/ui/hooks/useJudgeRunPolling';
import { useResponseDraftAutosave } from '@/ui/hooks/useResponseDraftAutosave';
import { ApiError } from '@/ui/lib/api';
import { toAttemptTimelineEvents } from './attempt-timeline-adapter';
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
  saveResponseDraft,
  submitReview,
} from './practice-api';

/** Transient notice sink; PfSolo passes the host's toast, the new page its own toaster. */
export type PracticeNotify = (text: string, tone?: 'info', icon?: string) => void;

export interface UsePracticeSubmitOptions {
  item: StreamItem;
  /** YUK-535 — server-resolved KC-scoped review session; null for the daily stream. */
  sessionId?: string | null;
  onDone: () => void;
  onBack: () => void;
  // YUK-432 (Bugbot FINDING 1) — 客观题自动 commit 后的「返回流」出口：host 标 slot done + 回列表
  // （不自动推进到下一题）。仅 autoCommitted 时走它；未提供时回落 onBack（向后兼容旧调用方）。
  onCommittedBack?: () => void;
  addToast: PracticeNotify;
  /**
   * Whether the question is on screen. The new page mounts the next question out of sight while
   * the previous one is still showing (YUK-1473); the answer timer starts only once it is shown.
   * Default true.
   */
  shown?: boolean;
}

/**
 * The question-detail read, shared by the hook and the page that prefetches the next question
 * while the learner reads a result (M13). Same key and projection as the hook's own read.
 */
export function questionDetailQuery(refId: string) {
  return {
    queryKey: ['question-detail', refId] as const,
    // Explicit Practice projection lets product-owned diagnostics expose only
    // learner-safe prompt/options while the question-bank surface remains 404.
    queryFn: () => getQuestionFull(refId, { surface: 'practice' }),
  };
}

export type Rating = 'again' | 'hard' | 'good';
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

export const RATING_LABEL: Record<Rating, string> = { again: '再练', hard: '模糊', good: '掌握' };

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

export function usePracticeSubmit({
  item,
  sessionId,
  onDone,
  onBack,
  onCommittedBack,
  addToast,
  shown = true,
}: UsePracticeSubmitOptions) {
  // 题面聚合 /api/questions/:id（getQuestionFull）。注意 getQuestion 与 getQuestionFull 命中同一
  // URL、同一 loadQuestionDetail 全聚合——「轻」query 只是类型窄了子集，服务端并不更省；故这里直接
  // 用全投影，YUK-617 W1 的 timeline 从同一份 data.timeline 白拿，不再二次请求（避免同题双取全聚合）。
  const qQ = useQuery(questionDetailQuery(item.ref_id));
  // YUK-1051 — 选项身份从数组下标换成内容派生的 stable option id（response-types）：
  // 重渲染 / 草稿恢复 / 复盘里同一选项文本恒同 id；选项数不硬编码（1–9 数字键随选项数）。
  const [nativeResponses, setNativeResponses] = useState<ResponseSetT>({ entries: [] });
  const [issuanceMode, setIssuanceMode] = useState<'auto_score' | 'manual'>('auto_score');
  // YUK-1051 (D10) — 开放作答的证据附件（通用文字+附件）；asset ids 随提交走
  // answer_image_refs（CreateAttempt 契约早就有，UI 此前丢弃）。
  const [evidence, setEvidence] = useState<EvidenceAttachment[]>([]);
  // YUK-1094 — 附件上传中：上传批次未 settle 前禁止提交，否则判分/提交跑的是旧 evidence
  // （刚选的附件丢掉）。由 EvidenceComposer 的 onUploadingChange 上报。
  const [uploading, setUploading] = useState(false);
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
  // YUK-562 (过程框) — 「记下你的思路」采集：默认折叠（showTrace=false，一行触发展开），
  // reasoningTrace 是可选过程文本。零强制：不挡提交、折叠即跳过、空值不发字段（buildCaptureFields）。
  const [showTrace, setShowTrace] = useState(false);
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
  const frozenQ = useQuery({
    queryKey: ['practice-issuance', issuanceId, issuanceMode],
    enabled: q !== null,
    retry: false,
    refetchOnMount: 'always',
    queryFn: async () => {
      try {
        return await getIssuanceState(issuanceId);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
      }
      if (!q) throw new Error('question unavailable');
      await issueAssessment({
        issuance_id: issuanceId,
        group_id: q.parent_question_id ?? q.id,
        ...(q.parent_question_id ? { part_ids: [q.id] } : {}),
        mode: issuanceMode,
      });
      return getIssuanceState(issuanceId);
    },
  });
  const frozen = frozenQ.data?.practice_dto;
  const draftEpoch = useRef<number | undefined>(undefined);
  const hydratedIssuance = useRef<string | null>(null);
  const [restoredIssuanceId, setRestoredIssuanceId] = useState<string | null>(null);
  useEffect(() => {
    // Cached data belongs to the previous answering session. Restore only after this
    // mount's successful read, then keep background reads from replacing local edits.
    if (
      !frozenQ.isFetchedAfterMount ||
      frozenQ.isError ||
      !frozenQ.data?.issuance ||
      hydratedIssuance.current === frozenQ.data.issuance.issuance_id
    )
      return;
    hydratedIssuance.current = frozenQ.data.issuance.issuance_id;
    const restored = frozenQ.data.submissions[0] ?? frozenQ.data.draft;
    setNativeResponses(restored?.response_set ?? { entries: [] });
    setEvidence(
      (restored?.group_evidence ?? []).map((item) => ({
        asset_id: item.evidence.asset.asset_id,
        original: item.evidence,
        originalTarget: item.target,
        slot_ids: null,
      })),
    );
    draftEpoch.current = frozenQ.data.draft?.save_epoch;
    setRestoredIssuanceId(frozenQ.data.issuance.issuance_id);
  }, [frozenQ.data, frozenQ.isFetchedAfterMount, frozenQ.isError]);
  const nativeEvidence = useMemo(
    () =>
      evidence.flatMap((item) =>
        item.original
          ? [
              {
                evidence: item.original,
                target: item.originalTarget ?? { scope: 'all_units' as const },
              },
            ]
          : [],
      ),
    [evidence],
  );
  const accepted = frozenQ.data?.submissions[0];
  const assessmentInput = {
    issuance_id: issuanceId,
    evaluation_group_id: accepted?.evaluation_group_id ?? `group_stream_${item.id}`,
    submission_id: accepted?.submission_id ?? `submission_stream_${item.id}`,
    idempotency_key: accepted?.idempotency_key ?? `submit_stream_${item.id}`,
    response_set: nativeResponses,
    group_evidence: nativeEvidence,
  };
  const draftValue = useMemo(
    () => ({ response_set: nativeResponses, group_evidence: nativeEvidence }),
    [nativeResponses, nativeEvidence],
  );
  const autosave = useResponseDraftAutosave({
    value: draftValue,
    enabled:
      restoredIssuanceId === issuanceId &&
      !!frozen &&
      !accepted &&
      !judging &&
      !preview &&
      !pendingPreview &&
      !committing,
    save: async (value) => {
      const ack = await saveResponseDraft(issuanceId, {
        ...value,
        evaluation_group_ref: assessmentInput.evaluation_group_id,
        expected_save_epoch: draftEpoch.current,
      });
      draftEpoch.current = ack.save_epoch;
    },
  });
  const updateNativeResponse = (entry: SlotResponseT) =>
    setNativeResponses((previous) => ({
      entries: [...previous.entries.filter((item) => item.slot_id !== entry.slot_id), entry],
    }));
  const isChoice =
    !!frozen?.response_spec.slots.length &&
    frozen.response_spec.slots.every(
      (slot) => slot.kind === 'single_choice' || slot.kind === 'multi_choice',
    );
  const imageRefs = useMemo(() => evidence.map((a) => a.asset_id), [evidence]);
  const answerMd = nativeResponses.entries
    .map((entry) =>
      nativeResponseText(
        entry,
        frozen?.response_spec.slots.find((slot) => slot.slot_id === entry.slot_id),
      ),
    )
    .join('\n');
  const canSubmit =
    !!frozen &&
    !returning &&
    !judging &&
    !pendingRun &&
    !uploading &&
    evidence.every((item) => item.original !== undefined) &&
    (issuanceMode === 'manual'
      ? nativeResponses.entries.some((entry) =>
          isSlotResponseAnswered(nativeResponseValue(entry)),
        ) || nativeEvidence.length > 0
      : frozen.response_spec.slots
          .filter((slot) => slot.kind !== 'table')
          .every((slot) => {
            const entry = nativeResponses.entries.find((entry) => entry.slot_id === slot.slot_id);
            if (isSlotResponseAnswered(nativeResponseValue(entry))) return true;
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
      if (!(await autosave.flush())) return;
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
    if (q?.id && shown) questionShownAtRef.current = Date.now();
  }, [q?.id, shown]);

  // A successful one-shot is already retired server-side. Restore its
  // canonical review/judge projection on mount so refresh or a lost response
  // returns to the settled feedback card rather than a dead loading state.
  useEffect(() => {
    const committed = q?.committed_attempt;
    if (!committedDiagnosticQuestionId || !isInterventionDiagnostic || !committed) {
      setCommittedPreview(null);
      setAutoCommitted(false);
      setAutoCommitJudgeEventId(null);
      return;
    }
    const feedback = feedbackFromCommittedDiagnosticAttempt(committed);
    setCommittedPreview(feedback);
    setRating(feedback.suggested_rating);
    setAutoCommitted(true);
    setAutoCommitJudgeEventId(committed.judge.judge_event_id);
  }, [committedDiagnosticQuestionId, isInterventionDiagnostic, q?.committed_attempt]);

  // YUK-1051 — 202-pending 轮询：同一次 submission 的 run 继续查询（poll_url 纯读 GET），
  // 终态 done → 用回传的终态判词揭晓反馈卡（与同步回执同一渲染路径）；failed → 诚实
  // 告知「作答已存住，会自动补判」，可先行推进（solo 202 可继续，不阻塞流）。
  const pendingPoll = useJudgeRunPolling({
    runId: pendingRun?.runId ?? null,
    pollUrl: pendingRun?.pollUrl ?? null,
  });
  useEffect(() => {
    if (!pendingRun) return;
    if (pendingPoll.status !== 'done') return;
    const r = pendingPoll.result;
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
  }, [pendingRun, pendingPoll.status, pendingPoll.result, addToast]);

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
    setCommitting(true);
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

  // 「自己评一下」：判不了时改走自行评级（manual issuance），清掉未落库的预览。
  const startSelfRate = () => {
    setIssuanceMode('manual');
    setPreview(null);
    setPendingPreview(null);
    activationIntent.current = undefined;
  };

  const displayedPreview = preview ?? committedPreview;

  return {
    qQ,
    q,
    frozenQ,
    frozen,
    accepted,
    issuanceId,
    issuanceMode,
    setIssuanceMode,
    restoredIssuanceId,
    isInterventionDiagnostic,
    timelineEvents,
    nativeResponses,
    updateNativeResponse,
    evidence,
    setEvidence,
    setUploading,
    autosave,
    isChoice,
    canSubmit,
    phase,
    judging,
    committing,
    returning,
    pendingRun,
    pendingPoll,
    displayedPreview,
    committedPreview,
    rating,
    setRating,
    autoCommitted,
    autoCommitJudgeEventId,
    appealOpen,
    setAppealOpen,
    appealText,
    setAppealText,
    showTrace,
    setShowTrace,
    reasoningTrace,
    setReasoningTrace,
    selfConfidence,
    revealVerdict,
    runJudge,
    commit,
    submitAutoCommitAppeal,
    handleBack,
    startSelfRate,
  };
}
