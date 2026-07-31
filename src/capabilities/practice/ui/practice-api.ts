// M2 练习面（YUK-316）— ui 数据层：练习面各视图对真 API 的调用与 wire 类型。
// 路由宿主（dev）：/api/papers、/api/review-sessions、/api/practice 经 vite proxy → Hono(:8787)；
// /api/questions/*（题面读 + solve 链）整体留旧栈 proxy——solve 链的旧壳是
// shim、handler 同为包内代码（quiz 域 D16 出 M2 范围，M5 收口）。

import {
  ApiAuthError,
  ApiError,
  type ApiOperationJsonResponse,
  type ApiOperationRequestBody,
  apiOperationJson,
  clearInternalToken,
  getInternalToken,
} from '@/ui/lib/api';
import type { SessionTransitionRequestOptions } from '@/ui/lib/session-transition';

// ── 流 ──────────────────────────────────────────────────────────
// 'frontier'（YUK-551）= B3 learnable_frontier 尾（前置全掌握、自身未掌握的可学前沿 KC）。
// 后端 softmax-selection.ts sourceForRole 早已可产出 source:'frontier' 的 StreamItem（走
// DEFAULT softmax 路径，非 legacy-only），此前 FE 联合漏同步 → PfStream SRC_META bare index
// 崩 TypeError。源枚举有五份手维护副本（schema.ts $type / stream-composer StreamPlanItem.source /
// stream-contracts / 本联合 / PfStream SRC_META keys）无共享 SoT——见 PfStream.tsx srcMeta accessor
// 的运行时兜底。
export type StreamSource =
  | 'decay'
  | 'variant'
  | 'new_check'
  | 'paper'
  | 'on_demand'
  | 'import'
  | 'frontier'
  | 'intervention';
export type StreamStatus = 'pending' | 'in_progress' | 'done' | 'skipped';

export interface StreamItem {
  id: string;
  position: number;
  item_kind: 'question' | 'paper';
  ref_id: string;
  source: StreamSource;
  reasoning: string;
  status: StreamStatus;
  estimated_minutes: number;
  knowledge_name: string | null;
  paper_title: string | null;
  verdict: 'again' | 'hard' | 'good' | null;
  completed_at: string | null;
  total_slots: number | null;
}

export interface StreamView {
  date: string;
  scope?: {
    kind: 'knowledge';
    id: string;
    label: string;
    session_id: string | null;
  } | null;
  opening_line: string;
  items: StreamItem[];
  budget: { pace: 'light' | 'medium' | 'dense'; minutes: number };
  progress: {
    done: number;
    total: number;
    estimated_total_minutes: number;
    estimated_remaining_minutes: number;
  };
}

export function buildPracticeStreamUrl(knowledgeId?: string): string {
  const query = new URLSearchParams({ date: 'today' });
  const normalized = knowledgeId?.trim();
  if (normalized) query.set('kc', normalized);
  return `/api/practice/stream?${query.toString()}`;
}

export const getStream = (knowledgeId?: string): Promise<StreamView> =>
  apiOperationJson('getPracticeStream', {
    url: buildPracticeStreamUrl(knowledgeId),
    method: 'GET',
  });

export const advanceStreamItem = (
  id: string,
  status: StreamStatus,
): Promise<{ item: StreamItem }> =>
  apiOperationJson('updatePracticeStreamItem', {
    url: `/api/practice/stream/items/${id}`,
    method: 'PATCH',
    body: { status },
  });

export const recomposeStream = (): Promise<StreamView & { added: number }> =>
  apiOperationJson('recomposePracticeStream', {
    url: '/api/practice/stream/recompose',
    method: 'POST',
  });

// ── 散题（题面 + 两段式判分 + 申诉 + 解题会话） ─────────────────
export type QuestionFullDetail = ApiOperationJsonResponse<'getQuestion'>;
export type QuestionDetail = Pick<
  QuestionFullDetail,
  'id' | 'kind' | 'prompt_md' | 'reference_md' | 'choices_md' | 'difficulty' | 'labels'
