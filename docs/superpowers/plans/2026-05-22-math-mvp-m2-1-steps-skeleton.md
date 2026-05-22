# Math MVP — M2.1 `steps@1` Capability Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `steps@1` capability 落 types / schema / manifest / 占位 runner + 注册到 registry + math profile 接入；judge route 能解析到 `'steps'`，runtime 暂返 `unsupported`（M2.2 替换为真实 vision LLM 实现）。

**Architecture:**
- 既有 `JudgeCapabilityRunner` 接口 + `CapabilityRegistry` Map + `createDefaultRegistry()` 工厂。M2.1 沿用同一 pattern 注册 `stepsV1Capability`：manifest 描述形态，`run()` 暂返 `unsupported` outcome（capability_ref 仍是 `steps@1`，clear marker M2.2 替换的点）。
- `QuestionKind` enum 加 `'derivation'`（math derivation 题型）；`ScoreMeaning` 加 `'steps_v1_weighted'`（M2.2 给 partial credit 用，M2.1 先入 enum，避免 M2.2 改 schema 不报）。
- 新 Zod schemas `StepsJudgeInput` / `StepsLlmOutput` 定义在 `src/core/capability/judges/steps.ts` —— M2.2 拿来 typed parse vision LLM 结构化输出，无需再设计。
- `resolveQuestionJudgeRoute` 加分支：`derivation` + math profile preferredRoutes 含 `'steps'` → 路由 `'steps'`；judgeAnswer 现在的 `RUNNABLE_ROUTES` 不含 steps，自动返 `unsupported` —— M2.1 期望行为。

**Tech Stack:** Zod / TypeScript / Vitest / 现有 capability scaffolding（`src/core/capability/`） / 现有 JudgeKind / QuestionKind / ScoreMeaning enums

**Spec source:** `docs/superpowers/specs/2026-05-21-math-mvp-vision-design.md` §3 Phase M2 + §7 `steps@1` capability 形态

**Spec deltas observed:**
- Spec §3 Phase M2 #4 提"加 `'derivation'` 到 `question.kind`" → 实际改 `QuestionKind` Zod enum at `src/core/schema/business.ts:16-25`。
- Spec §7.4 称 `scoreMeaning: 'steps-v1-weighted'`（hyphen） → 实际 `ScoreMeaning` enum 用 snake_case（`'correctness' / 'mastery_estimate' / 'rubric_weighted' / 'external_verdict'`），M2.1 采用 `'steps_v1_weighted'` 与 codebase 一致。
- Spec §7.3 称 `costTier: 'llm-rubric'` → CapabilityManifest `CostClass` enum 是 `'local' / 'cheap_llm' / 'expensive_llm' / 'external'`；steps@1 用 `'expensive_llm'`（vision LLM call）。
- Spec §7.4 流程内涉及 vision LLM 调用 + 加速分支 + 分数合成 → 这些是 M2.2 实现，M2.1 只落 schema / 占位 stub。

**Boundaries (M2.1 不做):**
- 不实际调用 vision LLM（M2.2）
- 不写 derivation fixtures（M2.2）
- 不做 sanity check 脚本（M2.2 同图重判 3 次）
- 不接 KaTeX 渲染（M2.3）
- 不动 UI surface（M2.3）
- 不实现 appeal event flow（M2.3）

---

## File Structure

### Create
- `src/core/capability/judges/steps.ts` — `stepsV1Capability` runner + Zod schemas for input / LLM output / reference solution
- `src/core/capability/judges/steps.test.ts` — schema parse tests + unsupported runner behavior

### Modify
- `src/core/schema/business.ts:16-25` — `QuestionKind` enum + `'derivation'`
- `src/core/schema/capability.ts:44-49` — `ScoreMeaning` enum + `'steps_v1_weighted'`
- `src/core/capability/judges/index.ts` — register `stepsV1Capability` in `createDefaultRegistry()` + re-export
- `src/subjects/math/profile.ts:100` — `judgeCapabilities` 数组 + `'steps'`
- `src/server/ai/judges/question-contract.ts:99-127` — `resolveQuestionJudgeRoute` 加 derivation case

### Test (modify)
- `src/server/ai/judges/question-contract.test.ts` — 加 case：derivation 题在 math profile 路由到 `'steps'`；judgeAnswer 对 `'steps'` 路由返 unsupported（占位）
- `tests/subjects/profile.test.ts` — 加 case：math profile 含 `'steps'` capability 通过 validateProfile

