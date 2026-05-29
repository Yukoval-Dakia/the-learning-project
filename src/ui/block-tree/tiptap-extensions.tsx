'use client';

import { Node, mergeAttributes } from '@tiptap/core';
import Link from '@tiptap/extension-link';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  type CrossLinkSuggestionContext,
  createCrossLinkSuggestionExtension,
} from './CrossLinkSuggestion';
import { AUTO_LINK_SYSTEM_LABEL, autoLinkChip } from './auto-link-chip';
import {
  ARTIFACT_REF_BLOCK_NODE,
  AUTO_LINKS_CONTAINER_NODE,
  CALLOUT_BLOCK_NODE,
  CROSS_LINK_BLOCK_NODE,
  SEMANTIC_BLOCK_NODE,
} from './types';

function BlockNodeView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper
      className={`block-tree-node-view block-tree-node-view-${node.type.name}`}
      data-block-id={String(node.attrs.id ?? '')}
    >
      <div className="block-tree-node-view-meta">
        {node.type.name === SEMANTIC_BLOCK_NODE
          ? String(node.attrs.semantic_kind ?? 'block')
          : node.type.name}
      </div>
      <NodeViewContent className="block-tree-node-view-content" />
    </NodeViewWrapper>
  );
}

// crossLinkBlock is an atom — no editable content. Render it as the same
// `.block-tree-link-card` the read renderer uses (BlockTreeRenderer.tsx) so the
// inserted node looks identical in edit + read. `contentEditable=false` keeps
// the cursor out of the card.
//
// YUK-95 P5 Lane-D — system-maintained auto-links (`attrs.auto === true`, written
// by the nightly hub_auto_sync worker) get the "系统维护" marker + relation chip
// here too, so the edit view matches the read view. Dismiss (×) is a read-view
// affordance (it POSTs to /api/hubs/[id]/dismiss-link, which mutates body_blocks
// out-of-band), so it is NOT surfaced inside the editor NodeView.
function CrossLinkNodeView({ node }: NodeViewProps) {
  const title = String(node.attrs.title ?? node.attrs.artifact_id ?? 'Artifact');
  const blockId = node.attrs.block_id ? String(node.attrs.block_id) : null;
  const chip = autoLinkChip(node.attrs as Record<string, unknown>);
  return (
    <NodeViewWrapper
      className={`block-tree-node-view-crosslink${chip.isAuto ? ' block-tree-node-view-crosslink--auto' : ''}`}
      data-block-id={String(node.attrs.id ?? '')}
      contentEditable={false}
    >
      <div className={`block-tree-link-card${chip.isAuto ? ' block-tree-link-card--auto' : ''}`}>
        <div className="block-tree-link-card-head">
          <span>cross_link</span>
          {chip.isAuto ? (
            <span className="auto-link-system-tag">{AUTO_LINK_SYSTEM_LABEL}</span>
          ) : null}
          {chip.relationLabel ? (
            <span className={`auto-link-chip ${chip.relationToneClass ?? ''}`}>
              {chip.relationLabel}
            </span>
          ) : null}
        </div>
        <strong>{title}</strong>
        {blockId ? <small>#{blockId}</small> : null}
      </div>
    </NodeViewWrapper>
  );
}

export const SemanticBlock = Node.create({
  name: SEMANTIC_BLOCK_NODE,
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      id: { default: null },
      semantic_kind: { default: 'definition' },
      source_tier: { default: 'llm_only' },
      user_verified: { default: false },
      embedded_check: { default: null },
      version: { default: 0 },
      derived_from_block_id: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'section[data-node-type="semanticBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'section',
      mergeAttributes(HTMLAttributes, {
        'data-node-type': SEMANTIC_BLOCK_NODE,
        'data-block-id': HTMLAttributes.id,
      }),
      0,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(BlockNodeView);
  },
});

export const CrossLinkBlock = Node.create({
  name: CROSS_LINK_BLOCK_NODE,
  group: 'block',
  atom: true,

  // FIX 1 (YUK-95 P5 review) — `auto` + `relation` are flat provenance attrs the
  // nightly hub_auto_sync worker (Lane-C) writes on system-maintained auto-links.
  // They MUST be declared here so they survive the editor's JSON round-trip
  // (setContent → getJSON): an undeclared attr is silently stripped by TipTap,
  // which (a) hides the relation chip in the edit view and (b) lets a user
  // edit-save strip provenance from body_blocks (read chip vanishes + the
  // worker's child-signature diff breaks). The `default: null` is the piece that
  // fixes the JSON path; parseHTML/renderHTML below carry them through the HTML
  // clipboard path too for completeness.
  addAttributes() {
    return {
      id: { default: null },
      artifact_id: { default: null },
      block_id: { default: null },
      title: { default: null },
      auto: { default: null },
      relation: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-node-type="crossLinkBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-node-type': CROSS_LINK_BLOCK_NODE })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CrossLinkNodeView);
  },
});

export const ArtifactRefBlock = Node.create({
  name: ARTIFACT_REF_BLOCK_NODE,
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      id: { default: null },
      artifact_id: { default: null },
      title: { default: null },
      artifact_type: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-node-type="artifactRefBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-node-type': ARTIFACT_REF_BLOCK_NODE })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(BlockNodeView);
  },
});

