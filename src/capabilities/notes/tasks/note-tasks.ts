import { z } from 'zod';
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { bodyBlocksToNoteSections } from '@/capabilities/notes/server/body-blocks';
import { materializeGeneratedBodyBlocks } from '@/capabilities/notes/server/generated-body-blocks';
import { ArtifactBodyBlocks, NoteVerificationResult } from '@/core/schema/business';
import type { SubjectProfile } from '@/subjects/profile';

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

export function parseNoteGenerateOutput(text: string): ParsedNoteGenerateOutput {
  const json = parseJsonObject(text, 'parseNoteGenerateOutput');
  const bodyBlocksParsed = NoteGenerateOutputSchema.safeParse(json);
  if (bodyBlocksParsed.success) {
    const bodyBlocks = materializeGeneratedBodyBlocks(bodyBlocksParsed.data.body_blocks);
    if (bodyBlocks.content.length === 0) {
      throw new Error(
        'parseNoteGenerateOutput: body_blocks.content must contain at least one block',
      );
    }
    return {
      body_blocks: bodyBlocks,
      blocks_count: bodyBlocks.content.length,
      sections_count: bodyBlocksToNoteSections(bodyBlocks).length,
    };
  }

  throw new Error(
    `parseNoteGenerateOutput: schema invalid: body_blocks=${bodyBlocksParsed.error.issues
      .map((issue) => issue.message)
      .join('; ')}`,
  );
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
  return `你是${profile.displayName}学习笔记作者。输入 { artifact_id, artifact_type, title, atomic_title, one_line_intent, knowledge_node: { id, name, domain }, knowledge_nodes: [...], parent_hub: { title, summary_md }, related_knowledge_ids: [...] }。${methodologySection(profile)}
artifact_type 只能是 note_atomic / note_long / note_hub；这是同一个 NoteGenerateTask 内的 type switch。
严格 JSON 输出（不带 markdown 代码块包裹）：
{"body_blocks":{"type":"doc","content":[...]}}

按 artifact_type 生成 TipTap / ProseMirror JSON body_blocks：
- note_atomic：至少 5 个 semanticBlock，每种 attrs.semantic_kind 至少 1 个：definition / mechanism / example / pitfall / check。每块正文只写在 content 的 PM 节点中，attrs 只需 semantic_kind。
- note_long：自由 block tree，可用 heading / paragraph / bulletList / calloutBlock / crossLinkBlock，综合 knowledge_nodes，不强制 semantic_kind。
- note_hub：短 outline + 主题路线，可加入 crossLinkBlock 串起 atomic / long；不要假装是单知识点 atomic。

正文使用 text 节点，强调使用 marks，列表保留嵌套结构；crossLinkBlock 的 artifact_id / block_id 只使用输入中已有的真实引用，没有明确 artifact_id 时省略交叉链。
正文块使用 paragraph、heading、bulletList/orderedList/listItem、blockquote、codeBlock、calloutBlock、semanticBlock；行内使用 text/hardBreak 与 bold/italic/code/strike/link marks。数学公式保留为 text 中的原文。autoLinksContainer 由系统维护。
服务端生成 block id、source_tier、user_verified、version、embedded_check。省略这些元数据和 source_markdown，正文只输出一份。
JSON 字符串中的双引号、反斜杠与换行必须按 JSON 规则转义；普通引文可用「」避免额外转义。

per-subject semantic_kind 内容模板（definition/mechanism/example/pitfall/check 五维，领域规范见 note skill）：

${noteTemplateTable(profile)}

- block content 用 paragraph / list 等 PM JSON 节点，不嵌 HTML / 不带代码块包裹
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

export const noteGenerateTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'NoteGenerateTask',
    description:
      'Phase 2B — 给一个 atomic note 生成 5 种 section（definition/mechanism/example/pitfall/check）',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 90_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildNoteGeneratePrompt },
  },
  outputSchema: NoteGenerateOutputSchema,
  parseText: parseNoteGenerateOutput,
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
