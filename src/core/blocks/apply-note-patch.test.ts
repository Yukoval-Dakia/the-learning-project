import { describe, expect, it } from 'vitest';

import { NoteRefineApplyError, applyNotePatch } from '@/core/blocks/apply-note-patch';
import type { NotePatchT } from '@/core/schema/note-patch';

function paragraph(id: string, text: string): Record<string, unknown> {
  return {
    type: 'paragraph',
    attrs: { id },
    content: [{ type: 'text', text }],
  };
}

function doc(...nodes: Record<string, unknown>[]) {
  return { type: 'doc', content: nodes };
}

describe('applyNotePatch — pure ops', () => {
  it('returns the original doc unchanged when patch.ops is empty', () => {
    const before = doc(paragraph('b1', 'hi'), paragraph('b2', 'bye'));
    const after = applyNotePatch(before, { ops: [] });
    expect(after).toEqual(before);
  });

  it('insert_after splices a new block right after the target', () => {
    const before = doc(paragraph('b1', 'first'), paragraph('b2', 'second'));
    const patch: NotePatchT = {
      ops: [
        {
          kind: 'insert_after',
          target_block_id: 'b1',
          block: paragraph('b1a', 'middle'),
        },
      ],
    };
    const after = applyNotePatch(before, patch);
    expect(after.content.map((n) => (n.attrs as { id: string }).id)).toEqual(['b1', 'b1a', 'b2']);
  });

  it('insert_after at the tail still appends correctly', () => {
    const before = doc(paragraph('b1', 'only'));
    const after = applyNotePatch(before, {
      ops: [{ kind: 'insert_after', target_block_id: 'b1', block: paragraph('b2', 'next') }],
    });
    expect(after.content.map((n) => (n.attrs as { id: string }).id)).toEqual(['b1', 'b2']);
  });

  it('replace_block overwrites the target in place keeping its slot index', () => {
    const before = doc(paragraph('b1', 'old'), paragraph('b2', 'keep'));
    const after = applyNotePatch(before, {
      ops: [{ kind: 'replace_block', target_block_id: 'b1', block: paragraph('b1', 'new') }],
    });
    expect(after.content[0]).toMatchObject({ attrs: { id: 'b1' } });
    expect((after.content[0].content as { text: string }[])[0].text).toBe('new');
    expect((after.content[1].attrs as { id: string }).id).toBe('b2');
  });

  it('delete_block removes the target', () => {
    const before = doc(paragraph('b1', 'a'), paragraph('b2', 'b'), paragraph('b3', 'c'));
    const after = applyNotePatch(before, {
      ops: [{ kind: 'delete_block', target_block_id: 'b2' }],
    });
    expect(after.content.map((n) => (n.attrs as { id: string }).id)).toEqual(['b1', 'b3']);
  });

  it('append_block appends to the doc tail', () => {
    const before = doc(paragraph('b1', 'a'));
    const after = applyNotePatch(before, {
      ops: [{ kind: 'append_block', block: paragraph('b9', 'tail') }],
    });
    expect(after.content.map((n) => (n.attrs as { id: string }).id)).toEqual(['b1', 'b9']);
  });

  it('applies ops left-to-right (sequencing matters)', () => {
    const before = doc(paragraph('b1', 'a'));
    const after = applyNotePatch(before, {
      ops: [
        { kind: 'append_block', block: paragraph('b2', 'b') },
        { kind: 'insert_after', target_block_id: 'b2', block: paragraph('b3', 'c') },
        { kind: 'delete_block', target_block_id: 'b1' },
      ],
    });
    expect(after.content.map((n) => (n.attrs as { id: string }).id)).toEqual(['b2', 'b3']);
  });

  it('throws NoteRefineApplyError(target_not_found) when insert_after target missing', () => {
    const before = doc(paragraph('b1', 'a'));
    expect(() =>
      applyNotePatch(before, {
        ops: [{ kind: 'insert_after', target_block_id: 'ghost', block: paragraph('x', 'x') }],
      }),
    ).toThrow(NoteRefineApplyError);
  });

  it('throws NoteRefineApplyError(target_not_found) when replace_block target missing', () => {
    const before = doc(paragraph('b1', 'a'));
    expect(() =>
      applyNotePatch(before, {
        ops: [{ kind: 'replace_block', target_block_id: 'ghost', block: paragraph('ghost', 'x') }],
      }),
    ).toThrow(/target_block_id "ghost" not found/);
  });

  it('throws NoteRefineApplyError(target_not_found) when delete_block target missing', () => {
    const before = doc(paragraph('b1', 'a'));
    expect(() =>
      applyNotePatch(before, {
        ops: [{ kind: 'delete_block', target_block_id: 'ghost' }],
      }),
    ).toThrow(/target_block_id "ghost" not found/);
  });

  it('throws NoteRefineApplyError(invalid_body_blocks) when input is not a valid doc', () => {
    expect(() => applyNotePatch({ not: 'a doc' }, { ops: [] })).toThrow(NoteRefineApplyError);
  });

  it('does not mutate the input doc (functional immutability)', () => {
    const before = doc(paragraph('b1', 'a'), paragraph('b2', 'b'));
    const snapshot = JSON.parse(JSON.stringify(before));
    applyNotePatch(before, {
      ops: [
        { kind: 'delete_block', target_block_id: 'b1' },
        { kind: 'append_block', block: paragraph('b9', 'x') },
      ],
    });
    expect(before).toEqual(snapshot);
  });
});
