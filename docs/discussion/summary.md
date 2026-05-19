# Discussion Summary: Generalization Review (2026-05-18)

> 6 rounds of cross-agent dialogue (Claude Code + Codex + Human) on framework generalization.
> This document is the authoritative summary of all decisions reached.

## Background

The Learning Project is a single-user, AI-driven learning tool. Phase 1 shipped with a classical Chinese (wenyan) focus: question ingestion → attempt → judge → attribution → variant → FSRS review. The codebase has a Next.js 15 App Router frontend, Postgres + Drizzle backend, event-driven core (ADR-0006 v2), and Claude Agent SDK for AI tasks.

The human owner asked for a comprehensive audit and forward-looking design review: does the framework generalize to multiple subjects and learning modes? What's missing?

## Audit Results

### Drift: ADR ↔ Code

ADR layer appears structurally aligned with code; no blocking drift was found in the reviewed ADRs. File count / numbering should be verified before citing exact totals (Codex R7 correction: ADR-0009 may be a numbering gap). Module-level documentation (`docs/modules/`) has a 4-8 week lag — Phase 2 features described as decided are actually exploratory. Recommendation: add "Current Status (as of date)" annotations to each module doc.

### Test Coverage

Strong: AI task execution, handler pipeline, orchestrators, knowledge mutations, FSRS scheduling, event writing, subject profiles.

Gaps: `providers.ts` (AI routing) zero tests, SSE streaming untested, UI components near-zero coverage, multi-subject cross-scenarios untested.

### Data Model Generalizability

Schema-level: **fully generic.** Zero wenyan-specific columns. All subject coupling is in business logic (Phase 1a root-creation guards), AI task prompts, subject profiles, seed data, and frontend rendering. Cost to add a new subject at schema level: zero changes.

### Frontend Subject Context

Backend SubjectProfile abstraction is solid. Frontend has near-zero active subject awareness: font hardcoded to wenyan serif, metadata references classical Chinese, API calls don't pass subject parameter, question kinds not filtered by subject. The frontend can display domain labels but cannot adapt behavior.

## Architectural Decisions Reached

### 1. Unified Activity Model (not dual loop)

The framework's core abstraction is `LearningActivity`, not `question`. Questions are one activity kind. Other kinds include `question_part`, `record`, `recall_prompt`, `practice_log`, `project_milestone`, `open_inquiry`.

All activity kinds share:
- One event pipeline (the existing event table)
- One knowledge graph (tree + mesh)
- One scheduling orchestration surface (`ActivityQueueItem[]`)
- One identity system (`ActivityRef { kind, id }`)

Per-kind behavior (assessment strategy, scheduling policy, rendering) is driven by capability dispatch, not framework branching.

Implementation approach: question-only adapter first, but new interfaces accept `ActivityRef`, not `question_id`. C tempo, B interfaces.

**Why not dual loop**: two independent loops create pressure toward question-as-first-class and records-as-second-class. Each new activity type would spawn another loop. Cross-activity coordination becomes an integration problem between schedulers. The dual-loop model is easy to start and expensive to finish — the same retrofit risk that "B interfaces" is meant to prevent.

### 2. Capability Registry

The framework does not understand any subject. It provides extension points; subject-specific behavior is implemented as registered capabilities.

```
SubjectProfile (declaration — pure data, ~50 lines per subject)
  ├─ judgeCapabilities / judgeRoutes → which assessment abilities this subject uses
  ├─ causeCategories                 → subject's own attribution taxonomy
  ├─ renderConfig                    → font, notation, code highlighting
  ├─ schedulingHints                 → default scheduling policy
  └─ promptFragments                → AI prompt customization

Capability Registries (implementation — shared across subjects)
  ├─ JudgeRegistry:     { exact, keyword, semantic, steps, symbolic, external, rubric, ... }
  ├─ RendererRegistry:  { katex, codeHighlight, chemSymbol, ... }
  └─ SchedulerRegistry: { fsrs, cadence, deadline, none_evidence_only, ... }
```

Core rule: **capabilities are cross-subject, not subject-owned.** `semantic` judge serves wenyan translation, English writing, and CPA case analysis. `katex` renderer serves math, physics, and chemistry. Each capability built makes every future subject cheaper.

Adding a subject = write a SubjectProfile (data). If the subject needs a capability not yet in the registry, implement it once — it's immediately available to all subjects.

Capabilities have manifests with version, input/output schema, cost class, latency class, stability level, and dependencies. Profiles declare compatibility ranges; events persist exact resolved versions. This ensures historical results remain explainable after capability upgrades.

Capabilities may compose into pipelines (e.g., physics numeric answer: expression_parse → unit_dimension → numeric_tolerance) declared in the profile, not hardcoded in framework router logic.

### 3. Attribution Fully Profile-Driven

Each SubjectProfile defines its own complete cause taxonomy. No universal base enum exists at runtime.

For authoring convenience, reusable category packs can be imported at build time (e.g., `science_common` pack with `unit_error`, `model_selection`). But the resulting profile taxonomy is fully materialized — runtime events store `(profile_id, profile_version, cause_category_id)` with no dependency on pack resolution.

Cross-subject analytics use explicit mapping tables (e.g., physics `unit_error` → axis `error_mode` = `unit_or_dimension`), not implicit shared categories.

### 4. JudgeResult with Continuous Score

All judge capabilities return a unified result:

