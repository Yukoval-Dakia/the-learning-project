# Editable Profile Studio — agent-managed subject policy design

> **Status**: design, 2026-06-03. **Refs**: ADR-0014 (generalized activity +
> capability registry), Foundation B SubjectProfile closeout, profile validator
> audit. **Decision**: `SubjectProfile` evolves from a hand-written "hard
> contract" into a versioned, editable runtime policy snapshot managed through a
> visual studio and agent review loop.

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

Preview must show due-queue impact: approximate added/removed due items, items
whose next review moves substantially, and whether mixed-subject balancing is
affected.

### `cause category ids`

Cause ids are editable, but the edit must be classified:

- **label/description edit**: same id, same semantics;
- **rename**: same semantics, new id, with explicit mapping;
- **split**: one old category becomes multiple new categories;
- **merge**: multiple old categories become one;
- **semantic replacement**: old and new should not be mixed in analytics.

The Studio must never treat an id string edit as a harmless text edit. It must
ask for the intended mapping and show analytics/variant-generation impact.

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

Agent tasks propose. They do not silently publish. This follows the project's
existing proposal-first safety pattern for destructive or semantically heavy AI
actions.

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
