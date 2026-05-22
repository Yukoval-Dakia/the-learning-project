# Math MVP — M2.2 `steps@1` Vision Judge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 替换 M2.1 占位的 `stepsV1Capability.run()`，落实真实 vision LLM 调用 — 学生图+文本 → mimo-v2.5 vision → 结构化输出解析 → JudgeResultV2 (partial credit)；新增 5-10 derivation fixtures + sanity 重判脚本。

**Architecture:**
- M2.1 已经把 capability skeleton + 路由分支 + 占位 unsupported 都落了（见 `src/core/capability/judges/steps.ts`, `src/ai/registry.ts`+task-prompts.ts ↔ `StepsJudgeTask`*尚未*存在, `resolveQuestionJudgeRoute` derivation→steps）。M2.2 不动 capability layer 的同步 `run()` —— 那个 stub 保留作为 type-marker。**真实执行走 `question-contract.ts` 的异步路径**（与 `runSemanticJudge` 平行），由 `runStepsJudge` 调 `runTask('StepsJudgeTask', ...)` 走 LLM 管线。
- `runStepsJudge` 流程：(1) 从 `rubric_json.reference_solution` 解出 expected_signals / final_answer / answer_equivalents；(2) accelerator — 学生打字 final_answer 命中 answer_equivalents 直接 final_match=true 不调 LLM；(3) 否则从 R2 抓 image_refs → base64 → `runTask('StepsJudgeTask', { text, images }, ctx)` 走 mimo-v2.5 vision；(4) `StepsLlmOutput` Zod parse；(5) 分数合成（step_weight=0.6）+ coarse_outcome 阈值映射 → JudgeResultV2。
- Cost ledger 由 `runTask` 自动写（runner.ts:296-310）—— 无需 M2.2 额外接线。
- Sanity check 是独立脚本 (`scripts/sanity-vision-rejudge.ts`)，不进 CI 默认套，验证 mimo 同图重判 3 次分差 <0.1。

**Tech Stack:** mimo-v2.5（vision-validated by M0 preflight）/ @anthropic-ai/claude-agent-sdk / Zod / Postgres testcontainer / R2 client (S3-compatible) / Vitest

**Spec source:** `docs/superpowers/specs/2026-05-21-math-mvp-vision-design.md` §3 Phase M2 + §7.4 (流程) + §7.5 (稳定性防线)

**User decisions (2026-05-22):**
- `step_weight = 0.6`（step-biased — derivation 测多步认知；spec §14 open question resolved）
- vision model = `mimo-v2.5`（M0 preflight 已验证，省 token；如 partial credit 误判率高 M2.3 升 pro）

**Spec deltas observed:**
- Spec §7.3 manifest 的 `costTier: 'llm-rubric'` → M2.1 已用 `cost_class: 'expensive_llm'`；M2.2 不动。
- Spec §7.4 流程示意 `extracted_steps` / `signal_verdicts` 长度对齐 expected_signals → Zod parse 阶段做 schema check + runtime length 校验。
- Spec §7.4 Output `final_answer_match` 在 accelerator 命中时由 deterministic 比对得出，不调 LLM — 这条 spec §7.5 #2 写明，按此实现。

**Boundaries (M2.2 不做):**
- KaTeX 渲染（M2.3）
- review/note/teaching surface UI 接入（M2.3）
- partial credit UI 显示（M2.3）
- appeal flow（M2.3）
- 同图重判自动 CI 化（M3+）

---

## File Structure

### Create
- `src/server/ai/judges/steps-judge.ts` — `runStepsJudge` 异步执行入口（image fetch + accelerator + LLM call + score 合成）
- `src/server/ai/judges/steps-judge.test.ts` — unit tests：accelerator / 分数合成 / 输入构造 / 错误兜底（mock LLM + mock R2）
- `subjects/math/fixtures/derivation-data.json` — 5 道 derivation fixture（含 reference_solution shape）
- `subjects/math/fixtures/derivation.ts` — fixture loader + Zod parse
- `subjects/math/fixtures/derivation.test.ts` — fixture schema validation
- `subjects/math/fixtures/derivation.e2e.test.ts` — e2e smoke：seed → resolveRoute=steps → runStepsJudge mock → JudgeResultV2 with partial credit
- `scripts/sanity-vision-rejudge.ts` — 独立脚本：同图答案 3 次重判，分差 <0.1 报告（不进 CI 默认套）

### Modify
- `src/core/schema/business.ts:159-170` — Rubric Zod schema 加 optional `reference_solution`
- `src/ai/registry.ts` — 加 `StepsJudgeTask`（vision-multimodal, mimo-v2.5, budget timeout 90s）
- `src/ai/task-prompts.ts` — 加 `buildStepsJudgePrompt(profile)` builder + switch case
- `src/server/ai/judges/question-contract.ts:10` — `RUNNABLE_ROUTES` 加 `'steps'`；新增 `runStepsJudge` 分支
- `app/api/_/seed/math/route.ts` — 一并 seed derivation fixtures

### Test (modify)
- `src/server/ai/judges/question-contract.test.ts` — M2.1 derivation→steps unsupported 测试要 flip：现在应该 routable，行为按 LLM mock 结果决定
- `src/ai/task-prompts.test.ts` — StepsJudgeTask 在 exhaustiveness suite 自动覆盖；加 1 个 case 验 prompt 含 expected_signals 占位词

---

## Phase M2.2 — Vision Judge Implementation

### Task 1: `Rubric` schema 加 `reference_solution`

**Files:**
- Modify: `src/core/schema/business.ts:159-170`

- [ ] **Step 1: 加 import + extend Rubric**

Find `src/core/schema/business.ts:159-170`:

```ts
export const Rubric = z.object({
  criteria: z.array(
    z.object({
      name: z.string(),
      weight: z.number(),
      descriptor: z.string(),
    }),
  ),
  keywords: z.array(z.string().min(1)).optional(),
  acceptable_answers: z.array(z.string().min(1)).optional(),
  required_points: z.array(z.string().min(1)).optional(),
});
```

Replace with:

