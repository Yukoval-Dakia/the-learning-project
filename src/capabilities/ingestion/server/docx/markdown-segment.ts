import { createId } from '@paralleldrive/cuid2';

import type { StructuredQuestionT } from '@/core/schema/structured_question';

// YUK-258 — DOCX text-line segmenter. Input = pandoc gfm markdown + extracted
// media manifest. Output = StructuredQuestionT[] (one per question block) with
// per-block image references (relative media paths; the persist stage swaps them
// for asset_ids).
//
// The interface shape is intentionally同构 with "markdown + 原位图引用" so a future
// GLM-OCR markdown path (#333) can reuse this segmenter unchanged. We do NOT
// depend on #333; this is an independent markdown-cutting implementation.
//
// 切题 regex modeled on tencent_mark_parser.ts's OPTION_LINE / SUB_LEADING_NUM
// patterns (those consume Tencent MarkInfos, not markdown — referenced for shape
// only). markdown carries no coordinates, so blocks have NO bbox / page_index
// (degradation path; the caller stamps page_spans=[{page_index:0, fullpage}]).

export interface SegmentedBlock {
  structured: StructuredQuestionT;
  /** Relative media paths (e.g. "media/image1.png") attached to this block, in order. */
  imagePaths: string[];
}

export interface SegmentInput {
  markdown: string;
  /** Media paths present in the document, for the noise-filter dimension checks. */
  media: Array<{ path: string; width?: number; height?: number }>;
}

// 题号行: 行首 N. — pandoc escapes leading numbers as `N\.` to avoid ordered-list
// promotion. Matches `1. text`, `1\. text`, AND a bare `8\.` line where pandoc split
// the number onto its own line and put the prompt on the NEXT line (observed on real
// 学科网 papers — Q8/Q13/Q23 otherwise merged into their predecessor); the prompt then
// flows in from the following line(s). `\d{1,3}` keeps 4-digit years (a stray `1991.`)
// from being mistaken for a question number. This only identifies candidates:
// numeric-led text can also be a decimal or section counter, so its boundary
// requires numbering/block context below rather than a fixed year/unit suffix.
const QUESTION_LEADING = /^\s*(\d{1,3})\\?[.．、]\s*(.*)$/;
const COMPACT_NUMERIC_LEADING = /^\s*\d{1,3}\\?[.．、]\d/;
// 选项行: A. / B\. etc.
const OPTION_LINE = /^\s*([A-D])\\?[.．、]\s*(.*)$/;
// 嵌图: markdown form ![alt](media/...) AND pandoc's <img src="media/..."> HTML
// form (emitted when the OOXML drawing carries explicit dimensions).
const IMG_MD = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;

interface DraftQuestion {
  questionNo: string;
  startedFromBare: boolean;
  promptLines: string[];
  options: Array<{ label: string; text: string }>;
  imagePaths: string[];
}

const BARE_DUPLICATE_LOOKAHEAD_LINES = 2;

function isBareQuestionBoundary(
  lines: readonly string[],
  lineIndex: number,
  currentQuestionNo: string | null,
  candidateQuestionNo: string,
): boolean {
  const candidate = Number(candidateQuestionNo);
  const current = currentQuestionNo == null ? null : Number(currentQuestionNo);

  // A bare marker has no textual evidence of being a top-level question. It
  // must move numbering forward (or start at Q1), but gaps are valid when a
  // section omits questions or continues at a later number.
  if (current == null ? candidate !== 1 : candidate <= current) return false;

  // A nearby same-number marker is stronger evidence that this bare line is an
  // outline item and the later texted marker is the real question. Keep this
  // lookahead deliberately short: scanning the whole remaining question would
  // let a distant same-number sub-item override a valid bare boundary.
  const lookaheadEnd = Math.min(lines.length, lineIndex + BARE_DUPLICATE_LOOKAHEAD_LINES + 1);
  for (let index = lineIndex + 1; index < lookaheadEnd; index += 1) {
    const next = QUESTION_LEADING.exec(lines[index]);
    if (!next || COMPACT_NUMERIC_LEADING.test(lines[index])) continue;
    const nextQuestionNo = Number(next[1]);
    if (nextQuestionNo === candidate) return false;
  }

  return true;
}