```ts
interface JudgeResult {
  score: number;           // 0-1, required
  score_meaning: string;   // 'correctness' | 'mastery_estimate' | 'rubric_weighted' | 'external_verdict'
  coarse_outcome: string;  // 'success' | 'partial' | 'failure' | 'unsupported'
  confidence: number;
  capability_ref: { id: string; version: string };
  evidence: unknown;
}
```

Scores from different capabilities are not assumed to be calibrated. Scheduling policies interpret scores according to their own logic (FSRS maps score to rating; practice cadence uses score trend; records may ignore score entirely).

### 5. External Judge for Programming (and beyond)

Programming subjects use OJ systems for judgment. The framework consumes external results via `external_judge` capability — it does not build a sandbox. This pattern extends to any domain with existing external grading (oral exams, certification test platforms, etc.).

`external_judge` is not zero-code — it needs evidence provenance, trust level, identity matching, and async status handling. But it avoids rebuilding solved infrastructure.

### 6. question_part as ActivityKind

Multi-part questions (English reading passages, physics multi-step, math multi-part) use `question_part`: parent question stores shared stem/passage/figures/provenance; parts are answerable leaves with independent `knowledge_ids`, judge routes, rubrics, and FSRS state.

### 7. Correction Event

A first-class correction event replaces the current `RateEvent(rating='rollback')` pattern:

```ts
interface CorrectEventPayload {
  correction_kind: 'supersede' | 'retract' | 'mark_wrong' | 'restore';
  replacement_event_id?: string;
  reason_md: string;
  affected_refs: Array<{ kind: string; id: string }>;
}
```

The event log remains append-only and immutable. Projections consult correction events to determine active truth. Rate events remain user feedback records, not semantic undo.

### 8. Scheduling: Unified Queue, Multiple Policies

FSRS is one scheduling policy, not the universal scheduler. The framework defines a `SchedulingPolicy` interface; profiles declare which policy to use.

Initial policies:
- `fsrs_question`: current question review behavior
- `none_evidence_only`: records feed AI/proposals but do not enter the review queue
- Future: `record_recall`, `practice_cadence`, `milestone_review`

The orchestrator produces one unified queue (`ActivityQueueItem[]`). In the first implementation it returns only question items — that's C tempo. The response shape already accommodates all activity kinds — that's B interface.

### 9. TS Framework + External Capabilities

ADR-0001 (TypeScript monolith + Python sidecar escape hatch) stands. The framework stays TS. Capability registry naturally supports external providers in any language — a Python sidecar is just another capability with `cost_class: 'external'`. No current capability requires non-TS implementation; `symbolic` and `unit_dimension` may eventually use Python (SymPy, Pint) when they reach priority.

### 10. renderConfig in SubjectProfile

Rendering is profile-driven: font family, notation system (KaTeX, music notation), code highlighting language, layout preferences. One generic `<SubjectContent>` component reads config and dispatches to registered renderer capabilities. No per-subject components.

## Implementation Priority

Build capabilities that unlock multiple subjects at once:

| Phase | Items | Unlocks |
|-------|-------|---------|
| **N+1** | Capability registry foundation (manifests, refs, **profile validator**); JudgeResult v2 with score + score_meaning; register existing exact/keyword; SubjectProfile.causeCategories as profile-driven; SubjectProfile.renderConfig; subject identity normalization; frontend minimal per-item render adapter | Framework extensibility proof; wenyan + math correctness |
| **N+2** | `semantic` judge capability; `external_judge` capability (manual import); `question_part` ActivityKind; `katex` renderer; record-to-proposal evidence loop; **correction event (minimal: supersede/retract/mark_wrong/restore)**; remaining SubjectProfile coverage for all AI tasks | English, programming, physics, CPA subjects unblocked; event correction before more AI evidence accumulates |
| **N+3** | `steps` judge; cross-subject scheduling v1 (deterministic quotas); `symbolic` judge (if needed, Python sidecar) | Math proofs, physics derivations, multi-subject parallel study |

Each phase is independently shippable. Each capability built compounds the framework's value.

## Participants

- **Claude Code**: initial audit, scenario brainstorming, Direction C proposal, capability registry model
- **Codex**: ADR verification, Unified Activity advocacy, capability manifest/versioning/composition hardening, materialized cause packs, scheduling policy architecture
- **Human**: "C tempo, B interfaces" directive; fully profile-driven attribution; renderConfig from day one; scope to academic + programming (no music/sports); external judge for programming (OJ); TS-only confirmation

## Files

## Codex Final Corrections (Round 7, incorporated)

1. ADR count wording softened — verified ADRs show no drift; exact file count to be confirmed
2. Correction event moved from N+3 to N+2 — needed before semantic/external judge evidence accumulates
3. Profile validator included in N+1 — registry without validation is just a naming convention
4. "Pure data" clarified — authoring-time helpers (materialized packs, route templates) are fine; runtime profile must be fully expanded with no dynamic inheritance

## Files

| File | Content |
|------|---------|
| `round-1-claude.md` | Full audit + 10 scenarios + 3 directions + 5 open questions |
| `round-2-codex.md` | Agreement/disagreement + open question answers + 6 blind spots |
| `round-3-claude.md` | Convergence + Human directive + revised implementation plan |
| `round-4-codex.md` | Unified Activity > dual loop + SchedulingPolicy + question_part + correction event |
| `round-5-claude-human.md` | Capability Registry model + subject examples |
| `round-6-codex.md` | Registry hardening: manifests, versioning, pipeline composition, materialized packs |
| `round-7-codex.md` | Final corrections: ADR wording, correction event timing, validation requirement |
| `summary.md` | This file |