```ts
// M2.2 (2026-05-22): reference_solution for steps@1 judge.
// expected_signals: 步骤应当体现的核心信号；final_answer: 标答；
// answer_equivalents: 学生打字提交时加速比对的等价表达。
// See src/core/capability/judges/steps.ts (StepsReferenceSolution).
export const RubricReferenceSolution = z.object({
  expected_signals: z.array(z.string().min(1)).min(1),
  final_answer: z.string().min(1),
  answer_equivalents: z.array(z.string().min(1)).default([]),
});

export const Rubric = z.object({
  criteria: z.array(
    z.object({
      name: z.string(),
      weight: z.number(),
      descriptor: z.string(),
    }),
  ),
  keywords: z.array(z.string().min(1)).optional(),
  acceptable_answers: z.array(z.string().min(1)).optional(),
  required_points: z.array(z.string().min(1)).optional(),
  reference_solution: RubricReferenceSolution.optional(),
});
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS — addition is optional, no consumer breakage.

- [ ] **Step 3: Commit**

```bash
git add src/core/schema/business.ts
git commit -m "feat(schema): Rubric += reference_solution (steps@1 contract)"
```

---

### Task 2: 注册 `StepsJudgeTask` + 加 prompt builder

**Files:**
- Modify: `src/ai/registry.ts`
- Modify: `src/ai/task-prompts.ts`

- [ ] **Step 1: 加 StepsJudgeTask 到 registry**

在 `src/ai/registry.ts` 的 `tasks` 对象里（位置上无关，建议放在 `SemanticJudgeTask` 后面以利分组），加入：

```ts
  StepsJudgeTask: {
    kind: 'StepsJudgeTask',
    description:
      'Math derivation vision-aware step judging — single vision LLM call with structured output (StepsLlmOutput)',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5',
    fallbackChain: [],
    // vision call latency: M0 preflight 7.6s for trivial; derivation prompts will run longer
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 90_000 },
    needsToolCall: false,
    isMultimodal: true,
    allowedTools: [],
    // DEPRECATED (2026-05-22 M1): do not edit. Runtime renders via
    // getTaskSystemPrompt(task, profile) in src/ai/task-prompts.ts; this
    // string is kept only as type-required fallback. New tasks MUST add a
    // builder in task-prompts.ts.
    systemPrompt:
      '你是数学题视觉判分器（vision LLM）。输入：题面 + reference_solution (expected_signals + final_answer) + 学生图/文本步骤/文本 final_answer。严格 JSON 输出 StepsLlmOutput。',
  },
```

- [ ] **Step 2: 加 builder + switch case 到 task-prompts.ts**

在 `src/ai/task-prompts.ts` 顶部 import 区上方（与其它 build* helper 一致位置），加入：

```ts
function buildStepsJudgePrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}视觉判分器。输入 { prompt_md, reference_solution: { expected_signals, final_answer, answer_equivalents }, student_image_refs（图片 0..N 张已附在 user message 中）, student_text_steps?, student_final_answer_text?, step_weight }。
科目上下文：${profile.displayName}。${profile.languageStyle}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}

任务：
1. 从图片 / text_steps / final_answer_text 提取学生的实际作答内容（OCR + 结构理解隐式完成）
2. 对照 reference_solution.expected_signals 逐项判 verdict（correct / partial / wrong / skipped）—— signal_verdicts.length 必须等于 expected_signals.length
3. 比对 final_answer：若学生 final_answer_text 给出，做 deterministic 比对（caller 已处理加速分支，本任务总是会被调一次）；若仅图，从图提取并比对
4. 输出 extracted_steps（自由切分学生步骤，给学习者反馈用，length 不约束）+ extracted_final_answer（图里答案文本化，evidence 用）

严格 JSON 输出（不带 markdown 代码块包裹），shape 名 StepsLlmOutput：
{"extracted_steps":[{"idx":0,"content":"...","verdict":"correct|partial|wrong|skipped","comment":"..."}],"extracted_final_answer":"...","signal_verdicts":[{"signal_idx":0,"verdict":"correct|partial|wrong|skipped","comment":"..."}],"final_answer_match":true|false,"final_answer_comment":"...","confidence":0.0-1.0}

要点：
- verdict 4 选 1；signal_verdicts 顺序必须与 expected_signals 严格对齐（按 index）
- final_answer_match 是 boolean；caller 用它和 signal_verdicts 加权合成 partial credit
- extracted_final_answer 即使图模糊也尽量给出，给学生 evidence 看
- 不确定时 verdict='partial' + 写 comment 说明原因，不要强行判 correct/wrong
- ${profile.grounding.uncertaintyPolicy}
- confidence 反映你判分时的把握，0.5 表示模棱两可
禁止：输出 JSON 之外的文字、verdict 用非合法值、signal_verdicts 长度与 expected_signals 不等。`;
}
```

然后在 `getTaskSystemPrompt` switch 内加 case（按字母顺序大致放在 `'SemanticJudgeTask'` 后或者邻近 vision 任务）：

```ts
    case 'StepsJudgeTask':
      return buildStepsJudgePrompt(profile);
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS — `StepsJudgeTask` 被加到 registry 之后是 TaskKind 的合法值，exhaustive switch 也覆盖。

- [ ] **Step 4: Run exhaustiveness test from M1**

Run: `pnpm vitest run --config vitest.unit.config.ts src/ai/task-prompts.test.ts -t 'exhaustiveness'`
Expected: PASS — `getTaskSystemPrompt` 自动迭代 `Object.keys(tasks)` 覆盖到 `StepsJudgeTask`。

- [ ] **Step 5: Commit**

```bash
git add src/ai/registry.ts src/ai/task-prompts.ts
git commit -m "feat(ai): StepsJudgeTask registration + profile-aware prompt builder"
```

---

### Task 3: `runStepsJudge` 核心 — image fetch + accelerator + LLM + score 合成

**Files:**
- Create: `src/server/ai/judges/steps-judge.ts`

- [ ] **Step 1: Read 现有 runSemanticJudge 作为参照**

Run: `grep -n 'runSemanticJudge\|semanticInput' src/server/ai/judges/question-contract.ts | head -10`

Expected: 看到 `runSemanticJudge`（async）/ `semanticInput`（payload builder）/ `defaultRunTaskFn`（importer for runner）三个引用点。

- [ ] **Step 2: 创建 steps-judge.ts**

```ts
import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { source_asset } from '@/db/schema';
import { Rubric } from '@/core/schema/business';
import type { JudgeResultV2T } from '@/core/schema/capability';
import { StepsLlmOutput, type StepsLlmOutputT } from '@/core/capability/judges/steps';
import type { SubjectProfile } from '@/subjects/profile';
import type { JudgeQuestionRow } from './question-contract';

const CAPABILITY_REF = { id: 'steps', version: '1.0.0' };
const STEP_WEIGHT_DEFAULT = 0.6;
const VERDICT_WEIGHT: Record<StepsLlmOutputT['signal_verdicts'][number]['verdict'], number> = {
  correct: 1,
  partial: 0.5,
  wrong: 0,
  skipped: 0,
};

export interface StepsRunTaskFn {
  (
    kind: string,
    input: { text: string; images: Array<{ data: string; mediaType: string }> } | unknown,
    ctx: unknown,
  ): Promise<{ text: string }>;
}

export interface StepsImageFetchFn {
  (assetIds: string[], db: Db): Promise<Array<{ data: string; mediaType: string }>>;
}

export interface RunStepsJudgeParams {
  db: Db;
  question: JudgeQuestionRow;
  answer_md: string;
  subjectProfile: SubjectProfile;
  runTaskFn?: StepsRunTaskFn;
  imageFetchFn?: StepsImageFetchFn;
}

function unsupportedResult(reason: string, evidence: Record<string, unknown>): JudgeResultV2T {
  return {
    score: null,
    score_meaning: 'steps_v1_weighted',
    coarse_outcome: 'unsupported',
    confidence: 0,
    capability_ref: CAPABILITY_REF,
    feedback_md: `steps@1 judge unsupported: ${reason}`,
    evidence_json: evidence,
  };
}

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

/**
 * Default R2 image fetcher: for each asset_id, look up storage_key + mime,
 * fetch bytes via getR2().get(key), base64-encode.
 *
 * Splits as an injectable so tests can stub.
 */
