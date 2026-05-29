import { describe, expect, it } from 'vitest';

import {
  AUTO_LINKS_CONTAINER_NODE,
  CROSS_LINK_BLOCK_NODE,
  appendSuppressedRef,
  buildRemoveAutoLinkPatch,
} from './hub-dismiss';

// Pure (no-DB) coverage for the hub-dismiss read-modify-write helpers
// (YUK-155 review-2). The single-owner write path persistHubLinkDismiss is
// covered by the DB route + nightly handler tests; these isolate the two pure
// transforms so the dedup / patch-construction edge cases are pinned without a
// testcontainer.

describe('appendSuppressedRef', () => {
  it('appends { artifact_id } when attrs is null', () => {
    const { attrs, added } = appendSuppressedRef(null, 'a1');
    expect(added).toBe(true);
    expect(attrs.suppressed_block_refs).toEqual([{ artifact_id: 'a1' }]);
  });

  it('appends when attrs has no suppressed_block_refs key', () => {
    const { attrs, added } = appendSuppressedRef({ title: 'hub' }, 'a1');
    expect(added).toBe(true);
    expect(attrs).toEqual({ title: 'hub', suppressed_block_refs: [{ artifact_id: 'a1' }] });
  });

  it('accumulates distinct artifact ids (no lost update on sequential append)', () => {
    const first = appendSuppressedRef({}, 'a1');
    const second = appendSuppressedRef(first.attrs, 'a2');
    expect(second.added).toBe(true);
    expect(second.attrs.suppressed_block_refs).toEqual([
      { artifact_id: 'a1' },
      { artifact_id: 'a2' },
    ]);
  });

  it('is idempotent — appending an existing artifact_id keeps a single entry', () => {
    const base = { suppressed_block_refs: [{ artifact_id: 'a1' }] };
    const { attrs, added } = appendSuppressedRef(base, 'a1');
    expect(added).toBe(false);
    expect(attrs.suppressed_block_refs).toEqual([{ artifact_id: 'a1' }]);
  });

  it('tolerates a malformed (non-array) suppressed_block_refs by resetting to a fresh list', () => {
    const { attrs, added } = appendSuppressedRef(
      { suppressed_block_refs: 'oops' as unknown as [] },
      'a1',
    );
    expect(added).toBe(true);
    expect(attrs.suppressed_block_refs).toEqual([{ artifact_id: 'a1' }]);
  });

  it('preserves unrelated attrs while appending', () => {
    const { attrs } = appendSuppressedRef(
      { kind: 'note_hub', suppressed_block_refs: [{ artifact_id: 'a1' }] },
      'a2',
    );
    expect(attrs.kind).toBe('note_hub');
    expect(attrs.suppressed_block_refs).toEqual([{ artifact_id: 'a1' }, { artifact_id: 'a2' }]);
  });

  it('ignores legacy entries that lack artifact_id when deduping', () => {
    const base = { suppressed_block_refs: [{ note: 'legacy' }] };
    const { attrs, added } = appendSuppressedRef(base, 'a1');
    expect(added).toBe(true);
    expect(attrs.suppressed_block_refs).toEqual([{ note: 'legacy' }, { artifact_id: 'a1' }]);
  });
});

describe('buildRemoveAutoLinkPatch', () => {
  const containerWith = (children: Record<string, unknown>[]) => ({
    type: 'doc',
    content: [{ type: AUTO_LINKS_CONTAINER_NODE, attrs: { id: 'auto-zone' }, content: children }],
  });
  const autoLink = (artifactId: string) => ({
    type: CROSS_LINK_BLOCK_NODE,
    attrs: { id: `blk-${artifactId}`, auto: true, artifact_id: artifactId },
  });

  it('returns null for a malformed doc (not an object)', () => {
    expect(buildRemoveAutoLinkPatch(null, 'a1')).toBeNull();
    expect(buildRemoveAutoLinkPatch('nope', 'a1')).toBeNull();
    expect(buildRemoveAutoLinkPatch(42, 'a1')).toBeNull();
  });

  it('returns null when there is no AutoLinksContainer', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'p1' } }] };
    expect(buildRemoveAutoLinkPatch(doc, 'a1')).toBeNull();
  });

  it('returns null when the container has no id', () => {
    const doc = {
      type: 'doc',
      content: [{ type: AUTO_LINKS_CONTAINER_NODE, attrs: {}, content: [autoLink('a1')] }],
    };
    expect(buildRemoveAutoLinkPatch(doc, 'a1')).toBeNull();
  });

  it('returns null when the auto-zone is empty', () => {
    expect(buildRemoveAutoLinkPatch(containerWith([]), 'a1')).toBeNull();
  });

  it('returns null when no auto child matches the target (idempotent re-dismiss)', () => {
    const doc = containerWith([autoLink('other')]);
    expect(buildRemoveAutoLinkPatch(doc, 'a1')).toBeNull();
  });

  it('builds a replace_block patch dropping only the matching auto child', () => {
    const doc = containerWith([autoLink('a1'), autoLink('a2')]);
    const patch = buildRemoveAutoLinkPatch(doc, 'a1');
    expect(patch).not.toBeNull();
    expect(patch?.ops).toHaveLength(1);
    const op = patch?.ops[0];
    expect(op?.kind).toBe('replace_block');
    if (op?.kind !== 'replace_block') throw new Error('expected replace_block');
    expect(op.target_block_id).toBe('auto-zone');
    const block = op.block as Record<string, unknown>;
    expect(block.type).toBe(AUTO_LINKS_CONTAINER_NODE);
    expect((block.attrs as Record<string, unknown>).id).toBe('auto-zone');
    expect(block.content).toEqual([autoLink('a2')]);
  });

  it('does not remove a manual (auto !== true) crossLinkBlock with the same artifact_id', () => {
    const manual = {
      type: CROSS_LINK_BLOCK_NODE,
      attrs: { id: 'manual', auto: false, artifact_id: 'a1' },
    };
    const doc = containerWith([manual]);
    expect(buildRemoveAutoLinkPatch(doc, 'a1')).toBeNull();
  });

  it('handles the first of multiple containers and only targets its auto children', () => {
    // Two AutoLinksContainers in the doc; find() picks the first. The target lives
    // in the first, so the patch rewrites that container and leaves the second.
    const doc = {
      type: 'doc',
      content: [
        { type: AUTO_LINKS_CONTAINER_NODE, attrs: { id: 'first' }, content: [autoLink('a1')] },
        { type: AUTO_LINKS_CONTAINER_NODE, attrs: { id: 'second' }, content: [autoLink('a2')] },
      ],
    };
    const patch = buildRemoveAutoLinkPatch(doc, 'a1');
    expect(patch).not.toBeNull();
    const op = patch?.ops[0];
    if (op?.kind !== 'replace_block') throw new Error('expected replace_block');
    expect(op.target_block_id).toBe('first');
    expect((op.block as Record<string, unknown>).content).toEqual([]);
  });

  it('returns null when the target only exists in a non-first container', () => {
    // find() resolves the first container, which has no matching auto child →
    // remaining.length === children.length → null. (Auto-zone is doc-root and
    // single in practice; this pins the documented first-match behavior.)
    const doc = {
      type: 'doc',
      content: [
        { type: AUTO_LINKS_CONTAINER_NODE, attrs: { id: 'first' }, content: [autoLink('a1')] },
        { type: AUTO_LINKS_CONTAINER_NODE, attrs: { id: 'second' }, content: [autoLink('a2')] },
      ],
    };
    expect(buildRemoveAutoLinkPatch(doc, 'a2')).toBeNull();
  });
});
