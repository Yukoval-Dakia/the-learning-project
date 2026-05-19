# Round 5 — Claude Code + Human (2026-05-18)

This round crystallizes the extensibility model that emerged from Rounds 1-4 + human direction.

## Key Insight: Capability Registry, Not Per-Subject Code

Round 1-2 identified real per-subject differences (judge routes, attribution, rendering). The trap is hardcoding them. The solution: **differences are registerable capabilities; SubjectProfile declares which ones to use.**

```
SubjectProfile (declaration — pure data, ~50 lines per subject)
  ├─ judgeCapabilities    → which judge abilities this subject uses
  ├─ causeCategories      → subject's own attribution taxonomy (fully profile-driven)
  ├─ renderConfig         → font, notation system, code highlighting
  ├─ schedulingHints      → default scheduling policy
  └─ promptFragments      → AI prompt customization

Capability Registries (implementation — shared across subjects)
  ├─ JudgeRegistry:     { exact, keyword, semantic, steps, symbolic, external, rubric }
  ├─ RendererRegistry:  { katex, codeHighlight, chemSymbol, musicNotation, ... }
  └─ SchedulerRegistry: { fsrs, cadence, deadline, none_evidence_only }
```

Core rule: **capabilities are cross-subject, not subject-owned.**

- `semantic` judge: wenyan translation, English writing, history analysis
- `katex` renderer: math, physics, chemistry
- `steps` judge: math proofs, physics derivations, chemistry balancing
- `external` judge: programming (OJ), oral exams (speech API), any external grading system
- `exact` judge: multiple choice across all subjects

Adding a subject = write a SubjectProfile (data). If the subject needs a capability that doesn't exist yet, implement it once in the registry — it's immediately available to all other subjects.

## Framework Boundary

The framework does NOT understand any subject. It provides:

1. **Event pipeline** — records all learning activity (Unified Activity model from Round 4)
2. **Knowledge graph** — tree + mesh, subject-agnostic topology
3. **Capability dispatch** — routes to registered judge/renderer/scheduler based on profile declaration
4. **AI proposal layer** — AI operates on events and knowledge graph, uses profile for prompt context
5. **Scheduling orchestration** — unified queue, policy selected by profile

The framework DOES NOT:

- Judge answers itself (it dispatches to a registered judge capability)
- Know what KaTeX is (it dispatches to a registered renderer)
- Define attribution categories (it reads them from profile)
- Assume FSRS is the only scheduling algorithm (it's one registered policy)

## Concrete Examples

### Adding Physics (zero new code if math already shipped steps + katex)

```typescript
// src/subjects/physics/profile.ts
export const physicsProfile: SubjectProfile = {
  id: 'physics',
  displayName: '物理',
  judgeCapabilities: ['exact', 'steps', 'semantic', 'unit_dimension'],
  causeCategories: [
    { id: 'model_selection', label: '模型选择错误' },
    { id: 'unit_error', label: '单位错误' },
    { id: 'approximation', label: '近似处理不当' },
    // ...profile owns the full taxonomy
  ],
  renderConfig: {
    fontFamily: 'system',
    notation: 'katex',        // reuse math's KaTeX capability
    codeHighlight: null,
  },
  promptFragments: {
    roleNoun: '物理学习',
    teachingStyle: '先建立物理直觉，再用公式推导验证',
  },
}
```

### Adding Programming (external judge, no sandbox needed)

```typescript
export const programmingProfile: SubjectProfile = {
  id: 'programming',
  displayName: '编程',
  judgeCapabilities: ['external'],  // OJ judges, framework just consumes results
  causeCategories: [
    { id: 'boundary_condition', label: '边界条件' },
    { id: 'algorithm_choice', label: '算法选择' },
    { id: 'time_complexity', label: '时间复杂度' },
    { id: 'edge_case', label: '特殊输入' },
  ],
  renderConfig: {
    fontFamily: 'monospace',
    notation: null,
    codeHighlight: 'typescript',
  },
  promptFragments: {
    roleNoun: '编程学习',
    teachingStyle: '从测试用例出发，分析失败原因，引导优化思路',
  },
}
```

Programming doesn't need framework-internal judging. User does problem on LeetCode, records result here (external judge → `JudgeResult { score, route: 'external', evidence }`), framework handles attribution → knowledge graph → review from there.

### Adding CPA Accounting (likely zero new capabilities needed)

```typescript
export const accountingProfile: SubjectProfile = {
  id: 'cpa_accounting',
  displayName: 'CPA·会计',
  judgeCapabilities: ['exact', 'keyword', 'semantic'],
  causeCategories: [
    { id: 'standard_confusion', label: '准则混淆' },
    { id: 'entry_direction', label: '借贷方向错误' },
    { id: 'recognition_timing', label: '确认时点错误' },
  ],
  renderConfig: { fontFamily: 'system', notation: null, codeHighlight: null },
  promptFragments: {
    roleNoun: 'CPA会计学习',
    teachingStyle: '以准则原文为锚点，结合典型分录理解',
  },
}
```

Pure data. No new code. Ship immediately once `semantic` judge exists.

## How This Connects To Previous Rounds

| Round | Decision | Status |
|-------|----------|--------|
| R2 Codex | Unified Activity, not dual loop | ✅ Adopted |
| R3 Human | "C tempo, B interfaces" | ✅ Adopted — capability registry is the B interface |
| R3 Human | Attribution fully profile-driven | ✅ causeCategories owned by profile, no universal base |
| R3 Human | renderConfig in SubjectProfile | ✅ Capability dispatch, not per-subject components |
| R4 Codex | SchedulingPolicy interface, FSRS as one policy | ✅ SchedulerRegistry |
| R4 Codex | JudgeResult with score: number | ✅ All judge capabilities return unified JudgeResult |
| R4 Codex | question_part as ActivityKind | ✅ Compatible — parts go through same capability dispatch |
| R4 Codex | Correction event (supersede/retract) | Still open — Round 6 or implementation time |

## What This Means For Implementation Priority

The capability registry model changes the sequencing. Instead of "build features per subject," it's "build capabilities that unlock multiple subjects at once":

| Capability to build | Subjects it unlocks | Priority |
|---------------------|---------------------|----------|
| `semantic` judge | wenyan translation, English writing, CPA case analysis | P0 — unlocks 3 subjects |
| `external` judge | programming (OJ), any external grading | P0 — near-zero code, huge extensibility proof |
| `steps` judge | math proofs, physics derivations | P1 — unlocks 2 subjects |
| `katex` renderer | math, physics, chemistry | P1 — dependency already in project |
| `codeHighlight` renderer | programming | P2 — standard OSS component |
| `symbolic` judge | chemistry balancing, algebra equivalence | P2 — can defer, use semantic as approximation |
| `unit_dimension` judge | physics, chemistry | P3 — niche but valuable |

Each capability built makes every future subject cheaper. That's compounding extensibility.

## Open For Codex

1. Does the capability registry model have blind spots? Where does it break down?
2. How should capability versioning work? If `semantic` judge v2 changes behavior, how do profiles declare compatibility?
3. Should `causeCategories` support inheritance (physics extends a "science base") or should each profile be fully standalone? Human said fully profile-driven, but is there a middle ground that avoids duplication without creating hidden coupling?

---

*Codex: review this extensibility model. Challenge it. Then we should be close to writing a formal ADR and implementation plan.*
