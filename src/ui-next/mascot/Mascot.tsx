// The page's mascot (B1–B4), drawn in the banner where the page places it. It sits in the page's
// own flow, so it moves with the banner (a drawer reflowing the column, scrolling) and never
// floats over the answer or the action bar. It is decorative: aria-hidden, no pointer events.
//
// Drawing: the still flower shows first. At idle time, if the device can afford it (support.ts),
// three.js is imported and the glass flower takes over. Under reduced motion, without WebGL, on
// software rendering or low power, when the import fails or the context is lost, the still flower
// stays; `data-render` / `data-still-reason` on the root say which and why.
//
// No effects. One runtime per mounted mascot owns everything imperative:
// - the root's ref callback watches its own `data-thinking` / `data-settle` attributes, so React
//   props reach the WebGL handle without an effect (thinking spins it; a new settle key turns one
//   petal, the first value being the baseline);
// - the canvas's ref callback probes, imports and builds the renderer at idle time, owns the
//   pointer, theme and context-loss listeners, and disposes all of it when the canvas leaves
//   (unmount, next question, reduced motion switched on, or a failure);
// - the render state is an external store read with useSyncExternalStore.
import { useState, useSyncExternalStore } from 'react';
import { useReducedMotion } from '../motion/reduced-motion';
import { FlowerStill } from './FlowerStill';
import type { FlowerHandle } from './flower-gl';
import { DEFAULT_REST, lookToward } from './orientation';
import { type StillReason, mascotSupport } from './support';

/** CSS px the glass flower is drawn at; the slot scales it down (largest slot 208px). */
const MASCOT_CANVAS = 224;
const FALLBACK_ACCENT = '#d97757';

interface MascotState {
  render: 'still' | 'gl';
  /** Set once the glass flower gave up for this mascot; the still flower stays. */
  failed: StillReason | null;
}

const INITIAL: MascotState = { render: 'still', failed: null };

