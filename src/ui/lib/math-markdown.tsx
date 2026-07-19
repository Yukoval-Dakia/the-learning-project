import type { HTMLAttributes, ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { MarkdownRenderer, type MarkdownRendererProps } from './markdown-renderer';

type MathPlugins = {
  remarkPlugins: NonNullable<MarkdownRendererProps['remarkPlugins']>;
  rehypePlugins: NonNullable<MarkdownRendererProps['rehypePlugins']>;
};

// rehype-katex pulls the full katex library (~270KB) into whatever chunk imports
// it. KaTeX is only ever needed when a subject renders LaTeX (notation ===
// 'latex'), so load the remark-math + rehype-katex plugin chain on demand rather
// than statically. This keeps katex out of the practice/review route chunks for
// non-latex subjects (e.g. Phase-1 wenyan). Mirrors deferred-markdown-renderer's
// module-memo pattern: once the chunk is warm, later latex mounts render katex
// synchronously with no flicker.
let loadedMathPlugins: MathPlugins | null = null;
let mathPluginsPromise: Promise<MathPlugins> | null = null;

function loadMathPlugins(): Promise<MathPlugins> {
  if (loadedMathPlugins) return Promise.resolve(loadedMathPlugins);
  mathPluginsPromise ??= Promise.all([import('remark-math'), import('rehype-katex')])
    .then(([remarkMath, rehypeKatex]) => {
      loadedMathPlugins = {
        remarkPlugins: [remarkMath.default],
        rehypePlugins: [rehypeKatex.default],
      };
      return loadedMathPlugins;
    })
    .catch((error: unknown) => {
      // Don't cache a rejected load (e.g. transient chunk-fetch failure) — clear
      // the memo so the next latex render retries the import instead of failing
      // forever. The plain-markdown fallback stays readable meanwhile.
      mathPluginsPromise = null;
      throw error;
    });
  return mathPluginsPromise;
}

const NO_MATH_PLUGINS: MathPlugins = { remarkPlugins: [], rehypePlugins: [] };

export interface MathMarkdownProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Markdown source. Supports inline `$...$` and block `$$...$$` math. */
  children: string;
  /**
   * Subject's renderConfig.notation. KaTeX plugin chain only activates when
   * notation === 'latex'. Other values (or undefined) skip math parsing —
   * `$...$` text passes through as raw markdown and the katex chunk is never
   * fetched.
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
 * When notation === 'latex', the KaTeX plugin chain is loaded lazily on first
 * render: the content shows as plain markdown for one frame, then re-renders with
 * math once the chunk arrives (a warm module cache makes subsequent latex mounts
 * synchronous). Non-latex renders never touch the katex chunk.
 *
 * Whitespace: react-markdown unwraps a single paragraph into <p>, but we wrap in a
 * div container so callers can apply layout styling. The wrapping div forwards
 * arbitrary HTMLAttributes (className, style, data-*) so subjectContentProps-style
 * helpers can be spread directly.
 */
export function MathMarkdown({ children, notation, ...divProps }: MathMarkdownProps): ReactElement {
  const isLatex = notation === 'latex';
  // Initialize from the module cache so an already-warm latex mount renders
  // synchronously (no fallback frame); a cold mount starts null and loads below.
  const [mathPlugins, setMathPlugins] = useState<MathPlugins | null>(() =>
    isLatex ? loadedMathPlugins : null,
  );

  useEffect(() => {
    if (!isLatex || mathPlugins) return;
    let cancelled = false;
    void loadMathPlugins()
      .then((plugins) => {
        if (!cancelled) setMathPlugins(plugins);
      })
      .catch(() => {
        // Keep the readable plain-markdown fallback mounted; a later mount retries.
      });
    return () => {
      cancelled = true;
    };
  }, [isLatex, mathPlugins]);

  const active = isLatex && mathPlugins ? mathPlugins : NO_MATH_PLUGINS;

  return (
    <MarkdownRenderer
      {...divProps}
      remarkPlugins={active.remarkPlugins}
      rehypePlugins={active.rehypePlugins}
    >
      {children}
    </MarkdownRenderer>
  );
}
