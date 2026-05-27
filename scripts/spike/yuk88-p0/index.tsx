import { writeFile } from 'node:fs/promises';
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { JSDOM } from 'jsdom';
import React from 'react';
import fixture from './fixture.json' with { type: 'json' };
import { assertIdleMock } from './idle-mock';
import { type JsonDoc, assertSplitMergeAndMarkWrong } from './invariants';

const dom = new JSDOM('<!doctype html><html><body><main id="app"></main></body></html>');
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: dom.window.navigator,
});

function SemanticBlockView({ node }: { node: { attrs: Record<string, unknown> } }) {
  return (
    <NodeViewWrapper
      as="section"
      data-block-id={String(node.attrs.id)}
      data-semantic-kind={String(node.attrs.semantic_kind)}
    >
      <strong>{String(node.attrs.semantic_kind)}</strong>
      <NodeViewContent as="div" />
    </NodeViewWrapper>
  );
}

function ArtifactRefView({ node }: { node: { attrs: Record<string, unknown> } }) {
  const target = node.attrs.target as { artifact_id?: string; kind?: string } | undefined;
  return (
    <NodeViewWrapper as="aside" data-artifact-id={target?.artifact_id}>
      artifact_ref: {target?.kind}/{target?.artifact_id}
    </NodeViewWrapper>
  );
}

const SemanticBlock = Node.create({
  name: 'semanticBlock',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      id: { default: null },
      semantic_kind: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: 'section[data-type="semantic-block"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['section', mergeAttributes(HTMLAttributes, { 'data-type': 'semantic-block' }), 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(SemanticBlockView);
  },
});

const CrossLink = Node.create({
  name: 'crossLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      target: { default: null },
      label: { default: 'cross_link' },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-type="cross-link"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    const label = String(HTMLAttributes.label ?? 'cross_link');
    return ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'cross-link' }), `↗ ${label}`];
  },
});

const ArtifactRefBlock = Node.create({
  name: 'artifactRefBlock',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      id: { default: null },
      target: { default: null },
      label: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: 'aside[data-type="artifact-ref"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['aside', mergeAttributes(HTMLAttributes, { 'data-type': 'artifact-ref' })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ArtifactRefView);
  },
});

const editor = new (await import('@tiptap/core')).Editor({
  element: document.querySelector('#app') as HTMLElement,
  extensions: [StarterKit, SemanticBlock, CrossLink, ArtifactRefBlock],
  content: fixture,
});

const roundTrip = editor.getJSON() as JsonDoc;
const invariants = assertSplitMergeAndMarkWrong(roundTrip);
const idle = assertIdleMock(roundTrip);
const editorDomHtml = editor.view.dom.outerHTML;
const editorHtml = editor.getHTML();

const summary = {
  tiptap_version: '3.23.6',
  fixture_shape: 'TipTap/ProseMirror doc.toJSON()',
  editor_text: editor.getText({ blockSeparator: '\n' }),
  editor_dom_html_sample: editorDomHtml,
  editor_html_sample: editorHtml,
  round_trip: roundTrip,
  split_merge_mark_wrong: invariants,
  idle_mock: idle,
  conclusion: {
    pm_doc_shape: 'viable',
    mark_wrong_anchor: 'stable when split keeps original block id and creates one new id',
    idle_coordination: 'defer while editing, flush on idle, force flush on timeout',
    adr_0020_adjustment:
      'P1/P2 should explicitly require editor split commands to preserve the left block attrs.id and mint a fresh id only for the new right block.',
  },
};

await writeFile('snapshots.json', `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary.conclusion, null, 2));
editor.destroy();