---

## Phase M2.1 — Capability Skeleton

### Task 1: 扩展 `QuestionKind` + `ScoreMeaning` enums

**Files:**
- Modify: `src/core/schema/business.ts:16-25`
- Modify: `src/core/schema/capability.ts:44-49`

- [ ] **Step 1: 加 `'derivation'` 到 `QuestionKind`**

Find `src/core/schema/business.ts:16-25`:

```ts
export const QuestionKind = z.enum([
  'choice',
  'true_false',
  'fill_blank',
  'short_answer',
  'essay',
  'computation',
  'reading',
  'translation',
]);
```

Replace with:

```ts
export const QuestionKind = z.enum([
  'choice',
  'true_false',
  'fill_blank',
  'short_answer',
  'essay',
  'computation',
  'reading',
  'translation',
  // M2.1 (2026-05-22): math derivation — vision-aware steps@1 judge target.
  // See docs/superpowers/specs/2026-05-21-math-mvp-vision-design.md §7.
  'derivation',
]);
```

- [ ] **Step 2: 加 `'steps_v1_weighted'` 到 `ScoreMeaning`**

Find `src/core/schema/capability.ts:44-49`:

```ts
export const ScoreMeaning = z.enum([
  'correctness',
  'mastery_estimate',
  'rubric_weighted',
  'external_verdict',
]);
```

Replace with:

```ts
export const ScoreMeaning = z.enum([
  'correctness',
  'mastery_estimate',
  'rubric_weighted',
  'external_verdict',
  // M2.1 (2026-05-22): steps@1 capability score meaning.
  // score = step_weight × Σ verdict_weight / N + (1 − step_weight) × (final_answer_match ? 1 : 0)
  // See docs/superpowers/specs/2026-05-21-math-mvp-vision-design.md §7.4.
  'steps_v1_weighted',
]);
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS — enum additions don't break consumers (additive).

- [ ] **Step 4: Commit**

```bash
git add src/core/schema/business.ts src/core/schema/capability.ts
git commit -m "feat(schema): QuestionKind += derivation, ScoreMeaning += steps_v1_weighted"
```

---

### Task 2: 定义 `steps@1` Zod schemas + capability runner stub

**Files:**
- Create: `src/core/capability/judges/steps.ts`

- [ ] **Step 1: 创建文件**

Create `src/core/capability/judges/steps.ts`:

```ts
import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';
import { z } from 'zod';
import type { JudgeCapabilityRunner, JudgeRunInput } from '../types';

// ----------------------------------------------------------------------------
// Schemas — input from judge runner, LLM output, reference solution shape.
// M2.1 defines these so M2.2 (vision LLM impl) can parse / validate without
// re-designing the contract. The shapes follow spec
// docs/superpowers/specs/2026-05-21-math-mvp-vision-design.md §7.
// ----------------------------------------------------------------------------

/**
 * Reference solution shape — comes from the question's rubric_json. For math
 * derivation, the rubric carries:
 *   - expected_signals: 步骤应当体现的核心信号（不是死答案文本）
 *   - final_answer: 最终答案
 *   - answer_equivalents: 学生若打字提交可加速比对的等价表达
 */
export const StepsReferenceSolution = z.object({
  expected_signals: z.array(z.string().min(1)).min(1),
  final_answer: z.string().min(1),
  answer_equivalents: z.array(z.string().min(1)).default([]),
});
export type StepsReferenceSolutionT = z.infer<typeof StepsReferenceSolution>;

/**
 * Judge runner input — what `stepsV1Capability.run()` receives. M2.1 stub
 * does not consume student_* fields beyond shape validation.
 */
export const StepsJudgeInput = z.object({
  prompt_md: z.string().min(1),
  reference_solution: StepsReferenceSolution,
  // M-1 first-class multimodal carriers; image_refs is asset_id list.
  student_image_refs: z.array(z.string().min(1)).default([]),
  student_text_steps: z.array(z.string().min(1)).optional(),
  student_final_answer_text: z.string().optional(),
  // step_weight ∈ [0, 1]. score = step_weight × Σ verdict_weight / N + (1 - step_weight) × (final_match ? 1 : 0)
  step_weight: z.number().min(0).max(1),
});
export type StepsJudgeInputT = z.infer<typeof StepsJudgeInput>;

