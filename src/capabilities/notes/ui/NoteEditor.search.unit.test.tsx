// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoteEditor } from './NoteEditor';
import { searchArtifacts } from './notes-api';
import type { BodyBlock } from './notes-api';

vi.mock('./notes-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./notes-api')>()),
  searchArtifacts: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.mocked(searchArtifacts).mockReset();
});

const blocks: BodyBlock[] = [
  {
    type: 'semanticBlock',
    attrs: {
      id: 'one',
      semantic_kind: 'definition',
      source_markdown: '第一块',
    },
    content: [{ type: 'paragraph', content: [{ type: 'text', text: '第一块' }] }],
  },
];

function openArtifactPicker() {
  render(<NoteEditor blocks={blocks} labels={[]} noteId="note_1" onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '在第 1 块后插入块' }));
  fireEvent.click(screen.getByRole('button', { name: /交叉链/ }));
  return screen.getByPlaceholderText('标题关键词…');
}

describe('NoteEditor artifact search', () => {
  it('keeps an aborted search silent', async () => {
    vi.mocked(searchArtifacts).mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    const input = openArtifactPicker();

    fireEvent.change(input, { target: { value: '二次' } });

    await waitFor(() => expect(screen.queryByText('正在搜索…')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: '重试搜索' })).toBeNull();
  });

  it('surfaces a failed search and lets the learner retry it', async () => {
    vi.mocked(searchArtifacts)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ rows: [{ id: 'note_2', title: '二次函数', type: 'atomic' }] });
    const input = openArtifactPicker();

    fireEvent.change(input, { target: { value: '二次' } });

    expect((await screen.findByRole('alert')).textContent).toBe('搜索失败，请重试。');
    expect(searchArtifacts).toHaveBeenNthCalledWith(1, '二次', 'note_1');

    fireEvent.click(screen.getByRole('button', { name: '重试搜索' }));

    await waitFor(() => expect(screen.getByRole('button', { name: /二次函数/ })).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(searchArtifacts).toHaveBeenNthCalledWith(2, '二次', 'note_1');
  });

  it('ignores a stale failure after a newer search succeeds', async () => {
    let rejectFirst!: (reason?: unknown) => void;
    vi.mocked(searchArtifacts)
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce({ rows: [{ id: 'note_3', title: '函数图像', type: 'atomic' }] });
    const input = openArtifactPicker();

    fireEvent.change(input, { target: { value: '函数' } });
    fireEvent.change(input, { target: { value: '函数图' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /函数图像/ })).toBeTruthy());

    rejectFirst(new Error('late failure'));
    await Promise.resolve();

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: /函数图像/ })).toBeTruthy();
  });
});
