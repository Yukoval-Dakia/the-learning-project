// The one on-screen mascot (B1–B4). It lives in a fixed layer above the page and flies, on a
// damped spring, to whichever slot the current page declares; on phones it tucks into the top
// bar's dock once the slot scrolls under the bar (B3). Between flights it sticks to its slot
// while the page scrolls, clipped to the reading column so it never floats over the top bar.
//
// Drawing: the still flower shows first. At idle time, if the device can afford it (support.ts),
// three.js is imported and the glass flower takes over; it only draws while it is turning or
// thinking. Under reduced motion, without WebGL, on software rendering or low power, the still
// flower stays, and position changes jump instead of fly.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useReducedMotion } from '../motion/reduced-motion';
import { type SpringHandle, createSpring } from '../motion/spring';
import { PHONE_MEDIA, SPRING } from '../tokens';
import type { MascotController } from './controller';
import { FlowerStill } from './FlowerStill';
import type { FlowerHandle } from './flower-gl';
import { DEFAULT_REST, type Orientation, lookToward } from './orientation';
import { type StillReason, mascotSupport } from './support';

/** CSS px the flower is drawn at; slots scale it down (the largest slot is 208px). */
export const MASCOT_CANVAS = 224;
/** How long the layer waits for a new slot before fading out (a page change takes one commit). */
const VACANT_MS = 260;
/** Re-measure once more after layout changes settle (panel and page-entry transitions). */
const LATE_MS = 460;
/** The slot counts as under the top bar once this share of it has passed the bar's bottom. */
const DOCK_SHARE = 0.45;

export type MascotMode = 'auto' | 'still' | 'off';

interface Target {
  x: number;
  y: number;
  s: number;
  docked: boolean;
  clip: DOMRect | null;
  rest: Orientation;
}

const scrollers = new WeakMap<HTMLElement, HTMLElement | null>();

