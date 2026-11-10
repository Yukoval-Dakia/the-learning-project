import { z } from 'zod';
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import type { SubjectProfile } from '@/subjects/profile';
import { parseTaskJsonObject } from './parse-json';

// Per-question handwriting trace for a photographed answer sheet. The VLM reads
// only the learner's own writing inside each supplied question area and reports
// it as evidence: transcribed steps, an optional red-pen check/cross mark, and an
// optional page-local bbox. It never supplies an answer key and never decides
// right/wrong — the red mark is the learner's own annotation, kept as evidence.

export class HandwritingTraceTaskError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HandwritingTraceTaskError';
  }
}

export const HandwritingTraceLeaf = z.object({
  index: z.number().int().min(0),
  page_index: z.number().int().min(0),
  question_no: z.string().nullable(),
  prompt_text: z.string(),
});

export type HandwritingTraceLeafT = z.infer<typeof HandwritingTraceLeaf>;

export const HandwritingTraceInput = z.object({
  page_count: z.number().int().min(1),
  leaves: z.array(HandwritingTraceLeaf),
});

export type HandwritingTraceInputT = z.infer<typeof HandwritingTraceInput>;

const TraceBBox = z.object({
  page_index: z.number().int().min(0),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});

/**
 * Why a leaf stayed out of `traces`. Only `no_handwriting` means the answer area is
 * empty; the other two mean learner work exists but cannot be used as text.
 */
export const HandwritingUnresolvedCause = z.enum([
  'illegible',
  'ambiguous_attribution',
  'no_handwriting',
]);
export type HandwritingUnresolvedCauseT = z.infer<typeof HandwritingUnresolvedCause>;

export const HandwritingTraceOutput = z.object({
  traces: z
    .array(
      z.object({
        leaf_index: z.number().int().min(0),
        /** Learner's writing in this question's answer area; empty when only a mark was read. */
        text: z.string().default(''),
        /** Red-pen check/cross drawn by the learner; 'none' = no red mark seen. */
        red_mark: z.enum(['none', 'check', 'cross', 'mixed', 'unknown']).default('unknown'),
        /** True when the transcribed text itself is red (for example a red-ink correction). */
        red_text: z.boolean().default(false),
        bbox: TraceBBox.nullable().optional(),
        confidence: z.number().min(0).max(1).default(0),
        /** Model's own remark about this area; evidence only, never part of the learner's answer. */
        note: z.string().optional(),
      }),
    )
    .default([]),
  /** A mark or writing that cannot be assigned to exactly one question stays here. */
  unresolved: z
    .array(
      z.object({
        leaf_index: z.number().int().min(0).nullable().optional(),
        /**
         * Structured cause. Absent or unrecognised (older outputs) is treated as
         * "something is there but unreadable", the conservative reading.
         */
        cause: HandwritingUnresolvedCause.optional().catch(undefined),
        reason: z.string(),
      }),
    )
    .default([]),
});

export type HandwritingTraceOutputT = z.infer<typeof HandwritingTraceOutput>;

export function parseHandwritingTraceOutput(text: string): HandwritingTraceOutputT {
  return HandwritingTraceOutput.parse(
    parseTaskJsonObject(
      text,
      'HandwritingTraceTask',
      (message, cause) =>
        new HandwritingTraceTaskError(message, cause === undefined ? undefined : { cause }),
    ),
  );
}

function buildHandwritingTracePrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}作业页的手写作答切分助手（多模态）。输入：
- user message 里按页顺序附了 N 张作业/试卷页面图片（第 1 张 = page_index 0）
- 一段文字 { page_count, leaves: [{ index, page_index, question_no, prompt_text }] } —— leaves 是运行时已经切好的题目位置（叶子题），index 是题目序号，page_index 是题目所在页，question_no 是印刷题号（可能为 null），prompt_text 是该题印刷题面（只用于定位，绝不能抄进输出）。

