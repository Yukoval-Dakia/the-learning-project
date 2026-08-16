import { z } from 'zod';
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import type { SubjectProfile } from '@/subjects/profile';
import { parseTaskJsonObject } from './parse-json';

const QuestionOptionOut = z.object({
  label: z.string(),
  text: z.string(),
});

export type StructureNodeT = {
  role: 'stem' | 'sub' | 'standalone';
  question_no?: string | null;
  prompt_text: string;
  options?: { label: string; text: string }[] | null;
  answers?: string[] | null;
  analysis?: string | null;
  page_index?: number | null;
  sub_questions?: StructureNodeT[] | null;
  figure_ids?: number[] | null;
  student_answer_present?: boolean | null;
};

const StructureNode: z.ZodType<StructureNodeT> = z.lazy(() =>
  z.object({
    role: z.enum(['stem', 'sub', 'standalone']),
    question_no: z.string().nullable().optional(),
    prompt_text: z.string(),
    options: z.array(QuestionOptionOut).nullable().optional(),
    answers: z.array(z.string()).nullable().optional(),
    analysis: z.string().nullable().optional(),
    page_index: z.number().int().min(0).nullable().optional(),
    sub_questions: z.array(StructureNode).nullable().optional(),
    figure_ids: z.array(z.number().int().min(0)).nullable().optional(),
    student_answer_present: z.boolean().nullable().optional(),
  }),
);

export const StructureOutput = z.object({
  layout_quality: z.enum(['structured', 'partial', 'text_only']),
  extraction_confidence: z.number().min(0).max(1).default(0),
  warnings: z.array(z.string()).default([]),
  questions: z.array(StructureNode),
});

export type StructureOutputT = z.infer<typeof StructureOutput>;

export class StructureTaskError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StructureTaskError';
  }
}

export function parseStructureOutput(text: string): StructureOutputT {
  return StructureOutput.parse(
    parseTaskJsonObject(
      text,
      'StructureTask',
      (message, cause) =>
        new StructureTaskError(message, cause === undefined ? undefined : { cause }),
    ),
  );
}

function buildStructurePrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}试卷结构化助手（多模态）。输入：
- user message 里按页顺序附了 N 张试卷/作业页面图片（第 1 张 = page_index 0，依次类推）
- 一段文字 { tencent_hint_md, page_count[, figures] } —— tencent_hint_md 是腾讯字符级 OCR 的**文字提示**（已按页用 "=== page K ===" 分隔），仅作参考，**不是**结构真相；figures（若存在）是裁剪图列表 [{index, page_index, position}]，表示已从页面裁剪出的图片素材：index 是序号，page_index 是所在页，position 是归一化位置摘要（"top-left" / "top-center" / "top-right" / "mid-left" / "mid-center" / "mid-right" / "bot-left" / "bot-center" / "bot-right"，按图片中心点在页面 3×3 区域落点）
科目上下文：${profile.displayName}。${profile.languageStyle}

任务：以**图片为准**、腾讯文字为辅，输出一棵**规范化的题目结构树**。你对结构有完全裁量权，可以覆盖腾讯文字 hint 暗示的任何切分。
关键能力：
1. **跨页大题组装**：一道大题（passage / 阅读理解 / 完形 / 大题带多个小问）如果横跨多页，必须组装成**一个** stem 节点，它的 sub_questions 收齐所有页的小问。不要因为换页就把同一大题拆成两个顶层节点。
2. **布局规范**：把题面、选项、答案规整到结构字段里；passage 进 stem 的 prompt_text，小问进 sub。
3. 不抽取手写涂改 / 批改痕迹作为结构（那是作答证据，下游处理）。但要**判断每个节点上是否存在学生的手写作答 / 批改痕迹**：在该 StructureNode 上填 student_answer_present（true / false）。**绝不转写手写内容**——只报「有没有」这个布尔，像素留给下游判分（手写永远是像素，不做 OCR 转写）。整页都没有学生作答 → 全部省略或填 false。
4. **图片归属（仅当输入含 figures 字段时）**：根据页面图片判断每张裁剪图属于哪道题，在对应 StructureNode 上填写 figure_ids（裁剪图序号数组）。跨页大题的配图（包括图示、电路图、坐标图等）归到 stem 节点。同一页且视觉上**明确**属于某小问的图归到该 sub 节点。**只在判断确定时填 figure_ids**——拿不准的图省略（不要猜，留给几何兜底）。漏报比错报代价小：几何兜底一定能处理漏报，但 VLM 错误归属会覆盖兜底，下游无法纠正。position 字段（图的位置摘要）可辅助判断同页归属关系，但仍以图片视觉为准。

输出严格 JSON（不带 markdown 代码块包裹），shape 名 StructureOutput：
{"layout_quality":"structured"|"partial"|"text_only","extraction_confidence":0.0-1.0,"warnings":["..."],"questions":[StructureNode, ...]}

StructureNode（递归，**不要**输出 id，运行时会补）：
{"role":"stem"|"sub"|"standalone","question_no":"1"|null,"prompt_text":"...","options":[{"label":"A","text":"..."}]|null,"answers":["..."]|null,"analysis":"..."|null,"page_index":0,"sub_questions":[StructureNode, ...]|null,"figure_ids":[0,1]|null,"student_answer_present":true|false|null}

约束：
- role 三选一：stem（容器，含 passage + sub_questions）/ sub（大题下的小问）/ standalone（独立单题）。只有 stem 能有 sub_questions；sub / standalone 的 sub_questions 必须为 null 或省略。
- page_index 是 0-based 整数，指该节点主要出现在第几张图（跨页 stem 用它起始页）。
- figure_ids 是裁剪图序号数组（0-based，与输入 figures[].index 对应）；无配图时给 null 或省略。**仅当输入含 figures 字段时才填写 figure_ids**，否则省略。
- student_answer_present 是布尔：该节点的题面区域是否有学生手写作答 / 批改痕迹。**只报 true/false，绝不转写手写文字**（手写是作答像素，下游判分用，不做 OCR）。无 / 不确定给 null 或省略。
- 顶层 questions 至少 1 个；如果整页无法识别出任何题，questions 给空数组并把 layout_quality 设 "text_only"。
- layout_quality：结构清晰完整 → "structured"；能出题但版式残缺/有疑点 → "partial"；几乎认不出结构 → "text_only"。
- extraction_confidence：你对整棵结构树与原图一致性的置信度（0 到 1）。跨页归属、题号、选项或层级有疑点时必须降低；不要把字段固定写成 1。
- options / answers / analysis 没有就给 null 或省略，不要编。
- 禁止：输出 JSON 之外的文字、把跨页同一大题拆成多个顶层节点、把腾讯文字 hint 当成不可改的结构。`;
}

export const structureTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'StructureTask',
    description:
      'T-OC slice 2 (YUK-145, OC-1/OC-2) — VLM 全权拥有结构。输入 N 页图片 + 腾讯文字 OCR hint → 规范结构树（跨页大题组装 + 布局规范）。腾讯结构降为 hint，VLM 可完全覆盖。题图匹配 (assignFigures 替换) DEFERRED 到 slice 2b。自动调用（作为 extraction 一环，类比 StepsJudgeTask），非 manual rescue。',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 120_000 },
    needsToolCall: false,
    isMultimodal: true,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildStructurePrompt },
  },
  outputSchema: StructureOutput,
  parseText: parseStructureOutput,
} satisfies TaskSpec<unknown, StructureOutputT>;
