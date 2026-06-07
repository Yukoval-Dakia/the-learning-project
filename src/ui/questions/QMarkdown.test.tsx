// YUK-288 题库 UI — QMarkdown notation-gating test (no DB; fast partition).
// Verifies the PR #83 红线: KaTeX activates ONLY when notation==='latex'; for
// wenyan / undefined, `$...$` passes through as raw text (it's punctuation).

import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QMarkdown } from './QMarkdown';

describe('QMarkdown notation gating', () => {
  it('renders KaTeX when notation=latex', () => {
    const html = renderToString(<QMarkdown text={'积分 $x^2$ 收敛'} notation="latex" />);
    expect(html).toContain('katex');
  });

  it('does NOT parse math when notation is undefined (wenyan default)', () => {
    const html = renderToString(<QMarkdown text={'青取之$于$蓝'} />);
    expect(html).not.toContain('katex');
    // the literal $ survives as text rather than being consumed as a math delim.
    expect(html).toContain('$');
  });

  it('does NOT parse math when notation=wenyan', () => {
    const html = renderToString(<QMarkdown text={'之$乎$者也'} notation="wenyan" />);
    expect(html).not.toContain('katex');
  });

  it('carries the q-md class plus any extra className', () => {
    const html = renderToString(<QMarkdown text="hi" className="extra" />);
    expect(html).toContain('q-md');
    expect(html).toContain('extra');
  });
});
