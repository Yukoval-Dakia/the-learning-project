# IMPLEMENTATION PLAN — 解题陪练 (Solve-Tutor), YUK-193

**Goal:** Ship a question-centric solve-tutor: open any `question` → (lazy) generate a reference solution + worked solution if missing → optionally get escalating Socratic hints → submit typed steps/answer OR a handwritten photo → AI judges it against the reference solution → reveal the worked solution → on a low score, enroll a mistake (which makes it FSRS-eligible). Net-new = **one AI generator task** + **one orchestrator** + **three routes** + a **thin UI entry**; everything else (judges, teaching turns, attempt/mistake path, asset upload, `JudgeResultPanel`) is reused.

**Architecture:** Next.js 15 App Router route handlers under `app/api/**` delegate to server modules under `src/server/`. AI tasks are registry-declared (`src/ai/registry.ts`) + prompt-built (`src/ai/task-prompts.ts`) and executed through the Claude Agent SDK runner (`src/server/ai/runner.ts` → `runTask`), which logs every run to the AI log (`src/server/ai/log.ts`). Judging routes by `question.kind` through `JudgeInvoker` (`src/server/judge/invoker.ts`) to the shipped `steps@1` / `semantic@1` capabilities. Sessions persist as `learning_session(type='tutor')` (polymorphic envelope, ADR-0008). Attempts are events (`action='attempt'`, ADR-0005); mistakes are `learning_record(kind='mistake')`.

**Tech Stack:** TypeScript, Next.js 15, Drizzle ORM + Postgres, Zod, Claude Agent SDK (xiaomi/mimo endpoint), Vitest, Biome, pnpm. Tests split unit (no-DB) vs db (real Postgres testcontainer; Docker required).

**For agentic workers:** Each task below is TDD: (1) write a failing test, (2) run it and confirm it fails for the expected reason, (3) write the minimal implementation, (4) run it and confirm it passes, (5) commit. Use EXACT file paths and the EXACT commands shown. No-DB tests run with `pnpm vitest run --config vitest.unit.config.ts <file>`; DB/route/orchestrator tests run with `pnpm vitest run --config vitest.db.config.ts <file>` (Docker must be running). Commit messages MUST include `Refs YUK-193` (or `Closes YUK-193` only on the final task) AND the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Do NOT create branches as part of these tasks — work on the current branch unless a wave workflow says otherwise.

Implementation order follows spec §10: (1) `SolutionGenerateTask`, (2) `TutorStatus` expansion, (3) Tutor session module, (4) solve orchestrator, (5) routes, (6) minimal UI entry, (7) pre-PR gate.

---

## Steps overview

- [ ] Task 1 — Register `SolutionGenerateTask` in the AI task registry
- [ ] Task 2 — Add the subject-aware `SolutionGenerateTask` prompt builder
- [ ] Task 3 — `SolutionGenerateOutput` schema (parse the LLM JSON)
- [ ] Task 4 — `generateReferenceSolution` server module (merge-preserving write + provenance + lazy/idempotent/logged-skip)
- [ ] Task 5 — Expand `TutorStatus` + wire the `tutor` arm in `LearningSessionStatusByType`
- [ ] Task 6 — `Tutor` session module (start / submitted / judged / ended / abandoned transitions)
- [ ] Task 7 — Export `Tutor` from the session barrel
- [ ] Task 8 — Solve orchestrator: `startSolveSession` (lazy-gen + create session)
- [ ] Task 9 — Solve orchestrator: `planSolveHint` (TeachingTurn-seeded escalating hint)
- [ ] Task 10 — Solve orchestrator: `submitSolveAttempt` (judge-by-kind → attempt event → reveal → mistake on low score)
- [ ] Task 11 — Route `POST /api/questions/[id]/solve`
- [ ] Task 12 — Route `POST /api/questions/[id]/solve/[sid]/hint`
- [ ] Task 13 — Route `POST /api/questions/[id]/solve/[sid]/submit`
- [ ] Task 14 — Minimal UI entry `SolveTutorPanel` reusing `JudgeResultPanel`
- [ ] Task 15 — Pre-PR gate

---

## File Structure (create vs modify)

### Create

| Path | One responsibility |
|---|---|
| `src/core/schema/solution.ts` | `SolutionGenerateOutput` Zod schema — the LLM's structured output (reference_solution + worked_solution_md). Pure, no IO. |
| `src/core/schema/solution.test.ts` | Unit tests for `SolutionGenerateOutput` parse/reject (no-DB). |
| `src/server/ai/solution-generate.ts` | `generateReferenceSolution()` — runs `SolutionGenerateTask` via the runner, parses output, merges `reference_solution` into existing `rubric_json` (preserving `criteria`/`keywords`/etc.), writes `reference_md`, stamps `reference_solution_source: 'ai_generated'`. Lazy/idempotent/logged-skip. |
| `src/server/ai/solution-generate.test.ts` | DB-backed tests with injected `runTaskFn` (no live LLM): generate-on-bare-question, idempotent skip, regenerate override, merge-preserve, missing-key/throw logged-skip. |
| `src/server/session/tutor.ts` | The ONLY writer of `learning_session(type='tutor')` (ADR-0005 single-owner). `startTutorSession` / `markSubmitted` / `markJudged` / `endTutor` / `abandonTutor`. |
| `src/server/session/tutor.test.ts` | DB-backed transition tests + bad-transition guards. |
| `src/server/orchestrator/solve.ts` | Solve orchestrator: `startSolveSession` / `planSolveHint` / `submitSolveAttempt`. Mirrors `orchestrator/teaching.ts`. Injectable `runTaskFn` + `judgeFn`. |
| `src/server/orchestrator/solve.test.ts` | DB-backed orchestrator tests with stubbed AI/judge seams. |
| `app/api/questions/[id]/solve/route.ts` | `POST` — start a solve session on a question (lazy-gen if needed). |
| `app/api/questions/[id]/solve/route.test.ts` | DB-backed route test (400 missing question, 200 start, lazy-gen invoked). |
| `app/api/questions/[id]/solve/[sid]/hint/route.ts` | `POST` — escalating Socratic hint. |
| `app/api/questions/[id]/solve/[sid]/hint/route.test.ts` | DB-backed route test (hint returns non-revealing text). |
| `app/api/questions/[id]/solve/[sid]/submit/route.ts` | `POST` — multimodal submit (≥1 non-empty), judge, attempt event, reveal, mistake-on-low-score. |
| `app/api/questions/[id]/solve/[sid]/submit/route.test.ts` | DB-backed route test (typed submit, photo submit, low-score mistake, empty→400). |
| `src/ui/components/SolveTutorPanel.tsx` | Thin client entry: 开练 button → start → hint/submit, renders result via `JudgeResultPanel`. |

### Modify

| Path | Change |
|---|---|
| `src/ai/registry.ts` | Add `SolutionGenerateTask` `TaskDef` to the `tasks` object. |
| `src/ai/task-prompts.ts` | Add `buildSolutionGeneratePrompt(profile)` + a `case 'SolutionGenerateTask'` arm in `getTaskSystemPrompt`. |
| `src/ai/task-prompts.test.ts` | Add prompt-shape assertions for `SolutionGenerateTask`. |
| `src/ai/registry.test.ts` | Add a registry-entry sanity test for `SolutionGenerateTask`. |
| `src/core/schema/learning_session.ts` | Expand `TutorStatus` enum from `['placeholder']` to the real machine. (No migration — text columns.) |
| `src/server/session/index.ts` | Add `export * as Tutor from './tutor';`. |

### No schema migration

`question.rubric_json` (schema.ts:153) + `question.reference_md` (schema.ts:152) already exist. `learning_session.type` / `learning_session.status` are `text('...')` columns (schema.ts:518, 520), validated only by the Zod discriminated union — expanding `TutorStatus` is a Zod-only change. **Zero new DB columns, zero `audit:schema` allowlist entries, zero `db:generate`.**

---

## Task 1 — Register `SolutionGenerateTask` in the AI task registry

**Files:** modify `src/ai/registry.ts`, modify `src/ai/registry.test.ts`.

### 1a. Failing test

Append to `src/ai/registry.test.ts`:

```ts
describe('SolutionGenerateTask registry entry', () => {
  it('is registered as a single-shot text task usable by runTask', () => {
    expect(tasks.SolutionGenerateTask.kind).toBe('SolutionGenerateTask');
    expect(tasks.SolutionGenerateTask.needsToolCall).toBe(false);
    expect(tasks.SolutionGenerateTask.isMultimodal).toBe(false);
    expect(tasks.SolutionGenerateTask.allowedTools).toEqual([]);
    expect(tasks.SolutionGenerateTask.budget.maxIterations).toBe(1);
    // invocation defaults to 'auto' (called from the solve orchestrator, not a manual rescue)
    expect(tasks.SolutionGenerateTask.invocation).toBeUndefined();
  });
});
```

### 1b. Run-fails

```
pnpm vitest run --config vitest.unit.config.ts src/ai/registry.test.ts
```

Expected: FAIL — `tasks.SolutionGenerateTask is undefined` / `Cannot read properties of undefined`.

### 1c. Minimal implementation

In `src/ai/registry.ts`, inside the `tasks` object (place it after `TaggingTask`, before the trailing comment), add:

```ts
  SolutionGenerateTask: {
    kind: 'SolutionGenerateTask',
    description:
      'YUK-193 — Generate a reference solution + worked solution for a bare question that has no rubric_json.reference_solution. Output = RubricReferenceSolution (expected_signals + final_answer + answer_equivalents) + worked_solution_md. The solve orchestrator writes it merge-preserving into rubric_json + reference_md so the shipped StepsJudge/SemanticJudge can grade real ingested questions. Single structured-output call, text-only (the question prompt is already text; figures are passed as a textual hint, not images — vision extraction is out of scope).',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    fallbackChain: [{ provider: 'xiaomi', model: 'mimo-v2.5' }],
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 90_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    // invocation omitted (defaults to 'auto'): called from the solve orchestrator's
    // lazy-generation path, not a user-initiated rescue. Runtime renders the prompt
    // via getTaskSystemPrompt(task, profile); this string is the type-required fallback.
    systemPrompt: '(see getTaskSystemPrompt(task, profile) - fallback not for runtime)',
  },
```

### 1d. Run-passes

```
pnpm vitest run --config vitest.unit.config.ts src/ai/registry.test.ts
```

Expected: PASS (all describe blocks green, including the new one).

NOTE: `pnpm typecheck` will now fail because `getTaskSystemPrompt`'s exhaustive switch (`assertNever`) does not yet handle `'SolutionGenerateTask'`. That is fixed in Task 2 — do not run typecheck between 1 and 2; commit Tasks 1+2 together OR run the Task 2 implementation before committing. To keep commits atomic and green, commit Tasks 1 and 2 in a single commit.

---

## Task 2 — Add the subject-aware `SolutionGenerateTask` prompt builder

**Files:** modify `src/ai/task-prompts.ts`, modify `src/ai/task-prompts.test.ts`.

### 2a. Failing test

Append to `src/ai/task-prompts.test.ts` (inside the top-level `describe('getTaskSystemPrompt', ...)`):

```ts
  it('builds a math SolutionGenerateTask prompt grounded in reference_solution shape', () => {
    const prompt = getTaskSystemPrompt('SolutionGenerateTask', resolveSubjectProfile('math'));
    expect(prompt).toContain('expected_signals');
    expect(prompt).toContain('final_answer');
    expect(prompt).toContain('answer_equivalents');
    expect(prompt).toContain('worked_solution_md');
    expect(prompt).toContain('数学');
    // existing answers/analysis are advisory hints, never ground truth
    expect(prompt).toContain('hint');
    expect(prompt).toContain('不带 markdown 代码块包裹');
  });

  it('builds a wenyan SolutionGenerateTask prompt with prose-appropriate signals', () => {
    const prompt = getTaskSystemPrompt('SolutionGenerateTask');
    expect(prompt).toContain('expected_signals');
    expect(prompt).toContain('worked_solution_md');
  });
```