>;

export const getQuestion = (id: string): Promise<QuestionDetail> =>
  apiOperationJson('getQuestion', {
    url: `/api/questions/${encodeURIComponent(id)}`,
    method: 'GET',
  });

export interface QuestionKnowledgeOption {
  id: string;
  name: string;
}

export const getQuestionKnowledgeOptions = (): Promise<{ rows: QuestionKnowledgeOption[] }> =>
  apiOperationJson('getKnowledgeTreeSnapshot', {
    url: '/api/knowledge',
    method: 'GET',
  });

// ── 题详情面 /questions/:id（YUK-413, loom screen-question-detail）─────────────
// GET /api/questions/:id 的完整聚合（src/server/questions/detail.ts QuestionDetail）。
// 上面那个薄 QuestionDetail 是 solve 链用的兼容子集；详情编辑面要全投影：
// family（变体家族）/ parts（composite 小题）/ scheduling（FSRS）/ backlinks（卷引用）
// / timeline（attempt·review）/ version（PATCH/DELETE 乐观锁 token）。
export type QFullDetailLabel = QuestionFullDetail['labels'][number];
export type QFullFamilyMember = QuestionFullDetail['family']['members'][number];
export type QFullPart = QuestionFullDetail['parts'][number];
export type QFullPerKnowledge = QuestionFullDetail['scheduling']['per_knowledge'][number];
export type QFullBacklink = QuestionFullDetail['backlinks'][number];
export type QFullTimelineEntry = QuestionFullDetail['timeline'][number];

export function buildQuestionDetailUrl(id: string, surface?: 'practice'): string {
  const base = `/api/questions/${encodeURIComponent(id)}`;
  return surface ? `${base}?surface=${surface}` : base;
}

export const getQuestionFull = (
  id: string,
  opts: { surface?: 'practice' } = {},
): Promise<QuestionFullDetail> =>
  apiOperationJson('getQuestion', {
    url: buildQuestionDetailUrl(id, opts.surface),
    method: 'GET',
  });

// PATCH 编辑面（editable surface 子集 + version 乐观锁；血缘字段后端 .strict() 拒）。
// 返回 { ok, noop, version, event_id }——noop≡补丁与现行 row 无差异（version 不动）。
export type QuestionPatchBody = ApiOperationRequestBody<'updateQuestion'>;

export interface QuestionPatchResult {
  ok: boolean;
  noop: boolean;
  version: number;
  event_id?: string | null;
}

export const patchQuestion = (id: string, body: QuestionPatchBody) =>
  apiOperationJson('updateQuestion', {
    url: `/api/questions/${encodeURIComponent(id)}`,
    method: 'PATCH',
    body,
  });

// DELETE 关联约束门 + 软删。两步：
//   1. 无 confirm → 后端回 409 'confirm_required' + associations 计数（attempts/
//      mistakes/fsrs_cards/paper_refs/children）。apiJson 会把 409 抛成 ApiError 丢掉 body，
//      故这里直接走 apiFetch 读 409 体（kind:'confirm_required' 返计数）。
//   2. confirm=true&version=N → 软删（re-draft）+ 级联小题 + event。
export interface QuestionAssociationCounts {
  attempts: number;
  mistakes: number;
  fsrs_cards: number;
  paper_refs: number;
  children: number;
}

export type DeleteQuestionResult =
  | { kind: 'confirm_required'; associations: QuestionAssociationCounts; has_associations: boolean }
  | {
      kind: 'archived';
      event_id?: string | null;
      cascaded_part_ids: string[];
      associations: QuestionAssociationCounts;
    };

