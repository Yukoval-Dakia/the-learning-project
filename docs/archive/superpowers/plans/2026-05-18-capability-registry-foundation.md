# Capability Registry Foundation (Phase N+1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the capability registry foundation that makes the framework subject-neutral: ActivityRef types, typed capability manifests, JudgeResult v2, existing judges registered as capabilities, SubjectProfile extended with version + causeCategories + renderConfig + schedulingHints + judgeCapabilities, build-time profile validator, and subject identity normalization.

**Architecture:** New core type layer (`src/core/schema/activity.ts`, `src/core/schema/capability.ts`) defines ADR-0014 data contracts. Runtime `CapabilityRegistry` (`src/core/capability/`) holds manifests + judge runners. Existing `exact` and `keyword` judges become the first registered capabilities. SubjectProfile grows capability declarations; profile validator (build/test time) ensures declared capabilities exist and cause IDs are unique. Old code paths continue working through a JudgeRouter compatibility bridge.

**Tech Stack:** TypeScript, Zod, Vitest, existing project conventions (`@paralleldrive/cuid2` IDs, `@/` path alias, snake_case schema properties, vitest `describe/it/expect`)

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/core/schema/activity.ts` | `ActivityKind`, `ActivityRef` Zod schemas |
| `src/core/schema/capability.ts` | `CapabilityManifest`, `CapabilityRef`, `CapabilityRunRef`, `JudgeResultV2`, `ScoreMeaning`, `CoarseOutcome` |
| `src/core/schema/profile-decl.ts` | `CauseCategoryDeclaration`, `RenderConfig`, `SchedulingHints` Zod schemas for SubjectProfile sub-types |
| `src/core/capability/types.ts` | `JudgeCapabilityRunner` interface (runner contract) |
| `src/core/capability/registry.ts` | `CapabilityRegistry` class (register + resolve + list) |
| `src/core/capability/judges/exact.ts` | Exact judge wrapped as `JudgeCapabilityRunner` |
| `src/core/capability/judges/keyword.ts` | Keyword judge wrapped as `JudgeCapabilityRunner` |
| `src/core/capability/judges/index.ts` | Bootstrap: registers all built-in judges, exports default registry |
| `src/core/capability/validate-profile.ts` | Build/test-time profile validator |
| `tests/schema/activity.test.ts` | ActivityKind + ActivityRef schema tests |
| `tests/schema/capability.test.ts` | Capability + JudgeResultV2 schema tests |
| `tests/core/capability/registry.test.ts` | Registry register/resolve/list tests |
| `tests/core/capability/judges.test.ts` | Exact + keyword capability output tests |
| `tests/core/capability/validate-profile.test.ts` | Profile validator tests |
| `tests/subjects/profile.test.ts` | SubjectProfile extension + normalization tests |

### Modified Files

| File | Change |
|------|--------|
| `src/subjects/profile.ts` | Extend `SubjectProfile` interface; make `SubjectId` extensible `string`; add `SubjectRegistry` + `registerSubjectProfile()` |
| `src/subjects/wenyan/profile.ts` | Add `version`, `causeCategories`, `renderConfig`, `schedulingHints`, `judgeCapabilities` |
| `src/subjects/math/profile.ts` | Add `version`, `causeCategories`, `renderConfig`, `schedulingHints`, `judgeCapabilities` |
| `src/server/ai/judges/index.ts` | Add `judgeRouterV2()` that delegates to registry; keep `judgeRouter()` as compat shim |

---

### Task 1: ActivityKind + ActivityRef Core Schemas

**Files:**
- Create: `src/core/schema/activity.ts`
- Test: `tests/schema/activity.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/schema/activity.test.ts
import { ActivityKind, ActivityRef } from '@/core/schema/activity';
import { describe, expect, it } from 'vitest';

describe('ActivityKind', () => {
  it('accepts all defined activity kinds', () => {
    for (const kind of [
      'question',
      'question_part',
      'record',
      'recall_prompt',
      'practice_log',
      'project_milestone',
      'open_inquiry',
    ]) {
      expect(ActivityKind.safeParse(kind).success).toBe(true);
    }
  });

  it('rejects unknown kinds', () => {
    expect(ActivityKind.safeParse('quiz').success).toBe(false);
    expect(ActivityKind.safeParse('').success).toBe(false);
  });
});

