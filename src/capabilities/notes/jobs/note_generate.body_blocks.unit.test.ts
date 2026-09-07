import { describe, expect, it } from 'vitest';

import { bodyBlocksToNoteSections } from '@/capabilities/notes/server/body-blocks';
import { blockText } from '@/capabilities/notes/ui/NoteBlocks';
import type { BodyBlock } from '@/capabilities/notes/ui/notes-api';
import { parseNoteGenerateOutput } from './note_generate';

const BODY_BLOCKS_OUTPUT = JSON.stringify({
  body_blocks: {
    type: 'doc',
    content: [
      {
        type: 'semanticBlock',
        attrs: {
          id: 'def_1',
          semantic_kind: 'definition',
          source_tier: 'llm_only',
          user_verified: false,
          version: 1,
          source_markdown: '定义内容',
        },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '定义内容' }] }],
      },
    ],
  },
});

const LEGACY_SECTIONS_OUTPUT = JSON.stringify({
  sections: [
    {
      id: 's1',
      kind: 'definition',
      body_md: '旧 sections 内容',
      source_tier: 'llm_only',
      user_verified: false,
      embedded_check: null,
      version: 1,
    },
  ],
});

describe('parseNoteGenerateOutput', () => {
  it('keeps long/hub structure and derives readable source for the shipped consumers', () => {
    const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
    const body = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '从条件到反例' }] },
        {
          type: 'calloutBlock',
          attrs: { tone: 'warning', title: '先检查条件' },
          content: [paragraph('P(B)>0；条件方向不同。')],
        },
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [
            {
              type: 'listItem',
              content: [
                paragraph('先缩小样本空间'),
                {
                  type: 'bulletList',
                  content: [
                    { type: 'listItem', content: [paragraph('再保留未知：不是互斥就一定独立。')] },
                  ],
                },
              ],
            },
          ],
        },
        { type: 'blockquote', content: [paragraph('不能从一次答对推断掌握。')] },
        {
          type: 'codeBlock',
          attrs: { language: 'text' },
          content: [{ type: 'text', text: 'P(A|B) = P(A∩B)/P(B)\n\\frac{2}{3}' }],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: '参考',
              marks: [{ type: 'link', attrs: { href: 'https://example.org/probability' } }],
            },
          ],
        },
        {
          type: 'crossLinkBlock',
          attrs: { artifact_id: 'existing-note', block_id: 'existing-block', title: '概率基础' },
        },
      ],
    };
    const parsed = parseNoteGenerateOutput(JSON.stringify({ body_blocks: body }));
    const visible = parsed.body_blocks.content
      .slice(0, 6)
      .map((node) => blockText(node as BodyBlock));
    expect(visible).toEqual([
      '## 从条件到反例',
      '先检查条件\n\nP(B)>0；条件方向不同。',
      '3. 先缩小样本空间\n  \n  - 再保留未知：不是互斥就一定独立。',
      '> 不能从一次答对推断掌握。',
      '```text\nP(A|B) = P(A∩B)/P(B)\n\\frac{2}{3}\n```',
      '[参考](https://example.org/probability)',
    ]);
    expect(parsed.body_blocks.content[6].attrs).toMatchObject({
      artifact_id: 'existing-note',
      block_id: 'existing-block',
      title: '概率基础',
    });
    expect(parsed.body_blocks.content[4].content).toEqual(body.content[4].content);
  });

  it.each(['unknownWidget', 'autoLinksContainer'])(
    'rejects unsupported or system-owned %s content',
    (type) => {
      expect(() =>
        parseNoteGenerateOutput(
          JSON.stringify({
            body_blocks: {
              type: 'doc',
              content: [{ type, content: [{ type: 'text', text: '不能静默丢失的内容' }] }],
            },
          }),
        ),
      ).toThrow(/unsupported generated node/);
    },
  );

  it('rejects unsupported marks and an empty content block', () => {
    expect(() =>
      parseNoteGenerateOutput(
        JSON.stringify({
          body_blocks: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: '保留所有语义', marks: [{ type: 'unknownMark' }] }],
              },
            ],
          },
        }),
      ),
    ).toThrow(/unsupported generated mark/);
    expect(() =>
      parseNoteGenerateOutput(
        JSON.stringify({
          body_blocks: { type: 'doc', content: [{ type: 'paragraph', content: [] }] },
        }),
      ),
    ).toThrow(/empty generated content block/);
  });

  it('materializes compact rich content without making the model duplicate prose or mint metadata', () => {
    const kinds = ['definition', 'mechanism', 'example', 'pitfall', 'check'];
    const content = kinds.map((kind) => ({
      type: 'semanticBlock',
      attrs: { semantic_kind: kind },
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: '条件 P(B)>0；“条件反转”不成立。\\frac{2}{3}',
              marks: [{ type: 'bold' }],
            },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: '保留反例与未知；先约束样本空间，再计算。' }],
                },
              ],
            },
          ],
        },
      ],
    }));
    const link = {
      type: 'crossLinkBlock',
      attrs: { artifact_id: 'related-note', block_id: 'existing-block', title: '条件方向' },
    };
    const parsed = parseNoteGenerateOutput(
      JSON.stringify({ body_blocks: { type: 'doc', content: [...content, link] } }),
    );
    expect(parsed.sections_count).toBe(5);
    const ids = new Set();
    for (const [index, node] of parsed.body_blocks.content.entries()) {
      expect(node.attrs).toHaveProperty('id', expect.any(String));
      ids.add((node.attrs as { id: string }).id);
      if (index < 5) {
        expect(node.attrs).toMatchObject({
          semantic_kind: kinds[index],
          source_tier: 'llm_only',
          user_verified: false,
          version: 1,
        });
        expect(blockText(node as BodyBlock)).toContain('条件反转');
        expect(blockText(node as BodyBlock)).toContain('保留反例与未知');
        expect(node.content).toEqual(content[index].content);
      } else expect(node.attrs).toMatchObject(link.attrs);
    }
    expect(ids.size).toBe(6);
    expect(bodyBlocksToNoteSections(parsed.body_blocks)[0].body_md).toContain('条件反转');
  });

  it('does not let generated metadata claim human verification or override the displayed content', () => {
    const raw = JSON.parse(BODY_BLOCKS_OUTPUT);
    Object.assign(raw.body_blocks.content[0].attrs, {
      source_tier: 'human',
      user_verified: true,
      version: 99,
      source_markdown: '与实际正文相矛盾的第二份内容',
    });
    const parsed = parseNoteGenerateOutput(JSON.stringify(raw));
    expect(parsed.body_blocks.content[0].attrs).toMatchObject({
      source_tier: 'llm_only',
      user_verified: false,
      version: 1,
    });
    expect(bodyBlocksToNoteSections(parsed.body_blocks)[0].body_md).toBe('定义内容');
  });

  it('accepts body_blocks output as the canonical NoteGenerateTask contract', () => {
    const parsed = parseNoteGenerateOutput(BODY_BLOCKS_OUTPUT);

    expect(parsed.blocks_count).toBe(1);
    expect(parsed.sections_count).toBe(1);
    expect(parsed.body_blocks.content[0]?.type).toBe('semanticBlock');
    expect(parsed.body_blocks.content[0]?.attrs).toMatchObject({
      id: expect.any(String),
      semantic_kind: 'definition',
    });
  });

  it('rejects empty body_blocks output before marking an artifact ready', () => {
    expect(() =>
      parseNoteGenerateOutput(
        JSON.stringify({
          body_blocks: { type: 'doc', content: [] },
        }),
      ),
    ).toThrow(/body_blocks\.content must contain at least one block/);
  });

  it('replaces model anchors and rejects malformed quoted prose instead of guessing a repair', () => {
    const raw = JSON.parse(BODY_BLOCKS_OUTPUT);
    raw.body_blocks.content.push(structuredClone(raw.body_blocks.content[0]));
    const parsed = parseNoteGenerateOutput(JSON.stringify(raw));
    expect(
      new Set(parsed.body_blocks.content.map((node) => (node.attrs as { id: string }).id)).size,
    ).toBe(2);
    expect(parsed.body_blocks.content[0].attrs).not.toHaveProperty('id', 'def_1');
    const malformed = BODY_BLOCKS_OUTPUT.replace('定义内容', '表示"在已知 B 发生的前提下"');
    expect(() => parseNoteGenerateOutput(malformed)).toThrow(/JSON.parse failed/);
  });

  it('rejects the retired sections provider format', () => {
    expect(() => parseNoteGenerateOutput(LEGACY_SECTIONS_OUTPUT)).toThrow(/schema invalid/);
  });
});
