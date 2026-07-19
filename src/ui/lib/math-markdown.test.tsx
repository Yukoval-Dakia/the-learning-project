// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { MathMarkdown } from './math-markdown';

afterEach(() => {
  cleanup();
});

describe('MathMarkdown — KaTeX rendering', () => {
  // Non-latex paths render synchronously and never load the katex chunk.
  it('skips KaTeX plugin chain by default (notation undefined)', () => {
    const html = renderToString(<MathMarkdown>{'wenyan: $\\sqrt{2}$ as text'}</MathMarkdown>);
    // No notation prop → no KaTeX parsing
    expect(html).not.toContain('class="katex"');
    expect(html).toContain('wenyan:');
  });

  it('skips KaTeX plugin chain when notation=wenyan (pure markdown)', () => {
    const html = renderToString(
      <MathMarkdown notation="wenyan">{'文言文：$\\sqrt{2}$'}</MathMarkdown>,
    );
    // No katex class — math syntax surfaces as raw text
    expect(html).not.toContain('class="katex"');
    expect(html).toContain('文言文');
  });

  it('renders plain markdown (lists, emphasis) regardless of notation', () => {
    const html = renderToString(<MathMarkdown>{'- **bold** item\n- second'}</MathMarkdown>);
    expect(html).toContain('<ul>');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('applies className to wrapping div', () => {
    const html = renderToString(<MathMarkdown className="prose-test">hello</MathMarkdown>);
    expect(html).toContain('class="prose-test"');
  });

  // Latex path lazy-loads the katex plugin chunk, then renders identically to the
  // former eager behavior (the deferral is the only change).
  it('renders inline math with KaTeX classes when notation=latex (after lazy load)', async () => {
    const { container } = render(
      <MathMarkdown notation="latex">{'square root: $\\sqrt{2}$'}</MathMarkdown>,
    );
    await waitFor(() => {
      expect(container.querySelector('.katex')).not.toBeNull();
    });
    expect(container.textContent).toContain('square root:');
  });

  it('renders block math with display class (after lazy load)', async () => {
    // remark-math treats `$$...$$` as block when it's on its own paragraph
    // (surrounded by blank lines or at edges). Inline form `$$x$$` mid-text
    // would parse as inline.
    const { container } = render(
      <MathMarkdown notation="latex">{'\n$$\nx^2 + 1\n$$\n'}</MathMarkdown>,
    );
    await waitFor(() => {
      expect(container.querySelector('.katex-display')).not.toBeNull();
    });
  });
});