function normalizeQuestionAssociationCounts(
  counts: Partial<QuestionAssociationCounts> | null | undefined,
  fallbackChildren: number,
): QuestionAssociationCounts {
  return {
    attempts: counts?.attempts ?? 0,
    mistakes: counts?.mistakes ?? 0,
    fsrs_cards: counts?.fsrs_cards ?? 0,
    paper_refs: counts?.paper_refs ?? 0,
    // Additive wire compatibility during a rolling web/API deploy. An older API
    // omits `children`; falling back to the already-loaded detail projection is
    // deliberately conservative so a children-only parent never enters the
    // "safe delete" path while the API and web bundles are on different versions.
    children: counts?.children ?? fallbackChildren,
  };
}

function hasQuestionAssociations(counts: QuestionAssociationCounts): boolean {
  return (
    counts.attempts > 0 ||
    counts.mistakes > 0 ||
    counts.fsrs_cards > 0 ||
    counts.paper_refs > 0 ||
    counts.children > 0
  );
}

export async function deleteQuestion(
  id: string,
  opts: {
    confirm?: boolean;
    confirmChildren?: boolean;
    version?: number;
    fallbackChildren?: number;
  } = {},
): Promise<DeleteQuestionResult> {
  const sp = new URLSearchParams();
  if (opts.confirm) sp.set('confirm', 'true');
  if (opts.confirmChildren) sp.set('confirm_children', 'true');
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
    associations?: Partial<QuestionAssociationCounts>;
    has_associations?: boolean;
  } | null;

  // 409 confirm_required：约束门（version 校验之前，无写库副作用）→ 回计数给 UI 展示。
  if (res.status === 409 && body?.error === 'confirm_required') {
    const associations = normalizeQuestionAssociationCounts(
      body.associations,
      opts.fallbackChildren ?? 0,
    );
    return {
      kind: 'confirm_required',
      associations,
      // Old APIs can truthfully report false only because they do not know about
      // the additive child dimension. Never let that stale aggregate override the
      // conservative detail fallback.
      has_associations: body.has_associations === true || hasQuestionAssociations(associations),
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
    associations: normalizeQuestionAssociationCounts(
      body?.associations,
      opts.fallbackChildren ?? 0,
    ),
  };
}

type ReviewAdviceWire = ApiOperationJsonResponse<'previewReviewAdvice'>;
export type JudgePreview = Omit<ReviewAdviceWire['judge'], 'suggested_rating'> & {
  suggested_rating: NonNullable<ReviewAdviceWire['judge']['suggested_rating']>;
};

export async function getAdvice(
  questionId: string,
  responseMd: string,
): Promise<Omit<ReviewAdviceWire, 'judge'> & { judge: JudgePreview }> {
  const response = await apiOperationJson('previewReviewAdvice', {
    url: '/api/review/advice',
    method: 'POST',
    body: { question_id: questionId, response_md: responseMd },
  });
  if (response.judge.suggested_rating === null) {
    throw new ApiError(
      '本次判定没有可提交的 FSRS 评级，请重试判分。',
      422,
      'judge_rating_unavailable',
    );
  }
  return {
    ...response,
    judge: { ...response.judge, suggested_rating: response.judge.suggested_rating },
  };
}

// YUK-433 — solo 路径 per-attempt response-time（RT）capture 的纯计算核。
// Clamp to the solo submit wire-contract range [0, 3_600_000]. Paper timing uses its
// separate safe-integer contract and sends its cumulative value directly.
export function computeLatencyMs(shownAtMs: number | null, nowMs: number): number | null {
  if (shownAtMs === null) return null;
  return Math.max(0, Math.min(3_600_000, Math.trunc(nowMs - shownAtMs)));
}

type CreateAttemptWire = ApiOperationJsonResponse<'createAttempt'>;
type PendingAttemptWire = Extract<CreateAttemptWire, { verdict: 'pending' }>;
export type SubmitResult = Exclude<CreateAttemptWire, PendingAttemptWire>;
export type SubmitReviewInput = Extract<
  ApiOperationRequestBody<'createAttempt'>,
  { question_id: string }
