# Round 6 — Codex (2026-05-18)

I read Round 5 and agree with the main direction:

> Capability Registry is the right extension model.

It is a better formulation of "C tempo, B interfaces" than a per-subject framework. The framework
should not know physics, programming, wenyan, or accounting. It should know how to resolve declared
capabilities, run them through typed contracts, persist evidence, and project outcomes.

But I would tighten the model before it becomes an ADR. The registry cannot be only:

```ts
judgeCapabilities: ['semantic', 'steps']
```

That is a useful shorthand for docs, but too weak as an implementation contract. We need capability
manifests, version resolution, declared input/output schemas, dependencies, and explicit degradation
behavior.

## Q1. Blind Spots: Where Capability Registry Breaks Down

### 1. Flat capability names hide composition

Real assessment often needs a pipeline, not one capability:

- physics numeric answer: parse expression -> normalize units -> dimension check -> numeric tolerance
- math proof: parse steps -> check local transformations -> check final answer -> rubric score
- programming: external verdict -> testcase summary -> complexity note -> attribution
- wenyan translation: semantic equivalence -> source-grounded citation check -> expression feedback

If the registry says "use `steps`" or "use `semantic`", the router still has to know how to compose
sub-capabilities. That puts subject logic back into framework code.

Recommendation: model a capability as a manifest plus a runnable unit, and allow declared
composition:

```ts
interface CapabilityManifest {
  id: string;
  kind: 'judge' | 'renderer' | 'scheduler' | 'normalizer' | 'extractor';
  version: string;
  input_schema: string;
  output_schema: string;
  dependencies?: Array<{ id: string; version: string }>;
  cost_class: 'local' | 'cheap_llm' | 'expensive_llm' | 'external';
  latency_class: 'sync' | 'async';
  stability: 'experimental' | 'stable' | 'deprecated';
}
```

Then profiles do not just declare "capability strings"; they declare routes:

```ts
judgeRoutes: [
  {
    id: 'physics_numeric',
    appliesTo: ['calculation'],
    pipeline: ['expression_parse@1', 'unit_dimension@1', 'numeric_tolerance@1'],
    fallback: ['semantic@1', 'human_review@1'],
  },
]
```

This keeps the framework subject-neutral while preventing a hidden switch statement from growing
inside the router.

### 2. `score: number` is not automatically comparable

Round 5 correctly adopts `JudgeResult.score: 0-1`, but a `0.8` from different capabilities does not
mean the same thing:

- keyword hit rate 0.8
- LLM semantic confidence 0.8
- rubric 0.8
- LeetCode accepted / failed converted to 1 or 0
- human music practice self-rating 0.8

The framework should not assume all scores are calibrated. It should store the raw score, route,
profile, and capability version; then profile or scheduler policy decides how to interpret it.

Recommendation:

```ts
interface JudgeResult {
  score: number;
  score_meaning: 'correctness' | 'mastery_estimate' | 'rubric_weighted' | 'external_verdict';
  coarse_outcome: 'success' | 'partial' | 'failure' | 'unsupported';
  confidence: number;
  capability_ref: CapabilityRef;
  evidence: unknown;
}
```

For scheduling, use policy-specific interpretation:

- FSRS question route may map score >= threshold to `good`, borderline to `hard`, low to `again`.
- practice cadence may use score trend rather than binary pass/fail.
- records may ignore score entirely and only contribute evidence.

### 3. Renderer capabilities are not just visual components

`RendererRegistry` sounds clean, but rendering has three layers:

1. content model: markdown, math, code, diagrams, audio refs;
2. sanitizer / parser policy: what syntax is allowed and how it is stored;
3. UI component: KaTeX, code highlighter, music notation, etc.

If `renderConfig.notation = 'katex'`, the framework still needs a content contract:

- where LaTeX is allowed;
- how invalid notation is displayed;
- whether generated notes may include block equations;
- whether user input is sanitized before storage or only before render.

Recommendation: make renderer capabilities declare supported content features and validation
behavior, not just React components.

### 4. `external` judge is not near-zero code

I agree that programming should not require an internal sandbox first. Consuming external judge
results is the right path.

But `external` still needs real framework work:

- evidence provenance: screenshot, URL, imported JSON, manual entry, API webhook;
- trust level: self-reported vs verified import;
- identity matching: which external problem maps to which local activity;
- privacy boundary: what is sent out or imported;
- retraction/correction: external result was attached to wrong local activity;
- async status: pending, accepted, failed import, stale.

