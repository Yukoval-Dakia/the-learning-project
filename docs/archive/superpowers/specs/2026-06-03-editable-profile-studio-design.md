# Editable Profile Studio — agent-managed subject policy design

> **Status**: design, 2026-06-03. **Refs**: ADR-0014 (generalized activity +
> capability registry), Foundation B SubjectProfile closeout, profile validator
> audit. **Decision**: `SubjectProfile` evolves from a hand-written "hard
> contract" into a versioned, editable runtime policy snapshot managed through a
> visual studio and agent review loop.
>
> **U0 adjudication note (2026-06-04 / YUK-205 / ADR-0029)**: the U0 grill
> session sliced this spec with **MVP knife + zero CUT, full DEFER** (reading A).
> Nothing in the vision is removed — the §0 reframe is *not* reversed — but only
> a small spine ships first; everything else is DEFERRED behind an explicit
> trigger. See `docs/adr/0029-review-engine-lands-on-existing-primitives.md` for
> the adjudication cluster and `docs/audit/2026-06-04-design-feasibility-audit.md`
> for the feasibility audit (U0 gate + §5 七问) that drove it. Sections amended
> below carry an inline `> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**`
> marker at the point of change.

## 0. Reframe

The old framing was "some profile fields are hard contract; other fields are
agent-managed." That is too rigid. Every profile field can be edited, including
subject id, capability refs, judge route priority, render config, scheduling
policy, cause category ids, prompts, rubrics, and templates.

The invariant is not field immutability. The invariant is historical
explainability:

- runtime uses a published `SubjectProfileSnapshot`, never a free-floating draft;
- historical events keep the profile/capability version they were produced
  under;
- edits create drafts and eventually a new published snapshot;
- high-impact edits require impact preview, fixture smoke, and explicit publish.

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: the "historical events keep
> their profile/capability version" invariant does **not** hold today —
> `capability_ref.version` is hard-coded `'1.0.0'`
> (question-contract.ts:92,239 / steps-judge.ts:10). The invariant is honored
> by D6 judge-event version stamping (see §8 gates), which adds optional
> `profile_version`/`capability_ref`/`judge_route` to the judge-event payload
> and reads the real `SubjectProfile.version`. This stamping is the **first
> slice** (§9) and ships before any Studio UI; until it lands, the invariant is
> aspirational rather than enforced.

Short version: **SubjectProfile is not a hard-coded contract; it is a versioned
editable policy. The hard thing is the publish record and historical reference,
not the fields.**

## 1. Product shape — Subject Studio

Add an admin surface for managing subject policies. It should feel like a dense
ops/editor tool, not a landing page or generic settings screen.

Primary routes:

- `/admin/subjects` — subject list: current snapshot, active draft, validation
  state, recent agent runs, and next required gate.
- `/admin/subjects/[subjectId]` — subject workspace with tabs:
  - **Overview**: current published snapshot, active draft, aliases, recent
    publish history, and warnings.
  - **Policy Editor**: editable fields grouped by identity, capability routing,
    rendering, scheduling, cause taxonomy, and authoring prompts.
  - **Agent Drafts**: ProfileAuthor / ProfileCritic / FixtureGenerator outputs,
    grouped as patch sets.
  - **Impact Preview**: what the draft changes: route changes, category mapping,
    due queue shift, rendered content preview, fixture delta.
  - **Fixtures**: subject-specific examples, expected signals, smoke runs, and
    failing cases.
  - **Publish**: validator status, required approvals, version bump, release
    notes, rollback target.
  - **History**: snapshots, diffs, profile refs used by events, and rollback.

Core UI rule: no field is locked by default. Instead, each change is tagged by
impact:

- **Low**: label, description, tone, teaching wording.
- **Medium**: prompt fragments, note template wording, review priority,
  variant targeting, rubric hints.
- **High**: subject id, cause category id semantics, capability refs, judge route
  priority, scheduler policy, render baseline, compatibility mappings.

High impact is not forbidden. It triggers stronger preview and publish gates.

## 2. Editing model

Represent subject policy in four lifecycle states:

1. **Published snapshot** — the current runtime policy. Route handlers,
   workers, renderers, scheduler, and prompt builders consume this.
2. **Draft** — mutable working copy. User and agents can edit it freely.
3. **Patch set** — a proposed change from an agent or user, with explanation,
   impact tags, and test evidence.
4. **Historical snapshot** — immutable record for old events and audit. It is not
   edited in place; changes publish a new snapshot.