export async function defaultImageFetch(
  assetIds: string[],
  db: Db,
): Promise<Array<{ data: string; mediaType: string }>> {
  if (assetIds.length === 0) return [];
  const { getR2 } = await import('@/server/r2');
  const r2 = getR2();
  const out: Array<{ data: string; mediaType: string }> = [];
  for (const id of assetIds) {
    const [row] = await db
      .select({ storage_key: source_asset.storage_key, mime_type: source_asset.mime_type })
      .from(source_asset)
      .where(eq(source_asset.id, id));
    if (!row) continue;
    const bytes = await r2.get(row.storage_key);
    if (!bytes) continue;
    out.push({
      data: Buffer.from(bytes).toString('base64'),
      mediaType: row.mime_type,
    });
  }
  return out;
}

function parseReferenceSolution(rubric_json: unknown): ReturnType<
  typeof Rubric.safeParse
> extends { success: true; data: infer R }
  ? R extends { reference_solution?: infer S }
    ? S
    : never
  : never
| null {
  const parsed = Rubric.safeParse(rubric_json);
  if (!parsed.success) return null as never;
  return (parsed.data.reference_solution ?? null) as never;
}

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('steps judge output did not contain a JSON object');
  }
  return JSON.parse(text.slice(start, end + 1));
}

function composeJudgeResult(
  output: StepsLlmOutputT,
  stepWeight: number,
  imageRefs: string[],
): JudgeResultV2T {
  // verdict_weight aggregation
  const N = output.signal_verdicts.length;
  const stepScoreRaw =
    N === 0
      ? 0
      : output.signal_verdicts.reduce((acc, sv) => acc + (VERDICT_WEIGHT[sv.verdict] ?? 0), 0) / N;
  const finalScore = output.final_answer_match ? 1 : 0;
  const score = stepWeight * stepScoreRaw + (1 - stepWeight) * finalScore;

  const evidence = {
    extracted_steps: output.extracted_steps,
    extracted_final_answer: output.extracted_final_answer,
    signal_verdicts: output.signal_verdicts,
    final_answer_comment: output.final_answer_comment,
    step_score_raw: stepScoreRaw,
    step_weight: stepWeight,
    image_refs: imageRefs,
  };

  if (score >= 0.85) {
    return {
      score: Math.min(1, Math.max(0.85, score)),
      score_meaning: 'steps_v1_weighted',
      coarse_outcome: 'correct',
      confidence: output.confidence,
      capability_ref: CAPABILITY_REF,
      feedback_md: output.final_answer_comment || '步骤与答案均合格。',
      evidence_json: evidence,
    };
  }
  if (score > 0) {
    return {
      score: Math.min(0.84, Math.max(0.01, score)),
      score_meaning: 'steps_v1_weighted',
      coarse_outcome: 'partial',
      confidence: output.confidence,
      capability_ref: CAPABILITY_REF,
      feedback_md: output.final_answer_comment || '部分步骤命中。',
      evidence_json: evidence,
    };
  }
  return {
    score: 0,
    score_meaning: 'steps_v1_weighted',
    coarse_outcome: 'incorrect',
    confidence: output.confidence,
    capability_ref: CAPABILITY_REF,
    feedback_md: output.final_answer_comment || '步骤与答案均未命中。',
    evidence_json: evidence,
  };
}

export async function runStepsJudge(params: RunStepsJudgeParams): Promise<JudgeResultV2T> {
  const refParsed = Rubric.safeParse(params.question.rubric_json);
  const referenceSolution = refParsed.success ? refParsed.data.reference_solution : null;
  if (!referenceSolution) {
    return unsupportedResult('reference_solution missing from rubric_json', {
      question_id: params.question.id,
    });
  }

  const imageRefs = params.question.image_refs ?? [];

  // Accelerator: deterministic final_answer match — skip LLM call.
  // Spec §7.5 #2: 学生主动打字 + answer_equivalents 命中时直接 final_match=true。
  const studentFinalText = params.answer_md.trim();
  if (studentFinalText.length > 0 && referenceSolution.answer_equivalents.length > 0) {
    const studentNorm = normalize(studentFinalText);
    const hit =
      normalize(referenceSolution.final_answer) === studentNorm ||
      referenceSolution.answer_equivalents.some((eq) => normalize(eq) === studentNorm);
    if (hit) {
      // Accelerator path: only the final_answer signal is reflected; signal_verdicts
      // are unknown without LLM, so we credit step portion as fully unknown.
      // Convention: zero out step_score_raw (we have NO step evidence), let
      // (1 - step_weight) * 1 score the final portion. With step_weight=0.6 this
      // means score = 0.4 — partial only. To reach 'correct' the LLM path is
      // required; this is conservative and intentional.
      const score = (1 - STEP_WEIGHT_DEFAULT) * 1;
      return {
        score: Math.min(0.84, Math.max(0.01, score)),
        score_meaning: 'steps_v1_weighted',
        coarse_outcome: 'partial',
        confidence: 0.9,
        capability_ref: CAPABILITY_REF,
        feedback_md:
          '最终答案匹配，但未提交步骤；仅按 final_answer 给分。完整批改需要看到推导过程。',
        evidence_json: {
          accelerator: 'final_answer_match',
          student_final_answer_text: studentFinalText,
          reference_final_answer: referenceSolution.final_answer,
          image_refs: imageRefs,
          step_score_raw: null,
          step_weight: STEP_WEIGHT_DEFAULT,
        },
      };
    }
  }

  // LLM path
  const imageFetchFn = params.imageFetchFn ?? defaultImageFetch;
  let images: Array<{ data: string; mediaType: string }> = [];
  try {
    images = await imageFetchFn(imageRefs, params.db);
  } catch (err) {
    return unsupportedResult('image fetch failed', {
      error: err instanceof Error ? err.message : String(err),
      image_refs: imageRefs,
    });
  }

  const llmTextPayload = JSON.stringify({
    prompt_md: params.question.prompt_md,
    reference_solution: referenceSolution,
    student_text_steps: undefined,
    student_final_answer_text: studentFinalText || undefined,
    step_weight: STEP_WEIGHT_DEFAULT,
    image_count: images.length,
  });

  const runTaskFn = params.runTaskFn ?? defaultRunTaskFn;
  let llmText: string;
  try {
    const result = await runTaskFn(
      'StepsJudgeTask',
      { text: llmTextPayload, images },
      { db: params.db, subjectProfile: params.subjectProfile },
    );
    llmText = result.text;
  } catch (err) {
    return unsupportedResult('LLM call failed', {
      error: err instanceof Error ? err.message : String(err),
      image_refs: imageRefs,
    });
  }

  let parsed: StepsLlmOutputT;
  try {
    parsed = StepsLlmOutput.parse(extractJsonObject(llmText));
  } catch (err) {
    return unsupportedResult('LLM output did not match StepsLlmOutput schema', {
      error: err instanceof Error ? err.message : String(err),
      raw_text: llmText,
    });
  }

  // Runtime invariant: signal_verdicts.length must equal expected_signals.length.
  if (parsed.signal_verdicts.length !== referenceSolution.expected_signals.length) {
    return unsupportedResult('signal_verdicts length mismatch', {
      expected: referenceSolution.expected_signals.length,
      got: parsed.signal_verdicts.length,
      image_refs: imageRefs,
    });
  }

  return composeJudgeResult(parsed, STEP_WEIGHT_DEFAULT, imageRefs);
}
```

- [ ] **Step 3: Wire 'steps' into RUNNABLE_ROUTES + dispatch to runStepsJudge**

Modify `src/server/ai/judges/question-contract.ts`. Find:

```ts
const RUNNABLE_ROUTES = new Set<JudgeKind>(['exact', 'keyword', 'semantic']);
```

Replace with:

```ts
const RUNNABLE_ROUTES = new Set<JudgeKind>(['exact', 'keyword', 'semantic', 'steps']);
```

Then find the dispatch block in `judgeAnswer`:

```ts
  if (route === 'semantic') {
    return { route, result: await runSemanticJudge(params) };
  }
