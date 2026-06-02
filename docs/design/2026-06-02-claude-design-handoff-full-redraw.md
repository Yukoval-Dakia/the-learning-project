# Loom — Full UI Redraw Handoff to claude.ai/design

> **For**: the standalone claude.ai/design agent. **From**: Claude Code (implements the result in a Next.js + React codebase).
> **This is a functional contract, not a style brief.** We are **not** prescribing any visual language — palette, typography, spacing, density, motion, shape, iconography, light/dark treatment, and overall aesthetic are **entirely yours to invent from scratch**. This doc tells you only **what the product is, what every screen must do, what data it shows, and what must keep working**. Design the rest however you think is best.
> **Scope**: the **whole app** — every surface below. Date 2026-06-02 · YUK-169. (A code-grounded inventory also lives at `docs/design/2026-05-30-claude-design-redraw-brief.md`, but this doc is self-contained.)

---

## 0. How to use this

1. Read §1 (the product model) — it explains the one idea that shapes the whole IA: **AI proposes, the human disposes.**
2. Walk §3 surface by surface. Each gives: what the screen is for, its content/sections, the data it shows (with realistic sample values so you design at true density), and the interactions that must exist.
3. Treat §4 as immutable (routes, data shapes, behaviors, accessibility). Everything else — the entire visual and even the layout/grouping/IA within a screen — is yours (§5).
4. Hand back per §6 so Claude Code can implement.

**On style: design freely.** There is a current implementation, but do not feel bound by it; you are not being asked to match or evolve any existing look. Invent the visual system you think best serves a focused, single-user study tool.

---

## 1. Product model (the one thing to internalize)

**Loom is a single-user, AI-augmented learning tool.** One person captures their mistakes, learning intents, and study materials; an AI layer organizes them into a knowledge graph, schedules spaced-repetition review, and surfaces coaching — and an FSRS review loop drives daily practice.

The defining principle, visible everywhere:

> **AI proposes; the human disposes.** Every AI action is an evidence-backed, reversible **proposal** the user reviews and accepts/dismisses — never a silent change. So the UI is full of: proposal inboxes, "accept / dismiss / undo" affordances, provenance ("who/what caused this"), confidence, and cost. These trust signals must be *present and legible* but should not dominate — they support the work, they aren't the work.

