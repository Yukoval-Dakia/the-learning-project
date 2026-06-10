# Timeout Defaults

_Started 2026-06-10 10:39 UTC_

---

## User

<system-info comment="Only acknowledge these if relevant">
Project title is now "loom-refresh"
Project currently has 58 file(s)
User is viewing file: Loom.html
Current date is now June 10, 2026
</system-info>

<pasted_text name="Pasted text (66 lines)">
# 练习面（流 + 卷架）功能 Handoff — 给 claude design

&gt; 2026-06-10 · 架构重写 M1 期间发出，供 claude.ai/design 出视觉稿；M2 落地。
&gt; 本文档**只写功能与数据契约，零风格规定**（风格由设计稿决定，落地时按既有 design tokens 体系实现）。
&gt; 概念来源：总 spec §1.6（D3/D4/D5/D12/D15），P2 spec §2 概念设计（REV 2 后仍有效）。

## 0. 一句话语境

这是一个单用户 AI 学习工具。AI 是编排者：用户每天打开「练习面」，做 AI 排好的练习流——不再有「到期队列」「复习页」这些机制暴露。练习面 = 两个视图：**流**（今天练什么，默认视图）+ **卷架**（卷的持久收藏与复盘）。

## 1. 视图一：练习流（默认）

**信息结构**：
- 今日流 = 有序 item 列表。item 两种：**散题**（单道题）与**卷**（有界题目集合的入口卡）。
- 每个 item 携带：来源标签（`decay` 记忆衰减复习 / `variant` 错题变式 / `new_check` 新学自测 / `paper` 打包卷 / `on_demand` 点播插入）、AI 排入理由一句话（第一人称，如「我昨晚看到你虚词那块衰减得厉害」）、状态（待做/进行中/已完成/跳过）。
- 流头部：今日进度概览（完成数/总数、预计剩余量）、AI 的开场白一句话（≤80 字）。
- 流尾部：今日完成后的收尾短结区（≤120 字，AI 生成）。

**交互行为**：
- 点散题 item → 进入**散题作答态**（见 §3）；做完即时反馈，流自动推进到下一项。
- 点卷 item → 进入**卷模式**（见 §4）。
- item 可跳过（跳过留在流尾可回头）；用户可向 AI 点播（自由文本入口，如「来份虚词专项卷」——提交后流内出现生成中占位，完成后变成新 item）。
- 流是活的：AI 白天可能增补 item（如答错后插入变式）——需要一个「新增」的可感知但不打断的呈现方式。

**数据契约**（M2 落地的 API 形状，设计可按此假设）：
```
GET /api/practice/stream?date=today →
{ date, opening_line, items: [{ id, position, item_kind: 'question'|'paper',
  ref_id, source, reasoning, status }], progress: { done, total } }
```

## 2. 视图二：卷架

**信息结构**：
- 全部卷的收藏：按状态分区（待做 / 在做 / 已完成），可按来源（AI 打包 / 点播 / 导入）与科目筛选。
- 每张卷卡：标题、来源、题数、创建时间；已完成卷另有：成绩摘要、完成时间。
- **完成卷可复盘**：点开看当时逐题作答、判分反馈、整卷小结、错题去向（已归因/已生成变式的线索链接）。

**交互行为**：卷架是浏览/复盘面，唯一写操作是从待做卷发起作答（进卷模式）。

## 3. 散题作答态

- 题面（可含图）、作答输入（文本 / 选项 / 手写拍照上传）、提交。
- **即时反馈**：判分结果（对/错/部分）、AI 反馈、评级建议（用户可改评级后确认）。
- 反馈卡上有**「不服判」入口**：点开附理由提交 → 异步重判（不阻塞流，结果回来后该卡更新 + 有可感知通知）。
- 随时可呼出**解题会话**（卡住时）：苏格拉底分级提示，逐级展开，不直接给答案；含手写图提交。

## 4. 卷模式

- 有界题目集合：逐题作答、可前后移动、**反馈缓冲**（做完整卷才显示对错——和散题的即时反馈是刻意相反的语义）。
- 交卷 → 整卷结果页：总分/逐题对错/AI 整卷小结；错题逐条带「不服判」入口。
- 中途可退出，进度保留（草稿自动保存已是后端现实）。

## 5. 不要设计的（明确出范围）

- 到期队列/复习页（已死）；笔记内自测（已死）；学习记录（疑问/顿悟，已死）。
- 工作台/today（M4 另出 handoff）；知识图谱面（M3）。
- 任何「机制暴露」：FSRS 参数、调度细节、proposal 内部状态不出现在练习面。

