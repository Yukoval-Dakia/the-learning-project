import { createId } from '@paralleldrive/cuid2';

import type { BBoxT, StructuredQuestionT } from '@/core/schema/structured_question';

import type { GlmLayoutBlock, GlmLayoutResponse } from './glm_ocr';
import type { LayoutQuality, ParsedFigureBox } from './tencent_mark_parser';

/**
 * Parser for GLM-OCR `layout_parsing` response → the SAME downstream contract the
 * handler already consumes from Tencent (YUK-253). The VLM `StructureTask` layer,
 * the fallback path, and the figure crop/attach pipeline are all untouched —
 * GLM swaps only the per-page OCR engine.
 *
 * GLM gives 4-number ABSOLUTE px `bbox_2d: [x1,y1,x2,y2]`; this is the GLM
 * analogue of the Tencent `flat8ToBBox` (which hard-asserts 8 numbers and is
 * therefore not reusable here). `glmBBox` emits the identical 0-1 normalized
 * `BBoxT` shape `cropAndUploadFigures` expects.
 */

export type GlmParsedPage = {
  page_index: number;
  /** Page text blocks' content, in `index` order, joined with `\n\n`. */
  hintMarkdown: string;
  /** Per-block geometry retained for 题级 bbox union (see bboxUnion + §note). */
  blocks: Array<{ index: number; bbox: BBoxT; label: string; content: string }>;
  /** Image-label blocks → figures (fed to the unchanged cropAndUploadFigures). */
  figures: ParsedFigureBox[];
};

export type GlmParseResult = {
  pages: GlmParsedPage[];
  layout_quality: LayoutQuality;
  warnings: string[];
};

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/**
 * `[x1,y1,x2,y2]` absolute px → 0-1 normalized BBoxT. GLM analogue of
 * `flat8ToBBox`. Clamps so the BBox schema's `x+width<=1` / `y+height<=1`
 * refinements always hold.
 */
export function glmBBox(b: [number, number, number, number], w: number, h: number): BBoxT {
  const [x1, y1, x2, y2] = b;
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  const x = clamp01(minX / w);
  const y = clamp01(minY / h);
  return {
    x,
    y,
    // Clamp width/height to the remaining space so the refinement holds even if
    // a block bbox grazes the page edge by a pixel.
    width: clamp01(Math.min((maxX - minX) / w, 1 - x)),
    height: clamp01(Math.min((maxY - minY) / h, 1 - y)),
  };
}

/**
 * Union of member-block bboxes → one enclosing BBoxT.
 *
 * PHASE-DEFERRED (YUK-253): this is the 题级 bbox 并集 machinery the locked
 * decision asks for. It is NOT wired into `page_spans` this lane — current
 * `applyExtractionResult` writes a full-page `{0,0,1,1}` bbox (ADR-0002) and
 * does not consume a per-question bbox; wiring it would change block-model
 * semantics ("分层语义不许动"). Staged here + retained per-block bbox so the
 * machinery exists for when ADR-0002's full-page-bbox constraint is relaxed.
 * See the §8 follow-up issue "题级 bbox into page_spans".
 */
