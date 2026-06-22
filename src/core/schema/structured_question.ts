import { z } from 'zod';
import { QuestionKind } from './business';

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
  // YUK-253: GLM-OCR replaces Tencent as the default OCR engine. Stamped on
  // GLM-fallback questions (VLM-down path); the VLM path keeps 'vlm_structure'.
  // Zod enum only — NOT a DB column (no audit:schema impact).
  'glm_ocr',
  'vision_rescue',
  // T-OC slice 2 (YUK-145, OC-1/OC-2): VLM StructureTask owns the normalized
  // structure tree; Tencent structure is demoted to a text hint. See
  // docs/superpowers/plans/2026-05-30-yuk145-toc-slice2-lane.md.
  'vlm_structure',
  'manual',
  'agent_edit',
  // YUK-258: DOCX text-line ingestion. Stamped on blocks segmented from pandoc
  // gfm markdown (语文/纯文本卷, zero MathType). Zod enum only — NOT a DB column
  // (no audit:schema impact). Added at the enum TAIL to minimise the merge面 with
  // #333 (yuk-253-glm-ocr-swap) which inserts 'glm_ocr' mid-enum.
  'docx_text',
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
  /**
   * 0-based source page this question was extracted from. Set on the Tencent
   * multi-page fallback path (parser stamps it per page); ABSENT on the VLM
   * structure tree and single-page legacy trees. Used by `assignFigures` to gate
   * figure↔question attachment to the same page so a page-1 figure can't match a
   * page-0 question on normalized (0–1) bbox overlap (YUK-163).
   */
  page_index?: number;
  sub_questions?: StructuredQuestionT[];
  extraction_evidence?: z.infer<typeof ExtractionEvidence>;
  source?: z.infer<typeof StructuredQuestionSource>;
  last_modified_by?: string;
  /**
   * Advisory question-type hint (YUK-195, design note §4.3). Written by the
   * `set_question_type` agent-edit DomainTool onto a draft-block structured
   * node. This is a jsonb-internal field — NOT a DDL column, NOT an
   * `audit:schema` business field. Import behavior is UNCHANGED by this hint:
   * `question.kind` is still supplied per-block by the import request. The
   * hint's only consumer is the future OC-5 review UI (YUK-169 redraw), which
   * will pre-fill the import kind selector from it.
   */
  kind?: z.infer<typeof QuestionKind>;
  /**
   * YUK-482 cut ④ — advisory "this node carries student work" flag emitted by the
   * VLM StructureTask (per-node / per-page). The VLM NEVER transcribes handwriting
   * (pixels stay pixels — constraint #3 / OC-1); it only reports PRESENCE so the
   * student-answer grading path (auto-enroll.ts `detectStudentWork`) knows the page
   * image holds a learner's answer to grade. jsonb-internal — NOT a DDL column, NOT
   * an `audit:schema` business field (rides inside the existing `structured` jsonb,
   * same precedent as the `kind` hint above). Absent ⇒ no VLM signal (detection
   * degrades to the Tencent `extraction_evidence.handwriting` signal alone).
   */
  student_answer_present?: boolean;
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
      page_index: z.number().int().min(0).optional(),
      sub_questions: z.array(StructuredQuestion).optional(),
      extraction_evidence: ExtractionEvidence.optional(),
      source: StructuredQuestionSource.optional(),
      last_modified_by: z.string().optional(),
      // YUK-195 §4.3 — advisory question-type hint (jsonb-internal, no DDL).
      kind: QuestionKind.optional(),
      // YUK-482 cut ④ — advisory student-work presence flag (jsonb-internal, no DDL).
      student_answer_present: z.boolean().optional(),
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

