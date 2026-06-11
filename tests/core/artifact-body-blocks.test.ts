import {
  artifactRefBlock,
  bodyBlocksHaveSemanticKinds,
  bodyBlocksToBlockSummaries,
  replaceNoteSectionBody,
  setNoteSectionEmbeddedCheckArtifactRef,
} from '@/capabilities/notes/server/body-blocks';
import { describe, expect, it } from 'vitest';

describe('body block helpers', () => {
  it('detects required semantic kinds from semantic blocks', () => {
    const bodyBlocks = {
      type: 'doc',
      content: [
        { type: 'semanticBlock', attrs: { id: 'b1', semantic_kind: 'definition' } },
        { type: 'semanticBlock', attrs: { id: 'b2', semantic_kind: 'mechanism' } },
        { type: 'semanticBlock', attrs: { id: 'b3', semantic_kind: 'example' } },
      ],
    };

    expect(bodyBlocksHaveSemanticKinds(bodyBlocks, ['definition', 'mechanism', 'example'])).toEqual(
      { ok: true, missing: [] },
    );
    expect(bodyBlocksHaveSemanticKinds(bodyBlocks, ['definition', 'pitfall', 'check'])).toEqual({
      ok: false,
      missing: ['pitfall', 'check'],
    });
  });

  it('ignores semantic_kind attrs outside top-level semantic blocks', () => {
    const bodyBlocks = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { semantic_kind: 'definition' },
          content: [
            {
              type: 'text',
              text: 'not a semantic block',
              attrs: { semantic_kind: 'mechanism' },
            },
          ],
        },
        {
          type: 'semanticBlock',
          attrs: { id: 'b1', semantic_kind: 'example' },
          content: [
            {
              type: 'paragraph',
              attrs: { semantic_kind: 'pitfall' },
              content: [{ type: 'text', text: '例子' }],
            },
          ],
        },
      ],
    };

    expect(bodyBlocksHaveSemanticKinds(bodyBlocks, ['definition', 'example', 'pitfall'])).toEqual({
      ok: false,
      missing: ['definition', 'pitfall'],
    });
  });

  it('creates artifact ref blocks with stable attrs', () => {
    expect(artifactRefBlock('quiz_1', 'tool_quiz', { id: 'ref_1' })).toEqual({
      type: 'artifactRefBlock',
      attrs: {
        id: 'ref_1',
        artifact_id: 'quiz_1',
        artifact_type: 'tool_quiz',
      },
      content: [],
    });
  });

  it('summarizes block ids, types, semantic kinds, and artifact refs', () => {
    const bodyBlocks = {
      type: 'doc',
      content: [
        {
          type: 'semanticBlock',
          attrs: { id: 'b1', semantic_kind: 'definition' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '核心定义' }] }],
        },
        artifactRefBlock('quiz_1', 'tool_quiz', { id: 'ref_1' }),
      ],
    };

    expect(bodyBlocksToBlockSummaries(bodyBlocks)).toEqual([
      {
        id: 'b1',
        type: 'semanticBlock',
        semantic_kind: 'definition',
        text_excerpt: '核心定义',
      },
      {
        id: 'ref_1',
        type: 'artifactRefBlock',
        target: { artifact_id: 'quiz_1', kind: 'tool_quiz' },
        text_excerpt: '',
      },
    ]);
  });

  it('adds a tool_quiz artifact ref while preserving embedded question ids', () => {
    const bodyBlocks = {
      type: 'doc',
      content: [
        {
          type: 'semanticBlock',
          attrs: { id: 'check_1', semantic_kind: 'check' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '自检' }] }],
        },
      ],
    };

    const updated = setNoteSectionEmbeddedCheckArtifactRef(bodyBlocks, 'check_1', 'quiz_1', [
      'q1',
      'q2',
    ]);

    expect(updated.content[0]?.attrs).toMatchObject({
      embedded_check: { question_ids: ['q1', 'q2'] },
    });
    const checkContent = updated.content[0]?.content as Array<unknown> | undefined;
    expect(checkContent?.[1]).toEqual({
      type: 'artifactRefBlock',
      attrs: {
        id: 'check_1_quiz_ref',
        artifact_id: 'quiz_1',
        artifact_type: 'tool_quiz',
      },
      content: [],
    });
  });

  it('preserves tool artifact refs when replacing section body text', () => {
    const bodyBlocks = {
      type: 'doc',
      content: [
        {
          type: 'semanticBlock',
          attrs: { id: 'check_1', semantic_kind: 'check', version: 1 },
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: '旧自检' }] },
            artifactRefBlock('quiz_1', 'tool_quiz', { id: 'check_1_quiz_ref' }),
          ],
        },
      ],
    };

    const updated = replaceNoteSectionBody(bodyBlocks, 'check_1', '新自检');
    const checkContent = updated.content[0]?.content as Array<unknown> | undefined;

    expect(updated.content[0]?.attrs).toMatchObject({
      version: 2,
      source_markdown: '新自检',
    });
    expect(checkContent?.[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: '新自检' }],
    });
    expect(checkContent?.[1]).toEqual(
      artifactRefBlock('quiz_1', 'tool_quiz', { id: 'check_1_quiz_ref' }),
    );
  });
});
