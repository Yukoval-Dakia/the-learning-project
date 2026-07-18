import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeferredMarkdownRenderer } from './deferred-markdown-renderer';

describe('DeferredMarkdownRenderer', () => {
  it('keeps escaped source text readable before the Markdown chunk resolves', () => {
    const html = renderToString(
      <DeferredMarkdownRenderer className="message">
        {'**重点**\n<script>alert(1)</script>'}
      </DeferredMarkdownRenderer>,
    );

    expect(html).toContain('class="message"');
    expect(html).toContain('white-space:pre-wrap');
    expect(html).toContain('**重点**');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });
});
