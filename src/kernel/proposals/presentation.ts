import { inArray } from 'drizzle-orm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { AiProposalPayloadT } from '@/core/schema/proposal';
import type { StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db, Tx } from '@/db/client';
import { question, question_block } from '@/db/schema';

type DbLike = Db | Tx;
type QuestionEditChange = Extract<AiProposalPayloadT, { kind: 'question_edit' }>['proposed_change'];

const TITLE_DETAIL_CAP = 48;
const BLOCK_EXCERPT_CAP = 120;
// YUK-1404 — named bounds for the additive sub-question / option previews on
// block previews. Lists carry at most these entries; the *_count fields keep
// the TRUE structured totals, so a truncated list is always shorter than its
// count — the UI never mistakes a preview list for the full set.
const BLOCK_SUB_QUESTION_PREVIEW_MAX = 3;
const BLOCK_OPTION_PREVIEW_MAX = 4;
const SUB_QUESTION_EXCERPT_CAP = 80;
const OPTION_TEXT_CAP = 60;

export interface ProposalBlockPreview {
  id: string;
  label: string;
  excerpt: string;
  /**
   * YUK-1404 — TRUE structured totals (never the preview-list lengths). null
   * when the block has no structured tree (legacy rows) — the UI must not
   * guess a count it cannot know.
   */
  sub_question_count: number | null;
  option_count: number | null;
  /** Bounded learner-facing previews; may be shorter than the counts above. */
  sub_questions: ProposalBlockSubQuestionPreview[];
  options: ProposalBlockOptionPreview[];
}

/**
 * YUK-1404 — bounded sub-question preview: learner label + text excerpt ONLY.
 * No answers / analysis / student-work flags / figure ids ever enter this
 * projection (learner-visible read surface).
 */
export interface ProposalBlockSubQuestionPreview {
  label: string;
  excerpt: string;
}

/** YUK-1404 — bounded option preview: the option's own label + text ONLY. */
export interface ProposalBlockOptionPreview {
  label: string;
  text: string;
}

export interface ProposalSummaryItem {
  label: string;
  value: string;
}

export interface ProposalPresentation {
  title: string;
  change_summary: ProposalSummaryItem[];
  technical_details: string | null;
  evidence_labels: Record<string, string>;
  block_merge: {
    primary: ProposalBlockPreview | null;
    merged: ProposalBlockPreview[];
    continuity_label: string | null;
  } | null;
}

interface ProposalPresentationInput {
  id: string;
  payload: AiProposalPayloadT;
}

type QuestionBlockPreviewRow = Pick<
  typeof question_block.$inferSelect,
  'id' | 'ingestion_session_id' | 'ordinal' | 'page_spans' | 'structured' | 'extracted_prompt_md'
>;

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : null;
}

// YUK-1404 P1 — a raw slice could cut inside a math span and leak a dangling
// `$` / `$$` / `\(` opener or raw TeX into the learner preview. Truncation
// backs off to just before the span the cap would split (never synthesizing a
// closing delimiter). Math spans are NOT hand-scanned: they are the position
// spans of the `inlineMath` / `math` nodes produced by the renderer's own
// pipeline (unified + remark-parse + remark-math — what react-markdown runs
// with, micromark 3.1), so the grammar is the actual one: whitespace-padded
// and digit-adjacent dollars are math, `$$$…$$$` is one span, a `$` after an
// even run of backslashes opens, unclosed flow `$$` may span blank lines and
// runs to EOF, code spans/fences win, and only a CommonMark line-anchored
// ``` / ~~~ run is a fence (inline backticks are not). The explicit legacy
// `\(...\)` / `\[...\]` forms never reach that parser as math, so they are
// protected with their ORIGINAL offsets via the renderer normalizer's own
// grammar (LATEX_DELIMITED in src/ui/lib/math-markdown.tsx, mirrored below):
// the renderer rewrites exactly those spans into dollar math before parsing.
// Guard spaces and the display-block reflow exist only in normalized
// coordinates, so AST spans found there are mapped back piecewise (rewrite
// interiors are covered by their whole source span) — offsets are never
// shifted blindly. Preview read-side only: the stored source is never
// rewritten, and text whose cap touches no active span stays byte-identical
// to the plain slice.

/** Minimal structural mdast view — only type/children/position are read. */
interface MathAstNode {
  type: string;
  children?: MathAstNode[] | undefined;
  position?:
    | { start: { offset?: number | undefined }; end: { offset?: number | undefined } }
    | undefined;
}

