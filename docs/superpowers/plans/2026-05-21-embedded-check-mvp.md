# Embedded Check MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "Phase 3 占位" embedded check placeholder in atomic notes with real AI-generated inline questions that the user can answer in place. Wrong answers feed the existing failure pipeline (mistake row → attribution_followup → variant_gen). Correct answers stay self-contained in the artifact, not auto-scheduled into FSRS daily review.

**Architecture:** Keep the verifier-style "separate lifecycle axis" pattern shipped by NoteVerify. `note_generate` writes note sections with `embedded_check=null`. `note_verify` runs as today; on `verdict='pass'` it calls a new `onVerified` callback that enqueues `embedded_check_generate`. Spending LLM cost on questions for a note that already failed verification is wasteful — chaining behind the verifier is the cost-control gate (per user direction, "仅 verified note 才生 embedded check"). The new handler calls `EmbeddedCheckGenerateTask`, inserts 1–3 questions into the `question` table with `source='embedded'`, and updates the artifact's check section + a new `embedded_check_status` column. UI loads the generated questions, lets the user answer inline, and posts attempts to a new dedicated endpoint that bypasses FSRS scheduling but writes the same `attempt` event + `learning_record (kind='mistake')` substrate that `attribution_followup` already consumes.

**Tech Stack:** Next.js App Router, Drizzle/Postgres, pg-boss, Zod schemas, existing AI task registry/runner, Vitest, ts-fsrs (untouched), SubjectProfile (`promptFragments.checkQuestionPolicy` already declared).

---

## Preconditions

