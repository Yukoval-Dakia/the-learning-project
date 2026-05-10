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
