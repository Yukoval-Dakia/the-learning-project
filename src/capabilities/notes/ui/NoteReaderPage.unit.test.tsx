// ADR-0033 D5 (YUK-203) — static-HTML tests for the NoteReader doc body. The
// unit partition runs in the `node` env with no jsdom / @testing-library, so
// (matching InteractiveArtifactRenderer / AutoEnrolledPanel precedent) we
// renderToString the PURE `NoteDocBody` — the page container's queries/state are
// not unit-tested on the node-only stack. Pins the three render modes the
// interactive-artifact wiring adds: interactive renderer / parse-fail notice /
// note-block (or empty) body.

import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NoteDocBody } from './NoteReaderPage';
import type { BodyBlock } from './notes-api';

const noop = () => {};

describe('NoteDocBody (NoteReader interactive wiring)', () => {
  it('type=interactive + html → mounts the sandboxed renderer (no empty-note copy)', () => {
    const html = renderToString(
      <NoteDocBody
        type="interactive"
        title="函数图像"
        interactive={{ html: '<p>plot</p>' }}
        blocks={[]}
        navigate={vi.fn()}
        onOpenQuestion={noop}
      />,
    );
    // the renderer's load-bearing iframe sandbox + a11y title.
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).toContain('class="note-interactive-frame"');
    expect(html).toContain('title="函数图像"');
    // the interactive body is NOT mistaken for an empty note.
    expect(html).not.toContain('空笔记');
  });

  it('type=interactive + null → degraded notice, no renderer (parse-fail signal)', () => {
    const html = renderToString(
      <NoteDocBody
        type="interactive"
        title="坏产物"
        interactive={null}
        blocks={[]}
        navigate={vi.fn()}
        onOpenQuestion={noop}
      />,
    );
    expect(html).not.toContain('sandbox="allow-scripts"');
    expect(html).not.toContain('note-interactive-frame');
    expect(html).toContain('互动内容暂时无法渲染');
    expect(html).toContain('quiet-empty');
  });

  it('note type + empty blocks → empty-note prompt (not the interactive renderer)', () => {
    const html = renderToString(
      <NoteDocBody
        type="note_atomic"
        title="空"
        interactive={null}
        blocks={[]}
        navigate={vi.fn()}
        onOpenQuestion={noop}
      />,
    );
    expect(html).toContain('空笔记');
    expect(html).not.toContain('note-interactive-frame');
    expect(html).not.toContain('互动内容暂时无法渲染');
  });

  it('note type + blocks → renders block content (not interactive / not empty)', () => {
    const blocks: BodyBlock[] = [
      {
        type: 'semanticBlock',
        attrs: { id: 'b1', semantic_kind: 'definition', source_markdown: '导数的定义' },
      },
    ];
    const html = renderToString(
      <NoteDocBody
        type="note_atomic"
        title="导数"
        interactive={null}
        blocks={blocks}
        navigate={vi.fn()}
        onOpenQuestion={noop}
      />,
    );
    expect(html).toContain('导数的定义');
    expect(html).not.toContain('空笔记');
    expect(html).not.toContain('note-interactive-frame');
  });
});
