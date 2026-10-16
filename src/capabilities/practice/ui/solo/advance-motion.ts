// YUK-1473 — the motion of moving to the next question in place (M2, M3). Driven only by the
// host's advance command and by the new question's ref attach; no effects, no timers that outlive
// the move. Each step answers one question:
// - the finished question's body drifts up and fades while the page glides back to the top
//   ("it is done, and it goes away"), so the title stays where the next one will be;
// - the title then morphs into the next title in place (motion/morph, from the host);
// - the next question's body rises in under it ("this is the new one"; the page's own
//   `un-page-in` entrance in practice-solo.css, which already runs when a question opens).
// Interruptible: the reader's wheel, touch or key takes the scroll back at once; going back
// cancels the fade and leaves the page exactly as it was. Reduced motion: every step is instant.
import { prefersReducedMotion } from '@/ui-next/public';

/** Mirror the tokens (T4): --un-t-ui, --un-t-panel, --un-t-small, --un-ease-glide. */
const T_UI = 280;
const T_PANEL = 420;
const T_SMALL = 200;
const EASE_GLIDE = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** Marks the part of a question that leaves and arrives (PracticeSolo: everything below the banner). */
const SWAP_BODY = '[data-swap-body]';

export interface Running {
  /** Settles when the step has ended, by finishing or by being stopped. */
  done: Promise<void>;
  /** Stop now: the scroll stays where it is, a fade is undone. */
  stop: () => void;
}

const settled: Running = { done: Promise.resolve(), stop: () => {} };

/** A short glide back to the top, handed back to the reader on wheel, touch or key. */
export function glideToTop(): Running {
  const from = window.scrollY;
  if (from <= 1) return settled;
  if (prefersReducedMotion()) {
    window.scrollTo({ top: 0, behavior: 'instant' });
    return settled;
  }
  const duration = Math.min(T_PANEL, T_SMALL + from * 0.12);
  const start = performance.now();
  let frame = 0;
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const handBack = ['wheel', 'touchstart', 'keydown'] as const;
  const stop = () => {
    cancelAnimationFrame(frame);
    for (const type of handBack) window.removeEventListener(type, stop);
    finish();
  };
  for (const type of handBack) window.addEventListener(type, stop, { passive: true });
  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    // Close to --un-ease-glide: quick start, long soft landing.
    const eased = 1 - (1 - t) ** 4;
    window.scrollTo({ top: Math.round(from * (1 - eased)), behavior: 'instant' });
    if (t < 1) frame = requestAnimationFrame(tick);
    else stop();
  };
  frame = requestAnimationFrame(tick);
  return { done, stop };
}

function swapBodies(root: ParentNode | null): HTMLElement[] {
  return root ? [...root.querySelectorAll<HTMLElement>(SWAP_BODY)] : [];
}

/**
 * The finished question's body drifts up and fades. While it fades it is inert, so nothing
 * invisible keeps focus or takes a click; `stop` cancels the fade and gives it back intact.
 */
export function leaveQuestion(root: ParentNode | null): Running {
  const nodes = swapBodies(root);
  if (!nodes.length || prefersReducedMotion()) return settled;
  const animations = nodes.map((node) => {
    node.inert = true;
    return node.animate(
      [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'translateY(-12px)' },
      ],
      { duration: T_UI, easing: EASE_GLIDE, fill: 'forwards' },
    );
  });
  const done = Promise.allSettled(animations.map((a) => a.finished)).then(() => {});
  const stop = () => {
    for (const a of animations) a.cancel();
    for (const node of nodes) node.inert = false;
  };
  return { done, stop };
}
