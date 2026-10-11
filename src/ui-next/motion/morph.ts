// Shared-title navigation (M4) as a hook. A card or list row and the detail page's title carry the
// same `data-morph` key; entering grows the title out of the card, going back folds it into the
// card again. The rest of the new page only fades in (`.un-page-enter`), so the title has a still
// place to land.
//
//   const morph = useSharedMorph(hostRef, routeKey);
//   <button onClick={() => { morph.capture(); open(question.id); }}>…</button>
//   <div className="un-page-enter" key={routeKey}>…</div>   // inside hostRef
import type { RefObject } from 'react';
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { type MorphSnapshot, playMorphsAfterPaint, snapshotMorphs } from './flights';

const ROOT_FLAG = 'unMorphIn';

export interface SharedMorph {
  /** Call right before the change that swaps the view (e.g. in the click handler). */
  capture(): void;
}

/**
 * `viewKey` identifies the current view (route, question id, list or detail). When it changes
 * after a `capture()`, matching titles fly from where they were. Without a capture, nothing flies
 * and the new view rises in as usual. Reduced motion: an instant change.
 */
export function useSharedMorph(
  rootRef: RefObject<HTMLElement | null>,
  viewKey: string | number,
): SharedMorph {
  const snapshot = useRef<Map<string, MorphSnapshot> | null>(null);
  const first = useRef(true);

  // viewKey is the trigger; the effect reads only refs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on every view change
  useLayoutEffect(() => {
    const root = rootRef.current;
    const taken = snapshot.current;
    snapshot.current = null;
    if (first.current) {
      first.current = false;
      return;
    }
    // Read by `.un-page-enter`: arriving through a shared title, the page fades without moving.
    // Set before the first paint, so the entry animation starts with the right keyframes.
    if (root) {
      if (taken?.size) root.dataset[ROOT_FLAG] = '';
      else delete root.dataset[ROOT_FLAG];
    }
    return playMorphsAfterPaint(root, taken);
  }, [viewKey]);

  const capture = useCallback(() => {
    snapshot.current = snapshotMorphs(rootRef.current);
  }, [rootRef]);

  return useMemo(() => ({ capture }), [capture]);
}
