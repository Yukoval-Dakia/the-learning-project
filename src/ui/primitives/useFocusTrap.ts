'use client';

// useFocusTrap — drawer/modal focus management: trap Tab within the panel, restore
// focus to the previously-focused element on close, and close on Esc. Ported from
// docs/design/loom-prototype/components.jsx (useFocusTrap).

import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

export function useFocusTrap(
  open: boolean,
  onClose: () => void,
  panelRef: RefObject<HTMLElement | null>,
): void {
  const restoreRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    if (first) first.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;
      const nodes = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (n) => n.offsetParent !== null,
      );
      if (!nodes.length) return;
      const f = nodes[0];
      const l = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === f) {
        e.preventDefault();
        l.focus();
      } else if (!e.shiftKey && document.activeElement === l) {
        e.preventDefault();
        f.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const restore = restoreRef.current;
      // Only restore focus if the previously-focused element is still in the
      // document (e.g. the trigger may have unmounted with a collapsing rail);
      // otherwise focus silently falls to <body> and the call is wasted.
      if (restore instanceof HTMLElement && document.contains(restore)) restore.focus();
    };
  }, [open, onClose, panelRef]);
}
