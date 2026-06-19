// M2 练习面（YUK-316）— ui 数据层：练习面各视图对真 API 的调用与 wire 类型。
// 路由宿主（dev）：/api/practice、/api/review 经 vite proxy → Hono(:8787)；
// /api/questions/*（题面读 + solve 链）整体留旧栈 proxy——solve 链的旧壳是
// shim、handler 同为包内代码（quiz 域 D16 出 M2 范围，M5 收口）。

import {
  ApiAuthError,
  ApiError,
  apiJson,
  clearInternalToken,
  getInternalToken,
} from '@/ui/lib/api';

// ── 流 ──────────────────────────────────────────────────────────
export type StreamSource = 'decay' | 'variant' | 'new_check' | 'paper' | 'on_demand' | 'import';
export type StreamStatus = 'pending' | 'in_progress' | 'done' | 'skipped';

export interface StreamItem {
  id: string;
  position: number;
  item_kind: 'question' | 'paper';
  ref_id: string;
  source: StreamSource;
  reasoning: string;
  status: StreamStatus;
}

export interface StreamView {
  date: string;
  opening_line: string;
  items: StreamItem[];
  progress: { done: number; total: number };
}

export const getStream = () => apiJson<StreamView>('/api/practice/stream?date=today');

export const advanceStreamItem = (id: string, status: StreamStatus) =>
  apiJson<{ item: StreamItem }>(`/api/practice/stream/items/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });

export const recomposeStream = () =>
  apiJson<StreamView & { added: number }>('/api/practice/stream/recompose', {
    method: 'POST',
    body: JSON.stringify({}),
  });

// ── 散题（题面 + 两段式判分 + 申诉 + 解题会话） ─────────────────
export interface QuestionDetail {
  id: string;
  kind: string;
  prompt_md: string;
  reference_md: string | null;
  choices_md: string[] | null;
  difficulty: number;
  labels: Array<{ id: string; name: string }>;
}

export const getQuestion = (id: string) =>
  apiJson<QuestionDetail>(`/api/questions/${encodeURIComponent(id)}`);

// ── 题详情面 /questions/:id（YUK-413, loom screen-question-detail）─────────────
// GET /api/questions/:id 的完整聚合（src/server/questions/detail.ts QuestionDetail）。
// 上面那个薄 QuestionDetail 是 solve 链用的兼容子集；详情编辑面要全投影：
// family（变体家族）/ parts（composite 小题）/ scheduling（FSRS）/ backlinks（卷引用）
// / timeline（attempt·review）/ version（PATCH/DELETE 乐观锁 token）。
export interface QFullDetailLabel {
  id: string;
  name: string;
}

export interface QFullFamilyMember {
  id: string;
  variant_depth: number;
  kind: string;
  is_self: boolean;
}

export interface QFullPart {
  id: string;
  kind: string;
  part_index: number;
  prompt_md: string;
  difficulty: number;
  draft_status: string | null;
}

export interface QFullPerKnowledge {
  knowledge_id: string;
  name: string | null;
  mastery: number | null;
  evidence_count: number;
  last_evidence_at_sec: number | null;
  decay_bucket: string;
  due_at_sec: number | null;
}

export interface QFullBacklink {
  artifact_id: string;
  type: string;
  title: string;
  tool_kind: string | null;
  intent_source: string;
  generation_status: string;
  created_at_sec: number;
}

export interface QFullTimelineEntry {
  kind: 'attempt' | 'review';
  event_id: string;
  created_at_sec: number;
  outcome: string;
  duration_ms: number | null;
  cause?: { primary: string; confidence: number | null } | null;
  fsrs_rating?: 'again' | 'hard' | 'good';
}

export interface QuestionFullDetail {
  id: string;
  kind: string;
  prompt_md: string;
  reference_md: string | null;
  choices_md: string[] | null;
  rubric_json: unknown;
  difficulty: number;
  source: string;
  source_ref: string | null;
  source_tier: { tier: number; name: string };
  visual_complexity: string | null;
  figures: unknown;
  image_refs: string[];
  variant_depth: number;
  root_question_id: string | null;
  parent_variant_id: string | null;
  parent_question_id: string | null;
  part_index: number | null;
  parts: QFullPart[];
  draft_status: string | null;
  version: number; // PATCH/DELETE 乐观锁 token（YUK-413 加在后端聚合上）。
  knowledge_ids: string[];
  labels: QFullDetailLabel[];
  family: { root_question_id: string; members: QFullFamilyMember[]; variant_count: number };
  scheduling: {
    per_knowledge: QFullPerKnowledge[];
    aggregate_decay_bucket: string;
    legacy_question_fsrs: { due_at_sec: number } | null;
  };
  backlinks: QFullBacklink[];
  backlinks_by_intent_source: Record<string, QFullBacklink[]>;
  timeline: QFullTimelineEntry[];
  metadata: Record<string, unknown> | null;
  created_at_sec: number;
  updated_at_sec: number;
  computed_at_sec: number;
}

export const getQuestionFull = (id: string) =>
  apiJson<QuestionFullDetail>(`/api/questions/${encodeURIComponent(id)}`);

// PATCH 编辑面（editable surface 子集 + version 乐观锁；血缘字段后端 .strict() 拒）。
// 返回 { ok, noop, version, event_id }——noop≡补丁与现行 row 无差异（version 不动）。
export interface QuestionPatchBody {
  version: number;
  prompt_md?: string;
  reference_md?: string | null;
  choices_md?: string[] | null;
  difficulty?: number;
  knowledge_ids?: string[];
  kind?: string;
  draft_status?: 'draft' | 'active' | null;
}

export interface QuestionPatchResult {
  ok: boolean;
  noop: boolean;
  version: number;
  event_id?: string | null;
}

export const patchQuestion = (id: string, body: QuestionPatchBody) =>
  apiJson<QuestionPatchResult>(`/api/questions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });

