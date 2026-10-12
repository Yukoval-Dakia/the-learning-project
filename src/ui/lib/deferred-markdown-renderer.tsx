import type { ComponentType, ReactElement } from 'react';
import { useSyncExternalStore } from 'react';
import type { MarkdownRendererProps } from './markdown-renderer';

type MarkdownRendererComponent = ComponentType<MarkdownRendererProps>;

let loadedRenderer: MarkdownRendererComponent | null = null;
let rendererPromise: Promise<MarkdownRendererComponent> | null = null;
// The renderer is code, not user state, so a module-level cache is safe under SSR.
const rendererListeners = new Set<() => void>();

function loadMarkdownRenderer(): Promise<MarkdownRendererComponent> {
  if (loadedRenderer) return Promise.resolve(loadedRenderer);
  rendererPromise ??= import('./markdown-renderer')
    .then(({ MarkdownRenderer }) => {
      loadedRenderer = MarkdownRenderer;
      for (const listener of rendererListeners) listener();
      return MarkdownRenderer;
    })
    .catch((error: unknown) => {
      // Let a later drawer open retry a transient chunk failure. The mounted
      // message remains readable through the plain-text fallback meanwhile.
      rendererPromise = null;
      throw error;
    });
  return rendererPromise;
}

/** Warm the Markdown chunk immediately before a deferred surface opens. */
export function preloadMarkdownRenderer(): void {
  void loadMarkdownRenderer().catch(() => {
    // The component's escaped plain-text fallback is the deliberate degrade path.
  });
}

/** A mounted renderer subscribes; the first subscriber after a cold start or a failed chunk loads it. */
function subscribeRenderer(listener: () => void): () => void {
  rendererListeners.add(listener);
  if (!loadedRenderer) preloadMarkdownRenderer();
  return () => {
    rendererListeners.delete(listener);
  };
}

function getLoadedRenderer(): MarkdownRendererComponent | null {
  return loadedRenderer;
}

/**
 * Render safe plain text until the Markdown parser is ready. A failed chunk
 * never blanks or crashes the enclosing surface; closing and reopening retries.
 */
export function DeferredMarkdownRenderer({
  children,
  className,
  components,
}: Pick<MarkdownRendererProps, 'children' | 'className' | 'components'>): ReactElement {
  // Until the chunk lands (or after it fails) this stays null and the plain-text fallback shows;
  // a later mount subscribes again and retries the import.
  const Renderer = useSyncExternalStore(subscribeRenderer, getLoadedRenderer, getLoadedRenderer);

  if (!Renderer) {
    return (
      <div className={className} style={{ whiteSpace: 'pre-wrap' }}>
        {children}
      </div>
    );
  }

  return (
    <Renderer className={className} components={components}>
      {children}
    </Renderer>
  );
}
