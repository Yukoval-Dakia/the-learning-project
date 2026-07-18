// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoteEditor } from './NoteEditor';
import type { BodyBlock } from './notes-api';

afterEach(cleanup);

function block(id: string, text: string): BodyBlock {
  return {
    type: 'semanticBlock',
    attrs: {
      id,
      semantic_kind: 'definition',
      source_markdown: text,
    },
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

const blocks = [block('one', '第一块'), block('two', '第二块')];

function renderEditor(onChange = vi.fn(), value = blocks) {
  render(<NoteEditor blocks={value} labels={[]} noteId="note_1" onChange={onChange} />);
  return onChange;
}

describe('NoteEditor block controls', () => {
  it('moves the focused block with ArrowDown and prevents page scrolling', () => {
    const onChange = renderEditor();
    const grip = screen.getByRole('button', {
      name: '重排第 1 块（共 2 块）；用上下方向键移动',
    });

    expect(fireEvent.keyDown(grip, { key: 'ArrowDown' })).toBe(false);
    expect(onChange).toHaveBeenCalledWith([blocks[1], blocks[0]]);
    expect(grip.getAttribute('aria-keyshortcuts')).toBe('ArrowUp ArrowDown');
  });

  it('does not emit a reorder beyond the first-block boundary', () => {
    const onChange = renderEditor();
    const grip = screen.getByRole('button', {
      name: '重排第 1 块（共 2 块）；用上下方向键移动',
    });

    expect(fireEvent.keyDown(grip, { key: 'ArrowUp' })).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('names insert/delete actions by block and exposes the insert toggle state', () => {
    renderEditor();
    const insert = screen.getByRole('button', { name: '在第 1 块后插入块' });

    expect(insert.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(insert);
    expect(insert.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: '删除第 1 块' })).toBeTruthy();
  });

  it('disables the reorder affordance when the note has only one block', () => {
    renderEditor(vi.fn(), blocks.slice(0, 1));

    expect(
      screen.getByRole('button', { name: '第 1 块（共 1 块，无需重排）' }).hasAttribute('disabled'),
    ).toBe(true);
  });
});