/**
 * LLM structured output schema — what the vision LLM returns, parsed and
 * validated before composing JudgeResultV2 in M2.2. M2.1 defines the shape
 * so M2.2 wires `runTaskFn('StepsJudgeTask', ...)` against it.
 */
export const StepsLlmOutput = z.object({
  extracted_steps: z.array(
    z.object({
      idx: z.number().int().min(0),
      content: z.string().min(1),
      verdict: z.enum(['correct', 'partial', 'wrong', 'skipped']),
      comment: z.string(),
    }),
  ),
  // LLM 把图里答案转文本 — evidence 用，partial credit 计算不依赖
  extracted_final_answer: z.string(),
  // 一对一对齐 reference_solution.expected_signals（schema 长度由 runner 校验）
  signal_verdicts: z.array(
    z.object({
      signal_idx: z.number().int().min(0),
      verdict: z.enum(['correct', 'partial', 'wrong', 'skipped']),
      comment: z.string(),
    }),
  ),
  final_answer_match: z.boolean(),
  final_answer_comment: z.string(),
  confidence: z.number().min(0).max(1),
});
export type StepsLlmOutputT = z.infer<typeof StepsLlmOutput>;

// ----------------------------------------------------------------------------
// Manifest + runner stub.
// ----------------------------------------------------------------------------

const VERSION = '1.0.0';

const manifest: CapabilityManifestT = {
  id: 'steps',
  kind: 'judge',
  version: VERSION,
  input_schema: 'StepsJudgeInput',
  output_schema: 'JudgeResultV2 (score_meaning=steps_v1_weighted)',
  // Vision LLM call; far above local exact / keyword.
  cost_class: 'expensive_llm',
  // Vision LLM call is sync from the runner's POV (awaited inside runner).
  latency_class: 'sync',
  // Until M2.2 ships the real LLM call + sanity check.
  stability: 'experimental',
};

const CAPABILITY_REF = { id: manifest.id, version: VERSION };

/**
 * M2.1 stub — capability registered, route resolvable, but actual execution
 * still gated behind RUNNABLE_ROUTES in question-contract.ts. judgeAnswer
 * never reaches this run() in M2.1 because RUNNABLE_ROUTES = {exact, keyword,
 * semantic} excludes 'steps'. The stub exists so:
 *   1. CapabilityRegistry can register stepsV1Capability
 *   2. SubjectProfile.judgeCapabilities can reference 'steps' and pass validateProfile
 *   3. M2.2 replaces this body with the vision LLM call without touching the
 *      registry / profile / route layer.
 */
function run(input: JudgeRunInput): JudgeResultV2T {
  return {
    score: null,
    score_meaning: 'steps_v1_weighted',
    coarse_outcome: 'unsupported',
    confidence: 0,
    capability_ref: CAPABILITY_REF,
    feedback_md:
      'steps@1 judge skeleton: vision LLM impl ships in M2.2. See docs/superpowers/plans/2026-05-22-math-mvp-m2-1-steps-skeleton.md.',
    evidence_json: {
      phase: 'M2.1-skeleton',
      reason: 'capability registered but run() not yet implemented',
      question: input.question,
    },
  };
}

export const stepsV1Capability: JudgeCapabilityRunner = { manifest, run };
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/core/capability/judges/steps.ts
git commit -m "feat(capability): steps@1 manifest + Zod schemas + run() stub"
```

---

### Task 3: Failing test — schemas parse + manifest correct

**Files:**
- Create: `src/core/capability/judges/steps.test.ts`

- [ ] **Step 1: 写测试**

Create `src/core/capability/judges/steps.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  StepsJudgeInput,
  StepsLlmOutput,
  StepsReferenceSolution,
  stepsV1Capability,
} from './steps';

describe('StepsReferenceSolution', () => {
  it('parses valid reference solution with all fields', () => {
    const parsed = StepsReferenceSolution.parse({
      expected_signals: ['识别为不定积分', '按幂法则分项积分'],
      final_answer: 'x² + 3x + C',
      answer_equivalents: ['x^2 + 3x + C'],
    });
    expect(parsed.expected_signals).toHaveLength(2);
    expect(parsed.answer_equivalents).toEqual(['x^2 + 3x + C']);
  });

  it('defaults answer_equivalents to []', () => {
    const parsed = StepsReferenceSolution.parse({
      expected_signals: ['signal a'],
      final_answer: '42',
    });
    expect(parsed.answer_equivalents).toEqual([]);
  });

  it('rejects empty expected_signals', () => {
    expect(() =>
      StepsReferenceSolution.parse({
        expected_signals: [],
        final_answer: '42',
      }),
    ).toThrow();
  });
});