## 6. 设计需要回答的开放题

1. 流的形态：纵向列表 / 卡片队列 / 其它——「AI 在旁边陪练递题」的感觉怎么呈现最好？
2. 卷 item 在流里和散题的视觉区分度怎么做？
3. 「AI 白天增补 item」的非打断式呈现？
4. 散题即时反馈 vs 卷模式缓冲反馈——两种节奏的视觉语言如何区分？

</pasted_text>

<!-- The user explicitly selected the following skills for this project, as attachments to their message. These are not optional context — they define how you work. Use them. -->
<attached-skill name="Loom Design System New (design system)">
[Design System] This project uses the **Loom Design System New** design system. This is a binding choice for visual style — every visual must follow it. Don't invent colors, type, spacing, or components not grounded here.

Scope: the design system is a visual style reference only. Its guide may describe example products, brands, or people that are unrelated to the user and unrelated to the subject of this conversation. Never treat anything in the design system as a fact about the user, their work, or the topic they asked about.

    Explore it to find what you need:
    - Always copy out the fonts and colors you need
    - For prototypes and designs, always copy out any relevant components
    - If the design system contains existing mocks of products, and you were asked to design or prototype something similar, copy and fork those mocks to start your design. This helps you make high-quality designs.

    Explore it quickly to find relevant UI kits (e.g. mocks of existing products you can copy and fork)

Full system at `/projects/195b1262-ffd7-49c6-963a-4896a9677be1/`. Its guide is reproduced below so you don't need to fetch it:

<design-system-guide>
# Loom — Design System

&gt; **Loom** is an AI-driven general learning system: a personal, event-sourced
&gt; study tool where a human and a roster of AI agents co-author what you learn.
&gt; The interface is **Chinese-first**, warm, and quiet — a "warm-paper, single-coral"
&gt; aesthetic in the spirit of Claude, tuned for long reading sessions of dense
&gt; material (the reference subject is 文言文 — classical Chinese).

This repository is a **design system**: the brand's visual foundations (color,
type, spacing, motion), its real assets, and a high-fidelity, interactive **UI
kit** recreating the product. Use it to build new Loom screens, marketing
material, prototypes, or decks that look and feel native to the product.

---

## What Loom is

Loom is a self-hosted, single-user learning app. Its core idea is an
**event-sourced model** (ADR-0006): every meaningful thing — you attempting a
question, an AI judging *why* you got it wrong, a nightly agent proposing a new
flashcard variant, the system extracting text from a photographed exam — is an
immutable `event` with an `actor_kind` (`user` / `agent` / `cron` / `system`),
a `caused_by_event_id` chain, and a micro-USD cost. Every screen is a **view
over that event log**.

The product surfaces six core routes:

| Route | 中文 | Purpose |
|-------|------|---------|
| `/today` | 今日 | Learning orchestrator — KPI strip, last night's "Dreaming" agent proposals, three lanes (review queue · learning intent · AI coach), cost ribbon |
| `/record` | 录入 | Unified ingestion — type a question, snap one, or photograph a whole exam paper; OCR runs as an async job streamed over SSE |
| `/review` | 复习 | FSRS spaced-repetition rating (不会 / 模糊 / 会了) with the AI's prior failure-attribution shown inline |
| `/mistakes` | 错题 | Wrong answers, each with the AI's `caused_by`-chained attribution + generated variants / notes you accept or dismiss |
| `/knowledge` | 知识 | A knowledge graph: a **tree** backbone (parent_id) plus a typed **mesh** of cross-edges; AI proposes new nodes and relations |
| `/items` | 学习项 | Parked learning intentions (TODO / goal layer), decoupled from the event log |

Plus a **Copilot drawer** — a tool-using agent that can query your mistakes,
propose variants, and explain, surfacing its `tool_use` calls as first-class
cards rather than hiding behind chat.

The throughline: **AI is an agent with tools and a cost, not a chatbot.** The UI
always attributes who did what (user vs. agent vs. cron), shows the reasoning
chain on demand, and keeps the human in the approve/dismiss loop.

---

## Sources

This system was reverse-engineered from a single, unusually complete design
handoff bundle. The reader is encouraged to explore it directly for deeper
fidelity:

- **GitHub repo:** [`Yukoval-Dakia/the-learning-project`](https://github.com/Yukoval-Dakia/the-learning-project)
  — a Next.js + Postgres + pg-boss self-hosted app.
  - **Canonical design bundle:** [`docs/design/loom-design-v2.1/`](https://github.com/Yukoval-Dakia/the-learning-project/tree/main/docs/design/loom-design-v2.1)
    — `tokens.css`, `app.css`, `primitives.jsx`, `pages.jsx`, `data.jsx`,
    `index.html`. This is the source of truth for the UI kit in `ui_kits/loom/`.
  - **Redraw brief:** `docs/design/2026-05-30-claude-design-redraw-brief.md`
  - **Architecture / ADRs:** `docs/architecture.md`, `docs/adr/` (ADR-0006
    event model, ADR-0008 sessions, ADR-0010 knowledge mesh)

&gt; The original bundle is itself a "Claude Design → coding agent" handoff, so its
&gt; tokens and components are production-shaped. Where this design system needed to
&gt; infer (marketing voice, logo lockups), it extends the bundle's established
&gt; language rather than inventing.

---

## CONTENT FUNDAMENTALS

How Loom writes. The voice is **a sharp, technical friend** — Chinese-first,
lowercase, unfussy, and unusually transparent about what the machine is doing.

### Language &amp; casing
- **Chinese is primary.** UI copy, headings, and body are 简体中文. Technical
  identifiers stay in English/code: table names (`learning_item`), event fields
  (`action=review`, `outcome=failure`), IDs (`e_20`, `q3`, `k_xuci_zhi`).
- **Latin technical terms are lowercase**, even in headings: "phase 1c",
  "tool-use", "mesh", "FSRS", "cron". UPPERCASE is reserved for short Latin
  eyebrows (`TODAY ·`, `KNOWLEDGE ·`) and acronyms. **Never UPPERCASE Chinese.**
- Code and Chinese are freely **interleaved in one sentence** — this is a
  signature of the voice: *"attempt:failure 无 judge 子事件"*, *"events WHERE
  action='propose' AND subject_kind='learning_item'"*.

### Tone &amp; person
- **Second person, casual, direct.** Addresses the user as 你. Eyebrow copy reads
  like a colleague narrating: *"昨晚 Dreaming agent 跑过；下面是它想让你看的几件事。"*
  ("Last night the Dreaming agent ran; here are a few things it wants you to see.")
- **Conversational micro-prompts** with a question mark: *"昨晚 AI 提议了 5 条，要看吗？"*
  ("AI proposed 5 things last night — want to look?")
- **Warm but never cute.** Empty states are gently human: *"今天没有要复习的，太好了。"*
  ("Nothing to review today — great.") No exclamation-mark hype, no mascots.

### AI transparency is a content rule, not just a feature
- Every AI surface is **attributed and priced**: *"AI · attribution (87%)"*,
  *"跑了 120 分钟 · $0.067"*, *"Haiku · ~$0.005"* vs *"Sonnet · ~$0.18"*.
- Confidence is shown as a percentage. Cost is shown in dollars to 3–4 decimals.
- The user is always the approver: actions are *接受 / 忽略 / 改方向 / 改关系*
  (accept / dismiss / reverse / change-type), never silent automation.

### Eyebrows expose the query
A signature pattern: page eyebrows literally show the data query behind the view.
&gt; `MISTAKES · events action=attempt outcome=failure`
&gt; `KNOWLEDGE · 9 nodes · 6 edges (mesh)`
&gt; `RECORD · session=s_ingest_now · LearningSession(type='ingestion')`

This is intentional — it teaches the user the system's mental model.

### Punctuation &amp; rhythm
- The **middle dot `·`** is the universal separator (`phase 1c · adr-0006 v2`).
- Full-width Chinese punctuation: 「」for quotes, ，。in prose.
- Numbers and units are split for emphasis: a big numeral, then a small unit
  (`6` 题, `1` 条, `5` 条).

### Emoji
- **None.** No emoji anywhere in product copy or UI. Iconography is line-icons
  only (see ICONOGRAPHY). A single moon glyph appears *as a Lucide icon* for the
  `cron` actor — never as an emoji character.

---

## VISUAL FOUNDATIONS

The feeling: **warm paper, one coral thread, soft warm shadows, generous reading
air.** It reads like a well-set book that happens to be a database UI.

### Color
- **Warm-paper neutrals, not gray.** Backgrounds are warm off-whites
  (`--paper #FAF9F5`, `--paper-sunk #F5F1E8`, raised cards pure `#FFFFFF`). Text is
  **warm slate ink** in a 5-step ramp (`--ink #1F1E1D` → `--ink-5 #B6B3A8`), never
  pure black, never cool gray.
- **One accent: coral `#D97757`** ("织线珊瑚" — woven-thread coral). It is the
  *only* chromatic brand color — used for primary actions, links, the brand mark,
  selection, and the most important AI-proposal highlights. Coral ships a full
  quartet: base / hover (`#C2553A`) / press (`#A93F26`) / soft tint (`#FAEDE5`).
- **Semantic colors map to FSRS recall + AI attribution**, each a four-part set
  (base / soft-bg / line / ink): **again** (不会, brick red), **hard** (模糊,
  ochre), **good** (会了, sage green), **info** (AI-attributed, muted blue). These
  are desaturated and earthy — they sit *in* the paper world, never neon.
- Hairlines are warm too (`--line #E8E4D8`).

### Typography
- **Three families.** Serif (**Source Serif 4** + Noto Serif SC) for display
  headings (h1/h2) and all 文言文 passages; **sans** (Noto Sans SC / MiSans) for
  in-app UI (h3–h6, body); **JetBrains Mono** for IDs, event keys, costs.
- **Serif headlines, sans UI** is the core type contrast — book-like titles over
  a crisp functional body.
- Chinese gets **more line-height** (`--lh-prose 1.7`, `--lh-loose 1.85` for
  classical passages). Tight leading (1.35) only on big Latin display.
- **Mobile-first scale; nothing below ~13px ships.** Body is 15px, preferred
  reading 17px. Big numerals (KPIs) pair a large figure with a small unit.

### Spacing &amp; layout
- Strict **4-pt grid** (`--s-1 … --s-24`).
- **Capped reading columns** — `--cap-prose 680px`, `--cap-app 960px`,
  `--cap-wide 1200px`. Content is centered and bounded; **no blind full-bleed
  stretching** on large screens. This is a deliberate brand rule: dense, legible,
  book-like — not a sprawling dashboard.
- Responsive: the same components reflow from phone → tablet → desktop; the top
  nav and lanes collapse gracefully.

### Backgrounds, surfaces &amp; cards
- Backgrounds are **flat warm paper** — **no gradients, no photos, no textures,
  no illustration washes.** Depth comes only from the paper/sunk/raised triad and
  soft shadow.
- **Cards:** white (`--paper-raised`) on paper, **1px warm border** (`--line`),
  radius **8px** (`--r-3`; 12px `--r-4` for large/modal), **soft warm shadow**
  (`--shadow-1`/`-2`). Never a hard or cool-gray shadow. AI-proposal cards get a
  coral or info tinted background + tinted border instead of a colored left rule.
- **Capsules / badges:** pill-shaped (`--r-pill`), tinted soft-bg + matching
  line + ink. Used for tones, actor labels, statuses.

### Shadows &amp; elevation
- A 3-step warm shadow scale, all built from `rgba(60,50,30, …)` — **warm brown,
  low opacity, never crisp black.** `--shadow-1` (rest cards) → `--shadow-3`
  (modals/drawers). Plus `--shadow-focus` (3px coral glow) and a subtle top
  `--shadow-inset`.

### Motion
- **Soft, quick, no bounce.** Standard easing is `--ease-out
  cubic-bezier(0.22,1,0.36,1)`; durations `--dur-fast 120ms` / `--dur-base 200ms`
  / `--dur-slow 320ms`.
- Transitions are **fades, gentle slides, and color shifts** — the Copilot drawer
  slides in, proposal cards fade on accept/dismiss, the knowledge graph settles
  via a Verlet simulation. No spring-y overshoot, no decorative looping animation
  on content.
- Respects `prefers-reduced-motion`.

### Interaction states
- **Hover:** links and coral shift to the darker `--coral-hover`; buttons darken
  slightly and lift shadow one step. Nav items gain a soft paper-sunk background.
- **Press:** coral goes to `--coral-press` (darker, not a separate hue); no shrink
  transform.
- **Focus:** 3px coral glow ring (`--shadow-focus`), never a hard outline.
- **Selection:** coral-soft background, coral-ink text.

### Borders &amp; radii
- Hairline borders everywhere (1px warm). Radii: 4px chips · 6px inputs/buttons ·
  8px cards · 12px modals · pill for badges. Consistent and modest — nothing
  super-rounded.

### Transparency &amp; blur
- Used **sparingly.** No glassmorphism. The Copilot drawer and modals sit on a
  faint scrim; surfaces stay opaque so text contrast holds against warm paper.

---

## ICONOGRAPHY

- **Lucide line icons**, inlined as SVG paths on a **24-unit grid with 1.75 stroke
  weight**, `currentColor`, round caps/joins. The product vendors its own subset
  (~35 glyphs) in `primitives.jsx` (`ICONS` map) — nav, chrome, action verbs, and
  proposal types. See `ui_kits/loom/primitives.jsx` for the exact set.
- For new work, pull matching icons from **[Lucide](https://lucide.dev)** (CDN or
  the inlined set) to keep stroke weight and grid identical. This is a documented
  substitution that *matches* the product's own icons — not a foreign set.
- **The brand mark** is custom: three woven curves threaded through a rounded
  frame (a "loom"), drawn in coral with descending opacity on the threads. It is
  the only filled/bespoke vector; everything else is Lucide line. Assets:
  - `assets/loom-mark.svg` — the mark alone (square, 64×64).
  - `assets/loom-logo-lockup.svg` — mark + "Loom" wordmark in Source Serif 4.
- **No emoji. No unicode pictographs as icons.** The only non-Lucide glyphs are
  arrows/relations rendered as typographic characters in the knowledge mesh
  (`→ ↔ ⇆ ↳`) and the `·` separator — these are typography, not icons.
- Actor identity uses specific Lucide glyphs: `user` (用户), `bot` (AI agent),
  `moon` (cron / nightly Dreaming), `cog` (system).

---

## Index — what's in this repo

| Path | What it is |
|------|------------|
| `README.md` | This file — product context, content + visual foundations, iconography, index |
| `colors_and_type.css` | The portable token layer: all color, type, spacing, radius, shadow, motion vars + semantic element styles. **Link this to inherit the brand.** |
| `fonts/NOTES.md` | Font stack + the CJK substitution flag (see Caveats) |
| `assets/` | `loom-mark.svg`, `loom-logo-lockup.svg` — brand marks |
| `preview/` | Small spec cards rendered in the Design System tab (color, type, spacing, components) |
| `ui_kits/loom/` | **The UI kit** — a high-fidelity, interactive recreation of the full product (6 routes + Copilot). See its own `README.md`. |
| `SKILL.md` | Agent-skill manifest so this system can be used directly in Claude Code |

### UI kits
- **`ui_kits/loom/`** — the Loom app. `index.html` boots all six routes with a
  live Tweaks panel exposing the product's open design questions. Built from the
  canonical bundle: `tokens.css`, `app.css`, `primitives.jsx`, `pages.jsx`,
  `data.jsx`.

There is **one product surface** (the app). No marketing site or docs site exists
in the source, so none is recreated here.

---

## Caveats

- 🚩 **Chinese fonts are substituted.** Source Serif 4 and JetBrains Mono are
  exact; the CJK faces use Noto Serif/Sans SC as stand-ins for the intended
  licensed MiSans + Source Han. See `fonts/NOTES.md`.
- No marketing/brand site, slide template, or photography exists in the source,
  so this system covers the **product** only. Logo lockups here are a faithful
  extension of the in-product brand mark, not a separately-authored brand kit.

</design-system-guide>

CSS tokens: the guide may describe tokens in prose, but the exact `--*` names are defined in the design system's stylesheet(s) (`/projects/195b1262-ffd7-49c6-963a-4896a9677be1/colors_and_type.css`, `/projects/195b1262-ffd7-49c6-963a-4896a9677be1/ui_kits/loom/app.css`, `/projects/195b1262-ffd7-49c6-963a-4896a9677be1/ui_kits/loom/tokens.css`). The 86 custom properties it defines are:

--again, --again-ink, --again-line, --again-soft, --cap-app, --cap-prose, --cap-wide, --coral, --coral-hover, --coral-ink, --coral-line, --coral-press, --coral-soft, --dur-base, --dur-fast, --dur-slow, --ease-in, --ease-out, --ease-soft, --font-mono, --font-sans, --font-serif, --font-wenyan, --fs-body, --fs-body-lg, --fs-caption, --fs-display, --fs-h1, --fs-h2, --fs-h3, --fs-h4, --fs-h5, --fs-h6, --fs-meta, --good, --good-ink, --good-line, --good-soft, --hard, --hard-ink, --hard-line, --hard-soft, --info, --info-ink, --info-soft, --ink, --ink-2, --ink-3, --ink-4, --ink-5, --lh-loose, --lh-prose, --lh-snug, --lh-tight, --line, --line-soft, --line-strong, --ls-normal, --ls-tight, --ls-wide, --paper, --paper-raised, --paper-sunk, --paper-tint, --r-1, --r-2, --r-3, --r-4, --r-pill, --s-1, --s-10, --s-12, --s-16, --s-2, --s-20, --s-24, --s-3, --s-4, --s-5, --s-6, --s-8, --shadow-1, --shadow-2, --shadow-3, --shadow-focus, --shadow-inset

Only use `var(--*)` names from that list. Never guess a token name — an unresolved `var()` silently falls back to the browser default.

For assets and UI kits beyond the guide: `read_file("/projects/195b1262-ffd7-49c6-963a-4896a9677be1/<path>")` and `copy_files` to bring them into the current project.
</attached-skill>

## Assistant

_[tool: list_files]_

_[tool: list_files]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: questions_v2]_

## User

Questions timed out; go with defaults

## Assistant

_[tool: update_todos]_

_[tool: read_file]_

Defaults it is — I'll make the calls: build the new 练习面 directly into the existing Loom prototype (复习/练习 merge into one 练习 entry), full clickable flow (流 → 散题作答 → 卷模式 → 交卷结果 → 卷架复盘), 文言文 content, demoable AI 增补 and 不服判 async re-judge. Let me absorb the existing component vocabulary first.

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: grep]_