### 2b. Run-fails

```
pnpm vitest run --config vitest.unit.config.ts src/ai/task-prompts.test.ts
```

Expected: FAIL — `assertNever` throws at runtime for the unhandled `'SolutionGenerateTask'` case (the switch has no arm yet), surfacing as a thrown error in the test.

### 2c. Minimal implementation

In `src/ai/task-prompts.ts`, add a builder function (place it after `buildTeachingTurnPrompt`):

```ts
function buildSolutionGeneratePrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}解题参考答案生成器。输入 { prompt_md, kind, subject_id, existing_answers_hint?, existing_analysis_hint?, figures_hint? } —— prompt_md 是题面文字，existing_answers_hint / existing_analysis_hint 是录入时附带的原始答案 / 解析（可能来自 OCR，**仅作参考线索，不是真值**，可能错或残缺），figures_hint 是题目附图的文字描述（若有）。
科目上下文：${profile.displayName}。${profile.languageStyle}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}

任务：你自己独立解这道题，产出两样东西：
1. reference_solution —— 供自动判分用的结构化参考解：
   - expected_signals：解题过程**应当体现的核心信号 / 步骤要点**（不是死答案文本），至少 1 条；${profile.displayName}里 derivation 的 signals 是推导步骤要点，prose / translation 的 signals 是必须覆盖的语义要点。
   - final_answer：最终答案（一行，尽量规范）。
   - answer_equivalents：学生若打字提交、可判等价的若干表达（0..N 条）。
2. worked_solution_md —— 给学习者看的完整解题过程（markdown，可含 ${profile.renderConfig.notation === 'latex' ? 'LaTeX' : '本学科记法'}），讲清每一步为什么，不只是甩答案。

严格 JSON 输出（不带 markdown 代码块包裹），shape 名 SolutionGenerateOutput：
{"reference_solution":{"expected_signals":["..."],"final_answer":"...","answer_equivalents":["..."]},"worked_solution_md":"...","confidence":0.0-1.0}

要点：
- existing_answers_hint / existing_analysis_hint 只是 hint：如果你判断它对就采纳，判断它错就以你自己的解为准，并在 worked_solution_md 里简述为何。
- expected_signals 至少 1 条且每条非空；final_answer 非空。
- ${profile.grounding.uncertaintyPolicy}
- confidence 反映你对这份参考解的把握，模棱两可给 0.5。
- 禁止：输出 JSON 之外的文字、用 markdown 代码块包裹整段 JSON、把 hint 当成不可质疑的真值。`;
}
```

Then add the switch arm inside `getTaskSystemPrompt` (with the other profile-built cases, e.g. right after `case 'TeachingTurnTask':`):

```ts
    case 'SolutionGenerateTask':
      return buildSolutionGeneratePrompt(profile);
```

### 2d. Run-passes

```
pnpm vitest run --config vitest.unit.config.ts src/ai/task-prompts.test.ts src/ai/registry.test.ts
pnpm typecheck
```

Expected: PASS; typecheck clean (the exhaustive switch now handles the new kind).

### 2e. Commit (Tasks 1 + 2 together)

```
git add src/ai/registry.ts src/ai/registry.test.ts src/ai/task-prompts.ts src/ai/task-prompts.test.ts
git commit -F - <<'EOF'
feat(solve-tutor): register SolutionGenerateTask + subject-aware prompt

Refs YUK-193

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3 — `SolutionGenerateOutput` schema

**Files:** create `src/core/schema/solution.ts`, create `src/core/schema/solution.test.ts`.

### 3a. Failing test

Create `src/core/schema/solution.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SolutionGenerateOutput } from './solution';

describe('SolutionGenerateOutput', () => {
  it('parses a valid output', () => {
    const parsed = SolutionGenerateOutput.parse({
      reference_solution: {
        expected_signals: ['用平方差因式分解', '约去 a−b'],
        final_answer: 'a + b',
        answer_equivalents: ['a+b'],
      },
      worked_solution_md: '先因式分解，再约分。',
      confidence: 0.8,
    });
    expect(parsed.reference_solution.expected_signals).toHaveLength(2);
    expect(parsed.worked_solution_md).toContain('因式分解');
  });

  it('defaults answer_equivalents to [] when omitted', () => {
    const parsed = SolutionGenerateOutput.parse({
      reference_solution: { expected_signals: ['x'], final_answer: 'y' },
      worked_solution_md: 'z',
      confidence: 0.5,
    });
    expect(parsed.reference_solution.answer_equivalents).toEqual([]);
  });

  it('rejects empty expected_signals', () => {
    expect(() =>
      SolutionGenerateOutput.parse({
        reference_solution: { expected_signals: [], final_answer: 'y', answer_equivalents: [] },
        worked_solution_md: 'z',
        confidence: 0.5,
      }),
    ).toThrow();
  });

  it('rejects empty final_answer', () => {
    expect(() =>
      SolutionGenerateOutput.parse({
        reference_solution: { expected_signals: ['x'], final_answer: '', answer_equivalents: [] },
        worked_solution_md: 'z',
        confidence: 0.5,
      }),
    ).toThrow();
  });

  it('rejects empty worked_solution_md', () => {
    expect(() =>
      SolutionGenerateOutput.parse({
        reference_solution: { expected_signals: ['x'], final_answer: 'y', answer_equivalents: [] },
        worked_solution_md: '',
        confidence: 0.5,
      }),
    ).toThrow();
  });
});
```

### 3b. Run-fails

```
pnpm vitest run --config vitest.unit.config.ts src/core/schema/solution.test.ts
```

Expected: FAIL — `Cannot find module './solution'`.

### 3c. Minimal implementation

Create `src/core/schema/solution.ts`:

```ts
// YUK-193 — SolutionGenerateTask LLM structured output.
//
// The generator's job is to produce a reference_solution (the same shape the
// shipped StepsJudge consumes from rubric_json) PLUS a human-readable worked
// solution. reference_solution reuses RubricReferenceSolution (single source of
// truth in business.ts) so the generated value drops straight into the rubric.
import { z } from 'zod';
import { RubricReferenceSolution } from './business';

export const SolutionGenerateOutput = z.object({
  reference_solution: RubricReferenceSolution,
  worked_solution_md: z.string().min(1),
  confidence: z.number().min(0).max(1),
});
export type SolutionGenerateOutputT = z.infer<typeof SolutionGenerateOutput>;
```

(`RubricReferenceSolution` already enforces `expected_signals` min(1), `final_answer` min(1), and `answer_equivalents` default `[]` — see `src/core/schema/business.ts:165-169`. No re-declaration needed.)

### 3d. Run-passes

```
pnpm vitest run --config vitest.unit.config.ts src/core/schema/solution.test.ts
```

Expected: PASS (5 tests).

### 3e. Commit

```
git add src/core/schema/solution.ts src/core/schema/solution.test.ts
git commit -F - <<'EOF'
feat(solve-tutor): SolutionGenerateOutput schema

Refs YUK-193

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 4 — `generateReferenceSolution` server module

**Files:** create `src/server/ai/solution-generate.ts`, create `src/server/ai/solution-generate.test.ts`.

This module mirrors the `runStructureTask` pattern (`src/server/ingestion/structure.ts`): injectable `runTaskFn`, JSON-brace-slice parse, Zod-validate, graceful error type. It additionally OWNS the merge-preserving write to `question.rubric_json` + `question.reference_md`.

### 4a. Failing test (DB-backed — db partition)

Create `src/server/ai/solution-generate.test.ts`:

```ts
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { question } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { generateReferenceSolution } from './solution-generate';

const db = testDb();

function validLlmText() {
  return JSON.stringify({
    reference_solution: {
      expected_signals: ['用平方差因式分解', '约去 a−b'],
      final_answer: 'a + b',
      answer_equivalents: ['a+b'],
    },
    worked_solution_md: '先因式分解，再约分，得 a+b。',
    confidence: 0.9,
  });
}

async function seedQuestion(opts: {
  rubric_json?: unknown;
  reference_md?: string | null;
  kind?: string;
}): Promise<string> {
  const id = createId();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: opts.kind ?? 'derivation',
    prompt_md: '化简 (a^2 - b^2)/(a - b)',
    reference_md: opts.reference_md ?? null,
    rubric_json: (opts.rubric_json ?? null) as never,
    knowledge_ids: [],
    difficulty: 3,
    source: 'manual',
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return id;
}

describe('generateReferenceSolution', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('generates + writes reference_solution + reference_md + provenance on a bare question', async () => {
    const id = await seedQuestion({});
    const runTaskFn = vi.fn(async () => ({ text: validLlmText() }));

    const result = await generateReferenceSolution({ db, questionId: id, runTaskFn });

    expect(result.status).toBe('generated');
    const [row] = await db.select().from(question).where(eq(question.id, id));
    const rubric = row.rubric_json as {
      reference_solution: { expected_signals: string[]; final_answer: string };
      reference_solution_source?: string;
    };
    expect(rubric.reference_solution.expected_signals.length).toBeGreaterThanOrEqual(1);
    expect(rubric.reference_solution.final_answer).toBe('a + b');
    expect(rubric.reference_solution_source).toBe('ai_generated');
    expect(row.reference_md).toContain('因式分解');
  });

  it('is idempotent — skips when reference_solution already present', async () => {
    const id = await seedQuestion({
      rubric_json: {
        criteria: [],
        reference_solution: {
          expected_signals: ['authored signal'],
          final_answer: 'AUTHORED',
          answer_equivalents: [],
        },
      },
    });
    const runTaskFn = vi.fn(async () => ({ text: validLlmText() }));

    const result = await generateReferenceSolution({ db, questionId: id, runTaskFn });

    expect(result.status).toBe('skipped_exists');
    expect(runTaskFn).not.toHaveBeenCalled();
    const [row] = await db.select().from(question).where(eq(question.id, id));
    expect((row.rubric_json as { reference_solution: { final_answer: string } }).reference_solution.final_answer).toBe('AUTHORED');
  });

  it('regenerate=true overwrites an existing reference_solution', async () => {
    const id = await seedQuestion({
      rubric_json: {
        criteria: [],
        reference_solution: {
          expected_signals: ['authored signal'],
          final_answer: 'AUTHORED',
          answer_equivalents: [],
        },
      },
    });
    const runTaskFn = vi.fn(async () => ({ text: validLlmText() }));

    const result = await generateReferenceSolution({ db, questionId: id, runTaskFn, regenerate: true });

    expect(result.status).toBe('generated');
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    const [row] = await db.select().from(question).where(eq(question.id, id));
    expect((row.rubric_json as { reference_solution: { final_answer: string } }).reference_solution.final_answer).toBe('a + b');
  });

  it('preserves existing criteria / keywords when merging the generated reference_solution', async () => {
    const id = await seedQuestion({
      rubric_json: {
        criteria: [{ name: 'method', weight: 1, descriptor: 'kept' }],
        keywords: ['kw1'],
        required_points: ['rp1'],
      },
    });
    const runTaskFn = vi.fn(async () => ({ text: validLlmText() }));

    await generateReferenceSolution({ db, questionId: id, runTaskFn });

    const [row] = await db.select().from(question).where(eq(question.id, id));
    const rubric = row.rubric_json as {
      criteria: { name: string }[];
      keywords: string[];
      required_points: string[];
      reference_solution: { final_answer: string };
    };
    expect(rubric.criteria).toEqual([{ name: 'method', weight: 1, descriptor: 'kept' }]);
    expect(rubric.keywords).toEqual(['kw1']);
    expect(rubric.required_points).toEqual(['rp1']);
    expect(rubric.reference_solution.final_answer).toBe('a + b');
  });

  it('logged-skip on LLM throw — question untouched, no exception', async () => {
    const id = await seedQuestion({});
    const runTaskFn = vi.fn(async () => {
      throw new Error('XIAOMI_API_KEY missing');
    });

    const result = await generateReferenceSolution({ db, questionId: id, runTaskFn });

    expect(result.status).toBe('skipped_error');
    const [row] = await db.select().from(question).where(eq(question.id, id));
    expect(row.rubric_json).toBeNull();
    expect(row.reference_md).toBeNull();
  });

  it('logged-skip on unparseable LLM output — question untouched', async () => {
    const id = await seedQuestion({});
    const runTaskFn = vi.fn(async () => ({ text: 'not json at all' }));

    const result = await generateReferenceSolution({ db, questionId: id, runTaskFn });

    expect(result.status).toBe('skipped_error');
    const [row] = await db.select().from(question).where(eq(question.id, id));
    expect(row.rubric_json).toBeNull();
  });

  it('returns skipped_not_found for an unknown question id', async () => {
    const runTaskFn = vi.fn(async () => ({ text: validLlmText() }));
    const result = await generateReferenceSolution({ db, questionId: 'nope', runTaskFn });
    expect(result.status).toBe('skipped_not_found');
    expect(runTaskFn).not.toHaveBeenCalled();
  });
});
```

### 4b. Run-fails

```
pnpm vitest run --config vitest.db.config.ts src/server/ai/solution-generate.test.ts
```

Expected: FAIL — `Cannot find module './solution-generate'` (Docker must be running for the db config to spin up the testcontainer).

### 4c. Minimal implementation

Create `src/server/ai/solution-generate.ts`:

```ts
// YUK-193 — Lazy AI reference-solution generator (spec §2).
//
// Runs SolutionGenerateTask through the AI runner (which logs the run to the AI
// log — evidence-first, ADR-0005 spirit), parses the structured output, and
// writes it MERGE-PRESERVING into question.rubric_json + question.reference_md.
// This is the "fuel" that makes the shipped StepsJudge/SemanticJudge usable on
// real ingested questions (which arrive with no rubric_json).
//
// Robustness (spec §2.4): a missing key / LLM throw / unparseable output is a
// LOGGED SKIP — never a thrown 500, never a retry storm. The caller (solve
// orchestrator) degrades gracefully; the manual flow is untouched. Lazy +
// idempotent (skip when reference_solution already exists, unless regenerate).
import { eq } from 'drizzle-orm';

