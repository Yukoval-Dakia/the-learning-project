'use client';

// useFocusTrap — drawer/modal focus management: trap Tab within the panel, restore
// focus to the previously-focused element on close, and close on Esc. Ported from
// docs/design/loom-prototype/components.jsx (useFocusTrap).
//
// YUK-1483: the trap is owned by the panel's DOM node, not by an effect. The hook
// returns a ref callback; put it on the real panel element. The trap attaches when
// that element is in the DOM *and* `open` is true, and detaches when the element
// unmounts or `open` turns false. A layer that is not rendered (e.g. `open` with no
// content, so the panel never mounts) never pushes a token.

import { useCallback, useRef } from 'react';

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

// Stack of currently-attached traps, most-recently-attached last. Every attached trap
// adds a document keydown listener, so without a guard a stacked pair (e.g.
// CommandPalette over CopilotDrawer) would see BOTH handle one Esc — stopPropagation
// does not stop sibling listeners on the same node, so the underlying drawer closed
// too (YUK-718 codex #3610033039). Only the trap whose token is on TOP of this stack
// acts on Esc/Tab, so one Esc closes exactly one layer; when it closes, its token is
// removed and the next layer becomes topmost. A trap that closes from the middle
// (e.g. the underlying drawer is closed programmatically while the palette is open)
// is spliced out, so the top always reflects the visually-topmost open trap.
// Holds only opaque browser-side tokens (ref callbacks never run on the server).
const trapStack: symbol[] = [];

interface ActiveTrap {
  panel: HTMLElement;
  dispose: () => void;
  // Set by a ref cleanup, cleared if React re-attaches the same panel in the same
  // commit (ref callback identity change, StrictMode double-invoke).
  detachPending: boolean;
}

interface TrapOwner {
  // Latest onClose, written only from the ref callback during commit.
  onClose: () => void;
  active: ActiveTrap | null;
}

function attachTrap(panel: HTMLElement, owner: TrapOwner): ActiveTrap {
  const token = Symbol('focus-trap');
  trapStack.push(token);
  const restore = document.activeElement;
  const first = panel.querySelector<HTMLElement>(FOCUSABLE);
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
      owner.onClose();
      return;
    }
    if (e.key !== 'Tab') return;
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
  return {
    panel,
    detachPending: false,
    dispose: () => {
      document.removeEventListener('keydown', onKey);
      const idx = trapStack.indexOf(token);
      if (idx !== -1) trapStack.splice(idx, 1);
      // Only restore focus if the previously-focused element is still in the
      // document (e.g. the trigger may have unmounted with a collapsing rail);
      // otherwise focus silently falls to <body> and the call is wasted.
      if (restore instanceof HTMLElement && document.contains(restore)) restore.focus();
    },
  };
}

/**
 * Returns a ref callback for the panel element. The trap is active only while the
 * panel is mounted and `open` is true.
 *
 * A new `onClose` identity (inline arrow from the parent) gives React a new ref
 * callback, which makes React run the old cleanup and call the new callback with the
 * same node in one commit. That pair is coalesced: the trap stays attached, keeps its
 * stack position and its restore target, and only the stored onClose is updated.
 */
export function useFocusTrap(
  open: boolean,
  onClose: () => void,
): (panel: HTMLElement | null) => (() => void) | undefined {
  const ownerRef = useRef<TrapOwner>({ onClose, active: null });

  return useCallback(
    (panel: HTMLElement | null) => {
      const owner = ownerRef.current;
      owner.onClose = onClose;
      if (!panel || !open) return undefined;

      const current = owner.active;
      let attached: ActiveTrap;
      if (current && current.panel === panel) {
        current.detachPending = false;
        attached = current;
      } else {
        if (current) {
          owner.active = null;
          current.dispose();
        }
        attached = attachTrap(panel, owner);
        owner.active = attached;
      }

      return () => {
        attached.detachPending = true;
        // Detach after the commit finishes, unless the same panel was re-attached
        // in between. Unmount and open→false both end up here.
        queueMicrotask(() => {
          if (!attached.detachPending || owner.active !== attached) return;
          owner.active = null;
          attached.dispose();
        });
      };
    },
    [open, onClose],
  );
}