// DELETE 关联约束门 + 软删。两步：
//   1. 无 confirm → 后端回 409 'confirm_required' + associations 计数（attempts/
//      mistakes/fsrs_cards/paper_refs）。apiJson 会把 409 抛成 ApiError 丢掉 body，
//      故这里直接走 apiFetch 读 409 体（kind:'confirm_required' 返计数）。
//   2. confirm=true&version=N → 软删（re-draft）+ 级联小题 + event。
export interface QuestionAssociationCounts {
  attempts: number;
  mistakes: number;
  fsrs_cards: number;
  paper_refs: number;
}

export type DeleteQuestionResult =
  | { kind: 'confirm_required'; associations: QuestionAssociationCounts; has_associations: boolean }
  | {
      kind: 'archived';
      event_id?: string | null;
      cascaded_part_ids: string[];
      associations: QuestionAssociationCounts;
    };

export async function deleteQuestion(
  id: string,
  opts: { confirm?: boolean; version?: number } = {},
): Promise<DeleteQuestionResult> {
  const sp = new URLSearchParams();
  if (opts.confirm) sp.set('confirm', 'true');
  if (opts.version != null) sp.set('version', String(opts.version));
  const url = `/api/questions/${encodeURIComponent(id)}${sp.toString() ? `?${sp.toString()}` : ''}`;

  // 手摇 fetch（不走 apiJson/apiFetch）：未确认删的第一拍要读 409 'confirm_required'
  // body 的 associations 计数，而 apiJson/apiFetch 在 !res.ok 时直接 throw 丢 body。
  // token 注入沿用 apiFetch 同款（x-internal-token from localStorage）；401 同样清 token。
  const token = getInternalToken();
  if (!token) throw new ApiAuthError('未设置 internal token');
  const res = await fetch(url, { method: 'DELETE', headers: { 'x-internal-token': token } });

  if (res.status === 401) {
    // 与 apiFetch 401 分支一致：清掉失效 token，避免后续请求继续带坏 token。
    clearInternalToken();
    throw new ApiAuthError('token 无效或已过期');
  }

  const body = (await res.json().catch(() => null)) as {
    error?: string;
    message?: string;
    archived?: boolean;
    event_id?: string | null;
    cascaded_part_ids?: string[];
    associations?: QuestionAssociationCounts;
    has_associations?: boolean;
  } | null;

  // 409 confirm_required：约束门（version 校验之前，无写库副作用）→ 回计数给 UI 展示。
  if (res.status === 409 && body?.error === 'confirm_required' && body.associations) {
    return {
      kind: 'confirm_required',
      associations: body.associations,
      has_associations: body.has_associations ?? false,
    };
  }

  if (!res.ok) {
    throw new ApiError(body?.message ?? `${res.status} ${res.statusText}`, res.status, body?.error);
  }

  // 2xx：confirm=true 已软删。
  return {
    kind: 'archived',
    event_id: body?.event_id ?? null,
    cascaded_part_ids: body?.cascaded_part_ids ?? [],
    associations: body?.associations ?? { attempts: 0, mistakes: 0, fsrs_cards: 0, paper_refs: 0 },
  };
}