>;

export async function submitReview(input: SubmitReviewInput): Promise<SubmitResult> {
  const response = await apiOperationJson('createAttempt', {
    url: '/api/attempts',
    method: 'POST',
    body: input,
  });
  if ('verdict' in response) {
    throw new ApiError(
      '判分正在后台处理中，请稍后重试或刷新查看结果。',
      202,
      'judge_pending',
      response,
    );
  }
  return response;
}

export const fileAppeal = (
  judgeEventId: string,
  reasonMd: string,
): Promise<{ appeal_event_id: string }> =>
  apiOperationJson('createAppeal', {
    url: '/api/appeals',
    method: 'POST',
    body: { judge_event_id: judgeEventId, reason_md: reasonMd },
  });

export const solveStart = (questionId: string): Promise<{ session_id: string }> =>
  apiOperationJson('createSolveSession', {
    url: '/api/solve-sessions',
    method: 'POST',
    body: { question_id: questionId },
  });

export const solveHint = (
  questionId: string,
  sessionId: string,
  hintIndex: number,
): Promise<{ text_md: string }> =>
  apiOperationJson('createSolveHintRequest', {
    url: `/api/solve-sessions/${encodeURIComponent(sessionId)}/hint-requests`,
    method: 'POST',
    body: { question_id: questionId, hint_index: hintIndex },
  });

// ── 题库面 /questions（YUK-409, loom screen-questions）─────────────────────────
// GET /api/questions?enrich=true 的投影（src/server/questions/list.ts QuestionListItem）。
// enrich 路径补了 subject（派生学科 profile id）/ knowledge_labels（kchip 中文名）/
// is_composite + children（大题展开小题）——基础投影没有的派生量，YUK-409 additive 补。
type QBankWireResult = ApiOperationJsonResponse<'listQuestions'>;
type QBankWireQuestion = QBankWireResult['items'][number];

// Domain projection: the API contract proves composite children stop at one
// level, while the React tree deliberately consumes one recursive view shape.
// Keep that UI convenience separate from the generated wire type.
export type QBankQuestion = Omit<QBankWireQuestion, 'children'> & {
  children: QBankQuestion[];
};
export type QBankListResult = Omit<QBankWireResult, 'data' | 'items' | 'page'> & {
  data?: QBankWireResult['data'];
  items: QBankQuestion[];
  page: Omit<QBankWireResult['page'], 'next_cursor'> & { next_cursor?: string | null };
};
export type QBankSourceTier = QBankQuestion['source_tier'];
export type QBankKnowledgeLabel = NonNullable<QBankQuestion['knowledge_labels']>[number];

function toQBankQuestion(row: QBankWireQuestion): QBankQuestion {
  return {
    ...row,
    children: row.children.map((child) => ({
      ...child,
      children: [],
    })),
  };
}