let mathSpanParser: { parse(text: string): unknown } | null = null;

/** The renderer's markdown→math pipeline (remark-math defaults: single `$` on). */
function rendererMathParser(): { parse(text: string): unknown } {
  mathSpanParser ??= unified().use(remarkParse).use(remarkMath) as unknown as {
    parse(text: string): unknown;
  };
  return mathSpanParser;
}

function collectMathSpans(node: MathAstNode, spans: Array<[number, number]>): void {
  if (node.type === 'inlineMath' || node.type === 'math') {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (typeof start === 'number' && typeof end === 'number' && start < end) {
      spans.push([start, end]);
    }
  }
  for (const child of node.children ?? []) collectMathSpans(child, spans);
}

/** Mirror of LATEX_DELIMITED (src/ui/lib/math-markdown.tsx) — keep in lockstep. */
const LEGACY_MATH_DELIMITED =
  /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|(?<!\\)\\\[((?:(?!\n\s*\n)[^`])+?)\\\]|(?<!\\)\\\(((?:(?!\n\s*\n)[^`])+?)\\\)/g;

interface LegacyRewrite {
  /** Span in the stored source that the renderer would rewrite to dollars. */
  sourceStart: number;
  sourceEnd: number;
  /** Same span in the normalized coordinates the renderer parses. */
  normalizedStart: number;
  normalizedEnd: number;
}

/** Verbatim mirror of the normalizeMathDelimiters replacement callback. */
function legacyMathReplacement(
  source: string,
  match: string,
  display: string | undefined,
  inline: string | undefined,
  offset: number,
): string {
  const prev = source.slice(Math.max(0, offset - 2), offset);
  const before = prev.endsWith('$') || prev === '\\)' || prev === '\\]' ? ' ' : '';
  const after = source[offset + match.length] === '$' ? ' ' : '';
  if (display !== undefined) {
    const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
    const indent = source.slice(lineStart, offset);
    if (/^[ \t]*$/.test(indent)) return `$$\n${indent}${display.trim()}\n${indent}$$\n${indent}`;
    return `${before}$$${display}$$${after}`;
  }
  return `${before}$${(inline ?? '').trim()}$${after}`;
}

/** The text the renderer actually parses, plus where each legacy rewrite landed. */
function effectiveSourceOf(source: string): { effective: string; rewrites: LegacyRewrite[] } {
  const rewrites: LegacyRewrite[] = [];
  if (!source.includes('\\(') && !source.includes('\\[')) {
    return { effective: source, rewrites };
  }
  const parts: string[] = [];
  let normalizedLength = 0;
  let sourceCursor = 0;
  for (const match of source.matchAll(LEGACY_MATH_DELIMITED)) {
    const [text, code, display, inline] = match;
    const start = match.index ?? 0;
    parts.push(source.slice(sourceCursor, start));
    normalizedLength += start - sourceCursor;
    if (code === undefined) {
      const replacement = legacyMathReplacement(source, text, display, inline, start);
      rewrites.push({
        sourceStart: start,
        sourceEnd: start + text.length,
        normalizedStart: normalizedLength,
        normalizedEnd: normalizedLength + replacement.length,
      });
      parts.push(replacement);
      normalizedLength += replacement.length;
    } else {
      parts.push(text);
      normalizedLength += text.length;
    }
    sourceCursor = start + text.length;
  }
  parts.push(source.slice(sourceCursor));
  return { effective: parts.join(''), rewrites };
}

/**
 * Map a math span found in normalized coordinates back to source coordinates.
 * Pieces inside a rewrite are dropped — that rewrite's whole source span is
 * already protected; pieces outside are shifted only by the length deltas of
 * fully-preceding rewrites, so offsets never drift.
 */
function mathSpanInSource(
  span: readonly [number, number],
  rewrites: readonly LegacyRewrite[],
): Array<[number, number]> {
  const pieces: Array<[number, number]> = [];
  let start = span[0];
  const end = span[1];
  for (const rewrite of rewrites) {
    if (rewrite.normalizedEnd <= start || rewrite.normalizedStart >= end) continue;
    if (start < rewrite.normalizedStart) pieces.push([start, rewrite.normalizedStart]);
    start = Math.max(start, rewrite.normalizedEnd);
    if (start >= end) break;
  }
  if (start < end) pieces.push([start, end]);
  return pieces.map(([from, to]) => {
    let shift = 0;
    for (const rewrite of rewrites) {
      if (rewrite.normalizedEnd <= from) {
        shift +=
          rewrite.sourceEnd -
          rewrite.sourceStart -
          (rewrite.normalizedEnd - rewrite.normalizedStart);
      }
    }
    return [from + shift, to + shift] as [number, number];
  });
}

