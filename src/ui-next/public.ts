// ui-next public entry (YUK-1354): the stable-layer design-system base.
// Rules: docs/design/2026-10-07-ui-visual-direction.md (§0 stable layer, §0.1 I1–I5).
// Render everything inside <UiNextRoot>; the stylesheets below attach to that scope only.
// Only what a live page uses is exported (first consumer: the practice page, YUK-1473).
import './tokens.css';
import './components.css';

export { Mascot, type MascotProps } from './mascot/Mascot';
export * from './primitives';
export * from './shell';
