# Loom · claude-design UI Redraw Brief

> **Status**: working brief for the planned from-scratch claude-design UI redraw (Project: north-star YUK-143 track). DOCS ONLY — this file changes no code, tokens, or components.
>
> **Date**: 2026-05-30 · **Branch**: `chore/ui-redraw-brief` · **Refs**: YUK-143

---

## 1. Purpose

The project has run its feature waves to v1 closeout under an explicit, deliberate UI stance:

> **"UI functionally correct + design-tokens only, defer visual polish."**

Every v1 UI lane shipped against that contract — pages are wired to the right data, use the design tokens in `app/globals.css`, and reuse the `src/ui/primitives/*` set, but pixel-level visual polish was intentionally deferred. The project grill landed on a **big claude-design redraw after the feature waves**, and `docs/planning/v0.5-maintenance-roadmap.md` §3 ("UI redraw-pending") parks a list of visual-only items for that redraw to absorb.

This brief is the map the redraw works from. Unlike the prior design briefs (`docs/design/2026-05-15-design-brief-v2.1.md`, which framed v2.1 as an *iteration* — "preserve 95%, refine 6 spots"), **this redraw is a from-scratch rebuild of the visuals**. So the brief's job is to nail down what MUST survive functionally (routes, data contracts, interactions, a11y) while leaving the visual layer fully open — and to fold in the deferred UI debt so it gets fixed inside the redraw rather than re-deferred.

The UI is branded **Loom**. The current visual language and prototype source of truth live in `docs/design/loom-design-v2.1/` (a static HTML/CSS/JS claude-design handoff bundle) plus the active brief `docs/design/2026-05-15-design-brief-v2.1.md`.

---

## 2. UI surface inventory (functional contract — MUST preserve)

Routing: Next.js 15 App Router. Three route groups under `app/`:
- `(app)` — the main authenticated shell (`TopNav` desktop + `TabBar` mobile, wrapped in `TokenGate`).
- `(admin)` — separate admin shell, same chrome primitives, nav = Runs/Cost/Failures.
- root + `health` — `/` redirects to `/today`; `/health` is the unauthenticated liveness page.

`middleware.ts` rejects any `/api/*` lacking `x-internal-token` except `/api/health`. Single-user tool — no per-user auth.

### Shell / navigation
- **`app/(app)/layout.tsx`** — desktop `TopNav` (nav items: 今日/录入/复习/错题/学习项/知识) + mobile `TabBar` (5 tabs; `/learning-items` dropped on mobile for thumb reach) + `ThemeToggle` in trailing slot. `activeFromPath()` maps `/inbox` → "today" active. Version string shown in mono.
- **`app/(admin)/layout.tsx`** — admin chrome, nav = Runs/Cost/Failures, version `admin · YUK-41`.

### Area A — Dashboard / Today hub
- **`/today`** (`today/page.tsx`) — central KPI hub. Reads `/api/review/due`, `/api/mistakes`, `/api/learning-items`, `/api/knowledge`, `/api/today/proposals`, `/api/cost/today`, `/api/learning-sessions`, `/api/today/ai-changes`. Surfaces: SessionStrip (active/paused sessions), AiChangeActivityStrip (24h AI artifact changes with undo), InboxStrip (proposal breakdown by kind → `/inbox`), three lanes (review queue / learning intent / coach 7d), CostRibbon (daily spend vs $5 budget). Today-specific `TodayCopilotDrawer` (`src/ui/today/`).

### Area B — Record / ingestion
- **`/record`** (`record/page.tsx`) — dual-panel record + error entry. MODE_TABS: `context` (learning records), `manual` (error entry), `vision_single`, `vision_paper`. Reads `/api/records` (kind filter 疑问/顿悟/反思/资料), `/api/knowledge` (picker). Mutates `POST /api/records`, `POST /api/mistakes`. Components: RecordContextPanel, ManualForm (题型/题面/参考答案/错答/难度 slider/知识点/错因 multi-select), VisionTab (camera/document capture).
- **`/study-log`** — redirect to `/record`.

