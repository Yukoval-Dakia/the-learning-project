import { z } from 'zod';
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { BBox } from '@/core/schema';
import { QuestionBlockRole, VisualComplexity } from '@/core/schema/business';

const VisionBlockSchema = z.object({
  extracted_prompt_md: z.string().min(1).max(5000),
  reference_md: z.string().nullable(),
  wrong_answer_md: z.string().nullable(),
  page_index: z.number().int().min(0),
  bbox: BBox,
  role: QuestionBlockRole,
  visual_complexity: VisualComplexity,
  extraction_confidence: z.number().min(0).max(1),
  knowledge_hint: z.string().nullable(),
});

export const VisionOutputSchema = z.object({
  blocks: z.array(VisionBlockSchema).min(1).max(20),
});

export type VisionOutput = z.infer<typeof VisionOutputSchema>;
export type VisionBlock = z.infer<typeof VisionBlockSchema>;

export function parseVisionOutput(text: string): VisionOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseVisionOutput: no JSON object found');
  }
  const slice = text.slice(start, end + 1);
  let json: unknown;
  try {
    json = JSON.parse(slice);
  } catch (error) {
    throw new Error(`parseVisionOutput: JSON.parse failed: ${(error as Error).message}`);
  }
  return VisionOutputSchema.parse(json);
}

export const visionExtractTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'VisionExtractTask',
    description: '错题图片 → 切块 + 题面 + 答案 + bbox（manual rescue only after Sub 0c）',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: true,
    allowedTools: [],
    invocation: 'manual_rescue_only',
    prompt: {
      kind: 'inline',
      text: '你是错题录入助手。给定一张题目图片（试卷/手写/教材截图），输出严格 JSON（不带 markdown 代码块包裹）：\n{"blocks":[{"extracted_prompt_md":"...","reference_md":"...|null","wrong_answer_md":"...|null","page_index":0,"bbox":{"x":0.1,"y":0.2,"width":0.6,"height":0.3},"role":"prompt|answer_area|continuation","visual_complexity":"low|medium|high","extraction_confidence":0.0-1.0,"knowledge_hint":"...|null"}]}\n约束：bbox 坐标 0-1 归一化（不是像素）；一图可输出 1+ 个 block（一页多题）；page_index 由调用方覆盖；wrong_answer_md 仅当图上有用户错答 / 批改痕迹时填；knowledge_hint 是软提示。',
    },
  },
  outputSchema: VisionOutputSchema,
  parseText: parseVisionOutput,
} satisfies TaskSpec<unknown, VisionOutput>;

export const visionExtractTaskHeavySpec = {
  ownership: 'owned',
  definition: {
    kind: 'VisionExtractTaskHeavy',
    description: '错题图片 → 切块（heavy / Tier 3 — mimo-v2.5 multimodal manual rescue）',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 90_000 },
    needsToolCall: false,
    isMultimodal: true,
    allowedTools: [],
    invocation: 'manual_rescue_only',
    prompt: {
      kind: 'inline',
      text: '你是错题录入助手（heavy 模式，前两层 OCR / haiku 都失败）。给定一张题目图片（可能含手写 / 复杂版式 / 公式），输出严格 JSON（不带 markdown 代码块包裹）：\n{"blocks":[{"extracted_prompt_md":"...","reference_md":"...|null","wrong_answer_md":"...|null","page_index":0,"bbox":{"x":0.1,"y":0.2,"width":0.6,"height":0.3},"role":"prompt|answer_area|continuation","visual_complexity":"low|medium|high","extraction_confidence":0.0-1.0,"knowledge_hint":"...|null"}]}\n约束：bbox 坐标 0-1 归一化（不是像素）；page_index 由调用方覆盖；wrong_answer_md 仅当图上有用户错答 / 批改痕迹时填。',
    },
  },
  outputSchema: VisionOutputSchema,
  parseText: parseVisionOutput,
} satisfies TaskSpec<unknown, VisionOutput>;
