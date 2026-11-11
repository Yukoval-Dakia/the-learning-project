import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { NotePatch, type NotePatchT } from '@/core/schema/note-patch';
import type { SubjectProfile } from '@/subjects/profile';

export interface ParsedNoteRefineOutput {
  readonly patch: NotePatchT;
}

export function parseNoteRefineOutput(text: string): ParsedNoteRefineOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseNoteRefineOutput: no JSON object found in text');
  }

  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`parseNoteRefineOutput: JSON.parse failed: ${message}`);
  }

  const parsed = NotePatch.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `parseNoteRefineOutput: schema invalid: ${parsed.error.issues
        .map((issue) => issue.message)
        .join('; ')}`,
    );
  }
  return { patch: parsed.data };
}

/** How many of the learner's latest undone AI edits the next refine is told about. */
export const REVERTED_NOTE_EDIT_LIMIT = 8;

export interface RevertedNoteEdit {
  readonly block_ids: readonly string[];
  readonly written_texts: readonly string[];
  readonly summary_line: string;
}

function plainText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const record = node as { text?: unknown; content?: unknown };
  if (typeof record.text === 'string') return record.text;
  if (!Array.isArray(record.content)) return '';
  return record.content.map((child) => plainText(child)).join('');
}

function normalizedBlockText(block: unknown): string {
  return plainText(block).replace(/\s+/g, ' ').trim();
}

function blockAttrId(block: unknown): string | null {
  if (!block || typeof block !== 'object') return null;
  const id = (block as { attrs?: { id?: unknown } }).attrs?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function excerpt(text: string): string {
  return text.length <= 80 ? text : `${text.slice(0, 79)}…`;
}

/**
 * One undone apply. `written_texts` are normalized so a later patch can be
 * compared without caring about whitespace. Empty when the ops carry nothing
 * the learner could have rejected.
 */
export function revertedNoteEditFromOps(ops: unknown): RevertedNoteEdit | null {
  if (!Array.isArray(ops)) return null;
  const blockIds: string[] = [];
  const writtenTexts: string[] = [];
  const lines: string[] = [];
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    const record = op as { kind?: unknown; target_block_id?: unknown; block?: unknown };
    if (typeof record.kind !== 'string') continue;
    const target = typeof record.target_block_id === 'string' ? record.target_block_id : '';
    const text = normalizedBlockText(record.block);
    const createdId = blockAttrId(record.block);
    if (target) blockIds.push(target);
    if (createdId) blockIds.push(createdId);
    if (text) writtenTexts.push(text);
    if (record.kind === 'replace_block' && target) {
      lines.push(`块 ${target} 被替换为「${excerpt(text)}」`);
    } else if (record.kind === 'delete_block' && target) {
      lines.push(`块 ${target} 被删除`);
    } else if (record.kind === 'insert_after' && target) {
      lines.push(`在块 ${target} 后插入「${excerpt(text)}」`);
    } else if (record.kind === 'append_block') {
      lines.push(`文末追加「${excerpt(text)}」`);
    }
  }
  if (blockIds.length === 0 && writtenTexts.length === 0) return null;
  return {
    block_ids: blockIds,
    written_texts: writtenTexts,
    summary_line: lines.join('；'),
  };
}

export function summarizeRevertedNoteEdits(edits: readonly RevertedNoteEdit[]): string {
  const lines = edits.map((edit) => edit.summary_line).filter((line) => line.length > 0);
  if (lines.length === 0) return '';
  return `学习者最近撤销过这些 AI 改动，不要把同样的内容自动写回：\n${lines
    .map((line) => `- ${line}`)
    .join('\n')}`;
}

/** A new patch hits a reverted edit when it targets that block or writes the same text. */
export function patchHitsRevertedNoteEdit(
  patch: NotePatchT,
  edits: readonly RevertedNoteEdit[],
): boolean {
  if (edits.length === 0) return false;
  const blockIds = new Set(edits.flatMap((edit) => edit.block_ids));
  const texts = new Set(
    edits.flatMap((edit) => edit.written_texts).filter((text) => text.length > 0),
  );
  for (const op of patch.ops) {
    if (op.kind !== 'append_block' && blockIds.has(op.target_block_id)) return true;
    if (op.kind === 'delete_block') continue;
    const id = blockAttrId(op.block);
    if (id && blockIds.has(id)) return true;
    const text = normalizedBlockText(op.block);
    if (text && texts.has(text)) return true;
  }
  return false;
}

function buildNoteRefinePrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}学习笔记 Living Note 编辑助手。输入 { artifact_id, artifact_type, title, knowledge_node, body_blocks, block_summaries, reverted_edits_md, trigger: { kind, context_md, evidence_ids? } } —— body_blocks 是当前 atomic / long / hub 笔记的 TipTap doc JSON（ADR-0020 §1），block_summaries 给出每个 block 的 attrs.id + 摘要，reverted_edits_md 是学习者最近撤销过的 AI 改动摘要（空字符串表示没有），trigger 描述触发本次 refine 的原因（mark_wrong / mastery_change / dreaming / verify 之一）。
科目上下文：${profile.displayName}。${profile.languageStyle}
证据要求：${profile.grounding.requirement}
你的产出是一个 NotePatch —— 严格 JSON（不带 markdown 代码块包裹），shape：
{"ops":[NotePatchOp, ...]}

NotePatchOp 是 4 种 op 的 discriminated union（kind 字段判别）：
- {"kind":"insert_after","target_block_id":"<existing block.attrs.id>","block":{...PM JSON node, attrs.id 新建 cuid}}
- {"kind":"replace_block","target_block_id":"<existing block.attrs.id>","block":{...PM JSON node, attrs.id 必须等于 target_block_id（ADR-0020 §2 block_id 稳定）}}
- {"kind":"delete_block","target_block_id":"<existing block.attrs.id>"}
- {"kind":"append_block","block":{...PM JSON node, attrs.id 新建}}

关键约束：
- target_block_id 必须是 block_summaries 里实际存在的 attrs.id；编 ghost id 会导致 apply 失败
- replace_block 的 block.attrs.id 必须等于 target_block_id（ADR-0020 §2，否则 schema reject）
- 新 block 用合法 PM JSON 形态：{type, attrs, content?, marks?}，attrs.id 用短随机串
- 顺着笔记现有结构补：已有 semanticBlock 时挂进合适的块或新建同 semantic_kind 的块（definition / mechanism / example / pitfall / check）；自由正文组织的笔记保持其组织方式，不要硬造五段
- ${profile.grounding.uncertaintyPolicy}

mutator-mode 友好度提示：
- 目标 patch 通常 ≤ 3 个 op，且新增 block（insert_after + append_block）不超过 2 个 —— 这样可直接 apply（mutator-mode），用户在 idle 期回来无干扰
- 如果触发的改动确实需要更大范围重写，按需输出更长 patch；P4-B 的 propose-mode 会把它当 review 项交给用户
- 没有可行 refine 时输出 {"ops":[]}，apply 路径会 no-op，不写 event
- reverted_edits_md 非空时，其中的块和原文是学习者撤销过的改动：不要再输出会把这些内容写回去的 op；没有别的可改时输出 {"ops":[]}

禁止：rewrite 整篇 note、嵌 markdown 代码块、输出 JSON 之外的文字、引入 source_tier / source_markdown / lineage 字段（source_markdown 由服务端 apply 时从 block content 推导，模型只写 content）。`;
}

export const noteRefineTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'NoteRefineTask',
    description:
      'Wave 6 / T-88 P4-A — Living Note refine pass. Given an atomic/long/hub note + a refine trigger, output a NotePatch (insert_after / replace_block / delete_block / append_block ops) for the apply pipeline to execute or surface as a proposal.',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    context: { view: 'none', reason: '笔记任务只加工本条笔记内容，不读学习者历史上下文' },

    prompt: { kind: 'profile', build: buildNoteRefinePrompt },
  },
  outputSchema: NotePatch,
  parseText: parseNoteRefineOutput,
} satisfies TaskSpec<unknown, ParsedNoteRefineOutput>;
