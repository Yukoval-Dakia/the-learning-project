// M3 笔记面（YUK-317）— ui 数据层。
// 读：GET /api/notes/[id]（note-page 聚合）；保存：PATCH /api/artifacts/[id]/
// body-blocks（乐观锁 artifact_version）；@ 交叉链：GET /api/artifacts/search；
// @ 题目引用（pre-flight B 用户增量）：GET /api/questions?knowledge_id=…（quiz
// 域旧栈，proxy catch-all，M5 收编）。

import {
  ApiError,
  type ApiOperationJsonResponse,
  type ApiOperationRequestBody,
  apiOperationJson,
} from '@/ui/lib/api';

// ── body_blocks 块模型（ArtifactBodyBlocks passthrough doc） ────────
// 已知块型：semanticBlock（文本块，kind ∈ definition/mechanism/example/
// pitfall —— check 为 D6 墓碑，只读渲染占位不可插入）、crossLinkBlock
//（atom，ADR-0022 flat attrs { id, artifact_id, block_id?, title? }——服务端
// block-refs 索引器按 attrs.artifact_id 写 backlink，勿嵌套 target）、
// questionRefBlock（atom，M3 新增：note 引用题库题，纯引用无作答交互
// ——D6 裁的是内嵌自测全链路）。
export type SemanticKind = 'definition' | 'mechanism' | 'example' | 'pitfall' | 'check';

export const SEMANTIC_KIND_LABEL: Record<Exclude<SemanticKind, 'check'>, string> = {
  definition: '定义',
  mechanism: '机制',
  example: '例子',
  pitfall: '易错点',
};

type NotePageWire = ApiOperationJsonResponse<'getNote'>;
export type BodyBlocksDoc = NonNullable<NotePageWire['body_blocks']>;
export type BodyBlock = BodyBlocksDoc['content'][number];

// ── NotePage wire（server/note-page.ts） ─────────────────────────
type NotePageOptionalProjection =
  | 'backlinks_by_type'
  | 'sections'
  | 'subject_profile'
  | 'updated_at'
  | 'verification_summary';
export type NotePage = Omit<NotePageWire, NotePageOptionalProjection> &
  Partial<Pick<NotePageWire, NotePageOptionalProjection>>;
export type NotePageLabel = NotePage['labels'][number];
export type NotePageBacklink = NotePage['backlinks'][number];
export type NotePageRelatedItem = NotePage['related_learning_items'][number];

export const getNotePage = (id: string): Promise<NotePage> =>
  apiOperationJson('getNote', {
    url: `/api/notes/${encodeURIComponent(id)}`,
    method: 'GET',
  });

export const saveBodyBlocks = (
  artifactId: string,
  input: ApiOperationRequestBody<'updateArtifactBodyBlocks'>,
) =>
  apiOperationJson('updateArtifactBodyBlocks', {
    url: `/api/artifacts/${encodeURIComponent(artifactId)}/body-blocks`,
    method: 'PATCH',
    body: input,
  });

// ── @ 选择器数据源 ───────────────────────────────────────────────
export type ArtifactSearchRow = ApiOperationJsonResponse<'searchArtifacts'>['rows'][number];

export const searchArtifacts = (q: string, exclude?: string, signal?: AbortSignal) =>
  apiOperationJson('searchArtifacts', {
    url: `/api/artifacts/search?q=${encodeURIComponent(q)}${exclude ? `&exclude=${encodeURIComponent(exclude)}` : ''}`,
    method: 'GET',
    init: { signal },
  });

type QuestionListWire = ApiOperationJsonResponse<'listQuestions'>;
export type QuestionPickRow = Pick<QuestionListWire['items'][number], 'id' | 'kind' | 'prompt_md'>;

// 题库无文本搜索参数——按笔记 labels 的知识点过滤（贴本笔记语境）。
// 响应形 = ListQuestionsResult（items 轴，src/server/questions/list.ts）。
export const questionsForKnowledge = (knowledgeIds: string[], limit = 20) => {
  const sp = new URLSearchParams();
  for (const kid of knowledgeIds) sp.append('knowledge_id', kid);
  sp.set('limit', String(limit));
  return apiOperationJson('listQuestions', {
    url: `/api/questions?${sp.toString()}`,
    method: 'GET',
  }).then((response) => ({
    items: response.items.map(({ id, kind, prompt_md }) => ({ id, kind, prompt_md })),
  }));
};

// ── AI refine 痕迹（T5 验过的 ai-changes 链） ────────────────────
export type AiChangeRow = ApiOperationJsonResponse<'listArtifactAiChanges'>['rows'][number];

// ── editing presence（M5 全分支 review H2 接线；YUK-384 session-qualified） ─────
// 写侧契约：编辑中每 5s 心跳 { artifact_id, editor_session_id, status: 'editing' }；
// 离开编辑态 blur { artifact_id, editor_session_id }（服务端 markArtifactIdleAndFlush
// 只删该 session，末个 session 走后才 FIFO apply 被 defer 的 AI patch）。
// editor_session_id = 每个挂载编辑会话一个 UUID（NoteReaderPage 侧 ref 生成）。
export const editingHeartbeat = (artifactId: string, editorSessionId: string) =>
  apiOperationJson('recordEditingHeartbeat', {
    url: '/api/editing-session/heartbeat',
    method: 'POST',
    body: {
      artifact_id: artifactId,
      editor_session_id: editorSessionId,
      status: 'editing',
    },
  });

export const editingBlur = (artifactId: string, editorSessionId: string) =>
  apiOperationJson('markEditingSessionIdle', {
    url: '/api/editing-session/blur',
    method: 'POST',
    body: { artifact_id: artifactId, editor_session_id: editorSessionId },
  });

export const getAiChanges = (artifactId: string) =>
  apiOperationJson('listArtifactAiChanges', {
    url: `/api/artifacts/${encodeURIComponent(artifactId)}/ai-changes`,
    method: 'GET',
  });

// The undo endpoint mirrors the apply-path optimistic lock: it answers HTTP 200 even
// when it did NOT restore the note. A concurrent version bump comes back as
// 'skipped:version_conflict' (the note is unchanged), while 'skipped:already_undone' is a
// real no-op success (the change is already reverted).
export type UndoAiChangeResult = ApiOperationJsonResponse<'undoArtifactAiChange'>;

export const undoAiChange = async (
  artifactId: string,
  eventId: string,
): Promise<UndoAiChangeResult> => {
  const result = await apiOperationJson('undoArtifactAiChange', {
    url: `/api/artifacts/${encodeURIComponent(artifactId)}/ai-changes/${encodeURIComponent(eventId)}/undo`,
    method: 'POST',
  });
  // Reject the false-success case so every caller (note reader + Today changes strip)
  // sees a failure instead of a 200. Status 409 lets conflict-aware callers show the
  // version-conflict copy; 'already_undone' resolves — the change is reverted either way.
  if (result.status === 'skipped:version_conflict') {
    throw new ApiError('undo skipped: version_conflict', 409, 'version_conflict');
  }
  return result;
};
