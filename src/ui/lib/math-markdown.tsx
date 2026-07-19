import type { ComponentProps, HTMLAttributes, ReactElement } from 'react';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import { useAssetUrl } from './assets';
import { MarkdownRenderer, type MarkdownRendererProps } from './markdown-renderer';

export function assetIdFromContentUrl(src: string | undefined): string | null {
  if (!src) return null;
  const match = /^\/api\/assets\/([^/]+)\/content(?:[?#].*)?$/.exec(src);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

type MarkdownImageProps = ComponentProps<'img'> & { node?: unknown };

/** Resolve protected source_asset URLs through apiFetch before handing bytes to <img>. */
function MarkdownImage({ node: _node, src, alt, ...props }: MarkdownImageProps): ReactElement {
  const assetId = assetIdFromContentUrl(src);
  const asset = useAssetUrl(assetId);
  if (!assetId) return <img {...props} src={src} alt={alt} />;
  if (asset.error) {
    return <span role="img" aria-label={alt || '图片加载失败'} data-asset-error="true" />;
  }
  return (
    <img
      {...props}
      src={asset.url ?? undefined}
      alt={alt}
      aria-busy={asset.loading || undefined}
      data-asset-id={assetId}
    />
  );
}

export interface MathMarkdownProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Markdown source. Supports inline `$...$` and block `$$...$$` math. */
  children: string;
  /**
   * Subject's renderConfig.notation. KaTeX plugin chain only activates when
   * notation === 'latex'. Other values (or undefined) skip math parsing —
   * `$...$` text passes through as raw markdown.
   *
   * Callers should thread this from their subject's render model
   * (e.g. `currentSubjectModel.renderConfig.notation`). Defaulting to 'latex'
   * was rejected (Codex P1, PR #83): it would silently enable LaTeX parsing
   * for wenyan content where `$...$` is incidental punctuation.
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
export function MathMarkdown({ children, notation, ...divProps }: MathMarkdownProps): ReactElement {
  const remarkPlugins: MarkdownRendererProps['remarkPlugins'] = [];
  const rehypePlugins: MarkdownRendererProps['rehypePlugins'] = [];
  if (notation === 'latex') {
    remarkPlugins.push(remarkMath);
    rehypePlugins.push(rehypeKatex);
  }
  return (
    <MarkdownRenderer
      {...divProps}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={{ img: MarkdownImage }}
    >
      {children}
    </MarkdownRenderer>
  );
}
