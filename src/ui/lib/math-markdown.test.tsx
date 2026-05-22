import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MathMarkdown } from './math-markdown';

describe('MathMarkdown — KaTeX rendering', () => {
  it('renders inline math with KaTeX classes when notation=latex (default)', () => {
    const html = renderToString(<MathMarkdown>{'square root: $\\sqrt{2}$'}</MathMarkdown>);
    expect(html).toContain('class="katex"');
    expect(html).toContain('square root:');
  });

  it('renders block math with display class', () => {
    // remark-math treats `$$...$$` as block when it's on its own paragraph
    // (surrounded by blank lines or at edges). Inline form `$$x$$` mid-text
    // would parse as inline.
    const html = renderToString(<MathMarkdown>{'\n$$\nx^2 + 1\n$$\n'}</MathMarkdown>);
    expect(html).toContain('katex-display');
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
});
