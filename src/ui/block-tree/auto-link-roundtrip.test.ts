import { getSchema } from '@tiptap/core';
import { Node as PmNode } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';

import { blockTreeEditorExtensions } from './tiptap-extensions';

// FIX 1 (YUK-95 P5 review) — regression for auto-link provenance round-trip.
//
// The nightly hub_auto_sync worker writes flat `auto: true` + `relation` attrs on
// each system-maintained crossLinkBlock. TipTap STRIPS any attr that isn't
// declared in the node's `addAttributes()` on the JSON path (setContent →
// getJSON). Before the fix, `auto`/`relation` were only declared on
// AutoLinksContainer (the wrong node), so a single edit-save silently dropped the
// provenance off every child crossLinkBlock — killing the read chip and breaking
// the worker's idempotent child-signature diff.
//
// We don't need a live editor (the unit partition runs in `environment: 'node'`,
// no DOM). `getSchema(extensions)` builds the real ProseMirror schema from the
// actual block-tree extensions, and `PmNode.fromJSON(schema, doc).toJSON()`
// exercises the exact attr parse/serialize path setContent/getJSON use: undeclared
// attrs are dropped on `fromJSON`, declared attrs survive to `toJSON`.

const schema = getSchema(blockTreeEditorExtensions());

function roundTrip(doc: Record<string, unknown>): Record<string, unknown> {
  return PmNode.fromJSON(schema, doc).toJSON();
}

// A hub doc with one system-maintained auto crossLinkBlock inside the auto-zone
// container — the exact shape the worker (`desiredChild` in
// hub_auto_sync_nightly.ts) emits.
function autoLinkDoc() {
  return {
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
              block_id: null,
              title: '之的助词用法',
              auto: true,
              relation: 'subtopic',
            },
          },
        ],
      },
    ],
  };
}

function firstAutoChildAttrs(doc: Record<string, unknown>): Record<string, unknown> {
  const content = (doc.content as Array<Record<string, unknown>>) ?? [];
  const container = content.find((n) => n.type === 'autoLinksContainer');
  const child = ((container?.content as Array<Record<string, unknown>>) ?? [])[0];
  return (child?.attrs as Record<string, unknown>) ?? {};
}

describe('crossLinkBlock auto-link provenance round-trip (FIX 1)', () => {
  it('keeps auto + relation on a crossLinkBlock through fromJSON/toJSON', () => {
    const attrs = firstAutoChildAttrs(roundTrip(autoLinkDoc()));
    expect(attrs.auto).toBe(true);
    expect(attrs.relation).toBe('subtopic');
    // The pre-existing flat attrs survive too.
    expect(attrs.artifact_id).toBe('atom1');
    expect(attrs.title).toBe('之的助词用法');
  });

  it('declares auto + relation on crossLinkBlock, not on autoLinksContainer', () => {
    const crossLink = schema.nodes.crossLinkBlock;
    const container = schema.nodes.autoLinksContainer;
    expect(crossLink).toBeDefined();
    expect(crossLink?.spec.attrs).toMatchObject({ auto: {}, relation: {} });
    // Provenance must NOT be (mis)declared on the container.
    expect(container?.spec.attrs).not.toHaveProperty('auto');
    expect(container?.spec.attrs).not.toHaveProperty('relation');
  });

  it('a user-inserted cross_link (no provenance) round-trips with null auto/relation', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'crossLinkBlock',
          attrs: { id: 'cl1', artifact_id: 'a2', title: '手动链接' },
        },
      ],
    };
    const child = (roundTrip(doc).content as Array<Record<string, unknown>>)[0];
    const attrs = child.attrs as Record<string, unknown>;
    expect(attrs.auto).toBeNull();
    expect(attrs.relation).toBeNull();
    expect(attrs.artifact_id).toBe('a2');
  });
});
