# Loom Design System — Import Notes

Imported from claude.ai design handoff bundle on 2026-05-10.

## Status: REFERENCE ONLY

Not wired into the codebase — `src/index.css` still uses ad-hoc Tailwind. Treat
this folder as the visual / content source of truth that future PRs can pull
from when building or refactoring UI.

The plan: let claude.ai design re-output a complete production-ready design
system after Phase 1 closes (i.e., once Note artifact / Orchestrator / Source
layer all exist in the codebase). v1 here is the anchor; v2 will be the actual
production CSS.

## What was excluded from the import

- `project/fonts/` (~8 MB) — Source Serif 4 + MiSans TTF
- `project/uploads/` (~38 MB) — duplicate copies + Source Han Serif SC OTF

## What was patched on import

The bundle as exported from claude.ai had two functional issues that broke
the local previews. Both fixed inline in `project/colors_and_type.css`:

1. **`@import` was after `@font-face`** — invalid per CSS spec, so the
   Google Fonts CDN load (Noto Serif SC + JetBrains Mono) was being ignored.
   Moved `@import` to the top.
2. **Local `@font-face` rules pointed at `fonts/SourceSerif4-Regular.ttf` +
   `fonts/MiSans-Normal.ttf`** which we excluded above. Removed the local
   blocks; instead added Source Serif 4 to the Google Fonts `@import` (it's
   on the public CDN). MiSans isn't on Google's CDN — falls back to PingFang
   SC / Hiragino Sans GB on Apple OS via the `--font-sans` stack.
3. **3 undefined CSS tokens** referenced by `ui_kits/loom-app/styles.css`
   (`--fs-base`, `--lh-base`, `--ring`) — added as aliases of the existing
   tokens (`--fs-body`, `--lh-snug`, `--shadow-focus`).

If you later self-host MiSans / Source Serif 4 / Source Han Serif SC, drop
the `.ttf` / `.otf` into `project/fonts/` and replace the `@import` line with
`@font-face` blocks — the family names already match the `--font-*` stacks.

Fonts were dropped to keep repo size sane. Re-acquire when actually wiring CSS:

| Brand intent | Where to get it |
| --- | --- |
| Source Serif 4 (display) | Google Fonts CDN OR self-host from https://fonts.google.com/specimen/Source+Serif+4 |
| Geist (UI sans) | Google Fonts CDN OR https://github.com/vercel/geist-font |
| Noto Serif SC + Noto Sans SC | Google Fonts CDN |
| JetBrains Mono | Google Fonts CDN |
| 思源宋体 (思源/Source Han Serif SC) | https://github.com/adobe-fonts/source-han-serif (download release ZIP) |
| MiSans VF | https://hyperos.mi.com/font/ (license: Mi Open Font License) |

## Open decisions tracked elsewhere

See issue tracking the font picker (Geist as bundle says vs MiSans VF as user originally chose) and the Phase 1 → design v2 timeline.

## How to use this folder

1. **As content source**: read `project/README.md` for voice / typography / color rules. Quote from it in PR descriptions when justifying UI choices.
2. **As component reference**: `project/ui_kits/loom-app/` has 9 admin screens recreated as JSX with the design tokens applied. Look here when implementing a new page.
3. **As preview gallery**: open the HTML files in `project/preview/` directly in a browser to see colors / type / components rendered (no build needed).
4. **As Claude Code skill**: drop the entire folder into `.claude/skills/loom-design/` later (currently kept under `docs/` to keep skill activation explicit, not auto-applied).