### Area C — Review / flashcard (FSRS)
- **`/review`** (`review/page.tsx`) — spaced-repetition loop. Reads `/api/review/plan`, `/api/questions/[id]/timeline`, `/api/review/advice`. Mutates `POST /api/review/submit`, `POST /api/learning-sessions` + `/end` `/pause` `/resume`, `PATCH /api/learning-sessions/[id]`. Session lifecycle: eager create on mount, close via `sendBeacon` on pagehide, resumable via `?session=<id>`. Phases: `answering` (textarea + reveal + skip) and `feedback` (answer/reference split, cause badge, attempt timeline, judge result, rating advisor). Keyboard: Ctrl/Cmd+Enter reveal, `s` skip, `1/2/3` rate, `a` advice. Components: ReviewSessionChrome, AttemptTimeline, JudgeResultPanel, ReviewAnswerPreview, ReviewIntentBanner, ReviewSubjectSwitchMarker (all `src/ui/components/` + `src/ui/review/`).

### Area D — Knowledge graph
- **`/knowledge`** (`knowledge/page.tsx`) — tree + mesh (Cytoscape, fcose layout). Reads `/api/knowledge`, `/api/knowledge/edges`, `/api/knowledge/proposals`, `/api/events?action=propose&subject_kind=knowledge_edge`, `/api/mistakes`, `/api/knowledge/review-due-summary`. Mutates `POST /api/knowledge/edges`, proposal accept/dismiss/retract. Tree↔Graph toggle; node detail drawer separates 层级·tree (parent_id) from 关系·mesh (edges) physically (per v2.1 §2.3.a); EdgeProposalCard with decision buttons (accept / reverse direction / change type / dismiss); EdgeCreateForm (relation: prerequisite/related_to/contrasts_with/applied_in/derived_from); MasteryBadge per node.
- **`/knowledge/[id]`** (`knowledge/[id]/page.tsx`) — single-node deep dive. Reads `/api/knowledge/[id]` (mesh_neighbors, primary_atomic, backlinks, timeline). Metadata card + mastery, mesh-neighbor chiplinks by type, primary atomic inline (BlockTreeRenderer or CTA to `/learning-items`), backlinks with type badges (atomic/hub/long/quiz), activity timeline.

### Area E — Error attribution & tracking
- **`/mistakes`** (`mistakes/page.tsx`) — recorded errors. Reads `/api/mistakes?limit=100` (refetch on window focus + 30s poll). MistakeCard (prompt, wrong answer, knowledge badges, CauseBadge, correction_state badge); inline EventChain `<details>` retained here (per v2.1 §1.1); link to `/events/[id]`; empty-state CTA → `/record`.
- **`/events/[id]`** (`events/[id]/page.tsx`) — correction chain. Reads `/api/events/[id]` (event + caused_by + caused_events + corrections). Focal EventCard, CorrectionControls, upstream/downstream/corrections sections, collapsible payload.

### Area F — Learning intent decomposition
- **`/learning-items`** (`learning-items/page.tsx`) — intent hub + atomic decomposition. Reads `/api/learning-items`. Mutates `POST /api/learning-intents` (topic → hub+atomics), `POST /api/learning-intents/[id]/accept`. Intent textarea + 提议拆分 button; IntentProposal panel; status filter tabs (all/pending/in_progress/done/resting/dismissed/archived); item cards with STATUS_TRANSITIONS action buttons; inline knowledge editor.
- **`/learning-items/[id]`** (`learning-items/[id]/page.tsx`) — full detail editor. Reads `/api/learning-items/[id]`, `/api/learning-items?limit=200` (parent candidates). Mutates `PATCH /api/learning-items`, `POST /api/proposals/[id]/retract`. Title/content inline edit (blur PATCH), status transitions, knowledge chips, SourceEventBlock (origin proposal + retract CTA with reason), ParentPicker (searchable), ArtifactView (BlockTree + generation/verification badges), children list. **TeachingDrawer** ("对话教学" button → AI teaching sidebar, `src/ui/components/TeachingDrawer.tsx`).

