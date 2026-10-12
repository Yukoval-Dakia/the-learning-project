import type { FocusEvent } from 'react';
import { useCallback, useState } from 'react';
import { DURATION } from '../tokens';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: string;
  text: string;
  /** Usually "撤销": optimistic writes stay undoable for the toast's lifetime (M10). */
  action?: ToastAction;
}

let seq = 0;

/** Toast state. `push` returns the id so a caller can dismiss early. */
export function useToaster(limit = 3) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: string) => {
    setToasts((all) => all.filter((t) => t.id !== id));
  }, []);
  const push = useCallback(
    (text: string, action?: ToastAction) => {
      seq += 1;
      const id = `un-toast-${seq}`;
      setToasts((all) => [...all.slice(Math.max(0, all.length - limit + 1)), { id, text, action }]);
      return id;
    },
    [limit],
  );
  return { toasts, push, dismiss };
}

/**
 * The undo window for one toast. It counts down only while the toast is in the DOM and neither
 * hovered nor focused, and keeps what is left across pauses, so a pause never restarts the window.
 */
interface UndoClock {
  remaining: number;
  startedAt: number;
  timer: number | null;
  hovered: boolean;
  focused: boolean;
  attached: boolean;
  /** Latest expiry command, written from the ref callback during commit. */
  expire: () => void;
}

function runClock(clock: UndoClock) {
  if (!clock.attached || clock.hovered || clock.focused || clock.timer !== null) return;
  clock.startedAt = performance.now();
  clock.timer = window.setTimeout(
    () => {
      clock.timer = null;
      clock.expire();
    },
    Math.max(0, clock.remaining),
  );
}

function haltClock(clock: UndoClock) {
  if (clock.timer === null) return;
  window.clearTimeout(clock.timer);
  clock.timer = null;
  clock.remaining -= performance.now() - clock.startedAt;
}

function ToastItem({ toast, dismiss }: { toast: Toast; dismiss: (id: string) => void }) {
  const [clock] = useState<UndoClock>(() => ({
    remaining: DURATION.undoWindow,
    startedAt: 0,
    timer: null,
    hovered: false,
    focused: false,
    attached: false,
    expire: () => {},
  }));

  // The toast node owns its timer: attaching starts the countdown, detaching stops it and keeps the
  // time left. A new `dismiss` identity re-runs this pair without losing any of the window.
  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return undefined;
      clock.expire = () => dismiss(toast.id);
      clock.attached = true;
      runClock(clock);
      return () => {
        clock.attached = false;
        haltClock(clock);
      };
    },
    [clock, dismiss, toast.id],
  );

  // The undo window pauses while the toast is hovered or focused, so it never closes under the
  // reader's pointer or keyboard (WCAG 2.2.1). Hover and focus pause separately; the window resumes
  // only once both have left. Moving focus between controls inside the toast keeps it paused.
  const setHovered = (hovered: boolean) => {
    clock.hovered = hovered;
    if (hovered) haltClock(clock);
    else runClock(clock);
  };
  const onFocus = () => {
    clock.focused = true;
    haltClock(clock);
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    clock.focused = false;
    runClock(clock);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: these handlers only pause the undo timer; the toast's real control is its button.
    <div
      ref={ref}
      className="un-toast un-glass"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <span className="un-toast-text">{toast.text}</span>
      {toast.action && (
        <button
          type="button"
          className="un-toast-action un-hit"
          onClick={() => {
            toast.action?.run();
            dismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}

/** Floating glass toasts, announced politely; above any bottom bar (M15). */
export function Toaster({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: string) => void }) {
  return (
    <div className="un-toasts" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} dismiss={dismiss} />
      ))}
    </div>
  );
}