export interface JudgePreview {
  route: string;
  score: number | null;
  coarse_outcome: 'correct' | 'partial' | 'incorrect' | 'unsupported';
  confidence: number;
  feedback_md: string;
  evidence_json: Record<string, unknown>;
  capability_ref: { id: string; version: string };
  suggested_rating: 'again' | 'hard' | 'good';
}

export const getAdvice = (questionId: string, responseMd: string) =>
  apiJson<{ judge: JudgePreview; advice: unknown }>('/api/review/advice', {
    method: 'POST',
    body: JSON.stringify({ question_id: questionId, response_md: responseMd }),
  });

export interface SubmitResult {
  review_event: { id: string; rating: string };
  judge: { judge_event_id: string | null; suggested_rating: string } | null;
}

// YUK-433 — solo 路径 per-attempt response-time（RT）capture 的纯计算核。A1 SRT 评分（PR2）的硬前置：
// 服务端 submit schema 早已接受 latency_ms（src/capabilities/practice/api/submit.ts:72）并把它映射成事件
// payload 的 duration_ms（同文件 :531）—— 但 SPA 从未发送（旧 Next.js worktree 的 questionShownAt 计时器
// 没被搬过来）。这里复活计算：题面变可见那刻记 shownAtMs，commit 时 now - shownAtMs 即这次作答的墙钟用时。
//
// clamp 边界**逐字对齐**服务端 zod 约束 [0, 3_600_000]（submit.ts:72 的 z.number().int().min(0).max(3_600_000)）：
//   - 负差（系统时钟回拨，now < shownAt）→ Math.max(0, …) clamp 到 0，不发负值。
//   - 超 1 小时（标签页长挂 / 隔夜回来）→ Math.min(3_600_000, …) clamp 到上界，避免服务端 422。
// shownAtMs 为 null（计时器未起 / 题面未就绪）→ 返回 null，调用方据此略过 latency_ms（不发噪声）。
//
// HONEST caveat：latency_ms 是**墙钟用时，含 idle**（切标签页 / 思考停顿 / 隔夜都计入），没有 active-time
// 追踪——一个已知噪声源。下游 A1 SRT 的 rapid-guess downweight + Ter personal baseline（P5 follow-ups）会
// 专门处理它。此外 duration_ms 已被 get-attempt-context 的「为什么错」诊断消费（见上方 QFullTimelineEntry
// .duration_ms + 后端 detail），所以复活 capture 也顺带丰富了那条诊断。
export function computeLatencyMs(shownAtMs: number | null, nowMs: number): number | null {
  if (shownAtMs === null) return null;
  return Math.max(0, Math.min(3_600_000, nowMs - shownAtMs));
}

