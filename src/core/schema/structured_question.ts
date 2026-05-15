import { z } from 'zod';

// ---------- BBox：0-1 归一化的轴对齐 bounding box ----------

export const BBox = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0).max(1),
    height: z.number().min(0).max(1),
  })
  .refine((b) => b.x + b.width <= 1, { message: 'x + width must be <= 1' })
  .refine((b) => b.y + b.height <= 1, { message: 'y + height must be <= 1' });

export type BBoxT = z.infer<typeof BBox>;

// ---------- FigureRef：题目附带的图 ----------

export const FigureRole = z.enum(['diagram']);

export const AttachConfidence = z.enum(['high', 'low', 'manual']);

export const FigureRef = z.object({
  asset_id: z.string().min(1),
  role: FigureRole,
  source_page_index: z.number().int().min(0),
  source_bbox: BBox,
  // attached_to_index 指向某个 StructuredQuestion.id；root-attached 时可能是 stem id
  attached_to_index: z.string().min(1),
  attach_confidence: AttachConfidence,
  // 用户手动改归属时记录时间戳；ISO 字符串或 Date（z.coerce.date）
  last_reassigned_at: z.coerce.date().optional(),
});

export type FigureRefT = z.infer<typeof FigureRef>;

// ---------- StructuredQuestion 抽取证据 ----------

export const HandwriteInfo = z.object({
  text: z.string(),
  bbox: BBox,
});

export const TencentGrading = z.object({
  IsCorrect: z.boolean(),
  RightAnswer: z.string(),
  AnswerAnalysis: z.string().optional(),
  KnowledgePoints: z.array(z.string()).optional(),
});

export const ExtractionEvidence = z.object({
  handwriting: z.array(HandwriteInfo).optional(),
  tencent_grading: TencentGrading.optional(),
});

// ---------- StructuredQuestion: 递归题目结构 ----------
//
// 三种 role：
//   stem        —— 含 passage + sub_questions[]（如阅读理解 / 完形填空）
//   sub         —— 大题下的子问题（独立题面 / 选项 / 答案）
//   standalone  —— 独立单题，无父无子
//
// 见 CONTEXT.md "大题 / 小题 / 叶题" 词条 + ADR-0002 修订

export const QuestionRole = z.enum(['stem', 'sub', 'standalone']);

export const QuestionOption = z.object({
  label: z.string(),
  text: z.string(),
});

export const StructuredQuestionSource = z.enum([
  'tencent_ocr',
  'vision_rescue',
  'manual',
  'agent_edit',
]);

// 用 z.lazy 实现递归类型。先声明类型，再赋值，再 type infer。
export type StructuredQuestionT = {
  id: string;
  role: 'stem' | 'sub' | 'standalone';
  question_no?: string;
  prompt_text: string;
  options?: { label: string; text: string }[];
  answers?: string[];
  analysis?: string;
  bbox?: BBoxT;
  sub_questions?: StructuredQuestionT[];
  extraction_evidence?: z.infer<typeof ExtractionEvidence>;
  source?: z.infer<typeof StructuredQuestionSource>;
  last_modified_by?: string;
};

export const StructuredQuestion: z.ZodType<StructuredQuestionT> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1),
      role: QuestionRole,
      question_no: z.string().optional(),
      prompt_text: z.string(),
      options: z.array(QuestionOption).optional(),
      answers: z.array(z.string()).optional(),
      analysis: z.string().optional(),
      bbox: BBox.optional(),
      sub_questions: z.array(StructuredQuestion).optional(),
      extraction_evidence: ExtractionEvidence.optional(),
      source: StructuredQuestionSource.optional(),
      last_modified_by: z.string().optional(),
    })
    .refine(
      (q) => {
        // standalone / sub 不该有 sub_questions（只有 stem 是容器）
        if (q.role !== 'stem' && q.sub_questions != null && q.sub_questions.length > 0) {
          return false;
        }
        return true;
      },
      { message: 'only stem may have sub_questions' },
    ),
);

// ---------- 渲染辅助：派生 markdown（不持久化，调用时现场派生） ----------
//
// 见 ADR-0002：extracted_prompt_md 不再持久化，所有 markdown 视图由 structured
// 现场派生，杜绝双源不一致。

export function structuredToPromptMarkdown(q: StructuredQuestionT): string {
  if (q.role === 'stem' && q.sub_questions && q.sub_questions.length > 0) {
    // stem: 先 passage（q.prompt_text），再递归拼 subs
    const subs = q.sub_questions.map(structuredToPromptMarkdown).join('\n\n');
    return `${q.prompt_text}\n\n${subs}`;
  }
  // leaf (sub / standalone)
  const numPrefix = q.question_no ? `${q.question_no}. ` : '';
  let md = `${numPrefix}${q.prompt_text}`;
  if (q.options && q.options.length > 0) {
    const optsMd = q.options.map((o) => `${o.label}. ${o.text}`).join('\n');
    md += `\n${optsMd}`;
  }
  return md;
}

export function structuredToReferenceMarkdown(q: StructuredQuestionT): string {
  if (q.role === 'stem' && q.sub_questions && q.sub_questions.length > 0) {
    return q.sub_questions
      .map(structuredToReferenceMarkdown)
      .filter((s) => s.length > 0)
      .join('\n\n');
  }
  // leaf
  const parts: string[] = [];
  if (q.answers && q.answers.length > 0) parts.push(q.answers.join('；'));
  if (q.analysis) parts.push(q.analysis);
  return parts.join('\n');
}

// ---------- 错误分类：用于 pg-boss 决定 retry / archive ----------
//
// RetryableError —— 暂时性失败（网络超时 / Tencent rate-limit / DB 死锁等），
//   pg-boss 自动重试；
// PermanentError —— 不可重试（认证错误 / 账号欠费 / 参数非法），立即 archive
//   并写 cost_ledger(outcome='failed_permanent')。
//
// 见 Sub 0c plan Step 6 + ADR-0002 修订（Tencent SDK error mapping）

export class RetryableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RetryableError';
  }
}

export class PermanentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentError';
  }
}
