import { describe, expect, it } from 'vitest';

import { bodyBlocksToNoteSections } from '@/server/artifacts/body-blocks';
import { parseNoteGenerateOutput } from '@/server/boss/handlers/note_generate';

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
  it('accepts body_blocks output as the canonical NoteGenerateTask contract', () => {
    const parsed = parseNoteGenerateOutput(BODY_BLOCKS_OUTPUT);

    expect(parsed.blocks_count).toBe(1);
    expect(parsed.sections_count).toBe(1);
    expect(parsed.body_blocks.content[0]?.type).toBe('semanticBlock');
    expect(parsed.body_blocks.content[0]?.attrs).toMatchObject({
      id: 'def_1',
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

  it('converts legacy sections output for compatibility', () => {
    const parsed = parseNoteGenerateOutput(LEGACY_SECTIONS_OUTPUT);

    expect(parsed.blocks_count).toBe(1);
    expect(parsed.sections_count).toBe(1);
    expect(bodyBlocksToNoteSections(parsed.body_blocks)[0]?.body_md).toBe('旧 sections 内容');
  });
});
