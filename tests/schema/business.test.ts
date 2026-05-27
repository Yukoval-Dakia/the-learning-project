import { ArtifactBodyBlocks } from '@/core/schema/business';
import { describe, expect, it } from 'vitest';

describe('ArtifactBodyBlocks', () => {
  it('requires TipTap marks to carry a non-empty type', () => {
    const invalid = ArtifactBodyBlocks.safeParse({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'bad mark', marks: [{ attrs: { href: '/x' } }] }],
        },
      ],
    });
    expect(invalid.success).toBe(false);

    const valid = ArtifactBodyBlocks.safeParse({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'linked', marks: [{ type: 'link', attrs: { href: '/x' } }] },
          ],
        },
      ],
    });
    expect(valid.success).toBe(true);
  });
});
