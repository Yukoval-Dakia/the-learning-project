import { z } from 'zod';
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { QuestionKind } from '@/core/schema/business';
import type { SubjectProfile } from '@/subjects/profile';
import { parseTaskJsonObject } from './parse-json';

const QuestionOptionOut = z.object({
  label: z.string(),
  text: z.string(),
  figure_ids: z.array(z.number().int().min(0)).nullable().optional(),
});

export type StructureNodeT = {
  kind?: string | null;
  role: 'stem' | 'sub' | 'standalone';
  question_no?: string | null;
  prompt_text: string;
  options?: { label: string; text: string; figure_ids?: number[] | null }[] | null;
  answers?: string[] | null;
  analysis?: string | null;
  page_index?: number | null;
  sub_questions?: StructureNodeT[] | null;
  figure_ids?: number[] | null;
  student_answer_present?: boolean | null;
};

const StructureNode: z.ZodType<StructureNodeT> = z.lazy(() =>
  z.object({
    kind: QuestionKind.nullable().optional(),
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
  content_lost: z.boolean().nullable().optional(),
  figure_handwriting: z
    .array(
      z.object({
        figure_index: z.number().int().min(0),
        student_answer_present: z.boolean().nullable().optional(),
      }),
    )
    .optional(),
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
- 一段文字 { tencent_hint_md, page_count[, figures] } —— tencent_hint_md 是腾讯字符级 OCR 的**文字提示**（已按页用 "=== page K ===" 分隔），仅作参考，**不是**结构真相；figures（若存在）是裁剪图列表 [{index, page_index, position, bbox}]：index 是整批裁剪图序号（不是题号），page_index 是所在页，bbox 是归一化裁剪范围 {x,y,width,height}，position 是页面 3×3 区域位置摘要。同页多张图须按 bbox 区分，不能只靠 position。题号 question_no 与 figure index 是不同身份。
科目上下文：${profile.displayName}。学科风格不适用于源材料转写：题面、选项、阅读材料必须保留图片中的原文和原语言。

任务：以**图片为准**、腾讯文字为辅，忠实转写为题目结构树。只调整字段与跨页分组，绝不翻译、改写、概括或解题。英语逐字保留英语，中文逐字保留中文，混合语言原样保留；不要把英语题面译成中文。
关键能力：
1. **跨页大题组装**：一道大题（passage / 阅读理解 / 完形 / 大题带多个小问）如果横跨多页，必须组装成**一个** stem 节点，它的 sub_questions 收齐所有页的小问。不要因为换页就把同一大题拆成两个顶层节点。跨页合并时题目正文、选项、阅读原文必须两页齐全；「（接上页）」「（续）」等版面续页标记可以去掉，但不能因此删掉任何题目文字。
2. **布局规范**：把题面、选项、答案规整到结构字段里；passage 进 stem 的 prompt_text，小问进 sub。
3. **手写和批改痕迹不是题面。** 学生的手写作答、涂改、红笔勾叉、批改分数都不进 prompt_text、options、answers、analysis；压在印刷字上或紧挨着印刷字的笔迹一律忽略，题面不能因为手写多出或少掉任何字符（例如印刷「2+3=」后面手写了「5」，题面仍是「2+3=」，不能写成「2+3=5」或「2+3×5=」）。腾讯文字提示可能把手写字混进印刷行，以图片为准剔除。手写只用来填 student_answer_present：该节点作答区域有任何学生笔迹或批改痕迹填 true，明确没有填 false，看不清就省略。只判断有没有，不辨认笔迹内容、不区分勾和叉、不判断对错，**绝不转写手写内容**（手写永远是像素，下游处理）。
4. **图片归属（仅当输入含 figures 字段时）**：按 page_index 和 bbox 对照页面图片，把确定属于题面的裁剪图 index 填在对应节点 figure_ids；图形选项的图填入对应 options[].figure_ids，不再重复填到节点。同一 index 只声明一次，归属不明就省略，不猜最近题。跨页共享图归 stem，某小问独有图归 sub。选项 label 只存印刷标签，text 只存该选项印刷原文；选项本身是图且无正文时 text 必须为 ""，图由 figure_ids 表达。禁止编写「图A所示的」「见配图」「[图像选项]」或图像细节描述；没有图时也不要用文字冒充图。
   对输入每个裁剪 index，在顶层 figure_handwriting 中独立报告 {figure_index,student_answer_present}：只检查该 bbox 内实际像素，有学生手写/批改痕迹填 true，明确没有填 false，不确定就省略 student_answer_present；同页别题手写不代表这张裁剪含手写。即使图含手写也可以报告它所属题/选项，是否挂载由运行时决定，绝不转写手写文字。
5. **数学公式定界**：prompt_text、options[].text 以及 sub_questions 题面里出现的数学公式，必须带明确的 LaTeX 定界符：行内公式用「$...$」，独立成行的展示公式用「$$...$$」。已带定界符的公式（$...$、$$...$$、\\(...\\)、\\[...\\]）原样保留，不要改写公式内容。代码片段（含 Python、缩进、反斜杠转义）与普通文字**不要**包进 $；拿不准是不是公式的文字保持原样，宁可不包也不要猜。answers / analysis 字段不适用本条。
6. **分节标题不是题。** 「一、选择题（每题4分）」这类大题/栏目标题、试卷标题、姓名栏、卷首说明、分值说明、注意事项都不是题目：不单独成节点，不写进任何节点的 prompt_text；略去它们**不算**内容丢失。
7. **思考只用来定结构。** 在思考里确定题与题的边界、层级（stem / sub）、跨页归属、配图归属和题型即可；不要在思考里先把题面、选项、公式草拟一遍，也不要预演 JSON 转义。题面原文只在最终 JSON 里逐字写一次。

输出严格 JSON（不带 markdown 代码块包裹），shape 名 StructureOutput：
{"layout_quality":"structured"|"partial"|"text_only","extraction_confidence":0.0-1.0,"warnings":["..."],"content_lost":true|false,"figure_handwriting":[{"figure_index":0,"student_answer_present":true|false}],"questions":[StructureNode, ...]}

StructureNode（递归，**不要**输出 id，运行时会补）：
{"kind":"choice","role":"stem"|"sub"|"standalone","question_no":"1","prompt_text":"...","options":[{"label":"A","text":"...","figure_ids":[0]}],"answers":["..."],"analysis":"...","page_index":0,"sub_questions":[StructureNode, ...],"figure_ids":[0,1],"student_answer_present":true|false}

约束：
- **可选字段没有值就省略这个键**，不写 null，也不用空数组、空字符串占位（图形选项的 text "" 除外）。
- kind 只填下列英文值之一，按题目自身的作答要求对应：选择题（单选/多选）→ choice；判断题 → true_false；填空题 → fill_blank；题干要求计算、化简、求值 → computation；证明题、推导题 → derivation；其它解答题、简答题、问答题 → short_answer；作文、书面表达 → essay；阅读理解、完形填空等带材料的大题（stem）→ reading；翻译题 → translation。表里没有的题型取最接近的一个，不必反复权衡。选择题的选项必须进入 options，不能只拼进 prompt_text。题型标签不是评分准入，不据此生成参考答案。
- question_no 只写该节点自己的印刷号码本身，去掉标点和括号：「6.」「第6题」写 "6"；小问「(1)」「⑴」「①」写 "1"，不拼大题号（不写 "9(1)"）。卷面没印号码就省略。
- role 三选一：stem（容器，含 passage + sub_questions）/ sub（大题下的小问）/ standalone（独立单题）。只有 stem 能有 sub_questions；sub / standalone 不输出 sub_questions。
- page_index 是 0-based 整数，指该节点主要出现在第几张图（跨页 stem 用它起始页）。
- figure_ids 是裁剪图序号数组（0-based，与输入 figures[].index 对应）；无配图就省略。**仅当输入含 figures 字段时才填写 figure_ids**，否则省略。
- student_answer_present 是布尔：该节点作答区域有学生笔迹或批改痕迹填 true，明确没有填 false，看不清就省略（见第 3 条）。
- 顶层 questions 至少 1 个；如果整页无法识别出任何题，questions 给空数组并把 layout_quality 设 "text_only"。
- layout_quality：结构清晰完整 → "structured"；能出题但版式残缺/有疑点 → "partial"；几乎认不出结构 → "text_only"。
- extraction_confidence：你对整棵结构树与原图一致性的置信度（0 到 1）。跨页归属、题号、选项或层级有疑点时必须降低；不要把字段固定写成 1。
- content_lost：原图可见的题、选项或内容有丢弃/无法转写时必须为 true 并写明 warning；跨页合并只去掉「（接上页）」「（续）」等版面续页标记不算内容丢失，题面正文、选项、原文缺一才算。略去第 6 条所列标题和说明不算丢失。全部保留填 false，无法判断就省略。不能只在 warning 报丢失。
- answers / analysis 只转写印刷的参考答案/解析；不求解，不把手写当答案键。没有就省略。
- 禁止：输出 JSON 之外的文字、把跨页同一大题拆成多个顶层节点、把腾讯文字 hint 当成不可改的结构。`;
}

export const structureTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'StructureTask',
    description:
      'T-OC slice 2 (YUK-145, OC-1/OC-2) — VLM 全权拥有结构。输入 N 页图片 + 腾讯文字 OCR hint → 规范结构树（跨页大题组装 + 布局规范）。腾讯结构降为 hint，VLM 可完全覆盖。题图匹配 (assignFigures 替换) DEFERRED 到 slice 2b。自动调用（作为 extraction 一环，类比 StepsJudgeTask），非 manual rescue。',
    // Hang/loop guard only (owner 2026-11-07). Longest measured run: TEST 131.6s
    // (tlp-audit-artifacts/yuk1994/structure-usage/52aa5a834/raw.jsonl), ~10k
    // thinking tokens at ~100 tok/s; 300s leaves room for admission concurrency.
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 300_000 },
    needsToolCall: false,
    isMultimodal: true,
    allowedTools: [],
    context: { view: 'none', reason: '录入 agent 只处理当次源材料，不读学习者历史上下文' },

    prompt: { kind: 'profile', build: buildStructurePrompt },
  },
  outputSchema: StructureOutput,
  parseText: parseStructureOutput,
} satisfies TaskSpec<unknown, StructureOutputT>;
