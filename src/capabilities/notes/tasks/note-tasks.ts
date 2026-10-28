import { z } from 'zod';
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { bodyBlocksToNoteSections } from '@/capabilities/notes/server/body-blocks';
import { materializeGeneratedBodyBlocks } from '@/capabilities/notes/server/generated-body-blocks';
import { ArtifactBodyBlocks, NoteVerificationResult } from '@/core/schema/business';
import type { SubjectProfile } from '@/subjects/profile';
import {
  assertNoteGenerateStopReason,
  compileNoteGenerateDocument,
} from './note-generate-document';

/**
 * 30 minutes stays under the 1h stuck-run sweeper and the queue lease. Operator
 * overrides go through the normal task budget; values above ~54 minutes are
 * refused by provider-session admission.
 */
export const NOTE_GENERATE_TIMEOUT_MS = 30 * 60 * 1000;

export const NoteGenerateOutputSchema = z.object({
  body_blocks: ArtifactBodyBlocks,
});

function parseJsonObject(text: string, parserName: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${parserName}: no JSON object found in text`);
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${parserName}: JSON.parse failed: ${message}`);
  }
}

export interface ParsedNoteGenerateOutput {
  body_blocks: z.infer<typeof ArtifactBodyBlocks>;
  blocks_count: number;
  sections_count: number;
}

export function parseNoteGenerateOutput(
  text: string,
  artifactType?: string,
  finishReason?: string,
): ParsedNoteGenerateOutput {
  assertNoteGenerateStopReason(finishReason);
  const compiled = compileNoteGenerateDocument(text, artifactType);
  const bodyBlocksParsed = NoteGenerateOutputSchema.safeParse({ body_blocks: compiled });
  if (!bodyBlocksParsed.success) {
    throw new Error(
      `parseNoteGenerateOutput: schema invalid: body_blocks=${bodyBlocksParsed.error.issues
        .map((issue) => issue.message)
        .join('; ')}`,
    );
  }
  const bodyBlocks = materializeGeneratedBodyBlocks(bodyBlocksParsed.data.body_blocks);
  if (bodyBlocks.content.length === 0) {
    throw new Error('parseNoteGenerateOutput: body_blocks.content must contain at least one block');
  }
  return {
    body_blocks: bodyBlocks,
    blocks_count: bodyBlocks.content.length,
    sections_count: bodyBlocksToNoteSections(bodyBlocks).length,
  };
}

