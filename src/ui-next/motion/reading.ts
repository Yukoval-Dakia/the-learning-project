// Keep the reader's place while a side panel opens or closes (M7). The column reflows on every
// frame of the width transition; pin the block at the reading line so the words under the
// reader's eyes stay put. A wheel, touch or key hands control straight back to the reader.

const BLOCKS = 'p, li, h1, h2, h3, dt, dd, figure, blockquote, [data-reading-block]';
const HAND_BACK = ['wheel', 'touchstart', 'keydown'] as const;

/** Returns a function that stops holding early. */
export function holdReadingPosition(scroller: HTMLElement | null, durationMs = 560): () => void {
  if (!scroller || scroller.scrollTop < 4) return () => {};
  const box = scroller.getBoundingClientRect();
  const line = box.top + Math.min(140, box.height * 0.25);
  let anchor: Element | null = null;
  for (const el of scroller.querySelectorAll(BLOCKS)) {
    const r = el.getBoundingClientRect();
    if (r.height && r.bottom > line && r.top < box.bottom) {
      anchor = el;
      break;
    }
  }
  if (!anchor) return () => {};
  const pinned = anchor;
  const offset = pinned.getBoundingClientRect().top - box.top;
  const until = performance.now() + durationMs;
  let frame = 0;

  const stop = () => {
    cancelAnimationFrame(frame);
    for (const type of HAND_BACK) scroller.removeEventListener(type, stop);
  };
  for (const type of HAND_BACK) scroller.addEventListener(type, stop, { passive: true });

  const tick = () => {
    const drift =
      pinned.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
    if (Math.abs(drift) > 0.5) scroller.scrollTop += drift;
    if (performance.now() < until) frame = requestAnimationFrame(tick);
    else stop();
  };
  frame = requestAnimationFrame(tick);
  return stop;
}
