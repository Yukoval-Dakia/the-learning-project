import type { ComponentProps, HTMLAttributes, ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { useAssetUrl } from './assets';
import { MarkdownRenderer, type MarkdownRendererProps } from './markdown-renderer';

type MathPlugins = {
  remarkPlugins: NonNullable<MarkdownRendererProps['remarkPlugins']>;
  rehypePlugins: NonNullable<MarkdownRendererProps['rehypePlugins']>;
};

// rehype-katex pulls the full katex library (~270KB) into whatever chunk imports
// it. KaTeX is only ever needed when a subject's notation is `katex` (or legacy
// `latex`), so it is loaded on demand via dynamic import() rather than statically
// — keeping katex out of the practice/review route chunks for non-math subjects
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
  // The stylesheet travels with the plugins: rehype-katex emits MathML for screen readers next to
  // the visual HTML, and only katex.min.css hides the MathML and lays out the HTML. Rendering
  // before it lands shows every formula twice (YUK-1379). Its fonts are bundled same-origin.
  // The root `katex` dependency exists only for this stylesheet and must stay on the version
  // rehype-katex renders with: 0.19 renamed .inner/.fix, so \neq drew as "/ =" (YUK-1446).
  mathPluginsPromise ??= Promise.all([
    import('remark-math'),
    import('rehype-katex'),
    import('katex/dist/katex.min.css'),
  ])
    .then(([remarkMath, rehypeKatex]) => cacheMathPlugins(remarkMath.default, rehypeKatex.default))
    .catch((error: unknown) => {
      // Don't cache a rejected load (e.g. transient chunk-fetch failure) — clear
      // the memo so the next math render retries the import instead of failing
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

// Ingested and model-written content also uses the LaTeX delimiters \( \) and \[ \]. remark-math
// only knows dollar signs, and CommonMark treats `\(` as an escaped bracket, so those formulas
// would show as source text. Code spans and fences are left untouched; a delimiter preceded by
// another backslash is a LaTeX line break, not an opener; a formula never crosses a blank line or
// a backtick, so an unclosed `\(` cannot swallow the following paragraphs.
const LATEX_DELIMITED =
  /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|(?<!\\)\\\[((?:(?!\n\s*\n)[^`])+?)\\\]|(?<!\\)\\\(((?:(?!\n\s*\n)[^`])+?)\\\)/g;

function normalizeMathDelimiters(source: string): string {
  if (!source.includes('\\(') && !source.includes('\\[')) return source;
  return source.replace(
    LATEX_DELIMITED,
    (
      match: string,
      code: string | undefined,
      display: string | undefined,
      inline: string | undefined,
      offset: number,
    ) => {
      if (code !== undefined) return match;
      // Keep neighbouring math apart: `$a$$b$` would parse as one broken formula.
      const prev = source.slice(Math.max(0, offset - 2), offset);
      const before = prev.endsWith('$') || prev === '\\)' || prev === '\\]' ? ' ' : '';
      const after = source[offset + match.length] === '$' ? ' ' : '';
      if (display !== undefined) {
        // A display formula that starts its own line becomes a math block, so it is centred;
        // mid-sentence it stays in the line.
        const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
        const indent = source.slice(lineStart, offset);
        if (/^[ \t]*$/.test(indent)) {
          return `$$\n${indent}${display.trim()}\n${indent}$$\n${indent}`;
        }
        return `${before}$$${display}$$${after}`;
      }
      return `${before}$${(inline ?? '').trim()}$${after}`;
    },
  );
}

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
  /** Markdown source. Supports `$...$` / `\\(...\\)` inline and `$$...$$` / `\\[...\\]` block math. */
  children: string;
  /**
   * Subject's renderConfig.notation. KaTeX plugin chain only activates when
   * notation is the canonical profile value `katex` (legacy callers may still
   * pass `latex`). Other values (or null/undefined) skip math parsing —
   * `$...$` text passes through as raw markdown and the katex chunk is never
   * fetched.
   *
   * Callers should thread this from their subject's render model
   * (e.g. `currentSubjectModel.renderConfig.notation`). Defaulting to 'latex'
   * was rejected (Codex P1, PR #83): it would silently enable LaTeX parsing
   * for wenyan content where `$...$` is incidental punctuation.
   */
  notation?: string | null;
}

/** Canonical KaTeX gate plus the pre-profile legacy spelling. */
export function isKatexNotation(notation?: string | null): boolean {
  return notation === 'katex' || notation === 'latex';
}

/**
 * Shared markdown renderer. Applied wherever LaTeX math may appear in user-facing
 * content: review prompt / reference / feedback; note section body; teaching turn text.
 *
 * When notation is `katex` (or legacy `latex`) on the browser, the KaTeX plugin chain is loaded
 * lazily on first render: the content shows as plain markdown for one frame, then
 * re-renders with math once the chunk arrives (a warm module cache makes later
 * math mounts synchronous). Server-side renders resolve KaTeX synchronously (see
 * the module warm-up above). Non-math renders never touch the katex chunk.
 *
 * Protected `/api/assets/<id>/content` images are routed through MarkdownImage so
 * their bytes load via the authenticated apiFetch blob URL (YUK-727), regardless
 * of notation.
 *
 * Whitespace: react-markdown unwraps a single paragraph into <p>, but we wrap in a
 * div container so callers can apply layout styling. The wrapping div forwards
 * arbitrary HTMLAttributes (className, style, data-*) so subjectContentProps-style
 * helpers can be spread directly.
 */
export function MathMarkdown({ children, notation, ...divProps }: MathMarkdownProps): ReactElement {
  const isKatex = isKatexNotation(notation);
  // Initialize from the module cache so an already-warm math mount (or any SSR
  // render, where the cache is warmed at module eval) renders synchronously with
  // no fallback frame; a cold browser mount starts null and loads in the effect.
  const [mathPlugins, setMathPlugins] = useState<MathPlugins | null>(() =>
    isKatex ? loadedMathPlugins : null,
  );

  useEffect(() => {
    if (!isKatex || mathPlugins) return;
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
  }, [isKatex, mathPlugins]);

  const active = isKatex && mathPlugins ? mathPlugins : NO_MATH_PLUGINS;
  const source = active === NO_MATH_PLUGINS ? children : normalizeMathDelimiters(children);
  return (
    <MarkdownRenderer
      {...divProps}
      remarkPlugins={active.remarkPlugins}
      rehypePlugins={active.rehypePlugins}
      components={{ img: MarkdownImage }}
    >
      {source}
    </MarkdownRenderer>
  );
}