```

Add a `steps` dispatch immediately after:

```ts
  if (route === 'semantic') {
    return { route, result: await runSemanticJudge(params) };
  }
  if (route === 'steps') {
    const { runStepsJudge } = await import('./steps-judge');
    return {
      route,
      result: await runStepsJudge({
        db: params.db,
        question: params.question,
        answer_md: params.answer_md,
        subjectProfile: params.subjectProfile,
        runTaskFn: params.runTaskFn,
      }),
    };
  }
```

(`params.runTaskFn` already exists in `JudgeAnswerParams`; type lines up because `StepsRunTaskFn` is a structural superset — both accept `(kind, input, ctx) => Promise<{ text }>`.)

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/ai/judges/steps-judge.ts src/server/ai/judges/question-contract.ts
git commit -m "feat(judge): runStepsJudge vision-aware impl + dispatch from judgeAnswer"
```

---

### Task 4: `runStepsJudge` unit tests — accelerator / score 合成 / 错误路径

**Files:**
- Create: `src/server/ai/judges/steps-judge.test.ts`

- [ ] **Step 1: 写测试**

```ts
import type { Db } from '@/db/client';
import { describe, expect, it, vi } from 'vitest';
import { resolveSubjectProfile } from '@/subjects/profile';
import { runStepsJudge } from './steps-judge';
import type { JudgeQuestionRow } from './question-contract';

const mockDb = {} as Db;
const mathProfile = resolveSubjectProfile('math');

function makeDerivationRow(opts: {
  expected_signals?: string[];
  answer_equivalents?: string[];
  image_refs?: string[];
}): JudgeQuestionRow {
  return {
    id: 'q-d',
    kind: 'derivation',
    prompt_md: '化简 $\\frac{a^2 - b^2}{a - b}$',
    reference_md: '$a + b$',
    rubric_json: {
      criteria: [{ name: 'method', weight: 1, descriptor: 'ok' }],
      reference_solution: {
        expected_signals: opts.expected_signals ?? ['用平方差因式分解', '约去 a−b', '得 a+b'],
        final_answer: 'a + b',
        answer_equivalents: opts.answer_equivalents ?? ['a+b', '(a) + (b)'],
      },
    },
    choices_md: null,
    judge_kind_override: null,
    image_refs: opts.image_refs ?? [],
  };
}

describe('runStepsJudge — accelerator path', () => {
  it('hits accelerator when student final_answer matches answer_equivalents', async () => {
    const runTaskFn = vi.fn();
    const imageFetchFn = vi.fn();
    const result = await runStepsJudge({
      db: mockDb,
      question: makeDerivationRow({}),
      answer_md: 'a+b',
      subjectProfile: mathProfile,
      runTaskFn,
      imageFetchFn,
    });
    expect(runTaskFn).not.toHaveBeenCalled();
    expect(imageFetchFn).not.toHaveBeenCalled();
    expect(result.coarse_outcome).toBe('partial');
    expect(result.evidence_json.accelerator).toBe('final_answer_match');
    // score = (1 - 0.6) * 1 = 0.4
    expect(result.score).toBeCloseTo(0.4, 2);
  });

  it('does NOT hit accelerator when answer differs', async () => {
    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        extracted_steps: [],
        extracted_final_answer: 'wrong',
        signal_verdicts: [
          { signal_idx: 0, verdict: 'wrong', comment: '' },
          { signal_idx: 1, verdict: 'wrong', comment: '' },
          { signal_idx: 2, verdict: 'wrong', comment: '' },
        ],
        final_answer_match: false,
        final_answer_comment: 'no',
        confidence: 0.9,
      }),
    }));
    const imageFetchFn = vi.fn(async () => []);
    const result = await runStepsJudge({
      db: mockDb,
      question: makeDerivationRow({}),
      answer_md: 'not the answer',
      subjectProfile: mathProfile,
      runTaskFn,
      imageFetchFn,
    });
    expect(runTaskFn).toHaveBeenCalledOnce();
    expect(result.coarse_outcome).toBe('incorrect');
  });
});

describe('runStepsJudge — score composition (step_weight=0.6)', () => {
  function llmResponseFromVerdicts(
    verdicts: Array<'correct' | 'partial' | 'wrong' | 'skipped'>,
    finalMatch: boolean,
  ) {
    return {
      text: JSON.stringify({
        extracted_steps: [],
        extracted_final_answer: 'x',
        signal_verdicts: verdicts.map((v, i) => ({ signal_idx: i, verdict: v, comment: '' })),
        final_answer_match: finalMatch,
        final_answer_comment: '',
        confidence: 0.9,
      }),
    };
  }

  it('all 3 signals correct + final match → score 1.0 → correct', async () => {
    const result = await runStepsJudge({
      db: mockDb,
      question: makeDerivationRow({}),
      answer_md: 'this triggers LLM (not in equivalents)',
      subjectProfile: mathProfile,
      runTaskFn: async () => llmResponseFromVerdicts(['correct', 'correct', 'correct'], true),
      imageFetchFn: async () => [],
    });
    // step_score_raw = 1; score = 0.6*1 + 0.4*1 = 1.0
    expect(result.score).toBeCloseTo(1.0, 2);
    expect(result.coarse_outcome).toBe('correct');
  });

  it('2/3 correct steps + final wrong → score 0.4 → partial', async () => {
    const result = await runStepsJudge({
      db: mockDb,
      question: makeDerivationRow({}),
      answer_md: 'foo',
      subjectProfile: mathProfile,
      runTaskFn: async () => llmResponseFromVerdicts(['correct', 'correct', 'wrong'], false),
      imageFetchFn: async () => [],
    });
    // step_score_raw = 2/3 ≈ 0.667; score = 0.6 * 0.667 + 0.4 * 0 = 0.4
    expect(result.score).toBeCloseTo(0.4, 2);
    expect(result.coarse_outcome).toBe('partial');
  });

  it('all wrong + final wrong → score 0 → incorrect', async () => {
    const result = await runStepsJudge({
      db: mockDb,
      question: makeDerivationRow({}),
      answer_md: 'foo',
      subjectProfile: mathProfile,
      runTaskFn: async () => llmResponseFromVerdicts(['wrong', 'wrong', 'wrong'], false),
      imageFetchFn: async () => [],
    });
    expect(result.score).toBe(0);
    expect(result.coarse_outcome).toBe('incorrect');
  });

  it('all partial + final match → score 0.7 → partial', async () => {
    const result = await runStepsJudge({
      db: mockDb,
      question: makeDerivationRow({}),
      answer_md: 'foo',
      subjectProfile: mathProfile,
      runTaskFn: async () => llmResponseFromVerdicts(['partial', 'partial', 'partial'], true),
      imageFetchFn: async () => [],
    });
    // step_score_raw = 0.5; score = 0.6 * 0.5 + 0.4 * 1 = 0.7
    expect(result.score).toBeCloseTo(0.7, 2);
    expect(result.coarse_outcome).toBe('partial');
  });
});

describe('runStepsJudge — error paths', () => {
  it('returns unsupported when reference_solution missing from rubric', async () => {
    const result = await runStepsJudge({
      db: mockDb,
      question: {
        ...makeDerivationRow({}),
        rubric_json: { criteria: [{ name: 'x', weight: 1, descriptor: 'y' }] }, // no reference_solution
      },
      answer_md: 'foo',
      subjectProfile: mathProfile,
      runTaskFn: async () => ({ text: '{}' }),
      imageFetchFn: async () => [],
    });
    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.feedback_md).toContain('reference_solution missing');
  });

  it('returns unsupported when LLM output is non-JSON', async () => {
    const result = await runStepsJudge({
      db: mockDb,
      question: makeDerivationRow({}),
      answer_md: 'foo',
      subjectProfile: mathProfile,
      runTaskFn: async () => ({ text: 'no json here' }),
      imageFetchFn: async () => [],
    });
    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.feedback_md).toContain('did not contain a JSON object');
  });

  it('returns unsupported when signal_verdicts length mismatches expected_signals', async () => {
    const result = await runStepsJudge({
      db: mockDb,
      question: makeDerivationRow({ expected_signals: ['s1', 's2', 's3'] }),
      answer_md: 'foo',
      subjectProfile: mathProfile,
      runTaskFn: async () => ({
        text: JSON.stringify({
          extracted_steps: [],
          extracted_final_answer: '',
          signal_verdicts: [{ signal_idx: 0, verdict: 'correct', comment: '' }],
          final_answer_match: false,
          final_answer_comment: '',
          confidence: 0.5,
        }),
      }),
      imageFetchFn: async () => [],
    });
    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.feedback_md).toContain('signal_verdicts length mismatch');
  });

  it('returns unsupported when LLM call throws', async () => {
    const result = await runStepsJudge({
      db: mockDb,
      question: makeDerivationRow({}),
      answer_md: 'foo',
      subjectProfile: mathProfile,
      runTaskFn: async () => {
        throw new Error('LLM down');
      },
      imageFetchFn: async () => [],
    });
    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.feedback_md).toContain('LLM call failed');
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `pnpm vitest run --config vitest.unit.config.ts src/server/ai/judges/steps-judge.test.ts`
Expected: 11 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/server/ai/judges/steps-judge.test.ts
git commit -m "test(judge): runStepsJudge accelerator / score / error path coverage"
```

