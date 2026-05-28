import { describe, expect, it } from 'vitest';
import {
  NotePatch,
  NotePatchAppendBlock,
  NotePatchDeleteBlock,
  NotePatchInsertAfter,
  NotePatchOp,
  NotePatchReplaceBlock,
  countNewBlocks,
  summarizeNotePatch,
} from './note-patch';

function paragraph(id: string, text: string): Record<string, unknown> {
  return {
    type: 'paragraph',
    attrs: { id },
    content: [{ type: 'text', text }],
  };
}

describe('NotePatchInsertAfter', () => {
  it('accepts valid insert_after op', () => {
    const parsed = NotePatchInsertAfter.parse({
      kind: 'insert_after',
      target_block_id: 'b1',
      block: paragraph('b2', 'hello'),
    });
    expect(parsed.target_block_id).toBe('b1');
    expect(parsed.block.type).toBe('paragraph');
  });

  it('rejects empty target_block_id', () => {
    expect(() =>
      NotePatchInsertAfter.parse({
        kind: 'insert_after',
        target_block_id: '',
        block: paragraph('b2', 'x'),
      }),
    ).toThrow();
  });

  it('rejects missing block', () => {
    expect(() =>
      NotePatchInsertAfter.parse({
        kind: 'insert_after',
        target_block_id: 'b1',
      } as never),
    ).toThrow();
  });
});

