import { describe, expect, it } from 'vitest';

import { extractBlockSnippet, extractCrossLinkSnippet } from './body-blocks';

// Pure (no-DB) coverage for the Lane-B backlink-panel context-snippet helpers.

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

// FIX 2 (YUK-95 P5 review) — the backlink panel snippet anchors on a
// crossLinkBlock's OWN attrs.id (= from_block_id). The real crossLinkBlock is
// `atom: true` with NO content (see cross-link-picker.ts / hub_auto_sync_nightly
// desiredChild), so the previous `extractBlockSnippet` always returned '' in
// production. These cases use the REAL atom shape (NO content array).
describe('extractCrossLinkSnippet (real atom shape)', () => {
  // Manual cross-link inside a semanticBlock paragraph — the real emitted shape:
  // crossLinkBlock = { type, attrs }, NO `content`.
  function crossLinkInSemantic(text: string, title: string) {
    return {
      type: 'doc',
      content: [
        {
          type: 'semanticBlock',
          attrs: { id: 'sec1', semantic_kind: 'definition' },
          content: [
            { type: 'paragraph', content: [{ type: 'text', text }] },
            { type: 'crossLinkBlock', attrs: { id: 'cl1', artifact_id: 'a2', title } },
          ],
        },
      ],
    };
  }

  it('sources the snippet from the ENCLOSING block text, not the empty atom', () => {
    const doc = crossLinkInSemantic('这里引用了目标笔记的定义', '为政');
    // The enclosing semanticBlock contains both the paragraph and the cross-link.
    expect(extractCrossLinkSnippet(doc, 'cl1')).toBe('这里引用了目标笔记的定义');
  });

  it('does NOT return an empty string for a no-content atom (regression)', () => {
    const doc = crossLinkInSemantic('父级语境文本', '某目标');
    const snippet = extractCrossLinkSnippet(doc, 'cl1');
    expect(snippet).not.toBe('');
    expect(snippet).not.toBeNull();
  });

  it('falls back to the cross-link title when the enclosing block has no text', () => {
    // A worker-written auto-link inside an AutoLinksContainer: the container has
    // no inline text, and the atom has no content — only its title attr.
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'autoLinksContainer',
          attrs: { id: 'hub1__auto_links', title: 'Related' },
          content: [
            {
              type: 'crossLinkBlock',
              attrs: {
                id: 'hub1__auto_links__atom1',
                artifact_id: 'atom1',
                title: '之的助词用法',
                auto: true,
                relation: 'subtopic',
              },
            },
          ],
        },
      ],
    };
    expect(extractCrossLinkSnippet(doc, 'hub1__auto_links__atom1')).toBe('之的助词用法');
  });

  it('trims a long enclosing-block snippet with an ellipsis', () => {
    const long = '字'.repeat(200);
    const doc = crossLinkInSemantic(long, '标题');
    const snippet = extractCrossLinkSnippet(doc, 'cl1', 120);
    expect(snippet?.length).toBe(120);
    expect(snippet?.endsWith('...')).toBe(true);
  });

  it('returns null when no crossLinkBlock matches the id', () => {
    const doc = crossLinkInSemantic('text', '标题');
    expect(extractCrossLinkSnippet(doc, 'nope')).toBeNull();
  });

  it('returns null for an unparseable doc', () => {
    expect(extractCrossLinkSnippet({ not: 'a doc' }, 'cl1')).toBeNull();
    expect(extractCrossLinkSnippet(null, 'cl1')).toBeNull();
  });
});
