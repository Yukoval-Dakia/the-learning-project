import type { ComponentProps, HTMLAttributes, ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';

export interface MarkdownRendererProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  children: string;
  remarkPlugins?: ComponentProps<typeof ReactMarkdown>['remarkPlugins'];
  rehypePlugins?: ComponentProps<typeof ReactMarkdown>['rehypePlugins'];
}

/**
 * Safe Markdown shell with no optional syntax plugins in its module graph.
 * ReactMarkdown ignores raw HTML by default; callers opt into math support through
 * MathMarkdown instead of making every Markdown-only surface download KaTeX.
 */
export function MarkdownRenderer({
  children,
  remarkPlugins,
  rehypePlugins,
  ...divProps
}: MarkdownRendererProps): ReactElement {
  return (
    <div {...divProps}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
