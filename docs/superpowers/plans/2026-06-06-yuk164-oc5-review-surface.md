# YUK-164 OC-5 — Auto-enroll review surface + VisionTab AI prefill (lane plan)

Branch: `yuk-164-oc5-review-surface` @ origin/main (`c425b3ad`).
Worktree: `/Users/yukoval/yukoval-projects/the-learning-project/.claude/worktrees/yuk164-oc5`.
Scope: YUK-164 #2 (OC-5 review surface UI) + #3 (VisionTab AI prefill). One PR. Commit trailer `Refs YUK-164` (NOT `Closes` — #4 flag flip is separate).
Design pre-flight: approved (redraw-brief.md:42-43, round2a §1.3 + §替换·auto_enrolled, loom-prototype/screen-record.jsx:178-219).

---

## 0. Key design discovery (read before slicing)

The redraw-brief (`docs/design/2026-05-30-claude-design-redraw-brief.md:42`) literally says the panel
"Reads `GET /api/ingestion/[id]/events` filtered to `action='experimental:auto_enroll_observed'`". **That `/events`
endpoint does not exist** and is not needed: the existing `GET /api/ingestion/[id]/blocks` route ALREADY joins the
`auto_enroll_observed` event per block and returns it as `auto_enroll_observation` (blocks/route.ts:67-99,
`toAutoEnrollObservation` :106-124). The observation object today carries everything a ROW needs:
`event_id / outcome / mode / route / confidence / threshold / reasoning / suggested_knowledge_ids / observed_at`
(verified against the actual function body :113-123 — it does NOT carry `ingestion_session_id`, and it does NOT yet
carry `mistake_draft`; that `mistake_draft` extension is slice 1's job, §4). Note the wire-shape doc comment at
blocks/route.ts:23-25 is stale (it omits `outcome`/`mode` and predates `mistake_draft`) — treat the function BODY, not
the comment, as authoritative; slice 1 updates that comment when it touches the function.

So the data flow is **two existing reads + one missing read**:
- **MISSING (this lane builds it)**: `GET /api/ingestion` — a session list, because the panel has no session id to
  start from. Without it the user can't pick which ingestion session to inspect. This is the pre-flight-approved new
  backend piece.
- **EXISTING**: `GET /api/ingestion/[id]/blocks` — per-session blocks, each already carrying `auto_enroll_observation`.
  The panel filters to rows where `auto_enroll_observation !== null`.
- **EXISTING**: `POST /api/ingestion/[id]/revert` `{block_id, reason_md?}` — block-scoped undo (only works on
  `status='auto_enrolled'`, i.e. flag-ON enrolled blocks; in observe-only production it returns 409 because blocks
  stay `draft` — this is correct and the UI must surface that path honestly).

Implication for the panel: in observe-only production (the current real state), rows exist (observations are written)
but their block `status` is `draft`, NOT `auto_enrolled`. So **revert is only actionable on `auto_enrolled` rows**; for
`draft`+observation rows the row is an observation/inspector entry with no revert (revert would 409). The loom
prototype models the populated list as if rows were enrolled; we render BOTH truthfully: route/confidence/knowledge
for every observation, and a revert control only when the block is actually `auto_enrolled`.

This matches round2a §替换 (line 86-87): "populated 列表 + revert 必须设计出来（数据形状与 revert 路径都是真的）" while
"空态/observe 态是当前最常见的真实态". We do not invent enrolled rows; we show observations and gate revert on real status.

---

## 1. Slice plan (4 atomic commits)

4 atomic commits. Rationale + dependency order (no inversion): **slice 1** lands ALL blocks-route read-shape work
(GET `/api/ingestion` list + `mistake_draft` surfacing on the existing blocks route) isolated and DB-tested first, so
the UI slices build against a frozen wire shape. **slice 2** creates the shared `src/ui/lib/auto-enroll.ts`
(type + `formatConfidence` + pure `seedBlockForm`) and the panel; it depends on slice 1's wire shape. **slice 3**
(VisionTab prefill) depends on slice 2's `auto-enroll.ts` (`seedBlockForm` + the shared type) — slice 3 imports from
the lib, NOT from slice 2's component file, so the two UI slices stay decoupled. **slice 4** (docs) last so the status
table reflects what shipped. The chain is 1→2→3→4; each commit is independently revertable (slice 1 inert without UI;
slices 2/3 touch disjoint components, share only the lib).

| # | Commit | Touches | Test partition |
|---|--------|---------|----------------|
| 1 | `feat(ingestion): GET /api/ingestion session list + surface mistake_draft on blocks (Refs YUK-164)` | add GET to `app/api/ingestion/route.ts` (file exists for POST — extend); extend `app/api/ingestion/route.test.ts` with GET cases; extend `app/api/ingestion/[id]/blocks/route.ts` `toAutoEnrollObservation` to surface `mistake_draft` + wire-shape comment (lines 23-25); extend `app/api/ingestion/[id]/blocks/route.test.ts` round-trip case | **DB** (`vitest.db.config.ts`) |
| 2 | `feat(record): auto_enrolled review tab + revert (Refs YUK-164)` | create `src/ui/lib/auto-enroll.ts` (shared type + `formatConfidence` + pure `seedBlockForm` helper); create `src/ui/components/AutoEnrolledPanel.tsx`; modify `app/(app)/record/page.tsx` (add 5th tab `auto_enrolled` to `ModeTab` union + `MODE_TABS`, gate `{mode==='auto_enrolled' && <AutoEnrolledPanel/>}`); create `src/ui/components/AutoEnrolledPanel.test.tsx` (static-HTML) + `src/ui/lib/auto-enroll.test.ts` (pure-fn) | **unit** (`vitest.unit.config.ts`) |
| 3 | `feat(record): VisionTab AI prefill from auto_enroll_observed payload (Refs YUK-164)` | modify `src/ui/components/VisionTab.tsx` (call pure `seedBlockForm` from the seed effect; widen `BlockRow.status` + add `auto_enroll_observation`; add "AI 预填" badge); extend `src/ui/lib/auto-enroll.test.ts` for `seedBlockForm`; create `src/ui/components/VisionTab.test.tsx` (static-HTML) | **unit** |
| 4 | `docs(oc5): record OC-5 review surface + prefill shipped (Refs YUK-164)` | modify `docs/superpowers/status.md` (or the OC-5 tracking doc) + any module doc | n/a (docs) |

Slices 1→2→3 are loosely chained: slice 2 depends on slice 1's wire shape; slice 3 is independent of slice 2 (touches
VisionTab, not the panel) but shares the observation type — define the shared `AutoEnrollObservation` TS interface once
in slice 2 (or a tiny `src/ui/lib/auto-enroll.ts` types module) and import it in slice 3. Decision: put the shared
type AND the prefill logic in **`src/ui/lib/auto-enroll.ts`** (new) so both the panel and VisionTab import from one
place and slice 3 doesn't import from slice 2's component file. This file holds:
- `AutoEnrollObservation` TS interface (the wire shape from blocks/route, including the pinned `mistake_draft` subset).
- `formatConfidence(n: number | null): string` — the mono `confidence X.XX` formatter.
- **`seedBlockForm(block): Partial<BlockFormState>`** — a PURE function that maps a block's `auto_enroll_observation`
  to seeded form values (`knowledge_ids` / `cause_primary` / `cause_notes` from `cause.analysis_md` / `difficulty`),
  falling back to today's defaults when no observation. Extracting this as a pure function is what makes the prefill
  logic UNIT-TESTABLE on the current node-only test stack (see test-stack reality below) — VisionTab's seed `useEffect`
  just calls it.