Other functional facts that shape the UI (not style directions):
- **Single user.** No login/multi-user/teams. (There's a separate admin area for observability.)
- **UI copy is Simplified Chinese.** Real labels are Chinese (samples below are the actual strings). Code identifiers, IDs, timestamps, costs, and version strings render in a monospaced register today — but the typographic treatment is your call.
- **Content is mixed**: Chinese prose, classical-Chinese passages, math (LaTeX), code, and structured question/answer trees all appear in note/review surfaces.
- **Recurring semantic states the design must keep visually distinguishable** (how is your choice, but they must be tellable apart *without relying on color alone*, for accessibility):
  - **FSRS rating, 3 tiers**: `again`(不会) · `hard`(模糊) · `good`(会了).
  - **Attribution**: AI-caused vs user-caused (and a transient "being attributed…" pending state).
  - **Knowledge-edge relation, 5 types**: prerequisite · related_to · contrasts_with · applied_in · derived_from.
  - **Status enum** across items/sessions: pending / in_progress / done / resting / dismissed / archived / extracted / partial / failed / queued / extracting.
  - **Proposal kinds** (what the AI can propose): knowledge_node, knowledge_edge, knowledge_mutation, learning_item, note_update, variant_question, record_promotion, record_links, completion, relearn, goal_scope, **block_merge** (new).

---

## 2. Global shell & navigation

- **Desktop**: a persistent top navigation with the product name and primary nav: **今日 · 录入 · 复习 · 错题 · 学习项 · 知识**. A theme toggle (light / dark / auto, persisted) lives in the shell. A small build/version string is shown.
- **Mobile**: a bottom tab bar with 5 destinations (今日 · 录入 · 复习 · 错题 · 知识) — 学习项 is reachable but dropped from the mobile bar.
- **Responsive**: every surface must work at mobile and desktop widths. Content today is width-capped on wide screens; the cap is your call.
- **Theme**: a complete light AND dark treatment is required (the toggle is a hard feature). Auto = follow system.
- **Separate admin shell** (area K): same product, different chrome, nav = Runs / Cost / Failures. Lower priority.

---

## 3. Surfaces (functional spec — design each freely)

### A · `/today` — daily hub (entry point; root `/` redirects here)
The "what should I do today" dashboard. Sections:
- **Header**: title 今日, a meta line (e.g. `TODAY · 2026-06-02 · phase 1c`), a one-line subtitle written in the product's voice (e.g. "昨晚 Dreaming agent 跑过；下面是它想让你看的几件事，再加你自己排的复习队列。"), and actions: open the **copilot** drawer, **刷新**, **录入**.
- **KPI row** — 4 clickable stats, each: label · big number · a small trend/sub-line:
  - FSRS · 到期 → **12** (→/review)
  - 错题 · 待归因 → **3** · "attempt:failure 无 judge" (→/mistakes)
  - AI 提议 · 待审 → **9** · "block_merge 2 · knowledge_edge 3 · note_update 4" (→/inbox)
  - 知识点 → **48** · "tree + mesh" (→/knowledge)
- **Active sessions strip** — resumable/abandoned review sessions, e.g. "`review` · started · 已复习 7 · again1/hard2/good4 · 14m · 物理·圆周运动" with **Resume →**; an abandoned one with **恢复**. Empty: "没有进行中的复习会话。"
- **AI-changes strip (24h)** — recent AI edits to notes/artifacts, each with provenance + an **undo**: e.g. "dreaming 改了 artifact · 3 ops · +1 block · v4→v5 · 2h 前 [撤销]". Empty: "过去 24 小时没有 AI 改动。" (This is the "human can revert AI" principle, foregrounded.)
- **Proposal inbox strip** — total pending + breakdown by kind (e.g. 9 待审 = block_merge 2 · knowledge_edge 3 · note_update 4) → /inbox.
- **Three lanes** (cards): A 复习队列·FSRS (badge "12 到期"; cause distribution; CTA 开始 review_session →), B 学习意图 (badge "5 在途"; CTA 打开 →), C Coach·周度报表 (badge "7d"; CTA 查看 → /coach).
- **Cost ribbon** — today's AI spend vs a $5 budget (e.g. **$1.84 / $5.00**) + a small per-task breakdown (dreaming $0.71 · vision_extract $0.52 · …) + tokens in/out + tool calls. De-emphasized but legible. Loading + error states.
- Every data section needs **loading** and **empty** states.

### B · `/record` — capture / ingestion (`/study-log` redirects here)
Dual-purpose capture. Mode tabs:
- **context** (学习记录): capture records of kind 疑问 / 顿悟 / 反思 / 资料; a knowledge-point picker.
- **manual** (错题录入): a form — 题型 · 题面 · 参考答案 · 错答 · 难度 (slider) · 知识点 (multi) · 错因 (multi-select).
- **vision_single / vision_paper**: camera / document capture → AI extracts question blocks; a review step to confirm extraction.
- **(new) auto_enrolled** — an "AI 自动录入" review surface: lists what the AI auto-enrolled / would enroll from an ingested page (route · confidence · suggested knowledge), each with a **revert** action. Also: for AI-routed captured blocks, the review step should surface the AI's suggested knowledge + a draft (outcome/difficulty/cause) as **editable prefilled fields**.
- Writes: new records, new mistakes, ingestion sessions. Loading/empty/error throughout.

### C · `/review` — spaced-repetition loop (FSRS) · highest-frequency surface
A focused single-card practice loop:
- **answering** phase: the prompt, a free-text answer box, a **reveal** action, a **skip** action.
- **feedback** phase: answer-vs-reference (split), the attribution (cause) of any error, an **attempt timeline**, the AI **judge result**, and a **rating advisor**; the user rates again/hard/good.
- **Keyboard shortcuts (must keep)**: Ctrl/Cmd+Enter = reveal · `s` = skip · `1/2/3` = rate again/hard/good · `a` = advice.
- **Session lifecycle (must keep)**: a session is created on entry, closed when the tab is hidden, resumable via a session id in the URL, and can be paused/resumed.
- Banners for review-intent and subject-switch moments. This whole family should feel fast and uncluttered — it's used daily, many cards in a row.

### D · `/knowledge` — knowledge graph + `/knowledge/[id]` node detail
- **`/knowledge`**: a **tree ↔ graph** toggle. Tree = hierarchy (parent/child). Graph = a mesh of typed edges (the 5 relation types), rendered as an interactive node-link diagram (currently Cytoscape; the viz library is your call as long as it's an interactive, pannable/zoomable mesh). A node-detail drawer must keep **hierarchy** and **relationships** visually separate. Edge proposals appear with decision controls (accept / reverse direction / change type / dismiss). A form to create edges (pick relation type). A mastery indicator per node (mastery % + evidence count + decay).
- **`/knowledge/[id]`**: single-node deep dive — metadata + mastery, neighbor links grouped by relation type, the node's primary note inline, backlinks (typed: atomic/hub/long/quiz), an activity timeline.
- Sample node: "圆周运动" · mastery 62% · 9 evidence · prerequisites: 牛顿第二定律, 向心加速度 · related: 简谐运动.

### E · `/mistakes` — error log + `/events/[id]` correction chains
- **`/mistakes`**: recorded errors as cards — prompt · wrong answer · knowledge badges · attribution (AI vs user) · correction-state. An inline expandable event chain; link to the full event page; empty-state CTA → /record. Refreshes on focus + polls.
- **`/events/[id]`**: the correction/causation chain for one event — the focal event, what caused it, what it caused, and corrections; controls to add a correction; collapsible raw payload. (The whole system is event-sourced: actions chain via "caused_by"; this screen visualizes that chain.)

### F · `/learning-items` — learning-intent decomposition + `/learning-items/[id]`
- **`/learning-items`**: type a learning intent (topic) → AI proposes a decomposition into a hub + atomic sub-items → accept. Status filter tabs (all/pending/in_progress/done/resting/dismissed/archived). Item cards with status-transition actions; inline knowledge editor.
- **`/learning-items/[id]`**: full editor — title/content inline edit, status transitions, knowledge chips, the **origin proposal** block (with a retract action + reason), a searchable parent picker, the **artifact view** (a block-tree note + generation/verification badges), and a children list. Has a **teaching drawer** ("对话教学" → an AI 1-on-1 teaching sidebar).

### G · Note / artifact authoring (block-tree) — inside `/learning-items/[id]`
A rich block-based note editor (TipTap/ProseMirror today). Must keep: **slash-command** block insert, **drag-handle** block reorder, a **cross-link** picker (link to knowledge/other notes), an interactive in-note quiz block ("embedded check"), a verification badge, and rendering of LaTeX / classical-Chinese / plaintext / code. Read-only and editable renderings both exist. (Two known fixes to fold in: a slash-inserted block must not nest illegally; the drag handle should only show on actually-draggable blocks.)

### H · `/inbox` — unified AI proposal triage
Every pending proposal in one place, grouped by kind. Each proposal card shows: the proposed change, evidence backlinks (→ the source event/record), and decision controls — **accept / dismiss**, plus kind-specific ones (edges: reverse direction / change type; some: retract). Kinds include the 12 in §1 — including the new **block_merge** (AI proposes merging two ingestion blocks that are actually one split question; the card should preview the primary + to-be-merged blocks and a continuity reason). A filter to show only proposals tied to a given evidence record. Sample: 9 pending — 2 block_merge, 3 knowledge_edge, 4 note_update.

### I · `/coach` — analytics
FSRS analytics over 7 / 30 / 90-day windows (toggle). A KPI strip (reviews · correct% · new mistakes · AI cost), a rating-distribution bar (again/hard/good/easy), per-day stacked bars, top knowledge points by failure count, and attribution distribution by cause. Read-only. Sample (7d): 84 reviews · 71% correct · 6 new mistakes · $4.10; top failing: 圆周运动 (5), 文言虚词 (4).

### J · `/learning-sessions` — review-session history + `/learning-sessions/[id]`
- **List**: past review sessions — status · reviewed count · rating breakdown · duration · knowledge chips — with detail / reopen / resume actions.
- **Detail**: session summary (type/status/duration/counts/cost), rating-distribution bar, an AI session summary, and a per-event stream linking to event pages.

### K · `/admin/*` — observability (separate shell, lowest priority)
`/admin/runs` (AI run log) · `/admin/cost` (spend) · `/admin/failures` (failed jobs). Tabular/observability surfaces; redraw last.

### Cross-cutting drawers
- **CopilotDrawer** — a right-side AI conversation drawer: scrollable transcript, streaming responses, and expandable cards showing the AI's tool calls (with cost). Reused in several places.
- **TodayCopilotDrawer** — the Today-specific instance (7-day coach summary + coaching on pending items).
- **TeachingDrawer** — AI 1-on-1 teaching for a learning item, with an idle-state behavior.
- Drawers need proper focus management (trap + restore) and keyboard dismissal.

---

## 4. Hard contracts — must survive the redraw (NOT up for redesign)

1. **Routes** (exact paths, immutable): `/today /record /review /mistakes /learning-items /learning-items/[id] /learning-sessions /learning-sessions/[id] /knowledge /knowledge/[id] /events/[id] /inbox /coach`; root `/`→`/today`; `/health`; `(admin)` `/admin/runs /admin/cost /admin/failures`.
2. **Data shapes**: the fields/shapes the surfaces read are fixed by the backend (the sample data above reflects real shapes). The redraw consumes them; it does not reshape the data model.
3. **Every interaction in §3** must remain: review keyboard shortcuts + session lifecycle (create-on-enter / close-on-hide / resume-by-url / pause), proposal accept/reverse/change-type/dismiss/retract, learning-intent decompose+accept, block-tree slash/drag/cross-link, undo of AI changes, theme persistence, evidence backlinks, focus mode in review.
4. **Accessibility** (functional, not style): full keyboard navigation of all interactive elements; focus management for drawers/modals/tab systems (trap + restore); semantic roles/labels for screen readers; and **state must never be conveyed by color alone** — the FSRS tiers, attribution, relation types, and statuses each need a non-color cue (shape/label/icon/text) in addition to whatever color you choose.

---

## 5. What's open (i.e. yours)

**Everything visual, and most of the structural:**
- The entire visual system — color, type, spacing, radii, shadow/elevation, motion, iconography, illustration, light/dark.
- Per-screen layout, grouping, section order, card vs list vs table, information density.
- Component shapes and states (buttons, badges, cards, inputs, drawers, charts, the graph viz).
- The typographic treatment of the Chinese/Latin/mono/math/classical-Chinese mix.
- How you make the recurring semantic states (§1) distinguishable.
- Whether to introduce new patterns (empty states, skeletons, onboarding hints, etc.).

The only limits are §4 (routes, data, behavior, a11y). If a layout change would require a data or route change, flag it rather than assume it.

---

## 6. What to hand back (so Claude Code can implement)

Whatever's natural for you (a Figma file, or screen specs), covering:
1. **A visual system / foundation** — your color/type/spacing/radii/elevation/motion decisions (with a complete dark mode), and the core reusable components (buttons, badges, cards, inputs, nav/shell, tabs, drawer, skeleton/empty states, charts, the graph node/edge styling). This is what makes every screen consistent.
2. **Each surface in §3** at desktop + mobile widths, using the real sample data, including loading / empty / error states.
3. Notes on any state/interaction nuances your design depends on (hover/active/focus/disabled, animation intent, responsive reflow).

Claude Code will translate the result into the Next.js + React + Tailwind-v4 codebase, implementing **slice by slice** (foundation first, then surfaces), each behind a per-slice design-doc pre-flight. So a clear foundation + component set first makes the implementation order clean — but design in whatever sequence suits you.

---

*This is a functional map. The look is yours.*