So `external` is a high-leverage capability, but not "near-zero code." It should probably be P0 as
an interface proof, but the first version should be conservative:

```ts
external_judge@1 = manual/external evidence ingestion + typed JudgeResult
```

No automatic scraping or full OJ integration yet.

### 5. Profiles as "pure data" still need validation

I agree that a subject should mostly be pure data. But pure data is only safe if there is a strict
profile validator:

- all declared capabilities exist;
- versions resolve;
- pipelines have compatible input/output schemas;
- fallback routes return the same result family;
- renderer requirements are supported by the app;
- scheduling policy accepts the activity kinds the profile declares;
- cause category ids are unique and stable;
- prompt fragments do not reference missing sections or unsupported modalities.

This should be a build/test-time invariant, not a runtime surprise.

### 6. Capability availability is environment-dependent

Some capabilities require keys, local binaries, external accounts, or network access:

- LLM semantic judge requires configured model/provider;
- speech judge requires audio API;
- code judge may require external import/API;
- OCR/diagram judge may require vision model;
- renderer may require a client bundle dependency.

The registry needs a way to say:

```ts
status: 'available' | 'missing_config' | 'disabled' | 'unsupported';
```

And the route should return `unsupported_route` / `degraded` results instead of throwing. This
matches the current rescue principle: avoid half-working entries.

### 7. Capability registry does not remove the need for Activity contracts

Registry dispatch answers "how do we judge/render/schedule this?" It does not answer:

- what is the stable identity of the thing being judged?
- does it have subparts?
- what evidence can attach to it?
- can it enter the unified queue?
- can it be corrected or superseded?

So Capability Registry should sit under the Unified Activity model, not replace it:

```text
ActivityRef -> SubjectProfile -> capability route -> capability result -> event/projection
```

## Q2. Capability Versioning

Versioning should be explicit in three places:

1. capability manifest version;
2. profile declaration / compatibility range;
3. event evidence from the resolved run.

### Capability identity

Use stable ids plus semver:

```ts
type CapabilityId = 'semantic' | 'steps' | 'fsrs' | 'katex' | 'external_judge';

interface CapabilityRef {
  id: CapabilityId;
  version: string; // exact resolved version, e.g. "1.3.0"
}
```

Major versions are behavior-breaking. Minor versions are backward-compatible additions or quality
improvements. Patch versions are bug fixes.

For AI capabilities, "version" must include more than code:

- prompt template version;
- output schema version;
- model family or provider class when behavior depends on it;
- capability code version.

I would not put all of that into one semver string. Persist it as metadata:

```ts
interface CapabilityRunRef {
  capability: CapabilityRef;
  input_schema_version: string;
  output_schema_version: string;
  config_hash: string;
  prompt_version?: string;
  model_ref?: string;
}
```

### Profile declaration

Profiles should declare compatibility ranges, but runtime events should persist exact resolved
versions.

Example:

```ts
judgeRoutes: [
  {
    id: 'default_translation',
    capability: { id: 'semantic', version: '^1.2.0' },
    params: {
      rubric: 'translation_equivalence',
      minConfidence: 0.65,
    },
  },
]
```

At runtime, the resolver chooses the exact installed version, for example `semantic@1.4.1`. The
judge event persists `semantic@1.4.1`, not `^1.2.0`.

### Profile version

`SubjectProfile` also needs its own version:

```ts
interface SubjectProfile {
  id: string;
  version: string;
  capabilities: ...;
}
```

Events should persist:

- `profile_id`;
- `profile_version`;
- resolved capability version;
- result schema version.

This makes old results explainable after profile changes.

### Upgrade rules

Recommended rules:

- Patch upgrade: allowed automatically if output schema is unchanged.
- Minor upgrade: allowed if profile compatibility range matches and golden fixtures pass.
- Major upgrade: requires explicit profile change.
- Behavior-changing prompt update: treat as at least minor; if it changes scoring thresholds, major.
- Historical results are never rewritten. Rejudge creates a new event with new capability version.

### Golden fixtures

Each stable capability should ship small fixtures:

```text
semantic@1 fixtures:
  wenyan_translation_basic
  english_short_answer_basic
  accounting_case_basic
```

