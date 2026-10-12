import { useCallback } from 'react';

/**
 * Runs the latest best-effort lifecycle transition when the document is hidden
 * for navigation, reload, or tab close. Domain callbacks should use
 * `fetch(..., { keepalive: true })`; the hook deliberately swallows failures
 * because pagehide has no recovery UI and server orphan sweeps are the fallback.
 *
 * YUK-1483: the pagehide listener is owned by a real DOM node, not an effect. The
 * hook returns a ref callback; put it on an element that stays mounted for as long
 * as the transition should be armed (the answering surface's root). The listener is
 * added when that node mounts and removed when it unmounts. When `transition` or
 * `enabled` changes, React detaches the old listener and attaches the new one in the
 * same commit, so exactly one listener is live and it always calls the committed
 * transition. Pass a stable `transition` to avoid re-binding on every render.
 */
export function usePagehideTransition(
  transition: (event: PageTransitionEvent) => unknown,
  enabled = true,
): (node: Element | null) => (() => void) | undefined {
  return useCallback(
    (node: Element | null) => {
      if (!node || !enabled) return undefined;
      const onPagehide = (event: PageTransitionEvent) => {
        try {
          void Promise.resolve(transition(event)).catch(() => {});
        } catch {
          // Best effort only; the server-side orphan sweep remains the fallback.
        }
      };
      window.addEventListener('pagehide', onPagehide);
      return () => window.removeEventListener('pagehide', onPagehide);
    },
    [transition, enabled],
  );
}