- Branch from latest `origin/main` (current HEAD `8cb1034 NoteVerifyTask Pass 2 (#67)` or newer). NoteVerify boss handler + verification status columns must be on the base — this plan piggybacks on the same `onReady` hook in `note_generate.ts`.
- Foundation B `unit_error` end-to-end already shipped (`e5d6ecf` + `5644749`). Math profile is treated as a first-class pressure subject; cause flow must continue to work after this slice.
- pg-boss queue worker is already wired up at app boot via `src/server/boss/handlers.ts:registerHandlers`. This slice adds one more `await boss.createQueue` + `await boss.work` block; no infra change.
- `pnpm dev:local` / `pnpm test` already point at the compose Postgres (PR #70). Do not introduce a separate test DB.
- Do **not** broaden into: question-kind UI for non-check sections, retake history surface, embedded check verifier (Pass 2), or section-level note editing — those are Slice 2/3 of the Product Track 1 phase plan (`~/.claude/plans/plan-cozy-corbato.md`).

## Resolved Open Questions (decided in phase plan + this section)

1. **Inline attempt endpoint** — **new `/api/embedded-check/attempt`**. Reusing `/api/review/submit` would force FSRS state writes for self-test questions and pollute the spaced-rep schedule; the new endpoint writes an `attempt` event via `writeEvent` + a `learning_record` row via `createLearningRecord({ kind: 'mistake', ... })` on failure, then explicitly enqueues `attribution_followup`. **The legacy `mistake` table was DROPped in Phase 1c.1 Step 9.J (ADR-0006 v2) — there is no `db.insert(mistake)` anymore.** Read `app/api/mistakes/route.ts:130-170` for the canonical pattern and copy it; do not invent a new write path.
2. **Regeneration on same atomic note** — MVP not supported. `embedded_check_status` enters `pending → ready|failed`; reset/retry is out of scope. User can answer multiple times (multiple attempt events), but the question rows themselves are stable.
3. **Question count** — 1 to 3 per atomic note. Prompt enforces `≤3`; runtime accepts 1 as minimum, rejects 0 (treat as failure).
4. **Generation failure** — surface `embedded_check_status='failed'` in UI with the same neutral copy "embedded check 暂未生成"; do NOT block note content rendering. No automatic retry — re-enqueue is a manual ops action.
5. **page.tsx refactor** — IN scope here (extract `ArtifactSections.tsx`). The phase plan flags `learning-items/[id]/page.tsx` growing big across slices 1/3/5; cutting the seam now while you're already touching the check renderer is cheaper than later.
6. **Question kind selection** — driven by the canonical `QuestionKind` enum (`choice | true_false | fill_blank | short_answer | essay | computation | reading | translation`). Subject voice and style are injected via `SubjectProfile.promptFragments.checkQuestionPolicy`. The subject-level `questionKinds` array is NOT used in the embedded-check prompt — that array is reserved for prompts that need subject-specific vocabulary (e.g. `variant_gen`).
7. **Cost gate (verdict='pass' only)** — `embedded_check_generate` is enqueued by `note_verify.onVerified` (a new callback that fires only on `verdict='pass'`), NOT by `note_generate.onReady`. Notes that hit `needs_review` or `failed` verification skip embedded check generation entirely. This is the **cost control** decided by the user (option B in phase planning) — cuts ~50% of LLM spend vs the parallel-enqueue design.
8. **`question.choices_md` column does not exist** — add it as part of the Task 1 migration (`jsonb('choices_md').$type<string[] | null>()`). Existing rows get NULL by default. No backfill needed; choice questions today encode options in `prompt_md` text and we leave them alone.

## File Structure

**Schema + DB**:
- Modify `src/core/schema/business.ts` — add `ArtifactEmbeddedCheckStatus` enum.
- Modify `src/core/schema/index.ts` — extend runtime `Artifact` schema with `embedded_check_status`; extend runtime `Question` schema with `choices_md`.
- Modify `src/db/schema.ts` — add `embedded_check_status` column to `artifact`; add `choices_md` column to `question`.
- Generate `drizzle/00XX_*.sql` — single migration adding both columns + defaults.
- Modify `src/core/schema/schema.test.ts` — cover new fields happy path + invalid status.

**AI task**:
- Modify `src/ai/registry.ts` — register `EmbeddedCheckGenerateTask`.
- Modify `src/ai/task-prompts.ts` — add `buildEmbeddedCheckGeneratePrompt(profile)` + dispatch.
- Modify `src/ai/task-prompts.test.ts` — assert profile-aware prompt content.

**Boss handler**:
- Create `src/server/boss/handlers/embedded_check_generate.ts` — pure runner + handler builder.
- Create `src/server/boss/handlers/embedded_check_generate.test.ts` — lifecycle coverage.
- Modify `src/server/boss/handlers/note_verify.ts` — add `onVerified?: (artifactId: string) => Promise<void>` callback that fires only when `verdict='pass'` (so embedded_check skips notes that hit `needs_review` / `failed`).
- Modify `src/server/boss/handlers/note_verify.test.ts` — cover onVerified called on pass, NOT called on needs_review / failed / thrown errors.
- Modify `src/server/boss/handlers.ts` — register `embedded_check_generate` queue + work; wire `note_verify.onVerified` to enqueue embedded_check_generate. `note_generate.onReady` stays a single-callback enqueuing only `note_verify`.

**API surface**:
- Modify `app/api/learning-items/[id]/route.ts` — include embedded question rows (id, kind, prompt_md, choices_md, embedded_check_status) in the primary artifact response.
- Modify `app/api/learning-items/[id]/route.test.ts` — assert embedded questions surface.
- Create `app/api/embedded-check/attempt/route.ts` — POST handler for inline attempts (no FSRS).
- Create `app/api/embedded-check/attempt/route.test.ts` — happy path, wrong path (mistake row), idempotency.

**UI**:
- Create `src/ui/components/ArtifactSections.tsx` — extracted from current inline JSX in `learning-items/[id]/page.tsx`. Renders all section kinds; check section delegates to `EmbeddedCheckSection`.
- Create `src/ui/components/EmbeddedCheckSection.tsx` — renders question list, choice/blank input, submit, status badge, post-submit feedback.
- Modify `app/(app)/learning-items/[id]/page.tsx` — replace inline `artifact.sections.map(...)` with `<ArtifactSections />`; pass embedded question payload down.
- Modify `app/globals.css` — `.embedded-check-question`, `.embedded-check-status.{pending,ready,failed}`, `.embedded-check-feedback` styles consistent with NoteVerify badge palette.

**Docs**:
- Modify `docs/superpowers/status.md` — flip "Embedded check" line ⬜ → ✅; note pg-boss queue addition.
- Modify `docs/modules/lanes.md` — add `embedded_check_generate` lane row.
- Modify `CLAUDE.md` — fix the long-stale `AI SDK v6` description while you're here (audit-drift 2026-05-19 contradicted finding). One-line change to §Stack.

---

## Task 1: Artifact embedded_check_status + Question choices_md schema

**Files:**
- Modify: `src/core/schema/business.ts`
- Modify: `src/core/schema/index.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/core/schema/schema.test.ts`
- Generate: `drizzle/00XX_*.sql` (single migration covering BOTH new columns)

- [ ] **Step 1: Add failing schema test**

In `src/core/schema/schema.test.ts`, append to the existing `Artifact accepts runtime generation and verification statuses` block (or add an adjacent `it`) :

```ts
it('Artifact accepts runtime embedded_check_status values', () => {
  const now = new Date();
  for (const status of ['not_required', 'pending', 'ready', 'failed'] as const) {
    const result = Artifact.safeParse({
      // ... copy of existing Artifact fixture from NoteVerify test ...
      embedded_check_status: status,
    });
    expect(result.success, `status=${status}`).toBe(true);
  }
});

it('Artifact rejects unknown embedded_check_status', () => {
  const result = Artifact.safeParse({
    /* ... existing fixture ... */
    embedded_check_status: 'bogus',
  });
  expect(result.success).toBe(false);
});
```

- [ ] **Step 2: Confirm failure**

```bash
pnpm vitest run src/core/schema/schema.test.ts
```

Expected: `embedded_check_status` is not on `Artifact`.

- [ ] **Step 3: Add Zod enum**

In `src/core/schema/business.ts`, near `ArtifactGenerationStatus`:

```ts
export const ArtifactEmbeddedCheckStatus = z.enum([
  'not_required',
  'pending',
  'ready',
  'failed',
]);
export type ArtifactEmbeddedCheckStatusT = z.infer<typeof ArtifactEmbeddedCheckStatus>;
```

In `src/core/schema/index.ts`, extend `Artifact`:

```ts
embedded_check_status: b.ArtifactEmbeddedCheckStatus,
```

- [ ] **Step 4: Add Drizzle columns**

In `src/db/schema.ts`, inside the `artifact` table builder, after `verification_status`:

```ts
embedded_check_status: text('embedded_check_status').notNull().default('not_required'),
```

Default `not_required` matches the prior behavior for non-note_atomic artifacts.

In the `question` table builder, after `rubric_json`:

```ts
choices_md: jsonb('choices_md').$type<string[] | null>(),
```

Nullable; only embedded check questions populate it for now.

In `src/core/schema/index.ts`, extend the runtime `Question` schema with `choices_md: z.array(z.string()).nullable()` to match.

- [ ] **Step 5: Generate migration**

```bash
pnpm db:generate
```

Confirm one new file appears under `drizzle/00XX_*.sql` adding `artifact.embedded_check_status` AND `question.choices_md`. Inspect it — should be two `ALTER TABLE ... ADD COLUMN` statements (artifact with NOT NULL DEFAULT, question nullable).

- [ ] **Step 6: Rerun tests**

```bash
pnpm vitest run src/core/schema/schema.test.ts
```

Should pass. Commit.

- [ ] **Step 7: Schema audit**

```bash
pnpm audit:schema
```

Must pass — write paths come in later tasks. If `audit:schema` fails because no INSERT/UPDATE references the new column yet, add an allowlist entry in `scripts/audit-schema-allowlist.json` with `resolves_when: "Slice 1 embedded_check_generate handler writes embedded_check_status"`. Remove the allowlist entry in Task 3.

---

## Task 2: EmbeddedCheckGenerateTask AI registry + prompt

**Files:**
- Modify: `src/ai/registry.ts`
- Modify: `src/ai/task-prompts.ts`
- Modify: `src/ai/task-prompts.test.ts`

- [ ] **Step 1: Add failing prompt test**

In `src/ai/task-prompts.test.ts`:

```ts
it('builds EmbeddedCheckGenerateTask prompt from the subject profile', () => {
  const wenyan = getTaskSystemPrompt('EmbeddedCheckGenerateTask');
  const math = getTaskSystemPrompt('EmbeddedCheckGenerateTask', resolveSubjectProfile('math'));

  expect(wenyan).toContain('文言文');
  expect(wenyan).toMatch(/choice|translation/i);
  expect(math).toContain('数学');
  expect(math).toMatch(/fill_blank|computation/i);
  // Both must enumerate the contract shape we will parse against
  for (const prompt of [wenyan, math]) {
    expect(prompt).toContain('EmbeddedCheckQuestion');
    expect(prompt).toContain('kind');
    expect(prompt).toContain('reference_md');
  }
});
```

- [ ] **Step 2: Confirm failure**

```bash
pnpm vitest run src/ai/task-prompts.test.ts
```

Expected: unknown task kind.

- [ ] **Step 3: Add the builder**

In `src/ai/task-prompts.ts`, after `buildNoteVerifyPrompt`:

```ts
function buildEmbeddedCheckGeneratePrompt(profile: SubjectProfile): string {
  const allowedKinds = profile.questionKinds.join(' | ');
  return `你是${profile.displayName}自检题作者。输入 { artifact_id, atomic_title, knowledge_node, sections } —— sections 是已生成的 atomic note 内容。
基于这篇笔记，出 1 到 3 道短自检题（学习者读完笔记就能马上验自己懂没懂），不出超纲题。

每题输出形状（EmbeddedCheckQuestion）：
{
  "kind": "${allowedKinds}",
  "prompt_md": "题面 markdown，可含 LaTeX",
  "reference_md": "标准答案 + 简短解析 markdown",
  "choices_md": ["选项 A", "选项 B", ...]  // 仅当 kind='choice' 时；其它 kind 留 null
}

整体严格 JSON 输出（不带 markdown 代码块包裹），shape 名 EmbeddedCheckGenerationResult：
{"questions": [EmbeddedCheckQuestion, ...]}

题目要求：
- 类型从 ${allowedKinds} 中选，符合 ${profile.displayName} 学习习惯
- ${profile.promptFragments.checkQuestionPolicy}
- ${profile.grounding.uncertaintyPolicy}
- 题面 prompt_md ≤ 400 字；reference_md ≤ 500 字
- choice 题给 3–4 个选项；标准答案放 reference_md 第一行
- 不要重复笔记里出现过的"经典示例"，要求学习者迁移应用
- 不出"超 atomic 范围"的综合题
禁止：emoji、营销话、套话、JSON 之外的文字、markdown 代码块包裹整段 JSON。`;
}
```

In the dispatch switch at the bottom of `getTaskSystemPrompt`:

```ts
case 'EmbeddedCheckGenerateTask':
  return buildEmbeddedCheckGeneratePrompt(profile);
```

- [ ] **Step 4: Register the task**

In `src/ai/registry.ts`, after `NoteVerifyTask`:

```ts
EmbeddedCheckGenerateTask: {
  kind: 'EmbeddedCheckGenerateTask',
  description: 'Product Track 1 — generate 1-3 self-test questions for an atomic note',
  defaultProvider: 'xiaomi',
  defaultModel: 'mimo-v2.5-pro',
  fallbackChain: [{ provider: 'xiaomi', model: 'mimo-v2.5' }],
  budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
  needsToolCall: false,
  isMultimodal: false,
  allowedTools: [],
  // fallback only; runtime uses getTaskSystemPrompt(task, profile)
  systemPrompt:
    '你是自检题作者。基于 atomic note 输出 1-3 道短自检题。严格输出 EmbeddedCheckGenerationResult JSON。',
},
```

- [ ] **Step 5: Verify**

```bash
pnpm vitest run src/ai/task-prompts.test.ts
pnpm typecheck
```

Both green. Commit.

---

## Task 3: embedded_check_generate boss handler

**Files:**
- Create: `src/server/boss/handlers/embedded_check_generate.ts`
- Create: `src/server/boss/handlers/embedded_check_generate.test.ts`

**Pattern reference (read first):**
- `src/server/boss/handlers/note_verify.ts` — verifier handler model (DepsOverride, JSON parser, append-only event write)
- `src/server/boss/handlers/variant_gen.ts` — question table insert pattern (knowledge_ids array, root_question_id, FSRS state init)

- [ ] **Step 1: Write the runner test first**

`src/server/boss/handlers/embedded_check_generate.test.ts` covers:

1. **Happy path**: seeded ready atomic artifact with sections → runner writes N question rows (`source='embedded'`), updates `artifact.embedded_check_status='ready'`, updates the `check` section's `embedded_check.question_ids` array, writes one `experimental:embedded_check_generate` event with outcome='success' and `payload.question_ids`.
2. **Skipped: artifact not found** — returns `'skipped:not_found'`, no DB writes.
3. **Skipped: artifact not ready** — `generation_status='pending'` → returns `'skipped:not_ready'`, no writes.
4. **Skipped: no check section** — sections present but no `kind='check'` → `'skipped:no_check_section'`, no writes.
5. **Skipped: already ready** — `embedded_check_status='ready'` → idempotent skip (avoid double-enqueue from pg-boss retries).
6. **AI rejects (returns 0 questions)** — handler sets `embedded_check_status='failed'`, writes failure event with outcome='failure', does NOT throw (no pg-boss retry — bad output is terminal).
7. **AI returns malformed JSON** — handler sets `failed`, writes failure event, throws so pg-boss records the job error.
8. **Profile drives prompt** — handler resolves `subjectProfile` from `knowledge.domain` and passes it into `runTaskFn`'s ctx. Test the math path by seeding a `knowledge.domain='math'` row.
9. **buildEmbeddedCheckGenerateHandler invokes runner for each job** — same pattern as NoteVerify handler test.

Each test seeds via `resetDb(); db.insert(artifact)... db.insert(knowledge)...`. Use `vi.fn` for `runTaskFn` to inject `{ text: VALID_OUTPUT_JSON }` or simulated failures.

- [ ] **Step 2: Confirm all 9 fail**

```bash
pnpm vitest run src/server/boss/handlers/embedded_check_generate.test.ts
```

All red (file does not exist yet).

- [ ] **Step 3: Implement the runner + handler**

`src/server/boss/handlers/embedded_check_generate.ts`:

```ts
// Product Track 1 — generate inline self-test questions for atomic notes.
//
// Enqueued after note_generate marks an atomic artifact ready. Runs in
// parallel with note_verify and shares nothing with it: embedded check is
// about quizzing the learner, verify is about checking the writer. The
// generated questions are real question rows (source='embedded') so the
// existing attempt/mistake/attribution pipelines just work; only the
// scheduling axis (FSRS) is bypassed because embedded check is not a
// spaced-rep surface.

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { z } from 'zod';

import { newId } from '@/core/ids';
import { QuestionKind } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { artifact, knowledge, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { resolveSubjectProfile } from '@/subjects/profile';

export interface EmbeddedCheckGenerateJobData {
  artifact_id: string;
}

export type RunTaskFn = (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;

type DepsOverride = { runTaskFn?: RunTaskFn };

const EmbeddedCheckQuestionSchema = z.object({
  kind: QuestionKind,
  prompt_md: z.string().min(1).max(400),
  reference_md: z.string().min(1).max(500),
  choices_md: z.array(z.string().min(1)).max(6).nullable().optional(),
});
const EmbeddedCheckOutputSchema = z.object({
  questions: z.array(EmbeddedCheckQuestionSchema).min(1).max(3),
});
type EmbeddedCheckOutput = z.infer<typeof EmbeddedCheckOutputSchema>;

function parseOutput(text: string): EmbeddedCheckOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseOutput: no JSON object found in text');
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`parseOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  const parsed = EmbeddedCheckOutputSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `parseOutput: schema invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return parsed.data;
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

export interface RunEmbeddedCheckGenerateParams {
  db: Db;
  artifactId: string;
  runTaskFn: RunTaskFn;
}

export type RunEmbeddedCheckGenerateStatus =
  | 'ready'
  | 'failed'
  | 'skipped:not_found'
  | 'skipped:not_ready'
  | 'skipped:no_check_section'
  | 'skipped:already_ready';

export interface RunEmbeddedCheckGenerateResult {
  status: RunEmbeddedCheckGenerateStatus;
  question_ids?: string[];
}

export async function runEmbeddedCheckGenerate(
  params: RunEmbeddedCheckGenerateParams,
): Promise<RunEmbeddedCheckGenerateResult> {
  const { db, artifactId, runTaskFn } = params;

  const rows = await db
    .select({
      id: artifact.id,
      title: artifact.title,
      knowledge_id: artifact.knowledge_id,
      sections: artifact.sections,
      generation_status: artifact.generation_status,
      embedded_check_status: artifact.embedded_check_status,
    })
    .from(artifact)
    .where(eq(artifact.id, artifactId))
    .limit(1);
  const row = rows[0];
  if (!row) return { status: 'skipped:not_found' };
  if (row.generation_status !== 'ready') return { status: 'skipped:not_ready' };
  if (row.embedded_check_status === 'ready') return { status: 'skipped:already_ready' };

  const sections = (row.sections ?? []) as Array<{
    id: string;
    kind: string;
    embedded_check?: { question_ids: string[] } | null;
  }>;
  const checkSection = sections.find((s) => s.kind === 'check');
  if (!checkSection) return { status: 'skipped:no_check_section' };

  // Resolve subject profile for prompt
  let kNode: { id: string; name: string; domain: string | null } | null = null;
  if (row.knowledge_id) {
    const kRows = await db
      .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
      .from(knowledge)
      .where(eq(knowledge.id, row.knowledge_id))
      .limit(1);
    kNode = kRows[0] ?? null;
  }
  const subjectProfile = resolveSubjectProfile(kNode?.domain);

  // Mark pending so the UI shows "正在生成..." while AI runs
  await db
    .update(artifact)
    .set({ embedded_check_status: 'pending', updated_at: new Date() })
    .where(eq(artifact.id, artifactId));

  const input = {
    artifact_id: row.id,
    atomic_title: row.title,
    knowledge_node: kNode,
    sections,
  };

  try {
    const result = await runTaskFn('EmbeddedCheckGenerateTask', input, {
      db,
      subjectProfile,
    });
    const parsed = parseOutput(result.text);

    // Insert question rows in a single transaction, then update artifact
    const questionIds: string[] = [];
    await db.transaction(async (tx) => {
      for (const q of parsed.questions) {
        const id = newId();
        await tx.insert(question).values({
          id,
          kind: q.kind,
          source: 'embedded',
          prompt_md: q.prompt_md,
          reference_md: q.reference_md,
          choices_md: q.choices_md ?? null,
          knowledge_ids: row.knowledge_id ? [row.knowledge_id] : [],
          difficulty: 2,
          source_artifact_id: row.id,
          // FSRS isn't initialised here — embedded check questions don't
          // enter the spaced-rep surface unless the user later actively
          // promotes them. The first FSRS write happens lazily if/when
          // /api/review/submit ever sees this question_id.
          created_at: new Date(),
          updated_at: new Date(),
        });
        questionIds.push(id);
      }

      const updatedSections = sections.map((s) =>
        s.id === checkSection.id ? { ...s, embedded_check: { question_ids: questionIds } } : s,
      );
      await tx
        .update(artifact)
        .set({
          sections: updatedSections as never,
          embedded_check_status: 'ready',
          updated_at: new Date(),
        })
        .where(eq(artifact.id, artifactId));
    });

    await writeEvent(db, {
      id: createId(),
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'embedded_check_generate',
      action: 'experimental:embedded_check_generate',
      subject_kind: 'artifact',
      subject_id: artifactId,
      outcome: 'success',
      payload: { question_ids: questionIds, count: questionIds.length },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(),
    });

    return { status: 'ready', question_ids: questionIds };
  } catch (err) {
    await db
      .update(artifact)
      .set({ embedded_check_status: 'failed', updated_at: new Date() })
      .where(eq(artifact.id, artifactId));
    await writeEvent(db, {
      id: createId(),
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'embedded_check_generate',
      action: 'experimental:embedded_check_generate',
      subject_kind: 'artifact',
      subject_id: artifactId,
      outcome: 'failure',
      payload: { error: String((err as Error).message ?? err) },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(),
    });
    throw err;
  }
}

export function buildEmbeddedCheckGenerateHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<EmbeddedCheckGenerateJobData>[]) => Promise<void> {
  const runTaskFn = deps.runTaskFn ?? defaultRunTaskFn;
  return async (jobs) => {
    for (const job of jobs) {
      const artifactId = job.data?.artifact_id;
      if (!artifactId) {
        console.warn('[embedded_check_generate] job missing artifact_id', job.id);
        continue;
      }
      const result = await runEmbeddedCheckGenerate({ db, artifactId, runTaskFn });
      console.log(`[embedded_check_generate] ${artifactId} -> ${result.status}`);
    }
  };
}
```

- [ ] **Step 4: Verify all 9 tests pass**

```bash
pnpm vitest run src/server/boss/handlers/embedded_check_generate.test.ts
```

Fix anything red. Commit.

- [ ] **Step 5: Remove the audit allowlist entry**

If you added one in Task 1 Step 7, remove it now — `embedded_check_status` has a write path (the runner updates it on every success/failure). Re-run `pnpm audit:schema` to confirm.

---

## Task 4: note_verify onVerified hook (cost-gated chain)

**Files:**
- Modify: `src/server/boss/handlers/note_verify.ts`
- Modify: `src/server/boss/handlers/note_verify.test.ts`
- Modify: `src/server/boss/handlers.ts`

**Why this design**: the user chose "仅 verified note 才生 embedded check" to cut ~50% of LLM cost. Parallel-enqueueing both note_verify and embedded_check_generate from `note_generate.onReady` would burn embedded-check tokens even when the underlying note fails verification. Chaining via a new `onVerified` hook in `note_verify` is the minimal change that enforces "pass only".

`note_generate.ts` stays as-is (single `onReady` callback) — that's already correct after NoteVerify pass2.

- [ ] **Step 1: Add failing tests in `note_verify.test.ts`**

Three new cases:

```ts
it('onVerified fires when verdict=pass', async () => {
  /* seed ready atomic with sections; runTaskFn returns valid pass JSON */
  const onVerified = vi.fn(async (_id: string) => {});
  const handler = buildNoteVerifyHandler(testDb(), { runTaskFn, onVerified });
  await handler([{ id: 'job1', data: { artifact_id: 'a1' } } as never]);
  expect(onVerified).toHaveBeenCalledWith('a1');
});

it('onVerified does NOT fire when verdict=needs_review', async () => {
  /* seed; runTaskFn returns verdict='needs_review' */
  const onVerified = vi.fn(async (_id: string) => {});
  const handler = buildNoteVerifyHandler(testDb(), { runTaskFn, onVerified });
  await handler([{ id: 'job1', data: { artifact_id: 'a1' } } as never]);
  expect(onVerified).not.toHaveBeenCalled();
});

it('onVerified does NOT fire when runner throws', async () => {
  /* runTaskFn returns malformed JSON → handler should set status='failed' and throw */
  const onVerified = vi.fn(async (_id: string) => {});
  const handler = buildNoteVerifyHandler(testDb(), { runTaskFn, onVerified });
  await expect(handler([{ id: 'job1', data: { artifact_id: 'a1' } } as never])).rejects.toThrow();
  expect(onVerified).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Confirm red**

```bash
pnpm vitest run src/server/boss/handlers/note_verify.test.ts
```

`onVerified` is not part of the type yet.

- [ ] **Step 3: Add the callback**

In `src/server/boss/handlers/note_verify.ts`:

```ts
type DepsOverride = {
  runTaskFn?: RunTaskFn;
  onVerified?: (artifactId: string) => Promise<void>;
};
```

In `runNoteVerify`, after the artifact UPDATE writes `verification_status` and BEFORE the `writeEvent` call (or after — pick the location where you're certain the verdict is committed), add:

```ts
if (parsed.verdict === 'pass' && params.onVerified) {
  await params.onVerified(artifactId);
}
```

Plumb `onVerified` through `RunNoteVerifyParams` and from `buildNoteVerifyHandler` into each `runNoteVerify` call. Catch block must NOT call onVerified (the existing flow already throws, so just keep onVerified out of the catch path).

- [ ] **Step 4: Wire embedded_check_generate enqueue in handlers.ts**

In `src/server/boss/handlers.ts`, after the `buildNoteVerifyHandler` import add:

```ts
import { buildEmbeddedCheckGenerateHandler } from './handlers/embedded_check_generate';
```

Register the queue **before** the `note_verify` work() registration so the queue exists when note_verify tries to send:

```ts
// Product Track 1: EmbeddedCheckGenerateTask — chained behind note_verify so
// that only verified notes spend LLM tokens on inline self-test generation.
await boss.createQueue('embedded_check_generate');
await boss.work(
  'embedded_check_generate',
  { pollingIntervalSeconds: 2, batchSize: 1 },
  buildEmbeddedCheckGenerateHandler(db),
);
```

Then modify the existing `note_verify` work() block to pass an `onVerified` callback:

```ts
await boss.work(
  'note_verify',
  { pollingIntervalSeconds: 2, batchSize: 1 },
  buildNoteVerifyHandler(db, {
    onVerified: async (artifactId) => {
      await boss.send('embedded_check_generate', { artifact_id: artifactId });
    },
  }),
);
```

`note_generate.onReady` stays unchanged from its NoteVerify pass2 form (single callback enqueuing `note_verify`).

- [ ] **Step 5: Green**

```bash
pnpm vitest run src/server/boss/handlers/note_verify.test.ts
```

All 3 new cases pass; existing NoteVerify cases stay green. Commit.

---

## Task 5: API surface for embedded questions

**Files:**
- Modify: `app/api/learning-items/[id]/route.ts`
- Modify: `app/api/learning-items/[id]/route.test.ts`

The detail page already loads the primary artifact server-side and ships it to the client. We extend the response to include the embedded questions if `embedded_check_status='ready'`.

- [ ] **Step 1: Add failing API test**

In `app/api/learning-items/[id]/route.test.ts`, add:

```ts
it('returns embedded check questions when status is ready', async () => {
  // seed: learning_item + primary atomic artifact with embedded_check_status='ready'
  // + check section with embedded_check.question_ids = ['q1','q2']
  // + insert q1, q2 question rows source='embedded'

  const res = await GET(/* ... */);
  const json = await res.json();
  expect(json.primary_artifact.embedded_check_status).toBe('ready');
  expect(json.primary_artifact.embedded_questions).toHaveLength(2);
  expect(json.primary_artifact.embedded_questions[0]).toMatchObject({
    id: expect.any(String),
    kind: expect.any(String),
    prompt_md: expect.any(String),
    choices_md: expect.anything(),
  });
});

it('omits embedded questions when status is pending', async () => {
  // seed with embedded_check_status='pending'
  const res = await GET(/* ... */);
  const json = await res.json();
  expect(json.primary_artifact.embedded_check_status).toBe('pending');
  expect(json.primary_artifact.embedded_questions ?? []).toHaveLength(0);
});
```

- [ ] **Step 2: Confirm failure**

```bash
pnpm vitest run app/api/learning-items/\[id\]/route.test.ts
```

Red.

- [ ] **Step 3: Extend GET handler**

In `app/api/learning-items/[id]/route.ts`, after the primary artifact fetch block, add:

```ts
// Embedded check question payload (only when ready)
let embeddedQuestions: Array<{
  id: string;
  kind: string;
  prompt_md: string;
  choices_md: string[] | null;
}> = [];
if (primary?.embedded_check_status === 'ready') {
  const checkSection = ((primary.sections ?? []) as Array<{
    kind: string;
    embedded_check?: { question_ids: string[] } | null;
  }>).find((s) => s.kind === 'check');
  const ids = checkSection?.embedded_check?.question_ids ?? [];
  if (ids.length > 0) {
    const qRows = await db
      .select({
        id: question.id,
        kind: question.kind,
        prompt_md: question.prompt_md,
        choices_md: question.choices_md,
      })
      .from(question)
      .where(inArray(question.id, ids));
    embeddedQuestions = qRows;
  }
}

// In the response object, add:
primary_artifact: {
  ...primary,
  embedded_questions: embeddedQuestions,
},
```

Do NOT return `reference_md` to the client — answers shouldn't ship to the browser before submit. The attempt endpoint handles judging server-side.

- [ ] **Step 4: Green**

Commit.

---

## Task 6: `/api/embedded-check/attempt` endpoint

**Files:**
- Create: `app/api/embedded-check/attempt/route.ts`
- Create: `app/api/embedded-check/attempt/route.test.ts`

**Behavior contract**:
- POST `{ question_id, answer_md, latency_ms? }`
- Server loads the question row (must be `source='embedded'`, else 422)
- Calls existing judge router (`src/server/ai/judges/router.ts`) — exact / keyword judge by default, falls back to AI flexible if profile says so
- Writes `attempt` event (action='attempt', subject_kind='question', subject_id=question.id, outcome='success'|'failure', payload={ answer_md, judge_route, judge_score })
- If failure → call `createLearningRecord(db, { kind: 'mistake', question_id, attempt_event_id, ... })` (the canonical post-Phase-1c.1 path, since the `mistake` table was DROPped in Step 9.J per ADR-0006 v2) AND explicitly enqueue `attribution_followup` via `boss.send` (confirmed required — both `/api/mistakes` and `/api/ingestion/[id]/import` already do this).
- Response: `{ outcome, judge: { route, score, reason_md? }, mistake_id?: string }` where `mistake_id` is the `learning_record.id` (the post-Phase-1c.1 identifier for a mistake)
- Does NOT touch `material_fsrs_state` — embedded check stays out of FSRS
- Idempotency: user can attempt multiple times. Each attempt is a separate event row + a separate learning_record row (no de-dup). UI shows latest verdict per question; full history is queryable via events.

**No MistakeSource enum changes** — there is no `mistake` table to set a `source` column on. The provenance "this came from an embedded check" is encoded in the attempt event's `payload.source='embedded_check'` and in `learning_record.source` (use `'self'` or `'agent'` per the existing convention; `app/api/mistakes/route.ts:147` uses `'manual'` for user-driven mistake entry, so use that here too — user-driven attempt UI is the same provenance class). The richer provenance lives in `learning_record.payload.from='embedded_check'` if it needs to be queried later.

- [ ] **Step 1: Write the attempt route test**

`app/api/embedded-check/attempt/route.test.ts` covers:

1. Happy path correct: seed embedded question with reference_md='答案'; POST answer_md='答案' → response.outcome='success', writes `attempt` event with outcome='success'. NO `learning_record` row inserted (correct answers do not create mistake records).
2. Happy path wrong: same seed, POST answer_md='错' → response.outcome='failure', writes attempt event with outcome='failure'. ONE `learning_record (kind='mistake')` row inserted with `question_id`, `attempt_event_id` pointing at the new event, `payload.from='embedded_check'`. `attribution_followup` job enqueued (use spy via `getStartedBoss` mock; see how `app/api/mistakes/route.test.ts` does it).
3. 422 on non-embedded question: seed source='daily' → 422 `question_not_embedded`.
4. 404 on missing question.
5. 400 on missing answer_md or question_id.
6. Auth: missing `x-internal-token` → 401 (middleware behavior; sanity assert).
7. Idempotency: second attempt at same question writes a second event row AND a second `learning_record` row. Latest verdict wins from the UI's perspective; no DB de-dup.
8. **FSRS untouched**: after a successful or failed attempt, `material_fsrs_state` count for the question_id is unchanged from baseline (asserts the design invariant).

- [ ] **Step 2: Confirm red**

```bash
pnpm vitest run app/api/embedded-check/attempt/route.test.ts
```

- [ ] **Step 3: Implement**

```ts
// app/api/embedded-check/attempt/route.ts
import { z } from 'zod';
import { eq } from 'drizzle-orm';

import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';
import { routeJudge } from '@/server/ai/judges/router';
import { getStartedBoss } from '@/server/boss/client';
import { createLearningRecord } from '@/server/records/queries';
import { resolveSubjectProfileForKnowledgeIds } from '@/server/knowledge/subject-profile';

export const runtime = 'nodejs';

const Body = z.object({
  question_id: z.string().min(1),
  answer_md: z.string().min(1).max(2000),
  latency_ms: z.number().int().min(0).max(3_600_000).nullable().optional(),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => i.message).join('; '),
        400,
      );
    }
    const body = parsed.data;

    const qRows = await db
      .select()
      .from(question)
      .where(eq(question.id, body.question_id))
      .limit(1);
    const q = qRows[0];
    if (!q) throw new ApiError('not_found', `question ${body.question_id} not found`, 404);
    if (q.source !== 'embedded') {
      throw new ApiError(
        'question_not_embedded',
        'this endpoint only accepts embedded check questions',
        422,
      );
    }

    const subjectProfile = await resolveSubjectProfileForKnowledgeIds(db, q.knowledge_ids);
    const judgeResult = await routeJudge({
      questionKind: q.kind,
      reference_md: q.reference_md,
      answer_md: body.answer_md,
      subjectProfile,
    });

    const outcome: 'success' | 'failure' =
      judgeResult.coarseOutcome === 'correct' ? 'success' : 'failure';
    const now = new Date();
    const attemptEventId = newId();
    let recordId: string | undefined;

    await db.transaction(async (tx) => {
      await writeEvent(tx, {
        id: attemptEventId,
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'embedded_check_attempt',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: q.id,
        outcome,
        payload: {
          source: 'embedded_check',
          answer_md: body.answer_md,
          latency_ms: body.latency_ms ?? null,
          judge: judgeResult,
        },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: now,
      });

      if (outcome === 'failure') {
        recordId = newId();
        await createLearningRecord(tx, {
          id: recordId,
          kind: 'mistake',
          title: null,
          content_md: body.answer_md,
          source: 'manual', // user-driven attempt; same provenance class as /api/mistakes POST
          capture_mode: 'text',
          activity_kind: 'attempt',
          processing_status: 'raw',
          origin_event_id: attemptEventId,
          knowledge_ids: q.knowledge_ids,
          question_id: q.id,
          attempt_event_id: attemptEventId,
          asset_refs: [],
          payload: {
            from: 'embedded_check',
            wrong_answer_md: body.answer_md,
            judge: judgeResult,
          },
        });
      }
    });

    // Enqueue attribution after the txn commits — mirrors /api/mistakes/route.ts:213.
    // VITEST guard prevents tests from accumulating pg-boss state.
    if (outcome === 'failure' && !process.env.VITEST) {
      try {
        const boss = await getStartedBoss();
        await boss.send('attribution_followup', { attempt_event_id: attemptEventId });
      } catch (err) {
        console.warn(`attribution_followup enqueue failed for ${attemptEventId}:`, err);
      }
    }

    return Response.json({
      outcome,
      judge: judgeResult,
      mistake_id: recordId,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
```

**Cross-check before implementing**:
- `resolveSubjectProfileForKnowledgeIds` already exists in `src/server/knowledge/subject-profile.ts` (imported by `app/api/mistakes/route.ts`). Verify its signature and adapt the call accordingly.
- `routeJudge` signature in `src/server/ai/judges/router.ts` may differ from the sketch above — adapt to actual signature; do not invent a wrapper.
- `createLearningRecord` accepts a `Tx | Db`; running inside `db.transaction` is supported (`/api/mistakes/route.ts:141` calls it from inside `tx`). Confirm by reading `CreateLearningRecordInput` type in `src/server/records/types.ts`.

- [ ] **Step 4: Green**

```bash
pnpm vitest run app/api/embedded-check/attempt/route.test.ts
```

Commit.

---

## Task 7: UI — extract ArtifactSections + EmbeddedCheckSection

**Files:**
- Create: `src/ui/components/ArtifactSections.tsx`
- Create: `src/ui/components/EmbeddedCheckSection.tsx`
- Modify: `app/(app)/learning-items/[id]/page.tsx`
- Modify: `app/globals.css`

**Refactor seam**: the current `learning-items/[id]/page.tsx` renders `artifact.sections.map(...)` inline (lines ~431–453). Move this into `ArtifactSections.tsx` so future Slice 3 (note editing) + Slice 5 (rollback UI) can drop into a child component without touching the page-level layout.

- [ ] **Step 1: Extract ArtifactSections without behavior change**

Move the section-list JSX into `src/ui/components/ArtifactSections.tsx`:

```tsx
interface Props {
  sections: Section[];
  subjectProfile: SlimSubjectProfile;
  embeddedQuestions: EmbeddedQuestion[];
  embeddedCheckStatus: ArtifactEmbeddedCheckStatusT;
  artifactId: string;
}

export function ArtifactSections({
  sections,
  subjectProfile,
  embeddedQuestions,
  embeddedCheckStatus,
  artifactId,
}: Props) {
  return (
    <div className="artifact-sections">
      {sections.map((s) => (
        <div key={s.id} className="artifact-section">
          <div className="artifact-section-head">
            <strong>{SECTION_LABEL[s.kind]}</strong>
            <span className="artifact-section-tier">{SOURCE_TIER_LABEL[s.source_tier]}</span>
          </div>
          <pre {...subjectContentProps(subjectProfile, { className: 'artifact-section-body' })}>
            {s.body_md}
          </pre>
          {s.kind === 'check' && (
            <EmbeddedCheckSection
              status={embeddedCheckStatus}
              questions={embeddedQuestions}
              artifactId={artifactId}
              subjectProfile={subjectProfile}
            />
          )}
        </div>
      ))}
    </div>
  );
}
```

In `page.tsx`, replace the inline block with `<ArtifactSections ... />`. Verify that the page renders identically to before for an artifact that has no embedded questions yet (i.e., still shows placeholder).

- [ ] **Step 2: Implement EmbeddedCheckSection**

`src/ui/components/EmbeddedCheckSection.tsx` renders three states:

- `embeddedCheckStatus === 'pending'`: show "自检题生成中…" with a subtle indicator. No question UI.
- `embeddedCheckStatus === 'failed'`: show "自检题暂未生成（生成失败）". No retry button in MVP.
- `embeddedCheckStatus === 'ready'`: render the `questions` list. For each question:
  - Show `prompt_md`
  - If `kind === 'choice'`: render `choices_md` as radio buttons
  - If `kind === 'fill_blank'` / `'short_answer'` / etc.: render a `<textarea>` (or `<input>` for fill_blank)
  - "提交" button → POST to `/api/embedded-check/attempt` with `{ question_id, answer_md }`
  - On response, show `outcome` badge + judge `reason_md` if any; disable submit (allow re-answer if user clicks "再答一次")
- `embeddedCheckStatus === 'not_required'`: render nothing (the section probably shouldn't even render for non-atomic artifacts; check the kind upstream).

Keep client-side state minimal: `const [answers, setAnswers] = useState<Record<string, string>>({})` + `const [feedback, setFeedback] = useState<Record<string, AttemptResult>>({})`. No global store changes.

- [ ] **Step 3: CSS**

In `app/globals.css`, after the `.artifact-verification` block, add:

```css
.embedded-check-section {
  margin-top: var(--s-4);
  padding-top: var(--s-3);
  border-top: 1px solid var(--line);
}
.embedded-check-question {
  border: 1px solid var(--line);
  border-radius: var(--r-2);
  padding: var(--s-3);
  margin-top: var(--s-2);
  background: var(--paper-sunk);
}
.embedded-check-question__prompt { margin: 0 0 var(--s-2); }
.embedded-check-question__choices { display: grid; gap: var(--s-2); margin: var(--s-2) 0; }
.embedded-check-question__submit { margin-top: var(--s-2); }
.embedded-check-feedback { margin-top: var(--s-2); font-family: var(--font-mono); font-size: var(--fs-meta); }
.embedded-check-feedback.outcome-success { color: var(--good-ink); }
.embedded-check-feedback.outcome-failure { color: var(--again-ink); }
.embedded-check-status {
  font-family: var(--font-mono);
  font-size: var(--fs-meta);
  padding: var(--s-1) var(--s-2);
  border-radius: var(--r-1);
}
.embedded-check-status.pending { color: var(--info-ink); background: var(--info-soft); }
.embedded-check-status.failed { color: var(--again-ink); background: var(--again-soft); }
```

Reuse the existing `--again-*` / `--good-*` / `--info-*` tokens (already used by NoteVerify badges in `.artifact-status.verify-*`).

- [ ] **Step 4: Verify in browser**

```bash
pnpm dev:local
```

In another shell, follow the validation path in the "Validation" section below.

Commit.

---

## Task 8: Docs + status updates + one drift fix

**Files:**
- Modify: `docs/superpowers/status.md`
- Modify: `docs/modules/lanes.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: status.md updates**

In `docs/superpowers/status.md` §"Product Track 1", flip the line:

```
⬜  Embedded check（atomic notes）  inline 选择题 / fill-blank
```

to:

```
✅  Embedded check（atomic notes）  inline 选择题 / fill-blank — embedded_check_generate handler + /api/embedded-check/attempt + UI
```

Bump "最后更新" date. Add a single line about the new pg-boss queue in §6 if you renumbered the queue list.

- [ ] **Step 2: lanes.md updates**

In `docs/modules/lanes.md`, add a row for `embedded_check_generate` mirroring the `note_verify` row format. Reference the task kind, trigger (after `note_generate.onReady`), output (1-3 question rows + status update).

- [ ] **Step 3: CLAUDE.md drift fix**

In `CLAUDE.md` §"Stack note (README is stale)", the line that currently reads:

```
- **AI SDK v6** (`ai` package) + `@ai-sdk/anthropic` — SDK only; runtime is self-hosted Node, not Vercel Functions
```

Replace with the actual stack (per audit 2026-05-19 finding + ADR-0004 2026-05-17 update):

```
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) via xiaomi/mimo Anthropic-compatible endpoint; runtime is self-hosted Node, not Vercel Functions
```

This closes one contradicted audit finding without scope creep.

Commit.

---

## Validation

After all 8 tasks complete, run from project root:

```bash
pnpm typecheck
pnpm lint
pnpm vitest run \
  src/core/schema/schema.test.ts \
  src/ai/task-prompts.test.ts \
  src/server/boss/handlers/embedded_check_generate.test.ts \
  src/server/boss/handlers/note_generate.test.ts \
  src/server/boss/handlers/note_verify.test.ts \
  'app/api/learning-items/[id]/route.test.ts' \
  'app/api/embedded-check/attempt/route.test.ts'
pnpm audit:schema
pnpm build
```

All must pass.

**Manual end-to-end on local NAS-equivalent compose**:

```bash
pnpm dev:local
```

In a fresh DB:
1. Visit `/knowledge`, manually create a small wenyan topic (or use seed).
2. Visit `/learning-items`, type "我想学 [topic]" → accept proposal.
3. Wait ~30–60s for `note_generate` + `embedded_check_generate` to complete (logs in dev console).
4. Open the atomic learning-item detail page. Check section should render real questions, not the placeholder.
5. Answer one question correctly → outcome=success badge appears, no mistake row created.
6. Answer another wrong → outcome=failure badge, visit `/mistakes`. New mistake row with `source='embedded_check'`.
7. From `/mistakes` click into the mistake → it should be a normal question detail, with attribution_followup running in the background.
8. Visit `/events/[attempt_event_id]` (id from step 6 server log) → verify event chain: attempt (failure) → judge → potentially variant_gen if cause matches.
9. Math pressure: change the topic's knowledge.domain to `math` (or use math seed), repeat 2–8. Verify questions render with `fill_blank` / `computation` kinds rather than `choice`.

**Acceptance criteria**:

- `pnpm audit:schema` green; `embedded_check_status` column has a documented write path (the runner) and is not in the allowlist.
- Status.md `Embedded check` line is ✅.
- `/events/[id]` shows `experimental:embedded_check_generate` event for at least one artifact.
- Both wenyan and math profile atomic notes generate kind-appropriate questions.
- No FSRS state row is created when an embedded check question is answered (verify by querying `material_fsrs_state` count before/after).
- Failure attempt creates one `mistake` row with `source='embedded_check'`.
- NoteVerify still works — `verification_status` lifecycle is independent of `embedded_check_status` (test by seeding an artifact with `verification_status='verified'` and `embedded_check_status='pending'`).

---

## Risks / Unknowns

1. ~~**`attribution_followup` enqueue point**~~ **Resolved**: explicit `boss.send('attribution_followup', { attempt_event_id })` is required. Two existing callers: `app/api/mistakes/route.ts:213` and `app/api/ingestion/[id]/import/route.ts:476`. Task 6 follows the same pattern.
2. ~~**`question.choices_md` column may not exist**~~ **Resolved**: column does NOT exist today. Task 1 adds it in the same migration (nullable jsonb of `string[]`).
3. **Judge router shape** — `routeJudge` signature in `src/server/ai/judges/router.ts` may differ from the Task 6 sketch. Adapt to the actual signature; do not invent a wrapper.
4. **pg-boss double-delivery** — handler must handle re-enqueue gracefully. The `skipped:already_ready` early return in Task 3 handles this; verify by running the runner twice in a test.
5. ~~**Cost surge**~~ **Resolved by chain redesign**: per user direction, `embedded_check_generate` is enqueued by `note_verify.onVerified` (only fires on `verdict='pass'`). Notes that hit `needs_review` or `failed` skip embedded check entirely. Net per atomic: 2 LLM calls (generate + verify) for non-passing notes, 3 LLM calls (generate + verify + embedded check) for passing notes. For a 5-atomic hub where 4 pass: 14 calls (vs the naive 15 in parallel enqueueing — small absolute savings but the structural win is "every embedded check token spent buys a question for a note we already trust").
6. **Same `page.tsx` simultaneously modified by other slices** — Slice 3 (note edit) and Slice 5 (rollback) will also edit this file. Slice 1 must land first or those slices must rebase. The phase plan already orders these correctly.
7. **Schema audit allowlist hygiene** — if anyone uses the allowlist escape hatch in Task 1, make sure they remove it. The allowlist is for legit deferred work; a permanent entry would mask the actual write path.
8. **`mistake` table is GONE** (Phase 1c.1 Step 9.J / ADR-0006 v2) — any code that imports `mistake` from `@/db/schema` will fail to compile. Use `learning_record (kind='mistake')` via `createLearningRecord` from `src/server/records/queries.ts`. Task 6 was rewritten to reflect this; double-check the executor doesn't reintroduce a `mistake` import out of habit.

---

## Out of scope (explicit)

- EmbeddedCheckVerifyTask (verify the generated questions themselves) — Phase 3 follow-up.
- Editing or regenerating embedded questions — Slice 3 (note editing) can extend.
- Showing embedded check question history / per-question retake graph.
- Notification when a long-running `embedded_check_generate` finishes — UI does not poll; user manually refreshes (acceptable for single-user tool).
- Pulling embedded check questions into `/review` daily queue (kept out of FSRS by design).
- VariantVerify — Slice 2.
- Teaching session idle — Slice 4.
- Rollback / retraction UI — Slice 5.

---

## Reading order for the executing agent

1. `docs/superpowers/plans/2026-05-19-note-verify-pass2.md` — the analogous Pass 2 plan that just shipped. Same structure; the writer copied many idioms.
2. `src/server/boss/handlers/note_verify.ts` — verifier handler model.
3. `src/server/boss/handlers/variant_gen.ts` — question table insert pattern.
4. `src/server/boss/handlers/attribution_followup.ts` — failure attempt → cause flow (confirm enqueue point per Risk #1).
5. `src/ai/task-prompts.ts` — existing profile-aware prompt builders.
6. `app/api/review/submit/route.ts` — attempt flow that this slice deliberately bypasses (to understand what we're skipping and why).