import { Rubric, type RubricT } from '@/core/schema/business';
import { SolutionGenerateOutput } from '@/core/schema/solution';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { resolveSubjectProfileForKnowledgeIds } from '@/server/knowledge/subject-profile';

export type SolutionGenerateRunTaskFn = (
  kind: string,
  input: unknown,
  ctx: unknown,
) => Promise<{ text: string }>;

export interface GenerateReferenceSolutionParams {
  db: Db;
  questionId: string;
  /** Inject in tests; defaults to the production runner. */
  runTaskFn?: SolutionGenerateRunTaskFn;
  /** Overwrite an existing reference_solution. Default false (idempotent skip). */
  regenerate?: boolean;
}

export type GenerateReferenceSolutionResult =
  | { status: 'generated'; final_answer: string }
  | { status: 'skipped_exists' }
  | { status: 'skipped_not_found' }
  | { status: 'skipped_error'; reason: string };

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
    throw new Error('SolutionGenerateTask output did not contain a JSON object');
  }
  return JSON.parse(text.slice(start, end + 1));
}

function existingReferenceSolution(rawRubric: unknown): boolean {
  const parsed = Rubric.safeParse(rawRubric);
  return parsed.success && parsed.data.reference_solution !== undefined;
}

export async function generateReferenceSolution(
  params: GenerateReferenceSolutionParams,
): Promise<GenerateReferenceSolutionResult> {
  const { db, questionId } = params;
  const runTaskFn = params.runTaskFn ?? defaultRunTaskFn;

  const [row] = await db
    .select({
      id: question.id,
      kind: question.kind,
      prompt_md: question.prompt_md,
      reference_md: question.reference_md,
      rubric_json: question.rubric_json,
      knowledge_ids: question.knowledge_ids,
      metadata: question.metadata,
    })
    .from(question)
    .where(eq(question.id, questionId))
    .limit(1);

  if (!row) return { status: 'skipped_not_found' };

  if (!params.regenerate && existingReferenceSolution(row.rubric_json)) {
    return { status: 'skipped_exists' };
  }

  const subjectProfile = await resolveSubjectProfileForKnowledgeIds(db, row.knowledge_ids);

  // existing answers / analysis are advisory hints (an ingested question may
  // carry Tencent's RightAnswer / AnswerAnalysis) — feed as hint, not truth.
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const input = {
    prompt_md: row.prompt_md,
    kind: row.kind,
    subject_id: subjectProfile.id,
    existing_answers_hint: row.reference_md ?? meta.tencent_right_answer ?? null,
    existing_analysis_hint: meta.tencent_answer_analysis ?? null,
    figures_hint: null,
  };

  let parsed: ReturnType<typeof SolutionGenerateOutput.parse>;
  try {
    const { text } = await runTaskFn('SolutionGenerateTask', input, { db, subjectProfile });
    parsed = SolutionGenerateOutput.parse(extractJsonObject(text));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[generateReferenceSolution] logged-skip for ${questionId}: ${reason}`);
    return { status: 'skipped_error', reason };
  }

  // Merge-preserving: keep any existing criteria/keywords/required_points/
  // acceptable_answers, replace only reference_solution. A question with no
  // prior rubric gets a minimal valid Rubric (criteria: []).
  const prior = Rubric.safeParse(row.rubric_json);
  const base: RubricT = prior.success ? prior.data : { criteria: [] };
  const mergedRubric = {
    ...base,
    reference_solution: parsed.reference_solution,
    // provenance marker (spec §2.1) — lets a human distinguish AI-generated
    // reference solutions from authored ones. Lives alongside the typed Rubric
    // keys; Rubric.parse() ignores unknown keys on read so this is safe.
    reference_solution_source: 'ai_generated' as const,
  };

  await db
    .update(question)
    .set({
      rubric_json: mergedRubric as RubricT,
      reference_md: parsed.worked_solution_md,
      updated_at: new Date(),
    })
    .where(eq(question.id, questionId));

  return { status: 'generated', final_answer: parsed.reference_solution.final_answer };
}
```

NOTE on the provenance marker: `Rubric` is a plain (non-`.strict()`) `z.object`, so `Rubric.safeParse()` of a value carrying the extra `reference_solution_source` key SUCCEEDS and silently drops the unknown key on the typed read — the marker survives in the DB jsonb and is readable via raw row access, but never trips the judge's `Rubric.safeParse`. This is verified by the merge-preserve test (which reads the raw row) + the idempotent test (which relies on `Rubric.safeParse(...).reference_solution` still being detected).

### 4d. Run-passes

```
pnpm vitest run --config vitest.db.config.ts src/server/ai/solution-generate.test.ts
```

Expected: PASS (7 tests).

### 4e. Commit

```
git add src/server/ai/solution-generate.ts src/server/ai/solution-generate.test.ts
git commit -F - <<'EOF'
feat(solve-tutor): generateReferenceSolution (lazy, idempotent, merge-preserving)

Refs YUK-193

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 5 — Expand `TutorStatus` + wire the `tutor` arm

**Files:** modify `src/core/schema/learning_session.ts`. The discriminated union `LearningSessionStatusByType` already has a `tutor` arm at line 71 referencing `TutorStatus`, so only the enum changes.

### 5a. Failing test

Create `src/core/schema/learning_session.test.ts` (no-DB — `src/core/**/*.test.ts` is in the unit partition):

```ts
import { describe, expect, it } from 'vitest';
import { LearningSessionStatusByType, TutorStatus } from './learning_session';

describe('TutorStatus machine (YUK-193)', () => {
  it('enumerates the real solve-tutor states', () => {
    expect(TutorStatus.options).toEqual([
      'active',
      'submitted',
      'judged',
      'ended',
      'abandoned',
    ]);
  });

  it('no longer carries the placeholder value', () => {
    expect(TutorStatus.options).not.toContain('placeholder');
  });

  it('accepts (tutor, active) via the discriminated union', () => {
    expect(() =>
      LearningSessionStatusByType.parse({ type: 'tutor', status: 'active' }),
    ).not.toThrow();
  });

  it('accepts (tutor, judged) via the discriminated union', () => {
    expect(() =>
      LearningSessionStatusByType.parse({ type: 'tutor', status: 'judged' }),
    ).not.toThrow();
  });

  it('rejects an unknown tutor status', () => {
    expect(() =>
      LearningSessionStatusByType.parse({ type: 'tutor', status: 'placeholder' }),
    ).toThrow();
  });
});
```

### 5b. Run-fails

```
pnpm vitest run --config vitest.unit.config.ts src/core/schema/learning_session.test.ts
```

Expected: FAIL — `TutorStatus.options` is `['placeholder']`.

### 5c. Minimal implementation

In `src/core/schema/learning_session.ts`, replace the `TutorStatus` declaration (lines 50-54) with:

```ts
// tutor 状态机 (YUK-193 解题陪练 / docs/superpowers/specs/2026-06-01-solve-tutor-design.md §3.1)：
//   active → submitted → judged → ended  (+ abandoned terminal)
// active   : 会话已开，可请求 hint / 提交作答
// submitted: 已收到一次作答提交，判分进行中（瞬态，submit 路由内同事务推进到 judged）
// judged   : 已判分 + 已揭示参考解
// ended    : 终态 —— 正常收尾
// abandoned: 终态 —— 放弃 / orphan
export const TutorStatus = z.enum(['active', 'submitted', 'judged', 'ended', 'abandoned']);
export type TutorStatusT = z.infer<typeof TutorStatus>;
```

`ExploreStatus` and `CreateStatus` keep their `['placeholder']` (still deferred). The `LearningSessionStatusByType` discriminated union at line 71 (`z.object({ type: z.literal('tutor'), status: TutorStatus })`) needs NO edit — it already references `TutorStatus`.

### 5d. Run-passes

```
pnpm vitest run --config vitest.unit.config.ts src/core/schema/learning_session.test.ts
pnpm typecheck
```

Expected: PASS; typecheck clean.

### 5e. Commit

```
git add src/core/schema/learning_session.ts src/core/schema/learning_session.test.ts
git commit -F - <<'EOF'
feat(solve-tutor): expand TutorStatus to the real solve-session machine

No migration — learning_session.type/status are text columns.

Refs YUK-193

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 6 — `Tutor` session module

**Files:** create `src/server/session/tutor.ts`, create `src/server/session/tutor.test.ts`. Mirrors `src/server/session/conversation.ts` (the single-owner pattern). Uses the existing `assertFromState` guard (`src/server/session/guards.ts`) and `writeJobEvent` (`src/server/events/writer.ts`). The solve session links its `question_id` via the `goal_id` slot (mirroring how `conversation` keeps `learning_item_id` in `goal_id`).

### 6a. Failing test (DB-backed)

Create `src/server/session/tutor.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { learning_session } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import * as Tutor from './tutor';

const db = testDb();

describe('Tutor session module', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('startTutorSession creates a tutor session in active linked to the question', async () => {
    const { sessionId } = await Tutor.startTutorSession(db, { questionId: 'q1' });
    const [row] = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(row.type).toBe('tutor');
    expect(row.status).toBe('active');
    expect(row.goal_id).toBe('q1');
  });

  it('active → submitted → judged', async () => {
    const { sessionId } = await Tutor.startTutorSession(db, { questionId: 'q1' });
    await Tutor.markSubmitted(db, sessionId);
    let [row] = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(row.status).toBe('submitted');
    await Tutor.markJudged(db, sessionId);
    [row] = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(row.status).toBe('judged');
  });

  it('judged → ended', async () => {
    const { sessionId } = await Tutor.startTutorSession(db, { questionId: 'q1' });
    await Tutor.markSubmitted(db, sessionId);
    await Tutor.markJudged(db, sessionId);
    await Tutor.endTutor(db, sessionId);
    const [row] = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(row.status).toBe('ended');
    expect(row.ended_at).not.toBeNull();
  });

  it('rejects markJudged from active (bad transition)', async () => {
    const { sessionId } = await Tutor.startTutorSession(db, { questionId: 'q1' });
    await expect(Tutor.markJudged(db, sessionId)).rejects.toThrow();
  });

  it('getTutorQuestionId returns the linked question for an accepting session', async () => {
    const { sessionId } = await Tutor.startTutorSession(db, { questionId: 'q1' });
    const { questionId, status } = await Tutor.getTutorQuestionId(db, sessionId);
    expect(questionId).toBe('q1');
    expect(status).toBe('active');
  });

  it('throws 404 for an unknown session id', async () => {
    await expect(Tutor.markSubmitted(db, 'nope')).rejects.toThrow();
  });
});
```

### 6b. Run-fails

```
pnpm vitest run --config vitest.db.config.ts src/server/session/tutor.test.ts
```

Expected: FAIL — `Cannot find module './tutor'`.

### 6c. Minimal implementation

Create `src/server/session/tutor.ts`:

```ts
import { createId } from '@paralleldrive/cuid2';
import { eq, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { learning_session } from '@/db/schema';
import { writeJobEvent } from '@/server/events/writer';
import { ApiError } from '@/server/http/errors';

import { assertFromState } from './guards';

// LearningSession.Tutor.* — YUK-193 solve-tutor session (spec §3.1).
//
// State machine (docs/superpowers/specs/2026-06-01-solve-tutor-design.md §3.1):
//   active → submitted → judged → ended   (+ abandoned terminal)
//
// This module is the ONLY allowed writer of learning_session(type='tutor')
// (ADR-0005 single-owner invariant, mirrors conversation.ts). Routes / handlers
// MUST NOT update learning_session for type='tutor' directly. The linked
// question_id lives in the `goal_id` slot (same convention conversation.ts uses
// for learning_item_id).

const SESSION_TABLE = 'learning_session' as const;

async function loadTutorSessionForUpdate(
  tx: Db | Tx,
  sessionId: string,
): Promise<{ status: string; goal_id: string | null } | null> {
  const rows = await tx.execute(
    sql`SELECT status, goal_id FROM learning_session WHERE id = ${sessionId} AND type = 'tutor' FOR UPDATE`,
  );
  const arr = rows as unknown as Array<{ status: string; goal_id: string | null }>;
  const row = arr[0];
  if (!row) return null;
  return { status: row.status, goal_id: row.goal_id };
}

function notFound(sessionId: string): ApiError {
  return new ApiError('not_found', `learning_session ${sessionId} (type=tutor) not found`, 404);
}

export type StartTutorSessionParams = {
  /** The question this solve session is about (kept in the goal_id slot). */
  questionId: string;
};

export async function startTutorSession(
  db: Db,
  params: StartTutorSessionParams,
): Promise<{ sessionId: string }> {
  return db.transaction(async (tx) => {
    const sessionId = createId();
    const now = new Date();
    await tx.insert(learning_session).values({
      id: sessionId,
      type: 'tutor',
      status: 'active',
      source_document_id: null,
      source_asset_ids: [],
      entrypoint: null,
      warnings: [],
      error_message: null,
      summary_md: null,
      goal_id: params.questionId,
      started_at: now,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'tutor.started',
      payload: { question_id: params.questionId },
    });
    return { sessionId };
  });
}

async function transition(
  db: Db,
  sessionId: string,
  from: readonly string[],
  to: 'submitted' | 'judged' | 'ended' | 'abandoned',
  eventType: string,
  setEndedAt: boolean,
): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await loadTutorSessionForUpdate(tx, sessionId);
    if (!current) throw notFound(sessionId);
    assertFromState(current.status, from, sessionId, `Tutor.${to}`);
    const now = new Date();
    await tx
      .update(learning_session)
      .set({
        status: to,
        ...(setEndedAt ? { ended_at: now } : {}),
        updated_at: now,
        version: sql`${learning_session.version} + 1`,
      })
      .where(eq(learning_session.id, sessionId));
    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: eventType,
      payload: { from_status: current.status },
    });
  });
}

export async function markSubmitted(db: Db, sessionId: string): Promise<void> {
  await transition(db, sessionId, ['active'] as const, 'submitted', 'tutor.submitted', false);
}

export async function markJudged(db: Db, sessionId: string): Promise<void> {
  await transition(db, sessionId, ['submitted'] as const, 'judged', 'tutor.judged', false);
}

export async function endTutor(db: Db, sessionId: string): Promise<void> {
  await transition(db, sessionId, ['active', 'judged'] as const, 'ended', 'tutor.ended', true);
}

export async function abandonTutor(db: Db, sessionId: string): Promise<void> {
  await transition(
    db,
    sessionId,
    ['active', 'submitted', 'judged'] as const,
    'abandoned',
    'tutor.abandoned',
    true,
  );
}

/** Read the linked question id + status for an accepting (active) session. */
export async function getTutorQuestionId(
  db: Db,
  sessionId: string,
): Promise<{ questionId: string | null; status: string }> {
  const rows = await db
    .select({ status: learning_session.status, goal_id: learning_session.goal_id })
    .from(learning_session)
    .where(eq(learning_session.id, sessionId))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound(sessionId);
  return { questionId: row.goal_id, status: row.status };
}
```

Confirm `assertFromState`'s signature matches: it is called in `conversation.ts` as `assertFromState(current.status, ['active'] as const, sessionId, 'Conversation.idleConversation')`. The wrapper above passes the same `(status, fromStates, sessionId, label)` argument order.

### 6d. Run-passes

```
pnpm vitest run --config vitest.db.config.ts src/server/session/tutor.test.ts
```

Expected: PASS (6 tests).

### 6e. Commit

```
git add src/server/session/tutor.ts src/server/session/tutor.test.ts
git commit -F - <<'EOF'
feat(solve-tutor): Tutor session module (single-owner state machine)

Refs YUK-193

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 7 — Export `Tutor` from the session barrel

**Files:** modify `src/server/session/index.ts`, modify `src/server/session/index.test.ts`.

### 7a. Failing test

Append to `src/server/session/index.test.ts` (it is in the unit partition — enumerated in `vitest.shared.ts:107`):

```ts
import * as Session from './index';

describe('session barrel — Tutor (YUK-193)', () => {
  it('re-exports the Tutor namespace with the transition functions', () => {
    expect(typeof Session.Tutor.startTutorSession).toBe('function');
    expect(typeof Session.Tutor.markSubmitted).toBe('function');
    expect(typeof Session.Tutor.markJudged).toBe('function');
    expect(typeof Session.Tutor.endTutor).toBe('function');
  });
});
```

(If `import { describe, expect, it } from 'vitest'` is not already at the top of `index.test.ts`, add it. Reuse the file's existing import style; if it already imports `* as Session`, do not duplicate the import.)

### 7b. Run-fails

```
pnpm vitest run --config vitest.unit.config.ts src/server/session/index.test.ts
```

Expected: FAIL — `Session.Tutor is undefined`.

### 7c. Minimal implementation

In `src/server/session/index.ts`, add after the `Conversation` export:

```ts
export * as Tutor from './tutor';
```

### 7d. Run-passes

```
pnpm vitest run --config vitest.unit.config.ts src/server/session/index.test.ts
```

Expected: PASS.

NOTE: `tests/integration/session-single-owner.test.ts` structurally asserts `learning_session` writes only originate from `src/server/session/`. `tutor.ts` lives there, so it complies. Run it as part of the gate (Task 15), not now.

### 7e. Commit

```
git add src/server/session/index.ts src/server/session/index.test.ts
git commit -F - <<'EOF'
feat(solve-tutor): export Tutor session namespace from the barrel

Refs YUK-193

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 8 — Solve orchestrator: `startSolveSession`

**Files:** create `src/server/orchestrator/solve.ts`, create `src/server/orchestrator/solve.test.ts`. Mirrors `src/server/orchestrator/teaching.ts`. Tasks 8/9/10 build this one module incrementally.

### 8a. Failing test (DB-backed)

Create `src/server/orchestrator/solve.test.ts`:

```ts
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { learning_session, question } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { startSolveSession } from './solve';

const db = testDb();

async function seedQuestion(opts: { rubric_json?: unknown }): Promise<string> {
  const id = createId();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'derivation',
    prompt_md: '化简 (a^2 - b^2)/(a - b)',
    reference_md: null,
    rubric_json: (opts.rubric_json ?? null) as never,
    knowledge_ids: [],
    difficulty: 3,
    source: 'manual',
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return id;
}

const VALID_GEN = JSON.stringify({
  reference_solution: { expected_signals: ['s1'], final_answer: 'a + b', answer_equivalents: ['a+b'] },
  worked_solution_md: '解：a+b。',
  confidence: 0.9,
});

describe('startSolveSession', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('lazily generates a reference solution then creates a tutor session', async () => {
    const id = await seedQuestion({});
    const runTaskFn = vi.fn(async () => ({ text: VALID_GEN }));

    const { sessionId, generated } = await startSolveSession({ db, questionId: id, runTaskFn });

    expect(generated).toBe(true);
    const [s] = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(s.type).toBe('tutor');
    expect(s.status).toBe('active');
    expect(s.goal_id).toBe(id);
    const [q] = await db.select().from(question).where(eq(question.id, id));
    expect((q.rubric_json as { reference_solution: { final_answer: string } }).reference_solution.final_answer).toBe('a + b');
  });

  it('skips generation when reference_solution already present', async () => {
    const id = await seedQuestion({
      rubric_json: {
        criteria: [],
        reference_solution: { expected_signals: ['s'], final_answer: 'A', answer_equivalents: [] },
      },
    });
    const runTaskFn = vi.fn(async () => ({ text: VALID_GEN }));

    const { generated } = await startSolveSession({ db, questionId: id, runTaskFn });

    expect(generated).toBe(false);
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('still creates a session (degraded) when generation fails', async () => {
    const id = await seedQuestion({});
    const runTaskFn = vi.fn(async () => {
      throw new Error('LLM down');
    });

    const { sessionId, generated, generationError } = await startSolveSession({
      db,
      questionId: id,
      runTaskFn,
    });

    expect(generated).toBe(false);
    expect(generationError).toBe(true);
    const [s] = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(s.status).toBe('active'); // session opens; judge will degrade later
  });

  it('throws SolveError(question_not_found) for an unknown question', async () => {
    const runTaskFn = vi.fn();
    await expect(startSolveSession({ db, questionId: 'nope', runTaskFn })).rejects.toMatchObject({
      code: 'question_not_found',
    });
  });
});
```

### 8b. Run-fails

```
pnpm vitest run --config vitest.db.config.ts src/server/orchestrator/solve.test.ts
```

Expected: FAIL — `Cannot find module './solve'`.

### 8c. Minimal implementation

Create `src/server/orchestrator/solve.ts`:

```ts
// YUK-193 — Solve-tutor orchestrator (spec §3.2). Mirrors orchestrator/teaching.ts.
//
// Three operations: startSolveSession (lazy-gen + create), planSolveHint
// (TeachingTurn-seeded escalating hint), submitSolveAttempt (judge → attempt
// event → reveal → mistake-on-low-score). All AI calls go through injectable
// fns so tests stub the LLM/judge seam (no live calls).
import { eq } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import {
  type GenerateReferenceSolutionResult,
  type SolutionGenerateRunTaskFn,
  generateReferenceSolution,
} from '@/server/ai/solution-generate';
import { Tutor } from '@/server/session';

export type RunTaskFn = (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;

export class SolveError extends Error {
  constructor(
    public code:
      | 'question_not_found'
      | 'session_not_found'
      | 'session_not_active'
      | 'empty_submission'
      | 'llm_parse_failed',
    message: string,
  ) {
    super(message);
    this.name = 'SolveError';
  }
}

export interface StartSolveSessionParams {
  db: Db;
  questionId: string;
  /** Injected in tests; forwarded to generateReferenceSolution. */
  runTaskFn?: SolutionGenerateRunTaskFn;
  /** Force regeneration of the reference solution. */
  regenerate?: boolean;
}

export interface StartSolveSessionResult {
  sessionId: string;
  /** true when this call generated a fresh reference solution. */
  generated: boolean;
  /** true when lazy generation was attempted but failed (degraded mode). */
  generationError: boolean;
}

export async function startSolveSession(
  params: StartSolveSessionParams,
): Promise<StartSolveSessionResult> {
  const { db, questionId } = params;

  const [q] = await db
    .select({ id: question.id })
    .from(question)
    .where(eq(question.id, questionId))
    .limit(1);
  if (!q) throw new SolveError('question_not_found', `question ${questionId} not found`);

  let gen: GenerateReferenceSolutionResult;
  try {
    gen = await generateReferenceSolution({
      db,
      questionId,
      runTaskFn: params.runTaskFn,
      regenerate: params.regenerate,
    });
  } catch (err) {
    // generateReferenceSolution already swallows LLM/parse errors into
    // skipped_error; this catch only guards an unexpected throw (e.g. DB read).
    console.warn(`[startSolveSession] generation threw for ${questionId}:`, err);
    gen = { status: 'skipped_error', reason: err instanceof Error ? err.message : String(err) };
  }

  const { sessionId } = await Tutor.startTutorSession(db, { questionId });

  return {
    sessionId,
    generated: gen.status === 'generated',
    generationError: gen.status === 'skipped_error',
  };
}
```

### 8d. Run-passes

```
pnpm vitest run --config vitest.db.config.ts src/server/orchestrator/solve.test.ts
```

Expected: PASS (4 tests).

### 8e. Commit

```
git add src/server/orchestrator/solve.ts src/server/orchestrator/solve.test.ts
git commit -F - <<'EOF'
feat(solve-tutor): startSolveSession orchestrator (lazy-gen + session create)

Refs YUK-193

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 9 — Solve orchestrator: `planSolveHint`

**Files:** modify `src/server/orchestrator/solve.ts`, modify `src/server/orchestrator/solve.test.ts`. Reuses `TeachingTurnTask` seeded with the worked solution.

### 9a. Failing test

Append to `src/server/orchestrator/solve.test.ts`:

```ts
import { planSolveHint } from './solve';
import { Tutor } from '@/server/session';

describe('planSolveHint', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns a non-revealing hint via TeachingTurnTask', async () => {
    const id = await seedQuestion({
      rubric_json: {
        criteria: [],
        reference_solution: { expected_signals: ['s'], final_answer: 'a + b', answer_equivalents: [] },
      },
    });
    await db.update(question).set({ reference_md: '完整解：先因式分解，再约分得 a+b。' }).where(eq(question.id, id));
    const { sessionId } = await Tutor.startTutorSession(db, { questionId: id });

    const turnText = JSON.stringify({
      kind: 'explain',
      text_md: '想想分子能不能因式分解？',
      suggested_next: 'continue',
    });
    const runTaskFn = vi.fn(async () => ({ text: turnText }));

    const hint = await planSolveHint({ db, sessionId, hintIndex: 0, runTaskFn });

    expect(hint.text_md).toContain('因式分解');
    expect(hint.text_md).not.toContain('a+b'); // does not reveal the final answer
    expect(runTaskFn).toHaveBeenCalledWith('TeachingTurnTask', expect.anything(), expect.anything());
  });

  it('throws session_not_found for an unknown session', async () => {
    const runTaskFn = vi.fn();
    await expect(planSolveHint({ db, sessionId: 'nope', hintIndex: 0, runTaskFn })).rejects.toMatchObject({
      code: 'session_not_found',
    });
  });
});
```

(`getTutorQuestionId` throws `not_found` (ApiError 404) for an unknown session; `planSolveHint` calls it first, so the "unknown session" case rejects with the ApiError, not `SolveError(session_not_found)`. To make the test assertion accurate, `planSolveHint` catches a missing/unknown session before calling `getTutorQuestionId`. Simplest: let `getTutorQuestionId` throw and assert `rejects.toThrow()` instead of `toMatchObject({code})`. Replace the second `it` body with `await expect(planSolveHint({ db, sessionId: 'nope', hintIndex: 0, runTaskFn })).rejects.toThrow();`.)

### 9b. Run-fails

```
pnpm vitest run --config vitest.db.config.ts src/server/orchestrator/solve.test.ts
```

Expected: FAIL — `planSolveHint is not exported`.

### 9c. Minimal implementation

Add imports at the top of `src/server/orchestrator/solve.ts`:

```ts
import { z } from 'zod';
import { resolveSubjectProfileForKnowledgeIds } from '@/server/knowledge/subject-profile';
```

Then add:

```ts
// Reuse the TeachingTurnTask output loosely — for hints we only need text_md
// (the minimal next step). Parse defensively: any JSON object with a string
// text_md is accepted.
const HintTurn = z.object({ text_md: z.string().min(1) }).passthrough();

