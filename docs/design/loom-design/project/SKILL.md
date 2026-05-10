---
name: loom-design
description: Use this skill to generate well-branded interfaces and assets for Loom (Yukoval Studios), either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.

If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

## Quick orientation

- **Brand:** Loom — single-user personal learning tool. Three threads: knowledge graph, mistake-driven AI attribution, FSRS spaced review. First subject is classical Chinese (文言文), but the architecture is generic.
- **Visual register:** Claude.ai-adjacent — warm white paper, single coral accent, serif for display, low visual noise, 中文-first reading. No gamification, no emoji, no toasts.
- **Files to load first:** `README.md` for the system overview, `colors_and_type.css` for every token (link it directly into any new HTML), `ui_kits/loom-app/` for component patterns, `assets/loom-monogram.svg` + `loom-wordmark.svg` for the mark.