export function bboxUnion(boxes: BBoxT[]): BBoxT {
  if (boxes.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return {
    x: clamp01(minX),
    y: clamp01(minY),
    width: clamp01(maxX - minX),
    height: clamp01(maxY - minY),
  };
}

function isTextBlockWithContent(
  block: GlmLayoutBlock,
): block is GlmLayoutBlock & { content: string } {
  // Image-label blocks omit `content` entirely (verified against both real
  // fixtures). Filter to text blocks that actually carry markdown.
  return (
    block.label !== 'image' && typeof block.content === 'string' && block.content.trim() !== ''
  );
}

export function deriveGlmLayoutQuality(pages: GlmParsedPage[]): {
  layout_quality: LayoutQuality;
  warnings: string[];
} {
  const pagesWithText = pages.filter((p) => p.blocks.length > 0).length;
  if (pages.length === 0 || pagesWithText === 0) {
    return {
      layout_quality: 'partial',
      warnings: ['GLM returned no text blocks on any page'],
    };
  }
  if (pagesWithText < pages.length) {
    return {
      layout_quality: 'text_only',
      warnings: ['GLM: at least one page has only image/empty blocks'],
    };
  }
  return { layout_quality: 'structured', warnings: [] };
}

/**
 * Parse the GLM layout_parsing response into per-page hints + figures + blocks.
 *
 * @param pageIndexBase 0-based offset for the first page's page_index (default 0).
 */
export function parseGlmLayoutResponse(resp: GlmLayoutResponse, pageIndexBase = 0): GlmParseResult {
  const pages: GlmParsedPage[] = [];
  const warnings: string[] = [];

  const pageDims = resp.data_info?.pages ?? [];

  resp.layout_details.forEach((blocks, i) => {
    const pageIndex = pageIndexBase + i;
    // Page dims from data_info (authoritative); block width/height are redundant
    // fallbacks if data_info is short.
    const dims = pageDims[i] ?? { width: blocks[0]?.width ?? 0, height: blocks[0]?.height ?? 0 };
    const pageWidth = dims.width || blocks[0]?.width || 1;
    const pageHeight = dims.height || blocks[0]?.height || 1;

    const sorted = [...blocks].sort((a, b) => a.index - b.index);

    const hintParts: string[] = [];
    const pageBlocks: GlmParsedPage['blocks'] = [];
    const figures: ParsedFigureBox[] = [];

    for (const block of sorted) {
      const bbox = glmBBox(block.bbox_2d, pageWidth, pageHeight);
      if (block.label === 'image') {
        if (block.native_label === 'header_image') {
          continue;
        }
        // image-label blocks (native_label image) → figures.
        figures.push({ bbox, source_page_index: pageIndex });
        continue;
      }
      if (isTextBlockWithContent(block)) {
        const content = block.content;
        hintParts.push(content); // LaTeX (\frac) kept verbatim — delimiter-agnostic downstream.
        pageBlocks.push({ index: block.index, bbox, label: block.label, content });
      }
    }

    pages.push({
      page_index: pageIndex,
      hintMarkdown: hintParts.join('\n\n'),
      blocks: pageBlocks,
      figures,
    });
  });

  // layout_quality heuristic:
  //   'structured' if every page has ≥1 text block,
  //   'text_only'  if any page yielded only image/empty blocks,
  //   'partial'    otherwise (no page has text at all).
  const quality = deriveGlmLayoutQuality(pages);
  warnings.push(...quality.warnings);

  return { pages, layout_quality: quality.layout_quality, warnings };
}

/**
 * Render the GLM per-page hints as a flat text hint for the VLM. Thin analogue of
 * `renderTencentHint` — each page prefixed `=== page K ===` then its hintMarkdown.
 * Advisory text only; the VLM owns the structure of record. Avoids synthesizing
 * fake questions (RunStructureTaskParams.tencentHintMd is a plain string).
 */
export function renderGlmHint(pages: GlmParsedPage[]): string {
  const parts: string[] = [];
  for (const page of pages) {
    parts.push(`=== page ${page.page_index} ===`);
    if (page.hintMarkdown.length === 0) {
      parts.push('(GLM 未识别出文本)');
      continue;
    }
    parts.push(page.hintMarkdown);
  }
  return parts.join('\n\n');
}

/**
 * Build the GLM fallback question tree (analogue of the Tencent fallback). GLM's
 * parser does NOT produce a question tree (no MarkAgent-style splitting — the VLM
 * owns splitting). So the fallback degrades to ONE `standalone` question per page
 * from the page's hintMarkdown, stamped `source: 'glm_ocr'`. This guarantees
 * extraction never hard-fails on a VLM outage (regression-safety parity with the
 * Tencent fallback) while being honest that GLM-without-VLM has no real splitting.
 */
export function buildGlmFallbackQuestions(result: GlmParseResult): {
  questions: StructuredQuestionT[];
  warnings: string[];
} {
  const questions: StructuredQuestionT[] = [];
  for (const page of result.pages) {
    if (page.hintMarkdown.length === 0) continue;
    questions.push({
      id: createId(),
      role: 'standalone',
      prompt_text: page.hintMarkdown,
      page_index: page.page_index,
      source: 'glm_ocr',
    });
  }
  const warnings = ['GLM fallback: page-level standalone, no sub-question split'];
  return { questions, warnings };
}
