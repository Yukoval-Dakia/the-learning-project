import { z } from 'zod';
import { LearnerHandwritingMarker, type LearnerHandwritingMarkerT } from './assessment/materials';
import { Presentation, type PresentationT } from './assessment/presentation';
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
  option_label: z.string().min(1).optional(),
  handwriting_unverified: z.boolean().optional(),
  // Per-crop handwriting judgment travels with the figure to every model reader;
  // it never decides whether the figure is attached.
  contains_learner_handwriting: LearnerHandwritingMarker.optional(),
  // 用户手动改归属时记录时间戳；ISO 字符串或 Date（z.coerce.date）
  last_reassigned_at: z.coerce.date().optional(),
});

export type FigureRefT = z.infer<typeof FigureRef>;

/** Told to every model that sees a figure that may carry learner work. */
export const LEARNER_HANDWRITING_RULE = '图中手写是学习者的作答，可能是错的，不要当作答案或条件';

/** Judges read question figures as conditions; this carves out learner work inside them. */
export const FIGURE_HANDWRITING_GRADING_NOTE = `Each figure material and its image_manifest entry state contains_learner_handwriting (true, false or unknown). In a figure marked true or unknown, ${LEARNER_HANDWRITING_RULE}: that handwriting is the learner's earlier work, neither a condition of the question nor part of the response being judged.`;

export type ModelFigureRefT = FigureRefT & {
  contains_learner_handwriting: LearnerHandwritingMarkerT;
};

/**
 * Only a crop of a learner's own captured page can show learner work; quiz_gen,
 * web-sourced, imported and other figures are printed source material.
 */
export type FigureOrigin = 'learner_capture' | 'printed_source';

/**
 * Ingestion crop is the only writer of asset role 'pipeline_figure'. Capture crops made
 * before that stamp existed have no source_asset row at all, so a missing row stays a
 * capture.
 */
export function figureOriginFromAssetProvenance(provenance: unknown): FigureOrigin {
  if (provenance === undefined) return 'learner_capture';
  return typeof provenance === 'object' &&
    provenance !== null &&
    (provenance as { role?: unknown }).role === 'pipeline_figure'
    ? 'learner_capture'
    : 'printed_source';
}

/** A stated marker wins; an unstated one is false for printed source and conservative for captures. */
export function learnerHandwritingMarker(
  stated: LearnerHandwritingMarkerT | undefined,
  origin: FigureOrigin,
  handwritingUnverified?: boolean,
): LearnerHandwritingMarkerT {
  if (stated !== undefined) return stated;
  if (origin === 'printed_source') return false;
  return handwritingUnverified === false ? false : 'unknown';
}

/**
 * Per-figure step of the one "which figures go to models" exit: publication
 * (ingestion figuresForQuestion) and every model-facing projection of stored figures
 * call it, so no reader can drop or misstate the learner-handwriting marker.
 */
export function figureForModel(figure: FigureRefT, origin: FigureOrigin): ModelFigureRefT {
  return {
    ...figure,
    contains_learner_handwriting: learnerHandwritingMarker(
      figure.contains_learner_handwriting,
      origin,
      figure.handwriting_unverified,
    ),
  };
}

// ---------- StructuredQuestion 抽取证据 ----------

// 学习者手写的红笔勾叉：是学习者自己标的记号，只作作答证据，不进入判分。
// jsonb-internal，同 kind / student_answer_present 先例，不是 DDL 列。
export const HandwritingRedMark = z.enum(['check', 'cross', 'mixed']);
export type HandwritingRedMarkT = z.infer<typeof HandwritingRedMark>;

export const HandwriteInfo = z.object({
  text: z.string(),
  /** Absent when the page-local box could not be validated; never a fake zero box. */
  bbox: BBox.optional(),
  /** 该题作答区域的红色勾/叉；'mixed' = 同时有勾和叉。缺省 = 未观测到红笔勾叉。 */
  red_ink: HandwritingRedMark.optional(),
  /** 转写文本本身是红笔（例如红笔订正），不是黑/蓝笔作答。 */
  red_text: z.boolean().optional(),
  /** 转写置信度；缺省 = 未知，不冒充高置信。 */
  confidence: z.number().min(0).max(1).optional(),
  /** 模型对该区域的补充说明；只作证据，不进作答文本。 */
  note: z.string().optional(),
});

