import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownRenderer } from './markdown-renderer';

describe('MarkdownRenderer', () => {
  it('renders Markdown while keeping dollar syntax as plain text', () => {
    const html = renderToString(
      <MarkdownRenderer className="message">{'**重点**：$\\sqrt{2}$'}</MarkdownRenderer>,
    );

    expect(html).toContain('class="message"');
    expect(html).toContain('<strong>重点</strong>');
    expect(html).toContain('$\\sqrt{2}$');
    expect(html).not.toContain('class="katex"');
  });

  it('does not enable raw HTML', () => {
    const html = renderToString(
      <MarkdownRenderer>{'<script>alert(1)</script><b>unsafe</b>'}</MarkdownRenderer>,
    );

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
  });

  it('keeps the global Copilot module graph free of eager Markdown and math plugins', () => {
    const copilotSource = readFileSync(
      join(process.cwd(), 'src/capabilities/copilot/ui/CopilotDock.tsx'),
      'utf8',
    );
    const deferredSource = readFileSync(
      join(process.cwd(), 'src/ui/lib/deferred-markdown-renderer.tsx'),
      'utf8',
    );
    const rendererSource = readFileSync(
      join(process.cwd(), 'src/ui/lib/markdown-renderer.tsx'),
      'utf8',
    );

    expect(copilotSource).not.toContain("from '@/ui/lib/markdown-renderer'");
    expect(deferredSource).toContain("import('./markdown-renderer')");
    expect(deferredSource).not.toContain("import { MarkdownRenderer } from './markdown-renderer'");
    expect(copilotSource).not.toContain("from '@/ui/lib/math-markdown'");
    expect(rendererSource).not.toMatch(/from ['"](?:remark-math|rehype-katex|katex)/);
  });
});