### Area G — Note / artifact authoring (block-tree)
- Lives inside `/learning-items/[id]` ArtifactView. Components: ArtifactBlockTree (editable, `src/ui/block-tree/`), BlockTreeRenderer (read-only), ArtifactSections, NoteRenderer (`src/ui/components/NoteRenderer/` — latex/wenyan/plaintext/code notation), EmbeddedCheckSection (interactive in-note quiz), VerificationBadge. Block-tree is TipTap/ProseMirror with slash-command insert + drag-handle reorder + cross-link picker (`src/ui/block-tree/SlashCommandSuggestion.tsx`, `CrossLinkSuggestion.tsx`, `tiptap-extensions.tsx`).

### Area H — AI proposal triage
- **`/inbox`** (`inbox/page.tsx`) — unified proposal triage. Reads `/api/proposals?status=pending&limit=200`, `/api/knowledge` (name resolution); `?evidence_record=<id>` filter. Mutates accept/dismiss/retract. Grouped by kind (knowledge_node/knowledge_edge/learning_item/note_update/…); EdgeProposalCard, NodeProposalCard, GenericProposalCard (proposed_change JSON + EvidenceRefChip backlinks → `/events` / `/record`).

### Area I — Analytics & coaching
- **`/coach`** (`coach/page.tsx`) — FSRS analytics over 7/30/90d windows. Reads `/api/review/weekly?days=<N>`. Window toggle, KPI strip (reviews/correct%/new mistakes/AI cost), stacked rating bar (again/hard/good/easy), daily stacked bars, top 知识点 by failure_count, 归因分布 by cause. No mutations.

### Area J — Session management
- **`/learning-sessions`** (`learning-sessions/page.tsx`) — review session history. Reads `/api/learning-sessions?type=review&limit=50`. Mutates `POST /api/review/sessions/[id]/reopen`. SessionRow (status, reviewed_count, rating breakdown, duration, knowledge chips) + 详情/恢复/Resume buttons.
- **`/learning-sessions/[id]`** (`learning-sessions/[id]/page.tsx`) — session detail + event stream. Reads `/api/learning-sessions/[id]`. SessionView (type/status/duration/counts/cost), stacked rating bar, AI 总结 (summary_md or SessionSummaryTask stub), SessionEventCard per event → `/events/[id]`.

### Area K — Admin (route group `(admin)`)
- **`/admin/runs`**, **`/admin/cost`**, **`/admin/failures`** (`app/(admin)/admin/*/page.tsx`, components in `src/ui/admin/`) — AI run/cost/failure observability. Lower redraw priority but part of the surface; uses the same chrome primitives.

### Drawers (cross-cutting overlays)
- **TeachingDrawer** — AI 1-on-1 teaching for a learning item (`/learning-items/[id]`). Props: learningItemId, learningItemTitle, subjectProfile. Idle-state machine spec: `docs/design/2026-05-24-teaching-idle-state-machine.md`.
- **CopilotDrawer** (`src/ui/primitives/CopilotDrawer.tsx`) — generic right-side AI conversation drawer: scroll container, SSE streaming, expandable ToolUseCard for tool invocations.
- **TodayCopilotDrawer** (`src/ui/today/`) — Today-specific copilot (7d coach summary, pending-item coaching).

---

## 3. Current design system

### 3.1 Tokens (`app/globals.css`)
Tailwind v4 CSS-first. Tokens are declared **twice on purpose**: `@theme { --color-* / --text-* / --spacing-* / … }` (drives Tailwind utilities) AND a mirror in `:root { … }` for raw `var()` usage. There's an in-file comment "Keep these in sync with @theme above" — intentional, but high-friction dual maintenance (see §4).

