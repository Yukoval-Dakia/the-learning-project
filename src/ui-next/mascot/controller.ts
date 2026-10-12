// The one mascot's shared state (B1): where pages have asked it to sit, the phone top-bar dock,
// and who is currently keeping it "thinking". Plain TS, no React state, so a slot registering
// or a run starting never re-renders the page; the mascot layer subscribes and reacts.
import type { Orientation } from './orientation';

export interface SlotRecord {
  el: HTMLElement;
  /** Resting orientation for this page (B2), already inside the angle limits. */
  rest: Orientation;
}

export type MascotEvent = 'layout' | 'thinking' | 'advance';

export interface MascotController {
  /** Slots in registration order; the last one that is on the page wins. */
  slots(): readonly SlotRecord[];
  addSlot(record: SlotRecord): () => void;
  dock(): HTMLElement | null;
  addDock(el: HTMLElement): () => void;
  /** Any source thinking makes the mascot think; it stops when the last one stops. */
  setThinking(source: symbol, on: boolean): void;
  thinking(): boolean;
  /** Turn one petal forward (something was recorded). */
  advance(): void;
  /** The slot moved without resizing (a panel opened beside it): measure again. */
  relayout(): void;
  subscribe(listener: (event: MascotEvent) => void): () => void;
  /** True once any page has declared a slot; the layer mounts from then on and stays. */
  used(): boolean;
  subscribeUsed(listener: () => void): () => void;
}

export function createMascotController(): MascotController {
  const slots: SlotRecord[] = [];
  const thinkers = new Set<symbol>();
  const listeners = new Set<(event: MascotEvent) => void>();
  const usedListeners = new Set<() => void>();
  let dockEl: HTMLElement | null = null;
  let used = false;

  const emit = (event: MascotEvent) => {
    for (const listener of listeners) listener(event);
  };

  return {
    slots: () => slots,
    addSlot(record) {
      slots.push(record);
      if (!used) {
        used = true;
        for (const listener of usedListeners) listener();
      }
      emit('layout');
      return () => {
        const i = slots.indexOf(record);
        if (i >= 0) slots.splice(i, 1);
        emit('layout');
      };
    },
    dock: () => dockEl,
    addDock(el) {
      dockEl = el;
      emit('layout');
      return () => {
        if (dockEl === el) dockEl = null;
        emit('layout');
      };
    },
    setThinking(source, on) {
      const before = thinkers.size > 0;
      if (on) thinkers.add(source);
      else thinkers.delete(source);
      if (before !== thinkers.size > 0) emit('thinking');
    },
    thinking: () => thinkers.size > 0,
    advance: () => emit('advance'),
    relayout: () => emit('layout'),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    used: () => used,
    subscribeUsed(listener) {
      usedListeners.add(listener);
      return () => usedListeners.delete(listener);
    },
  };
}