Edits can be manual, agent-proposed, or agent-generated from a brief. The editor
does not distinguish "human-written" and "agent-written" fields once a patch is
accepted; all accepted changes belong to the draft and must pass the same gates.

## 3. What each formerly-hard field means when editable

### `subject_id`

The stable routing name for a subject, currently analogous to `math` or
`physics`. It is editable, but a rename must be interpreted as one of:

- **alias**: old id still resolves to the same subject;
- **rename migration**: knowledge domains and subject refs move forward;
- **fork**: new subject starts from old policy but historical data remains with
  the old subject.

The Studio must ask which semantic operation the user intends. It should not
silently rewrite old records.

### `profile_version`

The published snapshot version. Users do not hand-edit the final version string
as ordinary content; publishing assigns or confirms it. A draft may suggest a
version bump, but publish creates the authoritative version.

The important behavior is that old events keep pointing at their old snapshot.
Rejudge creates a new event; it does not rewrite old results.

### `capability_refs`

The capabilities a subject may use, such as exact, keyword, semantic, steps,
unit_dimension, multimodal_direct, or future rubric/external verdict runners.

They are editable because a subject's assessment strategy evolves. A change here
is high impact because it changes runtime behavior, model cost, latency, and
failure modes. Publish requires registry validation plus fixture smoke for the
affected routes.

### `judge route priority`

The ordering/policy for choosing a judge route. This is editable because agent
evidence may show that a subject should prefer rubric over semantic, or a
specific deterministic capability before an LLM fallback.

Preview must show which fixture cases route differently under the draft.

### `render config`

Rendering defaults such as font family, notation, and code highlighting. This is
editable because subject material changes. It remains a runtime anchor because
UI must render old artifacts safely.

Preview must show sample content under old and draft render config. If a draft
turns on KaTeX/code highlighting, fixture content should include representative
formula/code examples.

### `scheduler policy`

The default review scheduler, currently commonly `fsrs`. This is editable
because some learning loops may be practice cadence, evidence-only, or project
based.

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: scheduling lives on
> `SubjectProfile.schedulingHints` (ADR-0014) — there is **no per-knowledge
> scheduler-policy column**, and knowledge-level FSRS reuses
> `material_fsrs_state(subject_kind='knowledge')` per D1/ADR-0028. The
> **due-queue impact preview is DEFERRED** (trigger = a *second* scheduler
> policy exists). Today the only policy is `fsrs`, so a policy delta is
> structurally always empty (audit SR-8) and a due-queue preview has nothing to
> show. The near-term, actually-useful impact preview is a **route-resolution
> diff**: run `resolveQuestionJudgeRoute` as a pure function over old vs draft
> profile and show which fixture/question families route differently. This is
> "可先做不挡 MVP" — buildable now, but not on the MVP critical path.

### `cause category ids`

Cause ids are editable, but the edit must be classified:

- **label/description edit**: same id, same semantics;
- **rename**: same semantics, new id, with explicit mapping;
- **split**: one old category becomes multiple new categories;
- **merge**: multiple old categories become one;
- **semantic replacement**: old and new should not be mixed in analytics.

The Studio must never treat an id string edit as a harmless text edit. It must
ask for the intended mapping and show analytics/variant-generation impact.

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: the **cause-taxonomy board**
> (§7) and the `subject_id` rename/alias/fork classifier (above) are both
> **DEFERRED** (trigger = the first real rename/split need). This is **schedule,
> not policy**: §0's "no field is locked" stance is unchanged. Until the gated
> tooling exists, the Studio UI simply ships **no edit entry point** for these
> two classes; the fallback is hand-editing `src/subjects/<id>/profile.ts`
> guarded by a **cause-id lint** (`causeLean` hard-coding + `variant_gen`
> targeted cross-check), tracked under YUK-172. See §8 gates.

## 4. Agent loop

Introduce an authoring loop that sits before the published snapshot:

1. **ProfileAuthorTask** drafts a subject policy from a subject brief, examples,
   existing knowledge nodes, and user goals.
2. **ProfileCriticTask** reviews for overbroad taxonomy, missing capabilities,
   route ambiguity, prompt/template drift, and fixture gaps.
3. **FixtureGeneratorTask** proposes representative fixtures and expected
   signals for routes, rendering, attribution, and scheduling.
4. **ProfileImpactTask** compares published snapshot vs draft and produces the
   impact report used by the UI.
