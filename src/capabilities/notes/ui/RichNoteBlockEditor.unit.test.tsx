// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BodyBlock } from './notes-api';
import { RichNoteBlockEditor } from './RichNoteBlockEditor';

afterEach(cleanup);

const rich: BodyBlock = {
  type: 'semanticBlock',
  attrs: {
    id: 'anchor',
    semantic_kind: 'definition',
    source_tier: 'llm_only',
    version: 7,
    source_markdown: '**定义**',
  },
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: '定义', marks: [{ type: 'bold' }] }] },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: '保留反例',
                  marks: [{ type: 'link', attrs: { href: 'https://example.com/lesson' } }],
                },
              ],
            },
            {
              type: 'orderedList',
              attrs: { start: 3 },
              content: [
                {
                  type: 'listItem',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: '嵌套条件' }] }],
                },
              ],
            },
          ],
        },
      ],
    },
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '边界' }] },
    {
      type: 'codeBlock',
      attrs: { language: 'js' },
      content: [{ type: 'text', text: 'a < b && c > d' }],
    },
    {
      type: 'crossLinkBlock',
      attrs: { id: 'ref', artifact_id: 'target', block_id: 'target-block', title: '关联' },
    },
  ],
};

describe('rich note block editing', () => {
  it('edits through the DOM without losing rich structure, anchors or undo history', async () => {
    const changed = vi.fn();
    const { rerender } = render(
      <RichNoteBlockEditor block={rich} label="笔记正文" onChange={changed} />,
    );
    const box = await screen.findByRole('textbox', { name: '笔记正文' });
    const text = box.querySelector('strong')?.firstChild;
    expect(text).toBeTruthy();
    if (!text) throw new Error('missing rich text');
    text.textContent = '新定义';
    fireEvent.input(box, { inputType: 'insertText', data: '新' });
    await waitFor(() => expect(changed).toHaveBeenCalled());
    const updated: BodyBlock = changed.mock.lastCall?.[0];
    expect(updated.attrs).toMatchObject({ id: 'anchor', version: 7, source_tier: 'llm_only' });
    expect(updated.attrs?.source_markdown).toContain('**新定义**');
    expect(updated.content).toMatchObject(
      rich.content?.map((node, i) =>
        i === 0
          ? {
              type: 'paragraph',
              content: [{ type: 'text', text: '新定义', marks: [{ type: 'bold' }] }],
            }
          : node,
      ) ?? [],
    );
    // Parent save acknowledgement must not reset undo history.
    rerender(<RichNoteBlockEditor block={updated} label="笔记正文" onChange={changed} />);
    fireEvent.keyDown(box, { key: 'z', code: 'KeyZ', ctrlKey: true });
    await waitFor(() =>
      expect(changed.mock.lastCall?.[0].attrs.source_markdown).toContain('**定义**'),
    );
    cleanup();
    render(<RichNoteBlockEditor block={updated} label="重开正文" onChange={vi.fn()} />);
    const reopened = await screen.findByRole('textbox', { name: '重开正文' });
    expect(reopened.querySelector('strong')?.textContent).toBe('新定义');
    expect(reopened.querySelector('ul ol')?.getAttribute('start')).toBe('3');
    expect(reopened.querySelector('h3')?.textContent).toBe('边界');
    expect(reopened.querySelector('pre code')?.textContent).toBe('a < b && c > d');
  });

  it('keeps a top-level heading inline and never wraps it in a paragraph', async () => {
    const changed = vi.fn();
    render(
      <RichNoteBlockEditor
        block={{
          type: 'heading',
          attrs: { id: 'heading', level: 2 },
          content: [{ type: 'text', text: '标题' }],
        }}
        label="标题"
        onChange={changed}
      />,
    );
    const box = await screen.findByRole('textbox', { name: '标题' });
    const text = box.querySelector('h2')?.firstChild;
    if (!text) throw new Error('missing heading');
    text.textContent = '新标题';
    fireEvent.input(box);
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(changed.mock.lastCall?.[0]).toMatchObject({
      type: 'heading',
      attrs: { id: 'heading', level: 2 },
      content: [{ type: 'text', text: '新标题' }],
    });
  });

  it('refuses unsupported stored nodes instead of silently stripping them', () => {
    const changed = vi.fn();
    render(
      <RichNoteBlockEditor
        block={{ ...rich, content: [{ type: 'unknown-widget', attrs: { id: 'keep' } }] }}
        label="正文"
        onChange={changed}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('保留原内容');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });
});
