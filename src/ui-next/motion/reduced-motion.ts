// Reduced motion (M3): under `prefers-reduced-motion: reduce` every change is immediate.
import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function media(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(QUERY);
}

/** Read the preference at the moment of a change (for imperative motion code). */
export function prefersReducedMotion(): boolean {
  return media()?.matches ?? false;
}

function subscribe(onChange: () => void): () => void {
  const list = media();
  if (!list) return () => {};
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

/** The preference as React state, updated when the user changes it. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}
