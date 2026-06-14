// ADR-0032 D6-R6 / D6-draftread — pure unit for the addressable-structure
// projection (read≡write coordinate fix). No DB / IO → src/core/** unit glob.

import { describe, expect, it } from 'vitest';

import {
  type FigureRefT,
  type StructuredQuestionT,
  projectAddressableNode,
  projectAddressableStructure,
} from './structured_question';

const bbox = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };

function stemTree(): StructuredQuestionT {
  return {
    id: 'stem_1',
    role: 'stem',
    prompt_text: '阅读下面文段，回答问题。',
    bbox,
    page_index: 0,
    source: 'vlm_structure',
    last_modified_by: 'agent:ingestion_block_edit',
    extraction_evidence: { handwriting: [{ text: '甲', bbox }] },
    sub_questions: [
      {
        id: 'sub_1',
        role: 'sub',
        question_no: '1',
        prompt_text: '解释加点字。',
        options: [
          { label: 'A', text: '之一' },
          { label: 'B', text: '之二' },
        ],
        answers: ['A'],
        analysis: '考查实词。',
        kind: 'choice',
        bbox,
        page_index: 1,
        extraction_evidence: { tencent_grading: { IsCorrect: true, RightAnswer: 'A' } },
      },
    ],
  };
}

describe('projectAddressableNode', () => {
  it('keeps id/role/sub_questions + readable fields, drops extraction-period coords', () => {
    const node = projectAddressableNode(stemTree());
    expect(node).toEqual({
      id: 'stem_1',
      role: 'stem',
      prompt_text: '阅读下面文段，回答问题。',
      sub_questions: [
        {
          id: 'sub_1',
          role: 'sub',
          question_no: '1',
          prompt_text: '解释加点字。',
          options: [
            { label: 'A', text: '之一' },
            { label: 'B', text: '之二' },
          ],
          answers: ['A'],
          analysis: '考查实词。',
          kind: 'choice',
        },
      ],
    });
    // Addressing coords / extraction evidence must NOT leak.
    expect(node).not.toHaveProperty('bbox');
    expect(node).not.toHaveProperty('page_index');
    expect(node).not.toHaveProperty('extraction_evidence');
    expect(node).not.toHaveProperty('source');
    expect(node).not.toHaveProperty('last_modified_by');
    expect(node.sub_questions?.[0]).not.toHaveProperty('bbox');
    expect(node.sub_questions?.[0]).not.toHaveProperty('extraction_evidence');
  });

  it('omits optional fields that are absent (no undefined keys)', () => {
    const node = projectAddressableNode({
      id: 'q_1',
      role: 'standalone',
      prompt_text: '默写。',
    });
    expect(node).toEqual({ id: 'q_1', role: 'standalone', prompt_text: '默写。' });
    expect(Object.keys(node).sort()).toEqual(['id', 'prompt_text', 'role']);
  });
});

describe('projectAddressableStructure', () => {
  it('projects figures to the addressing triple only (drops bbox/page/confidence)', () => {
    const figures: FigureRefT[] = [
      {
        asset_id: 'asset_a',
        role: 'diagram',
        source_page_index: 2,
        source_bbox: bbox,
        attached_to_index: 'sub_1',
        attach_confidence: 'high',
      },
    ];
    const out = projectAddressableStructure(stemTree(), figures);
    expect(out.tree.id).toBe('stem_1');
    expect(out.figures).toEqual([
      { asset_id: 'asset_a', role: 'diagram', attached_to_index: 'sub_1' },
    ]);
    const fig = out.figures[0] as unknown as Record<string, unknown>;
    expect(fig).not.toHaveProperty('source_bbox');
    expect(fig).not.toHaveProperty('source_page_index');
    expect(fig).not.toHaveProperty('attach_confidence');
  });

  it('defaults figures to empty array', () => {
    const out = projectAddressableStructure({
      id: 'q_1',
      role: 'standalone',
      prompt_text: 'x',
    });
    expect(out.figures).toEqual([]);
  });
});