Create `src/ui/lib/auto-enroll.ts` in slice 2.

### Test-stack reality (drives all slice-2/3 test choices — read before writing any test)
**Verified**: `package.json` has NO `@testing-library/react`, `jsdom`, or `happy-dom`; BOTH `vitest.unit.config.ts` and
`vitest.db.config.ts` set `environment: 'node'`; every existing `*.test.tsx` (CopilotDrawer, ReviewAnswerPreview,
ArtifactSections, …) uses `react-dom/server` `renderToString` for STATIC HTML assertions only; ZERO test file uses
`QueryClientProvider`, mounts a component, or exercises a click/effect/state-transition. **Decision: do NOT add jsdom +
@testing-library (that is new test infra, out of scope for the minimal-functional mandate).** Instead:
- **Logic** (seeding, confidence formatting, banner-derivation, revert-gating predicate) lives in **pure functions** in
  `src/ui/lib/auto-enroll.ts` and is unit-tested DIRECTLY (no render).
- **Markup** (panel renders route text / mono confidence / "AI 预填" badge / EmptyState copy / revert button
  present-vs-absent by status) is asserted via **`renderToString` static-HTML checks**, matching the existing convention.
- **Interactions** that need a live DOM (click → two-step confirm → POST, retry → refetch, slider drag) are NOT
  asserted in the component test (renderToString can't fire them). The revert SERVICE path is already covered by
  `revert-auto-enroll.test.ts` (DB); the seed LOGIC is covered by the pure `seedBlockForm` unit test. The component test
  only asserts that the correct static affordance is present in the rendered HTML for a given input (e.g. a row with
  `status:'auto_enrolled'` renders a button with the "撤销" label; a `draft` row does not).

---

## 2. `GET /api/ingestion` design (slice 1)

### Why a session list at all
The AutoEnrolledPanel sits on `/record` with no session context (the vision flow's `sessionId` is local React state
that's gone once you leave the vision tab). To review what AI observed/enrolled across past ingestions, the user needs
to see recent ingestion sessions and pick one. Hence a list endpoint.

### Query params
```
GET /api/ingestion?limit=20&with_observations=1
```
- `limit` — int, default 20, clamp 1..100. Keyset/offset pagination is overkill for a single-user tool with low
  ingestion volume; use a simple `limit` + `created_at desc` ordering. Pagination strategy: **limit-only, newest
  first** (no cursor). If volume ever grows, add `before=<iso>` later; not now (anti-overengineering).
- `with_observations` — optional `'1'`. When set, the route computes per-session observation/auto_enrolled counts
  (one extra grouped query). Default behavior: **always include counts** — they're cheap (one grouped query over
  `event` + one over `question_block`) and the panel always needs them; drop the param and always return counts.
  Decision: **no query param beyond `limit`**. Keep it dead simple.

### Return shape
```jsonc
{
  "rows": [
    {
      "id": "sess_...",
      "entrypoint": "vision_paper",          // learning_session.entrypoint (nullable -> string|null)
      "status": "extracted",                  // learning_session.status
      "source_asset_ids": ["asset_..."],      // for a thumbnail / count
      "observation_count": 3,                 // # of auto_enroll_observed events for this session's blocks
      "auto_enrolled_count": 0,               // # of question_block rows status='auto_enrolled' in this session
      "block_count": 5,                       // total blocks (context: "3 of 5 observed")
      "created_at": 1730000000                // unix sec (match blocks route convention)
    }
  ]
}
```
Rationale for the two counts: `observation_count` drives the panel's "N observations" badge and is non-zero in
observe-only production; `auto_enrolled_count` is non-zero only once the flag is ON, and tells the panel how many rows
have an actionable revert. Sessions with `observation_count === 0` can still be listed (the panel can show "no AI
observations yet" per session) — but to keep the list focused, **filter to sessions that have at least one block**
(`block_count > 0`); do NOT filter on observation_count (a freshly-extracted session with 0 observations is still a
valid pick, and filtering it out would hide the observe-empty state we want to show).

### Drizzle query sketch
```ts
// 1) latest ingestion sessions
const sessions = await db
  .select({
    id: learning_session.id,
    entrypoint: learning_session.entrypoint,
    status: learning_session.status,
    source_asset_ids: learning_session.source_asset_ids,
    created_at: learning_session.created_at,
  })
  .from(learning_session)
  .where(eq(learning_session.type, 'ingestion'))
  .orderBy(desc(learning_session.created_at))
  .limit(limit);

const sessionIds = sessions.map((s) => s.id);
if (sessionIds.length === 0) return Response.json({ rows: [] });

// 2) blocks grouped by session: total count + auto_enrolled count
const blockAgg = await db
  .select({
    sid: question_block.ingestion_session_id,
    total: count(),
    enrolled: sql<number>`count(*) filter (where ${question_block.status} = 'auto_enrolled')`,
  })
  .from(question_block)
  .where(inArray(question_block.ingestion_session_id, sessionIds))
  .groupBy(question_block.ingestion_session_id);

// 3) observation events grouped by session.
//    NOTE: event.subject_id = question_block.id (per block), NOT the session id.
//    The auto_enroll_observed payload carries ingestion_session_id, but joining on
//    payload JSON is ugly. Cleaner: join observed events -> their block -> session.
const obsAgg = await db
  .select({
    sid: question_block.ingestion_session_id,
    obs: count(),
  })
  .from(event)
  .innerJoin(question_block, eq(event.subject_id, question_block.id))
  .where(
    and(
      eq(event.action, 'experimental:auto_enroll_observed'),
      eq(event.subject_kind, 'question_block'),
      inArray(question_block.ingestion_session_id, sessionIds),
    ),
  )
  .groupBy(question_block.ingestion_session_id);
```
Then zip the three result sets in JS by session id (Maps keyed by sid), defaulting missing counts to 0, and map
`created_at` to unix sec via `Math.floor(d.getTime()/1000)` (mirror blocks/route.ts:96).

**Audit-query correctness note** (from Map facts): the canonical observation query is
`event WHERE action='experimental:auto_enroll_observed'` — NOT `generated_by` alone, because once the flag is ON the
enroll events ALSO carry `generated_by='workflow_judge'`. The query above uses `action=...observed` exactly. Good.

`event.subject_id` for observe events is the **block id** (auto-enroll.ts:295 `subject_id: block.id`), so the
`event → question_block` join on `event.subject_id = question_block.id` is correct.

### Partition
**DB test** — the route imports `@/db/client` and queries real tables. **Verified**: the existing
`app/api/ingestion/route.test.ts` is ALREADY a DB test (it imports `../../../tests/helpers/db` and uses
`resetDb`/`testDb` to exercise the real POST against a testcontainer Postgres). So **extend that same file** with GET
`describe` blocks — no new file, no partition split, no risk of mixing unit+DB in one file. Runs under
`vitest.db.config.ts` via `pnpm test:db`. (The earlier "new route.get.test.ts" hedge is resolved: extend the existing
DB file.)

### audit:schema
No new schema columns. All reads. `pnpm audit:schema` unaffected. `pnpm audit:profile` unaffected.

---

## 3. AutoEnrolledPanel component design (slice 2)

### Component type
A self-contained **panel component** (`AutoEnrolledPanel.tsx`), mounted as the body of a **new 5th tab** on the
`/record` route — NOT a drawer/modal/route, and NOT an always-mounted sibling.

Placement decision (**corrected** — supersedes the earlier "always-mounted sibling" reading): add `auto_enrolled` to
the `ModeTab` union (record/page.tsx:16) and to `MODE_TABS` (record/page.tsx:92-96), then gate the panel exactly like
every other tab body: `{mode === 'auto_enrolled' && <AutoEnrolledPanel/>}` inside `record-tab-body`
(record/page.tsx:116-120). **Verified**: `vision_paper` is rendered as `{mode === 'vision_paper' && <VisionTab/>}`
(record/page.tsx:119) — i.e. TAB-GATED, not unconditional. So the brief's own phrase "mirroring how `vision_paper`
renders `VisionTab`" (redraw-brief:42) argues FOR a tab-gated render, and the brief's other phrase "a new MODE_TAB
(`auto_enrolled`)" argues for it too. **Both signals point to a 5th tab; resolve there.** This is the honest reading and
it also avoids firing the `/api/ingestion` session-list query on every `/record` visit (an always-mounted panel would
eager-fetch on the default `context` tab). The earlier claim that an always-mounted panel "mirrors vision_paper" was
wrong and is retracted. Keep `AutoEnrolledPanel` self-contained so the wrapper choice is a one-line swap if the owner
ever wants a sibling instead (rollback is trivial — see Risks §6).

### Props
```ts
interface AutoEnrolledPanelProps {
  // none required for v1 — panel self-fetches the session list + selected session blocks.
  // (Keep it self-contained like RecordContextPanel, which owns its own queries.)
}
```
Self-contained: the panel owns its TanStack Query calls, mirroring `RecordContextPanel` / `ManualForm` in the same
file (they each own their queries). No props threading from `RecordPage`.

### Data flow
1. `sessionsQ = useQuery(['ingestion-sessions'], () => apiJson('/api/ingestion?limit=20'))`.
2. Local state `selectedSessionId` — default to the first session in the list once loaded (most recent). A compact
   session picker (chips or a select) lets the user switch.
3. `blocksQ = useQuery(['ingestion-blocks', selectedSessionId], () => apiJson(`/api/ingestion/${selectedSessionId}/blocks`), { enabled: !!selectedSessionId })`.
   **Reuse the exact query key `['ingestion-blocks', sessionId]` that VisionTab uses** (VisionTab.tsx:151) so a revert
   here and an import there share cache invalidation semantics.
4. `observedRows = blocksQ.data.rows.filter((r) => r.auto_enroll_observation !== null)`.
5. Render one row per `observedRows` entry.

**Presentational split (required for testability, §1 + §5):** keep the data-fetching `AutoEnrolledPanel` thin and put
the markup in a pure presentational `PanelBody` (or row-renderer) that takes ALREADY-RESOLVED props
(`{ status, observedRows, showBanner }`) and contains no `useQuery`/`useMutation`. The container resolves queries →
computes `showBanner` from `blocksQ.data` (the P2-3 contract) → passes resolved props down. Only `PanelBody` is
`renderToString`'d in the slice-2 component test; the container's live wiring is not unit-tested (it can't be on the
node-only stack, and the service path is covered by the DB test).

### States (all five, per round2a §1.3 + §替换)
Use the `Stateful` primitive (`src/ui/primitives/Stateful.tsx`) — `status: 'loading'|'empty'|'error'|'ok'`:
- **loading** — `sessionsQ.isLoading || blocksQ.isLoading` → `skeleton={<SkLines rows={3} />}`.
- **error** — `sessionsQ.isError || blocksQ.isError` → `errorText="无法读取自动录入项。"` + `onRetry` refetch. Honor
  `ApiAuthError` (reuse `formatError` from VisionTab pattern; surface "请重新进入页面输入 token" like record page does).
- **observe / empty** — `observedRows.length === 0` → `empty={<EmptyState icon="eye" title="AI 正在观察，尚未自动录入"
  text="开启 auto-enroll 后，AI 拟录入的错题 / 记录会列在这里，每项可一键撤销。" />}` (verbatim from loom:197-198). This is the
  **most common real state in observe-only production** — it must be meaningful, not a bare "no data".
- **populated (ok)** — render the strip list of observation rows.
- (No separate "no sessions" sub-state needed — if `sessionsQ` returns `rows: []`, treat as observe/empty with the
  same EmptyState; a single-user tool with zero ingestions is the same "nothing to review yet" message.)

Also render the **observe-only banner** above the list (loom:189-192) so the user understands why blocks aren't
enrolled: a `Badge tone="info"` reading `observe-only` + meta text
`WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED = OFF · 当前仅观察、块留 draft`. The flag value is not exposed to the browser, so
derive the banner from data.

**Hard contract (P2-3) — banner derives from `blocksQ.data`, the SAME source as the per-row revert gate, NOT from the
session-list count.** Concretely: show the banner when **none of the loaded blocks for the selected session have block
`status === 'auto_enrolled'`** (i.e. `blocksQ.data.rows.every((r) => r.status !== 'auto_enrolled')`). Rationale: the
session-list's `auto_enrolled_count` and the loaded blocks can momentarily disagree right after a revert (the list is
cached under the `['ingestion-sessions']` query key and refetches independently of `['ingestion-blocks', sid]`).
Deriving banner + per-row revert from the one `blocksQ.data` source keeps them consistent within a single refetch. The
session-list `auto_enrolled_count` MAY still drive the session-picker badge (a coarse hint), but MUST NOT drive the
banner or any per-row affordance. When some loaded blocks ARE `auto_enrolled` (flag ON), drop the banner.

### Row anatomy (round2a:84-86 — `route · confidence(等宽) · 建议知识点` + revert; §1.3 non-color cues)
Each row shows, left→right:
- **route badge** — `auto_enroll_observation.route` is `'auto' | 'review'`. Non-color cue: the literal text `auto` /
  `review` IS the label (round2a §1.3: status needs a text/shape cue, not just color). Tone: `auto` → `tone="good"`,
  `review` → `tone="info"`. Because the AI is the actor, the **info-blue (`--info-blue` / `#4f6e8e`) AI-actor color**
  applies to the AI-attribution element — use a small `bolt`/`sparkle` Icon + info tone on the panel header
  (loom:187 `lane-ic tone-coral` with a bolt; round2a §1.3 says AI actor = info-blue, so prefer `tone="info"` for the
  AI-attribution marker over coral). Decision: **header AI marker = info-blue bolt icon** ("AI 自动录入 · 复审");
  per-row route badge keeps good/info semantic tones with text labels.
- **confidence** — `confidence` rendered with `var(--font-mono)` (等宽), formatted `confidence {n.toFixed(2)}`
  (loom:205). Add a non-color cue: prefix with a tiny gauge glyph or just the mono number + label (mono font IS the
  required 等宽 treatment). Use the shared `formatConfidence` helper from `src/ui/lib/auto-enroll.ts`.
- **suggested knowledge** — `suggested_knowledge_ids` mapped to names via the `['knowledge']` query (reuse the same
  query the rest of `/record` uses). Render as small `chip-k` pills (mono, `--paper-sunk` bg, like `knowledgePillStyle`
  in record/page.tsx:768). If an id has no name, show the id (graceful).
- **reasoning** (optional, collapsible) — `auto_enroll_observation.reasoning` as a `<details>`/muted line so the user
  can see WHY the AI routed it. Keeps evidence-first posture (project memory: AI decisions traceable).
- **status pill** — the block's own `status` (`draft` vs `auto_enrolled`) with a text label, so observe-mode rows
  visibly read `draft` (no revert) and enrolled rows read `auto_enrolled` (revert active). Non-color cue = the word.
- **revert control** — `Btn size="sm" variant="ghost" icon="undo"` "撤销", rendered **only when block
  `status === 'auto_enrolled'`**. For `draft` observation rows, render a disabled/absent control with a tiny meta
  hint ("仅观察 · 无可撤销项") so the user isn't confused by a dead button.

### Revert interaction
`revertMutation = useMutation({ mutationFn: ({blockId}) => apiJson(`/api/ingestion/${selectedSessionId}/revert`, { method:'POST', body: JSON.stringify({ block_id: blockId }) }) })`.
- **Confirm step**: a lightweight inline confirm (button → "确认撤销?" two-step, or `window.confirm` for v1-minimal —
  the brief says "Minimal-functional only — the visual is this redraw's job", so a two-click inline confirm is enough;
  do NOT build a modal). Decision: **inline two-state button** (click "撤销" → swaps to "确认?" / "取消"), no modal,
  matches the minimal-functional mandate and the loom's optimistic `setReverted` pattern (loom:208-210).
- **On success**: invalidate `['ingestion-blocks', selectedSessionId]` (refetch — the block flips to `draft`, its
  observation row stays but loses the revert affordance) AND `['ingestion-sessions']` (counts change). Prefer
  **refetch over optimistic** for correctness (revert touches multiple tables); show a transient "已撤销" badge
  (loom:209) while refetching. `reason_md` omitted for v1 (optional in the API).
- **On error** (e.g. 409 if already reverted / observe-only draft): surface inline error text under the row via
  `formatError` (the 409 message from the service is human-readable: "...only 'auto_enrolled' can be reverted").

### Primitives used
`Card`, `Badge` (tones neutral/info/good), `Button`/`Btn`, `Icon` (bolt/undo/eye), `Stateful`, `EmptyState`,
`ErrorState` (via Stateful), `SkLines`, `SectionLabel`. All exist in `src/ui/primitives/`. Reuse — do not hand-roll
loading/empty/error markup.

### Tokens / non-color rules
- AI-actor attribution: `--info-blue` (#4f6e8e) on the panel header marker (round2a §1.3 "AI actor 用 info-blue").
- Confidence: `--font-mono` (等宽) per round2a:84.
- Knowledge pills: `--paper-sunk` / `--line-soft` / `--ink-3` (reuse `knowledgePillStyle`).
- Status/route distinguished by **text label + icon**, never color alone (round2a §1.3): route badge text `auto`/
  `review`, status pill text `draft`/`auto_enrolled`, revert icon `undo`.
- Spacing: 4pt grid `var(--s-*)`; radius `var(--r-2)` cards / `var(--r-pill)` chips; coral reserved for primary
  affordances elsewhere — the panel header AI marker uses info, not coral, to read as "AI" not "danger".

---

## 4. VisionTab prefill design (slice 3)

### Where to inject
In the **`reviewing` phase**, the per-block `BlockEditor`. The existing seed effect (VisionTab.tsx:161-190) initializes
`blockForms[b.id]` from the block's own fields (`extracted_prompt_md`, etc.) with hardcoded defaults
(`knowledge_ids: []`, `cause_primary: ''`, `question_kind: 'short_answer'`, `difficulty: 3`). **Prefill replaces those
defaults with the AI's suggestions when an `auto_enroll_observation` exists on the block.**

### What to prefill (from `auto_enroll_observation`, NOT new columns — ADR-0026 §4)
The blocks route returns `auto_enroll_observation` per row. For prefill we need TWO things from it:
1. `suggested_knowledge_ids: string[]` — **already returned** by `toAutoEnrollObservation` (blocks/route.ts:121).
   → seed `knowledge_ids`.
2. `mistake_draft: { wrong_answer, difficulty, cause }` — the `MistakeEnrollOutputT`
   (`src/core/schema/mistake_enroll.ts`: `wrong_answer: 'failure'|'partial'|'success'|'unanswered'`, `difficulty: 1..5`,
   `cause: CauseSchema|null`). **CauseSchema shape (verified cause.ts:13-18) is
   `{ primary_category, secondary_categories, analysis_md, confidence }` — there is NO `user_notes` field on the
   source cause.** (`user_notes` only exists on the VisionTab *import payload* the form builds at VisionTab.tsx:282 —
   it is NOT a field you can read back off `mistake_draft.cause`.) **GAP**: the current
   `toAutoEnrollObservation` (blocks/route.ts:106-124) does NOT extract `mistake_draft` from the event payload, even
   though auto-enroll.ts:303 writes it (`...(mistakeDraft ? { mistake_draft: mistakeDraft } : {})`). **Slice 1 extends
   `toAutoEnrollObservation` to also surface `mistake_draft`** (read `payload.mistake_draft`, validate shape
   defensively via a tolerant projection — see §6 P3-2 below — expose a pinned, single-named subset). **Pinned wire
   field names (no either/or):** surface `mistake_draft` as
   `{ wrong_answer: 'failure'|'partial'|'success'|'unanswered'|null, difficulty: number|null, cause: { primary_category, analysis_md } | null }`.
   Keep the source field name `wrong_answer` verbatim (auto-enroll.ts:303 writes the raw `MistakeEnrollOutputT`, whose
   field is `wrong_answer`) — do NOT rename it to `outcome`. This is a backend read-shape change inside the existing
   blocks route — no schema change, no new column. Add a DB test case to `blocks/route.test.ts` asserting `mistake_draft`
   round-trips under the EXACT pinned key names. **Decision: fold the `mistake_draft` surfacing into slice 1** alongside
   the GET route, so all blocks-route read-shape work lands once and slice 3 is pure UI. The slice table (§1) already
   reflects this: slice 1 touches `app/api/ingestion/[id]/blocks/route.ts` + its test.

   Prefill mapping (field names pinned to the REAL source schemas — verified, no hallucinated fields):
   - `mistake_draft.difficulty` (1..5) → seed `difficulty`.
   - `mistake_draft.wrong_answer` (`failure`/`partial`/`success`/`unanswered`) → there is no `outcome` field in
     `BlockFormState`; the import payload derives outcome server-side from `wrong_answer_md` presence. So the
     suggestion is **display-only context** (show "AI 判定：失败/部分/正确/未作答" as a hint), not a seeded form field —
     unless we add an editable outcome control. **Decision (minimal-functional): surface it as a read-only AI hint
     line; do NOT add a new outcome form field** (the import contract doesn't accept outcome; auto-enroll derives it).
     This keeps #3 within the existing import flow's shape. **The field is `wrong_answer` (mistake_enroll.ts:39), NOT
     `outcome`** — read `mistake_draft.wrong_answer` for the hint; do not reference a nonexistent `outcome` key.
   - `mistake_draft.cause.primary_category` → seed `cause_primary`. **Seed ORDER matters** (P2-3 of the self-heal
     effect): the existing effect at VisionTab.tsx:543-547 clears BOTH `cause_primary` AND `cause_notes` whenever
     `cause_primary` is not in `causeOptions`. `causeOptions` derives from the seeded `knowledge_ids`
     (`causeOptionsForSelectedKnowledge(..., selectedKnowledgeIds)`). So `cause_notes` only survives if `cause_primary`
     is a valid option for the seeded knowledge set. Therefore seed `knowledge_ids` and `cause_primary` together, and
     only seed `cause_primary` when it is present (a bad/absent seed self-heals to `''`, which is correct, but also
     wipes `cause_notes` — so don't seed `cause_notes` expecting it to persist behind an invalid `cause_primary`).
   - `mistake_draft.cause.analysis_md` → seed `cause_notes`. **NOT `cause.user_notes`** (that field does not exist on
     `CauseSchema` — see correction above; `analysis_md` is the human-readable cause text the judge produced). A
     literal `mistake_draft.cause.user_notes` access against the typed `CauseSchema` would not even compile, so the
     mapping MUST read `analysis_md`. (If `cause` is null — i.e. `wrong_answer !== 'failure'` — seed `cause_notes: ''`
     and `cause_primary: ''`, today's defaults.)
   - `suggested_knowledge_ids` → seed `knowledge_ids`.

### Editability
All prefilled fields stay **fully editable** — they're just initial values in `blockForms`. The user can toggle
knowledge chips, change difficulty, pick a different cause exactly as today. Add a small **"AI 预填" affordance**: a
muted `Badge tone="info"` near the seeded fields ("AI 预填，可改") so the user knows these came from the judge, not OCR
— per redraw-brief:43 "editable prefills" + project memory (AI decisions visible/traceable). Non-color cue: the text
"AI 预填" label.

### Merge point with existing import flow
- The **seed effect** (VisionTab.tsx:161-190) is the single injection point. It calls the pure
  `seedBlockForm(block)` helper from `src/ui/lib/auto-enroll.ts` (created in slice 2): when `b.auto_enroll_observation`
  is present, the helper returns the observation-derived values for `knowledge_ids` / `difficulty` / `cause_primary` /
  `cause_notes` (from `cause.analysis_md`); fields without a suggestion keep today's defaults. Extracting the mapping
  into `seedBlockForm` is what lets slice 3 be unit-tested without a DOM (the effect body becomes a one-line call).
- The **import handler** (VisionTab.tsx:246-300) is UNCHANGED — it reads `blockForms` as today. Because prefill only
  changes initial `blockForms` values, the import payload shape, validation, and `/import` call are untouched. This is
  the cleanest merge: prefill is purely a better default, the downstream contract is identical.
- The `BlockRow` interface in VisionTab (lines 75-94) must gain `auto_enroll_observation: AutoEnrollObservation | null`
  (import the shared type from `src/ui/lib/auto-enroll.ts`). Also widen `status` union to include `'auto_enrolled'`
  (line 91 currently `'draft'|'imported'|'ignored'`; the route already returns the 4-state union per
  business.ts:145).

---

## 5. Test checklist

### Slice 1 — `GET /api/ingestion` + `mistake_draft` surfacing
- File: extend existing `app/api/ingestion/route.test.ts` (**verified DB partition** — already imports
  `tests/helpers/db`) with GET `describe` blocks. No new file.
- Assertions:
  - empty DB → `{ rows: [] }`.
  - seed N ingestion sessions (varied `created_at`) → returned newest-first, capped at `limit`.
  - `limit` clamps to 1..100 (e.g. `limit=0`→1, `limit=999`→100).
  - a session with M blocks, K of them `auto_enrolled`, and J `auto_enroll_observed` events → `block_count===M`,
    `auto_enrolled_count===K`, `observation_count===J`.
  - non-ingestion `learning_session` rows (type≠'ingestion') are excluded.
  - `created_at` is unix seconds (integer), `entrypoint` passthrough.
- For `mistake_draft` surfacing (extend `app/api/ingestion/[id]/blocks/route.test.ts`, **DB**): seed an
  `auto_enroll_observed` event whose payload includes `mistake_draft` → assert
  `rows[i].auto_enroll_observation.mistake_draft` round-trips under the EXACT pinned keys
  `{ wrong_answer, difficulty, cause: { primary_category, analysis_md } }` (NO `outcome` key — the source field is
  `wrong_answer`); seed one without `mistake_draft` → assert it's `null`; seed one with a PARTIAL/legacy `mistake_draft`
  (e.g. missing `difficulty`) → assert the tolerant projection keeps the present fields and nulls the absent ones
  (does NOT drop the whole draft — see §6 P3-2).

### Slice 2 — `auto-enroll.ts` pure fns (unit) + AutoEnrolledPanel static HTML (unit)
**Two test files**, both clean unit (no DB/R2/AI imports). See "Test-stack reality" in §1 — node-only env, `renderToString`
for markup, pure fns for logic. NO jsdom, NO `QueryClientProvider`, NO click/effect simulation.

- File A: `src/ui/lib/auto-enroll.test.ts` (**unit**, pure functions, no render):
  - `formatConfidence(0.5)` → `'confidence 0.50'`; `formatConfidence(null)` → a stable placeholder (e.g. `'confidence —'`).
  - banner-derivation predicate: `every(status !== 'auto_enrolled')` over canned block arrays → `true`/`false` cases.
  - revert-gating predicate: a block with `status:'auto_enrolled'` → revertable `true`; `draft` → `false`.
- File B: `src/ui/components/AutoEnrolledPanel.test.tsx` (**unit**, `renderToString` static HTML):
  - Render the panel's pure presentational pieces (extract a presentational `PanelBody`/row renderer that takes already-
    resolved data as props, so it can be `renderToString`'d WITHOUT TanStack Query mounting). Assert:
    - empty state input → HTML contains EmptyState copy "AI 正在观察，尚未自动录入".
    - populated input (rows with observation) → HTML contains route text (`auto`/`review`), the mono `confidence X.XX`
      string, knowledge-name chip text.
    - observe banner: input where all blocks are `draft` → HTML contains the `observe-only` banner text; input with an
      `auto_enrolled` block → banner text ABSENT.
    - a row with `status:'auto_enrolled'` → HTML contains the "撤销" revert control; a `draft` row → "撤销" ABSENT
      (the "仅观察 · 无可撤销项" hint present instead).
  - The live data wiring (TanStack Query, `apiJson`, mutation, two-step confirm, refetch/invalidation) is NOT unit-tested
    here — it can't be exercised by `renderToString` on the current stack, and the revert SERVICE is already covered by
    `revert-auto-enroll.test.ts` (DB). The component test asserts only that the right static affordance renders for a
    given resolved input. (This is the deliberate trade in §1; it is NOT a coverage gap to "fix" by adding jsdom.)
- Partition guard: both files import NOTHING from `@/db/client` / `postgres` / `drizzle` / `tests/helpers/db` → clean unit.

### Slice 3 — VisionTab prefill: `seedBlockForm` pure fn (unit) + VisionTab static HTML (unit)
- File A: extend `src/ui/lib/auto-enroll.test.ts` with `seedBlockForm` cases (**unit**, pure, no render — this is where
  the prefill LOGIC is actually verified, since the seed runs in a `useEffect` that `renderToString` cannot tick):
  - a block WITH `auto_enroll_observation.suggested_knowledge_ids=['k1','k2']` → `seedBlockForm(block).knowledge_ids ===
    ['k1','k2']`.
  - `mistake_draft.difficulty=4` → `seedBlockForm(block).difficulty === 4`.
  - `mistake_draft.cause.primary_category='x'` present → `seedBlockForm(block).cause_primary === 'x'` and
    `seedBlockForm(block).cause_notes === mistake_draft.cause.analysis_md` (mapped from `analysis_md`, NOT a
    nonexistent `user_notes`).
  - `mistake_draft.cause = null` (non-failure outcome) → `cause_primary === ''` and `cause_notes === ''`.
  - a block WITHOUT observation → today's defaults (`knowledge_ids: []`, `difficulty: 3`, `cause_primary: ''`,
    `cause_notes: ''`, `question_kind: 'short_answer'`) unchanged (regression guard).
  - NOTE on self-heal: the in-component `useEffect` (VisionTab.tsx:543-547) that clears `cause_primary`+`cause_notes`
    when `cause_primary ∉ causeOptions` is NOT re-tested here (it's existing behavior); `seedBlockForm` only produces
    initial values. The seed→self-heal ordering interaction is documented in §4 and is correct-by-construction (seed
    `knowledge_ids` and `cause_primary` from the same observation so `causeOptions` admits the seeded `cause_primary`).
- File B: `src/ui/components/VisionTab.test.tsx` (NEW, **unit**, `renderToString` static HTML — mock `apiJson`,
  `uploadAsset`, `useIngestionSSE`, `useAssetUrl` so no DB/R2/AI import leaks; mirror how other UI tests stub these):
  - render a block list where one block carries an `auto_enroll_observation` and one does not → HTML contains the
    "AI 预填，可改" badge text for the observation block and NOT for the plain block. (Markup-presence only; the seeded
    VALUES are asserted in File A, not here.)

### Whole-PR gate
`pnpm typecheck`, `pnpm lint`, `pnpm audit:schema`, `pnpm audit:partition`, `pnpm audit:profile`, `pnpm test`,
`pnpm build` (with `DATABASE_URL` placeholder env per worktree-build note). Touched-file Biome on every commit.
**Visual ring (Playwright screenshot + visual-verdict vs loom reference) is intentionally OUT of this gate**: the
brief mandates minimal-functional ("the visual is this redraw's job", redraw-brief:42) and redraw-wave2 owns the visual
pass. We ship functional markup with tokens/primitives; the screenshot ring runs in wave2, not here. (Stated explicitly
so the omission is a decision, not a gap.)

---

## 6. Risks & rollback

### Risk: collision with redraw-wave2
`docs/superpowers/plans/2026-06-04-redraw-wave2-plan.md` redraws `/record` visually, and the loom prototype
(`screen-record.jsx`) ALREADY contains an `AutoEnrollPanel` design. **Two avoidance moves**:
1. Build AutoEnrolledPanel **minimal-functional** (redraw-brief:42 mandate "the visual is this redraw's job") — wire it
   with existing primitives + tokens, do NOT invest in bespoke visual polish that the redraw will overwrite. The
   functional contract (data flow, states, revert) is what survives the redraw; the markup is replaceable.
2. Keep all new UI **inside new files** (`AutoEnrolledPanel.tsx`, `src/ui/lib/auto-enroll.ts`) + one small insertion in
   `record/page.tsx` (render the panel). Minimize the `record/page.tsx` diff surface so a wave2 rebase is a one-line
   re-add, not a merge fight. Touch VisionTab only in the seed effect + BlockRow type + one badge (slice 3).

   Check at lane start: `git log origin/main --oneline -- 'app/(app)/record/**' 'src/ui/components/VisionTab.tsx'` to
   confirm wave2 hasn't landed on main ahead of us; if it has, rebase the panel onto the redrawn markup.

### Risk: tab-vs-panel ambiguity (brief prose says "new MODE_TAB" AND "mirroring vision_paper")
**Resolved toward a 5th tab `auto_enrolled`** (see §3 corrected placement). Both brief signals agree once you check the
code: `vision_paper` is itself tab-gated (`{mode==='vision_paper' && <VisionTab/>}`, record/page.tsx:119), so "mirroring
vision_paper" = tab-gated, same as the explicit "new MODE_TAB" phrase. The earlier "always-mounted sibling" reading was
retracted (it mis-described vision_paper and would eager-fetch the session list on unrelated tabs). Keep
`AutoEnrolledPanel` self-contained so if the owner ever prefers a sibling render it's a one-line wrapper swap (no
component rewrite). Flag the chosen tab placement in the PR description for sign-off.

### Risk: observe-only means revert can't be exercised against real enrolled data
`auto_enrolled` blocks only exist when `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED=ON`, which is OFF in production (and we are
NOT flipping it — that's #4). So the **populated-with-revert path can't be hit by clicking through prod**. Verification
strategy: the revert path is verified by **DB tests on the service** (`revert-auto-enroll.test.ts`, already exists) +
**static-HTML panel tests** + **pure-fn predicate tests** (§5 slice 2) that feed canned blocks with
`status:'auto_enrolled'` + observation. To produce populated test data: in the slice-1 DB test, seed a `question_block`
row with `status='auto_enrolled'` + `imported_question_id` set + a matching `auto_enroll_observed` event; in the slice-2
unit tests, pass such a row as a resolved prop to the presentational renderer / predicate. We do NOT need the flag ON to
test the surface — the wire shape is independent of the flag. (Per §1 test-stack reality, the live click→POST path is
intentionally NOT unit-asserted; the service DB test covers the mutation.)

### Risk: `mistake_draft` payload shape drift (P3-2 — tolerant projection, NOT strict full-schema safeParse)
`mistake_draft` in the payload is the FULL `MistakeEnrollOutputT` (`wrong_answer` / `question_type` / `difficulty` /
`cause` / `overall_confidence` / `reasoning`), but the prefill only needs a subset. **Do NOT `safeParse` the whole
`MistakeEnrollOutput` schema and fall back to null on any mismatch** — a strict full-schema parse would reject a
historical/legacy event that predates a field or carries a slightly different shape, silently dropping a draft that is
"valid enough" for prefill. Instead, **project tolerantly**: read only the needed fields and guard each one
defensively, reusing the existing tolerant helpers already in `blocks/route.ts:126-136`
(`stringOrNull` / `numberOrNull` / `stringArray`) plus a small enum-guard:
- `wrong_answer`: enum-guard against `['failure','partial','success','unanswered']`, else `null`.
- `difficulty`: `numberOrNull` (and clamp to 1..5 if you want, else pass through as the seed clamps).
- `cause`: if `payload.mistake_draft.cause` is an object, project `{ primary_category: stringOrNull(...), analysis_md: stringOrNull(...) }`; else `null`.
Whole-`mistake_draft` is `null` only when `payload.mistake_draft` itself is absent/not-an-object. This keeps a partial
historical event usable (present fields seed, absent fields fall to defaults) rather than discarding it wholesale.
Rollback: if extraction proves flaky, ship slices 1+2 (panel) and defer slice 3 (prefill) — they're independent; the
panel does not depend on `mistake_draft`, only on `route/confidence/suggested_knowledge_ids` which are already surfaced.

### Rollback granularity
The 4 commits are independently revertable. Slice 1 (read API + `mistake_draft` surfacing) is inert without UI. Slice 2
(panel) and slice 3 (prefill) touch disjoint UI (`AutoEnrolledPanel` vs `VisionTab` seed) and share only the new
`src/ui/lib/auto-enroll.ts`. If wave2 conflicts, the panel's tab registration in `record/page.tsx` (one line in the
`ModeTab` union, one entry in `MODE_TABS`, one gated render) is the only shared surface.

---

## 7. Linear capture
No new follow-up Linear issue required at plan time — this lane IS YUK-164 #2/#3. The one deferred item
(`WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED` flip = #4) is already tracked under YUK-164 and explicitly out of scope here
(commit trailer `Refs YUK-164`, not `Closes`). If, during implementation, the `mistake_draft` surfacing reveals
missing payload fields on historical events, file a YUK follow-up; otherwise none.

---

## 8. Critic round — disposition (统合 sign-off 2026-06-06)

Critic verdict was `FIX_REQUIRED` (2×P1, 3×P2, 2×P3). All P1+P2 ABSORBED; both P3 absorbed (cheap + correct). All
six rest on facts I re-verified against source before editing.

**Absorbed (with the source line that confirms the critic):**
- **P1-1** (cause field) — `CauseSchema` (cause.ts:13-18) = `{ primary_category, secondary_categories, analysis_md,
  confidence }`; NO `user_notes`. Fixed §4: prefill maps `cause_notes ← cause.analysis_md` (was the hallucinated
  `cause.user_notes`, which would not typecheck against the typed `CauseSchema`); §4 prose now describes the real shape;
  the seed/self-heal ordering (VisionTab.tsx:543-547 clears BOTH `cause_primary`+`cause_notes`) is documented so
  `knowledge_ids`+`cause_primary` seed together. Disambiguated: `user_notes` is a real field on the VisionTab *import
  payload* (VisionTab.tsx:282) but NOT on the source `mistake_draft.cause` — the critic's "won't compile" point holds
  for reads off the typed cause.
- **P1-2** (no interactive DOM test stack) — verified: no `@testing-library`/`jsdom`/`happy-dom`, both vitest configs
  `environment:'node'`, every `*.test.tsx` uses `renderToString` static HTML only, ZERO use `QueryClientProvider`/mount/
  click. Chose **option (a)**: extract logic into pure fns (`seedBlockForm`, `formatConfidence`, banner/revert
  predicates in `src/ui/lib/auto-enroll.ts`) unit-tested directly; assert markup via `renderToString` on an extracted
  presentational `PanelBody`; do NOT add jsdom (rejected as scope expansion). §1 "Test-stack reality" + §5 rewritten;
  impossible click/slider/refetch assertions removed; revert SERVICE coverage delegated to existing
  `revert-auto-enroll.test.ts` (DB).
- **P2-1** (tab vs panel mis-argued) — verified record/page.tsx:119 renders `vision_paper` as
  `{mode==='vision_paper' && <VisionTab/>}` (TAB-GATED, not unconditional). Re-resolved §3 toward a **5th tab
  `auto_enrolled`** (add to `ModeTab` union :16 + `MODE_TABS` :92-96, gate `{mode==='auto_enrolled' && <Panel/>}`);
  retracted the "always-mounted mirrors vision_paper" claim (it didn't); this also kills the eager session-list fetch
  on the default tab. §6 risk paragraph + slice table + rollback updated.
- **P2-2** (`outcome` vs `wrong_answer`) — verified `MistakeEnrollOutput.wrong_answer` (mistake_enroll.ts:39); no
  `outcome` field. Pinned the wire key to `wrong_answer` in slice 1's `toAutoEnrollObservation` extension; removed the
  `outcome|wrong_answer` either/or in §4 + the slice-1 round-trip test; the AI-hint line reads `mistake_draft.wrong_answer`.
- **P2-3** (banner source) — pinned a hard contract in §3: the observe-only banner derives from `blocksQ.data`
  (`every(status!=='auto_enrolled')`), the SAME source as the per-row revert gate — NOT the session-list
  `auto_enrolled_count` (which is cached under a different query key and can momentarily disagree after a revert). The
  list count may drive only the picker badge.
- **P3-1** (stale wire-shape comment / "carries everything") — corrected §0 to list the function's ACTUAL return
  (event_id/outcome/mode/route/confidence/threshold/reasoning/suggested_knowledge_ids/observed_at; no
  ingestion_session_id; no mistake_draft yet), flagged blocks/route.ts:23-25 as stale, and made slice 1 update that
  comment when it touches the function.
- **P3-2** (tolerant projection, not strict safeParse) — replaced the §6 "safeParse full `MistakeEnrollOutput` → null"
  posture with a tolerant per-field projection reusing `stringOrNull`/`numberOrNull` + an enum-guard, so a partial/
  legacy historical `mistake_draft` keeps its present fields instead of being dropped wholesale.

**驳回记录 (rejected): none.** All seven issues were verified true against source and absorbed. No critic claim was
overruled. (One precision note added in §4, not a rejection: the critic's "`user_notes` is always undefined" is exactly
right for reads off `mistake_draft.cause`; `user_notes` does legitimately exist as a write-side field on the import
payload, which the plan now states so an implementer doesn't delete it from the import handler by mistake.)