5. The user accepts, edits, or dismisses patch sets.
6. Publish compiles the draft into a `SubjectProfileSnapshot` after validation
   and smoke checks.

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: **ProfileCriticTask is the
> only MVP agent** (it reviews human/agent drafts without owning generation, so
> it gives value immediately). The other three are **DEFERRED** with explicit
> triggers:
> - **ProfileAuthorTask** — trigger = the Critic loop runs smoothly in practice;
> - **FixtureGeneratorTask** — trigger = DB-backed fixture runs exist (tied to
>   the §5 table DEFER);
> - **ProfileImpactTask** — DEFERRED as a task; the near-term impact preview is
>   the pure-function route-resolution diff described in §3, not a dedicated
>   agent.

Agent tasks propose. They do not silently publish.

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: the proposal-only invariant
> is owned by **ADR-0025 ND-5** (with ADR-0004). This spec restates it by
> reference rather than re-deriving it; admission of agent-proposed profile
> edits follows the **blast-radius admission rule in the Agent Framework spec
> §3** (per D8): a *global policy* like a subject profile is **publish-gated**
> (never auto-active), as opposed to per-item measurement metadata which is
> auto-active with confidence + provenance.

## 5. Data model direction

V1 can stay file-backed: agents generate patches to
`src/subjects/<id>/profile.ts`, tests and `pnpm audit:profile` validate the
compiled result, and the Studio reads the current compiled profiles.

Longer term, add database-backed authoring records:

- `subject_profile_snapshot`
  - `id`, `subject_id`, `version`, `profile_json`, `created_at`,
    `created_by_event_id`, `status`.
- `subject_profile_draft`
  - `id`, `subject_id`, `base_snapshot_id`, `draft_json`, `updated_at`.
- `subject_profile_patch`
  - `id`, `draft_id`, `actor_kind`, `actor_ref`, `patch_json`, `impact_level`,
    `reason_md`, `status`.
- `subject_profile_fixture_run`
  - `id`, `draft_id`, `snapshot_id`, `result_json`, `created_at`.

Runtime should resolve only published snapshots. Drafts are authoring state.

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: all four `subject_profile_*`
> DB tables are **DEFERRED** (trigger = the git-backed flow proves insufficient).
> `git` already supplies the four lifecycle states for free — commit = snapshot,
> uncommitted working tree = draft, diff/PR = patch, history = audit trail — and
> `profile.ts` has been verified to round-trip as pure data, so no DB row is
> needed to author profiles today. **V1 stays file-backed.** Do not add these
> tables until a concrete authoring need (concurrent drafts, agent-run fixture
> persistence, cross-machine state) can't be served by git.

## 6. Runtime resolution

Current route handlers and workers already rely on resolved `SubjectProfile`.
The new system preserves that interface:

```txt
domain / subject ref
  -> resolve published SubjectProfileSnapshot
  -> runTask / judge router / renderer / scheduler
```

The runtime should not call ProfileAuthor/ProfileCritic. Runtime behavior must
be deterministic for a given snapshot. If the user wants changed behavior, they
edit and publish a new snapshot.

## 7. Visual interaction details

Important screens and controls:

- Subject list with status chips: published, draft, failing fixtures, publish
  blocked, deprecated alias.
- Diff editor with field-level impact badges.
- Side-by-side preview for prompts, render config, and due queue.
- Cause taxonomy board with explicit operations: rename, split, merge, replace.
- Capability route matrix: rows = question/activity families; columns =
  capabilities; cells show enabled, preferred, fallback, or blocked.

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: the **cause-taxonomy board**
> and the side-by-side **due-queue preview** above are **DEFERRED** (board:
> trigger = first real rename/split need; due-queue: trigger = a second
> scheduler policy exists — see §3). These are schedule, not policy; §0 stays.
> Until then, cause-id edits go through hand-edited `profile.ts` + cause-id lint
> (YUK-172), and the near-term impact panel is the route-resolution diff (§3),
> not a due-queue panel.
- Fixture console: case list, expected route, actual route, score delta, output
  evidence.
- Publish drawer: version bump, required gates, release notes, rollback pointer.

The interface should be compact and operational: tabs, tables, diff panels,
badges, segmented controls, menus, and icon buttons. Avoid decorative hero
patterns. This is a tool for repeated subject maintenance.

## 8. Gates

Minimum publish gates:

- profile schema parse succeeds;
- declared capabilities resolve in the registry;
- scheduler resolves and supports required activity kind(s);
- render config parses and has preview coverage if notation/highlighting changes;
- cause category id changes have explicit mapping;
- affected fixture smoke passes or failures are explicitly accepted;
- impact report is attached to the publish event.

