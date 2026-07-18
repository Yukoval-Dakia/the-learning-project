import { useEffect, useRef } from 'react';

/**
 * Runs the latest best-effort lifecycle transition when the document is hidden
 * for navigation, reload, or tab close. Domain callbacks should use
 * `fetch(..., { keepalive: true })`; the hook deliberately swallows failures
 * because pagehide has no recovery UI and server orphan sweeps are the fallback.
 */
export function usePagehideTransition(
  transition: (event: PageTransitionEvent) => unknown,
  enabled = true,
): void {
  const transitionRef = useRef(transition);
  const enabledRef = useRef(enabled);

  useEffect(() => {
    transitionRef.current = transition;
    enabledRef.current = enabled;
  }, [transition, enabled]);

  useEffect(() => {
    const onPagehide = (event: PageTransitionEvent) => {
      if (!enabledRef.current) return;
      try {
        void Promise.resolve(transitionRef.current(event)).catch(() => {});
      } catch {
        // Best effort only; the server-side orphan sweep remains the fallback.
      }
    };

    window.addEventListener('pagehide', onPagehide);
    return () => window.removeEventListener('pagehide', onPagehide);
  }, []);
}
