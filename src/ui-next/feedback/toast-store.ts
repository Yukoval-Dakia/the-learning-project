// One toast host for the whole app (YUK-1473). Anything can show a short message, optionally with
// one action (撤销); the shell renders them. Plain module store read with useSyncExternalStore:
// showing and dismissing are commands, the timer starts in the command, never in render.

export interface Toast {
  id: number;
  message: string;
  /** One action, e.g. 撤销. Clicking it runs the action and dismisses the toast. */
  action?: { label: string; run: () => void };
}

/** How long a toast stays (M10: 4.5 s to undo). */
const TOAST_MS = 4500;
const EMPTY: readonly Toast[] = [];

let toasts: readonly Toast[] = EMPTY;
let nextId = 1;
const listeners = new Set<() => void>();

function publish(next: readonly Toast[]) {
  toasts = next;
  for (const listener of listeners) listener();
}

export function dismissToast(id: number): void {
  if (!toasts.some((toast) => toast.id === id)) return;
  publish(toasts.filter((toast) => toast.id !== id));
}

/** Show a toast; returns its id. At most three stay; the oldest leaves first. */
export function showToast(toast: Omit<Toast, 'id'>): number {
  const id = nextId++;
  publish([...toasts.slice(-2), { ...toast, id }]);
  if (typeof window !== 'undefined') window.setTimeout(() => dismissToast(id), TOAST_MS);
  return id;
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readToasts(): readonly Toast[] {
  return toasts;
}

export function readServerToasts(): readonly Toast[] {
  return EMPTY;
}
