// M2 练习面 — 散题作答态（YUK-316）。
// 设计基准 docs/design/loom-refresh/project/pface-solo.jsx：即时反馈（§6.4 着色
// 即判定）· 评级建议可改 · 不服判（异步重判，不阻塞流）· 解题会话（苏格拉底
// 分级提示，不直接给答案）。
//
// 数据流（两段式）：作答 → POST /api/review/advice（判分预览，不写事件）→
// 反馈卡 + 评级三档（默认=建议）→「确认评级 · 下一项」→ POST /api/attempts
// （judge_result_v2 复用预览判分，不重跑 judge；事件 + FSRS + 判定锚点落库）。
// intervention_diagnostic 是刻意的一段式例外：首份答案直接 POST /api/attempts +
// auto_rate，由服务端真实 judge 原子认领并结算；绝不先打可重复的 advice 预览。
// 不服判：提交重判 = 先 submit（当前评级生效）拿锚点 judge_event_id → appeal
// → 流继续（设计稿「重判中 · 不阻塞，先继续」；改判回执经 M4 工作台/通知回流）。

import { useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
// 边界（PR #1069 review 修复）：capability 包只依赖 @/kernel/* + 自身 + 共享 UI 件
// （src/capabilities/AGENTS.md）。此前这里直 import @/core/schema/event/known 取长度常量，
// 既违反依赖方向，又把整套 event Zod schema 拖进 SPA 模块图（实测 8 模块 / 46.7 KB）。
// 改走 @/kernel/limits 窄 facade（2 模块 / 107 B，零 event schema）——真源仍是 core/limits.ts。
// 注意别改成 @/kernel/capability-contract-schemas：那个 barrel 反而拖 34 模块 / 252.9 KB，
// 见 src/kernel/limits.ts 头注释的实测表。
import { REASONING_TRACE_MAX_LEN } from '@/kernel/limits';
import { AttemptTimeline } from '@/ui/components/AttemptTimeline';
import { ApiError } from '@/ui/lib/api';
import { Btn } from '@/ui/primitives/Btn';
import { Card } from '@/ui/primitives/Card';
import { IconBtn } from '@/ui/primitives/IconBtn';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { useFocusTrap } from '@/ui/primitives/useFocusTrap';
import { toAttemptTimelineEvents } from './attempt-timeline-adapter';
import { HintLadder } from './HintLadder';
import { PfSrcBadge } from './PfStream';
import type { PfToast } from './PracticeFacePage';
import {
  type JudgePreview,
  type QuestionDetail,
  type QuestionFullDetail,
  type StreamItem,
  type SubmitResult,
  type SubmitReviewInput,
  computeLatencyMs,
  fileAppeal,
  getAdvice,
  getQuestionFull,
  submitReview,
} from './practice-api';

type Rating = 'again' | 'hard' | 'good';
type JudgeFeedback = Pick<
  JudgePreview,
  'route' | 'coarse_outcome' | 'confidence' | 'feedback_md' | 'suggested_rating'
>;

const INTERVENTION_DIAGNOSTIC_SOURCE = 'intervention_diagnostic';

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
    confidence: result.judge.confidence,
    feedback_md: result.judge.feedback_md,
    // auto_rate 的正常回执恒带 suggested_rating；旧/滚动部署响应若漏掉，
    // review_event.rating 仍是服务端最终实际采用的评级，不能在 UI 侧猜。
    suggested_rating: result.judge.suggested_rating ?? result.review_event.rating,
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

const VERDICT_OF: Record<JudgePreview['coarse_outcome'], { label: string; tone: Rating }> = {
  correct: { label: '对', tone: 'good' },
  partial: { label: '部分对', tone: 'hard' },
  incorrect: { label: '错', tone: 'again' },
  unsupported: { label: '无法判定', tone: 'hard' },
};

const RATING_LABEL: Record<Rating, string> = { again: '再练', hard: '模糊', good: '掌握' };

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

export function PfSolo({
  item,
  sessionId,
  pos,
  total,
  onDone,
  onBack,
  onCommittedBack,
  addToast,
}: {
  item: StreamItem;
  /** YUK-535 — server-resolved KC-scoped review session; null for the daily stream. */
  sessionId?: string | null;
  pos: number;
  total: number;
  onDone: () => void;
  onBack: () => void;
  // YUK-432 (Bugbot FINDING 1) — 客观题自动 commit 后的「返回流」出口：host 标 slot done + 回列表
  // （不自动推进到下一题）。仅 autoCommitted 时走它；未提供时回落 onBack（向后兼容旧调用方）。
  onCommittedBack?: () => void;
  addToast: (text: string, tone?: PfToast['tone'], icon?: string) => void;
}) {
  // 题面聚合 /api/questions/:id（getQuestionFull）。注意 getQuestion 与 getQuestionFull 命中同一
  // URL、同一 loadQuestionDetail 全聚合——「轻」query 只是类型窄了子集，服务端并不更省；故这里直接
  // 用全投影，YUK-617 W1 的 timeline 从同一份 data.timeline 白拿，不再二次请求（避免同题双取全聚合）。
  const qQ = useQuery({
    queryKey: ['question-detail', item.ref_id],
    // Explicit Practice projection lets product-owned diagnostics expose only
    // learner-safe prompt/options while the question-bank surface remains 404.
    queryFn: () => getQuestionFull(item.ref_id, { surface: 'practice' }),
  });
  const [sel, setSel] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [judging, setJudging] = useState(false);
  const [preview, setPreview] = useState<JudgePreview | null>(null);
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
  const [coach, setCoach] = useState(false);
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
  const isChoice = (q?.choices_md?.length ?? 0) > 0;
  const answerMd = isChoice && sel !== null ? (q?.choices_md?.[sel] ?? '') : text;
  const canSubmit = !judging && (isChoice ? sel !== null : text.trim().length > 0);
  // YUK-444 — 三相：answering（作答）→ confidence（judge 结果暂存、信心自评插拍、判定未揭晓）→
  // feedback（判定卡）。confidence 只在非客观流出现；客观题 answering 直接跳到 feedback（auto-commit）。
  const phase = committedPreview ? 'feedback' : derivePhase(preview, pendingPreview);
  // YUK-432 (Bugbot FINDING 1) — 「返回流」出口：自动 commit 后必须标 slot done（onCommittedBack），
  // 否则只 onBack 会留下「已判分但 slot 卡 in_progress」的不一致。未自动 commit → 原 onBack。
  const handleBack = () =>
    shouldMarkSlotDoneOnBack(autoCommitted) && onCommittedBack ? onCommittedBack() : onBack();

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
    if (!q || !pv || committing) return;
    setCommitting(true);
    try {
      const res = await submitReview({
        question_id: q.id,
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
        auto_rate: opts.autoRate,
        // YUK-433 — solo 路径 RT capture：这次作答的墙钟用时（题面就绪 → 此刻 commit）。在单一 commit()
        // 路径里 stamp，故**两条提交分支都覆盖**：手动评级 commit（开放题）与客观题 auto_rate:true 自动
        // commit 都经此。computeLatencyMs clamp 到 [0, 3_600_000]（对齐 server zod）；shownAt 为 null →
        // 略过（不发噪声）。server 映射成事件 payload 的 duration_ms（无后端改动）。墙钟含 idle，已知噪声源。
        latency_ms: computeLatencyMs(questionShownAtRef.current, Date.now()),
        judge_task_run_id: pv.task_run_id,
        judge_provenance_token: pv.provenance_token,
        // YUK-589 — echo the digested result VERBATIM (see toSubmittedJudgeResult).
        judge_result_v2: toSubmittedJudgeResult(pv),
      });
      if (opts.withAppeal) {
        const anchor = res.judge?.judge_event_id;
        if (anchor) {
          await fileAppeal(anchor, appealText.trim());
          addToast('已提交重判——异步跑，结果回来我会提醒你。', 'info', 'clock');
        } else {
          addToast('这次判定没有可申诉的锚点（无服务端判分）。', 'info', 'alert');
        }
      }
      // 客观题自动 commit 成功 → 标记 autoCommitted（反馈卡隐藏手动评级、「下一项」只推进）+ 暂存
      // 这次判定的 judge 锚点 id（FINDING 2：让「不服判」入口在自动 commit 后仍能对它发 appeal）。
      // 只在写入成功后置位：失败时保持手动评级行可见，用户可重试/手动评级（不丢答）。
      if (opts.autoRate && opts.advance === false) {
        setAutoCommitted(true);
        setAutoCommitJudgeEventId(res.judge?.judge_event_id ?? null);
      }
      // advance=false（客观题自动 commit）→ 留在反馈卡让用户先看判定，「下一项」再 onDone()。
      if (opts.advance !== false) onDone();
    } catch (e) {
      addToast(`提交失败：${(e as Error).message}`, 'info', 'alert');
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
      await fileAppeal(autoCommitJudgeEventId, appealText.trim());
      addToast('已提交重判——异步跑，结果回来我会提醒你。', 'info', 'clock');
      setAppealOpen(false);
    } catch (e) {
      addToast(`提交重判失败：${(e as Error).message}`, 'info', 'alert');
    } finally {
      setCommitting(false);
    }
  };

  const runJudge = async () => {
    if (!q || !canSubmit) return;
    setJudging(true);
    try {
      if (isInterventionDiagnostic) {
        // One-shot measurement integrity: do not call the repeatable advice
        // endpoint. The canonical attempt owns the first and only server judge,
        // atomically claims the diagnostic, persists the learner answer, settles
        // the probe, and uses its suggested rating via auto_rate.
        const res = await submitReview({
          question_id: q.id,
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
        });
        const feedback = feedbackFromCommittedAttempt(res);
        setCommittedPreview(feedback);
        setRating(feedback.suggested_rating);
        setAutoCommitted(true);
        setAutoCommitJudgeEventId(res.judge?.judge_event_id ?? null);
        return;
      }
      const r = await getAdvice(q.id, answerMd);
      // YUK-444 (PR #1069 thread 修复) — 分流判据是 shouldOfferConfidenceGate(route) 本体，不再在这里
      // 重新拼一遍 isObjectiveQuestion(route)。两者语义严格互补（gate = !isObjectiveQuestion，见上方定义
      // 与 capture 单测的互补断言），但**判据必须只有一处**：单测断言的正是这个生产分支所调的谓词，
      // 否则谓词被单独测绿、生产路径却走另一份拷贝 = 假绿（本 PR review finding）。
      if (shouldOfferConfidenceGate(r.judge.route)) {
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
      addToast(`判分失败：${(e as Error).message}`, 'info', 'alert');
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

  // 键盘：1-4 选项 · ⌘/Ctrl+Enter 提交
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phase !== 'answering' || coach) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void runJudge();
        return;
      }
      if (isChoice && /^[1-4]$/.test(e.key) && (e.target as HTMLElement).tagName !== 'TEXTAREA') {
        setSel(Number(e.key) - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (qQ.isLoading) return <p className="quiet-empty">取题中…</p>;
  if (qQ.isError || !q)
    return (
      <div className="pfs">
        <Btn size="sm" variant="ghost" icon="arrowL" onClick={onBack}>
          返回流
        </Btn>
        <p className="quiet-empty">题面加载失败：{(qQ.error as Error | null)?.message ?? '未知'}</p>
      </div>
    );

  const displayedPreview = preview ?? committedPreview;
  const verdict = displayedPreview ? VERDICT_OF[displayedPreview.coarse_outcome] : null;

  return (
    <div className="pfs" data-screen-label={`散题作答 · ${q.id}`}>
      <div className="pfs-top">
        {/* YUK-432 (FINDING 1) — 自动 commit 后「返回流」走 handleBack（标 slot done），否则 onBack。 */}
        <Btn size="sm" variant="ghost" icon="arrowL" onClick={() => handleBack()}>
          返回流
        </Btn>
        <span className="pfs-pos">
          流 · 第 {pos} / {total} 项
        </span>
        <PfSrcBadge source={item.source} />
        <span className="topbar-spacer" />
        {!isInterventionDiagnostic && (
          <Btn size="sm" variant="secondary" icon="teach" onClick={() => setCoach(true)}>
            卡住了？解题会话
          </Btn>
        )}
      </div>

      <Card pad="lg">
        <div className="nowrap-meta" style={{ marginBottom: 'var(--s-2)' }}>
          {q.labels.map((l) => (
            <span key={l.id} className="chip chip-k">
              {l.name}
            </span>
          ))}
          <span className="meta mono">{q.id.slice(0, 12)}</span>
        </div>

        <div className="pfs-stem">{q.prompt_md}</div>

        {isChoice ? (
          <div className="pfs-opts" role="radiogroup" aria-label="选项">
            {(q.choices_md ?? []).map((c, i) => {
              const graded = phase === 'feedback';
              const isRight = graded && displayedPreview?.coarse_outcome === 'correct' && sel === i;
              const isWrong = graded && displayedPreview?.coarse_outcome !== 'correct' && sel === i;
              const cls = [
                'pfs-opt',
                !graded && sel === i ? 'is-sel' : '',
                isRight ? 'is-right' : '',
                isWrong ? 'is-wrong' : '',
              ].join(' ');
              return (
                <button
                  type="button"
                  key={c}
                  className={cls}
                  // YUK-444 — 作答面在 confidence（自评插拍）与 feedback 相位都冻结（非 answering
                  // 即禁选），避免揭晓前改答；着色仍只在 feedback（graded）依 preview 生效。
                  disabled={phase !== 'answering'}
                  // biome-ignore lint/a11y/useSemanticElements: 设计稿卡片式选项
                  // （pfs-opt 布局）；native <input type="radio"> 无法承载该布局，
                  // 真 <button> + radiogroup ARIA 模式语义完整（同 PracticeChoiceOptions）。
                  role="radio"
                  aria-checked={sel === i}
                  onClick={() => setSel(i)}
                >
                  <span className="k mono">{String.fromCharCode(65 + i)}</span>
                  <span className="t">{c}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div style={{ marginTop: 'var(--s-5)' }}>
            <div className="composer answer-composer">
              <textarea
                rows={3}
                value={text}
                disabled={phase !== 'answering'}
                placeholder="写下你的解答…"
                onChange={(e) => setText(e.target.value)}
                aria-label="作答"
              />
            </div>
          </div>
        )}

        {/* YUK-562 — 过程框「记下你的思路」：作答面与提交 CTA 之间，仅开放/文本作答题（!isChoice）显示，
            客观（选择）题隐藏。默认折叠（一行触发展开 textarea）。零强制：不挡提交、折叠即跳过、
            空值不发字段（buildCaptureFields 在 commit 时 trim 判空）。vision §8 红线 3：可完全忽略、不打断流。 */}
        {phase === 'answering' && shouldOfferProcessBox(isChoice) && (
          <div className="pfs-trace">
            {showTrace ? (
              <div className="composer pfs-trace-composer">
                <textarea
                  rows={2}
                  value={reasoningTrace}
                  // YUK-562 — 硬闸在 REASONING_TRACE_MAX_LEN（与 server zod .max() 同源），挡住
                  // 越界输入撞 400 软死锁；buildCaptureFields 发送前再防御性截断兜底粘贴/IME 绕过。
                  maxLength={REASONING_TRACE_MAX_LEN}
                  placeholder="随手记下你是怎么想的——不评分，也可以留空。"
                  onChange={(e) => setReasoningTrace(e.target.value)}
                  aria-label="解题思路（可选）"
                />
              </div>
            ) : (
              <button type="button" className="pfs-trace-toggle" onClick={() => setShowTrace(true)}>
                ＋ 记下你的思路（可选）
              </button>
            )}
          </div>
        )}

        {phase === 'answering' && (
          <div className="pfs-actions">
            <Btn
              variant="primary"
              icon="check"
              onClick={() => void runJudge()}
              disabled={!canSubmit}
            >
              {judging ? '判分中…' : '提交 · 即时判分'}
            </Btn>
            <span className="key-hints mono" style={{ marginLeft: 'auto' }}>
              {isChoice ? '1-4 选 · ⌘Enter 提交' : '⌘Enter 提交'}
            </span>
          </div>
        )}

        {/* YUK-444 — 信心自评 in-page interstitial：提交后、判定揭晓前插一拍。1-5 自评 + 「跳过」，
            推迟揭晓——选一档或跳过（revealVerdict）后才 setPreview 渲判定卡（先自评再看结果的元认知语义）。
            observe-only：值只随 commit 落 review event payload.self_confidence，绝不进判分 / FSRS / θ̂。
            零强制：「跳过」= confidence:null → 不发字段。客观题 auto-commit 流不经此（不插拍）。
            aria-live=polite 沿用判定卡的读屏习惯，让插拍出现时被朗读。 */}
        {phase === 'confidence' && (
          <div className="pfs-conf" aria-live="polite">
            <span className="pfs-conf-q">看答案之前——你有几分把握？</span>
            {/* biome-ignore lint/a11y/useSemanticElements: 原生 <fieldset> 自带
                border/margin/legend 布局，与这排 pill 按钮的 flex 形制不兼容；role=group
                + aria-label 是无表单语义的按钮分组的完整 ARIA 模式（同 .pfs-opts radiogroup）。 */}
            <div className="pfs-conf-scale" role="group" aria-label="信心自评，1 到 5">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  type="button"
                  key={n}
                  className={`pfs-conf-btn${selfConfidence === n ? ' on' : ''}`}
                  aria-label={`把握 ${n} 分（共 5 分）`}
                  onClick={() => revealVerdict(n)}
                >
                  {n}
                </button>
              ))}
              <button type="button" className="pfs-conf-skip" onClick={() => revealVerdict(null)}>
                跳过
              </button>
            </div>
            <span className="pfs-conf-hint">1 = 全靠猜 · 5 = 十拿九稳 · 不评分</span>
          </div>
        )}

        {phase === 'feedback' && displayedPreview && verdict && (
          // YUK-718 — 判定卡是即时判分结果，须播报给读屏（对/错 + AI 反馈）。
          // aria-live=polite 沿用仓库 live-region 习惯（.li-intent-preview /
          // .pf-toasts）——不加 role=status，因 biome useSemanticElements 会要求换
          // <output>；polite live region 已足够让读屏在判定卡出现时朗读内容。
          <div className={`pfs-fb v-${verdict.tone}`} aria-live="polite">
            <div className="pfs-fb-head">
              <span className={`badge tone-${verdict.tone}`}>
                <LoomIcon
                  name={
                    verdict.tone === 'good' ? 'check' : verdict.tone === 'again' ? 'close' : 'minus'
                  }
                  size={12}
                />
                {verdict.label}
              </span>
              <span className="ai-tag">
                <LoomIcon name="sparkle" size={12} />
                AI 判定
              </span>
              <span className="pfs-fb-meta">
                judge · {displayedPreview.route} · {Math.round(displayedPreview.confidence * 100)}%
              </span>
            </div>
            <p className="pfs-fb-text">{displayedPreview.feedback_md}</p>
            {q.reference_md && (
              <div className="pfs-fb-ref">
                <span className="cmp-label">参考</span>
                {q.reference_md}
              </div>
            )}

            {/* YUK-617 W1 — 本题最近 attempt·review 历史（判定卡内、错因旁）。有历史才出，
                首次作答无历史不渲染，避免 clutter。重复错因会自动标红（组件内 ×前缀 + again 色）。 */}
            {timelineEvents.length > 0 && <AttemptTimeline events={timelineEvents} />}

            {/* YUK-432 — 客观题自动判分+自动评级：preview 回来已自动 commit（auto_rate:true），故
                隐藏手动 again/hard/good 评级行；用户仍看到上面的判定反馈卡，按「下一项」推进。
                注意：仅隐藏**手动评级行**——「不服判」入口仍保留（FINDING 2，见下方 footer）。
                开放题：保留现有手动评级行（默认=建议，可改）。 */}
            {!autoCommitted && (
              <div className="pfs-rate">
                <span className="pfs-rate-label">评级</span>
                {(['again', 'hard', 'good'] as const).map((g) => (
                  <button
                    type="button"
                    key={g}
                    className={`pfs-rate-btn t-${g}${rating === g ? ' on' : ''}`}
                    onClick={() => setRating(g)}
                  >
                    {RATING_LABEL[g]}
                  </button>
                ))}
                <span className="pfs-rate-advised">
                  建议：{RATING_LABEL[displayedPreview.suggested_rating]}
                </span>
              </div>
            )}

            <div className="pfs-fb-foot">
              {autoCommitted ? (
                // 客观题：已自动判分+评级，「下一项」只推进（不再二次 commit）。
                <Btn variant="primary" icon="arrow" disabled={committing} onClick={() => onDone()}>
                  {committing ? '判分中…' : '下一项'}
                </Btn>
              ) : (
                // 开放题：手动确认评级后 commit（auto_rate 缺省 false → server 用 body.rating）。
                <Btn
                  variant="primary"
                  icon="arrow"
                  disabled={committing || !rating}
                  onClick={() => rating && void commit({ withAppeal: false, rating })}
                >
                  {committing ? '提交中…' : '确认评级 · 下一项'}
                </Btn>
              )}
              {/* YUK-432 (FINDING 2) — 「不服判」入口在客观题自动 commit 后**仍可用**（旧实现错误地
                  用 autoCommitted 隐藏它）：deterministic 判定（exact/keyword）也落了 judge 锚点，可
                  对它发 appeal（如 exact-match 误拒等价答案）。可用性由 appealEntryAvailable 统一判：
                  自动流要求拿到锚点 id，手动流恒可见。 */}
              {appealEntryAvailable({
                phase,
                appealOpen,
                autoCommitted,
                autoCommitJudgeEventId,
              }) && (
                <button
                  type="button"
                  className="pfs-appeal-link"
                  onClick={() => setAppealOpen(true)}
                >
                  不服判？附理由重判
                </button>
              )}
            </div>

            {appealOpen && (
              <div className="pfs-appeal">
                <div className="composer">
                  <textarea
                    rows={2}
                    value={appealText}
                    placeholder="说说为什么——比如「我的表述和参考是等价的」"
                    onChange={(e) => setAppealText(e.target.value)}
                    aria-label="不服判理由"
                  />
                </div>
                <div className="pfs-actions" style={{ marginTop: 'var(--s-3)' }}>
                  {/* 自动 commit 流：review 已落库 → 直接对暂存锚点发 appeal（不再二次 submit）。
                      手动流：commit({ withAppeal:true }) 一次性 submit + appeal（既有行为不变）。 */}
                  {autoCommitted ? (
                    <Btn
                      size="sm"
                      variant="secondary"
                      icon="send"
                      disabled={!appealText.trim() || committing || !autoCommitJudgeEventId}
                      onClick={() => void submitAutoCommitAppeal()}
                    >
                      提交重判 · 先继续
                    </Btn>
                  ) : (
                    <Btn
                      size="sm"
                      variant="secondary"
                      icon="send"
                      disabled={!appealText.trim() || committing || !rating}
                      onClick={() => rating && void commit({ withAppeal: true, rating })}
                    >
                      提交重判 · 先继续
                    </Btn>
                  )}
                  <Btn size="sm" variant="ghost" onClick={() => setAppealOpen(false)}>
                    算了
                  </Btn>
                  <span className="key-hints mono" style={{ marginLeft: 'auto' }}>
                    re-judge · 异步 · 不阻塞流
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      <PfCoach open={coach} onClose={() => setCoach(false)} question={q} />
    </div>
  );
}

/* ── 解题会话 — 6 阶 hint 强度梯（YUK-354 A2，solve 链 API） ──
   抽屉壳（触发/scrim/focus-trap/「会话不计入判分」note/关闭）保留；body 由旧的「无级线性、点一次
   给一条」提示流换成可感知的 6 阶 H0-H5 强度梯（HintLadder）。强度梯本身的状态机 + 形态在 HintLadder。 */
function PfCoach({
  open,
  onClose,
  question,
}: {
  open: boolean;
  onClose: () => void;
  question: QuestionDetail;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  useFocusTrap(open, onClose, panelRef);

  return createPortal(
    <>
      {open && (
        <div
          className="scrim open"
          style={{ zIndex: 35 }}
          onClick={onClose}
          onKeyDown={() => {}}
          role="presentation"
        />
      )}
      <aside
        className={`pfs-coach${open ? ' open' : ''}`}
        ref={panelRef as never}
        // biome-ignore lint/a11y/useSemanticElements: native <dialog> 需要
        // imperative showModal()/close() API，与 CSS-class 驱动的 .open 抽屉
        // + scrim/focus-trap 模式不兼容（同 CopilotDrawer）。
        role="dialog"
        aria-label="解题会话"
        aria-hidden={!open}
      >
        <div className="pfs-coach-head">
          <span className="ai-tag">
            <LoomIcon name="teach" size={13} />
            解题会话
          </span>
          <span className="meta mono">H0–H5 · 逐阶加力</span>
          <span className="topbar-spacer" />
          <IconBtn icon="close" size={16} title="关闭" onClick={onClose} />
        </div>
        <div className="pfs-coach-body">
          <p className="pfs-coach-note">
            一级一级加力，每阶更近一步；想直接看完整解也行（记为非独立完成）。会话不计入判分。
          </p>
          <HintLadder open={open} question={question} onReturnToAnswer={onClose} />
        </div>
      </aside>
    </>,
    document.body,
  );
}
