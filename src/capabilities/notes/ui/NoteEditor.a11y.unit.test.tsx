// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoteEditor } from './NoteEditor';
import type { BodyBlock, SemanticKind } from './notes-api';

afterEach(cleanup);

function block(
  id: string,
  text: string,
  semanticKind: Exclude<SemanticKind, 'check'> = 'definition',
): BodyBlock {
  return {
    type: 'semanticBlock',
    attrs: {
      id,
      semantic_kind: semanticKind,
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
  it('names every editable block by its current order and semantic type', () => {
    const initialBlocks = [block('one', '第一块', 'definition'), block('two', '第二块', 'example')];
    const { rerender } = render(
      <NoteEditor blocks={initialBlocks} labels={[]} noteId="note_1" onChange={vi.fn()} />,
    );

    expect(screen.getByRole('textbox', { name: '第 1 块「定义」内容' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '第 2 块「例子」内容' })).toBeTruthy();

    const inserted = block('inserted', '插入块', 'pitfall');
    rerender(
      <NoteEditor
        blocks={[inserted, ...initialBlocks]}
        labels={[]}
        noteId="note_1"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('textbox', { name: '第 1 块「易错点」内容' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '第 2 块「定义」内容' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '第 3 块「例子」内容' })).toBeTruthy();

    rerender(
      <NoteEditor
        blocks={[initialBlocks[1], initialBlocks[0]]}
        labels={[]}
        noteId="note_1"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('textbox', { name: '第 1 块「例子」内容' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '第 2 块「定义」内容' })).toBeTruthy();
  });

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