---

### Task 5: 修 M2.1 不再适用的 derivation→unsupported 测试

**Files:**
- Modify: `src/server/ai/judges/question-contract.test.ts`

M2.1 加了 3 个 derivation 路由测试。第 3 个 `judgeAnswer returns unsupported for derivation route (M2.1 skeleton)` 现在不再成立 —— `steps` 已经 runnable + 行为由 LLM mock 决定。

- [ ] **Step 1: 改写第 3 个测试**

找 `src/server/ai/judges/question-contract.test.ts` 中：

```ts
  it('judgeAnswer returns unsupported for derivation route (M2.1 skeleton)', async () => {
    const mathProfile = resolveSubjectProfile('math');
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
      subjectProfile: mathProfile,
    });
    expect(result.route).toBe('steps');
    expect(result.result.coarse_outcome).toBe('unsupported');
    expect(result.result.feedback_md).toContain("judge route 'steps' is not implemented");
  });
});
```

Replace with:

```ts
  it('judgeAnswer routes derivation to steps; returns unsupported when rubric lacks reference_solution', async () => {
    // M2.2: 'steps' is now runnable. With no reference_solution in rubric,
    // runStepsJudge short-circuits to unsupported BEFORE any LLM call.
    const mathProfile = resolveSubjectProfile('math');
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
      subjectProfile: mathProfile,
    });
    expect(result.route).toBe('steps');
    expect(result.result.coarse_outcome).toBe('unsupported');
    expect(result.result.feedback_md).toContain('reference_solution missing');
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `pnpm vitest run --config vitest.unit.config.ts src/server/ai/judges/question-contract.test.ts`
Expected: 7 tests PASS (其中第 3 个 derivation 用新断言).

- [ ] **Step 3: Commit**

```bash
git add src/server/ai/judges/question-contract.test.ts
git commit -m "test(judge): M2.2 — derivation routes to steps now runnable (rubric-driven unsupported)"
```

---

### Task 6: 5 道 derivation fixtures + loader + schema test

**Files:**
- Create: `subjects/math/fixtures/derivation-data.json`
- Create: `subjects/math/fixtures/derivation.ts`
- Create: `subjects/math/fixtures/derivation.test.ts`

- [ ] **Step 1: 写 derivation-data.json — 5 道无图 derivation（图片走 M2.3 在 UI 上传）**

注意 M2.2 fixtures 暂不带图（image_refs:[]）— vision LLM 收到 0 张图就只看文本，这是 spec §7.1 "至少一项不为空"的边界场景。带图的 e2e 在 M2.3 加；M2.2 验文本 path 闭环。

```json
{
  "version": "2026-05-22",
  "subject_id": "math",
  "items": [
    {
      "ref": "math-derivation-001",
      "kind": "derivation",
      "prompt_md": "化简 $\\frac{a^2 - b^2}{a - b}$（$a \\neq b$）",
      "reference_md": "用平方差公式因式分解分子：$a^2 - b^2 = (a-b)(a+b)$，约去 $a-b$，得 $a + b$。",
      "rubric_json": {
        "criteria": [{ "name": "method", "weight": 1, "descriptor": "识别平方差并约分" }],
        "reference_solution": {
          "expected_signals": [
            "用平方差公式因式分解分子",
            "约去 a−b",
            "得到 a+b"
          ],
          "final_answer": "a + b",
          "answer_equivalents": ["a+b", "(a+b)", "b + a"]
        }
      },
      "difficulty": 2,
      "knowledge_hint": "平方差公式"
    },
    {
      "ref": "math-derivation-002",
      "kind": "derivation",
      "prompt_md": "求 $\\int (2x + 3) \\, dx$",
      "reference_md": "分项积分：$\\int 2x \\, dx = x^2$；$\\int 3 \\, dx = 3x$；加上常数 $C$ 得 $x^2 + 3x + C$。",
      "rubric_json": {
        "criteria": [{ "name": "method", "weight": 1, "descriptor": "幂法则分项积分" }],
        "reference_solution": {
          "expected_signals": [
            "对 2x 应用幂法则得 x^2",
            "对常数 3 积分得 3x",
            "添加积分常数 C"
          ],
          "final_answer": "x^2 + 3x + C",
          "answer_equivalents": ["x² + 3x + C", "x*x + 3x + C"]
        }
      },
      "difficulty": 2,
      "knowledge_hint": "不定积分"
    },
    {
      "ref": "math-derivation-003",
      "kind": "derivation",
      "prompt_md": "解方程 $2x + 5 = 13$",
      "reference_md": "两边减 5 得 $2x = 8$；两边除 2 得 $x = 4$。",
      "rubric_json": {
        "criteria": [{ "name": "method", "weight": 1, "descriptor": "等式两边同操作" }],
        "reference_solution": {
          "expected_signals": ["两边减去 5", "两边除以 2", "得到 x = 4"],
          "final_answer": "x = 4",
          "answer_equivalents": ["x=4", "4", "x = 4"]
        }
      },
      "difficulty": 1,
      "knowledge_hint": "一元一次方程"
    },
    {
      "ref": "math-derivation-004",
      "kind": "derivation",
      "prompt_md": "求 $f(x) = x^2 + 3x$ 在 $x = 2$ 处的导数。",
      "reference_md": "$f'(x) = 2x + 3$；代入 $x=2$ 得 $f'(2) = 7$。",
      "rubric_json": {
        "criteria": [{ "name": "method", "weight": 1, "descriptor": "幂法则求导后代值" }],
        "reference_solution": {
          "expected_signals": ["对 x^2 求导得 2x", "对 3x 求导得 3", "代入 x=2 得 7"],
          "final_answer": "7",
          "answer_equivalents": ["f'(2) = 7", "= 7", "结果为 7"]
        }
      },
      "difficulty": 2,
      "knowledge_hint": "导数 / 幂法则"
    },
    {
      "ref": "math-derivation-005",
      "kind": "derivation",
      "prompt_md": "已知 $\\log_2 8 = a$，求 $a$。",
      "reference_md": "由 $2^a = 8 = 2^3$，所以 $a = 3$。",
      "rubric_json": {
        "criteria": [{ "name": "method", "weight": 1, "descriptor": "对数定义" }],
        "reference_solution": {
          "expected_signals": ["把对数转写成指数 $2^a = 8$", "$8 = 2^3$", "得 a = 3"],
          "final_answer": "a = 3",
          "answer_equivalents": ["a=3", "3"]
        }
      },
      "difficulty": 1,
      "knowledge_hint": "对数定义"
    }
  ]
}
```

- [ ] **Step 2: 创建 loader + Zod schema validation**

`subjects/math/fixtures/derivation.ts`:

```ts
import { z } from 'zod';
import fixtureData from './derivation-data.json' with { type: 'json' };