export interface PlanSolveHintParams {
  db: Db;
  sessionId: string;
  /** 0-based hint count so far in this session — escalates the ask. */
  hintIndex: number;
  runTaskFn?: RunTaskFn;
}

export interface PlanSolveHintResult {
  text_md: string;
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

function parseHintTurn(text: string): PlanSolveHintResult {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new SolveError('llm_parse_failed', 'hint turn output had no JSON object');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new SolveError('llm_parse_failed', `hint turn JSON.parse failed: ${(e as Error).message}`);
  }
  const parsed = HintTurn.safeParse(raw);
  if (!parsed.success) {
    throw new SolveError('llm_parse_failed', `hint turn schema mismatch: ${parsed.error.message}`);
  }
  return { text_md: parsed.data.text_md };
}

export async function planSolveHint(params: PlanSolveHintParams): Promise<PlanSolveHintResult> {
  const { db, sessionId, hintIndex } = params;
  const runTaskFn = params.runTaskFn ?? defaultRunTaskFn;

  const { questionId } = await Tutor.getTutorQuestionId(db, sessionId);
  if (!questionId) {
    throw new SolveError('session_not_found', `tutor session ${sessionId} missing question link`);
  }
  const [q] = await db
    .select({
      prompt_md: question.prompt_md,
      reference_md: question.reference_md,
      knowledge_ids: question.knowledge_ids,
    })
    .from(question)
    .where(eq(question.id, questionId))
    .limit(1);
  if (!q) throw new SolveError('question_not_found', `question ${questionId} not found`);

  const subjectProfile = await resolveSubjectProfileForKnowledgeIds(db, q.knowledge_ids);

  // Seed TeachingTurnTask with the worked solution as material + a synthetic
  // message asking for ONLY the next step (escalating with hintIndex). The
  // TeachingTurnTask prompt forbids dumping the full solution + caps ≤300 字/轮,
  // so the returned text_md is a minimal hint, not the answer.
  const input = {
    learning_item: {
      title: '解题陪练',
      one_line_intent: q.prompt_md,
      knowledge_node: null,
    },
    parent_hub_summary: null,
    atomic_sections: q.reference_md ? { worked_solution: q.reference_md } : null,
    messages: [
      {
        role: 'user' as const,
        text_md:
          hintIndex === 0
            ? '我卡住了，给我一个不剧透答案的最小提示，只点一步方向。'
            : `还是不会，给下一个更具体的提示（第 ${hintIndex + 1} 个），仍然不要直接说出最终答案。`,
      },
    ],
  };

  const { text } = await runTaskFn('TeachingTurnTask', input, { db, subjectProfile });
  return parseHintTurn(text);
}
```

NOTE: Non-revelation is the TeachingTurnTask prompt's responsibility (asserted here via the stub). The orchestrator passes the worked solution as material and asks for the next step only; it never echoes `reference_md`.

### 9d. Run-passes

```
pnpm vitest run --config vitest.db.config.ts src/server/orchestrator/solve.test.ts
```

Expected: PASS.

### 9e. Commit

```
git add src/server/orchestrator/solve.ts src/server/orchestrator/solve.test.ts
git commit -F - <<'EOF'
feat(solve-tutor): planSolveHint (TeachingTurn-seeded escalating hint)