describe('StepsJudgeInput', () => {
  it('accepts input with only image_refs (no text steps, no final_answer)', () => {
    const parsed = StepsJudgeInput.parse({
      prompt_md: '求 ∫(2x+3)dx',
      reference_solution: {
        expected_signals: ['幂法则'],
        final_answer: 'x² + 3x + C',
      },
      student_image_refs: ['asset_1'],
      step_weight: 0.4,
    });
    expect(parsed.student_image_refs).toEqual(['asset_1']);
    expect(parsed.student_text_steps).toBeUndefined();
    expect(parsed.student_final_answer_text).toBeUndefined();
  });

  it('accepts input with text steps and final_answer (no images)', () => {
    const parsed = StepsJudgeInput.parse({
      prompt_md: '求 ∫(2x+3)dx',
      reference_solution: {
        expected_signals: ['幂法则'],
        final_answer: 'x² + 3x + C',
      },
      student_image_refs: [],
      student_text_steps: ['∫2x dx = x²', '∫3 dx = 3x'],
      student_final_answer_text: 'x² + 3x + C',
      step_weight: 0.4,
    });
    expect(parsed.student_text_steps).toHaveLength(2);
    expect(parsed.student_final_answer_text).toBe('x² + 3x + C');
  });

  it('rejects step_weight out of range', () => {
    expect(() =>
      StepsJudgeInput.parse({
        prompt_md: 'x',
        reference_solution: { expected_signals: ['s'], final_answer: '42' },
        student_image_refs: [],
        step_weight: 1.5,
      }),
    ).toThrow();
  });
});

describe('StepsLlmOutput', () => {
  it('parses well-formed LLM output', () => {
    const parsed = StepsLlmOutput.parse({
      extracted_steps: [{ idx: 0, content: '∫2x dx = x²', verdict: 'correct', comment: 'ok' }],
      extracted_final_answer: 'x² + 3x + C',
      signal_verdicts: [{ signal_idx: 0, verdict: 'correct', comment: 'shows power rule' }],
      final_answer_match: true,
      final_answer_comment: 'matches',
      confidence: 0.92,
    });
    expect(parsed.signal_verdicts[0].verdict).toBe('correct');
    expect(parsed.confidence).toBe(0.92);
  });

  it('rejects invalid verdict enum value', () => {
    expect(() =>
      StepsLlmOutput.parse({
        extracted_steps: [],
        extracted_final_answer: '',
        signal_verdicts: [{ signal_idx: 0, verdict: 'maybe', comment: '' }],
        final_answer_match: false,
        final_answer_comment: '',
        confidence: 0.5,
      }),
    ).toThrow();
  });
});

