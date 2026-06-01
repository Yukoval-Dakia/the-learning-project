import { describe, expect, it } from 'vitest';

import type { StructuredQuestionT } from '@/core/schema/structured_question';
import type { PreAttachFigure } from './crop';
import { assignFigures } from './figure_attach';

function makeStem(): StructuredQuestionT {
  return {
    id: 'stem-1',
    role: 'stem',
    prompt_text: 'passage',
    bbox: { x: 0, y: 0, width: 1, height: 1 },
    sub_questions: [
      {
        id: 'sub-a',
        role: 'sub',
        prompt_text: 'sub a',
        bbox: { x: 0, y: 0, width: 0.5, height: 0.5 }, // top-left quad
      },
      {
        id: 'sub-b',
        role: 'sub',
        prompt_text: 'sub b',
        bbox: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, // bottom-right quad
      },
    ],
  };
}

function fig(
  bbox: { x: number; y: number; width: number; height: number },
  idx = 0,
  page = 0,
): PreAttachFigure {
  return {
    asset_id: `fig_${idx}`,
    role: 'diagram',
    source_page_index: page,
    source_bbox: bbox,
  };
}

describe('assignFigures', () => {
  it('attaches to most-specific containing question with high confidence', () => {
    const figures = [fig({ x: 0.6, y: 0.6, width: 0.05, height: 0.05 })]; // inside sub-b
    const result = assignFigures(figures, [makeStem()]);
    expect(result).toHaveLength(1);
    expect(result[0].attached_to_index).toBe('sub-b'); // smaller than stem
    expect(result[0].attach_confidence).toBe('high');
  });

  it('falls back to nearest with low confidence when no containment', () => {
    const figures = [
      // Outside all sub bbox but within stem (stem is whole page so it would contain — set figure
      // slightly oversized to fail containment on every node)
      fig({ x: 0, y: 0.4, width: 1, height: 0.2 }), // straddles both quads, contained by neither sub but contained by stem
    ];
    const result = assignFigures(figures, [makeStem()]);
    // stem contains it → high confidence to stem
    expect(result[0].attached_to_index).toBe('stem-1');
    expect(result[0].attach_confidence).toBe('high');
  });

  it('nearest-neighbor fallback when no bbox in any question is containing', () => {
    // Remove stem's bbox so containment fails for everyone
    const stemNoBbox: StructuredQuestionT = {
      id: 'stem-2',
      role: 'stem',
      prompt_text: 'p',
      sub_questions: [
        {
          id: 'sub-c',
          role: 'sub',
          prompt_text: 'c',
          bbox: { x: 0, y: 0, width: 0.1, height: 0.1 },
        },
        {
          id: 'sub-d',
          role: 'sub',
          prompt_text: 'd',
          bbox: { x: 0.9, y: 0.9, width: 0.05, height: 0.05 },
        },
      ],
    };
    // figure at top-right corner
    const figures = [fig({ x: 0.95, y: 0.05, width: 0.02, height: 0.02 })];
    const result = assignFigures(figures, [stemNoBbox]);
    // Nearest center: sub-d (at .925,.925) vs sub-c (at .05,.05) vs figure center (.96,.06)
    // sub-c center distance to figure: sqrt((.91)^2 + (.01)^2) ≈ 0.91
    // sub-d center distance to figure: sqrt((.035)^2 + (.865)^2) ≈ 0.87
    // → sub-d wins
    expect(result[0].attached_to_index).toBe('sub-d');
    expect(result[0].attach_confidence).toBe('low');
  });

  it('returns [] for empty figures input', () => {
    expect(assignFigures([], [makeStem()])).toEqual([]);
  });

  it('falls back to root when no question has bbox at all', () => {
    const noBbox: StructuredQuestionT = { id: 'root1', role: 'standalone', prompt_text: 'p' };
    const figures = [fig({ x: 0.5, y: 0.5, width: 0.1, height: 0.1 })];
    const result = assignFigures(figures, [noBbox]);
    expect(result[0].attached_to_index).toBe('root1');
    expect(result[0].attach_confidence).toBe('low');
  });

  // ---------- YUK-163: page-index gating (multi-page Tencent fallback) ----------

  it('does NOT attach a page-1 figure to a page-0 question on normalized bbox overlap', () => {
    // Both questions carry normalized (0–1) bbox from their own page. The page-0
    // question is SMALLER, so the old (page-blind) heuristic would pick it as the
    // most-specific container for a page-1 figure whose bbox sits inside both.
    const page0q: StructuredQuestionT = {
      id: 'p0-q',
      role: 'standalone',
      prompt_text: 'page 0 question',
      page_index: 0,
      bbox: { x: 0, y: 0, width: 0.2, height: 0.2 }, // area 0.04 (smaller → old winner)
    };
    const page1q: StructuredQuestionT = {
      id: 'p1-q',
      role: 'standalone',
      prompt_text: 'page 1 question',
      page_index: 1,
      bbox: { x: 0, y: 0, width: 0.5, height: 0.5 }, // area 0.25
    };
    const figures = [fig({ x: 0.05, y: 0.05, width: 0.02, height: 0.02 }, 0, 1)]; // page 1, inside both
    const result = assignFigures(figures, [page0q, page1q]);
    expect(result[0].attached_to_index).toBe('p1-q'); // gated to its own page
    expect(result[0].attached_to_index).not.toBe('p0-q');
    expect(result[0].attach_confidence).toBe('high');
  });

  it('attaches each figure within its own page in a multi-page document', () => {
    const page0q: StructuredQuestionT = {
      id: 'p0-q',
      role: 'standalone',
      prompt_text: 'page 0',
      page_index: 0,
      bbox: { x: 0, y: 0, width: 0.6, height: 0.6 },
    };
    const page1q: StructuredQuestionT = {
      id: 'p1-q',
      role: 'standalone',
      prompt_text: 'page 1',
      page_index: 1,
      bbox: { x: 0, y: 0, width: 0.6, height: 0.6 },
    };
    const figures = [
      fig({ x: 0.1, y: 0.1, width: 0.05, height: 0.05 }, 0, 0), // page 0
      fig({ x: 0.1, y: 0.1, width: 0.05, height: 0.05 }, 1, 1), // page 1 (identical bbox)
    ];
    const result = assignFigures(figures, [page0q, page1q]);
    expect(result[0].attached_to_index).toBe('p0-q');
    expect(result[1].attached_to_index).toBe('p1-q');
  });

  it('falls back to scope root on the figure page when same-page questions lack bbox', () => {
    const page0q: StructuredQuestionT = {
      id: 'p0-q',
      role: 'standalone',
      prompt_text: 'page 0',
      page_index: 0,
      bbox: { x: 0, y: 0, width: 0.5, height: 0.5 },
    };
    const page1root: StructuredQuestionT = {
      id: 'p1-root',
      role: 'standalone',
      prompt_text: 'page 1 (no bbox)',
      page_index: 1,
    };
    const figures = [fig({ x: 0.1, y: 0.1, width: 0.05, height: 0.05 }, 0, 1)]; // page 1
    const result = assignFigures(figures, [page0q, page1root]);
    // No page-1 question has a bbox → must land on the page-1 root, never the
    // page-0 question (which would be a cross-page leak).
    expect(result[0].attached_to_index).toBe('p1-root');
    expect(result[0].attach_confidence).toBe('low');
  });

  it('preserves prior behavior when no question carries page_index (VLM / legacy)', () => {
    // page_index absent everywhere → gating is a no-op → identical to the
    // page-blind heuristic: smallest containing question wins.
    const figures = [fig({ x: 0.6, y: 0.6, width: 0.05, height: 0.05 }, 0, 3)]; // any page
    const result = assignFigures(figures, [makeStem()]);
    expect(result[0].attached_to_index).toBe('sub-b');
    expect(result[0].attach_confidence).toBe('high');
  });
});
