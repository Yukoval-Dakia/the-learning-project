# Loom — App UI kit

A click-thru recreation of Loom's 9 admin pages, distilled to ~5 core screens. No real backend; all state is in-memory React state seeded with a few mistakes / learning-items / knowledge nodes so flows feel alive.

## Files

- `index.html` — the runnable kit. Open it directly.
- `styles.css` — surface styles. **No tokens here** — all colors / type / radii / shadows / motion come from `../../colors_and_type.css`. Component-scoped CSS only.
- `Primitives.jsx` — `<Brand>`, `<Icon>`, `<Button>`, `<Badge>`, `<StatusBadge>`, `<CauseBadge>`, `<Card>`, `<PageHeader>`, `<TopNav>`, `<TabBar>`.
- `Screens.jsx` — `<HomeScreen>`, `<RecordScreen>`, `<MistakesScreen>`, `<ReviewScreen>`, `<ItemsScreen>`, `<KnowledgeScreen>`, `<IngestScreen>`.

## What's modeled

| Route | Screen | Notes |
|---|---|---|
| `/` (home) | `HomeScreen` | Dashboard with due / pending-attribution / open-items counts. |
| `/record` | `RecordScreen` | Form: prompt + reference + wrong answer + knowledge-point chips + optional cause. Empty cause → AI fills in (Sub 3). |
| `/mistakes` | `MistakesScreen` | List with `CauseBadge` showing AI/user provenance + confidence. Pending shows pulsing dot. |
| `/review` | `ReviewScreen` | One question at a time. Reference hidden under `<details>`. 1 / 2 / 3 keys for **不会 / 模糊 / 会了**. Fake FSRS schedules next due. |
| `/learning-items` | `ItemsScreen` | Status filter, status transitions (pending → in_progress → done). Replaces the Phase 4a `LearningGoal` spec naming. |
| `/knowledge` | `KnowledgeScreen` | Read-only table; mentions effective-domain inheritance + AI proposals route. |
| `/ingest` | `IngestScreen` | Vision pipeline placeholder dropzone — copy only, no real upload. |

## What's intentionally cut

- Real fetches (no Hono / D1 / TanStack Query — components hold a fake `db`).
- `/knowledge/proposals` review queue (mentioned, not built).
- `/_/inspect` debug page.
- BackgroundTask retry UI for stuck attribution.
- Real FSRS scheduler (we mock the next-due bump on rating).

## Conventions used (from the design system)

- **Coral is the only accent** — every primary action, every active nav state, every focus ring.
- **Serif for display** (`Source Serif 4`) — `<h1>`, the dashboard big numbers. Sans for body, body for everything else.
- **STKaiti / FangSong stack** for any classical-Chinese passage (`.prose-cn`). Line-height 1.85, slight letter-spacing.
- **No emoji.** No celebration toasts. No gamification. Empty states are quiet ("今天没有要复习的，太好了").
- **FSRS rating buttons** are the only place we use semantic color clusters (red/amber/green tints). All other state is neutral grays + coral.
- **Mobile = bottom tab bar, desktop = top nav.** Same items, same labels, swap at 760px.

## How to extend

When a new screen is needed, put one screen-component in `Screens.jsx`, register the route in `index.html`'s `switch`, and add it to the nav arrays in `Primitives.jsx`. Don't reach for new colors — every new state should already have a token in `colors_and_type.css`.