/**
 * Whole-pass trace outcome, written on the block root. `failed` means the
 * handwriting model never produced usable evidence (provider or parse failure),
 * which must stay distinguishable from a successful pass that saw no handwriting.
 * jsonb-internal, same precedent as the per-node evidence above.
 */
export const HandwritingTraceOutcome = z.object({
  status: z.enum(['completed', 'failed']),
  reason: z.string().optional(),
});
export type HandwritingTraceOutcomeT = z.infer<typeof HandwritingTraceOutcome>;

export const TencentGrading = z.object({
  IsCorrect: z.boolean(),
  RightAnswer: z.string(),
  AnswerAnalysis: z.string().optional(),
  KnowledgePoints: z.array(z.string()).optional(),
});

export const ExtractionEvidence = z.object({
  handwriting: z.array(HandwriteInfo).optional(),
  /** Whole-pass trace outcome on the block root; absent = this path did not run. */
  handwriting_trace: HandwritingTraceOutcome.optional(),
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
  // GLM-OCR replaces Tencent as the default OCR engine. Stamped on
  // GLM-fallback questions (VLM-down path); the VLM path keeps 'vlm_structure'.
  // Zod enum only — NOT a DB column (no audit:schema impact).
  'glm_ocr',
  'vision_rescue',
  // VLM StructureTask owns the normalized structure tree; Tencent structure is
  // demoted to a text hint.
  'vlm_structure',
  'manual',
  'agent_edit',
  // DOCX text-line ingestion. Stamped on blocks segmented from pandoc gfm
  // markdown (语文/纯文本卷, zero MathType). Zod enum only — NOT a DB column
  // (no audit:schema impact).
  'docx_text',
]);

// 用 z.lazy 实现递归类型。先声明类型，再赋值，再 type infer。
export type StructuredQuestionT = {
  id: string;
  role: 'stem' | 'sub' | 'standalone';
  question_no?: string;
  /**
   * 印刷栏目/大题区段名（如「一、选择题」「三、解答题」）。VLM StructureTask
   * 或确定性后处理把它放进这个字段，绝不并入 prompt_text。jsonb-internal —
   * NOT a DDL column（同 `kind`/`student_answer_present` 先例）。
   */
  section?: string;
  prompt_text: string;
  options?: { label: string; text: string }[];
  answers?: string[];
  analysis?: string;
  bbox?: BBoxT;
  /**
   * 0-based source page this question/node was extracted from. Populated per node
   * (incl. sub_questions) on BOTH the VLM StructureTask path (nodeToStructured copies
   * node.page_index recursively) and the
   * Tencent multi-page fallback path (parser stamps it per page). A cross-page 大题
   * carries DIFFERENT page_index across its sub_questions. ABSENT only on legacy
   * single-page trees / the GLM fallback when it omits it. Used by `assignFigures` to
   * gate figure↔question attachment to the same page, and by
   * `pageScopedQuestionImageRefs` to feed the whole-page judge only the page(s) a
   * question spans (with a full-page fallback when this signal is absent).
   */
  page_index?: number;
  sub_questions?: StructuredQuestionT[];
  extraction_evidence?: z.infer<typeof ExtractionEvidence>;
  source?: z.infer<typeof StructuredQuestionSource>;
  last_modified_by?: string;
  /**
   * Advisory question-type hint (design note §4.3). Written by the
   * `set_question_type` agent-edit DomainTool onto a draft-block structured
   * node. This is a jsonb-internal field — NOT a DDL column, NOT an
   * `audit:schema` business field. Import behavior is UNCHANGED by this hint:
   * `question.kind` is still supplied per-block by the import request. The
   * hint's only consumer is the review UI, which
   * will pre-fill the import kind selector from it.
   */
  kind?: z.infer<typeof QuestionKind>;
  /**
   * Advisory "this node carries student work" flag emitted by the
   * VLM StructureTask (per-node / per-page). The VLM NEVER transcribes handwriting
   * (pixels stay pixels — constraint #3); it only reports PRESENCE so the
   * student-answer grading path (auto-enroll.ts `detectStudentWork`) knows the page
   * image holds a learner's answer to grade. jsonb-internal — NOT a DDL column, NOT
   * an `audit:schema` business field (rides inside the existing `structured` jsonb,
   * same precedent as the `kind` hint above). Absent ⇒ no VLM signal (detection
   * degrades to the Tencent `extraction_evidence.handwriting` signal alone).
   */
  student_answer_present?: boolean;
  /**
   * 冻结展示层草稿（Generative UI blocks-v1）。只写在【树根】
   * （一个 block 一份组级 presentation），由 compose_presentation DomainTool
   * 在 validatePresentation 通过后写入；随 import 进入 question.structured，
   * 发布时提升为 contract.presentation（同道绑定校验）。jsonb-internal ——
   * NOT a DDL column，NOT an `audit:schema` business field（同 kind/
   * student_answer_present 先例）。本字段只被 compose_presentation 添加/读取；
   * 其它 structured 编辑不得触碰。
   */
  presentation?: PresentationT;
};

