import { useCallback, useEffect, useRef, useState } from 'react';
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

function ToastItem({ toast, dismiss }: { toast: Toast; dismiss: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const remaining = useRef<number>(DURATION.undoWindow);

  // The undo window pauses while the toast is hovered or focused, so it never closes under the
  // reader's pointer or keyboard (WCAG 2.2.1).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pause = () => setPaused(true);
    const resume = () => setPaused(false);
    el.addEventListener('pointerenter', pause);
    el.addEventListener('pointerleave', resume);
    el.addEventListener('focusin', pause);
    el.addEventListener('focusout', resume);
    return () => {
      el.removeEventListener('pointerenter', pause);
      el.removeEventListener('pointerleave', resume);
      el.removeEventListener('focusin', pause);
      el.removeEventListener('focusout', resume);
    };
  }, []);

  useEffect(() => {
    if (paused) return;
    const startedAt = performance.now();
    const timer = window.setTimeout(() => dismiss(toast.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current -= performance.now() - startedAt;
    };
  }, [paused, dismiss, toast.id]);

  return (
    <div ref={ref} className="un-toast un-glass">
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
