import type { HTMLAttributes, ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { MarkdownRenderer, type MarkdownRendererProps } from './markdown-renderer';

type MathPlugins = {
  remarkPlugins: NonNullable<MarkdownRendererProps['remarkPlugins']>;
  rehypePlugins: NonNullable<MarkdownRendererProps['rehypePlugins']>;
};

// rehype-katex pulls the full katex library (~270KB) into whatever chunk imports
// it. KaTeX is only ever needed when a subject renders LaTeX (notation ===
// 'latex'), so it is loaded on demand via dynamic import() rather than statically
// — keeping katex out of the practice/review route chunks for non-latex subjects
// (e.g. Phase-1 wenyan). Both the client path below and the SSR warm-up use
// import(), so katex is never a static edge in any chunk; it lands in its own
// dynamic chunk. Mirrors deferred-markdown-renderer's module-memo pattern.
let loadedMathPlugins: MathPlugins | null = null;
let mathPluginsPromise: Promise<MathPlugins> | null = null;

function cacheMathPlugins(
  remarkMath: MathPlugins['remarkPlugins'][number],
  rehypeKatex: MathPlugins['rehypePlugins'][number],
): MathPlugins {
  loadedMathPlugins = { remarkPlugins: [remarkMath], rehypePlugins: [rehypeKatex] };
  return loadedMathPlugins;
}

function loadMathPlugins(): Promise<MathPlugins> {
  if (loadedMathPlugins) return Promise.resolve(loadedMathPlugins);
  mathPluginsPromise ??= Promise.all([import('remark-math'), import('rehype-katex')])
    .then(([remarkMath, rehypeKatex]) => cacheMathPlugins(remarkMath.default, rehypeKatex.default))
    .catch((error: unknown) => {
      // Don't cache a rejected load (e.g. transient chunk-fetch failure) — clear
      // the memo so the next latex render retries the import instead of failing
      // forever. The plain-markdown fallback stays readable meanwhile.
      mathPluginsPromise = null;
      throw error;
    });
  return mathPluginsPromise;
}

// A non-browser render (SSR / react-dom/server renderToString, incl. the repo's
// SSR unit tests) has no effect pass, so the lazy client path below never runs.
// Warm the plugin cache at module evaluation there so KaTeX renders synchronously
// on the first (only) render. `import.meta.env.SSR` is a build-time constant: the
// client build inlines it to `false`, so this top-level-await block is dead-code
// eliminated from every client chunk — the browser never eagerly loads katex and
// reaches it only through the on-demand loadMathPlugins() path.
if (import.meta.env.SSR) {
  const [remarkMath, rehypeKatex] = await Promise.all([
    import('remark-math'),
    import('rehype-katex'),
  ]);
  cacheMathPlugins(remarkMath.default, rehypeKatex.default);
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
 * When notation === 'latex' on the browser, the KaTeX plugin chain is loaded
 * lazily on first render: the content shows as plain markdown for one frame, then
 * re-renders with math once the chunk arrives (a warm module cache makes later
 * latex mounts synchronous). Server-side renders resolve KaTeX synchronously (see
 * the module warm-up above). Non-latex renders never touch the katex chunk.
 *
 * Whitespace: react-markdown unwraps a single paragraph into <p>, but we wrap in a
 * div container so callers can apply layout styling. The wrapping div forwards
 * arbitrary HTMLAttributes (className, style, data-*) so subjectContentProps-style
 * helpers can be spread directly.
 */
export function MathMarkdown({ children, notation, ...divProps }: MathMarkdownProps): ReactElement {
  const isLatex = notation === 'latex';
  // Initialize from the module cache so an already-warm latex mount (or any SSR
  // render, where the cache is warmed at module eval) renders synchronously with
  // no fallback frame; a cold browser mount starts null and loads in the effect.
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