describe('stepsV1Capability manifest', () => {
  it('has expected identity + cost class', () => {
    expect(stepsV1Capability.manifest.id).toBe('steps');
    expect(stepsV1Capability.manifest.version).toBe('1.0.0');
    expect(stepsV1Capability.manifest.kind).toBe('judge');
    expect(stepsV1Capability.manifest.cost_class).toBe('expensive_llm');
    expect(stepsV1Capability.manifest.stability).toBe('experimental');
  });

  it('run() returns unsupported skeleton response (M2.1 placeholder)', () => {
    const result = stepsV1Capability.run({
      question: { foo: 'bar' },
      answer: { content: 'student answer' },
    });
    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.score).toBeNull();
    expect(result.score_meaning).toBe('steps_v1_weighted');
    expect(result.capability_ref).toEqual({ id: 'steps', version: '1.0.0' });
    expect(result.feedback_md).toContain('M2.2');
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `pnpm vitest run --config vitest.unit.config.ts src/core/capability/judges/steps.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/core/capability/judges/steps.test.ts
git commit -m "test(capability): steps@1 schemas + manifest + stub run()"
```

---

### Task 4: 注册 `stepsV1Capability` 到 `createDefaultRegistry`

**Files:**
- Modify: `src/core/capability/judges/index.ts`

- [ ] **Step 1: Read 现状（10 行）**

Run: `head -15 src/core/capability/judges/index.ts`

Expected: shows `createDefaultRegistry` with `exactJudgeCapability` and `keywordJudgeCapability` registered.

- [ ] **Step 2: 加 import + 注册**

Replace the file's contents (it's ~22 lines) with:

```ts
import { CapabilityRegistry } from '../registry';
import { exactJudgeCapability } from './exact';
import { keywordJudgeCapability } from './keyword';
import { stepsV1Capability } from './steps';

export function createDefaultRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.registerJudge(exactJudgeCapability);
  registry.registerJudge(keywordJudgeCapability);
  // M2.1 (2026-05-22): steps@1 skeleton — run() returns 'unsupported' until
  // M2.2 wires the vision LLM call. Registration is required so
  // mathProfile.judgeCapabilities = [..., 'steps'] passes validateProfile.
  registry.registerJudge(stepsV1Capability);
  return registry;
}

let defaultRegistry: CapabilityRegistry | null = null;

export function getDefaultRegistry(): CapabilityRegistry {
  if (!defaultRegistry) {
    defaultRegistry = createDefaultRegistry();
  }
  return defaultRegistry;
}

export { exactJudgeCapability } from './exact';
export { keywordJudgeCapability } from './keyword';
export { stepsV1Capability } from './steps';
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Verify registry now has steps@1 — sanity check via existing tests**

Run: `pnpm vitest run --config vitest.unit.config.ts src/core/capability/`
Expected: existing capability tests PASS + new `steps.test.ts` PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/capability/judges/index.ts
git commit -m "feat(capability): register stepsV1Capability in default registry"
```

---

### Task 5: math profile 加 `'steps'` capability

**Files:**
- Modify: `src/subjects/math/profile.ts:100`

- [ ] **Step 1: 加 capability**

Find `src/subjects/math/profile.ts:100`:

```ts
  judgeCapabilities: ['exact', 'keyword'],
};
```

Replace with:

```ts
  // M2.1 (2026-05-22): + 'steps' for derivation question kind.
  // steps@1 capability is registered in default registry; run() body lands in M2.2.
  judgeCapabilities: ['exact', 'keyword', 'steps'],
};
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Add validation regression test**

Find `tests/subjects/profile.test.ts` and append to its main `describe`:

```ts
import { createDefaultRegistry } from '@/core/capability/judges';
import { validateProfile } from '@/core/capability/validate-profile';
import { mathProfile } from '@/subjects/math/profile';

describe('M2.1: mathProfile + steps@1', () => {
  it('mathProfile passes validateProfile against default registry', () => {
    const registry = createDefaultRegistry();
    const result = validateProfile(mathProfile, registry);
    expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('mathProfile.judgeCapabilities includes steps', () => {
    expect(mathProfile.judgeCapabilities).toContain('steps');
  });

  it('default registry exposes steps@1 with experimental stability', () => {
    const registry = createDefaultRegistry();
    const runner = registry.resolveJudge('steps');
    expect(runner).toBeDefined();
    expect(runner?.manifest.version).toBe('1.0.0');
    expect(runner?.manifest.stability).toBe('experimental');
  });
});
```

If `tests/subjects/profile.test.ts` does not already have an outer `describe` to append into, place this new `describe` at the bottom of the file.

- [ ] **Step 4: 跑测试**

Run: `pnpm vitest run --config vitest.unit.config.ts tests/subjects/profile.test.ts`
Expected: new 3 tests PASS + existing tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/subjects/math/profile.ts tests/subjects/profile.test.ts
git commit -m "feat(math): mathProfile.judgeCapabilities += steps + validation test"
```

---

### Task 6: `resolveQuestionJudgeRoute` 路由 `derivation` → `'steps'`

**Files:**
- Modify: `src/server/ai/judges/question-contract.ts:99-127`

- [ ] **Step 1: Update resolveQuestionJudgeRoute**

Find this block at `src/server/ai/judges/question-contract.ts:99-127`:

```ts
export function resolveQuestionJudgeRoute(
  q: JudgeQuestionRow,
  subjectProfile: SubjectProfile,
): JudgeKind {
  const override = parseRoute(q.judge_kind_override);
  if (override) return override;

  // A question with persisted choices is structurally a multiple/single-choice
  // item regardless of the kind string the subject profile uses
  // (e.g. wenyan exposes 'single_choice' / 'multiple_choice' while the
  // QuestionKind enum still calls the canonical kind 'choice'). The structure
  // is the source of truth: if there are choices, the only safe default is
  // exact match against reference_md — never spend LLM budget on a semantic
  // judge for what is fundamentally a string compare.
  const choices = q.choices_md ?? [];
  if (choices.length > 0) return 'exact';

  const kind = QuestionKind.safeParse(q.kind).success ? q.kind : 'short_answer';
  const rubric = parseRubric(q.rubric_json);
  const keywords = nonEmpty(rubric?.keywords);

  if (kind === 'choice' || kind === 'true_false') return 'exact';
  if (kind === 'fill_blank') return keywords.length > 0 ? 'keyword' : 'exact';
  if (kind === 'computation') return keywords.length > 0 ? 'keyword' : 'semantic';
  if (kind === 'short_answer' || kind === 'reading' || kind === 'translation' || kind === 'essay') {
    return isPreferred(subjectProfile, 'semantic') ? 'semantic' : 'keyword';
  }
  return 'exact';
}
```

Add a `derivation` branch immediately after the `computation` branch:

```ts
  if (kind === 'choice' || kind === 'true_false') return 'exact';
  if (kind === 'fill_blank') return keywords.length > 0 ? 'keyword' : 'exact';
  if (kind === 'computation') return keywords.length > 0 ? 'keyword' : 'semantic';
  // M2.1 (2026-05-22): derivation always routes via steps@1 for profiles that
  // declare it (math); other profiles fall back to semantic if preferred, else
  // keyword. judgeAnswer's RUNNABLE_ROUTES gates 'steps' at runtime until M2.2.
  if (kind === 'derivation') {
    if (isPreferred(subjectProfile, 'steps')) return 'steps';
    return isPreferred(subjectProfile, 'semantic') ? 'semantic' : 'keyword';
  }
  if (kind === 'short_answer' || kind === 'reading' || kind === 'translation' || kind === 'essay') {
    return isPreferred(subjectProfile, 'semantic') ? 'semantic' : 'keyword';
  }
  return 'exact';
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: 加路由 regression test**

Append to `src/server/ai/judges/question-contract.test.ts`:

```ts
import { resolveQuestionJudgeRoute } from './question-contract';
import { resolveSubjectProfile } from '@/subjects/profile';

describe('M2.1: resolveQuestionJudgeRoute — derivation kind', () => {
  it('routes derivation to steps for math profile (preferredRoutes includes steps)', () => {
    const route = resolveQuestionJudgeRoute(
      {
        id: 'q-d1',
        kind: 'derivation',
        prompt_md: '求 ∫(2x+3)dx',
        reference_md: 'x² + 3x + C',
        rubric_json: null,
        choices_md: null,
        judge_kind_override: null,
      },
      resolveSubjectProfile('math'),
    );
    expect(route).toBe('steps');
  });

  it('routes derivation to semantic for wenyan profile (no steps in preferredRoutes)', () => {
    const route = resolveQuestionJudgeRoute(
      {
        id: 'q-d2',
        kind: 'derivation',
        prompt_md: 'derivation in wenyan context',
        reference_md: 'ref',
        rubric_json: null,
        choices_md: null,
        judge_kind_override: null,
      },
      resolveSubjectProfile('wenyan'),
    );
    // wenyan profile preferredRoutes does NOT include 'steps' — falls back to semantic
    expect(route).toBe('semantic');
  });

  it('judgeAnswer returns unsupported for derivation route (M2.1 skeleton)', async () => {
    const { judgeAnswer } = await import('./question-contract');
    const result = await judgeAnswer({
      db: mockDb,
      question: {
        id: 'q-d3',
        kind: 'derivation',
        prompt_md: '求导',
        reference_md: 'x',
        rubric_json: null,
        choices_md: null,
        judge_kind_override: null,
      },
      answer_md: '答案',
      subjectProfile: resolveSubjectProfile('math'),
    });
    expect(result.route).toBe('steps');
    expect(result.result.coarse_outcome).toBe('unsupported');
    expect(result.result.feedback_md).toContain("judge route 'steps' is not implemented");
  });
});
```

(`mockDb` is already defined at file top from prior M-1 / M1 tests; reuse.)

- [ ] **Step 4: 跑测试**

Run: `pnpm vitest run --config vitest.unit.config.ts src/server/ai/judges/question-contract.test.ts`
Expected: new 3 tests PASS + existing tests still pass.

- [ ] **Step 5: Verify wenyan profile preferredRoutes does not include 'steps'**

Run: `grep -A 5 "preferredRoutes" src/subjects/wenyan/profile.ts`
Expected: wenyan's preferredRoutes does NOT include 'steps' — if it does, the second test ("routes to semantic") will fail and the test assertion must be flipped.

If wenyan happens to have 'steps' in preferredRoutes (it should not — wenyan has no math derivation), fix the wenyan profile or change the test to use a stub profile that lacks 'steps'.

- [ ] **Step 6: Commit**

```bash
git add src/server/ai/judges/question-contract.ts src/server/ai/judges/question-contract.test.ts
git commit -m "feat(judge): resolveQuestionJudgeRoute routes derivation to steps for math"
```

---

### Task 7: M2.1 exit gate

**Files:** (none modified; verification only)

- [ ] **Step 1: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 3: Schema audit**

Run: `pnpm audit:schema`
Expected: PASS (no schema changes; QuestionKind / ScoreMeaning are enum-only).

- [ ] **Step 4: Partition audit**

Run: `pnpm audit:partition`
Expected: PASS.

- [ ] **Step 5: Full test suite**

Run: `pnpm test 2>&1 | tail -15`
Expected: all green. M1 baseline 1112 → M2.1 adds:
- 8 tests in `steps.test.ts`
- 3 tests in `tests/subjects/profile.test.ts`
- 3 tests in `question-contract.test.ts`
- Expected total: **1126 tests pass** (1112 + 14).

If any pre-existing test regresses, debug before tagging M2.1.

- [ ] **Step 6: Tag M2.1 completion**

```bash
git commit --allow-empty -m "chore: M2.1 phase complete (steps@1 capability skeleton)"
```

---

## Self-Review (run after writing this plan)

**1. Spec coverage:**

| Spec §3 M2 / §7 deliverable | M2.1 scope | Task | Status |
|---|---|---|---|
| `steps@1` capability manifest | ✓ in M2.1 | Task 2 | ✓ |
| `JudgeResultV2` `scoreMeaning: 'steps_v1_weighted'` enum value | ✓ in M2.1 (enum-only) | Task 1 | ✓ |
| KaTeX rendering | deferred to M2.3 | — | (out of M2.1 scope) |
| Math derivation 题型 | enum + route only (M2.1); fixtures M2.2 | Task 1 + Task 6 | ✓ (skeleton) |
| Student input primitive | schema only (StepsJudgeInput); UI M2.3 | Task 2 | ✓ (schema) |
| UI 显示 judge route 选择理由 | deferred to M2.3 | — | (out of M2.1 scope) |
| Sanity check 同图重判 | deferred to M2.2 | — | (out of M2.1 scope) |
| `appealable: true` 流转 | deferred to M2.3 | — | (out of M2.1 scope) |

M2.1 explicit non-goals listed in plan header. Coverage scope = skeleton only.

**2. Placeholder scan:**
- No "TBD" / "TODO" / "implement later".
- All commits concrete.
- Stub `run()` body is intentional (M2.2 replaces); marked with phase comment + feedback_md mentions M2.2.

**3. Type consistency:**
- `stepsV1Capability` exports `{ manifest, run }` matching `JudgeCapabilityRunner` interface (Task 2).
- `StepsJudgeInput.step_weight` is `z.number().min(0).max(1)` consistent with spec §7.4 formula.
- `ScoreMeaning` new value `'steps_v1_weighted'` matches stub `run()` return + spec §7.4 (allowing for hyphen→underscore translation, noted in spec deltas).
- `CAPABILITY_REF` in stub matches `{ id: 'steps', version: '1.0.0' }` consistent with manifest.
- `resolveQuestionJudgeRoute` returns `JudgeKind` (existing); `'steps'` is already in `JudgeKindSchema` enum (no schema change needed).

**Fixes applied during self-review:**
- Task 6 originally tested `judgeAnswer` returns `unsupported` for derivation — but `judgeAnswer` uses `RUNNABLE_ROUTES` (exact / keyword / semantic) to gate. So `steps` route → unsupported is automatic via existing gate logic. No code change needed to RUNNABLE_ROUTES in M2.1. M2.2 will add `'steps'` to RUNNABLE_ROUTES + wire real LLM impl.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-22-math-mvp-m2-1-steps-skeleton.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Fresh subagent per task + review between tasks, fast iteration via superpowers:subagent-driven-development

**2. Inline Execution** — Execute tasks in this session using superpowers:executing-plans, batch execution with checkpoints

**Which approach?**
