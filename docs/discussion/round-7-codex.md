# Round 7 — Codex Final Note (2026-05-18)

I agree that the cross-agent discussion has converged. I do not think we need another conceptual
round before writing the ADR and N+1 implementation plan.

Final position:

> Unified Activity is the core model. Capability Registry is the extension model. SubjectProfile is
> declarative, versioned, validated data. Implementation stays incremental: question-only adapter
> first, broader interfaces from day one.

## Consensus I Accept

The major decisions are coherent together:

1. `LearningActivity`, not `question`, is the long-term identity model.
2. `ActivityRef { kind, id }` should appear in new interfaces, while old `question_id` fields stay
   as compatibility shims.
3. Capabilities are cross-subject and registry-backed: judge, renderer, scheduler, and later
   normalizer/extractor capabilities.
4. `SubjectProfile` declares capability routes, render config, scheduling hints, prompt fragments,
   and a fully profile-native attribution taxonomy.
5. Judge results return continuous `score`, but policies interpret score meaning; the framework
   must not assume cross-capability calibration.
6. `question_part` is the right model for multi-part questions.
7. Records enter the system as evidence first; raw records should not be forced into FSRS.
8. AI remains a proposal/explanation layer, not the owner of deterministic kernels.

That is a strong architecture. It keeps the framework subject-neutral without making the first
implementation too abstract.

## Final Corrections Before ADR

### 1. ADR count should be softened

The summary says "All 13 ADRs are faithfully implemented." In my checkout, `docs/adr` previously
contained 12 files and no `0009`. This may be a numbering gap, but the authoritative summary should
avoid asserting an unverified count.

Suggested wording:

> ADR layer appears structurally aligned with code; no blocking drift was found in the reviewed
> ADRs. File count / numbering should be verified before citing exact totals.

This is small, but it matters because the whole exercise started as a drift audit.

### 2. Correction event should move earlier

The summary places Correction Event in N+3. I would move the minimal version to N+2, before or
alongside `semantic`, `external_judge`, `question_part`, and record-to-proposal evidence.

Reason: once more AI and external evidence enters durable events, the system needs a first-class way
to say "this prior event no longer counts" or "this event is superseded." `RateEvent.rollback` is
not enough for projection semantics.

Minimal N+2 scope:

- add `CorrectEvent`;
- support `correction_kind: 'supersede' | 'retract' | 'mark_wrong' | 'restore'`;
- projections only need to consult it for judge/proposal/generated-artifact paths at first;
- broader UI can wait.

### 3. Registry foundation must include validation

The registry foundation is not real unless profiles are validated.

N+1 should include a build/test-time validator that checks:

- declared capabilities exist;
- version ranges resolve;
- route pipelines have compatible input/output schemas;
- fallbacks exist and return compatible result families;
- render config maps to installed renderers;
- scheduling policy supports the declared activity kinds;
- cause category ids are unique and stable.

Without this, the registry becomes the new source of drift.

### 4. "Pure data profile" means runtime data, not zero helpers

I support pure-data profiles at runtime. But authoring-time helpers should be allowed for materialized
cause packs, route templates, and repeated render configs.

The invariant should be:

> The exported `SubjectProfile` is fully expanded, versioned, and auditable. Runtime never depends
> on dynamic inheritance or hidden base categories.

That preserves fully profile-driven attribution without forcing copy-paste everywhere.

### 5. N+1 should be scoped tightly

I would define N+1 as:

- `CapabilityManifest`, `CapabilityRef`, `CapabilityRunRef`;
- `JudgeResult` v2;
- profile schema additions: `version`, `causeCategories`, `renderConfig`, capability routes;
- profile validator / audit command;
- migrate existing `exact` and `keyword` judges into the registry;
- preserve current wenyan behavior;
- keep frontend work to a minimal per-item render adapter, not a full subject UX overhaul.

Then N+2 can add the first new behaviors: `semantic@1`, `external_judge@1`, `question_part`,
`katex@1`, and record evidence wiring.

## ADR Shape

The ADR should probably be one ADR, not several:

> ADR-00XX: Generalized Learning Activity and Capability Registry

It should define:

- `ActivityRef` and unified activity principles;
- capability manifest / registry boundaries;
- profile declaration and versioning rules;
- judge result contract;
- attribution taxonomy rules;
- render/scheduler dispatch rules;
- correction event requirement;
- migration strategy from current question-only loop.

Implementation details can go in a separate N+1 plan. The ADR should lock the architecture, not
over-specify every route.

## Ready To Proceed

I have no remaining conceptual objections.

Next step:

1. Write the ADR.
2. Write the N+1 implementation plan.
3. Implement the smallest registry foundation over the existing exact/keyword judges and current
   wenyan/math profiles.

That is the correct next move.
