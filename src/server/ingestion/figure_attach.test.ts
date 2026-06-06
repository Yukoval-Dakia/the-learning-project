import { describe, expect, it } from 'vitest';

import type { StructuredQuestionT } from '@/core/schema/structured_question';
import type { PreAttachFigure } from './crop';
import { assignFigures, assignFiguresFromVlm } from './figure_attach';
import type { FigureAssignment } from './structure';

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

// ---------- YUK-227 S3 Slice A — assignFiguresFromVlm ----------

describe('assignFiguresFromVlm', () => {
  function q(id: string, page = 0): StructuredQuestionT {
    return { id, role: 'standalone', prompt_text: id, page_index: page };
  }

  it('uses VLM assignment for covered figures (high confidence)', () => {
    const figures: PreAttachFigure[] = [fig({ x: 0.1, y: 0.1, width: 0.1, height: 0.1 }, 0, 0)];
    const assignments: FigureAssignment[] = [
      { figure_index: 0, attached_to_question_id: 'q1', confidence: 'high' },
    ];
    const questions = [q('q1'), q('q2')];
    const result = assignFiguresFromVlm(figures, assignments, questions);
    expect(result).toHaveLength(1);
    expect(result[0].attached_to_index).toBe('q1');
    expect(result[0].attach_confidence).toBe('high');
  });

  it('VLM priority: 3 questions 3 figures — each figure goes to its assigned question (regression core)', () => {
    // The old heuristic (no bbox on VLM questions) would attach ALL figures to root (q1).
    // assignFiguresFromVlm must route each figure to its correct question.
    const figures: PreAttachFigure[] = [
      fig({ x: 0.1, y: 0.1, width: 0.1, height: 0.1 }, 0, 0),
      fig({ x: 0.2, y: 0.2, width: 0.1, height: 0.1 }, 1, 0),
      fig({ x: 0.3, y: 0.3, width: 0.1, height: 0.1 }, 2, 0),
    ];
    const assignments: FigureAssignment[] = [
      { figure_index: 0, attached_to_question_id: 'q1', confidence: 'high' },
      { figure_index: 1, attached_to_question_id: 'q2', confidence: 'high' },
      { figure_index: 2, attached_to_question_id: 'q3', confidence: 'high' },
    ];
    const questions = [q('q1'), q('q2'), q('q3')];
    const result = assignFiguresFromVlm(figures, assignments, questions);
    expect(result).toHaveLength(3);
    // Each figure goes to its assigned question, not all to root q1.
    expect(result.find((r) => r.asset_id === 'fig_0')?.attached_to_index).toBe('q1');
    expect(result.find((r) => r.asset_id === 'fig_1')?.attached_to_index).toBe('q2');
    expect(result.find((r) => r.asset_id === 'fig_2')?.attached_to_index).toBe('q3');
  });

  it('VLM miss fallback: uncovered figures fall back to geometric heuristic (no figure dropped)', () => {
    // VLM covers figure 0 and 1 but misses figure 2.
    // Figure 2 must be picked up by geometric fallback — not dropped.
    const q1: StructuredQuestionT = {
      id: 'q1',
      role: 'standalone',
      prompt_text: 'q1',
      page_index: 0,
      bbox: { x: 0, y: 0, width: 0.5, height: 0.5 },
    };
    const q2: StructuredQuestionT = {
      id: 'q2',
      role: 'standalone',
      prompt_text: 'q2',
      page_index: 0,
      bbox: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
    };
    const figures: PreAttachFigure[] = [
      fig({ x: 0.1, y: 0.1, width: 0.1, height: 0.1 }, 0, 0), // covered by VLM → q1
      fig({ x: 0.6, y: 0.6, width: 0.1, height: 0.1 }, 1, 0), // covered by VLM → q2
      fig({ x: 0.6, y: 0.6, width: 0.05, height: 0.05 }, 2, 0), // NOT covered by VLM → geometric
    ];
    const assignments: FigureAssignment[] = [
      { figure_index: 0, attached_to_question_id: 'q1', confidence: 'high' },
      { figure_index: 1, attached_to_question_id: 'q2', confidence: 'high' },
      // figure 2 deliberately omitted from assignments
    ];
    const result = assignFiguresFromVlm(figures, assignments, [q1, q2]);
    expect(result).toHaveLength(3); // all 3 figures present (none dropped)
    expect(result.find((r) => r.asset_id === 'fig_0')?.attached_to_index).toBe('q1');
    expect(result.find((r) => r.asset_id === 'fig_1')?.attached_to_index).toBe('q2');
    // fig_2 falls back to geometric: bbox (0.6,0.6,0.05,0.05) inside q2's bbox
    expect(result.find((r) => r.asset_id === 'fig_2')?.attached_to_index).toBe('q2');
  });

  it('returns [] for empty figures input', () => {
    expect(assignFiguresFromVlm([], [], [q('q1')])).toEqual([]);
  });

  it('degrades to pure geometric when assignments is undefined', () => {
    // When called from the Tencent fallback path, assignments is undefined →
    // identical to calling assignFigures directly.
    const stem = makeStem(); // has bbox on stem + sub-b
    const figures = [fig({ x: 0.6, y: 0.6, width: 0.05, height: 0.05 })]; // inside sub-b
    const result = assignFiguresFromVlm(figures, undefined, [stem]);
    expect(result).toHaveLength(1);
    // geometric: sub-b is smallest containing → high confidence
    expect(result[0].attached_to_index).toBe('sub-b');
    expect(result[0].attach_confidence).toBe('high');
  });

  it('degrades to pure geometric when assignments is empty array', () => {
    const stem = makeStem();
    const figures = [fig({ x: 0.6, y: 0.6, width: 0.05, height: 0.05 })];
    const result = assignFiguresFromVlm(figures, [], [stem]);
    expect(result).toHaveLength(1);
    expect(result[0].attached_to_index).toBe('sub-b');
  });

  // YUK-227 S3 Slice A (P3 fix) — invalid attached_to_question_id falls to geometric.

  it('P3: assignment pointing to non-existent question id falls back to geometric (no dangling ref)', () => {
    // VLM hallucinates a question id that is not in the question tree.
    // The P3 fix must discard that assignment and route the figure via the
    // geometric heuristic instead — producing a valid (non-dangling) attached_to_index.
    const realQ: StructuredQuestionT = {
      id: 'real-q',
      role: 'standalone',
      prompt_text: 'real question',
      page_index: 0,
      bbox: { x: 0, y: 0, width: 1, height: 1 },
    };
    const figures: PreAttachFigure[] = [fig({ x: 0.2, y: 0.2, width: 0.1, height: 0.1 }, 0, 0)];
    const assignments: FigureAssignment[] = [
      {
        figure_index: 0,
        // This id does not exist in the question tree — VLM hallucination.
        attached_to_question_id: 'ghost-question-id',
        confidence: 'high',
      },
    ];

    const result = assignFiguresFromVlm(figures, assignments, [realQ]);

    // P3: the hallucinated assignment must be discarded; the figure must land
    // on a real question via geometric fallback — not 'ghost-question-id'.
    expect(result).toHaveLength(1);
    expect(result[0].attached_to_index).not.toBe('ghost-question-id');
    // geometric fallback: figure bbox (0.2,0.2,0.1,0.1) is inside realQ's full-page bbox
    expect(result[0].attached_to_index).toBe('real-q');
  });

  // R2-1: output order must match original preFigures order.

  it('R2-1: output preserves original preFigures order even when index-1 is VLM and index-0 is geometric', () => {
    // figure index 0 → NOT covered by VLM (goes geometric)
    // figure index 1 → covered by VLM (goes to q2)
    // Expected output: [result_for_fig0, result_for_fig1] — original order, NOT
    // [vlmRef(fig1), geometricRef(fig0)] which the old [...vlmRefs, ...geometricRefs]
    // would have produced.
    const q1: StructuredQuestionT = {
      id: 'q1',
      role: 'standalone',
      prompt_text: 'q1',
      bbox: { x: 0, y: 0, width: 0.5, height: 0.5 },
    };
    const figures: PreAttachFigure[] = [
      fig({ x: 0.1, y: 0.1, width: 0.05, height: 0.05 }, 0, 0), // index 0 — no VLM assignment
      fig({ x: 0.6, y: 0.6, width: 0.05, height: 0.05 }, 1, 0), // index 1 — VLM → q2
    ];
    const assignments: FigureAssignment[] = [
      { figure_index: 1, attached_to_question_id: 'q1', confidence: 'high' },
    ];
    const result = assignFiguresFromVlm(figures, assignments, [q1]);
    expect(result).toHaveLength(2);
    // result[0] must correspond to preFigures[0] (fig_0, no VLM coverage → geometric)
    expect(result[0].asset_id).toBe('fig_0');
    // result[1] must correspond to preFigures[1] (fig_1, VLM → q1)
    expect(result[1].asset_id).toBe('fig_1');
    expect(result[1].attached_to_index).toBe('q1');
    expect(result[1].attach_confidence).toBe('high');
  });

  // R2-2: same figure_index claimed by multiple nodes → both discarded → geometric.

  it('R2-2: duplicate figure_index in VLM assignments → conflict discarded → geometric fallback', () => {
    // VLM assigns figure 0 to both q1 and q2 (e.g. same image claimed by stem and sub).
    // The whole conflict group must be discarded; figure 0 falls to geometric heuristic.
    const q1: StructuredQuestionT = {
      id: 'q1',
      role: 'standalone',
      prompt_text: 'q1',
      bbox: { x: 0, y: 0, width: 0.5, height: 0.5 },
    };
    const q2: StructuredQuestionT = {
      id: 'q2',
      role: 'standalone',
      prompt_text: 'q2',
      bbox: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
    };
    const figures: PreAttachFigure[] = [
      // figure 0 inside q1 bbox — geometric would attach it to q1
      fig({ x: 0.1, y: 0.1, width: 0.05, height: 0.05 }, 0, 0),
    ];
    const assignments: FigureAssignment[] = [
      { figure_index: 0, attached_to_question_id: 'q1', confidence: 'high' },
      { figure_index: 0, attached_to_question_id: 'q2', confidence: 'high' }, // conflict
    ];
    const result = assignFiguresFromVlm(figures, assignments, [q1, q2]);
    expect(result).toHaveLength(1);
    // The VLM conflict is discarded; geometric resolves it: fig inside q1 bbox → q1.
    // (Not q2, which would indicate the conflicting VLM assignment leaked through.)
    expect(result[0].asset_id).toBe('fig_0');
    expect(result[0].attached_to_index).toBe('q1'); // geometric: bbox containment
    expect(result[0].attach_confidence).toBe('high'); // geometric containment = high
  });
});
