// YUK-1548 §3.1 — the client half of a `diagram` block: Mermaid loads on the first diagram that
// mounts (its own lazy chunk), renders the frozen source to an SVG string, and the string is shown
// only as an <img> (SvgImage), never as live DOM. Same module-memo + useSyncExternalStore pattern
// as math-markdown.tsx: no effects, nothing runs during SSR, and a warm cache renders immediately.
//
// "Deterministic" (§3.1): the same source + the pinned mermaid version + these theme tokens always
// give the same picture, so the palette below is fixed per theme instead of read from the page.

import type { MermaidConfig } from 'mermaid';

export type DiagramTheme = 'light' | 'dark';

// ── Theme ────────────────────────────────────────────────────────────────────────────────────
// The app theme lives on <html data-theme> (RootShell owns it); without one the system preference
// decides, matching tokens.css T6. CSS variables cannot reach into an <img>, so a theme change
// re-renders the diagram with the other palette.

const themeListeners = new Set<() => void>();
let themeWatch: (() => void) | null = null;

function readTheme(): DiagramTheme {
  const applied = document.documentElement.getAttribute('data-theme');
  if (applied) return applied === 'dark' ? 'dark' : 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function subscribeDiagramTheme(listener: () => void): () => void {
  themeListeners.add(listener);
  if (!themeWatch) {
    const notify = () => {
      for (const current of themeListeners) current();
    };
    const observer = new MutationObserver(notify);
    observer.observe(document.documentElement, { attributeFilter: ['data-theme'] });
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', notify);
    themeWatch = () => {
      observer.disconnect();
      scheme.removeEventListener('change', notify);
    };
  }
  return () => {
    themeListeners.delete(listener);
    if (themeListeners.size === 0 && themeWatch) {
      themeWatch();
      themeWatch = null;
    }
  };
}

export function getDiagramTheme(): DiagramTheme {
  return readTheme();
}

export function getServerDiagramTheme(): DiagramTheme {
  return 'light';
}

// ── Mermaid config ───────────────────────────────────────────────────────────────────────────
// System CJK fonts only: the page measures labels with this stack, and the <img> draws them with
// the same installed fonts. A webfont would be measured in the page but missing inside the image.
const DIAGRAM_FONT =
  '"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei", -apple-system, "Segoe UI", system-ui, sans-serif';

// Values mirror src/ui-next/tokens.css (light / dark): raised paper, sunk paper, hairlines, ink,
// and the accent pair for nodes.
const PALETTE: Record<DiagramTheme, Record<string, string>> = {
  light: {
    background: '#ffffff',
    primaryColor: '#faede5',
    primaryBorderColor: '#d97757',
    primaryTextColor: '#1f1e1d',
    secondaryColor: '#f4f2ec',
    secondaryBorderColor: '#cdc8bc',
    secondaryTextColor: '#1f1e1d',
    tertiaryColor: '#faf9f5',
    tertiaryBorderColor: '#cdc8bc',
    tertiaryTextColor: '#1f1e1d',
    lineColor: '#5e5b54',
    textColor: '#1f1e1d',
    titleColor: '#1f1e1d',
    edgeLabelBackground: '#ffffff',
    clusterBkg: '#f4f2ec',
    clusterBorder: '#cdc8bc',
    noteBkgColor: '#f6eedb',
    noteBorderColor: '#cdc8bc',
    noteTextColor: '#45433e',
    actorBkg: '#faede5',
    actorBorder: '#d97757',
    actorTextColor: '#1f1e1d',
    signalColor: '#45433e',
    signalTextColor: '#1f1e1d',
  },
  dark: {
    background: '#1f1e1b',
    primaryColor: '#3a2419',
    primaryBorderColor: '#e8916e',
    primaryTextColor: '#f2efe8',
    secondaryColor: '#282724',
    secondaryBorderColor: '#403e3a',
    secondaryTextColor: '#f2efe8',
    tertiaryColor: '#171614',
    tertiaryBorderColor: '#403e3a',
    tertiaryTextColor: '#f2efe8',
    lineColor: '#aba79e',
    textColor: '#f2efe8',
    titleColor: '#f2efe8',
    edgeLabelBackground: '#1f1e1b',
    clusterBkg: '#121110',
    clusterBorder: '#403e3a',
    noteBkgColor: '#33291a',
    noteBorderColor: '#403e3a',
    noteTextColor: '#c8c4bb',
    actorBkg: '#3a2419',
    actorBorder: '#e8916e',
    actorTextColor: '#f2efe8',
    signalColor: '#c8c4bb',
    signalTextColor: '#f2efe8',
  },
};

function configFor(theme: DiagramTheme): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
    theme: 'base',
    darkMode: theme === 'dark',
    fontFamily: DIAGRAM_FONT,
    themeVariables: { ...PALETTE[theme], darkMode: theme === 'dark', fontFamily: DIAGRAM_FONT },
  };
}

