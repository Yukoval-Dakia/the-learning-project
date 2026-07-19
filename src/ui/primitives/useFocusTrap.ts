'use client';

// useFocusTrap — drawer/modal focus management: trap Tab within the panel, restore
// focus to the previously-focused element on close, and close on Esc. Ported from
// docs/design/loom-prototype/components.jsx (useFocusTrap).

import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

// Stack of currently-open traps, most-recently-opened last. Every open trap adds a
// document keydown listener, so without a guard a stacked pair (e.g. CommandPalette
// over CopilotDrawer) would see BOTH handle one Esc — stopPropagation does not stop
// sibling listeners on the same node, so the underlying drawer closed too (YUK-718
// codex #3610033039). Only the trap whose token is on TOP of this stack acts on
// Esc/Tab, so one Esc closes exactly one layer; when it closes, its token is removed
// and the next layer becomes topmost. A trap that closes from the middle (e.g. the
// underlying drawer is closed programmatically while the palette is open) is spliced
// out, so the top always reflects the visually-topmost open trap.
const trapStack: symbol[] = [];

export function useFocusTrap(
  open: boolean,
  onClose: () => void,
  panelRef: RefObject<HTMLElement | null>,
): void {
  const restoreRef = useRef<Element | null>(null);
  // Latest-ref for onClose so the effect depends only on [open, panelRef]. If onClose
  // were a dep, an unstable inline onClose would re-run the effect on every parent
  // render, popping + re-pushing this trap's token to the TOP of the stack and
  // corrupting the layering (a background drawer could steal "topmost" from the
  // palette). Reading it through a ref keeps the token pushed exactly once per open.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const token = Symbol('focus-trap');
    trapStack.push(token);
    restoreRef.current = document.activeElement;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    if (first) first.focus();

    const onKey = (e: KeyboardEvent) => {
      // Only the topmost trap owns the keyboard; a trap beneath a stacked modal must
      // ignore Esc/Tab so a single keystroke never closes (or re-tabs) two layers.
      if (trapStack[trapStack.length - 1] !== token) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        // stopPropagation still guards against any outer non-trap window/document
        // listener; the topmost check above handles trap-vs-trap.
        e.stopPropagation();
        onCloseRef.current();
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
      const idx = trapStack.indexOf(token);
      if (idx !== -1) trapStack.splice(idx, 1);
      const restore = restoreRef.current;
      // Only restore focus if the previously-focused element is still in the
      // document (e.g. the trigger may have unmounted with a collapsing rail);
      // otherwise focus silently falls to <body> and the call is wasted.
      if (restore instanceof HTMLElement && document.contains(restore)) restore.focus();
    };
  }, [open, panelRef]);
}
