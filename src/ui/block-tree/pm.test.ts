import { describe, expect, it } from 'vitest';

import {
  markdownToBodyBlocks,
  mergeAdjacentSemanticBlocks,
  paragraphNode,
  semanticBlockNode,
  splitSemanticBlockAtText,
} from './pm';

const fixture = {
  type: 'doc' as const,
  content: [
    semanticBlockNode(
      { id: 'b1', semantic_kind: 'definition', source_tier: 'llm_only', version: 3 },
      [paragraphNode('left and right')],
    ),
  ],
};

describe('block-tree PM helpers', () => {
  it('split preserves the left block id and mints the right block id', () => {
    const split = splitSemanticBlockAtText(fixture, 'b1', 'left', 'right', 'b2');

    expect(split.content).toHaveLength(2);
    expect(split.content[0]?.attrs).toMatchObject({ id: 'b1', version: 4 });
    expect(split.content[1]?.attrs).toMatchObject({
      id: 'b2',
      derived_from_block_id: 'b1',
      version: 0,
    });
  });

  it('merge keeps the previous block id and discards the merged-away id', () => {
    const split = splitSemanticBlockAtText(fixture, 'b1', 'left', 'right', 'b2');
    const merged = mergeAdjacentSemanticBlocks(split, 'b1', 'b2');

    expect(merged.content).toHaveLength(1);
    expect(merged.content[0]?.attrs).toMatchObject({ id: 'b1' });
    expect(JSON.stringify(merged)).not.toContain('b2');
  });

  it('keeps mark_wrong projection anchored to the original id after split', () => {
    const markWrongBlocks = { b1: { state: 'marked_wrong' } };
    const split = splitSemanticBlockAtText(fixture, 'b1', 'left', 'right', 'b2');
    const left = split.content[0] as { attrs?: { id?: string } } | undefined;
    const leftId = String(left?.attrs?.id);

    expect(markWrongBlocks[leftId as 'b1']).toMatchObject({ state: 'marked_wrong' });
  });

  it('converts pasted markdown into valid body_blocks and strips markdown-only syntax', () => {
    const doc = markdownToBodyBlocks('# Definition\n\n- example item', 'md');

    expect(doc.content).toHaveLength(2);
    expect(doc.content[0]?.attrs).toMatchObject({ id: 'md_1', semantic_kind: 'definition' });
    expect(JSON.stringify(doc)).toContain('Definition');
    expect(JSON.stringify(doc)).not.toContain('# Definition');
    expect(JSON.stringify(doc)).not.toContain('- example');
  });
});