/** Merged, disjoint active-math spans in SOURCE coordinates. */
function activeMathSpans(value: string): Array<[number, number]> {
  if (!value.includes('$') && !value.includes('\\(') && !value.includes('\\[')) return [];
  const { effective, rewrites } = effectiveSourceOf(value);
  const spans: Array<[number, number]> = rewrites.map(
    (rewrite) => [rewrite.sourceStart, rewrite.sourceEnd] as [number, number],
  );
  // The parse is the only non-trivial cost, and dollars are its only trigger.
  // A parse failure must never 500 the read path — fall back to the legacy
  // spans (the renderer would fail on the same content anyway).
  if (effective.includes('$')) {
    try {
      const astSpans: Array<[number, number]> = [];
      collectMathSpans(rendererMathParser().parse(effective) as MathAstNode, astSpans);
      for (const span of astSpans) spans.push(...mathSpanInSource(span, rewrites));
    } catch {
      // legacy spans above still protect explicit \(...\) / \[...\]
    }
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

/**
 * Largest cut index ≤ limit that does not split an active math span. When the
 * raw limit lands strictly inside a span, back off to the span's start; text
 * with no intersecting span cuts exactly where the old raw slice did.
 */
function mathSafeCut(value: string, limit: number): number {
  for (const [start, end] of activeMathSpans(value)) {
    if (start < limit && limit < end) return start;
  }
  return limit;
}

function truncate(value: string, cap: number): string {
  if (value.length <= cap) return value;
  return `${value.slice(0, mathSafeCut(value, cap - 1))}…`;
}

function subQuestionPreview(
  sub: StructuredQuestionT,
  index: number,
): ProposalBlockSubQuestionPreview {
  return {
    label: textOf(sub.question_no) ?? `第 ${index + 1} 问`,
    excerpt: truncate(textOf(sub.prompt_text) ?? '题面暂缺', SUB_QUESTION_EXCERPT_CAP),
  };
}

function optionPreview(option: { label: string; text: string }): ProposalBlockOptionPreview {
  return {
    label: textOf(option.label) ?? '?',
    text: truncate(textOf(option.text) ?? '选项暂缺', OPTION_TEXT_CAP),
  };
}

function titled(base: string, detail: unknown): string {
  const text = textOf(detail);
  return text ? `${base}：${truncate(text, TITLE_DETAIL_CAP)}` : base;
}

function readableToken(value: unknown): string | null {
  const text = textOf(value);
  if (!text) return null;
  if (DOMAIN_TOKEN[text]) return DOMAIN_TOKEN[text];
  return text
    .split('_')
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

function summaryItem(label: string, value: unknown): ProposalSummaryItem | null {
  const text = textOf(value);
  return text ? { label, value: truncate(text, BLOCK_EXCERPT_CAP) } : null;
}

function compact(items: Array<ProposalSummaryItem | null>): ProposalSummaryItem[] {
  return items.filter((item): item is ProposalSummaryItem => item !== null);
}

const EDGE_OPERATION: Record<string, string> = {
  create: '新增关系',
  archive: '归档关系',
  supersede: '替换关系',
};

const MUTATION_OPERATION: Record<string, string> = {
  reparent: '调整父级',
  merge: '合并知识点',
  split: '拆分知识点',
};

const QUESTION_EDIT_OPERATION: Record<string, string> = {
  edit_node_text: '修改题面',
  edit_reference: '修改答案或解析',
  set_choice: '更新选项',
  set_node_kind: '调整题型',
};

const DOMAIN_TOKEN: Record<string, string> = {
  prerequisite: '前置关系',
  related_to: '相关关系',
  contrasts_with: '易混淆关系',
  applied_in: '应用关系',
  derived_from: '推导关系',
  choice: '选择题',
  true_false: '判断题',
  fill_blank: '填空题',
  short_answer: '简答题',
  essay: '论述题',
  computation: '计算题',
  reading: '阅读题',
  translation: '翻译题',
  derivation: '推导题',
  mastery_high_persisted: '掌握表现持续稳定',
  check_all_passed: '所有检查均通过',
  no_recent_mistake: '近期没有同类错误',
  user_stated_understanding: '你已确认理解',
};

const RECORD_PROMOTION_TARGET: Record<string, string> = {
  question: '整理为练习题',
  learning_item: '整理为学习项',
  artifact: '整理为学习笔记',
};

function estimatedDifficulty(value: unknown): string | null {
  if (typeof value !== 'number') return null;
  const level = value <= 2 ? '偏低' : value >= 4 ? '偏高' : '中等';
  return `${level}（AI 估计，仅供参考）`;
}

function estimatedMasteryTrend(current: unknown, peak: unknown): string | null {
  if (typeof current !== 'number' || typeof peak !== 'number') return null;
  const gap = peak - current;
  const trend =
    gap > 0.15 ? '较历史高点明显回落' : gap > 0.03 ? '较历史高点有所回落' : '建议复核当前掌握状态';
  return `${trend}（AI 估计，仅供参考）`;
}

function noteUpdateSummary(change: Record<string, unknown> | null): string | null {
  const summary = recordOf(change?.summary);
  const ops = summary?.ops_count;
  const blocks = summary?.new_blocks;
  if (typeof ops !== 'number') return textOf(change?.summary_md ?? change?.summary);
  return `${ops} 处内容调整${typeof blocks === 'number' ? `，其中新增 ${blocks} 块` : ''}`;
}

function questionEditSummary(change: QuestionEditChange): ProposalSummaryItem[] {
  const edit = change.edit;
  const location =
    edit.op === 'edit_node_text' ? null : summaryItem('题面定位', change.node_preview);
  switch (edit.op) {
    case 'edit_node_text':
      return compact([
        summaryItem('修改', QUESTION_EDIT_OPERATION[edit.op]),
        summaryItem('新题面', edit.prompt_text),
      ]);
    case 'edit_reference':
      return compact([
        summaryItem('修改', QUESTION_EDIT_OPERATION[edit.op]),
        location,
        edit.answers === undefined
          ? null
          : summaryItem(
              '新答案',
              edit.answers.length > 0 ? edit.answers.join('；') : '清空参考答案',
            ),
        edit.analysis === undefined
          ? null
          : summaryItem('新解析', edit.analysis.length > 0 ? edit.analysis : '清空解析'),
      ]);
    case 'set_choice':
      return compact([
        summaryItem('修改', QUESTION_EDIT_OPERATION[edit.op]),
        location,
        summaryItem(
          '新选项',
          edit.options.map((option) => `${option.label}. ${option.text}`).join('；'),
        ),
      ]);
    case 'set_node_kind':
      return compact([
        summaryItem('修改', QUESTION_EDIT_OPERATION[edit.op]),
        location,
        summaryItem('新题型', readableToken(edit.kind)),
      ]);
  }
}

type ProposalPayloadByKind = {
  [K in AiProposalPayloadT['kind']]: Extract<AiProposalPayloadT, { kind: K }>;
};
type ProposalPayload<K extends AiProposalPayloadT['kind'] = AiProposalPayloadT['kind']> = {
  [P in K]: ProposalPayloadByKind[P];
}[K];
type ProposalPresenter<K extends AiProposalPayloadT['kind']> = {
  title: (payload: ProposalPayloadByKind[K]) => string;
  summary: (payload: ProposalPayloadByKind[K]) => ProposalSummaryItem[];
  details: (payload: ProposalPayloadByKind[K]) => string | null;
};

function defaultTechnicalDetails(payload: AiProposalPayloadT): string {
  const details = recordOf(payload.proposed_change);
  if (!details) return JSON.stringify(payload.proposed_change, null, 2);
  return JSON.stringify(details, null, 2);
}

function difficultyTechnicalDetails(payload: AiProposalPayloadT): string {
  const details = recordOf(payload.proposed_change);
  if (!details) return JSON.stringify(payload.proposed_change, null, 2);
  const { difficulty, ...learnerSafe } = details;
  return JSON.stringify(
    { ...learnerSafe, difficulty_estimate: estimatedDifficulty(difficulty) },
    null,
    2,
  );
}

function relearnTechnicalDetails(payload: AiProposalPayloadT): string {
  const details = recordOf(payload.proposed_change);
  if (!details) return JSON.stringify(payload.proposed_change, null, 2);
  const { current_mastery, peak_mastery, ...learnerSafe } = details;
  return JSON.stringify(
    {
      ...learnerSafe,
      mastery_trend_estimate: estimatedMasteryTrend(current_mastery, peak_mastery),
    },
    null,
    2,
  );
}

// One exhaustive entry owns each kind's human projection and safe technical details.
const proposalPresenters: { [K in AiProposalPayloadT['kind']]: ProposalPresenter<K> } = {
  knowledge_node: {
    title: (payload) => titled('新知识点', payload.proposed_change.name),
    summary: (payload) => {
      const change = recordOf(payload.proposed_change);
      return compact([summaryItem('新知识点', change?.name)]);
    },
    details: defaultTechnicalDetails,
  },
  knowledge_edge: {
    title: () => '调整知识关系',
    summary: (payload) => {
      const change = recordOf(payload.proposed_change);
      return compact([
        summaryItem('动作', EDGE_OPERATION[textOf(change?.edge_op) ?? 'create'] ?? '调整关系'),
        summaryItem('关系', readableToken(change?.relation_type)),
      ]);
    },
    details: defaultTechnicalDetails,
  },
  knowledge_mutation: {
    title: (payload) => MUTATION_OPERATION[payload.proposed_change.mutation] ?? '调整知识结构',
    summary: (payload) => {
      const change = recordOf(payload.proposed_change);

      const mutation = textOf(change?.mutation);
      const splitCount = Array.isArray(change?.into) ? change.into.length : null;
      const mergeCount = Array.isArray(change?.from_ids) ? change.from_ids.length : null;
      return compact([
        summaryItem(
          '动作',
          mutation ? (MUTATION_OPERATION[mutation] ?? readableToken(mutation)) : null,
        ),
        summaryItem(
          '范围',
          splitCount
            ? `拆成 ${splitCount} 个知识点`
            : mergeCount
              ? `合并 ${mergeCount} 个知识点`
              : null,
        ),
      ]);
    },
    details: defaultTechnicalDetails,
  },
  learning_item: {
    title: (payload) => {
      const change = recordOf(payload.proposed_change);
      return titled('建立学习主线', recordOf(change?.hub)?.title ?? change?.topic);
    },
    summary: (payload) => {
      const change = recordOf(payload.proposed_change);

      const hub = recordOf(change?.hub);
      const stepCount =
        (Array.isArray(change?.atomics) ? change.atomics.length : 0) +
        (Array.isArray(change?.longs) ? change.longs.length : 0);
      return compact([
        summaryItem('学习主线', hub?.title ?? change?.topic),
        summaryItem('计划', stepCount > 0 ? `${stepCount} 个学习步骤` : null),
      ]);
    },
    details: defaultTechnicalDetails,
  },
  note_update: {
    title: (payload) => {
      const change = recordOf(payload.proposed_change);
      return titled('更新学习笔记', noteUpdateSummary(change));
    },
    summary: (payload) => {
      const change = recordOf(payload.proposed_change);

      const patch = recordOf(change?.patch);
      const summary = recordOf(change?.summary);
      const opCount = Array.isArray(patch?.ops)
        ? patch.ops.length
        : Array.isArray(change?.ops)
          ? change.ops.length
          : typeof summary?.ops_count === 'number'
            ? summary.ops_count
            : null;
      return compact([
        summaryItem('修改', opCount === null ? '更新笔记内容' : `${opCount} 处内容调整`),
        typeof summary?.ops_count === 'number'
          ? summaryItem(
              '新增',
              typeof summary.new_blocks === 'number' && summary.new_blocks > 0
                ? `${summary.new_blocks} 个内容块`
                : null,
            )
          : summaryItem('说明', noteUpdateSummary(change)),
      ]);
    },
    details: defaultTechnicalDetails,
  },
  variant_question: {
    title: (payload) => titled('生成变式练习', payload.proposed_change.prompt_md),
    summary: (payload) => {
      const change = recordOf(payload.proposed_change);
      return compact([
        summaryItem('新题题面', change?.prompt_md),
        summaryItem('AI 估计难度', estimatedDifficulty(change?.difficulty)),
        summaryItem(
          '变式层级',
          typeof change?.variant_depth === 'number' ? `第 ${change.variant_depth} 层` : null,
        ),
      ]);
    },
    details: difficultyTechnicalDetails,
  },
  completion: {
    title: () => '确认学习项已完成',
    summary: (payload) => {
      const change = recordOf(payload.proposed_change);

      const signals = Array.isArray(change?.triggering_signals)
        ? change.triggering_signals.map(readableToken).filter(Boolean).join('、')
        : null;
      return compact([summaryItem('建议', '标记学习项已完成'), summaryItem('依据', signals)]);
    },
    details: defaultTechnicalDetails,
  },
  relearn: {
    title: () => '重新巩固学习项',
    summary: (payload) => {
      const change = recordOf(payload.proposed_change);
      return compact([
        summaryItem(
          '距上次完成',
          typeof change?.days_since_done === 'number' ? `${change.days_since_done} 天` : null,
        ),
        summaryItem(
          'AI 估计掌握趋势',
          estimatedMasteryTrend(change?.current_mastery, change?.peak_mastery),
        ),
      ]);
    },
    details: relearnTechnicalDetails,
  },
  defer: {
    title: () => '调整学习安排',
    summary: (payload) => {
      const change = recordOf(payload.proposed_change);
      return compact([
        summaryItem('延后到', change?.defer_until),
        summaryItem('安排说明', change?.reason),
      ]);
    },
    details: defaultTechnicalDetails,
  },
  record_links: {
    title: () => '补充记录关联',
    summary: (payload) => {
      const change = recordOf(payload.proposed_change);

      const links = Array.isArray(change?.links)
        ? change.links.length
        : Array.isArray(change?.link_refs)
          ? change.link_refs.length
          : null;
      return compact([
        summaryItem('关联', links === null ? '补充记录之间的关联' : `${links} 条关联`),
      ]);
    },
    details: defaultTechnicalDetails,
  },
  record_promotion: {
    title: (payload) => {
      const target = textOf(recordOf(payload.proposed_change)?.target);
      return titled('整理学习记录', target ? RECORD_PROMOTION_TARGET[target] : null);
    },
    summary: (payload) => {
      const change = recordOf(payload.proposed_change);

      const target = textOf(change?.target);
      const draft = recordOf(change?.draft);
      return compact([
        summaryItem('目标', (target && RECORD_PROMOTION_TARGET[target]) ?? '整理为长期学习对象'),
        summaryItem('草稿标题或题面', draft?.title ?? draft?.prompt_md),
      ]);
    },
    details: defaultTechnicalDetails,
  },
  archive: {
    title: () => '归档学习内容',
    summary: (payload) => {
      const change = recordOf(payload.proposed_change);
      return compact([
        summaryItem('动作', '移出当前工作区'),
        summaryItem('原因', change?.archived_reason ?? change?.reason),
      ]);
    },
    details: defaultTechnicalDetails,
  },
  judge_retraction: {
    title: () => '复核一次 AI 判定',
    summary: (payload) => {
      const change = recordOf(payload.proposed_change);
      return compact([
        summaryItem('动作', '撤回这次 AI 判定'),
        summaryItem('复核说明', change?.reason_md),
      ]);
    },
    details: defaultTechnicalDetails,
  },
  goal_scope: {
    title: (payload) => titled('确认目标范围', payload.proposed_change.title),
    summary: (payload) => {
      const change = recordOf(payload.proposed_change);
      return compact([
        summaryItem('目标', change?.title),
        summaryItem(
          '范围',
          Array.isArray(change?.scope_knowledge_ids)
            ? `${change.scope_knowledge_ids.length} 个知识点`
            : null,
        ),
        summaryItem('判断依据', change?.reasoning),
      ]);
    },
    details: defaultTechnicalDetails,
  },
  block_merge: {
    title: (payload) => {
      const mergedCount = payload.proposed_change.merge_block_ids.length;
      return `合并 ${mergedCount + 1} 个被切断的题块`;
    },
    summary: (payload) => {
      const change = recordOf(payload.proposed_change);
      return compact([
        summaryItem(
          '动作',
          Array.isArray(change?.merge_block_ids)
            ? `保留 1 块，并入 ${change.merge_block_ids.length} 块`
            : null,
        ),
      ]);
    },
    details: defaultTechnicalDetails,
  },
  image_candidate: {
    title: (payload) => titled('图题来源', payload.proposed_change.source_title),
    summary: (payload) => {
      const change = recordOf(payload.proposed_change);
      return compact([
        summaryItem('来源', change?.source_title),
        summaryItem('图题判断', change?.summary_md),
        summaryItem('题型', readableToken(change?.requested_kind)),
      ]);
    },
    details: defaultTechnicalDetails,
  },
  question_draft: {
    title: (payload) => titled('审核新题', payload.proposed_change.prompt_preview),
    summary: (payload) => {
      const change = recordOf(payload.proposed_change);
      return compact([
        summaryItem('题面', change?.prompt_preview),
        summaryItem('题型', readableToken(change?.kind)),
        summaryItem('AI 估计难度', estimatedDifficulty(change?.difficulty)),
      ]);
    },
    details: difficultyTechnicalDetails,
  },
  question_edit: {
    title: (payload) => titled('修订一道题目', payload.proposed_change.node_preview),
    summary: (payload) => questionEditSummary(payload.proposed_change),
    details: defaultTechnicalDetails,
  },
  conjecture: {
    title: (payload) => titled('验证诊断推测', payload.proposed_change.claim_md),
    summary: (payload) => {
      const change = recordOf(payload.proposed_change);
      return compact([
        summaryItem('观察', change?.claim_md),
        summaryItem('验证方式', change?.probe_md),
        summaryItem(
          '重复信号',
          typeof change?.recurrence_count === 'number' ? `${change.recurrence_count} 次` : null,
        ),
      ]);
    },
    details: () => null,
  },
  cause_category: {
    title: (payload) => titled('收编错因类目', payload.proposed_change.label),
    summary: (payload) => {
      const change = recordOf(payload.proposed_change);
      return compact([
        summaryItem('新类目', change?.label),
        summaryItem('类目 id', change?.category_id),
        summaryItem('说明', change?.description),
        summaryItem('来源', change?.source === 'owner' ? '人工提议' : 'AI 提议（other 复发）'),
      ]);
    },
    details: defaultTechnicalDetails,
  },
};

export function proposalChangeSummary<K extends AiProposalPayloadT['kind']>(
  payload: ProposalPayload<K>,
): ProposalSummaryItem[] {
  return proposalPresenters[payload.kind].summary(payload);
}

function technicalDetails<K extends AiProposalPayloadT['kind']>(
  payload: ProposalPayload<K>,
): string | null {
  return proposalPresenters[payload.kind].details(payload);
}

/** A concise learner-facing identity, derived from meaningful payload fields. */
export function proposalDisplayTitle<K extends AiProposalPayloadT['kind']>(
  payload: ProposalPayload<K>,
): string {
  return proposalPresenters[payload.kind].title(payload);
}

const CONTINUITY_LABEL: Record<string, string> = {
  page_edge: '跨页延续',
  numbering: '题号连续',
  stem_answer_split: '题干与作答区被切开',
  carryover: '上下文承接',
};

const IN_QUERY_CHUNK_SIZE = 500;

function blockPreview(block: QuestionBlockPreviewRow): ProposalBlockPreview {
  const questionNo = textOf(block.structured?.question_no);
  const pageIndex = block.page_spans[0]?.page_index;
  const position = [`第 ${block.ordinal + 1} 块`];
  if (questionNo) position.push(`题号 ${questionNo}`);
  if (pageIndex !== undefined) position.push(`第 ${pageIndex + 1} 页`);
  const prompt = textOf(block.structured?.prompt_text) ?? textOf(block.extracted_prompt_md);
  const tree = block.structured ?? null;
  return {
    id: block.id,
    label: position.join(' · '),
    excerpt: truncate(prompt ?? '题面暂缺', BLOCK_EXCERPT_CAP),
    // YUK-1404 — true totals; null when the block predates structured storage.
    sub_question_count: tree ? (tree.sub_questions?.length ?? 0) : null,
    option_count: tree ? (tree.options?.length ?? 0) : null,
    sub_questions: (tree?.sub_questions ?? [])
      .slice(0, BLOCK_SUB_QUESTION_PREVIEW_MAX)
      .map((sub, index) => subQuestionPreview(sub, index)),
    options: (tree?.options ?? [])
      .slice(0, BLOCK_OPTION_PREVIEW_MAX)
      .map((option) => optionPreview(option)),
  };
}

function chunksOf<T>(values: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += IN_QUERY_CHUNK_SIZE) {
    chunks.push(values.slice(index, index + IN_QUERY_CHUNK_SIZE));
  }
  return chunks;
}

async function loadQuestionBlockPreviews(
  db: DbLike,
  ids: readonly string[],
): Promise<QuestionBlockPreviewRow[]> {
  const rows: QuestionBlockPreviewRow[] = [];
  for (const chunk of chunksOf(ids)) {
    rows.push(
      ...(await db
        .select({
          id: question_block.id,
          ingestion_session_id: question_block.ingestion_session_id,
          ordinal: question_block.ordinal,
          page_spans: question_block.page_spans,
          structured: question_block.structured,
          extracted_prompt_md: question_block.extracted_prompt_md,
        })
        .from(question_block)
        .where(inArray(question_block.id, chunk))),
    );
  }
  return rows;
}

async function loadQuestionPrompts(
  db: DbLike,
  ids: readonly string[],
): Promise<Array<{ id: string; prompt_md: string }>> {
  const rows: Array<{ id: string; prompt_md: string }> = [];
  for (const chunk of chunksOf(ids)) {
    rows.push(
      ...(await db
        .select({ id: question.id, prompt_md: question.prompt_md })
        .from(question)
        .where(inArray(question.id, chunk))),
    );
  }
  return rows;
}

/** Batch-enrich proposal cards without an N+1 query per block-merge card. */
export async function loadProposalPresentations(
  db: DbLike,
  proposals: readonly ProposalPresentationInput[],
): Promise<Map<string, ProposalPresentation>> {
  const presentations = new Map<string, ProposalPresentation>();
  const blockIds = new Set<string>();
  const questionIds = new Set<string>();
  for (const proposal of proposals) {
    presentations.set(proposal.id, {
      title: proposalDisplayTitle(proposal.payload),
      change_summary: proposalChangeSummary(proposal.payload),
      technical_details: technicalDetails(proposal.payload),
      evidence_labels: {},
      block_merge: null,
    });
    for (const evidence of proposal.payload.evidence_refs) {
      if (evidence.kind !== 'question') continue;
      questionIds.add(evidence.id);
      blockIds.add(evidence.id);
    }
    if (proposal.payload.kind !== 'block_merge') continue;
    blockIds.add(proposal.payload.proposed_change.primary_block_id);
    for (const id of proposal.payload.proposed_change.merge_block_ids) blockIds.add(id);
  }

  if (blockIds.size === 0 && questionIds.size === 0) return presentations;

  const [blocks, questions] = await Promise.all([
    loadQuestionBlockPreviews(db, [...blockIds]),
    loadQuestionPrompts(db, [...questionIds]),
  ]);
  const blockById = new Map(blocks.map((block) => [block.id, block]));
  const questionById = new Map(questions.map((row) => [row.id, row]));

  for (const proposal of proposals) {
    const presentation = presentations.get(proposal.id);
    if (!presentation) continue;
    for (const evidence of proposal.payload.evidence_refs) {
      if (evidence.kind !== 'question') continue;
      const block = blockById.get(evidence.id);
      const questionRow = questionById.get(evidence.id);
      const blockBelongsToProposal =
        block &&
        (proposal.payload.kind !== 'block_merge' ||
          block.ingestion_session_id === proposal.payload.proposed_change.ingestion_session_id)
          ? block
          : null;
      const preview = blockBelongsToProposal ? blockPreview(blockBelongsToProposal) : null;
      const label = preview
        ? `${preview.label} · ${preview.excerpt}`
        : questionRow
          ? `题目 · ${truncate(questionRow.prompt_md, TITLE_DETAIL_CAP)}`
          : null;
      if (label) presentation.evidence_labels[`question:${evidence.id}`] = label;
    }
    if (proposal.payload.kind !== 'block_merge') continue;
    const change = proposal.payload.proposed_change;
    const inExpectedSession = (id: string) => {
      const block = blockById.get(id);
      return block?.ingestion_session_id === change.ingestion_session_id ? block : null;
    };
    const primary = inExpectedSession(change.primary_block_id);
    const merged = change.merge_block_ids
      .map(inExpectedSession)
      .filter((block): block is QuestionBlockPreviewRow => block !== null)
      .map(blockPreview);
    presentations.set(proposal.id, {
      ...presentation,
      title: primary
        ? merged.length > 0
          ? `合并 ${merged.length + 1} 个被切断的题块`
          : '检查被切断的题块'
        : '检查题块合并提议',
      change_summary: [
        {
          label: '动作',
          value:
            primary && merged.length > 0
              ? `保留 1 块，并入 ${merged.length} 块`
              : '候选题块已变化，请重新检查',
        },
      ],
      block_merge: {
        primary: primary ? blockPreview(primary) : null,
        merged,
        continuity_label: change.continuity_signal
          ? (CONTINUITY_LABEL[change.continuity_signal] ?? null)
          : null,
      },
    });
  }

  return presentations;
}
