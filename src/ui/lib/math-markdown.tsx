import type { ComponentProps, HTMLAttributes, ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';

export interface MathMarkdownProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Markdown source. Supports inline `$...$` and block `$$...$$` math. */
  children: string;
  /**
   * Profile rendering hint. If 'latex' (math), KaTeX plugin chain is enabled.
   * Otherwise pure markdown rendering (wenyan profile renderConfig.notation = 'wenyan').
   *
   * Default 'latex' for backwards-compat at callers that already opt into LaTeX.
   */
  notation?: 'latex' | 'wenyan' | 'plaintext' | 'code';
}

/**
 * Shared markdown renderer. Applied wherever LaTeX math may appear in user-facing
 * content: review prompt / reference / feedback; note section body; teaching turn text.
 *
 * Whitespace: react-markdown unwraps a single paragraph into <p>, but we wrap in a
 * div container so callers can apply layout styling. The wrapping div forwards
 * arbitrary HTMLAttributes (className, style, data-*) so subjectContentProps-style
 * helpers can be spread directly.
 */
export function MathMarkdown({
  children,
  notation = 'latex',
  ...divProps
}: MathMarkdownProps): ReactElement {
  const remarkPlugins: ComponentProps<typeof ReactMarkdown>['remarkPlugins'] = [];
  const rehypePlugins: ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [];
  if (notation === 'latex') {
    remarkPlugins.push(remarkMath);
    rehypePlugins.push(rehypeKatex);
  }
  return (
    <div {...divProps}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
