'use client';

import { Node, mergeAttributes } from '@tiptap/core';
import Link from '@tiptap/extension-link';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
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

  addAttributes() {
    return {
      id: { default: null },
      artifact_id: { default: null },
      block_id: { default: null },
      title: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-node-type="crossLinkBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-node-type': CROSS_LINK_BLOCK_NODE })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(BlockNodeView);
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

export const AutoLinksContainer = Node.create({
  name: AUTO_LINKS_CONTAINER_NODE,
  group: 'block',
  content: '(crossLinkBlock | artifactRefBlock)*',
  defining: true,

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

  addNodeView() {
    return ReactNodeViewRenderer(BlockNodeView);
  },
});

export function blockTreeEditorExtensions() {
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
  ];
}
