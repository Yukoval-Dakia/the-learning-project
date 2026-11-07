import type { ComponentProps, HTMLAttributes, ReactElement } from 'react';
import { type CSSProperties, type ElementType, useMemo, useSyncExternalStore } from 'react';
import remarkGfm from 'remark-gfm';
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
// Plugin code, not user state: a module-level cache and listener set are SSR-safe.
const mathPluginListeners = new Set<() => void>();

type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start: { offset?: number } };
  data?: unknown;
};

/**
 * `$$…$$` written on one line inside its own paragraph is, to remark-math, inline math — so a
 * formula the author set apart (the quadratic formula on its own line) came out in text style,
 * fractions squeezed small. A paragraph that holds nothing but one `$$`-delimited formula becomes
 * a display formula, the same node remark-math builds for a fenced `$$` block. Single-dollar
 * formulas stay inline wherever they are: the author chose the inline form.
 */
function remarkLoneDisplayMath() {
  return (tree: MdNode, file: { value?: unknown }) => {
    const source = String(file.value ?? '');
    const walk = (node: MdNode) => {
      const children = node.children;
      if (!children) return;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const only =
          child?.type === 'paragraph' && child.children?.length === 1
            ? child.children[0]
            : undefined;
        const start = only?.position?.start.offset;
        if (only?.type === 'inlineMath' && start !== undefined && source.startsWith('$$', start)) {
          const value = only.value ?? '';
          children[i] = {
            type: 'math',
            value,
            position: child.position,
            data: {
              hName: 'pre',
              hChildren: [
                {
                  type: 'element',
                  tagName: 'code',
                  properties: { className: ['language-math', 'math-display'] },
                  children: [{ type: 'text', value }],
                },
              ],
            },
          };
        } else if (child) {
          walk(child);
        }
      }
    };
    walk(tree);
  };
}

const LEADING_CLOSING = /^[，。；：！？、）》」』】,.;:!?)]+/;
const TRAILING_OPENING = /[（《「『【(]+$/;
/** A longer formula has to be free to wrap, so it can't be held on one line with its punctuation. */
const TIE_MAX_LATEX = 40;

interface HastLike {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastLike[];
}

function isInlineFormula(node: HastLike | undefined): boolean {
  const names = node?.properties?.className;
  return node?.type === 'element' && Array.isArray(names) && names.includes('katex');
}

function latexLength(node: HastLike): number | null {
  if (node.tagName === 'annotation') return node.children?.[0]?.value?.length ?? null;
  for (const child of node.children ?? []) {
    const length = latexLength(child);
    if (length !== null) return length;
  }
  return null;
}

/**
 * A browser may break on either side of a formula, even right before 「，」 or after 「（」. A short
 * formula goes in one no-wrap span with the punctuation that belongs to it.
 */
function tieMathPunctuation(node: HastLike): void {
  const children = node.children;
  if (!children) return;
  const tied: HastLike[] = [];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index] as HastLike;
    if (!isInlineFormula(child)) {
      tieMathPunctuation(child);
      tied.push(child);
      continue;
    }
    const previous = tied[tied.length - 1];
    const next = children[index + 1];
    const opening = previous?.type === 'text' ? previous.value?.match(TRAILING_OPENING)?.[0] : null;
    const closing = next?.type === 'text' ? next.value?.match(LEADING_CLOSING)?.[0] : null;
    if ((!opening && !closing) || (latexLength(child) ?? TIE_MAX_LATEX + 1) > TIE_MAX_LATEX) {
      tied.push(child);
      continue;
    }
    if (opening && previous?.value) previous.value = previous.value.slice(0, -opening.length);
    if (closing && next?.value) next.value = next.value.slice(closing.length);
    tied.push({
      type: 'element',
      tagName: 'span',
      properties: { className: ['un-math-tie'] },
      children: [
        ...(opening ? [{ type: 'text', value: opening }] : []),
        child,
        ...(closing ? [{ type: 'text', value: closing }] : []),
      ],
    });
  }
  node.children = tied;
}

const rehypeTieMathPunctuation = () => tieMathPunctuation;

function cacheMathPlugins(
  remarkMath: MathPlugins['remarkPlugins'][number],
  rehypeKatex: MathPlugins['rehypePlugins'][number],
): MathPlugins {
  loadedMathPlugins = {
    remarkPlugins: [remarkMath, remarkLoneDisplayMath],
    rehypePlugins: [rehypeKatex, rehypeTieMathPunctuation],
  };
  return loadedMathPlugins;
}