/**
 * Find the FIRST node (depth-first pre-order) whose `id` matches `target` in a
 * StructuredQuestion tree. Read-only, no clone — returns the live node reference
 * (or undefined when absent).
 *
 * First-match is safe because ids are UNIQUE per tree (ADR-0032 read≡write
 * coords — the addressable projection exposes each node's id as its sole write
 * coordinate; duplicate ids would make a write ambiguous, so the write path
 * never produces them). Lives in core (not in a capability) so the practice
 * question-edit applier (proposal-appliers.ts) can import it without owning it.
 * NOTE: the judge narrowing helper (server/judge/narrow-part.ts) needs the
 * matched node's PARENT (for passage-preserving wrap), so it uses its own
 * parent-tracking variant rather than this id-only walker.
 */
export function findStructuredNode(
  node: StructuredQuestionT,
  target: string,
): StructuredQuestionT | undefined {
  if (node.id === target) return node;
  for (const sub of node.sub_questions ?? []) {
    const hit = findStructuredNode(sub, target);
    if (hit) return hit;
  }
  return undefined;
}

// ---------- 可寻址结构投影：read≡write 坐标修复（ADR-0032 D6-R6 / D6-draftread） ----------
//
// 让 AI 能像写一样按【节点】寻址地读题结构：投影只保留写路径会用到的寻址坐标
// （id / role / sub_questions + figures[asset_id, role, attached_to_index]），
// 丢弃 bbox / page_index / extraction_evidence —— 这些是【抽取期】像素坐标，对
// 按节点寻址（split_stem / reassign_figure / update_prompt 用的 id 坐标系）无用，
// 只会让 read 面与 write 面坐标错配（prose-vs-node mismatch）。
//
// 纯函数、不持久化、不碰任何写路径 —— get_question_context(include:['structure'])
// 与 get_question_block_structure draft reader 共用此一处投影。

export interface AddressableFigureRef {
  asset_id: string;
  role: string;
  attached_to_index: string;
}

export interface AddressableStructuredQuestion {
  id: string;
  role: 'stem' | 'sub' | 'standalone';
  question_no?: string;
  prompt_text: string;
  options?: { label: string; text: string }[];
  answers?: string[];
  analysis?: string;
  kind?: z.infer<typeof QuestionKind>;
  sub_questions?: AddressableStructuredQuestion[];
}

export interface AddressableStructure {
  tree: AddressableStructuredQuestion;
  figures: AddressableFigureRef[];
}

/**
 * 递归裁剪 StructuredQuestion → 可寻址投影。保留按节点寻址需要的 id/role/
 * sub_questions（外加供 AI 判读的 prompt_text/options/answers/analysis/kind），
 * 显式丢弃 bbox/page_index/extraction_evidence/source/last_modified_by 等抽取期
 * 元数据。
 */
export function projectAddressableNode(q: StructuredQuestionT): AddressableStructuredQuestion {
  const node: AddressableStructuredQuestion = {
    id: q.id,
    role: q.role,
    prompt_text: q.prompt_text,
  };
  if (q.question_no != null) node.question_no = q.question_no;
  if (q.options != null) node.options = q.options.map((o) => ({ label: o.label, text: o.text }));
  if (q.answers != null) node.answers = [...q.answers];
  if (q.analysis != null) node.analysis = q.analysis;
  if (q.kind != null) node.kind = q.kind;
  if (q.sub_questions != null) node.sub_questions = q.sub_questions.map(projectAddressableNode);
  return node;
}

/**
 * 把一棵 StructuredQuestion 树 + 其 FigureRef[] 投影成可寻址结构。figures 只保留
 * 寻址三元组（asset_id / role / attached_to_index）—— source_bbox /
 * source_page_index / attach_confidence 是抽取期坐标，对寻址无用。
 */
export function projectAddressableStructure(
  tree: StructuredQuestionT,
  figures: readonly FigureRefT[] = [],
): AddressableStructure {
  return {
    tree: projectAddressableNode(tree),
    figures: figures.map((f) => ({
      asset_id: f.asset_id,
      role: f.role,
      attached_to_index: f.attached_to_index,
    })),
  };
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
