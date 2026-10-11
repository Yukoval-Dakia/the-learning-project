// ui-next public entry (YUK-1354): the stable-layer design-system base.
// Rules: docs/design/2026-10-07-ui-visual-direction.md (§0 stable layer, §0.1 I1–I5).
// Render everything inside <UiNextRoot>; the stylesheets below attach to that scope only.
import './tokens.css';
import './components.css';
import './answer/answer.css';

export * from './answer';
export * from './companion';
export * from './mascot';
export type { CaptureFlight, FlyOptions, MorphSnapshot, QuoteFlight } from './motion/flights';
export {
  bump,
  cancelMorphs,
  flyCapture,
  flyQuote,
  flyTo,
  playMorphs,
  playMorphsAfterPaint,
  snapshotMorphs,
} from './motion/flights';
export type { SharedMorph } from './motion/morph';
export { useSharedMorph } from './motion/morph';
export { holdReadingPosition } from './motion/reading';
export { prefersReducedMotion, useReducedMotion } from './motion/reduced-motion';
export { FLASH_CLASS, reveal } from './motion/reveal';
export type { SpringConfig, SpringHandle, SpringOptions } from './motion/spring';
export { createSpring } from './motion/spring';
export * from './primitives';
export * from './shell';
export { DURATION, EASE, MASCOT_SIZE, PHONE_MAX_WIDTH, PHONE_MEDIA, SPRING, Z } from './tokens';