This extends current `pnpm audit:profile` rather than replacing it. The
2026-05-30 drift audit already notes validator coverage gaps around prompt
section references, fallback family, and pipeline schema compatibility; the
Studio publish gate is a good home for those checks.

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: three concrete foundation
> gates land first, ahead of the long-term publish-gate vision:
>
> - **profile_version event stamping (D6)** — the first slice. Judge-event
>   payload gains optional `profile_version`/`capability_ref`/`judge_route`, and
>   the hard-coded `capability_ref.version` `'1.0.0'`
>   (question-contract.ts:92,239 / steps-judge.ts:10) is replaced with the real
>   `SubjectProfile.version`. This is a **shared CO/PS slice — built once, not
>   twice**; it makes the §0 historical-explainability invariant actually true.
> - **`audit:profile` registry-traversal fix (YUK-206)** — repair the registry
>   walk so declared capabilities are genuinely validated against the capability
>   registry, not silently skipped.
> - **cause-id lint** — guard against `causeLean` hard-coding drift plus a
>   `variant_gen` targeted cross-check, so hand-edited `profile.ts` cause-id
>   changes (the file-backed fallback while the taxonomy board is DEFERRED) stay
>   honest. Tracked under YUK-172.

## 9. First implementation slice

Keep the first slice deliberately small:

1. Add a design-only `Subject Studio` admin route backed by existing compiled
   profiles, read-only except draft JSON import/export.
2. Define `SubjectProfileDraft` and `ProfileImpactReport` Zod schemas in core.
3. Implement a local compile/check script: draft JSON -> `SubjectProfileSchema`
   -> `validateProfile` -> impact report.
4. Add one agent task, `ProfileCriticTask`, before `ProfileAuthorTask`. Critic
   gives immediate value by reviewing human/agent drafts without owning
   generation.
5. Add fixtures later; do not block v1 UI on DB-backed snapshots.

This validates the product loop without prematurely migrating runtime profile
resolution out of TypeScript files.

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: the MVP KEEP list (per D9)
> is ordered as follows, and only these ship in the first pass:
>
> 1. **D6 judge-event version stamping** (the first knife; shared CO/PS slice,
>    built once — see §8);
> 2. **`audit:profile` registry-traversal fix (YUK-206)**;
> 3. **`SubjectProfileDraft` + `ProfileImpactReport` Zod schemas** in core;
> 4. **draft-JSON → `validateProfile` → diff CLI compile script**;
> 5. **profile → TS-literal serializer** (round-trip back to `profile.ts`);
> 6. **`ProfileCriticTask`** — the only MVP agent;
> 7. **read-only `/admin/subjects` page** — reuses the existing `(admin)` layout
>    + `TokenGate`. Any future write operation **must** go through `/api/admin/*`
>    so it inherits the API token gate (see the Security note below); no page
>    Server Action.
>
> Everything else in this spec is DEFERRED with the triggers recorded in the
> amended sections above.

## 9a. Security note — admin pages are not middleware-gated

> **Added 2026-06-04 (U0 / YUK-205 / ADR-0029)**, per audit SR-4.

The auth middleware **does not gate admin PAGE routes**: `middleware.ts`'s
`matcher` only covers `/api/:path*`, and `TokenGate` is a client-side
`localStorage` guard, not a server-side check. A page route under `/admin/*`
therefore renders without any server-enforced token.

The hard rule for this Studio: **every write operation must go through
`/api/admin/*`**, so it inherits the middleware's `x-internal-token` gate. Do
**not** put writes in page Server Actions — those bypass the API matcher and run
unauthenticated. The read-only `/admin/subjects` page (§9) is fine because it
only reads compiled profiles client-side; the moment a write is introduced it
moves behind an `/api/admin/*` endpoint.

The single-token model is sufficient for this single-user tool — there is no
per-user auth, and the one shared `INTERNAL_TOKEN` is the entire trust boundary.
Stating this explicitly so no future slice "improves" the page route into a
Server Action that quietly drops the gate.

## 10. Open decisions

- Where should published snapshots live long term: TypeScript source, DB, or
  generated JSON checked into the repo?
- Should a profile publish require user approval always, or can low-impact
  patches auto-publish after green gates?
- Should cause category mappings become first-class event payloads so analytics
  can reinterpret history explicitly?
- Should subject id rename ever rewrite knowledge domains, or should aliases be
  the default forever?

## 11. Non-goals

- No runtime free-form profile inference.
- No silent mutation of historical events.
- No external plugin marketplace for subjects in this slice.
- No full DB migration in the first slice.
- No UI for editing every downstream prompt builder directly; the Studio edits
  profile policy and draft patches, then compiled runtime continues to use the
  existing prompt builders.
