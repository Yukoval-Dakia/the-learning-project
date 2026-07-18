import type { ComponentType, ReactElement } from 'react';
import { useEffect, useState } from 'react';
import type { MarkdownRendererProps } from './markdown-renderer';

type MarkdownRendererComponent = ComponentType<MarkdownRendererProps>;

let loadedRenderer: MarkdownRendererComponent | null = null;
let rendererPromise: Promise<MarkdownRendererComponent> | null = null;

function loadMarkdownRenderer(): Promise<MarkdownRendererComponent> {
  if (loadedRenderer) return Promise.resolve(loadedRenderer);
  rendererPromise ??= import('./markdown-renderer')
    .then(({ MarkdownRenderer }) => {
      loadedRenderer = MarkdownRenderer;
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

/**
 * Render safe plain text until the Markdown parser is ready. A failed chunk
 * never blanks or crashes the enclosing surface; closing and reopening retries.
 */
export function DeferredMarkdownRenderer({
  children,
  className,
}: Pick<MarkdownRendererProps, 'children' | 'className'>): ReactElement {
  const [Renderer, setRenderer] = useState<MarkdownRendererComponent | null>(() => loadedRenderer);

  useEffect(() => {
    if (Renderer) return;
    let cancelled = false;
    void loadMarkdownRenderer()
      .then((nextRenderer) => {
        if (!cancelled) setRenderer(() => nextRenderer);
      })
      .catch(() => {
        // Keep the readable fallback mounted; a later mount will retry the import.
      });
    return () => {
      cancelled = true;
    };
  }, [Renderer]);

  if (!Renderer) {
    return (
      <div className={className} style={{ whiteSpace: 'pre-wrap' }}>
        {children}
      </div>
    );
  }

  return <Renderer className={className}>{children}</Renderer>;
}