- **Color — paper (surfaces, warm whites)**: `--color-paper #faf9f5`, `--color-paper-sunk #f5f1e8`, `--color-paper-raised #ffffff`, `--color-paper-tint #f2ede0`.
- **Color — ink (text, warm slate)**: `--color-ink #1f1e1d`, `--color-ink-2 #3d3b36`, `--color-ink-3 #5c5b57`, `--color-ink-4 #8a8880`, `--color-ink-5 #b6b3a8`.
- **Color — lines**: `--color-line #e8e4d8`, `--color-line-strong #d5d0bf`, `--color-line-soft #f0ebdd`.
- **Color — coral (single primary accent)**: `--color-coral #d97757` + `-hover #c2553a`, `-press #a93f26`, `-soft #faede5`, `-line #edc3ae`, `-ink #6e2c18`.
- **Color — FSRS semantic 3-tier** (each with `-soft` / `-line` / `-ink`): `again` 不会/red `#b5341b`, `hard` 模糊/orange `#a87519`, `good` 会了/green `#4a7c59`.
- **Color — extra semantic**: `info` (AI actor) blue `#4f6e8e`; `contrasts` violet `#8a5a9e` (knowledge mesh `contrasts_with`; desaturated registers fall back to info/hard per knowledge graph §2.3.b).
- **Dark mode**: full inverted palette under both `@media (prefers-color-scheme: dark)` and `[data-theme="dark"]`. Explicit attribute wins over system. `--shadow-focus` has a dark-adjusted coral variant.
- **Fonts**: `--font-serif` (Source Serif 4 + Noto Serif SC — display/headings), `--font-sans` (Noto Sans SC + PingFang SC — UI), `--font-mono` (JetBrains Mono + Source Han Mono — code/meta), `--font-wenyan` (serif stack for classical Chinese passages).
- **Type scale**: `--text-meta 13` / `-caption 14` / `-body 15` / `-body-lg 17` / `-h6 15` / `-h5 17` / `-h4 19` / `-h3 22` / `-h2 28` / `-h1 36` / `-display 48` (px). Line heights `--lh-tight 1.35` / `-snug 1.5` / `-prose 1.7` / `-loose 1.85`. Letter spacing `--ls-tight -0.015em` / `-normal 0` / `-wide 0.04em`.
- **Spacing (4pt grid)**: `--spacing-s1..s24` = 4/8/12/16/20/24/32/40/48/64/80/96px, mirrored as `--s-1..--s-24`.
- **Radii**: `--radius-r1..r4` = 4/6/8/12px + `--radius-pill 999px`, mirrored as `--r-1..--r-4`.
- **Shadows**: `--shadow-1/2/3` (warm-tinted, soft), `--shadow-focus` (coral ring `0 0 0 3px rgba(217,119,87,0.22)`), `--shadow-inset`.
- **Motion**: `--ease-out (.22,1,.36,1)` / `-in` / `-soft`; `--duration-fast 120ms` / `-base 200ms` / `-slow 320ms` (mirror `--dur-fast/base/slow`).
- **Layout caps**: `--width-prose 680` / `-app 960` / `-wide 1200`px.