export const submitReview = (input: {
  question_id: string;
  rating: 'again' | 'hard' | 'good';
  response_md: string;
  referenced_knowledge_ids: string[];
  judge_result_v2?: Omit<JudgePreview, 'route' | 'suggested_rating'> & { score_meaning?: string };
  // YUK-372 L2 — 被答 practice_stream_item.id（流作答传被答 slot id，π_i 直 join 判别子）。
  // 散题/非流作答省略 → server hook skip。
  stream_item_id?: string;
  // YUK-432 — 客观题自动判分+自动评级：true 时 server 用 judge 的 suggested rating 覆盖
  // body.rating（auto-grade），并让客观判分流过 difficulty_calibration_label hook 产标签
  // （B1 难度 firm-up 链解冻）。开放题省略 → 默认 false → 维持现有手动评级流。
  auto_rate?: boolean;
  // YUK-433 — per-attempt 墙钟用时（ms），由 computeLatencyMs 算出并 clamp 到 [0, 3_600_000]。
  // 服务端 submit schema 接受它并映射成事件 payload 的 duration_ms（submit.ts:72/531，**无需后端改动**）。
  // null/省略 → server 略过 duration_ms（向后兼容旧 caller）。墙钟含 idle，是已知噪声源（见 computeLatencyMs）。
  latency_ms?: number | null;
}) => apiJson<SubmitResult>('/api/review/submit', { method: 'POST', body: JSON.stringify(input) });

export const fileAppeal = (judgeEventId: string, reasonMd: string) =>
  apiJson<{ appeal_event_id: string }>('/api/review/appeal', {
    method: 'POST',
    body: JSON.stringify({ judge_event_id: judgeEventId, reason_md: reasonMd }),
  });

export const solveStart = (questionId: string) =>
  apiJson<{ session_id: string }>(`/api/questions/${encodeURIComponent(questionId)}/solve`, {
    method: 'POST',
    body: JSON.stringify({}),
  });

export const solveHint = (questionId: string, sessionId: string, hintIndex: number) =>
  apiJson<{ text_md: string }>(
    `/api/questions/${encodeURIComponent(questionId)}/solve/${encodeURIComponent(sessionId)}/hint`,
    { method: 'POST', body: JSON.stringify({ hint_index: hintIndex }) },
  );

// ── 题库面 /questions（YUK-409, loom screen-questions）─────────────────────────
// GET /api/questions?enrich=true 的投影（src/server/questions/list.ts QuestionListItem）。
// enrich 路径补了 subject（派生学科 profile id）/ knowledge_labels（kchip 中文名）/
// is_composite + children（大题展开小题）——基础投影没有的派生量，YUK-409 additive 补。
export interface QBankSourceTier {
  tier: number;
  name: string;
}

export interface QBankKnowledgeLabel {
  id: string;
  name: string;
}

export interface QBankQuestion {
  id: string;
  kind: string;
  prompt_md: string; // ≤200 字预览（detail 才给全文）。
  source: string;
  source_tier: QBankSourceTier;
  difficulty: number; // 1-5
  visual_complexity: string | null;
  knowledge_ids: string[];
  root_question_id: string | null;
  variant_depth: number;
  parent_question_id: string | null;
  part_index: number | null;
  draft_status: string | null; // NULL≡active；'draft'≡草稿。
  created_at_sec: number; // unix 秒。
  // enrich 路径填（enrich:false 时后端给 null / 非大题默认）。
  subject: string | null; // 派生学科 profile id（'wenyan'|'math'|'eng'|'general'...）。
  knowledge_labels: QBankKnowledgeLabel[] | null;
  is_composite: boolean; // 有 question_part 子题（大题）。
  children: QBankQuestion[]; // 大题的有序小题（part_index 序）；非大题为 []。
}

export interface QBankListResult {
  items: QBankQuestion[];
  families: unknown | null; // 题库面不走 group_by_family，恒 null。
  total: number;
  truncated: boolean;
  computed_at_sec: number;
}