export function parseNoteVerificationOutput(text: string): z.infer<typeof NoteVerificationResult> {
  const parsed = NoteVerificationResult.safeParse(parseJsonObject(text, 'parseVerificationOutput'));
  if (!parsed.success) {
    throw new Error(
      `parseVerificationOutput: schema invalid: ${parsed.error.issues
        .map((issue) => issue.message)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

function methodologySection(profile: SubjectProfile): string {
  const methodology = profile.promptFragments.methodology?.trim();
  return methodology ? `\n科目方法论：${methodology}` : '';
}

function noteTemplateTable(profile: SubjectProfile): string {
  return `| kind | 内容 |
|---|---|
| definition | ${profile.noteTemplate.definition} |
| mechanism | ${profile.noteTemplate.mechanism} |
| example | ${profile.noteTemplate.example} |
| pitfall | ${profile.noteTemplate.pitfall} |
| check | ${profile.noteTemplate.check} |`;
}

function buildNoteGeneratePrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}学习笔记作者。输入 { artifact_id, artifact_type, title, atomic_title, one_line_intent, knowledge_node: { id, name, domain }, knowledge_nodes: [...], parent_hub: { title, summary_md }, related_knowledge_ids: [...], reference_artifacts: [...] }。${methodologySection(profile)}
artifact_type 只能是 note_atomic / note_long / note_hub。
输入若带 revision_context（上一版正文 body_blocks 与检查发现的问题 issues），本次是修订任务：逐条修正所列问题，尤其数学与事实性陈述错误，保留其余正确内容、结构与链接纪律，仍按 NOTE v1 全文输出。

只输出一份 NOTE v1 内容文档。第一行就是 NOTE v1，最后一行就是 @end。不要写开场白，不要在 @end 之后写任何字，也不要把收尾套话写进最后一段。不要输出 JSON，不要输出 TipTap / ProseMirror，不要用 markdown 代码围栏包住整篇。语言规则里提到的 JSON 字段名不是本任务的输出格式。
公式用 $...$ 或各自独占一行的 $$。多行公式不要把开头的 $$ 和公式写在同一行。LaTeX 反斜杠只写一个，例如 $\\frac{x^2}{a^2}$，不要写成 JSON 转义。引号用「」或英文双引号，原文照写。

格式（标记必须独占一行）：
NOTE v1
@type <与输入 artifact_type 完全相同>

note_atomic 必须包含这五段，顺序不限，每段都要有正文：
@definition
@mechanism
@example
@pitfall
@check

note_long 与 note_hub 用一段自由正文，不要假装成单知识点 atomic：
@body

@end

段内可用 # 标题、空行分段、- 或 1. 列表、> 引用、三个反引号代码块。提示块写成 > [!note] 标题，下一行继续 > 正文；tone 只用 note、tip 或 warning。强调可用 **粗体**、两侧有空格的 _斜体_、\`代码\`。标识符里的下划线保持原样。交叉链接必须单独成行，且只能使用 reference_artifacts 里的 id：[[artifact:<artifact_id>]] 或 [[artifact:<artifact_id>#<block_id>|<标题>]]。目录里可以有尚未写正文的笔记；只链接，不推断其内容。没有合适目标就不要写链接，不要编造 id。链接只用 http、https、mailto。
服务端负责 block id、source_tier、user_verified、version、embedded_check、source_markdown。不要输出这些字段，也不要输出 autoLinksContainer。

per-subject semantic_kind 内容模板（definition/mechanism/example/pitfall/check 五维，领域规范见 note skill）：

${noteTemplateTable(profile)}

- 正文写给人读的段落和列表，不嵌 HTML，不用代码围栏包住整篇
- ${profile.promptFragments.noteExamplePolicy}
- ${profile.grounding.uncertaintyPolicy}
- 禁止：套话、营销话语、emoji / 颜文字`;
}

function buildNoteVerifyPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}学习笔记质检员。输入 { artifact_id, artifact_type, title, knowledge_node, body_blocks, block_summaries, sections }，其中 body_blocks 是 NoteGenerateTask 产出的 TipTap / ProseMirror JSON；sections 仅为旧兼容摘要。
科目上下文：${profile.displayName}。${profile.languageStyle}
证据要求：${profile.grounding.requirement}
输出严格 JSON（不带 markdown 代码块包裹），shape 名称为 NoteVerificationResult：
{"verdict":"pass"|"needs_review","summary_md":"...","issues":[{"block_id":"b1"|null,"severity":"info"|"warn"|"error","category":"factuality"|"coverage"|"clarity"|"subject_fit"|"format"|"safety","message":"...","suggested_fix_md":"..."}],"confidence":0.0-1.0}
四维检查（fallback；详细规范见 note skill）：factuality（自洽不编造，${profile.grounding.uncertaintyPolicy}）/ coverage（atomic 须覆盖 definition/mechanism/example/pitfall/check 五种；long 综合完整；hub 路线+cross-link）/ clarity（按 block_summaries 可读，不空泛）/ subject_fit（符合 ${profile.displayName} 表达与例子风格）。format：block_id 引用 attrs.id；找不到用 null。
判定（fallback）：无 error 且 warn≤2 → pass；任一 error 或 warn>2 或 confidence<0.6 → needs_review。issues≤10 条，message 可执行，suggested_fix_md 有明确改法时填。
禁止：重写整篇 note、markdown 代码块、JSON 之外的文字。`;
}

function artifactTypeFromGenerateInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || !('artifact_type' in input)) return undefined;
  const value = (input as { artifact_type?: unknown }).artifact_type;
  return typeof value === 'string' ? value : undefined;
}

export const noteGenerateTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'NoteGenerateTask',
    description:
      'Phase 2B — 给一个 atomic note 生成 5 种 section（definition/mechanism/example/pitfall/check）',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: NOTE_GENERATE_TIMEOUT_MS },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildNoteGeneratePrompt },
  },
  outputSchema: NoteGenerateOutputSchema,
  parseText: (text, context) =>
    parseNoteGenerateOutput(text, artifactTypeFromGenerateInput(context.input)),
} satisfies TaskSpec<unknown, ParsedNoteGenerateOutput>;

export const noteVerifyTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'NoteVerifyTask',
    description: 'Product Track 1 — second-pass verification for generated atomic note sections',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildNoteVerifyPrompt },
  },
  outputSchema: NoteVerificationResult,
  parseText: parseNoteVerificationOutput,
} satisfies TaskSpec<unknown, z.infer<typeof NoteVerificationResult>>;