### 3.2 Primitives (`src/ui/primitives/`, 17 components)
- **Badge** — semantic pills; tones neutral/info/good/hard/again/coral; optional dot (static/pulsing).
- **Button** — 9 variants (primary/secondary/ghost/quiet/good/hard/coral/info/danger), sizes sm/md, left/right icon; all colors via `var(--*)`; `active:scale-[0.98]`, focus-visible ring via `--shadow-focus`.
- **Card** — surface container; pad default (16/18px) or lg (22/24px); optional elevated hover shadow.
- **Icon** — lucide-react wrapper, ~30 named icons ("loom naming"), configurable size, `strokeWidth 1.75`.
- **PageHeader** — eyebrow (mono) + title + sub + action slot; delegates to `.page-head` CSS.
- **TabBar** — segmented mobile control → `.seg-row`/`.seg` CSS.
- **TopNav** — sticky header (brand "Loom" + BrandMark + nav + version + trailing). **Heavy inline styles with hardcoded values** (see §4).
- **Brand / BrandMark** — coral logo mark.
- **ThemeToggle** — 3-state cycle (light → dark → auto), `data-theme` on `<html>`, persists to localStorage.
- **StatusBadge** — maps the full status enum (pending/in_progress/done/resting/dismissed/archived/extracted/partial/failed/queued/extracting/again/hard/good) to Badge tone.
- **CauseBadge** — AI vs user attribution + `pendingSinceSec` (info=AI, good=user). Inline `gap: 4` (see §4).
- **MasteryBadge** — mastery % + evidence_count + decay; compact/full; delegates to `.mastery-*` CSS.
- **CopilotDrawer** — right-side AI drawer (SSE + expandable tool-use).
- **ToolUseCard** — three-segment AI tool-call card (head: tool+summary+cost / body: expandable / cost row); modes via tweaks (chainRowCost, detailMode). Matches v2.1 §1.6.
- **SuggestionKindTag** — compact proposal-kind tag.

### 3.3 Derived components
`src/ui/components/` (TeachingDrawer, ReviewIntentBanner, AttemptTimeline, ArtifactSections, NoteRenderer, EmbeddedCheckSection, JudgeResultPanel, ReviewAnswerPreview, ReviewSubjectSwitchMarker, ReviewSessionChrome, VisionTab, TokenGate), `src/ui/block-tree/` (ArtifactBlockTree, tiptap-extensions, SlashCommandSuggestion, CrossLinkSuggestion, pm.ts), `src/ui/correction/` (CorrectionStateRenderer), `src/ui/today/` (TodayCopilotDrawer), `src/ui/review/`, `src/ui/admin/`. KnowledgeGraph = Cytoscape + cytoscape-fcose.

### 3.4 Design docs (`docs/design/`)
- `2026-05-15-design-brief-v2.1.md` — **active brief**; iteration over v2 (6 refines + knowledge mesh ADR-0010 + ToolUseCard).
- `2026-05-15-design-brief.md` — original context brief (4 AI archetypes A/B/C/D, targeting C+D; event-driven actor_kind × action × subject_kind).
- `loom-design-v2.1/` — **static HTML/CSS/JS claude-design handoff bundle + tokens.css + transcripts** (the visual source of truth; `HANDOFF.md` explains the bundle). `loom-design-v2/` and `loom-design/` are prior iterations.
- Surface-specific specs: `2026-05-24-teaching-idle-state-machine.md`, `2026-05-25-abandoned-review-session-resume.md`, `2026-05-25-review-intent-banner.md`, `2026-05-25-yuk-54-note-section-edit-in-place.md`, `2026-05-26-atomic-note-read-view.md`, `2026-05-15-data-assumptions.md`, `2026-05-21-test-partition-audit.md`, `2026-05-23-mempalace-evaluation.md`.

### 3.5 Visual conventions
- Warm paper + single coral accent + FSRS 3-tier semantic color. Info-blue = AI actor tone.
- **No emoji, ever.** Allowed glyphs only: `· → ↳ — × +`.
- Voice: technical specificity, dry occasional humor, Chinese-first UI labels. "Show the mechanism" (cost/evidence visible but visually de-emphasized).
- Layout: CSS Grid + Flexbox on a 4pt grid (no rigid column system). Soft cubic-bezier easings, 120–320ms, never jarring.

---

## 4. Token audit (document + recommend only — do NOT change tokens in this doc)

Overall the token system is solid (audit verdict ~85/100): all component colors go through `var(--*)`, dark mode is complete, the focus ring is tokenized. The leaks below are what a clean redraw foundation should resolve.