_[tool: grep]_

_[tool: grep]_

_[tool: grep]_

_[tool: write_file]_

Now building. First the data layer:

_[tool: write_file]_

Now the stylesheet:

_[tool: write_file]_

Now the host screen:

_[tool: write_file]_

Now the stream view:

_[tool: str_replace_edit]_

_[tool: write_file]_

_[tool: write_file]_

Now 卷模式 + 结果页 + 复盘:Now the 卷架 shelf:

_[tool: write_file]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now wiring into the app shell:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Two small consistency fixes (done-row should show the judgment, and carry the 改判 flag):

_[tool: show_html]_

_[tool: show_html]_

_[tool: multi_screenshot]_

_[tool: multi_screenshot]_

_[tool: show_html]_

_[tool: multi_screenshot]_

_[tool: grep]_

_[tool: read_file]_

_[tool: save_screenshot]_

_[tool: save_screenshot]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: show_html]_

_[tool: multi_screenshot]_

_[tool: str_replace_edit]_

Paper mode → result flow works end-to-end. Fixing the result hero wrap + paper title flex, then checking shelf/retro and resetting demo state:

_[tool: multi_screenshot]_

_[tool: show_html]_

_[tool: multi_screenshot]_

_[tool: get_webview_logs]_

_[tool: done]_

