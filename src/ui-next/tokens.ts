// Shared constants that JS needs and CSS custom properties cannot provide (media queries cannot
// read custom properties). Values mirror tokens.css; decision doc T4, T7, T8.

/** Phone layout at or below this width (T8). */
export const PHONE_MAX_WIDTH = 720;
export const PHONE_MEDIA = `(max-width: ${PHONE_MAX_WIDTH}px)`;

/** Stacking order (T7). Components read these instead of writing raw z-index values. */
export const Z = {
  mascot: 3,
  bubble: 4,
  sheet: 40,
  tabbar: 42,
  capture: 45,
  palette: 50,
  toast: 60,
} as const;

/** Durations in ms (T4). Under reduced motion every one of them collapses to an instant change. */
export const DURATION = {
  feedback: 90,
  small: 200,
  ui: 280,
  panel: 420,
  flight: 540,
  undoWindow: 4500,
} as const;

/** Damped springs for JS-driven motion: keep velocity, retarget mid-flight (M3). */
export const SPRING = {
  /** Bottom sheet: firm, settles fast. */
  sheet: { stiffness: 240, damping: 29 },
  /** Floating objects (mascot): slightly under critical, a whisper of overshoot. */
  float: { stiffness: 190, damping: 23 },
} as const;

/** Cubic-bezier curves matching --un-ease-*; used by Web Animations. */
export const EASE = {
  spring: 'cubic-bezier(0.32, 1.28, 0.48, 1)',
  springSoft: 'cubic-bezier(0.32, 1.12, 0.48, 1)',
  glide: 'cubic-bezier(0.22, 1, 0.36, 1)',
} as const;
