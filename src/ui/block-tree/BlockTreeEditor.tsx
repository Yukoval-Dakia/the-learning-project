'use client';

import type { JSONContent } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/ui/primitives/Button';
import { coerceBlockTreeDoc, markdownToBodyBlocks } from './pm';
import { blockTreeEditorExtensions } from './tiptap-extensions';
import type { BlockTreeDoc } from './types';

interface BlockTreeEditorProps {
  initialContent: BlockTreeDoc;
  saving?: boolean;
  onSave: (content: BlockTreeDoc) => Promise<void> | void;
  onCancel: () => void;
  onEditorBlur?: () => void;
}

export function BlockTreeEditor({
  initialContent,
  saving = false,
  onSave,
  onCancel,
  onEditorBlur,
}: BlockTreeEditorProps) {
  const [pasteDraft, setPasteDraft] = useState('');
  const extensions = useMemo(() => blockTreeEditorExtensions(), []);
  const editor = useEditor({
    extensions,
    content: initialContent as JSONContent,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'block-tree-editor-content',
      },
    },
  });

  useEffect(() => {
    if (!editor) return;
    editor.commands.setContent(initialContent as JSONContent, { emitUpdate: false });
  }, [editor, initialContent]);

  if (!editor) {
    return <div className="block-tree-editor-shell">加载编辑器...</div>;
  }
  const activeEditor = editor;

  const canSave = !saving;

  function replaceWithMarkdown() {
    const next = markdownToBodyBlocks(pasteDraft, 'paste');
    activeEditor.commands.setContent(next as JSONContent);
    setPasteDraft('');
  }

  async function save() {
    await onSave(coerceBlockTreeDoc(activeEditor.getJSON()));
  }

  return (
    <div
      className="block-tree-editor-shell"
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
        onEditorBlur?.();
      }}
    >
      <div className="block-tree-editor-toolbar" aria-label="Block tree editor toolbar">
        <Button
          variant="quiet"
          size="sm"
          icon="arrowL"
          onClick={() => activeEditor.chain().focus().undo().run()}
          disabled={!activeEditor.can().undo()}
        >
          Undo
        </Button>
        <Button
          variant="quiet"
          size="sm"
          icon="arrowR"
          onClick={() => activeEditor.chain().focus().redo().run()}
          disabled={!activeEditor.can().redo()}
        >
          Redo
        </Button>
        <Button
          variant="quiet"
          size="sm"
          icon="check"
          onClick={() => activeEditor.chain().focus().toggleBold().run()}
        >
          B
        </Button>
        <Button
          variant="quiet"
          size="sm"
          icon="pen"
          onClick={() => activeEditor.chain().focus().toggleItalic().run()}
        >
          I
        </Button>
        <Button
          variant="quiet"
          size="sm"
          icon="hash"
          onClick={() => activeEditor.chain().focus().toggleCode().run()}
        >
          Code
        </Button>
        <div className="block-tree-editor-toolbar-spacer" />
        <Button variant="ghost" size="sm" icon="x" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" icon="check" disabled={!canSave} onClick={save}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </div>
      <div>
        <EditorContent editor={activeEditor} />
      </div>
      <details className="block-tree-paste-box">
        <summary>Paste markdown</summary>
        <textarea
          className="artifact-section-textarea"
          rows={4}
          value={pasteDraft}
          onChange={(event) => setPasteDraft(event.target.value)}
        />
        <Button
          variant="secondary"
          size="sm"
          icon="upload"
          onClick={replaceWithMarkdown}
          disabled={pasteDraft.trim().length === 0}
        >
          Import
        </Button>
      </details>
    </div>
  );
}