// ── Mermaid module memo ──────────────────────────────────────────────────────────────────────
type MermaidApi = typeof import('mermaid')['default'];

let mermaidPromise: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import('mermaid')
    .then((module) => module.default)
    .catch((error: unknown) => {
      // A failed chunk fetch is not cached; the next diagram mount retries.
      mermaidPromise = null;
      throw error;
    });
  return mermaidPromise;
}

// ── Render cache ─────────────────────────────────────────────────────────────────────────────

export type DiagramRender =
  | { status: 'pending' }
  | { status: 'ready'; src: string; width: number; height: number }
  /** `load`: the mermaid chunk did not arrive (retried on the next mount); `render`: bad source. */
  | { status: 'failed'; reason: 'load' | 'render' };

interface RenderEntry {
  render: DiagramRender;
  listeners: Set<() => void>;
  started: boolean;
}

const PENDING: DiagramRender = Object.freeze({ status: 'pending' });
const MAX_IDLE_ENTRIES = 48;
const entries = new Map<string, RenderEntry>();
// mermaid.initialize is global, so each initialize + render pair runs alone.
let renderQueue: Promise<unknown> = Promise.resolve();
let renderSeq = 0;

function keyOf(theme: DiagramTheme, source: string): string {
  return `${theme}\u0000${source}`;
}

/** Give the SVG root its viewBox size so the <img> has an intrinsic size and keeps its ratio. */
function sizeSvg(svg: string): { xml: string; width: number; height: number } | null {
  let doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  let root: Element | null = doc.documentElement;
  if (root?.nodeName !== 'svg' || doc.getElementsByTagName('parsererror').length > 0) {
    // Mermaid serialises through the HTML DOM; re-read it that way and write it back as XML.
    doc = new DOMParser().parseFromString(svg, 'text/html');
    root = doc.querySelector('svg');
  }
  if (!root) return null;
  const box = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const width = Math.round(box[2] ?? 0);
  const height = Math.round(box[3] ?? 0);
  if (!(width > 0 && height > 0)) return null;
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  root.removeAttribute('style');
  return { xml: new XMLSerializer().serializeToString(root), width, height };
}

function publish(entry: RenderEntry, render: DiagramRender): void {
  entry.render = render;
  for (const listener of entry.listeners) listener();
}

function startRender(entry: RenderEntry, theme: DiagramTheme, source: string): void {
  entry.started = true;
  if (entry.render.status !== 'pending') publish(entry, PENDING);
  const id = `un-blk-mmd-${++renderSeq}`;
  const job = renderQueue.then(async (): Promise<DiagramRender> => {
    let mermaid: MermaidApi;
    try {
      mermaid = await loadMermaid();
    } catch {
      return { status: 'failed', reason: 'load' };
    }
    try {
      mermaid.initialize(configFor(theme));
      const { svg } = await mermaid.render(id, source);
      const sized = sizeSvg(svg);
      if (!sized) return { status: 'failed', reason: 'render' };
      return {
        status: 'ready',
        src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized.xml)}`,
        width: sized.width,
        height: sized.height,
      };
    } catch {
      return { status: 'failed', reason: 'render' };
    } finally {
      // Mermaid measures inside a temporary node; never leave one behind after a failure.
      document.getElementById(`d${id}`)?.remove();
      document.getElementById(id)?.remove();
    }
  });
  renderQueue = job.catch(() => undefined);
  void job.then((render) => publish(entry, render));
}

function evictIdle(): void {
  if (entries.size <= MAX_IDLE_ENTRIES) return;
  for (const [key, entry] of entries) {
    if (entries.size <= MAX_IDLE_ENTRIES) return;
    if (entry.listeners.size === 0 && entry.render.status !== 'pending') entries.delete(key);
  }
}

export function subscribeDiagram(
  theme: DiagramTheme,
  source: string,
  listener: () => void,
): () => void {
  const key = keyOf(theme, source);
  let entry = entries.get(key);
  if (!entry) {
    entry = { render: PENDING, listeners: new Set(), started: false };
    entries.set(key, entry);
    evictIdle();
  }
  const current = entry;
  current.listeners.add(listener);
  const retryLoad = current.render.status === 'failed' && current.render.reason === 'load';
  if (!current.started || retryLoad) startRender(current, theme, source);
  return () => {
    current.listeners.delete(listener);
  };
}

/**
 * The render for this theme; while it is still pending, the other theme's finished render stands
 * in, so switching light/dark swaps the picture without a blank frame.
 */
export function getDiagramRender(theme: DiagramTheme, source: string): DiagramRender {
  const render = entries.get(keyOf(theme, source))?.render ?? PENDING;
  if (render.status !== 'pending') return render;
  const other = entries.get(keyOf(theme === 'dark' ? 'light' : 'dark', source))?.render;
  return other?.status === 'ready' ? other : render;
}

export function getServerDiagramRender(): DiagramRender {
  return PENDING;
}
