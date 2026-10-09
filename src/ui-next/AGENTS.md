# src/ui-next — scoped design-system base

Stable-layer base for the UI rewrite (YUK-1354). Source of truth for every rule:
`docs/design/2026-10-07-ui-visual-direction.md` (§0 stable vs pending layer, §0.1 I1–I5).

- Everything renders inside `<UiNextRoot>` (`[data-ui-next]`). Styles nest under that scope and
  stay unlayered, so they outrank the app's unlayered global element rules.
- Variables are prefixed `--un-`, classes `un-`. Do not use names from Tailwind v4 theme
  namespaces (T9); Tailwind scans this directory, so prefer prefixed class names everywhere.
- Never touch `:root`, `body`, global resets or global fonts; never edit `src/ui/`,
  `web/src/globals.css`, Start routes/router/boot, package/lock/vite entries (I4).
- No external URLs (the CSP allows same-origin fonts only). No new dependencies without
  coordination. Reuse `@/ui/primitives/useFocusTrap` for modal layers; do not bind ⌘K.
- Components are presentation and interaction only: no data fetching, no business rules (I1).
  Showcase examples use local sample data and never call real writes.
- Collapsed or hidden regions are `inert` (A1); small controls opt into `.un-hit` (A2).
  Transitions read `--un-t-*` tokens; keyframes live only under `prefers-reduced-motion:
  no-preference` (M3).
- Tests are `*.unit.test.ts(x)` with `// @vitest-environment jsdom`, Testing Library and
  `afterEach(cleanup)`; they run in the unit partition (`vitest.shared.ts`).
- Pending-layer surfaces (page composition, sidebar entries, home layout) do not belong here
  until the feature-rework wave that settles them.