### Hardcoded values bypassing tokens
- **`TopNav.tsx`** (worst offender, all inline styles):
  - `padding: '10px 24px'` (10px is off the 4pt grid; 24px = s-6 but not via token)
  - `paddingRight: 14` (off-grid; nearest s-3=12 / s-4=16)
  - `gap: 2` (unitless 2px; should be a token or explicit px)
  - `fontSize: 18` (brand) and `fontSize: '13.5px'` (nav) and `'11.5px'` (version) — none in the type scale (scale offers 13/14/15/17px)
  - `padding: '6px 10px'` (both off-grid)
- **`CauseBadge.tsx`** — inline `gap: 4` (Badge elsewhere uses `gap-[4px]`/`px-[8px]`; should be a Tailwind class, not inline style).
- **`Icon.tsx`** — `strokeWidth={1.75}` is a magic number (fine today, but a hidden dependency if stroke weight ever becomes a design variable).

### Structural gaps / inconsistencies
- **Icon sizing has no scale token** — Icon default 18px, Button icon 13–14px, Badge dot 6px, all ad-hoc via a `size?: number` prop. Recommend an `--s-icon-{sm,md,lg}` scale.
- **Dual token storage** (`@theme` + `:root` mirror) requires manual sync — currently in sync, prone to drift. Recommend the redraw pick one storage strategy (or generate the mirror) so there's a single source of truth.
- **No `Skeleton` / `EmptyState` / `loading` primitives** — loading/empty/placeholder states are hand-rolled per page (e.g. MasteryBadge "untrained"/"low evidence" inline logic; CauseBadge pulsing "归因中…"). The redraw should extract reusable primitives.
- **Tailwind native scale vs custom tokens** — arbitrary values like `px-[10px]` / `rounded-[var(--r-2)]` bypass Tailwind's utility optimization; the TopNav inline-style friction suggests the token-to-utility ergonomics need tightening so raw styles aren't the path of least resistance.

### Recommended clean-foundation starting point for the redraw
1. Single source of truth for tokens (resolve the `@theme`/`:root` duplication).
2. Add an icon-size scale token; retire the ad-hoc `size` numbers.
3. Add `Skeleton` + `EmptyState` (and loading/disabled state) primitives.
4. Re-derive TopNav (and any other inline-style component) entirely from tokens — no hardcoded px/font-size.
5. Keep the existing color/type/spacing/radii/shadow/motion token *semantics* — they're good; the redraw should restyle *application*, not redefine the palette unless intentionally rebranding.

---

## 5. Redraw constraints

### MUST be preserved (hard contract — breaking these is out of scope for a redraw)
- **Route paths** — every path in §2 is immutable: `(app)` `/today /record /review /mistakes /learning-items /learning-items/[id] /learning-sessions /learning-sessions/[id] /knowledge /knowledge/[id] /events/[id] /inbox /coach /study-log`; `(admin)` `/admin/runs /admin/cost /admin/failures`; root `/`→`/today`, `/health`. Plus all `app/api/**` endpoints listed per route.
- **Data contracts** (read-only; see `src/db/schema.ts` + ADRs): event-driven core (`event` table, `actor_kind × action × subject_kind`, `caused_by_event_id` chaining, Zod discriminated-union payloads) ADR-0006 v2; `learning_item` (decoupled from event stream); `material_fsrs_state`; StructuredQuestion schema; SubjectProfile ADR-0014 (validates at startup); Artifact + `body_blocks[]` ADR-0020; KnowledgeEdge mesh ADR-0010 (5 relation types). The redraw consumes these; it does not reshape them.
- **Functionality** — every interaction in §2: review keyboard shortcuts + session lifecycle (eager create / sendBeacon close / `?session=` resume / pause / reopen), proposal accept/reverse/change-type/dismiss/retract, intent decomposition + accept, block-tree slash/drag/cross-link, undo of AI changes, theme toggle persistence, evidence backlinks.
- **Accessibility** — ~50 ARIA/role markers already in `src/ui`. Preserve keyboard navigation for all interactive components, focus management for drawers/modals/tab systems, and color-semantic contrast + non-color cues for the good/hard/again/info/contrasts badges.