/** The last load failed: a formula reads better as its source than as a placeholder that never ends. */
let mathLoadFailed = false;

function loadMathPlugins(): Promise<MathPlugins> {
  if (loadedMathPlugins) return Promise.resolve(loadedMathPlugins);
  // The stylesheet travels with the plugins: rehype-katex emits MathML for screen readers next to
  // the visual HTML, and only katex.min.css hides the MathML and lays out the HTML. Rendering
  // before it lands shows every formula twice (YUK-1379). Its fonts are bundled same-origin.
  // The root `katex` dependency exists only for this stylesheet and must stay on the version
  // rehype-katex renders with: 0.19 renamed .inner/.fix, so \neq drew as "/ =" (YUK-1446).
  // mhchem (`$\ce{…}$`, `$\pu{…}$`, YUK-1548 §3.3) registers its macros into the katex module it
  // imports; that is the same katex@0.16.47 rehype-katex renders with, so it rides in the same load.
  if (!mathPluginsPromise && mathLoadFailed) {
    mathLoadFailed = false;
    for (const listener of mathPluginListeners) listener();
  }
  mathPluginsPromise ??= Promise.all([
    import('remark-math'),
    import('rehype-katex'),
    import('katex/dist/katex.min.css'),
    import('katex/contrib/mhchem'),
  ])
    .then(([remarkMath, rehypeKatex]) => {
      const plugins = cacheMathPlugins(remarkMath.default, rehypeKatex.default);
      for (const listener of mathPluginListeners) listener();
      return plugins;
    })
    .catch((error: unknown) => {
      // Don't cache a rejected load (e.g. transient chunk-fetch failure) — clear
      // the memo so the next math render retries the import instead of failing
      // forever. Mounted renders show the formulas' source until then.
      mathPluginsPromise = null;
      mathLoadFailed = true;
      for (const listener of mathPluginListeners) listener();
      throw error;
    });
  return mathPluginsPromise;
}

/**
 * Resolves once the KaTeX plugins (and their stylesheet) are loaded, so mounted math renders can
 * switch from the plain-markdown fallback. Used by the worksheet print page to know when formulas
 * are typeset before it reports ready (YUK-1528).
 */
export function preloadMathPlugins(): Promise<void> {
  return loadMathPlugins().then(() => undefined);
}

// A non-browser render (SSR / react-dom/server renderToString, incl. the repo's
// SSR unit tests) never subscribes, so the lazy client path below never runs.
// Warm the plugin cache at module evaluation there so KaTeX renders synchronously
// on the first (only) render. `import.meta.env.SSR` is a build-time constant: the
// client build inlines it to `false`, so this top-level-await block is dead-code
// eliminated from every client chunk; the browser reaches katex through loadMathPlugins().
if (import.meta.env.SSR) {
  const [remarkMath, rehypeKatex] = await Promise.all([
    import('remark-math'),
    import('rehype-katex'),
    import('katex/contrib/mhchem'),
  ]);
  cacheMathPlugins(remarkMath.default, rehypeKatex.default);
}

const NO_MATH_PLUGINS: MathPlugins = { remarkPlugins: [], rehypePlugins: [] };

// Formulas are on most pages that show questions, and the renderer used to start loading only when
// the first one mounted, after the page's data had arrived. It starts once the page is idle instead,
// so on a slow link it is already there. Pages without formulas pay for it once; it is then cached.
if (!import.meta.env.SSR && typeof window !== 'undefined') {
  const start = () => void loadMathPlugins().catch(() => {});
  if ('requestIdleCallback' in window) window.requestIdleCallback(start, { timeout: 3000 });
  else setTimeout(start, 1500);
}

