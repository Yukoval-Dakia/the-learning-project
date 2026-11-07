// YUK-1548 slice 1 — DrawingTask: one complete free-form SVG drawing per
// request, produced by the dedicated Sol lane (openai/gpt-6.1-sol via the
// ChatGPT-login auth file). The lane is configured by four keys and asserted
// again before every send (server/route-assert.ts):
//   task.DrawingTask.provider='openai'  task.DrawingTask.model='gpt-6.1-sol'
//   task.DrawingTask.reasoning={level:'high'}  task.DrawingTask.override_global_pin=true
// With override_global_pin the env/DB global pins cannot repoint this task;
// an incomplete pair is a TaskConfigError, never a silent paid fallback.

import { z } from 'zod';
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { rebuildSvgFigure } from '@/kernel/blocks/svg-rebuild';

export const DRAWING_TASK_KIND = 'DrawingTask';
export const SOL_REASONING_LEVEL = 'high';

// Loop guard only — above the longest real single-round draw, never a speed knob.
export const DRAWING_TIMEOUT_MS = 20 * 60 * 1000;

export const DrawingTaskInput = z
  .object({
    brief: z.string().min(1).max(2_000),
    alt: z.string().min(1).max(300),
    caption: z.string().max(200).optional(),
  })
  .strict();
export type DrawingTaskInputT = z.infer<typeof DrawingTaskInput>;

export const DrawingTaskOutputSchema = z
  .object({
    /** Sanitised standalone SVG document (server-allowlisted shape). */
    svg: z.string().min(1),
  })
  .strict();
export type ParsedDrawingOutput = z.infer<typeof DrawingTaskOutputSchema>;

const SVG_BLOCK = /<svg[\s\S]*<\/svg>/;

export function parseDrawingOutput(text: string): ParsedDrawingOutput {
  const match = SVG_BLOCK.exec(text);
  if (!match) {
    throw new Error('parseDrawingOutput: model output contains no complete <svg> document');
  }
  const rebuilt = rebuildSvgFigure(match[0]);
  if (!rebuilt.ok) {
    throw new Error(
      `parseDrawingOutput: svg rejected: ${rebuilt.issues.map((issue) => issue.detail).join('; ')}`,
    );
  }
  return { svg: rebuilt.svg };
}

const PROMPT = `你是一个学习绘图器。输入 { brief, alt, caption? }：brief 是要画的内容（可能是装置图、受力图、几何构图、电路等），alt 是一句话无障碍描述，caption 是可选小注。

只输出一份完整独立的 SVG 文档：第一行就是 <svg，最后一行就是 </svg>。不要开场白、注释或 markdown 围栏。

要求：
- 单文件自包含：声明 viewBox；不得引用外部资源（无 <image href>、@import、外部字体、script、iframe）；不得包含 <script>、事件属性（on*）、<a> 链接或 foreignObject。
- 一次画完整张图，不是分步草图。
- 风格统一克制：描边粗细分层（轮廓/细节/标注线），有限调色板（建议 ≤6 色），标注文字为中文（除非学科惯例用英文/符号），字号分层且不小于 10px。
- 标注准确：部件名称、箭头与连线必须指向正确对象，公式用纯文本写法（如 v = λf）。
- 尺寸建议 640×400 左右的 viewBox，留白均匀。`;

export const drawingTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: DRAWING_TASK_KIND,
    description: 'Single-round Sol free-form SVG drawing for generative-UI blocks (slice 1).',
    // Dedicated Sol drawing lane — the model id lives only here (the legal
    // tasks/** defaultModel site); route asserts read this pair back, never a literal.
    defaultProvider: 'openai',
    defaultModel: 'gpt-6.1-sol',
    budget: {
      ...DEFAULT_TASK_BUDGET,
      maxIterations: 1,
      timeout: DRAWING_TIMEOUT_MS,
      transientRetries: 0,
    },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    context: {
      view: 'none',
      reason:
        'Draws one brief only; learner context is provenance-checked and stored by the drawing record, not read by the model.',
    },
    prompt: { kind: 'inline', text: PROMPT },
    ignoreGlobalPin: true,
  },
  outputSchema: DrawingTaskOutputSchema,
  parseText: (text: string) => parseDrawingOutput(text),
} satisfies TaskSpec<DrawingTaskInputT, ParsedDrawingOutput>;