Refs YUK-193

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 10 — Solve orchestrator: `submitSolveAttempt`

**Files:** modify `src/server/orchestrator/solve.ts`, modify `src/server/orchestrator/solve.test.ts`.

**FSRS clarification (resolved ambiguity):** The shipped mistake path does NOT fabricate a `material_fsrs_state` row. A mistake becomes "FSRS-scheduled" by being a `failure` attempt + `learning_record(kind='mistake')`: it surfaces in `/api/review/due` as a never-reviewed item (`src/server/review/due-list.ts:9-13`), and its first real `review` event creates the FSRS card. So "schedule via FSRS" = enroll the mistake exactly as `/api/embedded-check/attempt` does. We mirror that route precisely, NOT a new FSRS write.

**Mastery threshold:** A mistake is enrolled when the judge event outcome is `failure` (`coarse_outcome === 'incorrect'`). `partial`/`unsupported` do NOT enroll (matching the embedded-check route's `if (outcome === 'failure')` guard).

### 10a. Failing test

Append to `src/server/orchestrator/solve.test.ts`:

```ts
import { submitSolveAttempt } from './solve';
import { event, learning_record } from '@/db/schema';

function seededRubricQuestion() {
  return {
    rubric_json: {
      criteria: [],
      reference_solution: { expected_signals: ['s1', 's2'], final_answer: 'a + b', answer_equivalents: ['a+b'] },
    },
  };
}

function judgeStub(outcome: 'correct' | 'incorrect' | 'partial', score: number) {
  return vi.fn(async () => ({
    route: 'steps' as const,
    result: {
      score,
      score_meaning: 'steps_v1_weighted' as const,
      coarse_outcome: outcome,
      confidence: 0.9,
      capability_ref: { id: 'steps', version: '1.0.0' },
      feedback_md: 'fb',
      evidence_json: {},
    },
    telemetry: {
      route: 'steps' as const,
      capability_ref: { id: 'steps', version: '1.0.0' },
      coarse_outcome: outcome,
      confidence: 0.9,
      elapsed_ms: 1,
      question_id: 'q',
      subject_id: 'math',
    },
  }));
}

describe('submitSolveAttempt', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('typed submit → judge → attempt event written → session judged → reveals worked solution', async () => {
    const id = await seedQuestion(seededRubricQuestion());
    await db.update(question).set({ reference_md: '完整解：a+b。' }).where(eq(question.id, id));
    const { sessionId } = await Tutor.startTutorSession(db, { questionId: id });

    const judgeFn = judgeStub('correct', 0.95);
    const res = await submitSolveAttempt({
      db,
      sessionId,
      submission: { student_text_steps: ['因式分解', '约分'], student_final_answer_text: 'a+b' },
      judgeFn,
    });

    expect(res.judge.coarse_outcome).toBe('correct');
    expect(res.revealed_solution_md).toContain('a+b');
    expect(res.mistake_id).toBeUndefined();

    const [s] = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(s.status).toBe('judged');

    const attempts = await db.select().from(event).where(eq(event.subject_id, id));
    expect(attempts.some((e) => e.action === 'attempt')).toBe(true);
  });

  it('handwritten-photo submit (student_image_refs) follows the same path', async () => {
    const id = await seedQuestion(seededRubricQuestion());
    const { sessionId } = await Tutor.startTutorSession(db, { questionId: id });
    const judgeFn = judgeStub('correct', 0.9);

    const res = await submitSolveAttempt({
      db,
      sessionId,
      submission: { student_image_refs: ['asset_1'] },
      judgeFn,
    });

    expect(res.judge.coarse_outcome).toBe('correct');
    expect(judgeFn).toHaveBeenCalledWith(expect.objectContaining({ student_image_refs: ['asset_1'] }));
  });

  it('low score (incorrect) enrolls a mistake learning_record', async () => {
    const id = await seedQuestion(seededRubricQuestion());
    const { sessionId } = await Tutor.startTutorSession(db, { questionId: id });
    const judgeFn = judgeStub('incorrect', 0);

    const res = await submitSolveAttempt({
      db,
      sessionId,
      submission: { student_final_answer_text: 'wrong' },
      judgeFn,
    });

    expect(res.mistake_id).toBeDefined();
    const records = await db.select().from(learning_record).where(eq(learning_record.question_id, id));
    expect(records).toHaveLength(1);
    expect(records[0].kind).toBe('mistake');
  });

  it('rejects an all-empty submission', async () => {
    const id = await seedQuestion(seededRubricQuestion());
    const { sessionId } = await Tutor.startTutorSession(db, { questionId: id });
    const judgeFn = judgeStub('correct', 1);

    await expect(
      submitSolveAttempt({ db, sessionId, submission: {}, judgeFn }),
    ).rejects.toMatchObject({ code: 'empty_submission' });
    expect(judgeFn).not.toHaveBeenCalled();
  });
});
```

### 10b. Run-fails

```
pnpm vitest run --config vitest.db.config.ts src/server/orchestrator/solve.test.ts
```

Expected: FAIL — `submitSolveAttempt is not exported`.

### 10c. Minimal implementation

Add imports at the top of `src/server/orchestrator/solve.ts`:

```ts
import { createId } from '@paralleldrive/cuid2';
import type { JudgeInvokerOutput } from '@/server/judge/invoker';
import type { JudgeAnswerParams } from '@/server/ai/judges/question-contract';
import { createDefaultJudgeInvoker } from '@/server/judge/invoker';
import { writeEvent } from '@/server/events/queries';
import { createLearningRecord } from '@/server/records/queries';
```

Then add:

```ts
export interface SolveSubmission {
  student_text_steps?: string[];
  student_final_answer_text?: string;
  student_image_refs?: string[];
}

export type JudgeFn = (input: JudgeAnswerParams) => Promise<JudgeInvokerOutput>;

export interface SubmitSolveAttemptParams {
  db: Db;
  sessionId: string;
  submission: SolveSubmission;
  /** Injected in tests; defaults to the production JudgeInvoker. */
  judgeFn?: JudgeFn;
  runTaskFn?: RunTaskFn;
}

export interface SubmitSolveAttemptResult {
  attempt_event_id: string;
  judge: {
    route: string;
    score: number | null;
    coarse_outcome: string;
    confidence: number;
    reason_md: string;
    evidence_json: unknown;
  };
  /** The worked solution revealed after judging (null if generation failed). */
  revealed_solution_md: string | null;
  /** Set when a mistake was enrolled (low score). */
  mistake_id?: string;
}

function hasNonEmptyCarrier(s: SolveSubmission): boolean {
  const steps = (s.student_text_steps ?? []).filter((x) => x.trim().length > 0);
  const finalText = (s.student_final_answer_text ?? '').trim();
  const images = (s.student_image_refs ?? []).filter((x) => x.trim().length > 0);
  return steps.length > 0 || finalText.length > 0 || images.length > 0;
}

function eventOutcomeForJudge(
  coarseOutcome: 'correct' | 'partial' | 'incorrect' | 'unsupported',
): 'success' | 'partial' | 'failure' {
  if (coarseOutcome === 'correct') return 'success';
  if (coarseOutcome === 'incorrect') return 'failure';
  return 'partial';
}

export async function submitSolveAttempt(
  params: SubmitSolveAttemptParams,
): Promise<SubmitSolveAttemptResult> {
  const { db, sessionId, submission } = params;

  if (!hasNonEmptyCarrier(submission)) {
    throw new SolveError(
      'empty_submission',
      'at least one of student_text_steps / student_final_answer_text / student_image_refs must be non-empty',
    );
  }

  const { questionId, status } = await Tutor.getTutorQuestionId(db, sessionId);
  if (!questionId) {
    throw new SolveError('session_not_found', `tutor session ${sessionId} missing question link`);
  }
  if (status !== 'active') {
    throw new SolveError('session_not_active', `tutor session ${sessionId} status=${status}`);
  }

  const [q] = await db.select().from(question).where(eq(question.id, questionId)).limit(1);
  if (!q) throw new SolveError('question_not_found', `question ${questionId} not found`);

  const subjectProfile = await resolveSubjectProfileForKnowledgeIds(db, q.knowledge_ids);

  const answerParts = [...(submission.student_text_steps ?? []), submission.student_final_answer_text]
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  const answerMd = answerParts.join('\n');

  const judgeFn = params.judgeFn ?? ((input) => createDefaultJudgeInvoker().invoke(input));
  const judged = await judgeFn({
    db,
    question: q,
    answer_md: answerMd,
    student_image_refs: submission.student_image_refs ?? [],
    subjectProfile,
    runTaskFn: params.runTaskFn,
  });

  const judgeResult = judged.result;
  const outcome = eventOutcomeForJudge(judgeResult.coarse_outcome);
  const responseJudge = {
    route: judged.route,
    score: judgeResult.score,
    coarse_outcome: judgeResult.coarse_outcome,
    confidence: judgeResult.confidence,
    reason_md: judgeResult.feedback_md,
    evidence_json: judgeResult.evidence_json,
  };

  // session: active → submitted (then → judged after the write commits)
  await Tutor.markSubmitted(db, sessionId);

  const now = new Date();
  const attemptEventId = createId();
  let mistakeId: string | undefined;

  await db.transaction(async (tx) => {
    await writeEvent(tx, {
      id: attemptEventId,
      session_id: sessionId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: q.id,
      outcome,
      payload: {
        answer_md: answerMd.length > 0 ? answerMd : null,
        answer_image_refs: submission.student_image_refs ?? [],
        referenced_knowledge_ids: q.knowledge_ids,
        // provenance (stored in jsonb; stripped by the Zod contract on parse)
        source: 'solve_tutor',
        judge_route: judged.route,
        judge_score: judgeResult.score,
        judge: responseJudge,
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: now,
    });

    if (outcome === 'failure') {
      mistakeId = createId();
      await createLearningRecord(tx, {
        id: mistakeId,
        kind: 'mistake',
        title: null,
        content_md: answerMd.length > 0 ? answerMd : '(handwritten submission)',
        source: 'manual',
        capture_mode: (submission.student_image_refs ?? []).length > 0 ? 'image' : 'text',
        activity_kind: 'attempt',
        processing_status: 'raw',
        origin_event_id: attemptEventId,
        knowledge_ids: q.knowledge_ids,
        question_id: q.id,
        attempt_event_id: attemptEventId,
        asset_refs: submission.student_image_refs ?? [],
        payload: {
          from: 'solve_tutor',
          wrong_answer_md: answerMd,
          judge_route: judged.route,
          judge_score: judgeResult.score,
          judge: responseJudge,
        },
      });
    }
  });

  // session: submitted → judged (reveal happens after this commits)
  await Tutor.markJudged(db, sessionId);

  return {
    attempt_event_id: attemptEventId,
    judge: responseJudge,
    revealed_solution_md: q.reference_md ?? null,
    ...(mistakeId !== undefined ? { mistake_id: mistakeId } : {}),
  };
}
```

NOTE: attribution follow-up (the pg-boss `attribution_followup` job) is enqueued at the ROUTE layer (Task 13), VITEST-gated, via `getStartedBoss()` (YUK-192) — never inside the orchestrator (keeps it testable without boss state).

### 10d. Run-passes

```
pnpm vitest run --config vitest.db.config.ts src/server/orchestrator/solve.test.ts
```

Expected: PASS (all four describe blocks).

### 10e. Commit

```
git add src/server/orchestrator/solve.ts src/server/orchestrator/solve.test.ts
git commit -F - <<'EOF'
feat(solve-tutor): submitSolveAttempt (judge → attempt → reveal → mistake)

Refs YUK-193

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 11 — Route `POST /api/questions/[id]/solve`

**Files:** create `app/api/questions/[id]/solve/route.ts`, create `app/api/questions/[id]/solve/route.test.ts`. Route handlers may ONLY export `POST` + recognized config (`runtime`) — no helper exports (YUK-67). DB/route test → db partition.

### 11a. Failing test

Create `app/api/questions/[id]/solve/route.test.ts`:

```ts
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { learning_session, question } from '@/db/schema';
import { resetDb, testDb } from '../../../../../tests/helpers/db';

vi.mock('@/server/ai/runner', () => ({
  runTask: vi.fn(async () => ({
    text: JSON.stringify({
      reference_solution: { expected_signals: ['s'], final_answer: 'a + b', answer_equivalents: [] },
      worked_solution_md: '解：a+b。',
      confidence: 0.9,
    }),
    task_run_id: 'tr',
    finishReason: 'stop',
    usage: { inputTokens: 0, outputTokens: 0 },
  })),
}));

const db = testDb();

async function seedBareQuestion(): Promise<string> {
  const id = createId();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'derivation',
    prompt_md: '化简 (a^2 - b^2)/(a - b)',
    reference_md: null,
    rubric_json: null as never,
    knowledge_ids: [],
    difficulty: 3,
    source: 'manual',
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return id;
}

describe('POST /api/questions/[id]/solve', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('starts a tutor session and lazily generates a reference solution', async () => {
    const { POST } = await import('./route');
    const id = await seedBareQuestion();
    const res = await POST(new Request('http://t/x', { method: 'POST' }), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session_id: string; generated: boolean };
    expect(body.session_id).toBeTruthy();
    expect(body.generated).toBe(true);
    const [s] = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, body.session_id));
    expect(s.type).toBe('tutor');
  });

  it('404s for an unknown question', async () => {
    const { POST } = await import('./route');
    const res = await POST(new Request('http://t/x', { method: 'POST' }), {
      params: Promise.resolve({ id: 'nope' }),
    });
    expect(res.status).toBe(404);
  });
});
```

### 11b. Run-fails

```
pnpm vitest run --config vitest.db.config.ts "app/api/questions/[id]/solve/route.test.ts"
```

Expected: FAIL — `Cannot find module './route'`.

### 11c. Minimal implementation

Create `app/api/questions/[id]/solve/route.ts`:

```ts
// YUK-193 — POST /api/questions/[id]/solve
//
// Start a solve session on a question. If rubric_json.reference_solution is
// missing, lazily generate it (spec §3.2). Creates learning_session(type='tutor',
// status='active'). Returns { session_id, generated }.
import { z } from 'zod';

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { SolveError, startSolveSession } from '@/server/orchestrator/solve';