function hasNumericQuestionContext(
  lines: readonly string[],
  lineIndex: number,
  currentQuestionNo: string | null,
  candidateQuestionNo: string,
): boolean {
  const current = Number(currentQuestionNo ?? 0);
  const candidate = Number(candidateQuestionNo);
  if (candidate !== current + 1) return false;

  const optionLabels = new Set<string>();
  let nextNumber: number | null = null;
  for (let index = lineIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const next = QUESTION_LEADING.exec(line);
    if (next && Number(next[1]) > current) {
      nextNumber = Number(next[1]);
      break;
    }
    for (const part of line.trim().split(/\s+(?=[A-D]\\?[.．、])/)) {
      const option = OPTION_LINE.exec(part);
      if (option) optionLabels.add(option[1]);
    }
  }
  // `2.5米` before the real Q2 is body text. A later same-number marker
  // outweighs this candidate; descending section counters never supply support.
  if (nextNumber === candidate) return false;
  // Either the following question completes the sequence (18, 19, 20), or
  // this candidate owns an option block. Both are provisional, not proof.
  return nextNumber === candidate + 1 || (optionLabels.has('A') && optionLabels.has('B'));
}

// ---------- math delimiter normalization (§3.3) ----------

/**
 * pandoc OMML→LaTeX emits GitLab-flavoured math: inline `$`...`$` and ```math
 * fences. Normalize to standard `$...$` / `$$...$$` so the render layer eats one
 * delimiter form. Idempotent on already-standard markdown.
 */
