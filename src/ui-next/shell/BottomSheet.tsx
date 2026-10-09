import type { KeyboardEvent, ReactNode, PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { type SpringHandle, createSpring } from '../motion/spring';
import { SPRING } from '../tokens';

export type SheetSnap = 'full' | 'half' | 'peek' | 'closed';

const ORDER: readonly SheetSnap[] = ['closed', 'peek', 'half', 'full'];
const SNAP_LABEL: Record<SheetSnap, string> = {
  closed: '已收起',
  peek: '露出标题',
  half: '一半',
  full: '全屏',
};

export interface BottomSheetProps {
  /** Accessible name, e.g. "学习伙伴". */
  label: string;
  snap: SheetSnap;
  onSnapChange: (next: SheetSnap) => void;
  /** Whether the sheet may close entirely; otherwise peek is the lowest stop (C2). */
  canClose?: boolean;
  /** Height that stays visible at peek; measured from the grip and header when omitted. */
  peekVisible?: number;
  /** Space kept clear below the peeking sheet, e.g. for a floating tab bar. */
  bottomInset?: number;
  header: ReactNode;
  children: ReactNode;
}

interface Drag {
  startY: number;
  startPointer: number;
  lastPointer: number;
  lastTime: number;
  velocity: number;
  moved: number;
}

/**
 * Draggable phone sheet with three stops (C2). Position is a damped spring that keeps its velocity,
 * so a fling carries into the stop and a new drag can grab the sheet mid-motion. A cancelled drag
 * settles like a release. The full-width grip is a real button: dragging it moves the sheet, Enter
 * toggles peek and half, arrow keys move between stops (A4). Content hidden at peek is inert (A1).
 */
export function BottomSheet({
  label,
  snap,
  onSnapChange,
  canClose = false,
  peekVisible,
  bottomInset = 0,
  header,
  children,
}: BottomSheetProps) {
  const sheetRef = useRef<HTMLElement>(null);
  const gripRef = useRef<HTMLButtonElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const springRef = useRef<SpringHandle | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const suppressClick = useRef(false);

  const stops = canClose ? ORDER : ORDER.slice(1);

  const visibleAtPeek = useCallback(() => {
    if (peekVisible !== undefined) return peekVisible;
    const measured = (gripRef.current?.offsetHeight ?? 0) + (headRef.current?.offsetHeight ?? 0);
    return measured || 92;
  }, [peekVisible]);

  const position = useCallback(
    (name: SheetSnap) => {
      const height = sheetRef.current?.offsetHeight || window.innerHeight;
      const map: Record<SheetSnap, number> = {
        full: 0,
        half: Math.round(height * 0.5),
        peek: height - visibleAtPeek() - bottomInset,
        closed: height + 32,
      };
      return map[name];
    },
    [visibleAtPeek, bottomInset],
  );

  const write = (y: number) => {
    if (sheetRef.current) sheetRef.current.style.transform = `translate3d(0, ${y}px, 0)`;
  };

  if (!springRef.current && typeof window !== 'undefined') {
    springRef.current = createSpring({ value: 0, config: SPRING.sheet, onUpdate: write });
  }

  // First placement is immediate; later changes animate from wherever the sheet is.
  const placed = useRef(false);
  useLayoutEffect(() => {
    const spring = springRef.current;
    if (!spring) return;
    if (!placed.current) {
      placed.current = true;
      spring.jump(position(snap));
    } else {
      spring.to(position(snap));
    }
  }, [snap, position]);

  // Publish how much of the screen bottom the sheet covers, so toasts sit above it and the
  // reading column can scroll its last lines clear of it (M15, A2).
  useLayoutEffect(() => {
    const root = sheetRef.current?.closest<HTMLElement>('[data-ui-next]');
    if (!root) return;
    const covered = snap === 'closed' ? bottomInset : visibleAtPeek() + bottomInset;
    root.style.setProperty('--un-chrome-bottom', `${covered}px`);
    return () => {
      root.style.removeProperty('--un-chrome-bottom');
    };
  }, [snap, bottomInset, visibleAtPeek]);

  useEffect(() => {
    const onResize = () => springRef.current?.to(position(snap));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [snap, position]);

  // Stop the spring only when the sheet goes away. Stopping it on every snap change would cancel
  // the motion the layout effect just started.
  useEffect(() => () => springRef.current?.stop(), []);

  const settleTo = (next: SheetSnap, velocity: number) => {
    if (next === snap) springRef.current?.to(position(next), velocity);
    else {
      springRef.current?.to(position(next), velocity);
      onSnapChange(next);
    }
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    const spring = springRef.current;
    if (!spring) return;
    // A touch drag ends without a click, so a stale suppression would swallow the next tap.
    suppressClick.current = false;
    spring.stop();
    dragRef.current = {
      startY: spring.get(),
      startPointer: e.clientY,
      lastPointer: e.clientY,
      lastTime: performance.now(),
      velocity: 0,
      moved: 0,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone (e.g. a cancelled touch); the next release settles the sheet.
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const spring = springRef.current;
    if (!drag || !spring) return;
    const now = performance.now();
    const dy = e.clientY - drag.lastPointer;
    drag.velocity = 0.8 * (dy / Math.max(1, now - drag.lastTime)) * 1000 + 0.2 * drag.velocity;
    drag.lastPointer = e.clientY;
    drag.lastTime = now;
    drag.moved = Math.max(drag.moved, Math.abs(e.clientY - drag.startPointer));
    const lowest = position(canClose ? 'closed' : 'peek');
    spring.jump(Math.max(-12, Math.min(lowest, drag.startY + (e.clientY - drag.startPointer))));
  };

  // Release and cancel both end the drag; a tap (no real movement) is left to the click handler.
  const release = () => {
    const drag = dragRef.current;
    const spring = springRef.current;
    dragRef.current = null;
    if (!drag || !spring) return;
    if (drag.moved < 5) {
      spring.to(position(snap));
      return;
    }
    suppressClick.current = true;
    const projected = spring.get() + drag.velocity * 0.2;
    const nearest = stops.reduce((best, name) =>
      Math.abs(position(name) - projected) < Math.abs(position(best) - projected) ? name : best,
    );
    settleTo(nearest, drag.velocity);
  };

  const onGripClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    onSnapChange(snap === 'half' || snap === 'full' ? 'peek' : 'half');
  };

  const onGripKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = stops.indexOf(snap);
    let next: SheetSnap | undefined;
    if (e.key === 'ArrowUp') next = stops[Math.min(stops.length - 1, i + 1)];
    if (e.key === 'ArrowDown') next = stops[Math.max(0, i - 1)];
    if (e.key === 'Home') next = stops[stops.length - 1];
    if (e.key === 'End') next = stops[0];
    if (!next) return;
    e.preventDefault();
    if (next !== snap) onSnapChange(next);
  };

  const lowered = snap === 'peek' || snap === 'closed';
  const dragHandlers = {
    onPointerDown,
    onPointerMove,
    onPointerUp: release,
    onPointerCancel: release,
  };

  return (
    <section
      ref={sheetRef}
      className="un-sheet"
      data-snap={snap}
      aria-label={label}
      inert={snap === 'closed'}
    >
      <button
        ref={gripRef}
        type="button"
        className="un-sheet-grip"
        aria-label={`调整${label}的高度，当前${SNAP_LABEL[snap]}。上下方向键切换`}
        onClick={onGripClick}
        onKeyDown={onGripKeyDown}
        {...dragHandlers}
      >
        <span className="un-sheet-grip-bar" aria-hidden="true" />
      </button>
      <div ref={headRef} className="un-sheet-head">
        {header}
      </div>
      <div className="un-sheet-body" inert={lowered}>
        {children}
      </div>
    </section>
  );
}