function idle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(run, { timeout: 2000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(run, 600);
  return () => window.clearTimeout(id);
}

function accentOf(el: Element): string {
  return getComputedStyle(el).getPropertyValue('--un-accent').trim() || FALLBACK_ACCENT;
}

function createMascotRuntime() {
  let state = INITIAL;
  const listeners = new Set<() => void>();
  let gl: FlowerHandle | null = null;
  let root: HTMLElement | null = null;

  const set = (next: Partial<MascotState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const fail = (reason: StillReason) => set({ render: 'still', failed: reason });
  const thinking = () => root?.dataset.thinking === 'true';

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => state,

    attachRoot(node: HTMLElement | null) {
      if (!node) return;
      root = node;
      let turns = 0;
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.attributeName === 'data-thinking') gl?.setThinking(thinking());
          if (record.attributeName === 'data-settle') {
            const next = node.dataset.settle ?? '';
            if (!next || next === record.oldValue) continue;
            turns += 1;
            node.style.setProperty('--un-mascot-turn', `${turns * 60}deg`);
            gl?.advance();
          }
        }
      });
      observer.observe(node, {
        attributeFilter: ['data-thinking', 'data-settle'],
        attributeOldValue: true,
      });
      return () => {
        observer.disconnect();
        if (root === node) root = null;
      };
    },

    attachCanvas(canvas: HTMLCanvasElement | null) {
      if (!canvas) return;
      let cancelled = false;
      let handle: FlowerHandle | null = null;
      let cancelBuild = () => {};
      let frame = 0;
      let pointer: { x: number; y: number } | null = null;

      /** Face the rest angle, turned toward a nearby pointer (B2). */
      const aim = () => {
        frame = 0;
        if (!handle) return;
        const r = canvas.getBoundingClientRect();
        const half = r.width / 2;
        handle.setRotation(
          lookToward(DEFAULT_REST, pointer, { x: r.left + half, y: r.top + half }, half),
        );
      };
      const onMove = (e: PointerEvent) => {
        pointer = { x: e.clientX, y: e.clientY };
        if (!frame) frame = requestAnimationFrame(aim);
      };
      const onLeave = () => {
        pointer = null;
        if (!frame) frame = requestAnimationFrame(aim);
      };
      const onUp = (e: PointerEvent) => {
        if (e.pointerType === 'touch') onLeave();
      };

      // The glass is faintly tinted with the accent: follow theme changes.
      const retint = () => handle?.setTint(accentOf(canvas));
      const themeObserver = new MutationObserver(retint);
      const scheme = window.matchMedia('(prefers-color-scheme: dark)');

      const build = (createFlower: typeof import('./flower-gl').createFlower) => {
        if (cancelled) return;
        try {
          handle = createFlower(canvas, {
            size: MASCOT_CANVAS,
            tint: accentOf(canvas),
            rotation: DEFAULT_REST,
            onLost: () => fail('context-lost'),
          });
        } catch {
          fail('no-webgl');
          return;
        }
        gl = handle;
        handle.setThinking(thinking());
        window.addEventListener('pointermove', onMove, { passive: true });
        window.addEventListener('pointerdown', onMove, { passive: true });
        window.addEventListener('pointerup', onUp, { passive: true });
        document.documentElement.addEventListener('pointerleave', onLeave);
        themeObserver.observe(document.documentElement, { attributeFilter: ['data-theme'] });
        const scope = canvas.closest('[data-ui-next]');
        if (scope) themeObserver.observe(scope, { attributeFilter: ['data-un-theme'] });
        scheme.addEventListener('change', retint);
        set({ render: 'gl' });
      };

      // Decided and built at idle time, never in the frame of an interaction (B4).
      const cancelProbe = idle(() => {
        if (cancelled) return;
        const support = mascotSupport();
        if (support.render !== 'gl') {
          fail(support.reason ?? 'no-webgl');
          return;
        }
        import('./flower-gl').then(
          ({ createFlower }) => {
            if (!cancelled) cancelBuild = idle(() => build(createFlower));
          },
          () => {
            if (!cancelled) fail('load-failed');
          },
        );
      });

      return () => {
        cancelled = true;
        cancelProbe();
        cancelBuild();
        if (frame) cancelAnimationFrame(frame);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerdown', onMove);
        window.removeEventListener('pointerup', onUp);
        document.documentElement.removeEventListener('pointerleave', onLeave);
        themeObserver.disconnect();
        scheme.removeEventListener('change', retint);
        // Releases the renderer, geometry, material and environment texture, stops its frame
        // loop and drops the GL context, so remounting per question never stacks contexts.
        handle?.dispose();
        if (gl === handle) gl = null;
        handle = null;
        if (state.render === 'gl') set({ render: 'still' });
      };
    },
  };
}

export interface MascotProps {
  /** The page is working on something (e.g. judging): the flower spins like a pinwheel (B2). */
  thinking?: boolean;
  /**
   * Changes whenever something is recorded: the flower turns one petal forward. The value at
   * mount is the baseline and does not turn it; an empty value never does.
   */
  settleKey?: string | null;
  className?: string;
}

/** The mascot in its banner slot. Size comes from the slot tokens (B1). */
export function Mascot({ thinking = false, settleKey, className }: MascotProps) {
  const [runtime] = useState(createMascotRuntime);
  const state = useSyncExternalStore(runtime.subscribe, runtime.snapshot, () => INITIAL);
  const reduced = useReducedMotion();
  const tryGl = !reduced && state.failed === null;
  const render = tryGl ? state.render : 'still';
  let stillReason: StillReason | undefined;
  if (reduced) stillReason = 'reduced-motion';
  else if (state.failed) stillReason = state.failed;
  return (
    <span
      ref={runtime.attachRoot}
      aria-hidden="true"
      className={['un-mascot', className].filter(Boolean).join(' ')}
      data-render={render}
      data-still-reason={render === 'still' ? stillReason : undefined}
      data-thinking={thinking}
      data-settle={settleKey ?? ''}
    >
      <span className="un-mascot-turn">
        <FlowerStill className="un-mascot-still" />
      </span>
      {tryGl && <canvas ref={runtime.attachCanvas} className="un-mascot-canvas" />}
    </span>
  );
}
