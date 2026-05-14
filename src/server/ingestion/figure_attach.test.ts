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

function fig(bbox: { x: number; y: number; width: number; height: number }, idx = 0): PreAttachFigure {
  return {
    asset_id: `fig_${idx}`,
    role: 'diagram',
    source_page_index: 0,
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
        { id: 'sub-c', role: 'sub', prompt_text: 'c', bbox: { x: 0, y: 0, width: 0.1, height: 0.1 } },
        { id: 'sub-d', role: 'sub', prompt_text: 'd', bbox: { x: 0.9, y: 0.9, width: 0.05, height: 0.05 } },
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
});