export const DerivationFixtureItemSchema = z.object({
  ref: z.string().min(1),
  kind: z.literal('derivation'),
  prompt_md: z.string().min(1),
  reference_md: z.string().min(1),
  rubric_json: z.object({
    criteria: z.array(
      z.object({ name: z.string(), weight: z.number(), descriptor: z.string() }),
    ),
    reference_solution: z.object({
      expected_signals: z.array(z.string().min(1)).min(1),
      final_answer: z.string().min(1),
      answer_equivalents: z.array(z.string().min(1)),
    }),
  }),
  difficulty: z.number().int().min(1).max(5),
  knowledge_hint: z.string().min(1),
});
export type DerivationFixtureItem = z.infer<typeof DerivationFixtureItemSchema>;

export const DerivationFixtureFileSchema = z.object({
  version: z.string(),
  subject_id: z.literal('math'),
  items: z.array(DerivationFixtureItemSchema).min(1),
});

export function loadMathDerivationFixtures(): DerivationFixtureItem[] {
  return DerivationFixtureFileSchema.parse(fixtureData).items;
}
```

- [ ] **Step 3: 写 fixture validation test**

`subjects/math/fixtures/derivation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadMathDerivationFixtures } from './derivation';

describe('math derivation fixtures', () => {
  it('loads 5 derivation items', () => {
    const items = loadMathDerivationFixtures();
    expect(items).toHaveLength(5);
  });

  it('every item has reference_solution with non-empty expected_signals', () => {
    const items = loadMathDerivationFixtures();
    for (const it of items) {
      expect(it.rubric_json.reference_solution.expected_signals.length).toBeGreaterThan(0);
      expect(it.rubric_json.reference_solution.final_answer.length).toBeGreaterThan(0);
    }
  });

  it('every item has at least one answer_equivalent', () => {
    const items = loadMathDerivationFixtures();
    for (const it of items) {
      expect(it.rubric_json.reference_solution.answer_equivalents.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 4: 跑测试**

Run: `pnpm vitest run --config vitest.unit.config.ts subjects/math/fixtures/derivation.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add subjects/math/fixtures/derivation-data.json subjects/math/fixtures/derivation.ts subjects/math/fixtures/derivation.test.ts
git commit -m "feat(math): 5 derivation fixtures + loader + schema validation"
```

---

### Task 7: math seed endpoint 写 derivation fixtures

**Files:**
- Modify: `app/api/_/seed/math/route.ts`

- [ ] **Step 1: 读现有 seed route 结构**

Run: `head -50 app/api/_/seed/math/route.ts`
Expected: 看到现有 POST handler，处理 choice + fill_blank。

- [ ] **Step 2: 合入 derivation seed 循环**

找到现有 loop（应在文件中部，循环处理 `fixtures`）。在 choice/fill_blank fixtures 处理后，加 derivation 处理：

```ts
import { loadMathDerivationFixtures } from '../../../../../subjects/math/fixtures/derivation';
// ... existing imports

// 在已有 fixtures loop 结束后：
const derivationFixtures = loadMathDerivationFixtures();
for (const item of derivationFixtures) {
  const existing = await db
    .select({ id: question.id, metadata: question.metadata })
    .from(question);
  const dup = existing.find(
    (q) => (q.metadata as { fixture_ref?: string } | null)?.fixture_ref === item.ref,
  );
  if (dup) {
    skipped.push(item.ref);
    continue;
  }

  const id = createId();
  await db.insert(question).values({
    id,
    kind: item.kind, // 'derivation'
    prompt_md: item.prompt_md,
    reference_md: item.reference_md,
    choices_md: null,
    rubric_json: item.rubric_json,
    knowledge_ids: [rootKnowledgeId],
    difficulty: item.difficulty,
    source: 'math_fixture',
    variant_depth: 0,
    figures: [],
    image_refs: [],
    structured: null,
    metadata: { fixture_ref: item.ref, knowledge_hint: item.knowledge_hint },
    created_at: now,
    updated_at: now,
    version: 0,
  });
  created.push(id);
}
```

(Note: `rootKnowledgeId` is the same `k-math-seed-root` defined earlier in the file.)

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/api/_/seed/math/route.ts
git commit -m "feat(seed): math seed endpoint + 5 derivation fixtures"
```

---

### Task 8: E2E smoke — derivation fixture → judgeAnswer → JudgeResultV2

**Files:**
- Create: `subjects/math/fixtures/derivation.e2e.test.ts`

- [ ] **Step 1: 写 e2e smoke**

```ts
import { describe, expect, it, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/tests/test-db';
import { question } from '@/db/schema';
import { judgeAnswer, type JudgeQuestionRow } from '@/server/ai/judges/question-contract';
import { resolveSubjectProfile } from '@/subjects/profile';
import { loadMathDerivationFixtures } from './derivation';

describe('math derivation e2e (M2.2)', () => {
  const mathProfile = resolveSubjectProfile('math');

  beforeAll(async () => {
    const fixtures = loadMathDerivationFixtures();
    const now = new Date();
    for (const item of fixtures) {
      await testDb.insert(question).values({
        id: `q-deriv-${item.ref}`,
        kind: item.kind,
        prompt_md: item.prompt_md,
        reference_md: item.reference_md,
        choices_md: null,
        rubric_json: item.rubric_json,
        knowledge_ids: [],
        difficulty: item.difficulty,
        source: 'math_fixture_test',
        variant_depth: 0,
        figures: [],
        image_refs: [],
        structured: null,
        metadata: { fixture_ref: item.ref },
        created_at: now,
        updated_at: now,
        version: 0,
      });
    }
  });

  it('accelerator path: student types final answer that hits answer_equivalents', async () => {
    const [row] = await testDb
      .select()
      .from(question)
      .where(eq(question.id, 'q-deriv-math-derivation-003'));
    const judgeRow: JudgeQuestionRow = {
      id: row.id,
      kind: row.kind,
      prompt_md: row.prompt_md,
      reference_md: row.reference_md,
      rubric_json: row.rubric_json,
      choices_md: row.choices_md,
      judge_kind_override: row.judge_kind_override,
      image_refs: row.image_refs,
    };
    // fixture 003 has answer_equivalents = ['x=4', '4', 'x = 4']
    const result = await judgeAnswer({
      db: testDb,
      question: judgeRow,
      answer_md: 'x=4',
      subjectProfile: mathProfile,
      runTaskFn: async () => {
        throw new Error('accelerator should not call LLM');
      },
    });
    expect(result.route).toBe('steps');
    expect(result.result.coarse_outcome).toBe('partial');
    expect(result.result.evidence_json.accelerator).toBe('final_answer_match');
  });

  it('LLM path: student answer not in equivalents — calls mock LLM, partial credit composed', async () => {
    const [row] = await testDb
      .select()
      .from(question)
      .where(eq(question.id, 'q-deriv-math-derivation-002'));
    const judgeRow: JudgeQuestionRow = {
      id: row.id,
      kind: row.kind,
      prompt_md: row.prompt_md,
      reference_md: row.reference_md,
      rubric_json: row.rubric_json,
      choices_md: row.choices_md,
      judge_kind_override: row.judge_kind_override,
      image_refs: row.image_refs,
    };
    const result = await judgeAnswer({
      db: testDb,
      question: judgeRow,
      answer_md: '我尝试做但不确定',
      subjectProfile: mathProfile,
      runTaskFn: async () => ({
        text: JSON.stringify({
          extracted_steps: [{ idx: 0, content: '2x→x^2', verdict: 'correct', comment: '' }],
          extracted_final_answer: 'x^2 + 3x',
          // fixture 002 has 3 expected_signals
          signal_verdicts: [
            { signal_idx: 0, verdict: 'correct', comment: '' },
            { signal_idx: 1, verdict: 'correct', comment: '' },
            { signal_idx: 2, verdict: 'wrong', comment: '缺常数 C' },
          ],
          final_answer_match: false,
          final_answer_comment: 'missing +C',
          confidence: 0.8,
        }),
      }),
    });
    expect(result.route).toBe('steps');
    // step_score_raw = 2/3 ≈ 0.667; score = 0.6*0.667 + 0.4*0 ≈ 0.4 → partial
    expect(result.result.coarse_outcome).toBe('partial');
    expect(result.result.score).toBeCloseTo(0.4, 1);
    expect(result.result.evidence_json.signal_verdicts).toBeDefined();
  });
});
```

(`testDb` import path may differ — search the project's existing test DB helper if `@/tests/test-db` doesn't resolve; common patterns are `tests/helpers/db.ts` exporting `testDb()` function.)

- [ ] **Step 2: 跑 e2e**

Run: `pnpm vitest run --config vitest.db.config.ts subjects/math/fixtures/derivation.e2e.test.ts`
Expected: 2 tests PASS — accelerator + LLM path 都跑通。

If `@/tests/test-db` not found, mirror the helper used in existing math fixtures e2e (`subjects/math/fixtures/e2e.smoke.test.ts`). Replace with whatever pattern works there.

- [ ] **Step 3: Commit**

```bash
git add subjects/math/fixtures/derivation.e2e.test.ts
git commit -m "test(math): derivation e2e — accelerator + LLM mock partial credit"
```

---

### Task 9: Sanity check script — 同图重判 3 次分差 <0.1

**Files:**
- Create: `scripts/sanity-vision-rejudge.ts`

- [ ] **Step 1: 创建脚本**

```ts
// scripts/sanity-vision-rejudge.ts
/**
 * Sanity check: 同一道 derivation 题（无图，纯文本步骤）走 runStepsJudge 3 次，
 * 报告 3 个 score 的最大分差。spec §3 M2 #7 exit criteria：< 0.1。
 *
 * 不进 CI 默认套（CI 跑会消耗真实 vision LLM quota）；phase exit 前手动跑：
 *   pnpm tsx scripts/sanity-vision-rejudge.ts
 *
 * Exit codes:
 *   0 — 分差 < 0.1，sanity 通过
 *   1 — 分差 >= 0.1，vision LLM 输出不稳定，phase M2 须停下复核
 *   2 — env 配置缺失 / 调用失败
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadMathDerivationFixtures } from '../subjects/math/fixtures/derivation';
import { runStepsJudge } from '../src/server/ai/judges/steps-judge';
import { resolveSubjectProfile } from '../src/subjects/profile';
import type { JudgeQuestionRow } from '../src/server/ai/judges/question-contract';
import type { Db } from '../src/db/client';

const OUT_DIR = resolve(process.cwd(), 'docs/preflight');
const OUT_FILE = resolve(OUT_DIR, `${new Date().toISOString().slice(0, 10)}-vision-rejudge.json`);

async function main() {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.ANTHROPIC_MODEL) {
    console.error('Missing ANTHROPIC_API_KEY / ANTHROPIC_MODEL env');
    process.exit(2);
  }

  const fixtures = loadMathDerivationFixtures();
  const fixture = fixtures[0]; // math-derivation-001 (平方差)
  const judgeRow: JudgeQuestionRow = {
    id: 'sanity-rejudge',
    kind: 'derivation',
    prompt_md: fixture.prompt_md,
    reference_md: fixture.reference_md,
    rubric_json: fixture.rubric_json,
    choices_md: null,
    judge_kind_override: null,
    image_refs: [],
  };

  const studentAnswer = '分子写成 (a-b)(a+b)，约去 a-b，得 a+b';
  const mathProfile = resolveSubjectProfile('math');
  const mockDb = {} as Db;

  const scores: number[] = [];
  const results: unknown[] = [];
  for (let i = 0; i < 3; i++) {
    const start = Date.now();
    const result = await runStepsJudge({
      db: mockDb,
      question: judgeRow,
      answer_md: studentAnswer,
      subjectProfile: mathProfile,
      imageFetchFn: async () => [], // 无图
    });
    results.push({
      iteration: i + 1,
      elapsed_ms: Date.now() - start,
      score: result.score,
      coarse_outcome: result.coarse_outcome,
      confidence: result.confidence,
      evidence_json: result.evidence_json,
    });
    if (typeof result.score === 'number') scores.push(result.score);
  }

  const maxDiff =
    scores.length > 1 ? Math.max(...scores) - Math.min(...scores) : Number.POSITIVE_INFINITY;
  const pass = maxDiff < 0.1;

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    OUT_FILE,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        fixture_ref: fixture.ref,
        student_answer: studentAnswer,
        scores,
        max_diff: maxDiff,
        threshold: 0.1,
        pass,
        runs: results,
      },
      null,
      2,
    ),
  );

  console.log(`Sanity rejudge: ${pass ? 'PASS' : 'FAIL'}`);
  console.log(`Scores: ${scores.map((s) => s.toFixed(3)).join(' / ')}`);
  console.log(`Max diff: ${maxDiff.toFixed(3)} (threshold 0.1)`);
  console.log(`Saved: ${OUT_FILE}`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('Sanity rejudge crashed:', err);
  process.exit(2);
});
```

- [ ] **Step 2: 加 pnpm 脚本入口（package.json）**

Run: `grep -A 1 '"preflight:vision"' package.json` — 看 M0 preflight 脚本位置 + 风格。

Edit `package.json` `scripts` 段，在 `preflight:vision` 后加：

```json
    "sanity:vision-rejudge": "tsx scripts/sanity-vision-rejudge.ts",
```

- [ ] **Step 3: 跑 sanity（人工，phase exit 前；M2.2 PR 不强制跑）**

Run: `pnpm sanity:vision-rejudge`
Expected: PASS（max_diff < 0.1）。

如 FAIL：
- 重新看 `extracted_final_answer` / `signal_verdicts.comment` 的稳定性
- 调 prompt（task-prompts.ts `buildStepsJudgePrompt`）让结构更确定
- 不达标不算 M2.2 blocker，但 spec §3 M2 exit criteria 之一；PR 描述里写明实测分差。

- [ ] **Step 4: Commit script + package.json**

```bash
git add scripts/sanity-vision-rejudge.ts package.json
git commit -m "feat(sanity): vision rejudge script (manual, phase exit gate)"
```

(Sanity check JSON output 不进 commit — `docs/preflight/*-vision-rejudge.json` 添加到 .gitignore 或手动 skip; M0 preflight 同模式。)

---

### Task 10: M2.2 exit gate — typecheck / lint / audit / 全 test

**Files:** (none modified; verification only)

- [ ] **Step 1: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 3: Schema audit**

Run: `pnpm audit:schema`
Expected: PASS — Rubric `reference_solution` 是 jsonb 内字段，schema audit 看的是 schema.ts 列，不会被新增 enum 触发。

- [ ] **Step 4: Partition audit**

Run: `pnpm audit:partition`
Expected: PASS — derivation.e2e.test.ts 在 db config (uses testDb); steps-judge.test.ts 在 unit config (mockDb)。

- [ ] **Step 5: 全 test 套**

Run: `pnpm test 2>&1 | tail -15`
Expected: M2.1 baseline 1128 → M2.2 加：
- steps-judge.test.ts: 11
- derivation.test.ts: 3
- derivation.e2e.test.ts: 2
- question-contract.test.ts: -0（改写第 3 个，总数不变）
- task-prompts.test.ts: -0（exhaustiveness 自动覆盖新 task）
- Expected total ≈ **1144 tests pass** (1128 + 16)。

If any regression, debug before tagging M2.2.

- [ ] **Step 6: Tag M2.2 completion**

```bash
git commit --allow-empty -m "chore: M2.2 phase complete (steps@1 vision judge impl)"
```

---

## Self-Review (run after writing this plan)

**1. Spec coverage:**

| Spec §3 M2 / §7 deliverable | M2.2 scope | Task | Status |
|---|---|---|---|
| `steps@1` capability runtime (vision LLM) | ✓ | Task 3 (runStepsJudge) | ✓ |
| `JudgeResultV2` partial credit + capabilityRef + evidence | ✓ | Task 3 (composeJudgeResult) | ✓ |
| Accelerator: text final_answer match → skip LLM | ✓ | Task 3 + Task 4 unit test | ✓ |
| Structured output Zod parse | ✓ | Task 3 (StepsLlmOutput parse) + length invariant | ✓ |
| 5-10 derivation fixtures | 5 in M2.2 (扩展到 10 视 M2.3 加图后) | Task 6 | ✓ partial |
| Student input primitive: images 0..N + text steps + final | answer_md 当 final_answer_text；text_steps 入 LLM payload 未走 → 留 M2.3 UI 接 | Task 3 | ✓ M2.2 范围内 |
| 同图重判 sanity check < 0.1 | ✓ 脚本 | Task 9 | ✓ |
| `appealable: true` 流转 | deferred M2.3 | — | (out of scope) |
| KaTeX 3 surface | deferred M2.3 | — | (out of scope) |
| UI judge route reason | deferred M2.3 | — | (out of scope) |

**2. Placeholder scan:**
- 无 "TBD" / "TODO" / "implement later"。
- Sanity script 显式 exit code 0/1/2 + 阈值写死 0.1。
- 注释里的"M2.3 UI 接"是 phase boundary 标记，不是 placeholder。

**3. Type consistency:**
- `StepsLlmOutputT` 从 M2.1 `src/core/capability/judges/steps.ts` 复用 — 无 schema duplication。
- `StepsReferenceSolutionT` (M2.1) ↔ `RubricReferenceSolution` (Task 1 加) shape 一致：`{ expected_signals, final_answer, answer_equivalents }`。在代码层 `RubricReferenceSolution` 是 Rubric 内嵌 Zod 定义，与 `StepsReferenceSolution` 是不同的 schema 实例（前者用于 DB JSON parse，后者用于 capability layer 内部）。Task 3 `parseReferenceSolution` 从 Rubric parse 出后给 LLM 用 — 字段名一致，互转无成本。
- step_weight 0.6 写死 `STEP_WEIGHT_DEFAULT` in steps-judge.ts；未来想 per-question 可配，加入 Rubric.reference_solution.step_weight（M2.3 + 后）—— 当前留 const 即可。
- VERDICT_WEIGHT 表与 StepsLlmOutput.signal_verdicts.verdict enum 严格对齐：correct/partial/wrong/skipped。

**Fixes applied during self-review:**
- 原 Task 6 计划 5-10 fixtures；考虑 M2.2 走纯文本路径（图片 UI 在 M2.3）+ 每道 fixture 写 expected_signals 很费时间，砍到 5 道。M2.3 加图时再加 5 道（spec 范围保留 5-10）。
- 原 plan 想把"sanity script 跑 PASS"作为 M2.2 exit blocker；改为 phase exit 前手动跑 + PR 描述里写实测分差。理由：mimo API quota 有限；不让 PR CI 燃烧 quota；同时保留人工 gate。
- Task 3 image fetch 默认走 R2，但允许 `imageFetchFn` 注入 — 这是为测试 + 给 M2.3 sanity script 留出空间（spec §7.5 不依赖 R2）。

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-22-math-mvp-m2-2-steps-impl.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Fresh subagent per task + review between tasks, fast iteration via superpowers:subagent-driven-development

**2. Inline Execution** — Execute tasks in this session using superpowers:executing-plans, batch execution with checkpoints

**Which approach?**
