// ui-next public entry (YUK-1354): the stable-layer design-system base.
// Rules: docs/design/2026-10-07-ui-visual-direction.md (§0 stable layer, §0.1 I1–I5).
// Render everything inside <UiNextRoot>; the stylesheets below attach to that scope only.
import './tokens.css';
import './components.css';

export type { FlyOptions, MorphSnapshot } from './motion/flights';
export { bump, flyTo, playMorphs, snapshotMorphs } from './motion/flights';
export { holdReadingPosition } from './motion/reading';
export { prefersReducedMotion, useReducedMotion } from './motion/reduced-motion';
export { FLASH_CLASS, reveal } from './motion/reveal';
export type { SpringConfig, SpringHandle, SpringOptions } from './motion/spring';
export { createSpring } from './motion/spring';
export * from './primitives';
export * from './shell';
export { DURATION, EASE, PHONE_MAX_WIDTH, PHONE_MEDIA, SPRING, Z } from './tokens';
