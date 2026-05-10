# Loom · Design System

> **Loom** is Yukoval Studios' personal AI learning tool — a single-user system
> that weaves three threads (**knowledge graph**, **mistake-driven AI
> attribution**, **FSRS spaced review**) into one closed loop. First subject:
> 文言文 (classical Chinese). Architecture is generic.
>
> *Loom large = 占据重要位置 · Loom = 织机 · 错题、知识、复习三股线交织成学习闭环。*

This design system is the canonical visual + content reference for Loom.
It targets a **Claude.ai-adjacent aesthetic**: warm white + a single coral
accent, low visual noise, 中文-first typography, mobile + desktop dual-use,
**no gamification**.

---

## Sources

| Asset | Where |
| --- | --- |
| Codebase | [github.com/Yukoval-Dakia/the-learning-project](https://github.com/Yukoval-Dakia/the-learning-project) (`main`) |
| Internal planning | `PLANNING.md` and `docs/` in that repo |
| Stack | React 19 · TanStack Query · react-router-dom 7 · Tailwind v4 (CSS @layer) · Hono Cloudflare Worker · D1 · ts-fsrs · Vercel AI SDK |
| Existing routes | `/`, `/record`, `/mistakes`, `/ingest`, `/review`, `/learning-items`, `/knowledge`, `/knowledge/proposals`, `/_/inspect` |

The current product is **9 admin pages, no unified nav, ~30 ad-hoc Tailwind
color combos**. This design system is the *target* — it consolidates that
chaos into a small, named palette and a 中文-first type ramp.

---

## Index

| File / folder | What |
| --- | --- |
| `colors_and_type.css` | All CSS custom properties — colors, type, spacing, radii, shadows, motion |
| `assets/` | Logos, glyphs, the existing PWA icons |
| `fonts/` | (referenced via Google Fonts CDN — see Visual Foundations) |
| `preview/` | Single-purpose HTML cards rendered in the **Design System** tab |
| `ui_kits/loom-app/` | High-fidelity recreation of the 9 product screens, with extracted JSX components |
| `SKILL.md` | Cross-compatible Agent Skill manifest — `loom-design`, user-invocable |

---

## Caveats & open questions

- **Fonts are CDN substitutions.** Source Serif 4, Geist, JetBrains Mono load from Google Fonts. The classical-Chinese passage stack is `STKaiti, FangSong, "Songti SC", serif` — these are **system fonts**, so the look depends on the reader's OS (macOS / iOS render best; Android falls back to Songti). If you want a guaranteed look, ship a self-hosted CJK serif (e.g. Source Han Serif SC) and replace `--font-wenyan`.
- **Logo is a placeholder mark** — three woven curves through a square frame. No formal Loom branding existed in the codebase, so this is original. Treat it as a *first proposal*, not a final lockup.
- **Iconography is Lucide-flavored**, drawn inline at 1.75 stroke. The repo doesn't ship an icon set yet; if you adopt one, the closest match is `lucide-react` directly (already in the React 19 ecosystem).
- **`/_/inspect`, `/knowledge/proposals`, BackgroundTask retry UI** are mentioned in routing but not built in the UI kit — no design context existed. Flag if you need those.
- **Real FSRS rating outcomes** are mocked in the `/review` screen — pressing 1/2/3 just bumps `due` by a fixed delta. Wire up `ts-fsrs` for production.
- **Dark mode is not designed.** Only one paper-on-ink monogram swatch exists. If dark mode matters, that's a real iteration.
| `SKILL.md` | Agent-skill manifest — drop this folder into Claude Code as a skill |

---

## Brand · One paragraph

**Loom** is for one person — me, the user. It is not a productivity app and
it is not a tutor. It is a *workshop* where mistakes, knowledge, and review
are the three threads on a loom; the agent and the schedule are the shuttle.
The voice is quiet, technical, and occasionally dryly funny. The visuals are
warm and low-contrast, designed to live on a phone next to a 文言文 textbook
or on a desktop next to a Vite dev server. **Coral is the only accent** —
everything else earns its color through semantics (FSRS rating, attribution
status), never decoration.

---

## CONTENT FUNDAMENTALS

### Voice

- **First-person plural never; second-person rarely.** The user is the only
  user, so the system mostly states facts and observations. Avoid "you should"
  unless it's a direct call-to-action.
- **Technical specificity over reassurance.** "归因中..." not "正在思考..."
  "今日复习完毕（{n} 条）" not "做得好！"
- **Show the mechanism.** Surface task names, confidence percentages, FSRS
  ratings, version numbers. The user *built* this and wants to see the seams.
- **Dry, occasional humor — never cute.** "今天没有要复习的，太好了" is
  on-brand. "🎉 你真棒！" is not.

### 中英混排

- **中文 is primary.** Latin/numerals are inline. UI labels are 中文 first;
  technical tokens (`fsrs_state`, `cause`, `/review`) stay English/code.
- **No Chinese punctuation inside English-named tokens.** Use `·` (middle
  dot) as a soft separator: `录入中... · {filename}`.
- **Numbers read tightly:** `1 / {data.length}` (with thin spaces around `/`),
  not `第 1 个 / 共 {n} 个`.
- Use parentheses for confidence: `AI · concept (87%)`. Never use percentage
  bars or stars.

### Casing

- **English labels: Sentence case.** Buttons read "Refresh", not "REFRESH"
  or "refresh".
- **Never UPPERCASE 中文.** Letter-spacing wide labels are okay for English
  meta lines (`PHASE 1A · SUB 4A`), never for 中文.

### Examples (lifted verbatim from the codebase — stay close to these)

| Surface | Copy |
| --- | --- |
| Empty review | 今天没有要复习的，太好了 |
| In-flight AI | 归因中... |
| Stale AI | 待归因 |
| FSRS buttons | 不会 (1) · 模糊 (2) · 会了 (3) |
| Mistakes header | 最近 20 条 · 归因中 {n} / 已归因 {n} |
| Empty list | 还没创建任何学习项 — 试试 + 新增 |
| AI proposal source | AI · {category} ({confidence}%) |
| User edit source | 用户 · {category} |
| Action verb | 录入 · 复习 · 归因 · 拆分 · 合并 · 重学 |

### Emoji & decorative chars

**No emoji.** Ever. Not in copy, not in icon slots, not as section markers.
The brand reads as a quiet workshop, not a Notion page.

**Permitted unicode characters as semantic markers:**

- `·` (U+00B7) — soft separator: `录于 2026-05-09 · 文言文`
- `→` `↳` — directional flow in lists/breadcrumbs
- `—` — em-dash for asides
- `×` — close affordance
- `+ ` (literal plus + space) — "add" prefix on links: `+ 录新错题`

---

## VISUAL FOUNDATIONS

### Color philosophy

The palette is **paper, ink, and one coral**. There are exactly three places
non-coral color appears:

1. **FSRS rating tints** (`again` rust, `hard` amber, `good` sage) on the
   three review buttons and nowhere else.
2. **Attribution source tints** (`AI` info-blue, `user` good-sage) on the
   `<CauseBadge>` only.
3. **`<code>` blocks** which sit on `--paper-sunk`.

Anywhere else, color cleared by hairlines, ink hierarchy, and white space.

### Backgrounds

- **No gradients.** The product is a workshop, not a dashboard.
- **No full-bleed photography.** A Loom screen is text on paper.
- **No textures, no grain.** Solid `--paper` (#FAF9F5) everywhere; recessed
  surfaces use `--paper-sunk` (#F5F1E8).
- **No background imagery in admin pages.** A Loom screen is a sheet of warm
  paper with text inked onto it.

### Type

- Display & long-form 文言文: **Source Serif 4** (Latin) + **Noto Serif SC**
  (中文). Substituted for Tiempos Headline. ⚠ See *Font substitutions*.
- UI sans: **Geist** + **Noto Sans SC**. Substituted for Styrene B. ⚠
- Mono: **JetBrains Mono**. Substituted for Söhne Mono. ⚠
- Minimum on-screen size: **14px**. 中文 prose: **17px / line-height 1.7+**.
- 文言文 passages get `var(--font-wenyan)` and line-height `1.85`.

### Animation

- **Fades and translates only.** Slides, color crossfades, height auto on
  expand. No bounces, no springs, no parallax, no Lottie.
- Default duration: `200ms`, ease `cubic-bezier(0.22, 1, 0.36, 1)`.
- Page transitions: none — instant route change. The user knows where they
  are.
- Skeleton loaders are okay; spinners are okay; *no* progress bars on
  AI calls (use the `归因中...` text-state instead).

### Hover & press

- **Hover:** background lightens by ~6% on solid surfaces; on coral primary
  the bg goes from `--coral` → `--coral-hover`. On links, the underline
  thickens (color → `--coral`, `text-decoration-color` → coral).
- **Press:** background goes one step darker (e.g. `--coral-press`) and the
  element scales `0.98` for ~80ms — the only place we shrink.
- **No glow, no neon.** Focus uses the soft coral ring `--shadow-focus`.

### Borders & dividers

- Default `1px solid var(--line)` (#E8E4D8). Strong: `--line-strong`.
- Inputs: `1px solid var(--line)` at rest → `var(--coral)` on focus + ring.
- Cards on paper: `1px solid var(--line)` + `var(--shadow-1)`. Cards on
  paper-sunk: no border, just the surface elevation.

### Shadows

Three steps; all warm-tinted (`rgba(60,50,30,...)`), never neutral grey.

| Token | Use |
| --- | --- |
| `--shadow-1` | Card resting on paper |
| `--shadow-2` | Hovered card / popover |
| `--shadow-3` | Modal / dialog |
| `--shadow-focus` | `:focus-visible` |
| `--shadow-inset` | Recessed input on raised surface (rare) |

### Capsules vs protection gradients

Loom does not use protection gradients. Where text overlaps a tinted
surface, we use a **capsule** instead — a `--r-pill` rounded rectangle in
that surface's `*-soft` color with `*-ink` text. See `<CauseBadge>`,
`<StatusBadge>`, `<RatingButton>`.

### Transparency & blur

- Almost never. The mobile sticky-bottom action bar uses
  `backdrop-filter: blur(8px)` over `rgba(250, 249, 245, 0.85)`. Nothing
  else.

### Corner radii

`4 / 6 / 8 / 12 / 999`. Tags use 4, inputs and buttons 6, cards 8, modals 12,
chips/pills 999. **No 16px+ radii.** No "squircles" or asymmetric radii.

### Cards

- Resting card: `--paper-raised` (white) on `--paper` body, `1px solid
  --line`, `--shadow-1`, `--r-3` corners.
- A `<details>` *expandable* card uses no shadow — just the border.
- Lists of cards: `gap: var(--s-3)` (12px). Cards never touch.
- **Avoid** colored left-border accents and colored card backgrounds. Status
  is communicated through a `<*Badge>` capsule in the card header, not the
  card chrome.

### Layout

- Reading column: `--cap-prose` (680px). Admin form pages: `--cap-app`
  (960px). Tabular pages (`/knowledge`, `/_/inspect`): `--cap-wide` (1200px).
- Page padding: `var(--s-4)` mobile, `var(--s-6)` desktop.
- Nothing is absolutely positioned except the sticky bottom action bar on
  mobile review.

### Imagery vibe

When imagery is needed (PWA icon, future onboarding), it stays in the **warm
desaturated** family — coral + cream + ink, never cool blues or vivid
saturated colors. No grain, no noise, no photo-realistic illustrations.
Linework over fills.

---

## Font substitutions ⚠

The brand brief points at **Tiempos Headline / Styrene B / Söhne Mono**
(Klim Type Foundry) — all paid licenses we don't own. The system substitutes
the closest free Google Fonts:

| Brand intent | Substitute (loaded) | Notes |
| --- | --- | --- |
| Tiempos Headline | **Source Serif 4** | Slightly more contrast; readable at display size |
| Styrene B | **Geist** | Vercel's open sans-serif; geometric, similar humanist feel |
| Söhne Mono | **JetBrains Mono** | Different mono — broader, more readable on screen |
| 中文 serif | **Noto Serif SC** | Pairs with Source Serif 4 |
| 中文 sans | **Noto Sans SC** | Pairs with Geist |

**Action for the brand owner:** if Klim licenses are acquired, drop the
`.woff2` files into `fonts/` and replace the `@import` at the top of
`colors_and_type.css` with `@font-face` declarations using the same family
names (`Source Serif 4`, `Geist`, etc.) — no other code changes needed.

---

## ICONOGRAPHY

The codebase imports `lucide-react` (v0.468). Loom uses **Lucide** as its
icon set — no other libraries, no inline SVG, no emoji.

- **Style:** stroke-based, 1.75px weight, rounded line caps, 24px nominal
  grid. Lucide's defaults are correct — do not customize the stroke.
- **Color:** icons inherit `currentColor`. In-app, that's `--ink-3` for
  inactive, `--ink` for active, `--coral` for the single primary CTA.
- **Size:** 16px in chips, 18px in line with body, 20px in buttons, 24px
  in toolbar/header. Never bigger than 24px in admin chrome.
- **No icon fonts.** Lucide ships as React components and CDN SVGs.

For static HTML (preview cards, slides, this design system), pull Lucide
icons from CDN: `https://unpkg.com/lucide-static@latest/icons/{name}.svg`.

The PWA icons (`assets/icon-192.png`, `assets/icon-512.png`) are the only
raster brand marks today. The wordmark and monogram in `assets/` are SVG
(see `assets/loom-monogram.svg`).

**No emoji and no unicode pseudo-icons.** Use a Lucide glyph or use a text
label.

---

## A note on what's NOT here

- **No marketing site** — Loom is single-user; there is no landing page to
  recreate.
- **No mobile app** — the PWA *is* the mobile experience.
- **No Figma file** — the design source of truth is this folder + the
  codebase.

That means there is exactly **one UI kit**: `ui_kits/loom-app/`, which
recreates the 9 admin routes as a clickable prototype.

---

## How to use this system

1. **For prototype HTML / slides:** copy `colors_and_type.css` into your
   project and use the CSS custom properties directly. Lucide icons via CDN.
2. **For the Loom codebase:** the variables map cleanly into a Tailwind v4
   `@theme` block — see the `loom-app` UI kit's `index.html` `<style>` for
   the canonical mapping.
3. **As a Claude Code skill:** drop this whole folder into your skill
   directory. `SKILL.md` is the entry point.
