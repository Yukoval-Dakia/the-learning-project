import { describe, expect, it } from 'vitest';

import { extractBlockSnippet } from './body-blocks';

// Pure (no-DB) coverage for the Lane-B backlink-panel context-snippet helper.
describe('extractBlockSnippet', () => {
  it('extracts whitespace-collapsed text for a matching block id', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'semanticBlock',
          attrs: { id: 'b1', semantic_kind: 'definition' },
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: '  仁者爱人\n克己复礼 ' }] },
          ],
        },
      ],
    };
    expect(extractBlockSnippet(doc, 'b1')).toBe('仁者爱人 克己复礼');
  });

  it('finds a nested block (crossLinkBlock inside a semanticBlock)', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'semanticBlock',
          attrs: { id: 'outer' },
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: '父级文本' }] },
            {
              type: 'crossLinkBlock',
              attrs: { id: 'cl1', artifact_id: 'a2', title: '为政' },
              content: [{ type: 'text', text: '内联链接文本' }],
            },
          ],
        },
      ],
    };
    expect(extractBlockSnippet(doc, 'cl1')).toBe('内联链接文本');
  });

  it('trims to maxLength with an ellipsis', () => {
    const long = '一'.repeat(200);
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'p1' },
          content: [{ type: 'text', text: long }],
        },
      ],
    };
    const snippet = extractBlockSnippet(doc, 'p1', 120);
    expect(snippet).not.toBeNull();
    expect(snippet?.length).toBe(120);
    expect(snippet?.endsWith('...')).toBe(true);
  });

  it('returns null when no block matches the id', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { id: 'p1' }, content: [] }],
    };
    expect(extractBlockSnippet(doc, 'missing')).toBeNull();
  });

  it('returns null for an unparseable doc', () => {
    expect(extractBlockSnippet({ not: 'a doc' }, 'b1')).toBeNull();
    expect(extractBlockSnippet(null, 'b1')).toBeNull();
  });
});