### FREE to redesign (the point of the redraw)
- Visual layout of each page — spacing, grouping, card arrangement, section order.
- Component internals — how primitives render (hover states, icon placement, drawer/modal shape, backdrop, animation easing/timing) as long as behavior holds.
- Typography hierarchy — heading sizes, line-heights, letter-spacing (preserve semantic roles, e.g. an h2 stays a section title).
- Color *application* — which token paints what, as long as semantic meaning holds (error → again, success → good, AI → info, contrast → contrasts).
- Token foundation refactor per §4 (so long as semantics survive).

### Process gate (CLAUDE.md §UI Design Compliance — this WILL gate the actual redraw)
Before writing any UI code, each redraw slice must do a **design-doc pre-flight, approved by the user before any code**:
1. Verbatim-quote the relevant design-doc paragraph(s) with file path + section anchor/line — don't infer from context; if not found, stop and ask.
2. Declare the component type (drawer / route / modal / page / other).
3. List files to touch (create vs modify).
Exceptions: pure docs / backend / schema / tests / already-approved plan steps. After approval, land against the existing design-system tokens + primitives. This brief is a *map*, not a substitute for per-slice pre-flight.

---

## 6. UI debt to fold into the redraw

The redraw should *absorb* these rather than re-defer them. Anything touching UI here re-triggers the §5 pre-flight gate.

