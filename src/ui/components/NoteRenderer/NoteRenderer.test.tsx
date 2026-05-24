import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NoteRenderer } from './NoteRenderer';

describe('NoteRenderer — basic markdown contract', () => {
  it('renders bullet lists into <ul><li>', () => {
    const html = renderToString(
      <NoteRenderer kind="note" notation="wenyan">
        {'- first\n- second\n- third'}
      </NoteRenderer>,
    );
    expect(html).toContain('<ul>');
    expect(html).toMatch(/<li>first<\/li>/);
    expect(html).toMatch(/<li>second<\/li>/);
    expect(html).toMatch(/<li>third<\/li>/);
  });

  it('renders fenced code with language class', () => {
    const md = '```ts\nconst x = 1;\n```';
    const html = renderToString(
      <NoteRenderer kind="note" notation="code">
        {md}
      </NoteRenderer>,
    );
    expect(html).toContain('<pre>');
    expect(html).toContain('<code class="language-ts">');
    expect(html).toContain('const x = 1;');
  });

  it('renders inline code', () => {
    const html = renderToString(
      <NoteRenderer kind="note">{'use `pnpm test` to run'}</NoteRenderer>,
    );
    expect(html).toContain('<code>pnpm test</code>');
  });

  it('renders images with alt text', () => {
    const html = renderToString(
      <NoteRenderer kind="note">{'![diagram](/img/d.png)'}</NoteRenderer>,
    );
    expect(html).toMatch(/<img[^>]+src="\/img\/d\.png"/);
    expect(html).toMatch(/<img[^>]+alt="diagram"/);
  });

  it('renders emphasis and strong', () => {
    const html = renderToString(
      <NoteRenderer kind="note">{'this is **bold** and *italic*'}</NoteRenderer>,
    );
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
  });

  it('renders blockquote', () => {
    const html = renderToString(
      <NoteRenderer kind="note">{'> a quote\n> two lines'}</NoteRenderer>,
    );
    expect(html).toContain('<blockquote>');
  });

  it('keeps KaTeX gating: latex notation parses $...$', () => {
    const html = renderToString(
      <NoteRenderer kind="note" notation="latex">
        {'energy is $E = mc^2$'}
      </NoteRenderer>,
    );
    expect(html).toContain('class="katex"');
  });

  it('skips KaTeX when notation is wenyan (raw $...$ text)', () => {
    const html = renderToString(
      <NoteRenderer kind="note" notation="wenyan">
        {'文言：$\\sqrt{2}$'}
      </NoteRenderer>,
    );
    expect(html).not.toContain('class="katex"');
    expect(html).toContain('文言：');
  });

  it('applies note-prose class for kind=note', () => {
    const html = renderToString(<NoteRenderer kind="note">hello</NoteRenderer>);
    expect(html).toContain('note-prose');
    expect(html).not.toContain('note-prose--verification');
  });

  it('applies note-prose--verification modifier for kind=verification', () => {
    const html = renderToString(<NoteRenderer kind="verification">hello</NoteRenderer>);
    expect(html).toContain('note-prose');
    expect(html).toContain('note-prose--verification');
  });

  it('forwards user className alongside note-prose', () => {
    const html = renderToString(
      <NoteRenderer kind="note" className="custom-x">
        hello
      </NoteRenderer>,
    );
    expect(html).toContain('note-prose');
    expect(html).toContain('custom-x');
  });
});