任务：对每个 leaf，只看它在页面上的作答区域，转写**学习者本人**的手写内容，并报告该区域的红笔勾/叉。这是作答证据，不是判分。
1. **只转写指定题目的作答区域。** 不要把题目印刷文字、别题的手写或整页内容抄进来。跨题的笔迹、页边批注、不属于任何 leaves 区域的手写放进 unresolved，cause='ambiguous_attribution'，reason 写清楚；**绝不**把它硬塞给最近的题。
2. **原样转写手写步骤/答案，不求解、不改写、不纠正。** 数学公式按手写原样转写（可用 LaTeX）；看不清的字符用「□」占位；整块无法辨认时不出 trace，把该 leaf 放进 unresolved，cause='illegible'。
   选择题里圈选/勾选的选项、写下的选项字母也是作答，要输出 trace（text 写选中的字母）。
   **text 只放学习者写下的原文**，不加任何评论、标注、说明或括号注释（例如「（红笔）」「图中……」）。笔色由 red_mark / red_text 表示；你想补充的观察（例如写在配图上的手写、哪一行是红笔）写进 note，不写进 text。
3. **红笔勾叉是学习者自己标的对错记号，只作为证据报告。** red_mark 只能填 none / check / cross / mixed / unknown：看到红色对勾填 check，看到红色叉填 cross，同题两种都有填 mixed，明确没有红笔记号填 none，看不清或不确定填 unknown。**绝不**据此输出 correct / incorrect / score 之类的判分结论。
4. red_text 只在转写文本本身是红笔（例如红笔订正/红笔写的步骤）时为 true；黑/蓝笔作答为 false。红笔勾叉本身不算 red_text。
5. bbox 是该 leaf 手写区域在它所在页的 0-1 归一化包围盒 {page_index,x,y,width,height}；多段手写取覆盖它们的整体范围；定位不准就省略 bbox，不猜。
6. confidence 是该 leaf 转写与切分的把握（0-1）；吃不准就如实给低分。
7. 作答区域没有任何手写的 leaf：**既不输出 trace，也不放进 unresolved**；不要为凑数输出空 trace。unresolved 只放「有手写但用不了」的情况，cause 只能是 illegible（看得见但读不出）或 ambiguous_attribution（归属不清）；万一要列出确认没有手写的 leaf，cause 必须写 no_handwriting。
8. 输出严格 JSON（不带 markdown 代码块包裹），shape 名 HandwritingTraceOutput：
{"traces":[{"leaf_index":0,"text":"...","red_mark":"none|check|cross|mixed|unknown","red_text":false,"bbox":{"page_index":0,"x":0.1,"y":0.2,"width":0.3,"height":0.1},"confidence":0.0,"note":"可省略"}],"unresolved":[{"leaf_index":1,"cause":"illegible|ambiguous_attribution","reason":"..."}]}

约束：
- 手写内容只出现在 traces[].text 里；不要把它写进题面、答案、解析或任何其他字段。traces[].text 里也不能有你自己的话。
- 不要输出 JSON 之外的文字。
- 不要判分，不要给对错结论，不要生成标准答案。`;
}

export const handwritingTraceTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'HandwritingTraceTask',
    description:
      'YUK-1994 片 4 — 按题切分拍照作业页上的学习者手写：逐 leaf 转写手写步骤/答案（原样、不判分）、报告学习者红笔勾叉（证据，不代替判分）、给出页内 0-1 bbox 与置信度。无法归属的手写进入 unresolved，绝不串题。输出只作作答证据，不进答案键和判分输入。',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1 },
    needsToolCall: false,
    isMultimodal: true,
    allowedTools: [],
    context: { view: 'none', reason: '录入只处理当次源材料，不读学习者历史上下文' },

    prompt: { kind: 'profile', build: buildHandwritingTracePrompt },
  },
  outputSchema: HandwritingTraceOutput,
  parseText: parseHandwritingTraceOutput,
} satisfies TaskSpec<unknown, HandwritingTraceOutputT>;
