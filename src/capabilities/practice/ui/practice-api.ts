// M2 练习面（YUK-316）— ui 数据层：练习面各视图对真 API 的调用与 wire 类型。
// 路由宿主（dev）：/api/practice、/api/review 经 vite proxy → Hono(:8787)；
// /api/questions/*（题面读 + solve 链）整体留旧栈 proxy——solve 链的旧壳是
// shim、handler 同为包内代码（quiz 域 D16 出 M2 范围，M5 收口）。

import { apiJson } from '@/ui/lib/api';

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

export const submitReview = (input: {
  question_id: string;
  rating: 'again' | 'hard' | 'good';
  response_md: string;
  referenced_knowledge_ids: string[];
  judge_result_v2?: Omit<JudgePreview, 'route' | 'suggested_rating'> & { score_meaning?: string };
  // YUK-372 L2 — 被答 practice_stream_item.id（流作答传被答 slot id，π_i 直 join 判别子）。
  // 散题/非流作答省略 → server hook skip。
  stream_item_id?: string;
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

export const getDrafts = (filters: DraftListFilters = {}) => {
  const sp = new URLSearchParams();
  if (filters.source) sp.set('source', filters.source);
  if (filters.kind) sp.set('kind', filters.kind);
  if (filters.limit != null) sp.set('limit', String(filters.limit));
  if (filters.offset != null) sp.set('offset', String(filters.offset));
  const qs = sp.toString();
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
