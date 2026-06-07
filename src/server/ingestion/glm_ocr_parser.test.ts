import { describe, expect, it } from 'vitest';

import mathPage1 from '../../../tests/fixtures/glm-ocr/math-page1.json';
import yuwen8page from '../../../tests/fixtures/glm-ocr/yuwen-8page.json';
import type { GlmLayoutResponse } from './glm_ocr';
import {
  bboxUnion,
  buildGlmFallbackQuestions,
  glmBBox,
  parseGlmLayoutResponse,
  renderGlmHint,
} from './glm_ocr_parser';

// YUK-253 — GLM-OCR parser. Pure no-DB unit, run against the REAL fixtures
// (math-page1 = 1 page / 10 blocks incl. 2 image; yuwen = 8 pages, each with an
// image block). Covers block→hint markdown, glmBBox normalization, image→figure,
// bboxUnion, multi-page page_index stamping, and the keyless-image-block guard.

const math = mathPage1 as unknown as GlmLayoutResponse;
const yuwen = yuwen8page as unknown as GlmLayoutResponse;

describe('glmBBox', () => {
  it('normalizes [x1,y1,x2,y2] absolute px → 0-1 BBoxT', () => {
    const bbox = glmBBox([312, 179, 926, 219], 1241, 1754);
    expect(bbox.x).toBeCloseTo(312 / 1241);
    expect(bbox.y).toBeCloseTo(179 / 1754);
    expect(bbox.width).toBeCloseTo((926 - 312) / 1241);
    expect(bbox.height).toBeCloseTo((219 - 179) / 1754);
  });

  it('keeps x+width<=1 and y+height<=1 (BBox refinement holds)', () => {
    const bbox = glmBBox([0, 0, 1241, 1754], 1241, 1754);
    expect(bbox.x + bbox.width).toBeLessThanOrEqual(1);
    expect(bbox.y + bbox.height).toBeLessThanOrEqual(1);
  });

  it('handles reversed coords (min/max) and clamps out-of-range', () => {
    const bbox = glmBBox([926, 219, 312, 179], 1241, 1754);
    expect(bbox.x).toBeCloseTo(312 / 1241);
    expect(bbox.width).toBeCloseTo((926 - 312) / 1241);
  });
});