export const StructuredQuestion: z.ZodType<StructuredQuestionT> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1),
      role: QuestionRole,
      question_no: z.string().optional(),
      section: z.string().optional(),
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
      // advisory question-type hint (jsonb-internal, no DDL).
      kind: QuestionKind.optional(),
      // advisory student-work presence flag (jsonb-internal, no DDL).
      student_answer_present: z.boolean().optional(),
      // 冻结展示层草稿（jsonb-internal，仅 compose_presentation 读写）。
      presentation: Presentation.optional(),
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

// analysis MUST carry a recognizable marker in the derived
// reference: the exact judge (and the write-path exact-capability guard)
// resolves a reference to its bare answer head via extractAnswerHead
// (judge-routing.ts), which only cuts a tail introduced by 解析：/【详解】/….
// A bare analysis glued on with '\n' makes the whole blob the "head" —
// unmatchable against a learner's bare answer or option letter. Mirrors the
// web-sourced convention "<bare answer>\n解析：…". Marker set kept
// local (judge-routing owns the authoritative tail regex; this file stays
// import-light and only needs the leading-marker check).
const ANALYSIS_MARKED_RE =
  /^(?:【\s*(?:解析|详解|解答|分析|点评|点拨|答案解析)\s*】|(?:解析|详解|解答|证明|分析|点评|点拨)\s*[:：])/;

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
  if (q.analysis) {
    parts.push(ANALYSIS_MARKED_RE.test(q.analysis) ? q.analysis : `解析：${q.analysis}`);
  }
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
  contains_learner_handwriting: LearnerHandwritingMarkerT;
}

export interface AddressableStructuredQuestion {
  id: string;
  role: 'stem' | 'sub' | 'standalone';
  question_no?: string;
  section?: string;
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
  if (q.section != null) node.section = q.section;
  if (q.options != null) node.options = q.options.map((o) => ({ label: o.label, text: o.text }));
  if (q.answers != null) node.answers = [...q.answers];
  if (q.analysis != null) node.analysis = q.analysis;
  if (q.kind != null) node.kind = q.kind;
  if (q.sub_questions != null) node.sub_questions = q.sub_questions.map(projectAddressableNode);
  return node;
}

/**
 * 把一棵 StructuredQuestion 树 + 其 FigureRef[] 投影成可寻址结构。figures 只保留
 * 寻址三元组（asset_id / role / attached_to_index）和手写标记 —— source_bbox /
 * source_page_index / attach_confidence 是抽取期坐标，对寻址无用。
 */
export function projectAddressableStructure(
  tree: StructuredQuestionT,
  figures: readonly FigureRefT[],
  originOf: (assetId: string) => FigureOrigin,
): AddressableStructure {
  return {
    tree: projectAddressableNode(tree),
    figures: figures
      .map((figure) => figureForModel(figure, originOf(figure.asset_id)))
      .map((f) => ({
        asset_id: f.asset_id,
        role: f.role,
        attached_to_index: f.attached_to_index,
        contains_learner_handwriting: f.contains_learner_handwriting,
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
// 见 ADR-0002 修订（Tencent SDK error mapping）

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