### Named in this task
- **YUK-162** (Backlind, Medium) — *P2-polish block editing: slash nested semanticBlock + drag-handle mis-shown.* From v1 PR #193 Codex/CodeRabbit review of YUK-150. Two defects: (1) **[structural bug]** `SlashCommandSuggestion.tsx:162` — choosing a semantic block via `/` while inside an existing `semanticBlock` inserts the new `semanticBlock` *inside* the current block (schema allows `content: 'block+'`), but backend `bodyBlocksToNoteSections`/coverage only walk top-level `doc.content`, so the section silently fails to project (embedded-check/verification miss it). Fix: hoist insert to doc top level or forbid nesting. (2) **[visual]** `tiptap-extensions.tsx:44` `BlockNodeView` renders a drag handle unconditionally, but `AutoLinksContainer` reuses it without `draggable` → "handle that won't drag." Fix: render handle only when `node.type.spec.draggable`. The issue explicitly notes the redraw will revisit UI and #2 may fold into it, **but #1 is a correctness bug that should be fixed regardless**.
- **YUK-164** (Backlog, Medium) — *T-OC slice 3b: auto-enroll wiring + OC-5 review-panel UI + flag enable.* T-OC slice 3 shipped the TaggingTask + WorkflowJudge + auto-enroll mechanism flag-gated-OFF; `runAutoEnrollForSession` is dormant (zero production callers). Slice 3b items with UI surface (gate the redraw's pre-flight): **#2 OC-5 review panel** ("AI auto-enrolled N items" review/correction surface, reads `event WHERE payload->>'generated_by'='workflow_judge'`) — explicitly **needs design-doc pre-flight + user approval**; **#3 review-UI display** of TaggingTask suggestions / prefilled fields for `review`-routed blocks (may need new `question_block.ai_suggested_knowledge_ids` / `ai_judge_*` columns). Non-UI items (#1 lifecycle wiring, #4 flag, #5 answer grading, #6 routing) are backend and out of redraw scope but the flag only flips ON once #2 exists. See ADR-0026 + `docs/superpowers/plans/2026-05-30-yuk145-toc-slice3-lane.md`.

### Other deferred UI items (from `docs/planning/v0.5-maintenance-roadmap.md` §3 "UI redraw-pending")
- **P6 atomic-note read-view** — 5→3 `semantic_kind` idiom CSS + low-contrast control steady-state; has TODO comments pointing at `docs/design/2026-05-26-atomic-note-read-view.md` §3/§5.
- **YUK-153** — knowledge graph proposal accept/dismiss re-scatter: replace full-graph rebuild with incremental `cy.add/remove` so accepting an edge doesn't reflow the whole layout.
- **YUK-157** — CrossLinkSuggestion silently swallows real fetch errors (needs an error/empty surface).
- **YUK-149** — Wave 6 Living Note mediums: FORCE_APPLY not refreshed on heartbeat / accept signal outside transaction / undo·ai-changes route untested (UI + behavioral).

### Deferred-feature UI debt (from `docs/superpowers/plans/2026-05-29-wave8-ready-to-launch.md` W8-2)
- **Generic @mention picker** (child of **YUK-88**) — deferred: trigger collides with the `@`-cross_link picker; "redraw 再定 UX" (the redraw is expected to decide its UX). Cross-link picker itself shipped Wave 7; slash + drag-drop shipped Wave 8 (YUK-150).

### In-code TODO markers found
- `src/ui/knowledge/page.tsx` — "full picker is a later UX polish; cycling lets current one…" — full node-picker polish pending (current behavior is cycling navigation).
- `src/ui/block-tree/*` — multiple `YUK-150 P2-polish` markers (SlashCommandSuggestion, slash-command-items, tiptap-extensions, pm.ts) documenting the shipped slash/drag-drop slice; the YUK-162 fixes land against these.
- Schema-level deferred work is tracked separately in `scripts/audit-schema-allowlist.json` (clean per `pnpm audit:schema`) — not UI, but referenced so the redraw doesn't conflate the two lint surfaces.

---

## 7. Suggested redraw sequencing (advisory only)

Order chosen to (a) settle the foundation first, (b) redraw highest-traffic + most-visited surfaces early for fast feedback, (c) batch surfaces that share components. Each slice gates on the §5 pre-flight.

1. **Foundation slice** — resolve §4 token issues (single source of truth, icon-size scale, Skeleton/EmptyState primitives), re-derive shell chrome (TopNav/TabBar/PageHeader/ThemeToggle) off clean tokens. Everything downstream depends on this; do it before any page.
2. **Today + shell** (`/today`, both `(app)`/`(admin)` layouts) — the entry point and KPI hub; exercises strips, lanes, CostRibbon, and the copilot drawer pattern.
3. **Review loop** (`/review` + ReviewSessionChrome/AttemptTimeline/JudgeResultPanel/ReviewIntentBanner/ReviewAnswerPreview/ReviewSubjectSwitchMarker) — the highest-frequency daily surface; self-contained component family.
4. **Record + ingestion** (`/record`, VisionTab, ManualForm) — fold in the T-OC **YUK-164** OC-5 review-panel + prefilled-field display here, since ingestion/review-of-AI-imports belongs adjacent to record entry (pre-flight required).
5. **Knowledge** (`/knowledge`, `/knowledge/[id]`) — tree/mesh/Cytoscape is the heaviest visual work; fold in **YUK-153** incremental re-scatter while reworking the graph.
6. **Learning items + note authoring** (`/learning-items`, `/learning-items/[id]`, block-tree, ArtifactView, TeachingDrawer) — fold in **YUK-162** (#1 structural fix regardless of redraw; #2 handle visibility), the **YUK-88** generic-@mention UX decision, **YUK-157** CrossLink error surface, and the **P6 read-view** CSS.
7. **Triage + tracking** (`/inbox`, `/mistakes`, `/events/[id]`) — shared proposal/event-chain components (EdgeProposalCard, EventChain, CorrectionStateRenderer); redraw together for consistency.
8. **Analytics + sessions** (`/coach`, `/learning-sessions`, `/learning-sessions/[id]`) — chart/stat surfaces; lower interaction complexity, good as a late confidence-builder.
9. **Admin** (`/admin/*`) — lowest priority; redraw last or only as the shared primitives naturally cover it.
10. **Living Note mediums (YUK-149)** — fold in wherever the AI-changes/undo surfaces land (Today strip + note authoring); behavioral, so pair with backend fixes.

---

*End of brief. This is a map for the redraw, not a spec — each slice still runs the CLAUDE.md design-doc pre-flight against the cited design docs before any code.*
