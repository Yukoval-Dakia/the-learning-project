// Shared-title navigation (M4) without an effect. A list row and the detail page's title carry
// the same `data-morph` key; entering grows the title out of the row, going back folds it into
// the row again.
//
//   const morph = useSharedMorph();
//   onClick={() => { morph.capture(hostRef.current); setView(next); }}   // a command
//   <div key={viewKey} ref={morph.land}>…</div>                          // the new view's root
//
// `capture` runs in the command that swaps the view; `land` is a ref callback, so it runs when the
// new view's root attaches (in the commit, before paint) and the flight is measured after the new
// view's first frame. Its cleanup cancels a flight that has not finished when the view goes away.
// Reduced motion: nothing is captured, so every change is instant.
import { useCallback, useMemo, useRef } from 'react';
import { type MorphSnapshot, playMorphsAfterPaint, snapshotMorphs } from './flights';

export interface SharedMorph {
  /**
   * Call right before the change that swaps the view. `rename` maps a title's key to the key it
   * should land on (e.g. one question's title onto the next question's), or drops it (null).
   */
  capture(root: ParentNode | null, rename?: (key: string) => string | null): void;
  /** Ref callback for the root of each view; key that root by view so it attaches per view. */
  land(node: HTMLElement | null): (() => void) | undefined;
}

export function useSharedMorph(): SharedMorph {
  const snapshot = useRef<Map<string, MorphSnapshot> | null>(null);

  const capture = useCallback(
    (root: ParentNode | null, rename?: (key: string) => string | null) => {
      for (const old of snapshot.current?.values() ?? []) old.ghost.remove();
      snapshot.current = snapshotMorphs(root, rename);
    },
    [],
  );

  // The snapshot a root took, so a re-attach of the same node (StrictMode runs ref callbacks
  // twice in development) plays the same flight instead of losing it.
  const taken = useRef(new WeakMap<HTMLElement, Map<string, MorphSnapshot>>());

  const land = useCallback((node: HTMLElement | null) => {
    if (!node) return undefined;
    const fresh = snapshot.current;
    snapshot.current = null;
    if (fresh) taken.current.set(node, fresh);
    const flight = fresh ?? taken.current.get(node) ?? null;
    // Without a capture (first view, a plain view change) this only cancels older flights.
    return playMorphsAfterPaint(node, flight);
  }, []);

  return useMemo(() => ({ capture, land }), [capture, land]);
}
