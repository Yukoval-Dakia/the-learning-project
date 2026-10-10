// Bring a referenced passage into view and let it glow once (M6). A second reveal restarts the
// glow instead of being cut short by the first one's timer.
import { prefersReducedMotion } from './reduced-motion';

export const FLASH_CLASS = 'un-flash';
const GLOW_MS = 1800;
const timers = new WeakMap<Element, number>();

export function reveal(el: HTMLElement | null, block: ScrollLogicalPosition = 'center'): void {
  if (!el) return;
  el.scrollIntoView?.({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block });
  window.clearTimeout(timers.get(el));
  el.classList.remove(FLASH_CLASS);
  // Force a style flush so re-adding the class restarts the animation.
  void el.offsetWidth;
  el.classList.add(FLASH_CLASS);
  timers.set(
    el,
    window.setTimeout(() => el.classList.remove(FLASH_CLASS), GLOW_MS),
  );
}
