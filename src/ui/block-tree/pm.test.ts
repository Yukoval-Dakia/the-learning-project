import { describe, expect, it } from 'vitest';

import {
  markdownToBodyBlocks,
  mergeAdjacentSemanticBlocks,
  paragraphNode,
  reorderTopLevelBlock,
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

const threeBlockFixture = {
  type: 'doc' as const,
  content: [
    semanticBlockNode({ id: 'b1', semantic_kind: 'definition' }, [paragraphNode('one')]),
    semanticBlockNode({ id: 'b2', semantic_kind: 'example' }, [paragraphNode('two')]),
    semanticBlockNode({ id: 'b3', semantic_kind: 'pitfall' }, [paragraphNode('three')]),
  ],
};

function ids(doc: { content: Array<{ attrs?: { id?: unknown } }> }): string[] {
  return doc.content.map((node) => String(node.attrs?.id));
}

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

  it('reorder moves a block without changing any block_id (ADR-0022 stability)', () => {
    const moved = reorderTopLevelBlock(threeBlockFixture, 0, 2);
    // Order changed: first block now last.
    expect(ids(moved)).toEqual(['b2', 'b3', 'b1']);
    // Same multiset of ids — reorder never mints or drops an id.
    expect([...ids(moved)].sort()).toEqual(['b1', 'b2', 'b3']);
    // The moved block kept its identity (id + content) intact.
    const movedBlock = moved.content[2] as { attrs?: { id?: string }; content?: unknown };
    expect(movedBlock.attrs?.id).toBe('b1');
    expect(JSON.stringify(movedBlock)).toContain('one');
  });

  it('reorder is a no-op for same / out-of-range indices', () => {
    expect(ids(reorderTopLevelBlock(threeBlockFixture, 1, 1))).toEqual(['b1', 'b2', 'b3']);
    expect(ids(reorderTopLevelBlock(threeBlockFixture, -1, 2))).toEqual(['b1', 'b2', 'b3']);
    expect(ids(reorderTopLevelBlock(threeBlockFixture, 0, 9))).toEqual(['b1', 'b2', 'b3']);
  });

  it('keeps a mark_wrong projection anchored after reorder (block_id, not position)', () => {
    const markWrongBlocks = { b1: { state: 'marked_wrong' } };
    const moved = reorderTopLevelBlock(threeBlockFixture, 0, 2);
    // b1 is now at index 2, but the projection still resolves by id.
    const last = moved.content[2] as { attrs?: { id?: string } };
    expect(markWrongBlocks[String(last.attrs?.id) as 'b1']).toMatchObject({
      state: 'marked_wrong',
    });
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