export interface QBankListFilters {
  // API 支持的 server-side 轴（择优 server-side 传参；search 走 client-side，同 DraftReviewPage）。
  subject?: string;
  source?: string;
  kind?: string; // canonical QuestionKind（choice/reading/computation...）。
  difficulty?: number; // 1-5
  knowledgeIds?: string[];
  includeDrafts?: boolean; // 题库面默认 true（状态 tab 需草稿全集 → client 按 draft_status 分）。
  limit?: number;
  offset?: number;
}

export const getQuestionsList = (filters: QBankListFilters = {}) => {
  const sp = new URLSearchParams();
  // 题库 UI 唯一走默认 flat list 路径 → 总带 enrich=true 拉 subject/labels/children。
  sp.set('enrich', 'true');
  if (filters.subject) sp.set('subject', filters.subject);
  if (filters.source) sp.set('source', filters.source);
  if (filters.kind) sp.set('kind', filters.kind);
  if (filters.difficulty != null) sp.set('difficulty', String(filters.difficulty));
  for (const k of filters.knowledgeIds ?? []) sp.append('knowledge_id', k);
  if (filters.includeDrafts) sp.set('include_drafts', 'true');
  if (filters.limit != null) sp.set('limit', String(filters.limit));
  if (filters.offset != null) sp.set('offset', String(filters.offset));
  return apiJson<QBankListResult>(`/api/questions?${sp.toString()}`);
};

// ── 卷（papers list / detail / 草稿 / 逐题提交 / 会话） ─────────
export interface PaperListItem {
  artifact_id: string;
  title: string;
  source: 'coach' | 'custom' | 'note' | 'other';
  intent_source: string;
  generation_status: string;
  knowledge: Array<{ id: string; name: string }>;
  total_slots: number;
  session: { id: string; status: string; pos: number; right: number; wrong: number } | null;
  created_at: string;
}

export const getPapers = () => apiJson<{ papers: PaperListItem[] }>('/api/practice');

export const startPaperSession = (artifactId: string) =>
  apiJson<{ session_id: string }>('/api/practice', {
    method: 'POST',
    body: JSON.stringify({ artifact_id: artifactId }),
  });

export interface PaperSlot {
  question_id: string;
  part_ref: string | null;
  section_index: number;
  question: {
    id: string;
    kind: string;
    prompt_md: string;
    choices_md: string[] | null;
    difficulty: number;
  };
  slot_state: {
    draft: { content_md: string } | null;
    submission:
      | null
      | {
          submitted: true;
          visible_to_user: true;
          outcome: string;
          score: number | null;
          feedback_md: string | null;
          answer_md: string;
          reference_md: string | null;
        }
      | { submitted: true; visible_to_user: false; feedback_buffered: true; answer_md: string };
  };
}

export interface PaperDetail {
  artifact_id: string;
  title: string;
  generation_status: string;
  intent_source: string;
  session: { id: string; status: string; pos: number; right: number; wrong: number } | null;
  sections: Array<{ section_index: number; knowledge_focus_names: string[]; slots: PaperSlot[] }>;
}

export const getPaperDetail = (artifactId: string) =>
  apiJson<PaperDetail>(`/api/practice/${encodeURIComponent(artifactId)}`);