/** The nearest scrolling ancestor: the mascot is clipped to it while sitting in its slot. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  if (scrollers.has(el)) return scrollers.get(el) ?? null;
  let node = el.parentElement;
  while (node && node !== document.body) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') break;
    node = node.parentElement;
  }
  const found = node && node !== document.body ? node : null;
  scrollers.set(el, found);
  return found;
}

function measure(controller: MascotController): Target | null {
  const slots = controller.slots();
  for (let i = slots.length - 1; i >= 0; i--) {
    const slot = slots[i];
    if (!slot?.el.isConnected) continue;
    const r = slot.el.getBoundingClientRect();
    if (!r.width) continue;
    let docked = false;
    let t = r;
    const dock = controller.dock();
    if (dock && window.matchMedia(PHONE_MEDIA).matches) {
      const d = dock.getBoundingClientRect();
      if (d.width) {
        const bar = (dock.closest('header') ?? dock).getBoundingClientRect();
        docked = r.top + r.height * DOCK_SHARE < bar.bottom;
        if (docked) t = d;
      }
    }
    return {
      x: t.left,
      y: t.top,
      s: t.width / MASCOT_CANVAS,
      docked,
      clip: docked ? null : (scrollerOf(slot.el)?.getBoundingClientRect() ?? null),
      rest: slot.rest,
    };
  }
  return null;
}

function idle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(run, { timeout: 2000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(run, 600);
  return () => window.clearTimeout(id);
}

function accentOf(el: Element | null): string {
  if (!el) return '#d97757';
  return getComputedStyle(el).getPropertyValue('--un-accent').trim() || '#d97757';
}

export function MascotLayer({
  controller,
  mode,
}: {
  controller: MascotController;
  mode: Exclude<MascotMode, 'off'>;
}) {
  const used = useSyncExternalStore(controller.subscribeUsed, controller.used, () => false);
  const reduced = useReducedMotion();
  const layerRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<FlowerHandle | null>(null);
  const restRef = useRef<Orientation>(DEFAULT_REST);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const placeRef = useRef({ x: 0, y: 0, s: 0 });
  const [visible, setVisible] = useState(false);
  const [render, setRender] = useState<'still' | 'gl'>('still');
  const [stillReason, setStillReason] = useState<StillReason | undefined>(undefined);

  /** Face the rest angle, turned toward a nearby pointer. */
  const aim = () => {
    const gl = glRef.current;
    if (!gl) return;
    const { x, y, s } = placeRef.current;
    const half = (MASCOT_CANVAS * s) / 2;
    gl.setRotation(
      lookToward(restRef.current, pointerRef.current, { x: x + half, y: y + half }, half),
    );
  };

  // Position: three springs (x, y, scale), retargeted whenever the slot, dock or layout moves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: aim reads refs only
  useEffect(() => {
    if (!used) return;
    const layer = layerRef.current;
    const box = boxRef.current;
    if (!layer || !box) return;
    let placed = false;
    let docked = false;
    let clip = '';
    let vacant = 0;
    let late = 0;

    const springs: Record<'x' | 'y' | 's', SpringHandle> = {
      x: createSpring({ value: 0, config: SPRING.float, onUpdate: () => write() }),
      y: createSpring({ value: 0, config: SPRING.float, onUpdate: () => write() }),
      s: createSpring({ value: 0.5, config: SPRING.float, onUpdate: () => write() }),
    };
    const moving = () => springs.x.moving() || springs.y.moving() || springs.s.moving();

    const write = () => {
      const x = springs.x.get();
      const y = springs.y.get();
      const s = Math.max(0.01, springs.s.get());
      placeRef.current = { x, y, s };
      box.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${s})`;
      // Clipped to the reading column only once landed: in flight it may cross the top bar.
      layer.style.clipPath = moving() ? '' : clip;
    };

    const jump = (t: Target) => {
      springs.x.jump(t.x);
      springs.y.jump(t.y);
      springs.s.jump(t.s);
    };

    const retarget = (fromScroll = false) => {
      const t = measure(controller);
      if (!t) {
        if (placed && !vacant) {
          vacant = window.setTimeout(() => {
            vacant = 0;
            placed = false;
            setVisible(false);
          }, VACANT_MS);
        }
        return;
      }
      window.clearTimeout(vacant);
      vacant = 0;
      if (t.rest !== restRef.current) {
        restRef.current = t.rest;
        aim();
      }
      const changed = t.docked !== docked;
      docked = t.docked;
      // The layer covers the viewport, so its own size turns the column's rect into insets.
      clip = t.clip
        ? `inset(${t.clip.top}px ${layer.clientWidth - t.clip.right}px ${layer.clientHeight - t.clip.bottom}px ${t.clip.left}px)`
        : '';
      if (!placed) {
        // First appearance (or back after a long gap): place, then fade in; never fly in from 0,0.
        placed = true;
        jump(t);
        setVisible(true);
        return;
      }
      if (fromScroll && !changed && !moving()) {
        // Riding along with the page: stick to the slot exactly, no lag behind the finger.
        jump(t);
        return;
      }
      springs.x.to(t.x);
      springs.y.to(t.y);
      springs.s.to(t.s);
    };

    const ro = new ResizeObserver(() => retarget());
    const observe = () => {
      ro.disconnect();
      ro.observe(document.documentElement);
      const slot = controller.slots().at(-1)?.el;
      if (slot) {
        ro.observe(slot);
        const scroller = scrollerOf(slot);
        if (scroller) ro.observe(scroller);
      }
      const dock = controller.dock();
      if (dock) ro.observe(dock);
    };

    const onLayout = () => {
      observe();
      retarget();
      window.clearTimeout(late);
      late = window.setTimeout(() => retarget(), LATE_MS);
    };
    const onScroll = () => retarget(true);
    const onResize = () => retarget();
    // A transition or entry animation that moved the slot (panel opening, page fading in).
    const onSettle = (e: Event) => {
      const slot = controller.slots().at(-1)?.el;
      if (slot && e.target instanceof Node && e.target.contains(slot)) retarget();
    };

    const unsubscribe = controller.subscribe((event) => {
      if (event === 'layout') onLayout();
    });
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    document.addEventListener('transitionend', onSettle, true);
    document.addEventListener('animationend', onSettle, true);
    window.addEventListener('resize', onResize);
    onLayout();

    return () => {
      unsubscribe();
      ro.disconnect();
      document.removeEventListener('scroll', onScroll, { capture: true });
      document.removeEventListener('transitionend', onSettle, true);
      document.removeEventListener('animationend', onSettle, true);
      window.removeEventListener('resize', onResize);
      window.clearTimeout(vacant);
      window.clearTimeout(late);
      for (const spring of Object.values(springs)) spring.stop();
    };
  }, [used, controller]);

  // Thinking spin and petal advance, for both the glass flower and the still one.
  useEffect(() => {
    if (!used) return;
    const box = boxRef.current;
    let turns = 0;
    const sync = () => {
      const thinking = controller.thinking();
      glRef.current?.setThinking(thinking);
      if (box) box.dataset.thinking = String(thinking);
    };
    sync();
    return controller.subscribe((event) => {
      if (event === 'thinking') sync();
      if (event === 'advance') {
        glRef.current?.advance();
        turns += 1;
        box?.style.setProperty('--un-mascot-turn', `${turns * 60}deg`);
      }
    });
  }, [used, controller]);

  // Turn toward a nearby pointer or finger; back to rest when it leaves or lifts (B2).
  // biome-ignore lint/correctness/useExhaustiveDependencies: aim reads refs only
  useEffect(() => {
    if (!used || render !== 'gl') return;
    let frame = 0;
    const onMove = (e: PointerEvent) => {
      pointerRef.current = { x: e.clientX, y: e.clientY };
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(aim);
    };
    const onLeave = () => {
      pointerRef.current = null;
      aim();
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === 'touch') onLeave();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onMove, { passive: true });
    window.addEventListener('pointerup', onUp, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onMove);
      window.removeEventListener('pointerup', onUp);
      document.documentElement.removeEventListener('pointerleave', onLeave);
    };
  }, [used, render]);

  // The glass flower: decided and built at idle time, never in the frame of an interaction (B4).
  // biome-ignore lint/correctness/useExhaustiveDependencies: aim reads refs only
  useEffect(() => {
    if (!used) return;
    if (mode === 'still') {
      setStillReason('forced');
      return;
    }
    if (reduced) {
      setStillReason('reduced-motion');
      return;
    }
    let cancelled = false;
    let cancelBuild = () => {};
    let handle: FlowerHandle | null = null;
    const fallBack = (reason: StillReason) => {
      handle?.dispose();
      handle = null;
      glRef.current = null;
      setStillReason(reason);
      setRender('still');
    };
    const cancelProbe = idle(() => {
      const support = mascotSupport();
      if (cancelled) return;
      if (support.render !== 'gl') {
        setStillReason(support.reason);
        return;
      }
      import('./flower-gl')
        .then(({ createFlower }) => {
          if (cancelled) return;
          cancelBuild = idle(() => {
            const canvas = canvasRef.current;
            if (cancelled || !canvas) return;
            try {
              handle = createFlower(canvas, {
                size: MASCOT_CANVAS,
                tint: accentOf(layerRef.current),
                rotation: restRef.current,
                onLost: () => fallBack('context-lost'),
              });
            } catch {
              fallBack('no-webgl');
              return;
            }
            glRef.current = handle;
            handle.setThinking(controller.thinking());
            aim();
            setStillReason(undefined);
            setRender('gl');
          });
        })
        .catch(() => {
          if (!cancelled) setStillReason('no-webgl');
        });
    });

    // Re-tint the glass when the theme changes.
    const retint = () => handle?.setTint(accentOf(layerRef.current));
    const themeObserver = new MutationObserver(retint);
    themeObserver.observe(document.documentElement, { attributeFilter: ['data-theme'] });
    const root = layerRef.current?.closest('[data-ui-next]');
    if (root) themeObserver.observe(root, { attributeFilter: ['data-un-theme'] });
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', retint);

    return () => {
      cancelled = true;
      cancelProbe();
      cancelBuild();
      themeObserver.disconnect();
      scheme.removeEventListener('change', retint);
      handle?.dispose();
      glRef.current = null;
      setRender('still');
    };
  }, [used, mode, reduced, controller]);

  if (!used) return null;
  return (
    <div
      ref={layerRef}
      className="un-mascot-layer"
      data-visible={visible}
      data-render={render}
      data-still-reason={render === 'still' ? stillReason : undefined}
      aria-hidden="true"
    >
      <div ref={boxRef} className="un-mascot">
        <div className="un-mascot-turn">
          <FlowerStill className="un-mascot-still" />
        </div>
        <canvas ref={canvasRef} className="un-mascot-canvas" />
      </div>
    </div>
  );
}