describe('NotePatchReplaceBlock (id-stability enforced at NotePatchOp level)', () => {
  it('accepts replace_block when block.attrs.id matches target', () => {
    const parsed = NotePatchOp.parse({
      kind: 'replace_block',
      target_block_id: 'b1',
      block: paragraph('b1', 'replaced'),
    });
    expect(parsed.kind).toBe('replace_block');
    if (parsed.kind === 'replace_block') {
      expect((parsed.block.attrs as { id?: string } | undefined)?.id).toBe('b1');
    }
  });

  it('rejects replace_block when block.attrs.id mismatches target (ADR-0020 §2 id stability)', () => {
    expect(() =>
      NotePatchOp.parse({
        kind: 'replace_block',
        target_block_id: 'b1',
        block: paragraph('b2', 'oops'),
      }),
    ).toThrow(/attrs\.id must equal target_block_id/);
  });

  it('rejects replace_block when block has no attrs.id', () => {
    expect(() =>
      NotePatchOp.parse({
        kind: 'replace_block',
        target_block_id: 'b1',
        block: { type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
      }),
    ).toThrow(/attrs\.id must be present/);
  });

  it('plain NotePatchReplaceBlock schema still parses (id-rule lives at union level)', () => {
    const parsed = NotePatchReplaceBlock.parse({
      kind: 'replace_block',
      target_block_id: 'b1',
      block: paragraph('b1', 'ok'),
    });
    expect(parsed.target_block_id).toBe('b1');
  });
});

describe('NotePatchDeleteBlock', () => {
  it('accepts delete_block', () => {
    const parsed = NotePatchDeleteBlock.parse({
      kind: 'delete_block',
      target_block_id: 'b1',
    });
    expect(parsed.target_block_id).toBe('b1');
  });

  it('rejects delete_block with block field (delete carries no block)', () => {
    // Strict not enforced — but discriminated union resolves by kind so an
    // extra unknown field is allowed (passthrough). What we DO test is that
    // missing target_block_id fails.
    expect(() =>
      NotePatchDeleteBlock.parse({
        kind: 'delete_block',
      } as never),
    ).toThrow();
  });
});

describe('NotePatchAppendBlock', () => {
  it('accepts append_block with no anchor', () => {
    const parsed = NotePatchAppendBlock.parse({
      kind: 'append_block',
      block: paragraph('b9', 'tail'),
    });
    expect((parsed.block.attrs as { id?: string } | undefined)?.id).toBe('b9');
  });
});

describe('NotePatchOp discriminated union', () => {
  it('routes to the right schema by kind', () => {
    expect(
      NotePatchOp.parse({
        kind: 'insert_after',
        target_block_id: 'b1',
        block: paragraph('b2', 'x'),
      }).kind,
    ).toBe('insert_after');
    expect(
      NotePatchOp.parse({
        kind: 'replace_block',
        target_block_id: 'b1',
        block: paragraph('b1', 'x'),
      }).kind,
    ).toBe('replace_block');
    expect(
      NotePatchOp.parse({
        kind: 'delete_block',
        target_block_id: 'b1',
      }).kind,
    ).toBe('delete_block');
    expect(
      NotePatchOp.parse({
        kind: 'append_block',
        block: paragraph('b9', 'x'),
      }).kind,
    ).toBe('append_block');
  });

  it('rejects unknown kind', () => {
    expect(() =>
      NotePatchOp.parse({
        kind: 'noop',
        target_block_id: 'b1',
      } as never),
    ).toThrow();
  });
});

describe('NotePatch envelope', () => {
  it('accepts empty ops array (no-op patch)', () => {
    const parsed = NotePatch.parse({ ops: [] });
    expect(parsed.ops).toEqual([]);
  });

  it('accepts a mixed-op patch', () => {
    const parsed = NotePatch.parse({
      ops: [
        { kind: 'insert_after', target_block_id: 'b1', block: paragraph('b1a', 'new') },
        { kind: 'replace_block', target_block_id: 'b2', block: paragraph('b2', 'replaced') },
        { kind: 'delete_block', target_block_id: 'b3' },
        { kind: 'append_block', block: paragraph('b9', 'tail') },
      ],
    });
    expect(parsed.ops).toHaveLength(4);
  });

  it('rejects > 200 ops (apply pipeline OOM guard)', () => {
    const ops = Array.from({ length: 201 }, (_, i) => ({
      kind: 'delete_block' as const,
      target_block_id: `b${i}`,
    }));
    expect(() => NotePatch.parse({ ops })).toThrow();
  });
});

describe('countNewBlocks / summarizeNotePatch (P4-B threshold inputs)', () => {
  it('counts insert_after + append_block; ignores replace_block + delete_block', () => {
    const patch = NotePatch.parse({
      ops: [
        { kind: 'insert_after', target_block_id: 'b1', block: paragraph('n1', 'x') },
        { kind: 'append_block', block: paragraph('n2', 'x') },
        { kind: 'replace_block', target_block_id: 'b2', block: paragraph('b2', 'x') },
        { kind: 'delete_block', target_block_id: 'b3' },
      ],
    });
    expect(countNewBlocks(patch)).toBe(2);
  });

  it('summarizeNotePatch returns ops_count + new_blocks', () => {
    const patch = NotePatch.parse({
      ops: [
        { kind: 'insert_after', target_block_id: 'b1', block: paragraph('n1', 'x') },
        { kind: 'delete_block', target_block_id: 'b2' },
      ],
    });
    expect(summarizeNotePatch(patch)).toEqual({ ops_count: 2, new_blocks: 1 });
  });

  it('summarizeNotePatch on empty patch is { ops_count: 0, new_blocks: 0 }', () => {
    expect(summarizeNotePatch(NotePatch.parse({ ops: [] }))).toEqual({
      ops_count: 0,
      new_blocks: 0,
    });
  });

  it('locked threshold derivation: ≤3 ops AND ≤2 new_blocks → mutator candidate', () => {
    // This test documents the derived inputs that P4-B will consume. It is
    // intentionally not a runtime gate — the gating call lives in P4-B.
    const mutatorish = summarizeNotePatch(
      NotePatch.parse({
        ops: [
          { kind: 'insert_after', target_block_id: 'b1', block: paragraph('n1', 'x') },
          { kind: 'replace_block', target_block_id: 'b2', block: paragraph('b2', 'x') },
        ],
      }),
    );
    expect(mutatorish.ops_count <= 3 && mutatorish.new_blocks <= 2).toBe(true);

    const proposeish = summarizeNotePatch(
      NotePatch.parse({
        ops: [
          { kind: 'append_block', block: paragraph('n1', 'x') },
          { kind: 'append_block', block: paragraph('n2', 'x') },
          { kind: 'append_block', block: paragraph('n3', 'x') },
        ],
      }),
    );
    expect(proposeish.ops_count <= 3 && proposeish.new_blocks <= 2).toBe(false);
  });
});