export const savePaperAnswer = (
  artifactId: string,
  input: { session_id: string; question_id: string; part_ref: string | null; answer_md: string },
) =>
  apiJson(`/api/practice/${encodeURIComponent(artifactId)}/answer`, {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const submitPaperSlot = (
  artifactId: string,
  input: { session_id: string; question_id: string; part_ref: string | null; answer_md: string },
) =>
  apiJson(`/api/practice/${encodeURIComponent(artifactId)}/submit`, {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const endPaperSession = (sessionId: string) =>
  apiJson(`/api/review/sessions/${encodeURIComponent(sessionId)}/end`, {
    method: 'POST',
    body: JSON.stringify({}),
  });

// ── 草稿审核池（owner manual gate, YUK-402/403 inc-4） ─────────────
// 后端 server/draft-review.ts 的投影：list 是截断预览 + verify 状态；detail 是
// 全文 prompt + passage/options/answer。verify_status 三态 unverified|needs_review|
// failed（draft 在池=未 promote，故不会是 pass）。

export type DraftVerifyStatus = 'unverified' | 'needs_review' | 'failed';

export interface DraftKnowledgeRef {
  id: string;
  label: string;
}

export interface DraftReviewRow {
  id: string;
  prompt_preview: string;
  kind: string;
  source: string;
  created_at: string;
  difficulty: number;
  knowledge: DraftKnowledgeRef[];
  verify_status: DraftVerifyStatus;
  verify_reason: string | null;
}

export interface DraftReviewListPage {
  rows: DraftReviewRow[];
  limit: number;
  offset: number;
  total: number;
  truncated: boolean;
}

export interface DraftReviewDetail {
  id: string;
  kind: string;
  source: string;
  created_at: string;
  difficulty: number;
  knowledge: DraftKnowledgeRef[];
  prompt_md: string;
  passage: string | null;
  options: string[] | null;
  answer: string | null;
  verify_status: DraftVerifyStatus;
  verify_reason: string | null;
}

/** verify→promote / force-enable 的共享返回（promoted=true 转 active；false 留池+reason）。 */
export interface DraftPromoteResult {
  promoted: boolean;
  status: string;
  verify_event_id: string | null;
  reason: string | null;
}

export interface DraftListFilters {
  source?: string;
  kind?: string;
  limit?: number;
  offset?: number;
}

/**
 * Build the /api/review/drafts query string from filters, with a client-side
 * negative-value guard. The server already clamps limit/offset (review-drafts-list.ts
 * + listDraftReview), so this is defense-in-depth: it stops malformed negatives from
 * ever leaving the browser as `?limit=-5`. Negative/zero limit and negative offset are
 * dropped (omitted → server applies its own default/clamp); valid positive values pass
 * through untouched, so current callers (limit: 200) are unaffected. Pure + exported
 * for unit testing.
 */
export function buildDraftListQuery(filters: DraftListFilters): string {
  const sp = new URLSearchParams();
  if (filters.source) sp.set('source', filters.source);
  if (filters.kind) sp.set('kind', filters.kind);
  // limit must be a positive integer to be meaningful; drop ≤0 / non-finite.
  if (filters.limit != null && Number.isFinite(filters.limit) && filters.limit > 0) {
    sp.set('limit', String(Math.trunc(filters.limit)));
  }
  // offset is a non-negative index; drop negatives / non-finite (0 is valid).
  if (filters.offset != null && Number.isFinite(filters.offset) && filters.offset >= 0) {
    sp.set('offset', String(Math.trunc(filters.offset)));
  }
  return sp.toString();
}

export const getDrafts = (filters: DraftListFilters = {}) => {
  const qs = buildDraftListQuery(filters);
  return apiJson<DraftReviewListPage>(`/api/review/drafts${qs ? `?${qs}` : ''}`);
};

export const getDraftDetail = (id: string) =>
  apiJson<DraftReviewDetail>(`/api/review/drafts/${encodeURIComponent(id)}`);

/** 启用：跑一遍 B5 verify，通过转 active；不过留池并回 needs_review/failed + reason。 */
export const enableDraft = (id: string) =>
  apiJson<DraftPromoteResult>(`/api/review/drafts/${encodeURIComponent(id)}/enable`, {
    method: 'POST',
    body: JSON.stringify({}),
  });

/** 强制启用：跳过 verify 直接转 active，必填 reason 留痕（actor=user · force_enable）。 */
export const forceEnableDraft = (id: string, reason: string) =>
  apiJson<DraftPromoteResult>(`/api/review/drafts/${encodeURIComponent(id)}/force-enable`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