describe('bboxUnion', () => {
  it('encloses all member bboxes', () => {
    const a = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };
    const b = { x: 0.5, y: 0.5, width: 0.2, height: 0.2 };
    const u = bboxUnion([a, b]);
    expect(u.x).toBeCloseTo(0.1);
    expect(u.y).toBeCloseTo(0.1);
    expect(u.x + u.width).toBeCloseTo(0.7);
    expect(u.y + u.height).toBeCloseTo(0.7);
  });

  it('returns a zero box for an empty list', () => {
    expect(bboxUnion([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('parseGlmLayoutResponse — math-page1 (real fixture)', () => {
  const result = parseGlmLayoutResponse(math);

  it('produces one page with page_index 0', () => {
    expect(result.pages.length).toBe(1);
    expect(result.pages[0].page_index).toBe(0);
  });

  it('joins only the 8 text blocks into hintMarkdown (image blocks skipped)', () => {
    const page = result.pages[0];
    // 8 text blocks in the fixture → 8 retained block entries.
    expect(page.blocks.length).toBe(8);
    // The doc title (idx 1) appears in the hint.
    expect(page.hintMarkdown).toContain('2025学年第二学期高一基础知识调测试卷');
  });

  it('keeps LaTeX content verbatim (GLM \\frac, $...$)', () => {
    const page = result.pages[0];
    expect(page.hintMarkdown).toContain('$');
    expect(page.hintMarkdown).toContain('frac');
  });

  it('maps the 2 image blocks (idx 0/9, no content key) to figures without throwing', () => {
    const page = result.pages[0];
    // CRITIC-ADDED (g): image blocks omit `content` entirely; they must be
    // routed to figures and skipped in the hint join with no undefined/throw.
    expect(page.figures.length).toBe(2);
    expect(page.hintMarkdown).not.toContain('undefined');
    // header_image (idx 0) bbox [108,91,373,135] normalized against 1241x1754.
    const fig0 = page.figures[0];
    expect(fig0.source_page_index).toBe(0);
    expect(fig0.bbox.x).toBeCloseTo(108 / 1241);
    expect(fig0.bbox.y).toBeCloseTo(91 / 1754);
  });

  it('reports layout_quality structured (page has text blocks)', () => {
    expect(result.layout_quality).toBe('structured');
  });
});

describe('parseGlmLayoutResponse — yuwen-8page (real multi-page fixture)', () => {
  const result = parseGlmLayoutResponse(yuwen);

  it('stamps sequential page_index 0..7', () => {
    expect(result.pages.length).toBe(8);
    expect(result.pages.map((p) => p.page_index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('routes all 8 image blocks (no content key) to figures, none throw', () => {
    const totalFigures = result.pages.reduce((n, p) => n + p.figures.length, 0);
    expect(totalFigures).toBe(8);
    for (const p of result.pages) {
      expect(p.hintMarkdown).not.toContain('undefined');
    }
  });

  it('honors pageIndexBase offset', () => {
    const offset = parseGlmLayoutResponse(yuwen, 10);
    expect(offset.pages[0].page_index).toBe(10);
    expect(offset.pages[7].page_index).toBe(17);
  });

  it('reports structured when every page has ≥1 text block', () => {
    expect(result.layout_quality).toBe('structured');
  });
});

describe('parseGlmLayoutResponse — layout_quality heuristics (synthetic)', () => {
  function page(blocks: GlmLayoutResponse['layout_details'][number]) {
    return blocks;
  }

  it('text_only when a page has only image/empty blocks', () => {
    const resp: GlmLayoutResponse = {
      id: 'x',
      request_id: 'x',
      data_info: {
        num_pages: 2,
        pages: [
          { width: 100, height: 100 },
          { width: 100, height: 100 },
        ],
      },
      layout_details: [
        page([
          {
            index: 0,
            label: 'text',
            native_label: 'paragraph',
            bbox_2d: [0, 0, 10, 10],
            content: 'hi',
            width: 100,
            height: 100,
          },
        ]),
        // image-only page (block omits content key entirely).
        page([
          {
            index: 0,
            label: 'image',
            native_label: 'image',
            bbox_2d: [0, 0, 10, 10],
            width: 100,
            height: 100,
          } as GlmLayoutResponse['layout_details'][number][number],
        ]),
      ],
      md_results: '',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    const result = parseGlmLayoutResponse(resp);
    expect(result.layout_quality).toBe('text_only');
  });

  it('partial when no page has any text block', () => {
    const resp: GlmLayoutResponse = {
      id: 'x',
      request_id: 'x',
      data_info: { num_pages: 1, pages: [{ width: 100, height: 100 }] },
      layout_details: [
        [
          {
            index: 0,
            label: 'image',
            native_label: 'image',
            bbox_2d: [0, 0, 10, 10],
            width: 100,
            height: 100,
          } as GlmLayoutResponse['layout_details'][number][number],
        ],
      ],
      md_results: '',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    const result = parseGlmLayoutResponse(resp);
    expect(result.layout_quality).toBe('partial');
  });
});

describe('renderGlmHint', () => {
  it('prefixes each page with === page K === and joins hintMarkdown', () => {
    const result = parseGlmLayoutResponse(math);
    const hint = renderGlmHint(result.pages);
    expect(hint).toContain('=== page 0 ===');
    expect(hint).toContain('2025学年第二学期高一基础知识调测试卷');
  });
});

describe('buildGlmFallbackQuestions', () => {
  it('emits one standalone glm_ocr question per page with hint, page_index stamped', () => {
    const result = parseGlmLayoutResponse(yuwen);
    const { questions, warnings } = buildGlmFallbackQuestions(result);
    // Every yuwen page has text → 8 fallback questions.
    expect(questions.length).toBe(8);
    for (const q of questions) {
      expect(q.role).toBe('standalone');
      expect(q.source).toBe('glm_ocr');
      expect(typeof q.page_index).toBe('number');
      expect(q.prompt_text.length).toBeGreaterThan(0);
    }
    expect(warnings[0]).toContain('page-level standalone');
  });
});