describe('ActivityRef', () => {
  it('accepts valid ref with question kind', () => {
    const result = ActivityRef.safeParse({ kind: 'question', id: 'q_abc123' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('question');
      expect(result.data.id).toBe('q_abc123');
    }
  });

  it('accepts valid ref with record kind', () => {
    const result = ActivityRef.safeParse({ kind: 'record', id: 'rec_xyz' });
    expect(result.success).toBe(true);
  });

  it('rejects ref with unknown kind', () => {
    expect(ActivityRef.safeParse({ kind: 'quiz', id: 'q_1' }).success).toBe(false);
  });

  it('rejects ref without id', () => {
    expect(ActivityRef.safeParse({ kind: 'question' }).success).toBe(false);
  });

  it('rejects ref with empty id', () => {
    expect(ActivityRef.safeParse({ kind: 'question', id: '' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/schema/activity.test.ts -t 'ActivityKind' 2>&1 | tail -5`
Expected: FAIL — module `@/core/schema/activity` does not exist

- [ ] **Step 3: Write the implementation**

```typescript
// src/core/schema/activity.ts
import { z } from 'zod';

// ADR-0014 §1 — ActivityKind union. 'question' is one activity kind, not the
// only kind. New modules use ActivityRef { kind, id } instead of bare question_id.
// C tempo: only 'question' has runtime behavior today; the rest are interface
// pre-allocation for N+2+.

export const ActivityKind = z.enum([
  'question',
  'question_part',
  'record',
  'recall_prompt',
  'practice_log',
  'project_milestone',
  'open_inquiry',
]);
export type ActivityKindT = z.infer<typeof ActivityKind>;

// Unified identity for any learning material. New interfaces accept ActivityRef;
// old interfaces keep question_id with a compat shim:
//   { activity_ref: { kind: 'question', id }, question_id /* compat */ }
export const ActivityRef = z.object({
  kind: ActivityKind,
  id: z.string().min(1),
});
export type ActivityRefT = z.infer<typeof ActivityRef>;

// Helper: build an ActivityRef from a plain question_id (compat shim).
export function questionRef(questionId: string): ActivityRefT {
  return { kind: 'question', id: questionId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/schema/activity.test.ts -v`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/schema/activity.ts tests/schema/activity.test.ts
git commit -m "feat(core): add ActivityKind + ActivityRef schemas (ADR-0014 §1)"
```

---

### Task 2: Capability Type Schemas (Manifest, Ref, RunRef)

**Files:**
- Create: `src/core/schema/capability.ts`
- Test: `tests/schema/capability.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/schema/capability.test.ts
import {
  CapabilityKind,
  CapabilityManifest,
  CapabilityRef,
  CapabilityRunRef,
  CostClass,
  LatencyClass,
  Stability,
} from '@/core/schema/capability';
import { describe, expect, it } from 'vitest';

describe('CapabilityManifest', () => {
  const validManifest = {
    id: 'exact',
    kind: 'judge',
    version: '1.0.0',
    input_schema: 'ExactJudgeInput',
    output_schema: 'JudgeResultV2',
    cost_class: 'local',
    latency_class: 'sync',
    stability: 'stable',
  };

  it('accepts a valid judge manifest', () => {
    const result = CapabilityManifest.safeParse(validManifest);
    expect(result.success).toBe(true);
  });

  it('accepts manifest with optional replaced_by', () => {
    const result = CapabilityManifest.safeParse({
      ...validManifest,
      stability: 'deprecated',
      replaced_by: 'exact_v2',
    });
    expect(result.success).toBe(true);
  });

  it('accepts renderer kind', () => {
    const result = CapabilityManifest.safeParse({
      ...validManifest,
      id: 'katex',
      kind: 'renderer',
    });
    expect(result.success).toBe(true);
  });

  it('accepts scheduler kind', () => {
    const result = CapabilityManifest.safeParse({
      ...validManifest,
      id: 'fsrs',
      kind: 'scheduler',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown kind', () => {
    expect(
      CapabilityManifest.safeParse({ ...validManifest, kind: 'parser' }).success,
    ).toBe(false);
  });

  it('rejects unknown cost_class', () => {
    expect(
      CapabilityManifest.safeParse({ ...validManifest, cost_class: 'free' }).success,
    ).toBe(false);
  });

  it('rejects missing version', () => {
    const { version: _, ...noVersion } = validManifest;
    expect(CapabilityManifest.safeParse(noVersion).success).toBe(false);
  });
});

describe('CapabilityRef', () => {
  it('accepts valid ref', () => {
    const result = CapabilityRef.safeParse({ id: 'semantic', version: '1.4.1' });
    expect(result.success).toBe(true);
  });

  it('rejects empty id', () => {
    expect(CapabilityRef.safeParse({ id: '', version: '1.0.0' }).success).toBe(false);
  });
});

describe('CapabilityRunRef', () => {
  it('accepts full run ref with optional prompt/model fields', () => {
    const result = CapabilityRunRef.safeParse({
      capability: { id: 'semantic', version: '1.2.0' },
      input_schema_version: '1.0.0',
      output_schema_version: '1.0.0',
      config_hash: 'abc123',
      prompt_version: '2.1.0',
      model_ref: 'claude-sonnet-4-20250514',
    });
    expect(result.success).toBe(true);
  });

  it('accepts minimal run ref without prompt/model', () => {
    const result = CapabilityRunRef.safeParse({
      capability: { id: 'exact', version: '1.0.0' },
      input_schema_version: '1.0.0',
      output_schema_version: '1.0.0',
      config_hash: 'def456',
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/schema/capability.test.ts 2>&1 | tail -5`
Expected: FAIL — module `@/core/schema/capability` does not exist

- [ ] **Step 3: Write the implementation**

```typescript
// src/core/schema/capability.ts
import { z } from 'zod';

// ADR-0014 §2 — Capability Registry types.
// Capabilities are cross-subject: 'semantic' judge serves wenyan, English,
// CPA; 'katex' renderer serves math, physics, chemistry. Each new capability
// makes every future subject cheaper.

// ---------- Enums ----------

export const CapabilityKind = z.enum(['judge', 'renderer', 'scheduler']);
export type CapabilityKindT = z.infer<typeof CapabilityKind>;

export const CostClass = z.enum(['local', 'cheap_llm', 'expensive_llm', 'external']);
export type CostClassT = z.infer<typeof CostClass>;

export const LatencyClass = z.enum(['sync', 'async']);
export type LatencyClassT = z.infer<typeof LatencyClass>;

export const Stability = z.enum(['experimental', 'stable', 'deprecated']);
export type StabilityT = z.infer<typeof Stability>;

// ---------- CapabilityManifest ----------
//
// Metadata for a registered capability. Lives in the registry; profiles
// reference capabilities by id. Events persist exact resolved versions via
// CapabilityRef / CapabilityRunRef.

export const CapabilityManifest = z.object({
  id: z.string().min(1),
  kind: CapabilityKind,
  version: z.string().min(1),
  input_schema: z.string().min(1),
  output_schema: z.string().min(1),
  cost_class: CostClass,
  latency_class: LatencyClass,
  stability: Stability,
  replaced_by: z.string().optional(),
});
export type CapabilityManifestT = z.infer<typeof CapabilityManifest>;

// ---------- CapabilityRef ----------
//
// Lightweight pointer persisted in events. Exact resolved version, not a range.

export const CapabilityRef = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
});
export type CapabilityRefT = z.infer<typeof CapabilityRef>;

// ---------- CapabilityRunRef ----------
//
// Full provenance for a single capability execution. Persisted alongside
// JudgeResultV2 in events so historical results remain explainable after
// capability upgrades.

export const CapabilityRunRef = z.object({
  capability: CapabilityRef,
  input_schema_version: z.string().min(1),
  output_schema_version: z.string().min(1),
  config_hash: z.string().min(1),
  prompt_version: z.string().optional(),
  model_ref: z.string().optional(),
});
export type CapabilityRunRefT = z.infer<typeof CapabilityRunRef>;

// ---------- JudgeResult V2 ----------
//
// ADR-0014 §4 — continuous score + semantic annotation. Different capabilities'
// 0.8 scores are NOT assumed comparable. Scheduling policies interpret scores
// according to their own logic.

export const ScoreMeaning = z.enum([
  'correctness',
  'mastery_estimate',
  'rubric_weighted',
  'external_verdict',
]);
export type ScoreMeaningT = z.infer<typeof ScoreMeaning>;

export const CoarseOutcome = z.enum(['correct', 'partial', 'incorrect', 'unsupported']);
export type CoarseOutcomeT = z.infer<typeof CoarseOutcome>;

export const JudgeResultV2 = z.object({
  score: z.number().min(0).max(1),
  score_meaning: ScoreMeaning,
  coarse_outcome: CoarseOutcome,
  confidence: z.number().min(0).max(1),
  capability_ref: CapabilityRef,
  feedback_md: z.string(),
  evidence_json: z.record(z.unknown()),
});
export type JudgeResultV2T = z.infer<typeof JudgeResultV2>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/schema/capability.test.ts -v`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/schema/capability.ts tests/schema/capability.test.ts
git commit -m "feat(core): add CapabilityManifest, CapabilityRef, JudgeResultV2 schemas (ADR-0014 §2/§4)"
```

---

### Task 3: Profile Declaration Schemas (CauseCategoryDeclaration, RenderConfig, SchedulingHints)

**Files:**
- Create: `src/core/schema/profile-decl.ts`
- Test: add cases in `tests/subjects/profile.test.ts` (created in Task 7)

These types are used by SubjectProfile (Task 6) and the profile validator (Task 8).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/schema/profile-decl.test.ts
import {
  CauseCategoryDeclaration,
  RenderConfig,
  SchedulingHints,
} from '@/core/schema/profile-decl';
import { describe, expect, it } from 'vitest';

describe('CauseCategoryDeclaration', () => {
  it('accepts valid cause with label only', () => {
    const result = CauseCategoryDeclaration.safeParse({
      id: 'unit_error',
      label: '单位错误',
    });
    expect(result.success).toBe(true);
  });

  it('accepts cause with description and source_pack', () => {
    const result = CauseCategoryDeclaration.safeParse({
      id: 'model_selection',
      label: '模型选择错误',
      description: '选错了物理模型或公式',
      source_pack: { id: 'science_common', version: '1.0.0' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty id', () => {
    expect(
      CauseCategoryDeclaration.safeParse({ id: '', label: 'x' }).success,
    ).toBe(false);
  });

  it('rejects id with spaces', () => {
    expect(
      CauseCategoryDeclaration.safeParse({ id: 'has space', label: 'x' }).success,
    ).toBe(false);
  });
});

describe('RenderConfig', () => {
  it('accepts wenyan-style config', () => {
    const result = RenderConfig.safeParse({
      font_family: 'serif-cjk',
      notation: null,
      code_highlight: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts math-style config with katex', () => {
    const result = RenderConfig.safeParse({
      font_family: 'system',
      notation: 'katex',
      code_highlight: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts programming config with code highlight', () => {
    const result = RenderConfig.safeParse({
      font_family: 'monospace',
      notation: null,
      code_highlight: 'typescript',
    });
    expect(result.success).toBe(true);
  });
});

describe('SchedulingHints', () => {
  it('accepts fsrs default', () => {
    const result = SchedulingHints.safeParse({ default_policy: 'fsrs' });
    expect(result.success).toBe(true);
  });

  it('accepts none_evidence_only for records', () => {
    const result = SchedulingHints.safeParse({ default_policy: 'none_evidence_only' });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/schema/profile-decl.test.ts 2>&1 | tail -5`
Expected: FAIL — module `@/core/schema/profile-decl` does not exist

- [ ] **Step 3: Write the implementation**

```typescript
// src/core/schema/profile-decl.ts
import { z } from 'zod';

// ADR-0014 §3 — SubjectProfile sub-type schemas.
// These Zod schemas are used by SubjectProfile (src/subjects/profile.ts) and
// the profile validator (src/core/capability/validate-profile.ts).

// ---------- CauseCategoryDeclaration ----------
//
// Each SubjectProfile defines its own complete cause taxonomy. No universal
// base enum exists at runtime. Authoring-time packs (source_pack) can reduce
// duplication, but the exported profile is fully materialized.

const CAUSE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export const CauseCategoryDeclaration = z.object({
  id: z.string().min(1).regex(CAUSE_ID_PATTERN, {
    message: 'cause id must be lowercase alphanumeric + underscores, starting with a letter',
  }),
  label: z.string().min(1),
  description: z.string().optional(),
  source_pack: z
    .object({
      id: z.string().min(1),
      version: z.string().min(1),
    })
    .optional(),
});
export type CauseCategoryDeclarationT = z.infer<typeof CauseCategoryDeclaration>;

// ---------- RenderConfig ----------
//
// ADR-0014 §3 + summary §10: rendering is profile-driven. One generic
// <SubjectContent> component reads config and dispatches to registered
// renderer capabilities.

export const RenderConfig = z.object({
  font_family: z.string().min(1), // 'system' | 'serif-cjk' | 'monospace' | ...
  notation: z.string().nullable(), // 'katex' | null
  code_highlight: z.string().nullable(), // 'typescript' | 'python' | null
});
export type RenderConfigT = z.infer<typeof RenderConfig>;

// ---------- SchedulingHints ----------
//
// ADR-0014 §5: FSRS is one policy, not the universal scheduler. Profiles
// declare their default; the orchestrator picks the matching SchedulingPolicy.

export const SchedulingHints = z.object({
  default_policy: z.string().min(1), // 'fsrs' | 'cadence' | 'none_evidence_only'
});
export type SchedulingHintsT = z.infer<typeof SchedulingHints>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/schema/profile-decl.test.ts -v`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/schema/profile-decl.ts tests/schema/profile-decl.test.ts
git commit -m "feat(core): add CauseCategoryDeclaration, RenderConfig, SchedulingHints schemas (ADR-0014 §3/§5)"
```

---

### Task 4: JudgeCapabilityRunner Interface + CapabilityRegistry

**Files:**
- Create: `src/core/capability/types.ts`
- Create: `src/core/capability/registry.ts`
- Test: `tests/core/capability/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/capability/registry.test.ts
import { CapabilityRegistry } from '@/core/capability/registry';
import type { JudgeCapabilityRunner } from '@/core/capability/types';
import type { CapabilityManifestT } from '@/core/schema/capability';
import { describe, expect, it } from 'vitest';

function makeStubJudge(id: string, version = '1.0.0'): JudgeCapabilityRunner {
  const manifest: CapabilityManifestT = {
    id,
    kind: 'judge',
    version,
    input_schema: 'StubInput',
    output_schema: 'JudgeResultV2',
    cost_class: 'local',
    latency_class: 'sync',
    stability: 'stable',
  };
  return {
    manifest,
    run: () => ({
      score: 1,
      score_meaning: 'correctness' as const,
      coarse_outcome: 'correct' as const,
      confidence: 1,
      capability_ref: { id, version },
      feedback_md: 'stub',
      evidence_json: {},
    }),
  };
}

describe('CapabilityRegistry', () => {
  it('registers and resolves a judge capability', () => {
    const registry = new CapabilityRegistry();
    const judge = makeStubJudge('exact');
    registry.registerJudge(judge);

    const resolved = registry.resolveJudge('exact');
    expect(resolved).toBeDefined();
    expect(resolved!.manifest.id).toBe('exact');
  });

  it('returns undefined for unregistered capability', () => {
    const registry = new CapabilityRegistry();
    expect(registry.resolveJudge('nonexistent')).toBeUndefined();
  });

  it('lists all registered judge manifests', () => {
    const registry = new CapabilityRegistry();
    registry.registerJudge(makeStubJudge('exact'));
    registry.registerJudge(makeStubJudge('keyword'));

    const manifests = registry.listJudges();
    expect(manifests).toHaveLength(2);
    expect(manifests.map((m) => m.id).sort()).toEqual(['exact', 'keyword']);
  });

  it('throws on duplicate judge registration', () => {
    const registry = new CapabilityRegistry();
    registry.registerJudge(makeStubJudge('exact'));
    expect(() => registry.registerJudge(makeStubJudge('exact'))).toThrow(
      /already registered/,
    );
  });

  it('hasJudge returns true for registered, false for missing', () => {
    const registry = new CapabilityRegistry();
    registry.registerJudge(makeStubJudge('exact'));
    expect(registry.hasJudge('exact')).toBe(true);
    expect(registry.hasJudge('semantic')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/core/capability/registry.test.ts 2>&1 | tail -5`
Expected: FAIL — modules do not exist

- [ ] **Step 3: Write the types file**

```typescript
// src/core/capability/types.ts
import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';

// ---------- JudgeCapabilityRunner ----------
//
// ADR-0014 §2 — contract for a registered judge capability.
// Each concrete judge (exact, keyword, semantic, ...) implements this interface.
// The runner validates its own input; the registry only routes by id.

export interface JudgeRunInput {
  /** Opaque question data — shape depends on the capability. */
  question: Record<string, unknown>;
  /** User/agent answer. */
  answer: { content: string };
}

export interface JudgeCapabilityRunner {
  readonly manifest: CapabilityManifestT;
  run(input: JudgeRunInput): JudgeResultV2T;
}
```

- [ ] **Step 4: Write the registry**

```typescript
// src/core/capability/registry.ts
import type { CapabilityManifestT } from '@/core/schema/capability';
import type { JudgeCapabilityRunner } from './types';

// ADR-0014 §2 — Capability Registry.
// Framework provides extension points; subject-specific behavior is registered
// as capabilities. Capabilities are cross-subject, not subject-owned.

export class CapabilityRegistry {
  private judges = new Map<string, JudgeCapabilityRunner>();

  registerJudge(runner: JudgeCapabilityRunner): void {
    const { id } = runner.manifest;
    if (this.judges.has(id)) {
      throw new Error(`Judge capability '${id}' already registered`);
    }
    this.judges.set(id, runner);
  }

  resolveJudge(id: string): JudgeCapabilityRunner | undefined {
    return this.judges.get(id);
  }

  hasJudge(id: string): boolean {
    return this.judges.has(id);
  }

  listJudges(): CapabilityManifestT[] {
    return [...this.judges.values()].map((r) => r.manifest);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run tests/core/capability/registry.test.ts -v`
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/capability/types.ts src/core/capability/registry.ts tests/core/capability/registry.test.ts
git commit -m "feat(core): add JudgeCapabilityRunner interface + CapabilityRegistry (ADR-0014 §2)"
```

---

### Task 5: Register Exact Judge as Capability

**Files:**
- Create: `src/core/capability/judges/exact.ts`
- Test: `tests/core/capability/judges.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/capability/judges.test.ts
import { exactJudgeCapability } from '@/core/capability/judges/exact';
import { JudgeResultV2 } from '@/core/schema/capability';
import { describe, expect, it } from 'vitest';

describe('exactJudgeCapability', () => {
  it('has a valid manifest', () => {
    const m = exactJudgeCapability.manifest;
    expect(m.id).toBe('exact');
    expect(m.kind).toBe('judge');
    expect(m.cost_class).toBe('local');
    expect(m.latency_class).toBe('sync');
    expect(m.stability).toBe('stable');
  });

  it('returns correct for exact match', () => {
    const result = exactJudgeCapability.run({
      question: { reference: '虚词' },
      answer: { content: '虚词' },
    });
    expect(result.coarse_outcome).toBe('correct');
    expect(result.score).toBe(1);
    expect(result.score_meaning).toBe('correctness');
    expect(result.confidence).toBe(1);
    expect(result.capability_ref.id).toBe('exact');
    // Must parse as valid JudgeResultV2
    expect(JudgeResultV2.safeParse(result).success).toBe(true);
  });

  it('returns incorrect for non-match', () => {
    const result = exactJudgeCapability.run({
      question: { reference: '虚词' },
      answer: { content: '实词' },
    });
    expect(result.coarse_outcome).toBe('incorrect');
    expect(result.score).toBe(0);
  });

  it('is case-insensitive', () => {
    const result = exactJudgeCapability.run({
      question: { reference: 'ABC' },
      answer: { content: 'abc' },
    });
    expect(result.coarse_outcome).toBe('correct');
    expect(result.score).toBe(1);
  });

  it('trims whitespace', () => {
    const result = exactJudgeCapability.run({
      question: { reference: '虚词' },
      answer: { content: '  虚词  ' },
    });
    expect(result.coarse_outcome).toBe('correct');
  });

  it('throws on missing reference', () => {
    expect(() =>
      exactJudgeCapability.run({
        question: {},
        answer: { content: 'abc' },
      }),
    ).toThrow(/reference/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/core/capability/judges.test.ts -t 'exactJudgeCapability' 2>&1 | tail -5`
Expected: FAIL — module does not exist

- [ ] **Step 3: Write the implementation**

```typescript
// src/core/capability/judges/exact.ts
import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';
import type { JudgeCapabilityRunner, JudgeRunInput } from '../types';

const manifest: CapabilityManifestT = {
  id: 'exact',
  kind: 'judge',
  version: '1.0.0',
  input_schema: 'ExactJudgeInput { reference: string }',
  output_schema: 'JudgeResultV2',
  cost_class: 'local',
  latency_class: 'sync',
  stability: 'stable',
};

const CAPABILITY_REF = { id: 'exact', version: '1.0.0' } as const;

function run(input: JudgeRunInput): JudgeResultV2T {
  const reference = input.question.reference;
  if (typeof reference !== 'string') {
    throw new Error('exact judge requires question.reference: string');
  }

  const normalize = (s: string) => s.trim().toLowerCase();
  const match = normalize(input.answer.content) === normalize(reference);

  return {
    score: match ? 1 : 0,
    score_meaning: 'correctness',
    coarse_outcome: match ? 'correct' : 'incorrect',
    confidence: 1,
    capability_ref: CAPABILITY_REF,
    feedback_md: match
      ? `正确答案：${reference}。`
      : `参考答案：${reference}。你的答案：${input.answer.content}。`,
    evidence_json: { match, normalized_reference: normalize(reference) },
  };
}

export const exactJudgeCapability: JudgeCapabilityRunner = { manifest, run };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/core/capability/judges.test.ts -t 'exactJudgeCapability' -v`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/capability/judges/exact.ts tests/core/capability/judges.test.ts
git commit -m "feat(core): register exact judge as capability (ADR-0014 §2)"
```

---

### Task 6: Register Keyword Judge as Capability

**Files:**
- Create: `src/core/capability/judges/keyword.ts`
- Modify: `tests/core/capability/judges.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/core/capability/judges.test.ts`:

```typescript
import { keywordJudgeCapability } from '@/core/capability/judges/keyword';

describe('keywordJudgeCapability', () => {
  it('has a valid manifest', () => {
    const m = keywordJudgeCapability.manifest;
    expect(m.id).toBe('keyword');
    expect(m.kind).toBe('judge');
    expect(m.cost_class).toBe('local');
    expect(m.stability).toBe('stable');
  });

  it('returns correct when all keywords hit', () => {
    const result = keywordJudgeCapability.run({
      question: { keywords: ['虚词', '代词'] },
      answer: { content: '虚词是一种代词' },
    });
    expect(result.coarse_outcome).toBe('correct');
    expect(result.score).toBe(1);
    expect(result.score_meaning).toBe('correctness');
    expect(result.capability_ref.id).toBe('keyword');
    expect(JudgeResultV2.safeParse(result).success).toBe(true);
  });

  it('returns partial for some keyword hits', () => {
    const result = keywordJudgeCapability.run({
      question: { keywords: ['虚词', '代词', '连词'] },
      answer: { content: '虚词分析' },
    });
    expect(result.coarse_outcome).toBe('partial');
    expect(result.score).toBeCloseTo(1 / 3);
  });

  it('returns incorrect for zero hits', () => {
    const result = keywordJudgeCapability.run({
      question: { keywords: ['虚词'] },
      answer: { content: '完全无关' },
    });
    expect(result.coarse_outcome).toBe('incorrect');
    expect(result.score).toBe(0);
  });

  it('returns correct at 85% threshold', () => {
    // 6 out of 7 keywords hit = 0.857 >= 0.85 → correct
    const result = keywordJudgeCapability.run({
      question: { keywords: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
      answer: { content: 'a b c d e f missing_last' },
    });
    expect(result.coarse_outcome).toBe('correct');
  });

  it('throws on missing keywords', () => {
    expect(() =>
      keywordJudgeCapability.run({
        question: {},
        answer: { content: 'abc' },
      }),
    ).toThrow(/keywords/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/core/capability/judges.test.ts -t 'keywordJudgeCapability' 2>&1 | tail -5`
Expected: FAIL — module does not exist

- [ ] **Step 3: Write the implementation**

```typescript
// src/core/capability/judges/keyword.ts
import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';
import type { JudgeCapabilityRunner, JudgeRunInput } from '../types';

const manifest: CapabilityManifestT = {
  id: 'keyword',
  kind: 'judge',
  version: '1.0.0',
  input_schema: 'KeywordJudgeInput { keywords: string[] }',
  output_schema: 'JudgeResultV2',
  cost_class: 'local',
  latency_class: 'sync',
  stability: 'stable',
};

const CAPABILITY_REF = { id: 'keyword', version: '1.0.0' } as const;

function run(input: JudgeRunInput): JudgeResultV2T {
  const keywords = input.question.keywords;
  if (!Array.isArray(keywords)) {
    throw new Error('keyword judge requires question.keywords: string[]');
  }

  const total = keywords.length;
  const lowerContent = input.answer.content.toLowerCase();
  const hits = keywords.filter((kw: string) => lowerContent.includes(kw.toLowerCase()));
  const missing = keywords.filter((kw: string) => !lowerContent.includes(kw.toLowerCase()));
  const score = total === 0 ? 0 : hits.length / total;

  let coarse_outcome: 'correct' | 'partial' | 'incorrect';
  if (score >= 0.85) coarse_outcome = 'correct';
  else if (score > 0.4) coarse_outcome = 'partial';
  else coarse_outcome = 'incorrect';

  return {
    score,
    score_meaning: 'correctness',
    coarse_outcome,
    confidence: 1,
    capability_ref: CAPABILITY_REF,
    feedback_md:
      missing.length === 0
        ? `命中所有关键词 (${hits.length}/${total})。`
        : `命中关键词 ${hits.length}/${total}：缺失 [${missing.join(', ')}]。`,
    evidence_json: { hits, missing, total },
  };
}

export const keywordJudgeCapability: JudgeCapabilityRunner = { manifest, run };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/core/capability/judges.test.ts -v`
Expected: all tests PASS (both exact and keyword)

- [ ] **Step 5: Create bootstrap index that registers built-in judges**

```typescript
// src/core/capability/judges/index.ts
import { CapabilityRegistry } from '../registry';
import { exactJudgeCapability } from './exact';
import { keywordJudgeCapability } from './keyword';

// Default registry with all built-in judge capabilities registered.
// Import this from anywhere that needs the standard capability set.
export function createDefaultRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.registerJudge(exactJudgeCapability);
  registry.registerJudge(keywordJudgeCapability);
  return registry;
}

// Singleton for app-wide use. Lazy-initialized.
let _default: CapabilityRegistry | null = null;

export function getDefaultRegistry(): CapabilityRegistry {
  if (!_default) {
    _default = createDefaultRegistry();
  }
  return _default;
}

// Re-export individual capabilities for direct use in tests.
export { exactJudgeCapability } from './exact';
export { keywordJudgeCapability } from './keyword';
```

- [ ] **Step 6: Commit**

```bash
git add src/core/capability/judges/keyword.ts src/core/capability/judges/index.ts tests/core/capability/judges.test.ts
git commit -m "feat(core): register keyword judge + bootstrap default registry (ADR-0014 §2)"
```

---

### Task 7: SubjectProfile Schema Extensions

**Files:**
- Modify: `src/subjects/profile.ts`
- Test: `tests/subjects/profile.test.ts`

This task extends the SubjectProfile interface with `version`, `causeCategories`, `renderConfig`, `schedulingHints`, and `judgeCapabilities`. Existing fields are preserved.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/subjects/profile.test.ts
import {
  CauseCategoryDeclaration,
  RenderConfig,
  SchedulingHints,
} from '@/core/schema/profile-decl';
import {
  type SubjectProfile,
  resolveSubjectProfile,
  subjectProfiles,
} from '@/subjects/profile';
import { describe, expect, it } from 'vitest';

describe('SubjectProfile extensions', () => {
  it('wenyan profile has version field', () => {
    const p = subjectProfiles.wenyan;
    expect(p.version).toBeDefined();
    expect(typeof p.version).toBe('string');
    expect(p.version.length).toBeGreaterThan(0);
  });

  it('wenyan profile has causeCategories array', () => {
    const p = subjectProfiles.wenyan;
    expect(Array.isArray(p.causeCategories)).toBe(true);
    expect(p.causeCategories.length).toBeGreaterThan(0);
    // Each entry must validate against the Zod schema
    for (const cc of p.causeCategories) {
      expect(CauseCategoryDeclaration.safeParse(cc).success).toBe(true);
    }
  });

  it('wenyan causeCategories have unique ids', () => {
    const p = subjectProfiles.wenyan;
    const ids = p.causeCategories.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('wenyan profile has renderConfig', () => {
    const p = subjectProfiles.wenyan;
    expect(RenderConfig.safeParse(p.renderConfig).success).toBe(true);
    expect(p.renderConfig.font_family).toBe('serif-cjk');
    expect(p.renderConfig.notation).toBeNull();
  });

  it('wenyan profile has schedulingHints', () => {
    const p = subjectProfiles.wenyan;
    expect(SchedulingHints.safeParse(p.schedulingHints).success).toBe(true);
    expect(p.schedulingHints.default_policy).toBe('fsrs');
  });

  it('wenyan profile has judgeCapabilities array', () => {
    const p = subjectProfiles.wenyan;
    expect(Array.isArray(p.judgeCapabilities)).toBe(true);
    expect(p.judgeCapabilities).toContain('exact');
    expect(p.judgeCapabilities).toContain('keyword');
  });

  it('math profile has renderConfig with katex notation', () => {
    const p = subjectProfiles.math;
    expect(p.renderConfig.notation).toBe('katex');
    expect(p.renderConfig.font_family).toBe('system');
  });

  it('math profile has causeCategories with unique ids', () => {
    const p = subjectProfiles.math;
    expect(p.causeCategories.length).toBeGreaterThan(0);
    const ids = p.causeCategories.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all profiles still have existing fields intact', () => {
    for (const p of Object.values(subjectProfiles)) {
      expect(p.displayName).toBeDefined();
      expect(p.languageStyle).toBeDefined();
      expect(p.questionKinds.length).toBeGreaterThan(0);
      expect(p.judgePolicy).toBeDefined();
      expect(p.noteTemplate).toBeDefined();
      expect(p.grounding).toBeDefined();
      expect(p.promptFragments).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/subjects/profile.test.ts 2>&1 | tail -10`
Expected: FAIL — properties like `version`, `causeCategories`, `renderConfig` don't exist on SubjectProfile

- [ ] **Step 3: Extend SubjectProfile interface**

Edit `src/subjects/profile.ts` — add new imports and extend the interface. Keep all existing fields.

Add at the top of the file:

```typescript
import type { CauseCategoryDeclarationT, RenderConfigT, SchedulingHintsT } from '@/core/schema/profile-decl';
```

Then extend the `SubjectProfile` interface by adding these fields after `displayName`:

```typescript
  version: string;
```

And after `promptFragments`:

```typescript
  // --- ADR-0014 extensions ---
  causeCategories: CauseCategoryDeclarationT[];
  renderConfig: RenderConfigT;
  schedulingHints: SchedulingHintsT;
  judgeCapabilities: string[];
```

The compiler will now require all profile implementations to provide these fields — which is the forcing function for Task 8.

- [ ] **Step 4: Update wenyan profile**

Edit `src/subjects/wenyan/profile.ts` — add new fields to `wenyanProfile`:

```typescript
  version: '1.0.0',

  // --- ADR-0014 extensions ---
  causeCategories: [
    { id: 'concept', label: '概念理解', description: '对文言词义、语法功能的核心概念理解错误' },
    { id: 'knowledge_gap', label: '知识缺失', description: '缺少必要的古文知识背景' },
    { id: 'reading', label: '审题偏差', description: '题面信息遗漏或误读' },
    { id: 'memory', label: '记忆混淆', description: '已学内容的记忆不牢固或混淆' },
    { id: 'expression', label: '表达不当', description: '理解正确但表述不清或不完整' },
    { id: 'carelessness', label: '粗心', description: '非知识性的笔误或遗漏' },
    { id: 'other', label: '其它' },
  ],
  renderConfig: {
    font_family: 'serif-cjk',
    notation: null,
    code_highlight: null,
  },
  schedulingHints: {
    default_policy: 'fsrs',
  },
  judgeCapabilities: ['exact', 'keyword'],
```

- [ ] **Step 5: Update math profile**

Edit `src/subjects/math/profile.ts` — add new fields to `mathProfile`:

```typescript
  version: '1.0.0',

  // --- ADR-0014 extensions ---
  causeCategories: [
    { id: 'concept', label: '概念理解', description: '对数学定义、定理、条件的理解错误' },
    { id: 'knowledge_gap', label: '知识缺失', description: '缺少解题所需的数学知识' },
    { id: 'calculation', label: '运算错误', description: '代数计算、数值运算失误' },
    { id: 'method', label: '方法选择', description: '解题方法或策略选择不当' },
    { id: 'reading', label: '审题偏差', description: '题面条件遗漏或误读' },
    { id: 'memory', label: '记忆混淆', description: '公式、定理的记忆不准确' },
    { id: 'expression', label: '表达不规范', description: '推导步骤省略或书写不清' },
    { id: 'unit_error', label: '单位错误', description: '量纲或单位换算错误' },
    { id: 'carelessness', label: '粗心', description: '非知识性的计算笔误或抄写错误' },
    { id: 'other', label: '其它' },
  ],
  renderConfig: {
    font_family: 'system',
    notation: 'katex',
    code_highlight: null,
  },
  schedulingHints: {
    default_policy: 'fsrs',
  },
  judgeCapabilities: ['exact', 'keyword'],
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run tests/subjects/profile.test.ts -v`
Expected: all tests PASS

- [ ] **Step 7: Run typecheck to confirm no regressions**

Run: `pnpm typecheck`
Expected: PASS — no type errors. All existing references to SubjectProfile still compile because we only added fields, didn't remove any.

- [ ] **Step 8: Commit**

```bash
git add src/subjects/profile.ts src/subjects/wenyan/profile.ts src/subjects/math/profile.ts tests/subjects/profile.test.ts
git commit -m "feat(subjects): extend SubjectProfile with version, causeCategories, renderConfig, schedulingHints, judgeCapabilities (ADR-0014 §3)"
```

---

### Task 8: Profile Validator

**Files:**
- Create: `src/core/capability/validate-profile.ts`
- Test: `tests/core/capability/validate-profile.test.ts`

Build/test-time validator checks: declared capabilities exist, cause IDs are unique and valid format, renderConfig/schedulingHints are well-formed. Without this, the registry is just a naming convention (Codex R7 §3).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/capability/validate-profile.test.ts
import { CapabilityRegistry } from '@/core/capability/registry';
import { validateProfile, type ProfileValidationResult } from '@/core/capability/validate-profile';
import type { SubjectProfile } from '@/subjects/profile';
import type { JudgeCapabilityRunner } from '@/core/capability/types';
import type { CapabilityManifestT } from '@/core/schema/capability';
import { describe, expect, it } from 'vitest';

function makeStubJudge(id: string): JudgeCapabilityRunner {
  const manifest: CapabilityManifestT = {
    id,
    kind: 'judge',
    version: '1.0.0',
    input_schema: 'any',
    output_schema: 'JudgeResultV2',
    cost_class: 'local',
    latency_class: 'sync',
    stability: 'stable',
  };
  return {
    manifest,
    run: () => ({
      score: 1,
      score_meaning: 'correctness' as const,
      coarse_outcome: 'correct' as const,
      confidence: 1,
      capability_ref: { id, version: '1.0.0' },
      feedback_md: '',
      evidence_json: {},
    }),
  };
}

function makeRegistry(...ids: string[]): CapabilityRegistry {
  const reg = new CapabilityRegistry();
  for (const id of ids) reg.registerJudge(makeStubJudge(id));
  return reg;
}

// Minimal valid profile for testing. Uses 'as unknown as SubjectProfile' to
// avoid filling every field — validator only checks ADR-0014 extensions.
function makeProfile(overrides: Partial<SubjectProfile> = {}): SubjectProfile {
  return {
    id: 'test',
    displayName: 'Test',
    version: '1.0.0',
    languageStyle: '',
    questionKinds: [],
    judgePolicy: { preferredRoutes: [], notes: [] },
    exampleSources: [],
    noteTemplate: { definition: '', mechanism: '', example: '', pitfall: '', check: '' },
    grounding: { requirement: '', allowedSources: [], uncertaintyPolicy: '' },
    promptFragments: {
      roleNoun: '',
      noteExamplePolicy: '',
      variantExamplePolicy: '',
      teachingStyle: '',
      checkQuestionPolicy: '',
      learningIntentPolicy: '',
    },
    causeCategories: [
      { id: 'concept', label: '概念' },
      { id: 'memory', label: '记忆' },
    ],
    renderConfig: { font_family: 'system', notation: null, code_highlight: null },
    schedulingHints: { default_policy: 'fsrs' },
    judgeCapabilities: ['exact', 'keyword'],
    ...overrides,
  } as SubjectProfile;
}

describe('validateProfile', () => {
  it('passes for a valid profile with matching registry', () => {
    const result = validateProfile(makeProfile(), makeRegistry('exact', 'keyword'));
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when declared judge capability is not in registry', () => {
    const result = validateProfile(
      makeProfile({ judgeCapabilities: ['exact', 'semantic'] }),
      makeRegistry('exact', 'keyword'),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('semantic'))).toBe(true);
  });

  it('fails when causeCategories has duplicate ids', () => {
    const result = validateProfile(
      makeProfile({
        causeCategories: [
          { id: 'concept', label: 'A' },
          { id: 'concept', label: 'B' },
        ],
      }),
      makeRegistry('exact', 'keyword'),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('duplicate'))).toBe(true);
  });

  it('fails when causeCategory id has invalid format', () => {
    const result = validateProfile(
      makeProfile({
        causeCategories: [{ id: 'Has Space', label: 'bad' }],
      }),
      makeRegistry('exact', 'keyword'),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('format'))).toBe(true);
  });

  it('fails when version is empty', () => {
    const result = validateProfile(
      makeProfile({ version: '' }),
      makeRegistry('exact', 'keyword'),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('version'))).toBe(true);
  });

  it('fails when causeCategories is empty', () => {
    const result = validateProfile(
      makeProfile({ causeCategories: [] }),
      makeRegistry('exact', 'keyword'),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('causeCategories'))).toBe(true);
  });

  it('warns (but does not fail) for deprecated capability', () => {
    const reg = new CapabilityRegistry();
    const deprecated: CapabilityManifestT = {
      id: 'old_judge',
      kind: 'judge',
      version: '1.0.0',
      input_schema: 'any',
      output_schema: 'JudgeResultV2',
      cost_class: 'local',
      latency_class: 'sync',
      stability: 'deprecated',
      replaced_by: 'new_judge',
    };
    reg.registerJudge({
      manifest: deprecated,
      run: () => ({
        score: 0,
        score_meaning: 'correctness' as const,
        coarse_outcome: 'incorrect' as const,
        confidence: 0,
        capability_ref: { id: 'old_judge', version: '1.0.0' },
        feedback_md: '',
        evidence_json: {},
      }),
    });

    const result = validateProfile(
      makeProfile({ judgeCapabilities: ['old_judge'] }),
      reg,
    );
    expect(result.valid).toBe(true); // deprecated = warning, not error
    expect(result.warnings.some((w) => w.includes('deprecated'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/core/capability/validate-profile.test.ts 2>&1 | tail -5`
Expected: FAIL — module does not exist

- [ ] **Step 3: Write the implementation**

```typescript
// src/core/capability/validate-profile.ts
import { CauseCategoryDeclaration } from '@/core/schema/profile-decl';
import type { SubjectProfile } from '@/subjects/profile';
import type { CapabilityRegistry } from './registry';

// ADR-0014 + Codex R7 §3: registry foundation must include validation.
// Build/test-time validator ensures profiles and registry stay in sync.

export interface ProfileValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const CAUSE_ID_RE = /^[a-z][a-z0-9_]*$/;

export function validateProfile(
  profile: SubjectProfile,
  registry: CapabilityRegistry,
): ProfileValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. version must be non-empty
  if (!profile.version || profile.version.trim().length === 0) {
    errors.push(`[${profile.id}] version must be a non-empty string`);
  }

  // 2. causeCategories: at least one, unique ids, valid format
  if (!profile.causeCategories || profile.causeCategories.length === 0) {
    errors.push(`[${profile.id}] causeCategories must have at least one entry`);
  } else {
    const seenIds = new Set<string>();
    for (const cc of profile.causeCategories) {
      // format check via Zod
      const parsed = CauseCategoryDeclaration.safeParse(cc);
      if (!parsed.success) {
        errors.push(
          `[${profile.id}] causeCategory '${cc.id}' has invalid format: ${parsed.error.issues[0]?.message}`,
        );
        continue;
      }
      if (!CAUSE_ID_RE.test(cc.id)) {
        errors.push(
          `[${profile.id}] causeCategory '${cc.id}' has invalid format (must be lowercase + underscores)`,
        );
      }
      if (seenIds.has(cc.id)) {
        errors.push(`[${profile.id}] causeCategory duplicate id: '${cc.id}'`);
      }
      seenIds.add(cc.id);
    }
  }

  // 3. judgeCapabilities: each must exist in registry
  if (profile.judgeCapabilities) {
    for (const capId of profile.judgeCapabilities) {
      if (!registry.hasJudge(capId)) {
        errors.push(
          `[${profile.id}] judgeCapability '${capId}' not found in registry`,
        );
      } else {
        // Check for deprecation warnings
        const runner = registry.resolveJudge(capId);
        if (runner?.manifest.stability === 'deprecated') {
          const replacement = runner.manifest.replaced_by
            ? ` (replaced by '${runner.manifest.replaced_by}')`
            : '';
          warnings.push(
            `[${profile.id}] judgeCapability '${capId}' is deprecated${replacement}`,
          );
        }
      }
    }
  }

  // 4. renderConfig: basic presence check (Zod validation in schema)
  if (!profile.renderConfig) {
    errors.push(`[${profile.id}] renderConfig is required`);
  }

  // 5. schedulingHints: basic presence check
  if (!profile.schedulingHints) {
    errors.push(`[${profile.id}] schedulingHints is required`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/core/capability/validate-profile.test.ts -v`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/capability/validate-profile.ts tests/core/capability/validate-profile.test.ts
git commit -m "feat(core): add build-time profile validator (ADR-0014 + Codex R7 §3)"
```

---

### Task 9: Subject Identity Normalization

**Files:**
- Modify: `src/subjects/profile.ts`
- Test: add cases in `tests/subjects/profile.test.ts`

Makes `SubjectId` extensible (string, not closed union) and adds a `SubjectRegistry` that holds profiles + aliases. Current behavior is preserved — `resolveSubjectProfile()` continues working.

- [ ] **Step 1: Write the failing test**

Append to `tests/subjects/profile.test.ts`:

```typescript
import {
  KNOWN_SUBJECT_IDS,
  SubjectRegistry,
} from '@/subjects/profile';

describe('SubjectRegistry', () => {
  it('resolves known subject by id', () => {
    const reg = new SubjectRegistry();
    // Built-in profiles are registered in constructor
    const wenyan = reg.resolve('wenyan');
    expect(wenyan).toBeDefined();
    expect(wenyan!.displayName).toBe('文言文');
  });

  it('resolves subject by alias', () => {
    const reg = new SubjectRegistry();
    const result = reg.resolve('classical_chinese');
    expect(result).toBeDefined();
    expect(result!.id).toBe('wenyan');
  });

  it('resolves math by alias "mathematics"', () => {
    const reg = new SubjectRegistry();
    const result = reg.resolve('mathematics');
    expect(result).toBeDefined();
    expect(result!.id).toBe('math');
  });

  it('returns default profile for unknown subject', () => {
    const reg = new SubjectRegistry();
    const result = reg.resolve('unknown_subject');
    expect(result).toBeDefined();
    expect(result!.id).toBe('wenyan'); // default
  });

  it('returns default profile for null/undefined', () => {
    const reg = new SubjectRegistry();
    expect(reg.resolve(null)!.id).toBe('wenyan');
    expect(reg.resolve(undefined)!.id).toBe('wenyan');
  });

  it('is case-insensitive', () => {
    const reg = new SubjectRegistry();
    expect(reg.resolve('WENYAN')!.id).toBe('wenyan');
    expect(reg.resolve('Math')!.id).toBe('math');
  });

  it('lists all registered profile ids', () => {
    const reg = new SubjectRegistry();
    const ids = reg.listIds();
    expect(ids).toContain('wenyan');
    expect(ids).toContain('math');
  });

  it('registers a custom profile', () => {
    const reg = new SubjectRegistry();
    const physics = {
      ...reg.resolve('math')!,
      id: 'physics',
      version: '1.0.0',
      displayName: '物理',
    };
    reg.register(physics, ['phys', 'physics_101']);

    expect(reg.resolve('physics')!.displayName).toBe('物理');
    expect(reg.resolve('phys')!.id).toBe('physics');
    expect(reg.listIds()).toContain('physics');
  });
});

describe('KNOWN_SUBJECT_IDS', () => {
  it('contains wenyan and math', () => {
    expect(KNOWN_SUBJECT_IDS).toContain('wenyan');
    expect(KNOWN_SUBJECT_IDS).toContain('math');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/subjects/profile.test.ts -t 'SubjectRegistry' 2>&1 | tail -5`
Expected: FAIL — `SubjectRegistry` not exported

- [ ] **Step 3: Refactor `src/subjects/profile.ts`**

Replace the entire `src/subjects/profile.ts` file. The new version:
- Changes `SubjectId` from literal union to `string` (with `KnownSubjectId` for backward compat)
- Adds `SubjectRegistry` class
- Keeps `subjectProfiles`, `defaultSubjectProfile`, `resolveSubjectProfile()` as backward-compat re-exports

```typescript
// src/subjects/profile.ts
import type {
  CauseCategoryDeclarationT,
  RenderConfigT,
  SchedulingHintsT,
} from '@/core/schema/profile-decl';
import { mathProfile } from './math/profile';
import { wenyanProfile } from './wenyan/profile';

// ---------- SubjectId ----------
//
// ADR-0014 subject identity normalization: SubjectId is an open string, not a
// closed union. KnownSubjectId preserves backward compat for exhaustive checks
// on the current subject set.

export type SubjectId = string;
export const KNOWN_SUBJECT_IDS = ['wenyan', 'math'] as const;
export type KnownSubjectId = (typeof KNOWN_SUBJECT_IDS)[number];

// ---------- Question / Judge route kinds (preserved) ----------

export type SubjectQuestionKind =
  | 'short_answer'
  | 'multiple_choice'
  | 'reading'
  | 'translation'
  | 'calculation'
  | 'proof'
  | 'concept_explain'
  | 'word_problem';

export type JudgeRouteKind =
  | 'exact_keyword'
  | 'llm_rubric'
  | 'symbolic_math'
  | 'unit_dimension'
  | 'code_execution'
  | 'speech_audio'
  | 'diagram_handwriting'
  | 'human_review';

// ---------- SubjectProfile ----------

export interface SubjectProfile {
  id: SubjectId;
  version: string;
  displayName: string;
  languageStyle: string;
  questionKinds: SubjectQuestionKind[];
  judgePolicy: {
    preferredRoutes: JudgeRouteKind[];
    notes: string[];
  };
  exampleSources: string[];
  noteTemplate: {
    definition: string;
    mechanism: string;
    example: string;
    pitfall: string;
    check: string;
  };
  grounding: {
    requirement: string;
    allowedSources: string[];
    uncertaintyPolicy: string;
  };
  promptFragments: {
    roleNoun: string;
    noteExamplePolicy: string;
    variantExamplePolicy: string;
    teachingStyle: string;
    checkQuestionPolicy: string;
    learningIntentPolicy: string;
  };

  // --- ADR-0014 extensions ---
  causeCategories: CauseCategoryDeclarationT[];
  renderConfig: RenderConfigT;
  schedulingHints: SchedulingHintsT;
  judgeCapabilities: string[];
}

// ---------- SubjectRegistry ----------

const DEFAULT_ALIASES: Record<string, SubjectId> = {
  wenyan: 'wenyan',
  classical_chinese: 'wenyan',
  chinese_classics: 'wenyan',
  math: 'math',
  mathematics: 'math',
  maths: 'math',
};

export class SubjectRegistry {
  private profiles = new Map<SubjectId, SubjectProfile>();
  private aliases = new Map<string, SubjectId>();
  private defaultId: SubjectId;

  constructor() {
    // Register built-in profiles
    this.profiles.set('wenyan', wenyanProfile);
    this.profiles.set('math', mathProfile);
    // Register built-in aliases
    for (const [alias, id] of Object.entries(DEFAULT_ALIASES)) {
      this.aliases.set(alias, id);
    }
    this.defaultId = 'wenyan';
  }

  register(profile: SubjectProfile, aliases: string[] = []): void {
    this.profiles.set(profile.id, profile);
    this.aliases.set(profile.id, profile.id);
    for (const alias of aliases) {
      this.aliases.set(alias.toLowerCase(), profile.id);
    }
  }

  resolve(domain?: string | null): SubjectProfile {
    const key = domain?.trim().toLowerCase();
    if (!key) return this.profiles.get(this.defaultId)!;
    const id = this.aliases.get(key) ?? key;
    return this.profiles.get(id) ?? this.profiles.get(this.defaultId)!;
  }

  get(id: SubjectId): SubjectProfile | undefined {
    return this.profiles.get(id);
  }

  listIds(): SubjectId[] {
    return [...this.profiles.keys()];
  }

  listProfiles(): SubjectProfile[] {
    return [...this.profiles.values()];
  }
}

// ---------- Backward compat exports ----------
//
// Existing code imports subjectProfiles, defaultSubjectProfile,
// resolveSubjectProfile. Keep them working via a default registry instance.

const _defaultRegistry = new SubjectRegistry();

export const subjectProfiles: Record<string, SubjectProfile> = Object.fromEntries(
  _defaultRegistry.listProfiles().map((p) => [p.id, p]),
);

export const defaultSubjectProfile = _defaultRegistry.resolve();

export function resolveSubjectProfile(domain?: string | null): SubjectProfile {
  return _defaultRegistry.resolve(domain);
}

export function getDefaultSubjectRegistry(): SubjectRegistry {
  return _defaultRegistry;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/subjects/profile.test.ts -v`
Expected: all tests PASS

- [ ] **Step 5: Run typecheck to catch any broken imports**

Run: `pnpm typecheck`
Expected: PASS. If there are errors, they'll be from code that used `SubjectId` as a literal union in exhaustive switches — fix by adding a `default` case.

- [ ] **Step 6: Commit**

```bash
git add src/subjects/profile.ts tests/subjects/profile.test.ts
git commit -m "feat(subjects): subject identity normalization + SubjectRegistry (ADR-0014)"
```

---

### Task 10: JudgeRouter Compatibility Bridge

**Files:**
- Modify: `src/server/ai/judges/index.ts`
- Modify: `src/server/ai/judges/exact.ts` (add JudgeResultV1 alias)
- Test: add bridge test in `tests/core/capability/judges.test.ts`

The old `judgeRouter()` continues to return `JudgeResult` (v1) so callers don't break. Internally it delegates to the capability registry. New code can call `judgeRouterV2()` or the registry directly.

- [ ] **Step 1: Write the failing test**

Append to `tests/core/capability/judges.test.ts`:

```typescript
import { judgeRouter, judgeRouterV2 } from '@/server/ai/judges';
import type { JudgeResult } from '@/server/ai/judges/exact';

describe('judgeRouter compatibility bridge', () => {
  it('judgeRouter returns v1 shape for exact match', () => {
    const result: JudgeResult = judgeRouter({
      kind: 'exact',
      question: { reference: '虚词' },
      answer: { content: '虚词' },
    });
    expect(result.verdict).toBe('correct');
    expect(result.score).toBe(1);
    expect(typeof result.feedback_md).toBe('string');
    expect(result.evidence_json).toBeDefined();
  });

  it('judgeRouter returns v1 shape for keyword', () => {
    const result = judgeRouter({
      kind: 'keyword',
      question: { keywords: ['abc'] },
      answer: { content: 'abc def' },
    });
    expect(result.verdict).toBe('correct');
  });

  it('judgeRouterV2 returns v2 shape for exact match', () => {
    const result = judgeRouterV2({
      kind: 'exact',
      question: { reference: '虚词' },
      answer: { content: '虚词' },
    });
    expect(result.coarse_outcome).toBe('correct');
    expect(result.score_meaning).toBe('correctness');
    expect(result.capability_ref.id).toBe('exact');
    expect(result.confidence).toBe(1);
  });

  it('judgeRouterV2 returns v2 shape for keyword', () => {
    const result = judgeRouterV2({
      kind: 'keyword',
      question: { keywords: ['abc'] },
      answer: { content: 'abc def' },
    });
    expect(result.coarse_outcome).toBe('correct');
    expect(result.capability_ref.id).toBe('keyword');
  });

  it('unimplemented judge kinds still throw', () => {
    expect(() =>
      judgeRouter({
        kind: 'semantic',
        question: {},
        answer: { content: '' },
      }),
    ).toThrow(/not implemented|not found/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/core/capability/judges.test.ts -t 'judgeRouter compatibility bridge' 2>&1 | tail -5`
Expected: FAIL — `judgeRouterV2` not exported

- [ ] **Step 3: Update `src/server/ai/judges/index.ts`**

Replace the contents of `src/server/ai/judges/index.ts`:

```typescript
// src/server/ai/judges/index.ts
import { getDefaultRegistry } from '@/core/capability/judges';
import type { JudgeResultV2T } from '@/core/schema/capability';
import type { AnswerInput, JudgeResult } from './exact';

export type JudgeKind =
  | 'exact'
  | 'keyword'
  | 'semantic'
  | 'rubric'
  | 'steps'
  | 'multimodal_direct'
  | 'ai_flexible';

export interface JudgeRouterInput {
  kind: JudgeKind;
  question: { reference?: string; keywords?: string[]; [k: string]: unknown };
  answer: AnswerInput;
}

// --- V2: returns JudgeResultV2 via capability registry ---

export function judgeRouterV2(input: JudgeRouterInput): JudgeResultV2T {
  const registry = getDefaultRegistry();
  const runner = registry.resolveJudge(input.kind);
  if (!runner) {
    throw new Error(
      `Judge kind '${input.kind}' not found in capability registry (not implemented)`,
    );
  }
  return runner.run({ question: input.question, answer: input.answer });
}

// --- V1 compat: returns old JudgeResult shape ---
//
// Callers that import judgeRouter() continue to get the old { verdict, score,
// feedback_md, evidence_json } shape. Internally delegates to V2.

function downgradeToV1(v2: JudgeResultV2T): JudgeResult {
  const verdictMap: Record<string, JudgeResult['verdict']> = {
    correct: 'correct',
    partial: 'partial',
    incorrect: 'incorrect',
    unsupported: 'incorrect', // no V1 equivalent; map to incorrect
  };
  return {
    verdict: verdictMap[v2.coarse_outcome] ?? 'incorrect',
    score: v2.score,
    feedback_md: v2.feedback_md,
    evidence_json: v2.evidence_json,
  };
}

export function judgeRouter(input: JudgeRouterInput): JudgeResult {
  return downgradeToV1(judgeRouterV2(input));
}

// Re-exports for backward compat
export { judgeExact } from './exact';
export { judgeKeyword } from './keyword';
export type { JudgeResult, AnswerInput };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/core/capability/judges.test.ts -v`
Expected: all tests PASS

- [ ] **Step 5: Run full test suite to confirm no regressions**

Run: `pnpm vitest run`
Expected: all existing tests PASS — the bridge preserves the old JudgeResult shape.

- [ ] **Step 6: Commit**

```bash
git add src/server/ai/judges/index.ts tests/core/capability/judges.test.ts
git commit -m "feat(judges): JudgeRouter delegates to capability registry + judgeRouterV2 (ADR-0014 §2)"
```

---

### Task 11: Profile Validation Integration Test

**Files:**
- Create: `tests/core/capability/profile-registry-integration.test.ts`

Validates that **real** wenyan and math profiles pass the validator against the **real** default registry. This is the CI guardrail that catches profile-vs-registry drift (Codex R7 §3).

- [ ] **Step 1: Write the test**

```typescript
// tests/core/capability/profile-registry-integration.test.ts
import { getDefaultRegistry } from '@/core/capability/judges';
import { validateProfile } from '@/core/capability/validate-profile';
import { subjectProfiles } from '@/subjects/profile';
import { describe, expect, it } from 'vitest';

describe('Profile ↔ Registry integration', () => {
  const registry = getDefaultRegistry();

  for (const [id, profile] of Object.entries(subjectProfiles)) {
    describe(`${id} profile`, () => {
      it('passes validation against the default registry', () => {
        const result = validateProfile(profile, registry);
        if (!result.valid) {
          // Print errors for debugging before assertion fails
          console.error(`${id} validation errors:`, result.errors);
        }
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('has no deprecation warnings', () => {
        const result = validateProfile(profile, registry);
        expect(result.warnings).toHaveLength(0);
      });
    });
  }
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm vitest run tests/core/capability/profile-registry-integration.test.ts -v`
Expected: all tests PASS — both wenyan and math profiles validate cleanly.

- [ ] **Step 3: Commit**

```bash
git add tests/core/capability/profile-registry-integration.test.ts
git commit -m "test: profile ↔ registry integration validation (Codex R7 §3 CI guardrail)"
```

---

### Task 12: Final Verification + Typecheck

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `pnpm vitest run`
Expected: all tests PASS (existing + new). No regressions.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS — no type errors.

- [ ] **Step 3: Run lint**

Run: `pnpm lint`
Expected: PASS (or only pre-existing warnings).

- [ ] **Step 4: Run format**

Run: `pnpm format`
Expected: formats any new files to Biome style.

- [ ] **Step 5: Final commit if format changed files**

```bash
git add -A
git status
# Only commit if there are format-only changes
git commit -m "style: format new capability registry files"
```

- [ ] **Step 6: Verify commit log**

Run: `git log --oneline -12`
Expected: clean sequence of commits matching the task order.

---

## Dependency Graph

```
Task 1 (ActivityRef) ─────────────────────────────────────────┐
Task 2 (Capability schemas) ──┬── Task 4 (Registry) ──┐      │
Task 3 (Profile-decl schemas) │                        │      │
                              │   Task 5 (Exact cap) ──┤      │
                              │   Task 6 (Keyword cap)─┤      │
                              │                        │      │
                              ├── Task 7 (Profile ext) ┤      │
                              │                        │      │
                              └── Task 8 (Validator) ──┼── Task 11 (Integration)
                                                       │
                                  Task 9 (Normalize) ──┤
                                  Task 10 (Bridge) ────┘
                                                       │
                                  Task 12 (Verify) ────┘
```

Tasks 1-3 are independent and can be done in any order. Tasks 4-6 depend on Task 2. Task 7 depends on Task 3. Tasks 8-10 depend on Tasks 4-7. Task 11 depends on everything. Task 12 is final verification.

---

## What This Plan Does NOT Cover (Deferred to N+2)

- `semantic@1` LLM judge capability
- `external_judge@1` capability
- `question_part` ActivityKind runtime behavior
- `katex@1` renderer capability
- Record-to-proposal evidence loop
- Correction event (`CorrectEventPayload`)
- Event schema migration to profile-scoped cause categories
- Cross-subject scheduling
- Frontend full subject UX overhaul (only minimal render adapter is N+1)
- Pipeline composition in judge routes