export interface QBankListFilters {
  // API 支持的 server-side 轴（择优 server-side 传参；search 走 client-side，同 DraftReviewPage）。
  subject?: string;
  source?: string;
  kind?: string; // canonical QuestionKind（choice/reading/computation...）。
  difficulties?: number[]; // repeated 1-5, OR semantics.
  knowledgeIds?: string[];
  includeDrafts?: boolean; // 题库面默认 true（状态 tab 需草稿全集 → client 按 draft_status 分）。
  status?: 'all' | 'active' | 'draft';
  search?: string;
  sortBy?: 'created_at' | 'difficulty';
  sortDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export function buildQuestionsListQuery(filters: QBankListFilters = {}): string {
  const sp = new URLSearchParams();
  // 题库 UI 唯一走默认 flat list 路径 → 总带 enrich=true 拉 subject/labels/children。
  sp.set('enrich', 'true');
  if (filters.subject) sp.set('subject', filters.subject);
  if (filters.source) sp.set('source', filters.source);
  if (filters.kind) sp.set('kind', filters.kind);
  for (const d of filters.difficulties ?? []) sp.append('difficulty', String(d));
  for (const k of filters.knowledgeIds ?? []) sp.append('knowledge_id', k);
  if (filters.includeDrafts) sp.set('include_drafts', 'true');
  if (filters.status) sp.set('status', filters.status);
  if (filters.search?.trim()) sp.set('search', filters.search.trim());
  if (filters.sortBy) sp.set('sort_by', filters.sortBy);
  if (filters.sortDir) sp.set('sort_dir', filters.sortDir);
  if (filters.limit != null && Number.isFinite(filters.limit) && filters.limit > 0) {
    sp.set('limit', String(Math.trunc(filters.limit)));
  }
  if (filters.offset != null && Number.isFinite(filters.offset) && filters.offset >= 0) {
    sp.set('offset', String(Math.trunc(filters.offset)));
  }
  return sp.toString();
}

export const getQuestionsList = (filters: QBankListFilters = {}): Promise<QBankListResult> =>
  apiOperationJson('listQuestions', {
    url: `/api/questions?${buildQuestionsListQuery(filters)}`,
    method: 'GET',
  }).then((response) => ({
    ...response,
    items: response.items.map(toQBankQuestion),
  }));

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

export const getPapers = (): Promise<{ papers: PaperListItem[] }> =>
  apiOperationJson('listPapers', {
    url: '/api/papers',
    method: 'GET',
  });

export const startPaperSession = (artifactId: string): Promise<{ session_id: string }> =>
  apiOperationJson('createReviewSession', {
    url: '/api/review-sessions',
    method: 'POST',
    body: { paper_id: artifactId },
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

export const getPaperDetail = (artifactId: string): Promise<PaperDetail> =>
  apiOperationJson('getPaper', {
    url: `/api/papers/${encodeURIComponent(artifactId)}`,
    method: 'GET',
  });

type PaperWriteInput = {
  session_id: string;
  question_id: string;
  part_ref: string | null;
  answer_md: string;
  latency_ms?: number;
};

export function buildPaperAnswerDraftBody(artifactId: string, input: PaperWriteInput) {
  return {
    paper_id: artifactId,
    question_id: input.question_id,
    part_ref: input.part_ref,
    content_md: input.answer_md,
  };
}

export function buildPaperSubmissionBody(artifactId: string, input: PaperWriteInput) {
  return {
    paper_id: artifactId,
    question_id: input.question_id,
    part_ref: input.part_ref,
    answer_md: input.answer_md,
    ...(input.latency_ms === undefined ? {} : { latency_ms: input.latency_ms }),
  };
}

// keepalive requests share a spec-mandated ~64KB budget across ALL of the page's in-flight
// keepalive bodies; a body over it makes fetch throw a TypeError synchronously and the draft
// never leaves. Stay comfortably under it (other keepalive PATCHes count too).
export const KEEPALIVE_MAX_BODY_BYTES = 60_000;

export function buildPaperAnswerDraftInit(
  artifactId: string,
  input: PaperWriteInput,
  // keepalive lets an exit/pagehide flush outlive the page teardown: a normal fetch is
  // dropped when the tab closes, but a keepalive PUT (unlike sendBeacon, it still carries
  // the x-internal-token header) is allowed to finish. Best-effort only.
  options: { keepalive?: boolean } = {},
): RequestInit {
  // Serialize once and reuse for both the size check and the request body (no double work).
  const body = JSON.stringify(buildPaperAnswerDraftBody(artifactId, input));
  // Only measure when keepalive is actually requested — `=== true &&` short-circuits the
  // TextEncoder on the common (non-keepalive) autosave path. An oversized draft falls back to
  // a normal fetch rather than throwing on keepalive: on an in-app exit the page is still
  // alive so it lands anyway, and on pagehide a dropped best-effort save is no worse than the
  // TypeError that would otherwise lose it outright.
  const keepalive =
    options.keepalive === true && new TextEncoder().encode(body).length <= KEEPALIVE_MAX_BODY_BYTES;
  return {
    method: 'POST',
    body,
    ...(keepalive ? { keepalive: true } : {}),
  };
}

// UTF-8 byte size of the serialized answer-draft body — what the keepalive budget is measured
// against. Exposed so a batch flush can pre-measure each slot before allocating the budget.
export function paperAnswerDraftBodyBytes(artifactId: string, input: PaperWriteInput): number {
  return new TextEncoder().encode(JSON.stringify(buildPaperAnswerDraftBody(artifactId, input)))
    .length;
}

// keepalive request bodies share ONE ~64KB budget across the whole page, so a batch flush
// (pagehide, many slots) must allocate cumulatively: grant keepalive only while the running
// total stays under the cap, and let the rest fall back to a normal (best-effort) fetch —
// otherwise the later slots' fetch() throws a TypeError and their drafts are lost outright.
export function allocateKeepaliveBudget(
  bodyByteSizes: number[],
  budget = KEEPALIVE_MAX_BODY_BYTES,
): boolean[] {
  let remaining = budget;
  return bodyByteSizes.map((size) => {
    if (size <= remaining) {
      remaining -= size;
      return true;
    }
    return false;
  });
}

export const savePaperAnswer = (
  artifactId: string,
  input: PaperWriteInput,
  options: { keepalive?: boolean } = {},
) => {
  const init = buildPaperAnswerDraftInit(artifactId, input, options);
  return apiOperationJson('createPaperAnswerDraft', {
    url: `/api/review-sessions/${encodeURIComponent(input.session_id)}/answer-drafts`,
    method: 'POST',
    body: buildPaperAnswerDraftBody(artifactId, input),
    init: init.keepalive ? { keepalive: true } : undefined,
  });
};

export const submitPaperSlot = (artifactId: string, input: PaperWriteInput) =>
  apiOperationJson('createPaperSubmission', {
    url: `/api/review-sessions/${encodeURIComponent(input.session_id)}/submissions`,
    method: 'POST',
    body: buildPaperSubmissionBody(artifactId, input),
  });

export const endPaperSession = (sessionId: string) =>
  apiOperationJson('updateReviewSession', {
    url: `/api/review-sessions/${encodeURIComponent(sessionId)}`,
    method: 'PATCH',
    body: { status: 'completed' },
  });

export const pausePaperSession = (
  sessionId: string,
  options: SessionTransitionRequestOptions = {},
) =>
  apiOperationJson('updateReviewSession', {
    url: `/api/review-sessions/${encodeURIComponent(sessionId)}`,
    method: 'PATCH',
    body: { status: 'paused' },
    init: options.keepalive ? { keepalive: true } : undefined,
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
  subject: string | null;
  notation: string | null;
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
  return apiOperationJson('listReviewDrafts', {
    url: `/api/review/drafts${qs ? `?${qs}` : ''}`,
    method: 'GET',
  });
};

export const getDraftDetail = (id: string): Promise<DraftReviewDetail> =>
  apiOperationJson('getReviewDraft', {
    url: `/api/review/drafts/${encodeURIComponent(id)}`,
    method: 'GET',
  });

/** 启用：跑一遍 B5 verify，通过转 active；不过留池并回 needs_review/failed + reason。 */
export const enableDraft = (id: string) =>
  apiOperationJson('enableReviewDraft', {
    url: `/api/review/drafts/${encodeURIComponent(id)}/enable`,
    method: 'POST',
  });

/** 强制启用：跳过 verify 直接转 active，必填 reason 留痕（actor=user · force_enable）。 */
export const forceEnableDraft = (id: string, reason: string) =>
  apiOperationJson('forceEnableReviewDraft', {
    url: `/api/review/drafts/${encodeURIComponent(id)}/force-enable`,
    method: 'POST',
    body: { reason },
  });
