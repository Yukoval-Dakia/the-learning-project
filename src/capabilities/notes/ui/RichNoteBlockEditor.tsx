import { Extension, type Extensions, type JSONContent, Mark, Node, getSchema } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useCallback, useMemo, useRef, useState } from 'react';
import { noteBlockSource } from '../shared/note-block-source';
import type { BodyBlock } from './notes-api';

const standardSchema = getSchema([StarterKit]);

// One editor owns one anchored outer block. Enter can split its paragraphs, not
// its identity; inserting/removing/reordering outer blocks stays with NoteEditor.
function blockExtensions(block: BodyBlock): Extensions {
  const attributes = new Map<string, Set<string>>();
  const collect = (node: JSONContent) => {
    if (node.type && node.attrs) {
      const keys = attributes.get(node.type) ?? new Set<string>();
      const builtIn = standardSchema.nodes[node.type] ?? standardSchema.marks[node.type];
      for (const key of Object.keys(node.attrs)) {
        if (!(key in (builtIn?.spec.attrs ?? {}))) keys.add(key);
      }
      attributes.set(node.type, keys);
    }
    node.content?.forEach(collect);
    node.marks?.forEach(collect);
  };
  collect(block as JSONContent);
  return [
    StarterKit.configure({
      document: false,
      trailingNode: false,
      underline: false,
      link: { openOnClick: false },
    }),
    Node.create({ name: 'doc', topNode: true, content: block.type }),
    Extension.create({
      name: 'noteOwnedAttributes',
      addGlobalAttributes: () =>
        [...attributes].map(([type, keys]) => ({
          types: [type],
          attributes: Object.fromEntries(
            [...keys].map((key) => [
              key,
              {
                default: null,
                rendered: false,
                keepOnSplit: false,
              },
            ]),
          ),
        })),
    }),
    ...['semanticBlock', 'calloutBlock'].map((name) =>
      Node.create({
        name,
        group: 'block',
        content: 'block+',
        isolating: true,
        defining: true,
        parseHTML: () => [{ tag: `div[data-note-node="${name}"]` }],
        renderHTML: () => ['div', { 'data-note-node': name }, 0],
      }),
    ),
    ...[
      'crossLinkBlock',
      'artifactRefBlock',
      'questionRefBlock',
      'image',
      'inlineMath',
      'blockMath',
    ].map((name) =>
      Node.create({
        name,
        group: name === 'inlineMath' ? 'inline' : 'block',
        inline: name === 'inlineMath',
        atom: true,
        selectable: true,
        renderHTML: ({ node }) => [
          'span',
          { 'data-note-node': name, contenteditable: 'false' },
          String(
            node.attrs.title ??
              node.attrs.prompt_preview ??
              node.attrs.latex ??
              node.attrs.alt ??
              node.attrs.artifact_id ??
              name,
          ),
        ],
      }),
    ),
    ...[
      ['strong', 'strong'],
      ['em', 'em'],
    ].map(([name, tag]) =>
      Mark.create({
        name,
        renderHTML: () => [tag, 0],
      }),
    ),
  ];
}

// The explicit command NoteEditor uses when a mounted editor must show a block it
// did not emit itself (e.g. an id-less block whose index key now holds another
// block after insert/remove/move). Typing never goes through here, so the cursor
// and undo history of the editing block are untouched.
export type BlockEditorAdapter = { replace: (block: BodyBlock) => void };
export type BlockEditorRegistry = Map<string, BlockEditorAdapter>;

type Props = {
  block: BodyBlock;
  label: string;
  onChange: (block: BodyBlock) => void;
  registry?: BlockEditorRegistry;
  registryKey?: string;
};

function synchronizeSources(node: JSONContent): JSONContent {
  const projected = {
    ...node,
    ...(node.content ? { content: node.content.map(synchronizeSources) } : {}),
  };
  if (node.attrs?.source_markdown != null) {
    projected.attrs = { ...node.attrs, source_markdown: noteBlockSource(projected) };
  }
  return projected;
}

export function RichNoteBlockEditor(props: Props) {
  const prepared = useMemo(() => {
    try {
      noteBlockSource(props.block);
      const extensions = blockExtensions(props.block);
      const schema = getSchema(extensions);
      schema.nodeFromJSON({ type: 'doc', content: [props.block] }).check();
      const schemaKey = JSON.stringify([
        props.block.type,
        ...Object.entries({ ...schema.nodes, ...schema.marks }).map(([name, type]) => [
          name,
          Object.keys(type.spec.attrs ?? {}).sort(),
        ]),
      ]);
      return { extensions, schemaKey };
    } catch {
      return null;
    }
  }, [props.block]);
  // Unknown/invalid stored structures are never silently coerced by TipTap.
  if (!prepared)
    return <div role="alert">此块包含暂不支持的结构，已保留原内容，不能直接编辑。</div>;
  return <EditableBlock key={prepared.schemaKey} {...props} extensions={prepared.extensions} />;
}

function EditableBlock({
  block,
  label,
  onChange,
  registry,
  registryKey,
  extensions,
}: Props & { extensions: Extensions }) {
  const current = useRef({ block, onChange });
  current.current = { block, onChange };
  // The block this editor currently shows: its own last emission, or the last
  // block applied through `replace`. Guards against echoing our own update back.
  const emitted = useRef(block);
  // TipTap 3.31 useEditor (deps = []) re-applies changed options itself after each
  // render via editor.setOptions, so the aria-label below follows `label` without
  // any extra sync here.
  const editor = useEditor({
    extensions,
    // Prepared above with the exact PM schema; the wire's nested content is unknown[].
    content: { type: 'doc', content: [block as JSONContent] },
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'nb-edit-area',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': label,
      },
    },
    onUpdate: ({ editor: active }) => {
      const content = active.getJSON().content?.[0];
      if (!content) return;
      const edited = synchronizeSources(content);
      const next: BodyBlock = {
        ...current.current.block,
        ...edited,
        type: current.current.block.type,
        attrs: {
          ...current.current.block.attrs,
          ...edited.attrs,
          id: current.current.block.attrs?.id,
          source_markdown: noteBlockSource(edited),
        },
      };
      emitted.current = next;
      current.current.onChange(next);
    },
  });
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const [adapter] = useState<BlockEditorAdapter>(() => ({
    replace: (next) => {
      if (next === emitted.current) return;
      const active = editorRef.current;
      // Not created yet: useEditor builds it from the latest `content` option.
      if (!active || active.isDestroyed) {
        emitted.current = next;
        return;
      }
      try {
        active.commands.setContent(
          { type: 'doc', content: [next as JSONContent] },
          { emitUpdate: false, errorOnInvalidContent: true },
        );
        emitted.current = next;
      } catch {
        // A block with another schema remounts this editor via schemaKey, and an
        // unsupported one renders the alert; neither may be coerced into this schema.
      }
    },
  }));
  // Register the replace command while this editor's host node is attached.
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !registry || registryKey === undefined) return;
      registry.set(registryKey, adapter);
      return () => {
        if (registry.get(registryKey) === adapter) registry.delete(registryKey);
      };
    },
    [adapter, registry, registryKey],
  );
  return <EditorContent ref={attach} editor={editor} />;
}