/** Stands in for one formula until the renderer arrives; never shown as `$...$` source. */
const FORMULA_WAIT = '\u2063';
const PENDING_FORMULA =
  /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|(?<!\\)\$\$(?:(?!\n\s*\n)(?:\\.|[^`$\\]))+?\$\$|(?<!\\)\\\[(?:(?!\n\s*\n)[^`])+?\\\]|(?<!\\)\\\((?:(?!\n\s*\n)[^`])+?\\\)|(?<![\\$])\$(?!\s)[^$\n`]*?[^\s\\]\$(?!\d)/g;

function holdFormulas(source: string): string {
  return source.replace(PENDING_FORMULA, (match: string, code?: string) =>
    code !== undefined ? match : `\`${FORMULA_WAIT}\``,
  );
}

type CodeProps = ComponentProps<'code'> & { node?: unknown };

/** Inline so the placeholder shows even where the reading styles aren't loaded. */
const WAIT_STYLE: CSSProperties = {
  display: 'inline-block',
  width: '2.4em',
  height: '1em',
  margin: '0 0.1em',
  borderRadius: 4,
  background: 'color-mix(in srgb, currentColor 10%, transparent)',
  verticalAlign: '-0.12em',
};

/** Renders the formula placeholder; any other code goes to the caller's own `code`, if it has one. */
function waitingCode(Code: NonNullable<MarkdownRendererProps['components']>['code']) {
  return function WaitingCode(props: CodeProps) {
    if (props.children === FORMULA_WAIT) {
      return (
        <span className="un-math-wait" style={WAIT_STYLE} role="img" aria-label="公式加载中" />
      );
    }
    if (Code === undefined) {
      const { node: _node, ...rest } = props;
      return <code {...rest} />;
    }
    const Caller = Code as ElementType;
    return <Caller {...props} />;
  };
}

function getMathLoadFailed(): boolean {
  return mathLoadFailed;
}

function getNoFailure(): boolean {
  return false;
}

/** Tables and the rest of GFM on every reading surface. One tilde stays text: 「约 ~3」 is not a strike. */
const GFM_PLUGIN: [typeof remarkGfm, { singleTilde: boolean }] = [
  remarkGfm,
  { singleTilde: false },
];

/** A mounted KaTeX render subscribes; the first one after a cold start or a failed chunk loads. */
function subscribeMathPlugins(listener: () => void): () => void {
  mathPluginListeners.add(listener);
  if (!loadedMathPlugins) {
    void loadMathPlugins().catch(() => {
      // Keep the readable plain-markdown fallback mounted; a later mount retries.
    });
  }
  return () => {
    mathPluginListeners.delete(listener);
  };
}

function getLoadedMathPlugins(): MathPlugins | null {
  return loadedMathPlugins;
}

// Non-math notation never subscribes; the katex chunk arrives only through the idle start above.
function subscribeWithoutMath(): () => void {
  return () => {};
}

function getNoMathPlugins(): null {
  return null;
}

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

/** Not every surface has the reading styles, and a wide table must scroll rather than break its card. */
function MarkdownTable({ node: _node, ...props }: ComponentProps<'table'> & { node?: unknown }) {
  return <table {...props} className="un-md-table" />;
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
  remarkPlugins?: MarkdownRendererProps['remarkPlugins'];
  components?: MarkdownRendererProps['components'];
  remarkRehypeOptions?: MarkdownRendererProps['remarkRehypeOptions'];
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

// YUK-1761 — content with no resolved subject notation (null / not passed) still renders math when
// the source plainly contains a formula. Same guards as normalizeMathDelimiters: code spans and
// fences are skipped, and a formula never crosses a blank line or a backtick. A single-dollar span
// counts only in the tight (pandoc) form: no space just inside either dollar and no digit right
// after the closing one, so a currency amount such as `$5` or `$5 到 $10` is never a formula.
const CODE_SPANS = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g;
const DELIMITED_FORMULA =
  /(?<!\\)\\\((?:(?!\n\s*\n)[^`])+?\\\)|(?<!\\)\\\[(?:(?!\n\s*\n)[^`])+?\\\]|(?<!\\)\$\$(?:(?!\n\s*\n)(?:\\.|[^`$\\]))+?\$\$/;
const TIGHT_DOLLAR_FORMULA =
  /(?<![\\$])\$(?![\s$])[^$\n`]*?[^\s\\$]\$(?![\d$])|(?<![\\$])\$[^\s\\$]\$(?![\d$])/;

// In fallback mode remark-math would still read every other dollar pair, with looser rules than the
// check above: `求 $x$，报名费 $5 到 $10` would turn `$5 到 $` into a formula. So before parsing,
// every dollar outside an accepted span (code, `$$…$$` — escaped characters such as `\$` allowed
// inside —, a tight `$…$`) is escaped to a literal.
const FALLBACK_DOLLARS = new RegExp(
  `(${CODE_SPANS.source})|((?<!\\\\)\\$\\$(?:(?!\\n\\s*\\n)(?:\\\\.|[^\`$\\\\]))+?\\$\\$)|(${TIGHT_DOLLAR_FORMULA.source})|(?<!\\\\)\\$`,
  'g',
);

const TABLE_DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/** `$` … `$` as Pandoc reads it: no space inside either end, and no digit right after, so 「$5 | $10」 is two prices. */
const INLINE_MATH = /(?<![\\$])\$(?!\s)[^$\n]*?[^\s\\]\$(?!\d)/g;

/**
 * A table row is split at every `|` before any formula is read, so `$|x|$` in a cell would fall
 * apart and cost the row its later cells. Inside a formula, `\vert` draws the same bar.
 */
function protectTableMathPipes(source: string): string {
  if (!source.includes('|')) return source;
  const lines = source.split('\n');
  // Code is shown and copied as written, so only the text between code spans is touched.
  const inRow = (line: string) =>
    line
      .split(/(`[^`]*`)/)
      .map((part, index) =>
        index % 2 === 1
          ? part
          : part.replace(INLINE_MATH, (math) => math.replace(/(?<!\\)\|/g, '\\vert ')),
      )
      .join('');
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const marker = line.match(/^\s*(```+|~~~+)/)?.[1]?.slice(0, 3);
    if (marker) fence = fence === null ? marker : fence === marker ? null : fence;
    if (fence !== null || marker || index === 0) continue;
    if (!line.includes('|') || !TABLE_DELIMITER_ROW.test(line)) continue;
    if (!lines[index - 1]?.includes('|')) continue;
    lines[index - 1] = inRow(lines[index - 1] as string);
    for (let row = index + 1; row < lines.length && lines[row]?.includes('|'); row += 1) {
      lines[row] = inRow(lines[row] as string);
    }
  }
  return lines.join('\n');
}

function escapeLooseDollars(source: string): string {
  return source.replace(
    FALLBACK_DOLLARS,
    (match: string, code?: string, display?: string, tight?: string) =>
      code !== undefined || display !== undefined || tight !== undefined ? match : '\\$',
  );
}

export function looksLikeMath(source: string): boolean {
  if (!source.includes('$') && !source.includes('\\(') && !source.includes('\\[')) return false;
  const prose = source.replace(CODE_SPANS, ' ');
  return DELIMITED_FORMULA.test(prose) || TIGHT_DOLLAR_FORMULA.test(prose);
}

/**
 * Shared markdown renderer. Applied wherever LaTeX math may appear in user-facing
 * content: review prompt / reference / feedback; note section body; teaching turn text.
 *
 * When notation is `katex` (or legacy `latex`) on the browser, the KaTeX plugin chain is loaded
 * lazily (started when the page is idle): until it arrives each formula shows as a quiet
 * placeholder (its source again if the load fails), then the content re-renders with math (a warm module cache makes later
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
export function MathMarkdown({
  children,
  notation,
  remarkPlugins = [],
  components,
  remarkRehypeOptions,
  ...divProps
}: MathMarkdownProps): ReactElement {
  // A resolved subject notation decides; only an unresolved one (null / absent) falls back to
  // the formula check above.
  const fallback = notation == null && looksLikeMath(children);
  const isKatex = isKatexNotation(notation) || fallback;
  // Read the module cache so an already-warm math mount (or any SSR render, where
  // the cache is warmed at module eval) renders synchronously with no fallback
  // frame; a cold browser mount reads null and the subscription loads the chunk.
  const mathPlugins = useSyncExternalStore(
    isKatex ? subscribeMathPlugins : subscribeWithoutMath,
    isKatex ? getLoadedMathPlugins : getNoMathPlugins,
    isKatex ? getLoadedMathPlugins : getNoMathPlugins,
  );

  const active = isKatex && mathPlugins ? mathPlugins : NO_MATH_PLUGINS;
  const failed = useSyncExternalStore(
    isKatex ? subscribeMathPlugins : subscribeWithoutMath,
    isKatex ? getMathLoadFailed : getNoFailure,
    getNoFailure,
  );
  // Waiting for the renderer: each formula is a quiet placeholder, not its source text.
  const waiting = isKatex && !mathPlugins && !failed;
  const source = waiting
    ? holdFormulas(children)
    : active === NO_MATH_PLUGINS
      ? children
      : protectTableMathPipes(
          normalizeMathDelimiters(fallback ? escapeLooseDollars(children) : children),
        );
  const callerCode = components?.code;
  const code = useMemo(
    () => (waiting ? waitingCode(callerCode) : callerCode),
    [waiting, callerCode],
  );
  return (
    <MarkdownRenderer
      {...divProps}
      remarkPlugins={[...active.remarkPlugins, GFM_PLUGIN, ...(remarkPlugins ?? [])]}
      rehypePlugins={active.rehypePlugins}
      components={{
        table: MarkdownTable,
        ...components,
        ...(code ? { code } : {}),
        img: MarkdownImage,
      }}
      remarkRehypeOptions={remarkRehypeOptions}
    >
      {source}
    </MarkdownRenderer>
  );
}
