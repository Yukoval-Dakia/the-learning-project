// M3 笔记面（YUK-317）— ui 数据层。
// 读：GET /api/notes/[id]（note-page 聚合）；保存：PATCH /api/artifacts/[id]/
// body-blocks（乐观锁 artifact_version）；@ 交叉链：GET /api/artifacts/search；
// @ 题目引用（pre-flight B 用户增量）：GET /api/questions?knowledge_id=…（quiz
// 域旧栈，proxy catch-all，M5 收编）。

import { apiJson } from '@/ui/lib/api';

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

export interface BodyBlock {
  type: string; // semanticBlock | crossLinkBlock | questionRefBlock | …
  attrs?: {
    id?: string;
    semantic_kind?: SemanticKind;
    source_tier?: string;
    user_verified?: boolean;
    version?: number;
    source_markdown?: string;
    // crossLinkBlock（flat，ADR-0022）
    artifact_id?: string;
    block_id?: string;
    title?: string;
    // questionRefBlock
    question_id?: string;
    prompt_preview?: string;
    [k: string]: unknown;
  };
  content?: unknown[];
}

export interface BodyBlocksDoc {
  type: 'doc';
  content: BodyBlock[];
}

// ── NotePage wire（server/note-page.ts） ─────────────────────────
export interface NotePageLabel {
  id: string;
  name: string;
}

export interface NotePageBacklink {
  from_artifact_id: string;
  from_learning_item_id: string | null;
  from_title: string;
  from_type: string;
  from_block_id: string;
}

export interface NotePageRelatedItem {
  id: string;
  title: string;
  status: string;
  relation: string;
}

export interface NotePage {
  id: string;
  type: string;
  title: string;
  knowledge_ids: string[];
  labels: NotePageLabel[];
  body_blocks: BodyBlocksDoc | null;
  // ADR-0033 — non-null only when type='interactive' (attrs.html feeds the
  // sandboxed renderer). Note types are always null; an interactive row whose
  // attrs fails server-side schema validation also arrives null while type
  // stays 'interactive' — that pair is the parse-fail degraded signal the
  // reader renders a notice for instead of mounting the renderer.
  interactive: { html: string } | null;
  generation_status: string;
  verification_status: string;
  version: number;
  history: Array<{ version: number; at: string; actor?: string; note?: string }>;
  backlinks: NotePageBacklink[];
  related_learning_items: NotePageRelatedItem[];
  created_at: string;
  updated_at?: string;
}

export const getNotePage = (id: string) =>
  apiJson<NotePage>(`/api/notes/${encodeURIComponent(id)}`);

export const saveBodyBlocks = (
  artifactId: string,
  input: { artifact_version: number; body_blocks: BodyBlocksDoc },
) =>
  apiJson<{ artifact_id: string; artifact_version: number; body_blocks: BodyBlocksDoc }>(
    `/api/artifacts/${encodeURIComponent(artifactId)}/body-blocks`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );

// ── @ 选择器数据源 ───────────────────────────────────────────────
export interface ArtifactSearchRow {
  id: string;
  title: string;
  type: string;
}

export const searchArtifacts = (q: string, exclude?: string) =>
  apiJson<{ rows: ArtifactSearchRow[] }>(
    `/api/artifacts/search?q=${encodeURIComponent(q)}${exclude ? `&exclude=${encodeURIComponent(exclude)}` : ''}`,
  );

export interface QuestionPickRow {
  id: string;
  kind: string;
  prompt_md: string;
}

// 题库无文本搜索参数——按笔记 labels 的知识点过滤（贴本笔记语境）。
// 响应形 = ListQuestionsResult（items 轴，src/server/questions/list.ts）。
export const questionsForKnowledge = (knowledgeIds: string[], limit = 20) => {
  const sp = new URLSearchParams();
  for (const kid of knowledgeIds) sp.append('knowledge_id', kid);
  sp.set('limit', String(limit));
  return apiJson<{ items: QuestionPickRow[] }>(`/api/questions?${sp.toString()}`);
};

// ── AI refine 痕迹（T5 验过的 ai-changes 链） ────────────────────
export interface AiChangeRow {
  event_id: string;
  artifact_id: string;
  created_at: string;
  actor_ref: string;
  ops_count: number;
  new_blocks: number;
  previous_artifact_version: number;
  next_artifact_version: number;
  undone: boolean;
}

// ── editing presence（M5 全分支 review H2 接线） ─────────────────
// 写侧契约与被 T5c 拆除的 ArtifactBlockTree 等价：编辑中每 5s 心跳
// { artifact_id, status: 'editing' }；离开编辑态 blur { artifact_id }（服务端
// markArtifactIdleAndFlush 顺带 FIFO apply 编辑期被 defer 的 AI patch）。
// 读侧 = worker note-refine 经 PgPresenceStore 判 idle（ADR-0023 M5 迁移注）。
export const editingHeartbeat = (artifactId: string) =>
  apiJson<{ ok: boolean }>('/api/editing-session/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ artifact_id: artifactId, status: 'editing' }),
  });

export const editingBlur = (artifactId: string) =>
  apiJson('/api/editing-session/blur', {
    method: 'POST',
    body: JSON.stringify({ artifact_id: artifactId }),
  });

export const getAiChanges = (artifactId: string) =>
  apiJson<{ artifact_id: string; rows: AiChangeRow[] }>(
    `/api/artifacts/${encodeURIComponent(artifactId)}/ai-changes`,
  );

export const undoAiChange = (artifactId: string, eventId: string) =>
  apiJson(
    `/api/artifacts/${encodeURIComponent(artifactId)}/ai-changes/${encodeURIComponent(eventId)}/undo`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
  );