export const CalloutBlock = Node.create({
  name: CALLOUT_BLOCK_NODE,
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      id: { default: null },
      tone: { default: 'info' },
      title: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'aside[data-node-type="calloutBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['aside', mergeAttributes(HTMLAttributes, { 'data-node-type': CALLOUT_BLOCK_NODE }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(BlockNodeView);
  },
});

// YUK-95 P5 Lane-D — reorder-only enforcement (ADR-0020 §9: "用户可重排顺序，但
// 不可增删 children"). We collect the MULTISET of auto-zone child anchors (each
// child's `attrs.id`, falling back to artifact_id) across every
// AutoLinksContainer in a doc, plus the number of containers. Reorder keeps the
// multiset identical; a hand add or delete changes it. The dismiss flow
// (× button → suppress event → out-of-band body_blocks mutation) is the ONLY
// sanctioned removal path.
export function autoZoneChildKeys(doc: PmNode): { containers: number; keys: string[] } {
  const keys: string[] = [];
  let containers = 0;
  doc.descendants((node: PmNode) => {
    if (node.type.name !== AUTO_LINKS_CONTAINER_NODE) return true;
    containers += 1;
    // `node.forEach` here is the ProseMirror Node child-iteration API (not
    // Array.prototype.forEach) — the only way to walk a PM node's children.
    // biome-ignore lint/complexity/noForEach: ProseMirror Node API, not an array.
    node.forEach((child: PmNode) => {
      const id = child.attrs?.id ?? child.attrs?.artifact_id;
      keys.push(typeof id === 'string' && id.length > 0 ? id : `${child.type.name}:unknown`);
    });
    // Don't descend further into the container (children are atoms anyway).
    return false;
  });
  return { containers, keys };
}

function sameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const k of a) counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const k of b) {
    const n = counts.get(k);
    if (!n) return false;
    counts.set(k, n - 1);
  }
  return [...counts.values()].every((n) => n === 0);
}

/**
 * True when `next` is an allowed evolution of `prev` for the auto-zone. We only
 * BLOCK in-place hand add/delete of individual children — i.e. the number of
 * AutoLinksContainers is unchanged but the combined child multiset differs
 * (reorder keeps it equal). Wholesale container add/remove (the count changed,
 * e.g. setContent on initial load, or the server-side dismiss replace_block
 * rebuilding the container) is allowed.
 *
 * Pure + exported for unit testing.
 */
export function isAllowedAutoZoneChange(prev: PmNode, next: PmNode): boolean {
  const before = autoZoneChildKeys(prev);
  const after = autoZoneChildKeys(next);
  // Container set changed wholesale → not a piecemeal child edit; allow.
  if (before.containers !== after.containers) return true;
  // Same containers: reorder keeps the multiset; add/delete changes it.
  return sameMultiset(before.keys, after.keys);
}

const autoZoneReorderOnlyKey = new PluginKey('autoZoneReorderOnly');

export const AutoLinksContainer = Node.create({
  name: AUTO_LINKS_CONTAINER_NODE,
  group: 'block',
  content: '(crossLinkBlock | artifactRefBlock)*',
  defining: true,

  // FIX 1 (YUK-95 P5 review) — `auto` / `relation` provenance live on the child
  // crossLinkBlock (declared on CrossLinkBlock above), NOT on the container: the
  // read renderer + edit NodeView both read the chip off each child's attrs via
  // `autoLinkChip(child.attrs)`, and the worker writes them per-child. They were
  // misplaced here and never read at container level, so they are removed.
  addAttributes() {
    return {
      id: { default: null },
      title: { default: 'Related' },
    };
  },

  parseHTML() {
    return [{ tag: 'aside[data-node-type="autoLinksContainer"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'aside',
      mergeAttributes(HTMLAttributes, { 'data-node-type': AUTO_LINKS_CONTAINER_NODE }),
      0,
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: autoZoneReorderOnlyKey,
        // Reject any transaction that adds/deletes a child inside an
        // AutoLinksContainer by hand. Programmatic full-container replacement
        // (setContent / the dismiss replace_block) keeps the multiset equal or
        // swaps the whole container, so it passes; only piecemeal user edits
        // that change the child multiset are blocked.
        filterTransaction(tr: Transaction, state: EditorState) {
          if (!tr.docChanged) return true;
          return isAllowedAutoZoneChange(state.doc, tr.doc);
        },
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(BlockNodeView);
  },
});

export function blockTreeEditorExtensions(crossLink?: CrossLinkSuggestionContext) {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3, 4] },
      link: false,
    }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      defaultProtocol: 'https',
    }),
    SemanticBlock,
    CrossLinkBlock,
    ArtifactRefBlock,
    CalloutBlock,
    AutoLinksContainer,
    // `@`-triggered cross_link picker (Wave 7 P5 Lane-A). Only wired when an
    // artifactId is provided so self-links can be excluded from search.
    ...(crossLink ? [createCrossLinkSuggestionExtension(crossLink)] : []),
  ];
}