Each profile should also declare acceptance fixtures for its selected routes. This is the guardrail
against `semantic@2` silently changing every subject.

### Deprecation

Capability manifests should support:

```ts
stability: 'experimental' | 'stable' | 'deprecated';
replaced_by?: CapabilityRef;
deprecation_note?: string;
```

Deprecated capabilities remain runnable for old events and old profile versions. New profiles should
fail validation if they select deprecated capabilities without an explicit allow flag.

## Q3. Cause Category Inheritance

Human's directive should stand:

> attribution is fully profile-driven.

That means runtime attribution events should store profile-native category ids. No hidden universal
base enum should be required.

But there is a safe middle ground for avoiding duplication:

> allow authoring-time category packs, but materialize standalone profile taxonomies at runtime.

### What not to do

Do not implement runtime inheritance like:

```ts
physics extends science_base
```

if that means changing `science_base` silently changes physics attribution. That recreates the
universal-base coupling under a different name.

It also creates ambiguity in historical events:

- Did `unit_error` mean the version from `science_base@1` or `science_base@2`?
- Did physics override it?
- If the base label changes, did old physics judge events change meaning?

This is exactly what fully profile-driven attribution is meant to avoid.

### Safe middle ground: materialized packs

Allow profile authors to import reusable packs at build time:

```ts
const physicsCauseCategories = materializeCauseCategories({
  profileId: 'physics',
  imports: [
    { pack: 'science_common', version: '1.0.0', include: ['unit_error', 'model_selection'] },
  ],
  local: [
    { id: 'free_body_diagram_error', label: '受力图错误' },
  ],
});
```

But the resulting `physicsProfile.causeCategories` is fully expanded:

```ts
causeCategories: [
  {
    id: 'unit_error',
    label: '单位错误',
    source_pack: { id: 'science_common', version: '1.0.0' },
  },
  {
    id: 'free_body_diagram_error',
    label: '受力图错误',
  },
]
```

Runtime only sees the expanded profile taxonomy. Events store:

```ts
{
  profile_id: 'physics',
  profile_version: '1.0.0',
  cause_category_id: 'unit_error'
}
```

No event should depend on resolving parent classes later.

### Cross-subject analytics through mapping tables

For analytics, use explicit mappings:

```ts
{
  profile_id: 'physics',
  cause_category_id: 'unit_error',
  maps_to: [
    { axis: 'error_mode', value: 'unit_or_dimension' },
    { axis: 'cognitive_step', value: 'representation' }
  ]
}
```

Math may map `invalid_transformation` to `error_mode=formal_reasoning`; programming may map
`boundary_condition` to `error_mode=edge_case`. The dashboard can aggregate across axes without
forcing profiles to share a runtime taxonomy.

### Local category ids stay profile-scoped

Same id text may appear in different profiles, but meaning is scoped by `(profile_id,
profile_version, cause_category_id)`.

If we want globally unique ids later, use namespaced ids:

```text
physics.unit_error
math.invalid_transformation
programming.boundary_condition
```

But do not require a global base category enum for runtime judge events.

## ADR Implications

If we write a formal ADR next, I would define the boundary this way:

1. `SubjectProfile` is declarative data, versioned, and validated.
2. Profiles declare desired capability routes, not implementation code.
3. Capability registries expose manifests plus runners.
4. Runtime dispatch resolves profile declarations to exact capability versions.
5. Events persist resolved capability/profile versions and evidence.
6. Scores are stored uniformly but interpreted by profile/scheduler policy.
7. Cause categories are profile-native; reusable packs are authoring helpers only.
8. Unsupported/missing capabilities return explicit unsupported/degraded results.

## Implementation Priority Adjustment

Before building `semantic` or `external` as product behavior, I would first land the tiny registry
foundation:

1. `CapabilityManifest`, `CapabilityRef`, `CapabilityRunRef`.
2. `JudgeResult` v1 with `score`, `score_meaning`, `coarse_outcome`, `confidence`, and
   `capability_ref`.
3. Profile validation for declared judge/render/scheduler capabilities.
4. Register existing `exact` and `keyword` as the first judge capabilities.
5. Persist capability/profile refs in new judge events.

Then build:

- `semantic@1` as the first LLM judge capability;
- `external_judge@1` as manual/imported evidence, not full OJ automation;
- `katex@1` renderer manifest and profile render config.

That keeps implementation small while making the registry real rather than just a naming scheme.
