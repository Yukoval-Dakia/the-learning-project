# Copilot tool_use 卡片 — claude design handoff (2026-06-07)

Archived design bundle from claude.ai/design. Source of truth for the
`ToolUseCard` full-anatomy upgrade (S1, component layer).

These are the original HTML/CSS/JS prototype files — **visual reference only**,
not production code. The React implementation lives in
`src/ui/primitives/ToolUseCard.tsx` + scoped styles in `app/globals.css`
(`.tool-use-card` namespace). We recreate the visual output; we do NOT copy
the prototype's internal structure.

## Files

| file                     | role                                                          |
| ------------------------ | ------------------------------------------------------------- |
| `chat3.md`               | design session transcript — where the intent + known traps live |
| `tokens.css`             | loom 暖纸·单珊瑚 token set (identical-in-spirit to `app/globals.css`) |
| `tool-use.css`           | the rich `.tcard` anatomy stylesheet (header/args/result/ribbon/actions) |
| `components.jsx`         | `Icon` + `BrandMark` primitives (repo equivalent: `LoomIcon`/`Brand`) |
| `tool-use-card.jsx`      | the `ToolCard` engine — five-part anatomy, five states        |
| `tool-use-showcase.jsx`  | gallery: 8-tool vocabulary + same-tool-across-5-states + anatomy legend |

## Known traps (from chat3.md, carried into the React port)

1. **No fragile fade-in on result / resolved-line.** The prototype's `fade-in`
   keyframe started at `opacity:0` with no fill-mode and got stuck invisible.
   Result + resolved bodies render instantly; only the spinner/skeleton/cursor
   animate (and those respect `prefers-reduced-motion`).
2. **No empty `( )` signature wrap.** Args render as a labelled key/value list,
   not a literal function signature, so an arg-less call never wraps awkwardly.
3. **`caused_by` sits on its own right-aligned footer line**, like a footer ref,
   never an awkward inline wrap inside the ribbon.

## Token mapping

The repo's `app/globals.css` already ships the loom token layer as plain
`var(--…)` custom properties (paper / ink / line / coral / again / hard / good /
info), matching `tokens.css` 1:1. The prototype's `tool-use.css` was ported to a
`.tool-use-card`-scoped block in `app/globals.css` using those existing tokens —
see the lane PR body for the full prototype→repo mapping table.