export const runtime = 'nodejs';

const Body = z.object({ regenerate: z.boolean().optional() }).nullable();

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    const regenerate = parsed.success && parsed.data ? parsed.data.regenerate : undefined;

    const result = await startSolveSession({ db, questionId: id, regenerate });

    return Response.json({
      session_id: result.sessionId,
      generated: result.generated,
      generation_error: result.generationError,
    });
  } catch (err) {
    if (err instanceof SolveError && err.code === 'question_not_found') {
      return errorResponse(new ApiError('not_found', err.message, 404));
    }
    return errorResponse(err);
  }
}
```

### 11d. Run-passes

```
pnpm vitest run --config vitest.db.config.ts "app/api/questions/[id]/solve/route.test.ts"
```

Expected: PASS (2 tests).

### 11e. Commit

```
git add "app/api/questions/[id]/solve/route.ts" "app/api/questions/[id]/solve/route.test.ts"
git commit -F - <<'EOF'
feat(solve-tutor): POST /api/questions/[id]/solve

Refs YUK-193

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 12 — Route `POST /api/questions/[id]/solve/[sid]/hint`

**Files:** create `app/api/questions/[id]/solve/[sid]/hint/route.ts`, create `app/api/questions/[id]/solve/[sid]/hint/route.test.ts`.

### 12a. Failing test

Create `app/api/questions/[id]/solve/[sid]/hint/route.test.ts`:

```ts
import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { question } from '@/db/schema';
import { Tutor } from '@/server/session';
import { resetDb, testDb } from '../../../../../../../tests/helpers/db';

vi.mock('@/server/ai/runner', () => ({
  runTask: vi.fn(async () => ({
    text: JSON.stringify({ kind: 'explain', text_md: '想想分子能否因式分解？', suggested_next: 'continue' }),
    task_run_id: 'tr',
    finishReason: 'stop',
    usage: { inputTokens: 0, outputTokens: 0 },
  })),
}));

const db = testDb();

describe('POST /api/questions/[id]/solve/[sid]/hint', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns a hint for an active session', async () => {
    const { POST } = await import('./route');
    const id = createId();
    const now = new Date();
    await db.insert(question).values({
      id,
      kind: 'derivation',
      prompt_md: '化简 (a^2 - b^2)/(a - b)',
      reference_md: '完整解：a+b。',
      rubric_json: { criteria: [], reference_solution: { expected_signals: ['s'], final_answer: 'a + b', answer_equivalents: [] } } as never,
      knowledge_ids: [],
      difficulty: 3,
      source: 'manual',
      created_at: now,
      updated_at: now,
      version: 0,
    });
    const { sessionId } = await Tutor.startTutorSession(db, { questionId: id });

    const res = await POST(
      new Request('http://t/x', { method: 'POST', body: JSON.stringify({ hint_index: 0 }) }),
      { params: Promise.resolve({ id, sid: sessionId }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text_md: string };
    expect(body.text_md).toContain('因式分解');
  });
});
```

### 12b. Run-fails

```
pnpm vitest run --config vitest.db.config.ts "app/api/questions/[id]/solve/[sid]/hint/route.test.ts"
```

Expected: FAIL — `Cannot find module './route'`.

### 12c. Minimal implementation

Create `app/api/questions/[id]/solve/[sid]/hint/route.ts`:

```ts
// YUK-193 — POST /api/questions/[id]/solve/[sid]/hint
//
// Request an escalating Socratic hint for an active solve session. Reuses the
// teaching orchestrator's TeachingTurnTask, seeded with the worked solution, to
// return the minimal next step WITHOUT revealing the full solution (spec §3.2).
import { z } from 'zod';

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { SolveError, planSolveHint } from '@/server/orchestrator/solve';

export const runtime = 'nodejs';

const Body = z.object({ hint_index: z.number().int().min(0).max(20).default(0) }).nullable();

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; sid: string }> },
): Promise<Response> {
  try {
    const { sid } = await ctx.params;
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    const hintIndex = parsed.success && parsed.data ? parsed.data.hint_index : 0;

    const hint = await planSolveHint({ db, sessionId: sid, hintIndex });
    return Response.json({ text_md: hint.text_md });
  } catch (err) {
    if (err instanceof SolveError) {
      if (err.code === 'session_not_found' || err.code === 'question_not_found') {
        return errorResponse(new ApiError('not_found', err.message, 404));
      }
      if (err.code === 'llm_parse_failed') {
        return errorResponse(new ApiError('upstream_error', err.message, 502));
      }
    }
    return errorResponse(err);
  }
}
```

### 12d. Run-passes

```
pnpm vitest run --config vitest.db.config.ts "app/api/questions/[id]/solve/[sid]/hint/route.test.ts"
```

Expected: PASS.

### 12e. Commit

```
git add "app/api/questions/[id]/solve/[sid]/hint/route.ts" "app/api/questions/[id]/solve/[sid]/hint/route.test.ts"
git commit -F - <<'EOF'
feat(solve-tutor): POST /api/questions/[id]/solve/[sid]/hint

Refs YUK-193

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 13 — Route `POST /api/questions/[id]/solve/[sid]/submit`

**Files:** create `app/api/questions/[id]/solve/[sid]/submit/route.ts`, create `app/api/questions/[id]/solve/[sid]/submit/route.test.ts`.

### 13a. Failing test

Create `app/api/questions/[id]/solve/[sid]/submit/route.test.ts`:

```ts
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { learning_record, learning_session, question } from '@/db/schema';
import { Tutor } from '@/server/session';
import { resetDb, testDb } from '../../../../../../../tests/helpers/db';

vi.mock('@/server/judge/invoker', () => ({
  createDefaultJudgeInvoker: () => ({
    invoke: vi.fn(async (input: { question: { id: string } }) => ({
      route: 'steps',
      result: {
        score: 0,
        score_meaning: 'steps_v1_weighted',
        coarse_outcome: 'incorrect',
        confidence: 0.9,
        capability_ref: { id: 'steps', version: '1.0.0' },
        feedback_md: 'fb',
        evidence_json: {},
      },
      telemetry: {
        route: 'steps',
        capability_ref: { id: 'steps', version: '1.0.0' },
        coarse_outcome: 'incorrect',
        confidence: 0.9,
        elapsed_ms: 1,
        question_id: input.question.id,
        subject_id: 'math',
      },
    })),
  }),
}));

const db = testDb();

async function seedAndStart(): Promise<{ id: string; sessionId: string }> {
  const id = createId();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'derivation',
    prompt_md: '化简 (a^2 - b^2)/(a - b)',
    reference_md: '完整解：a+b。',
    rubric_json: { criteria: [], reference_solution: { expected_signals: ['s'], final_answer: 'a + b', answer_equivalents: [] } } as never,
    knowledge_ids: [],
    difficulty: 3,
    source: 'manual',
    created_at: now,
    updated_at: now,
    version: 0,
  });
  const { sessionId } = await Tutor.startTutorSession(db, { questionId: id });
  return { id, sessionId };
}

describe('POST /api/questions/[id]/solve/[sid]/submit', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('typed submit → judged, reveals solution, enrolls mistake on low score', async () => {
    const { POST } = await import('./route');
    const { id, sessionId } = await seedAndStart();

    const res = await POST(
      new Request('http://t/x', {
        method: 'POST',
        body: JSON.stringify({ student_final_answer_text: 'wrong' }),
      }),
      { params: Promise.resolve({ id, sid: sessionId }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      judge: { coarse_outcome: string };
      revealed_solution_md: string;
      mistake_id?: string;
    };
    expect(body.judge.coarse_outcome).toBe('incorrect');
    expect(body.revealed_solution_md).toContain('a+b');
    expect(body.mistake_id).toBeDefined();

    const [s] = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(s.status).toBe('judged');
    const records = await db.select().from(learning_record).where(eq(learning_record.question_id, id));
    expect(records).toHaveLength(1);
  });

  it('400 on an all-empty submission', async () => {
    const { POST } = await import('./route');
    const { id, sessionId } = await seedAndStart();
    const res = await POST(
      new Request('http://t/x', { method: 'POST', body: JSON.stringify({}) }),
      { params: Promise.resolve({ id, sid: sessionId }) },
    );
    expect(res.status).toBe(400);
  });
});
```

### 13b. Run-fails

```
pnpm vitest run --config vitest.db.config.ts "app/api/questions/[id]/solve/[sid]/submit/route.test.ts"
```

Expected: FAIL — `Cannot find module './route'`.

### 13c. Minimal implementation

Create `app/api/questions/[id]/solve/[sid]/submit/route.ts`:

```ts
// YUK-193 — POST /api/questions/[id]/solve/[sid]/submit
//
// Submit a solution: typed steps/answer OR a handwritten photo (student_image_refs
// = asset ids from a prior POST /api/assets upload). At least one carrier must be
// non-empty (Math MVP constraint). Routes by question.kind to steps@1 / semantic@1
// via the orchestrator's JudgeInvoker, writes an attempt event, transitions the
// session to judged, reveals the worked solution, and enrolls a mistake on a low
// score. On failure, enqueues attribution_followup (VITEST-gated, getStartedBoss).
import { z } from 'zod';

import { db } from '@/db/client';
import { getStartedBoss } from '@/server/boss/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { SolveError, submitSolveAttempt } from '@/server/orchestrator/solve';

export const runtime = 'nodejs';

const Body = z.object({
  student_text_steps: z.array(z.string()).optional(),
  student_final_answer_text: z.string().optional(),
  student_image_refs: z.array(z.string()).optional(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; sid: string }> },
): Promise<Response> {
  try {
    const { sid } = await ctx.params;
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => i.message).join('; '),
        400,
      );
    }

    const result = await submitSolveAttempt({ db, sessionId: sid, submission: parsed.data });

    // Enqueue attribution after the response path commits (failure only).
    // VITEST guard mirrors /api/mistakes + /api/embedded-check/attempt. Uses
    // getStartedBoss (YUK-192), never createBoss.
    if (result.mistake_id !== undefined && !process.env.VITEST) {
      try {
        const boss = await getStartedBoss();
        await boss.send('attribution_followup', { attempt_event_id: result.attempt_event_id });
      } catch (err) {
        console.warn(`attribution_followup enqueue failed for ${result.attempt_event_id}:`, err);
      }
    }

    return Response.json({
      attempt_event_id: result.attempt_event_id,
      judge: result.judge,
      revealed_solution_md: result.revealed_solution_md,
      ...(result.mistake_id !== undefined ? { mistake_id: result.mistake_id } : {}),
    });
  } catch (err) {
    if (err instanceof SolveError) {
      if (err.code === 'empty_submission') {
        return errorResponse(new ApiError('validation_error', err.message, 400));
      }
      if (err.code === 'session_not_found' || err.code === 'question_not_found') {
        return errorResponse(new ApiError('not_found', err.message, 404));
      }
      if (err.code === 'session_not_active') {
        return errorResponse(new ApiError('conflict', err.message, 409));
      }
    }
    return errorResponse(err);
  }
}
```

### 13d. Run-passes

```
pnpm vitest run --config vitest.db.config.ts "app/api/questions/[id]/solve/[sid]/submit/route.test.ts"
```

Expected: PASS (2 tests).

### 13e. Commit

```
git add "app/api/questions/[id]/solve/[sid]/submit/route.ts" "app/api/questions/[id]/solve/[sid]/submit/route.test.ts"
git commit -F - <<'EOF'
feat(solve-tutor): POST /api/questions/[id]/solve/[sid]/submit

Refs YUK-193

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 14 — Minimal UI entry `SolveTutorPanel`

**Files:** create `src/ui/components/SolveTutorPanel.tsx`. UI is redraw-pending (spec §3.4) — a thin functional shell reusing `JudgeResultPanel` + `apiFetch`.

DESIGN-DOC PRE-FLIGHT (CLAUDE.md UI compliance): the design redraw (WR umbrella) supersedes this entry; spec §3.4 states "No visual polish this phase ... the UI is a thin shell." Component type: a client React component (panel mounted by a parent question view — not drawer/modal/route). Files touched: CREATE `src/ui/components/SolveTutorPanel.tsx` only. No new tokens/primitives; reuses `JudgeResultPanel` + plain elements. Because this is explicitly minimal-by-spec, no separate design doc citation is required beyond §3.4; if the implementing agent wants visual styling beyond functional class names, STOP and ask first.

No automated test (thin UI shell, no business logic; project is in UI-redraw-pending mode where functional shells skip visual QA). Type-safety is verified by `pnpm typecheck` in the gate.

### 14a. Implementation

Create `src/ui/components/SolveTutorPanel.tsx`:

```tsx
'use client';

import { useState } from 'react';

import type { JudgeResultV2T } from '@/core/schema/capability';
import { JudgeResultPanel } from '@/ui/components/JudgeResultPanel';
import { apiFetch } from '@/ui/lib/api';

export interface SolveTutorPanelProps {
  questionId: string;
  /** expected_signals from the question's rubric_json (for JudgeResultPanel zip). */
  expectedSignals?: string[];
  notation?: 'latex' | 'wenyan' | 'plaintext' | 'code';
}

interface JudgeResponse {
  attempt_event_id: string;
  judge: {
    route: string;
    score: number | null;
    coarse_outcome: JudgeResultV2T['coarse_outcome'];
    confidence: number;
    reason_md: string;
    evidence_json: unknown;
  };
  revealed_solution_md: string | null;
  mistake_id?: string;
}

export function SolveTutorPanel({ questionId, expectedSignals = [], notation }: SolveTutorPanelProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [hints, setHints] = useState<string[]>([]);
  const [result, setResult] = useState<JudgeResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/questions/${questionId}/solve`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const body = (await res.json()) as { session_id: string };
      setSessionId(body.session_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : '开练失败');
    } finally {
      setBusy(false);
    }
  }

  async function requestHint() {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/questions/${questionId}/solve/${sessionId}/hint`, {
        method: 'POST',
        body: JSON.stringify({ hint_index: hints.length }),
      });
      const body = (await res.json()) as { text_md: string };
      setHints((h) => [...h, body.text_md]);
    } catch (e) {
      setError(e instanceof Error ? e.message : '获取提示失败');
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/questions/${questionId}/solve/${sessionId}/submit`, {
        method: 'POST',
        body: JSON.stringify({ student_final_answer_text: answer }),
      });
      setResult((await res.json()) as JudgeResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : '提交失败');
    } finally {
      setBusy(false);
    }
  }

  if (!sessionId) {
    return (
      <div className="solve-tutor-panel">
        <button type="button" onClick={start} disabled={busy} className="solve-tutor-panel__start">
          开练
        </button>
        {error && <p className="solve-tutor-panel__error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="solve-tutor-panel">
      {hints.length > 0 && (
        <ol className="solve-tutor-panel__hints">
          {hints.map((h, i) => (
            <li key={`hint-${i}-${h.slice(0, 8)}`}>{h}</li>
          ))}
        </ol>
      )}
      <textarea
        className="solve-tutor-panel__answer"
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder="写下你的步骤 / 最终答案"
      />
      <div className="solve-tutor-panel__actions">
        <button type="button" onClick={requestHint} disabled={busy}>
          要个提示
        </button>
        <button type="button" onClick={submit} disabled={busy || answer.trim().length === 0}>
          提交批改
        </button>
      </div>
      {error && <p className="solve-tutor-panel__error">{error}</p>}
      {result && (
        <>
          <JudgeResultPanel
            result={{
              score: result.judge.score,
              score_meaning: 'steps_v1_weighted',
              coarse_outcome: result.judge.coarse_outcome,
              confidence: result.judge.confidence,
              capability_ref: { id: result.judge.route, version: '1.0.0' },
              feedback_md: result.judge.reason_md,
              evidence_json: result.judge.evidence_json as JudgeResultV2T['evidence_json'],
            }}
            expectedSignals={expectedSignals}
            appealable={false}
            notation={notation}
          />
          {result.revealed_solution_md && (
            <details className="solve-tutor-panel__solution">
              <summary>查看参考解</summary>
              <div>{result.revealed_solution_md}</div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
```

VERIFY before writing: `JudgeResultPanelProps` requires `result: JudgeResultV2T` + `expectedSignals: string[]`, with optional `onAppeal`/`appealable`/`notation` (`src/ui/components/JudgeResultPanel.tsx:12-22`). Confirm the `score_meaning` literal and `evidence_json` field name against `src/core/schema/capability.ts` (`JudgeResultV2`) when implementing — if `score_meaning`'s allowed set or `evidence_json`'s type differs, adjust the cast (render-only shell; type alignment is the only correctness bar).

### 14b. Typecheck

```
pnpm typecheck
```

Expected: typecheck clean. (No component test by design.)

### 14c. Commit

```
git add src/ui/components/SolveTutorPanel.tsx
git commit -F - <<'EOF'
feat(solve-tutor): minimal SolveTutorPanel UI entry (reuses JudgeResultPanel)

Refs YUK-193

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 15 — Pre-PR gate

**Files:** none (verification + final commit `Closes YUK-193`).

### 15a. Run the full gate

```
pnpm typecheck && pnpm lint && pnpm audit:schema && pnpm audit:partition && pnpm audit:profile && pnpm test && pnpm build
```

Expected, gate by gate:
- `pnpm typecheck` — exits 0.
- `pnpm lint` — Biome clean (run `pnpm format` + re-stage if it flags formatting).
- `pnpm audit:schema` — exits 0 with NO new allowlist entries (zero columns added). If it flags a new field needing a write path, STOP — the implementation introduced a column it should not have.
- `pnpm audit:partition` — exits 0. Unit tests added (`src/core/schema/solution.test.ts`, `src/core/schema/learning_session.test.ts`, the `src/server/session/index.test.ts` addition, `src/ai/*.test.ts` additions) are covered by `src/core/**` / `src/ai/**` / the enumerated `src/server/session/index.test.ts`. DB tests (`src/server/ai/solution-generate.test.ts`, `src/server/session/tutor.test.ts`, `src/server/orchestrator/solve.test.ts`, the three route tests) import `tests/helpers/db` and are NOT in `fastTestInclude`, so they fall through to the db partition. If flagged, ensure db-touching tests aren't matched by a `fastTestInclude` glob (none of the new paths are) and unit tests don't import `tests/helpers/db`.
- `pnpm audit:profile` — exits 0 (no SubjectProfile changed).
- `pnpm test` — full gate green, including `tests/integration/session-single-owner.test.ts` (tutor.ts is in `src/server/session/`, compliant).
- `pnpm build` — `next build` succeeds; new route handlers pass Next's route export validation (each exports only `POST` + `runtime`). If build fails on `DATABASE_URL` at page-data in a bare worktree, supply a placeholder env (known non-regression).

### 15b. Linear gate

Update Linear YUK-193: link the PR, mark the two phases (generator + orchestrator) shipped, confirm the out-of-scope items (batch gen, turn-by-turn co-solve, streaming hints, new judge capabilities, new mistake/FSRS path) remain deferred — not undertracked. Create Linear issues for any follow-ups that surfaced (e.g. batch-generation job, `/solve/[sid]/end` route, a real component test).

### 15c. Final commit

If any gate fix touched files, commit with the closing keyword:

```
git add -A
git commit -F - <<'EOF'
chore(solve-tutor): pre-PR gate green

Closes YUK-193

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

(If no gate fix was needed, add `Closes YUK-193` to the PR description instead — do not fabricate an empty commit unless the wave workflow requires a trailer-only commit.)

---

## Critical details

**Error handling.** `SolveError`'s discriminant `code` maps to HTTP at the route boundary (`question_not_found`/`session_not_found`→404, `empty_submission`→400, `session_not_active`→409, `llm_parse_failed`→502). `generateReferenceSolution` NEVER throws on LLM/parse failure — it returns `skipped_error`; `startSolveSession` opens the session anyway (degraded). If the judge later returns `unsupported` (no reference solution), the submit route still writes the attempt with `coarse_outcome='unsupported'` → event outcome `partial` (no 500, no mistake) — the UI surfaces "无法判分" via `JudgeResultPanel`'s `unsupported` tone.

**State management.** `learning_session(type='tutor')` is written ONLY through `src/server/session/tutor.ts` (ADR-0005 single-owner; enforced by `tests/integration/session-single-owner.test.ts`). The submit flow advances `active → submitted` (before the event write) then `submitted → judged` (after), so a crash mid-write leaves the session in `submitted` (recoverable / abandonable), never a phantom `judged`.

**Evidence-first.** Every AI call (gen, hint, judge) flows through `runTask`, which writes `ai_task_runs` + `cost_ledger` rows. The generated rubric carries `reference_solution_source: 'ai_generated'`. The attempt is an `event(action='attempt')` carrying the full `JudgeResultV2` in its payload — traceable + reversible (ADR-0005).

**FSRS reuse (no new path).** Mistake enrollment = `failure` attempt event + `createLearningRecord(kind='mistake')`, byte-for-byte the shipped `/api/embedded-check/attempt` posture. The question becomes due via the never-reviewed failure-attempt stream (`src/server/review/due-list.ts:9-13`); its FSRS card is created on the first `review` event by the existing review/submit path. We do NOT write `material_fsrs_state`.

**Enqueue safety.** The only async enqueue is `attribution_followup` on failure, at the submit ROUTE, VITEST-gated, via `getStartedBoss()` (YUK-192) — never `createBoss()`.

**Testing / LLM seam.** No live LLM/judge in any test: `runTaskFn`/`judgeFn` injected into `generateReferenceSolution` / orchestrator helpers (mirrors `auto-enroll.test.ts` + `steps-judge.test.ts`); routes `vi.mock('@/server/ai/runner')` / `vi.mock('@/server/judge/invoker')` before importing the route module. Unit vs db partition strictly honors `vitest.shared.ts:fastTestInclude` — db-touching tests import `tests/helpers/db` and stay out of `fastTestInclude`.

**Security.** All `/api/*` requests already require `x-internal-token` via `middleware.ts`. The submit route relies on the judge's `defaultImageFetch` to skip missing assets; photo upload mime/size validation is owned by the existing `POST /api/assets`.

---

## Self-Review

**Spec coverage (§10 order):** (1) `SolutionGenerateTask` registry+prompt+server module (Tasks 1–4) ✓ merge-preserving + reference_md + provenance + lazy/idempotent/subject-aware/logged-skip; (2) `TutorStatus` expansion + `LearningSessionStatusByType` arm (Task 5) ✓ no migration (text columns confirmed schema.ts:518,520); (3) `src/server/orchestrator/solve.ts` (Tasks 8–10) ✓; (4) routes solve/hint/submit multimodal ≥1-non-empty (Tasks 11–13) ✓; (5) minimal UI reusing `JudgeResultPanel` (Task 14) ✓; (6) pre-PR gate (Task 15) ✓. Acceptance criteria 1–6 all map to tests. Out-of-scope items unbuilt.

**Placeholder scan:** No "TBD" / "similar to Task N" / "add error handling" — every task carries complete runnable code, exact commands, expected output. Two explicit VERIFY-before-write notes (Task 14's `JudgeResultV2T` cast; the `assertFromState` arg order; the Task 9 unknown-session assertion correction) are grounding checks against real signatures, not placeholders.

**Type consistency:** `SolutionGenerateOutput.reference_solution` reuses `RubricReferenceSolution` → drops straight into `Rubric.reference_solution`. `generateReferenceSolution` returns a discriminated `status` union consumed by `startSolveSession`. `submitSolveAttempt`'s `JudgeFn` is typed against the real `JudgeAnswerParams`/`JudgeInvokerOutput` so the production `createDefaultJudgeInvoker().invoke` and the test stub share one shape. Event payload matches `AttemptOnQuestion` (`answer_md` nullable, `answer_image_refs`, `referenced_knowledge_ids`); `createLearningRecord` args match `CreateLearningRecordInput` as used by the mistakes + embedded-check routes. `TutorStatus` values match the strings written by `tutor.ts` and validated by `LearningSessionStatusByType`.

**Resolved ambiguities:**
1. *"Schedule via FSRS"* — shipped mistake path does NOT write `material_fsrs_state`; enrollment = failure attempt + `learning_record`, surfacing in the never-reviewed due stream, FSRS card on first review. Plan mirrors `/api/embedded-check/attempt`. (Resolved by reading due-list.ts + fsrs/state.ts + embedded-check route.)
2. *Mastery threshold* — "low score" = judge `coarse_outcome` mapping to event outcome `failure` (`incorrect→failure`); `partial` does NOT enroll, matching the embedded-check `if (outcome === 'failure')` guard.
3. *TutorStatus migration* — `learning_session.type`/`status` are `text()` columns (schema.ts:518,520) → no migration, no `audit:schema` entry.
4. *Session↔question linkage* — reuse the `goal_id` slot for `question_id`, mirroring `conversation.ts`.
5. *Hint non-revelation* — enforced by the TeachingTurnTask prompt; the orchestrator asks for the next step only and never echoes `reference_md`.

No placeholders remain; all code blocks are complete and use the project's real test/lint/build invocations.