export function normalizeMathDelimiters(md: string): string {
  // GitLab block fence first (so its inner `$`-like content isn't mangled by the
  // inline pass): ```math\n...\n``` → $$...$$
  let out = md.replace(/```math\n([\s\S]+?)\n```/g, (_m, expr: string) => `$$${expr.trim()}$$`);
  // GitLab inline: $`x^2`$ → $x^2$
  out = out.replace(/\$`([^`]+?)`\$/g, (_m, expr: string) => `$${expr}$`);
  return out;
}

/**
 * Pandoc emits HTML instead of Markdown when a DOCX drawing carries explicit
 * dimensions, and may wrap the tag across lines. Collapse the complete tag to
 * one Markdown image reference before line-based segmentation so continuation
 * attributes such as `style="width:..."` can never become question text.
 */
export function normalizeHtmlImageTags(md: string): string {
  return md.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\bsrc\s*=\s*(["'])(.*?)\1/i.exec(tag);
    return src ? `![](${src[2]})` : '';
  });
}

// ---------- segmentation ----------

function finalize(draft: DraftQuestion): StructuredQuestionT {
  const prompt = draft.promptLines.join('\n').trim();
  const structured: StructuredQuestionT = {
    id: createId(),
    role: 'standalone',
    question_no: draft.questionNo,
    prompt_text: prompt,
    source: 'docx_text',
  };
  if (draft.options.length > 0) {
    structured.options = draft.options;
  }
  return structured;
}

// pandoc references media as `media/imageN.png`, `./media/imageN.png`, or an
// absolute tmp path depending on --extract-media. Normalize to the trailing
// `media/<name>` form the manifest + persist stage key on.
//
// Exported so the route's pathToAssetId map keys go through the SAME
// normalization as segmentMarkdown's imagePaths lookup (coderabbit-b): the two
// sides must agree regardless of what raw path form a future converter emits.
export function normalizeMediaPath(raw: string): string {
  const idx = raw.lastIndexOf('media/');
  return idx >= 0 ? raw.slice(idx) : raw;
}

/**
 * Cut pandoc gfm markdown into per-question structured blocks with in-position
 * provisional image attribution. Images before the first question stay only on
 * the source document; later images are provisionally associated by text anchor.
 * Word floating anchors can disagree with visual placement, so these references
 * always require review; Markdown alone cannot establish figure ownership.
 *
 * Noise filter (§3.4): tiny media (<50×50, from the manifest) are filtered out of
 * a block's imagePaths so decorative bullets/rules don't enter the pipeline. When
 * a media path has no dimensions in the manifest, it is KEPT (拿不准默认存).
 */
export function segmentMarkdown(input: SegmentInput): {
  blocks: SegmentedBlock[];
  warnings: string[];
} {
  // Word often bolds just the number, or the whole first line. Unwrap the
  // leading bold span before matching the marker; retain the remaining prose.
  const md = normalizeHtmlImageTags(normalizeMathDelimiters(input.markdown)).replace(
    /^(\s*)(\*\*|__)(\d{1,3}\\?[.．、].*?)\2/gm,
    '$1$3',
  );
  const lines = md.split('\n');

  // Build the tiny-image deny set from the manifest (§3.4 微小尺寸).
  const tinyPaths = new Set(
    input.media
      .filter((m) => m.width != null && m.height != null && (m.width < 50 || m.height < 50))
      .map((m) => normalizeMediaPath(m.path)),
  );

  const drafts: DraftQuestion[] = [];
  const warnings: string[] = [];
  let cur: DraftQuestion | null = null;

  for (const [lineIndex, rawLine] of lines.entries()) {
    const imagePaths: string[] = [];
    const line = rawLine.replace(IMG_MD, (_match, path: string) => {
      const normalized = normalizeMediaPath(path);
      if (!tinyPaths.has(normalized)) imagePaths.push(normalized);
      return '';
    });
    const q = QUESTION_LEADING.exec(line);
    if (q) {
      // Once a bare marker has opened a question, a later line that repeats the
      // same number belongs to that question's body rather than opening a
      // duplicate top-level block.
      if (cur?.startedFromBare && cur.questionNo === q[1]) {
        cur.promptLines.push(line);
        cur.imagePaths.push(...imagePaths);
        continue;
      }
      // Section counters / nested decimal lists must not create phantom Q1/Q2
      // after Q30. Keep their text, flag the ambiguity instead of discarding it.
      if (cur && Number(q[1]) <= Number(cur.questionNo)) {
        warnings.push(
          `题号 ${q[1]} 重复或倒序，正文保留在第 ${cur.questionNo} 题，请对照原卷确认。`,
        );
        cur.promptLines.push(line);
        cur.imagePaths.push(...imagePaths);
        continue;
      }
      const firstLine = q[2];
      if (COMPACT_NUMERIC_LEADING.test(line)) {
        const supported = hasNumericQuestionContext(
          lines,
          lineIndex,
          cur?.questionNo ?? null,
          q[1],
        );
        warnings.push(
          `第 ${q[1]} 题候选以数字开头，${supported ? '按相邻题号或选项暂时切分' : '边界证据不足，原行保留在正文或来源中'}，请对照原卷确认。`,
        );
        if (!supported) {
          if (cur) {
            cur.promptLines.push(line);
            cur.imagePaths.push(...imagePaths);
          }
          continue;
        }
      }
      if (!firstLine && !isBareQuestionBoundary(lines, lineIndex, cur?.questionNo ?? null, q[1])) {
        if (cur) {
          cur.promptLines.push(line);
          cur.imagePaths.push(...imagePaths);
        }
        continue;
      }
      if (cur) drafts.push(cur);
      // q[2] is undefined for a bare `N\.` line (prompt lives on the next line);
      // start with no prompt line so the following line(s) fill it via the
      // non-question fall-through below.
      cur = {
        questionNo: q[1],
        startedFromBare: !firstLine,
        promptLines: firstLine ? [firstLine] : [],
        options: [],
        imagePaths,
      };
      continue;
    }
    // Before the first question: header region — drop images, ignore prose.
    if (!cur) continue;
    // Collect every image even on a question/option line, without dropping the
    // text before, between or after the figures.
    cur.imagePaths.push(...imagePaths);

    const opt = OPTION_LINE.exec(line);
    if (opt) {
      for (const part of line.trim().split(/\s+(?=[A-D]\\?[.．、])/)) {
        const option = OPTION_LINE.exec(part);
        if (option) cur.options.push({ label: option[1], text: option[2].trim() });
      }
      continue;
    }
    if (line.trim().length > 0) cur.promptLines.push(line);
  }
  if (cur) drafts.push(cur);

  let previous = 0;
  for (const draft of drafts) {
    const number = Number(draft.questionNo);
    if (draft.imagePaths.length > 0) {
      warnings.push(
        `第 ${draft.questionNo} 题的图片按 DOCX 文本锚点暂存，题目归属须对照原卷确认。`,
      );
    }
    if (number > previous + 1) {
      warnings.push(`题号 ${previous + 1} 至 ${number - 1} 未独立提取，请对照原卷确认。`);
    }
    if (!draft.promptLines.join('').trim()) {
      warnings.push(`第 ${draft.questionNo} 题缺少可提取的题干，请对照原卷确认。`);
      if (new Set(draft.imagePaths).size > 1) {
        // Two image-only questions can share one Word drawing anchor, whose XML
        // order need not match page order. Retain media on the source document;
        // do not claim both images belong to this one question.
        warnings.push(`第 ${draft.questionNo} 题附近多张图片的题目归属不明，请对照原卷确认。`);
        draft.imagePaths = [];
      }
    }
    previous = number;
  }
  return {
    blocks: drafts.map((d) => ({
      structured: finalize(d),
      imagePaths: [...new Set(d.imagePaths)],
    })),
    warnings,
  };
}
