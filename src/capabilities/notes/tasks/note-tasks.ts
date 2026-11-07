import { z } from 'zod';
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { materializeGeneratedBodyBlocks } from '@/capabilities/notes/server/generated-body-blocks';
import { ArtifactBodyBlocks } from '@/core/schema/business';
import { bodyBlocksToNoteSections } from '@/kernel/read-models/note-sections';
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

function buildNoteGeneratePrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}学习笔记作者。输入 { artifact_id, artifact_type, title, atomic_title, today, one_line_intent, knowledge_node: { id, name, domain }, knowledge_nodes: [...], parent_hub: { title, summary_md }, related_knowledge_ids: [...], reference_artifacts: [...] }。today 是学习者本地（Asia/Shanghai）日期与星期（YYYY-MM-DD（周X）），提到「今天/明天/下周」等相对日期时以它为锚。
本科目文档库目录在系统提示末尾：先用 read_subject_doc 读 skill/note（本科目笔记规范）与 guide/notes（例题政策与五维自查表）、guide/grounding（事实纪律），再按下述要求写；方法论与教学风格见 guide/teaching。
artifact_type 只能是 note_atomic / note_long / note_hub。
输入若带 revision_context（上一版正文 body_blocks 与检查发现的问题 issues），本次是修订任务：逐条修正所列问题，尤其数学与事实性陈述错误，保留其余正确内容、结构与链接纪律，仍按 NOTE v1 全文输出。

只输出一份 NOTE v1 内容文档。第一行就是 NOTE v1，最后一行就是 @end。不要写开场白，不要在 @end 之后写任何字，也不要把收尾套话写进最后一段。不要输出 JSON，不要输出 TipTap / ProseMirror，不要用 markdown 代码围栏包住整篇。语言规则里提到的 JSON 字段名不是本任务的输出格式。
公式用 $...$ 或各自独占一行的 $$。多行公式不要把开头的 $$ 和公式写在同一行。LaTeX 反斜杠只写一个，例如 $\\frac{x^2}{a^2}$，不要写成 JSON 转义。引号用「」或英文双引号，原文照写。

格式（标记必须独占一行）：
NOTE v1
@type <与输入 artifact_type 完全相同>

note_atomic 的正文结构跟着材料组织走——概念材料沿它的引入链条写，题解材料沿条件、思路、步骤写，实验材料沿目的、操作、现象与结论写；不套用固定分段。正文可以直接写（等价于写在 @body 里），用 ## 及以下标题、小节和列表按材料自身的展开组织；页面已展示笔记标题，正文开头不要重复写一级标题。某个维度值得单独成段时再另起一行 @<维度名> 挂语义段（可选维度见下方自查表）；挂 @ 段之后想回到自由正文再写一行 @body。声明的每个 @ 段都要有正文。

note_long 与 note_hub 用一段自由正文，不要假装成单知识点 atomic：
@body

@end

段内可用 # 标题、空行分段、- 或 1. 列表、> 引用、三个反引号代码块。提示块写成 > [!note] 标题，下一行继续 > 正文；tone 只用 note、tip 或 warning。强调可用 **粗体**、两侧有空格的 _斜体_、\`代码\`。标识符里的下划线保持原样。交叉链接必须单独成行，且只能使用 reference_artifacts 里的 id：[[artifact:<artifact_id>]] 或 [[artifact:<artifact_id>#<block_id>|<标题>]]。reference_artifacts 里有与正文直接相关的材料时，在正文首次依托它的地方放一条交叉链接，让读者能回到材料原文；没有合适目标就不要写链接，不要编造 id。目录里可以有尚未写正文的笔记；只链接，不推断其内容。链接只用 http、https、mailto。
服务端负责 block id、source_tier、user_verified、version、embedded_check、source_markdown。不要输出这些字段，也不要输出 autoLinksContainer。

读到读者可能卡住的地方——材料依赖却没有展开的先行概念、记号约定、被省略的依据——可以就地补一小段背景，帮读者自己过卡点；只补理解这份材料必需的内容，不写成与材料无关的百科条目。

篇幅控制：整篇以覆盖材料要点与卡点为准，写得紧凑；多分支的推导给分段结论与判定依据即可，不逐行展开所有演算，写完立即以 @end 收尾。

成稿自查（这是查漏清单，不是分段模板）：按材料写完正文后对照 skill/note 里的五维表问自己——少了哪一维，读者理解这份材料会卡住？会卡的维度就地补上（可挂对应 @ 段，也可并进相邻正文）；五个维度都用不到就一维不加，材料本身已讲透的维度也不重复写。

- 正文写给人读的段落和列表，不嵌 HTML，不用代码围栏包住整篇
- 例题写法按 guide/notes 的例题政策；${profile.grounding.uncertaintyPolicy}
- 正文结尾停在最后一个知识点上，不写收尾套话：不要「以上就是这篇/本篇笔记」「希望对你有帮助/有用」「如有问题/疑问」「欢迎继续提问」「祝你学习」「祝学习进步」之类的客气话或邀请提问
- 禁止：营销话语、emoji / 颜文字`;
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
    description: 'Phase 2B — 生成一篇结构跟随材料的笔记（五维 semantic_kind 仅作写作参考）',
    // maxIterations 覆盖 read_subject_doc 按需读（规范 + 政策）后再产出；无文档
    // 可读时（目录为空/表未就绪）单轮即收口。
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 6, timeout: NOTE_GENERATE_TIMEOUT_MS },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    context: { view: 'none', reason: '笔记任务只加工本条笔记内容，不读学习者历史上下文' },

    prompt: { kind: 'profile', build: buildNoteGeneratePrompt },
  },
  outputSchema: NoteGenerateOutputSchema,
  parseText: (text, context) =>
    parseNoteGenerateOutput(text, artifactTypeFromGenerateInput(context.input)),
} satisfies TaskSpec<unknown, ParsedNoteGenerateOutput>;