_[tool: fork_verifier_agent]_

新练习面已并入 Loom 原型（侧栏「复习/练习」合并为单一「练习」入口，旧复习路由仍可达但已退出导航）。对 §6 四个开放题的回答都做进了交互里：

- **§6.1 流的形态** — 一条「织线」纵轨：item 挂在线上，AI 开场白 + 每条第一人称理由陪练递题；做完的项收紧成织入的一行
- **§6.2 卷 vs 散题** — 卷 item 是「摞起的纸」（层叠纸边 + 衬线标题 + 「交卷统一判分」胶囊），散题是平卡
- **§6.3 白天增补** — Tweaks 里有「模拟 AI 增补」按钮：新 item 滑入 + 渐褪珊瑚光 + 流顶一枚可点的通知 pill，不打断
- **§6.4 两种节奏** — 散题反馈即时着色（颜色=判定）；卷模式全程零语义色（pip 只有中性墨点），颜色在交卷瞬间才进场

全链路可点：流 → 散题作答（即时判分 / 评级可改 / **不服判异步重判**约 7 秒后回执 + toast / **解题会话**三级苏格拉底提示 + 手写图）→ 卷模式（草稿持久、中途退出可恢复）→ 交卷结果页（整卷小结 + 错题去向）→ 卷架（来源筛选 + 两份已授权复盘）。点播 composer 在流尾，提交后出现生成中占位。

注意事项：进度持久化在本地，玩乱了用 Tweaks「重置练习面演示」；点播生成的示例卷未配题面（作答演示走今日卷）。后台校验正在跑，有问题我会跟进。

## User

Found issues — fixing…

## Assistant

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

_[tool: fork_verifier_agent]_

已修复：`PfaceSolo` 现按 item id 作 key，切到下一道散题时作答状态（phase/选项/评级）会完整重置，不再带着上一题的判定串题。验证子代理正在复跑这条链路，有问题我会再跟进。

