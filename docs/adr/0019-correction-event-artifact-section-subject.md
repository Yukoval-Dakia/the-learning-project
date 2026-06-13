# ADR-0019 — Correction event extends to artifact-section subject

**Status**: superseded by [ADR-0020](0020-block-tree-note-rebuild.md)
**Date**: 2026-05-26
**Supersedes**: —
**Superseded by**: [ADR-0020](0020-block-tree-note-rebuild.md) — 2026-05-26（同日 grill-with-docs 后 Y 路径决策，section_id anchor 整体废止 → block_id anchor）
**Related**: [ADR-0011 v2](0011-tool-use-and-edge-event-paths.md) (event channel taxonomy), [ADR-0014](0014-generalized-activity-and-capability-registry.md) §6 (correction event introduction), [ADR-0018](0018-mistake-variant-lifecycle-and-variants-max.md) (parallel artifact-lifecycle precedent)

> **2026-05-26 同日 supersede 说明**：本 ADR 在 YUK-85 (PR #154) ship 时同日 accepted；当天下午 YUK-88 grill-with-docs session 后路径升级到 Y（atomic 也变 block tree），`section_id` anchor 整体废止，由 ADR-0020 的 `block_id` anchor 接管。文档保留作为决策演进档案；实施层 ADR-0020 是权威。

## Context

ADR-0014 §6 introduced the correction event channel (`action='correct'`) with `correction_kind ∈ { supersede, retract, mark_wrong, restore }` to give the append-only event log a first-class way to mutate projection state without rewriting history. The first surface — [YUK-40](https://linear.app/yukoval-studios/issue/YUK-40) — locked the schema to event-target only:

```ts
// src/core/schema/event/known.ts (pre-ADR-0019)
export const CorrectEvent = z.object({
  ...
  subject_kind: z.literal('event'),
  subject_id: z.string(),  // event_id
  payload: z.object({
    correction_kind: CorrectionKind,
    replacement_event_id: z.string().optional(),
    reason_md: z.string(),
    affected_refs: z.array(ActivityRef).min(1),
  }),
});
```

Track-1 follow-up YUK-85 ("Note 申诉 / 标错 UX") requires users to mark atomic note sections as wrong from the reading view. Pre-flight (2026-05-26) found:

1. `CorrectEvent.subject_kind` is `z.literal('event')` — a hard schema constraint. Cannot reuse for artifact targets without widening the union.
2. `payload.affected_refs: z.array(ActivityRef).min(1)` is event-target invariant — artifacts don't have a natural ActivityRef to point at.
3. `payload.replacement_event_id` is event-typed; supersede on artifacts would replace with another artifact, not another event.
4. Section identifiers are required for atomic note granularity but absent from the existing payload.
5. `NoteSection` schema ([src/core/schema/business.ts:220-228](../../src/core/schema/business.ts)) already has `id: z.string()` — a stable identifier per section, NOT an array index. The id is preserved across in-place edits ([YUK-54](https://linear.app/yukoval-studios/issue/YUK-54) `note section edit-in-place` already shipped this invariant).

Choices considered:

- **Path A** — new parallel `CorrectArtifactEvent` schema, distinct from `CorrectEvent`, sharing the `CorrectionKind` enum.
- **Path B** — new `experimental:note_appeal` event channel that does not flow through correction-state projection at all.
- **Path C** — atomic-level only, no per-section identifier.
- **Widen** `CorrectEvent.subject_kind` to a union — rejected because the `affected_refs.min(1)` and `replacement_event_id` invariants would need to be softened for one side only, polluting the original path.

## Decision

**Adopt Path A.** Introduce a parallel `CorrectArtifactEvent` zod schema beside `CorrectEvent` in `src/core/schema/event/known.ts`, added to the `KnownEvent` union. Wire it through a sibling projection module (`src/server/events/artifact-corrections.ts`) so the existing `getCorrectionStatuses` (event-target only, `subject_kind='event'` filter) is untouched.

### Schema shape

```ts
export const CorrectArtifactEvent = z.object({
  actor_kind: z.literal('user'),
  actor_ref: z.literal('self'),
  action: z.literal('correct'),
  subject_kind: z.literal('artifact'),
  subject_id: z.string(),  // artifact_id
  outcome: z.literal('success'),
  payload: z.object({
    correction_kind: CorrectionKind,
    section_id: z.string().optional(),    // NoteSection.id; omitted = whole-artifact
    reason_md: z.string().min(1).max(2000),
    replacement_artifact_id: z.string().optional(),
  }),
  ...baseOptionalFields,
}).superRefine(/* supersede ↔ replacement_artifact_id invariant */);
```

### Invariants

1. **`section_id` is `NoteSection.id`, never an array index.** Section ids are stable across in-place edits ([YUK-54](https://linear.app/yukoval-studios/issue/YUK-54)) and across `NoteRefineTask` revisions ([YUK-87](https://linear.app/yukoval-studios/issue/YUK-87), pending). Reordering does not reissue ids. Whatever process mutates atomic `sections[]` MUST preserve `id`.
2. **Whole-artifact and per-section state compose independently.** A `whole` `retract` does not silently mask `mark_wrong` per-section history; UI / `NoteRefineTask` can read either. `ArtifactCorrectionState` exposes both shapes.
3. **`CorrectionKind` enum is unchanged.** `mark_wrong`, `retract`, `restore`, `supersede` semantics carry over verbatim. `restore` returns to active.
4. **Composition is latest-applicable-event-wins.** Events are read in `(created_at, id)` order; the last non-restore event wins per `(artifact_id, section_id?)` key. `restore` returns to active. No supersede-chain walking (which is event-only via `effective-truth.ts`); artifact supersede is a terminal redirect to a `replacement_artifact_id`.
5. **`affected_refs` is dropped on artifact corrections.** Artifacts have no natural `ActivityRef`. The original `CorrectEvent.payload.affected_refs.min(1)` requirement stays on event-target corrections; the new artifact path does not carry that field.
6. **`actor_kind / actor_ref` locked to user / self.** Agents do not issue artifact corrections in this phase. If a future Dreaming lane proposes an artifact retraction, it goes through `AiProposalPayload` ([YUK-44](https://linear.app/yukoval-studios/issue/YUK-44)) and produces a `RateEvent`, not a `CorrectArtifactEvent` directly.

### Projection contract

Sibling module `src/server/events/artifact-corrections.ts` exposes:

```ts
export type ArtifactCorrectionStatus =
  | { state: 'active';       correction_event_id: null;    replacement_artifact_id: null }
  | { state: 'retracted';    correction_event_id: string;  replacement_artifact_id: null }
  | { state: 'marked_wrong'; correction_event_id: string;  replacement_artifact_id: null }
  | { state: 'superseded';   correction_event_id: string;  replacement_artifact_id: string };

export interface ArtifactCorrectionState {
  whole: ArtifactCorrectionStatus;
  sections: Map<string, ArtifactCorrectionStatus>;
}

export function getArtifactCorrectionState(db, artifactId): Promise<ArtifactCorrectionState>;
export function getArtifactCorrectionStates(db, artifactIds): Promise<Map<string, ArtifactCorrectionState>>;
```

UI ([CorrectionStateRenderer](../../src/ui/correction/CorrectionStateRenderer.tsx)) reuse: the existing renderer consumes `CorrectionStateSnapshot` (event-snapshot shape with `effective_event_id`). Section-state rendering will either (a) adapt the renderer to accept a more abstract snapshot, or (b) introduce `<SectionCorrectionBadge>` reusing the same `Badge` primitive + tone table. Decision deferred to Sub 3 of [YUK-85](https://linear.app/yukoval-studios/issue/YUK-85); both options keep visual consistency.

## Consequences

### Positive

- [YUK-87](https://linear.app/yukoval-studios/issue/YUK-87) Living Note `NoteRefineTask` gains a sixth signal channel: "user marked this section wrong" reads directly from `getArtifactCorrectionState(...).sections.get(sectionId)`. No proposal-inbox round trip.
- Event-target correction path (existing `/api/events/[id]/correct` + `getCorrectionStatuses`) is untouched — no regression risk for [YUK-40](https://linear.app/yukoval-studios/issue/YUK-40) shipped surface.
- `CorrectionKind` enum reuse means `effective-truth` UI semantics stay consistent across event and artifact targets.
- Future extension to other artifact kinds (quiz, variant, summary) requires zero schema change — `subject_id` is opaque, `section_id` is optional. New artifact kinds just publish their own correction events.

### Negative / costs

- Two parallel correction projection modules (`corrections.ts` and `artifact-corrections.ts`). Acceptable: they share the `CorrectionKind` enum and have parallel shapes but compose different subject types. Merging would force a generic key type that obscures intent.
- `replacement_artifact_id` vs `replacement_event_id` field rename adds nominal complexity for callers that handle both. Callers should narrow by `subject_kind` early; no shared composer.
- UI `CorrectionStateRenderer` may need a thin adapter or a sibling component (`<SectionCorrectionBadge>`). The visual contract (tone table, label map) is shared, so design drift risk is low.

### Migration

No DB migration required: `event.payload` is `jsonb`, `event.subject_kind` already accepts any string at the column level. The constraint is enforced at the zod boundary only.

`audit:schema` is unaffected — the new schema does not touch `src/db/schema.ts` columns.

## Alternatives considered

### Path B — `experimental:note_appeal` event channel

**Rejected.** Path B would write `action='experimental:note_appeal'` events that do not feed `getCorrectionStatuses` / `getArtifactCorrectionStates`. Pros: zero ADR cost, lighter schema. Cons: bypasses ADR-0014 §6 correction-state projection; `mark_wrong` semantics (which should *prevent* downstream consumption of the section in review queues, FSRS, NoteRefine triggers) cannot be enforced without parallel projection logic everywhere. `appeal` is also a weaker term — semantically "please re-judge" rather than "this is wrong, suppress it".

### Path C — atomic-level only, no `section_id`

**Rejected.** Path C keeps `correction_kind` semantics intact at artifact granularity but loses section addressability. [YUK-87](https://linear.app/yukoval-studios/issue/YUK-87) NoteRefine trigger 1 ("`pitfall` section has ≥ 2 fresh mistakes → propose section update") needs per-section state; if a user marks `pitfall` wrong, the trigger should target *that section's* refine, not regenerate the whole atomic. Path C forces over-coarse refines.

### Widen `CorrectEvent.subject_kind` to `z.enum(['event', 'artifact'])`

**Rejected.** Would force `affected_refs.min(1)` and `replacement_event_id` to be relaxed to `optional` and conditional on `subject_kind`. The superRefine surface doubles in size, and the event-target path silently loses its non-empty invariant for half its lifetime. Parallel schemas keep both paths' invariants strong.

## Implementation references

- Schema: [`src/core/schema/event/known.ts`](../../src/core/schema/event/known.ts) — `CorrectArtifactEvent` and `KnownEvent` union
- Projection: [`src/server/events/artifact-corrections.ts`](../../src/server/events/artifact-corrections.ts)
- Tests: `tests/schema/event.test.ts` (zod), `src/server/events/artifact-corrections.test.ts` (projection)
- Phase outline: [`docs/superpowers/plans/2026-05-26-track-1-followup-phase.md`](../superpowers/plans/2026-05-26-track-1-followup-phase.md) W1.3
- Per-lane plan: [`docs/superpowers/plans/2026-05-26-note-appeal-mark-wrong.md`](../superpowers/plans/2026-05-26-note-appeal-mark-wrong.md)
- API route (Sub 2): `app/api/artifacts/[id]/correct/route.ts` (not in Sub 1)
- UI integration (Sub 3): `NoteRenderer` / `learning-items/[id]/page.tsx` (not in Sub 1; separate design-doc pre-flight)

> **M5 路径注（YUK-321，2026-06-13）**：本文提及的 `app/api/**` Next route 路径已随旧栈拆除迁移至 capability manifests（`src/capabilities/*/manifest.ts` + 各包 `api/*.ts`），由组合根 `server/app.ts` 挂载；决策本身不受影响。
