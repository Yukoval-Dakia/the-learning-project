# Note Verify Pass 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second-pass verifier for generated atomic notes so AI-written study notes are visibly verified, flagged for review, or failed before the product treats them as trustworthy.

**Architecture:** Keep generation and verification as separate lifecycle axes on `artifact`: `generation_status` answers whether note content exists, while `verification_status` answers whether that content passed a second AI check. `note_generate` remains the only content writer; the new `note_verify` queue writes verification metadata and an `experimental:note_verify` event, never mutating or deleting generated sections.

**Tech Stack:** Next.js App Router, Drizzle/Postgres, pg-boss, Zod schemas, existing AI task registry/runner, Vitest.

---

## Preconditions

- PR #65 is already merged into `main`; execute from a fresh branch based on `origin/main`.
- PR #66 (`Foundation B evidence contract bridge`) is a separate Foundation B branch. This NoteVerify slice must not depend on #66 until #66 is merged; do not import the new profile-scoped cause bridge or touch attribution/review/variant code in this PR.
- This slice does not require `CorrectEvent` writes. It records `experimental:note_verify` events and leaves user retraction/rollback for the later proposal-inbox/rollback slice.
- Do not broaden into embedded quiz generation, note editing, proposal inbox, or correction UI. This phase only verifies existing generated sections and exposes the result.
- Execution worktree for this run: `/private/tmp/the-learning-project-note-verify` on branch `codex/note-verify-pass2`, tracking `origin/main`.

## File Structure

- Modify `src/core/schema/business.ts` — add artifact lifecycle and note verification result schemas.
- Modify `src/core/schema/index.ts` — align `Artifact` zod status enums with DB/runtime values.
- Modify `src/db/schema.ts` — add verification columns to `artifact`.
- Generate one Drizzle migration under `drizzle/` — add the verification columns to Postgres.
- Modify `src/ai/registry.ts` — register `NoteVerifyTask`.
- Modify `src/ai/task-prompts.ts` — add profile-aware `NoteVerifyTask` system prompt.
- Modify `src/ai/task-prompts.test.ts` — assert the verifier prompt uses `SubjectProfile`.
- Create `src/server/boss/handlers/note_verify.ts` — pure runner + pg-boss handler.
- Create `src/server/boss/handlers/note_verify.test.ts` — verifier lifecycle tests.
- Modify `src/server/boss/handlers/note_generate.ts` — mark generated notes as `verification_status='queued'` and call an injectable `onReady` hook.
- Modify `src/server/boss/handlers/note_generate.test.ts` — assert queued status + enqueue hook behavior.
- Modify `src/server/boss/handlers.ts` — create/work `note_verify`; wire `note_generate` ready hook to enqueue verifier jobs.
- Modify `app/api/learning-items/[id]/route.ts` — include verification fields in `primary_artifact`.
- Modify `app/api/learning-items/[id]/route.test.ts` — cover artifact verification fields in API response.
- Modify `app/(app)/learning-items/[id]/page.tsx` — render verification badges/issues.
- Modify `app/globals.css` — styles for verification status/issues.
- Modify `docs/modules/lanes.md` and `docs/superpowers/status.md` — record the shipped lane after implementation.

---

### Task 1: Artifact Verification Schema

**Files:**
- Modify: `src/core/schema/business.ts`
- Modify: `src/core/schema/index.ts`
- Modify: `src/db/schema.ts`
- Generate: `drizzle/*.sql`
- Test: `src/core/schema/schema.test.ts`

- [ ] **Step 1: Add failing schema tests**

Append these assertions to the existing `Artifact` coverage in `src/core/schema/schema.test.ts`. If there is no artifact-specific `describe`, create `describe('Artifact schema', ...)` near the current artifact fixture tests.

```ts
import { Artifact, NoteVerificationResult } from '@/core/schema';

it('Artifact accepts runtime generation + verification statuses', () => {
  const now = new Date();
  const result = Artifact.safeParse({
    id: 'a1',
    type: 'note_atomic',
    title: '之的用法',
    knowledge_id: null,
    parent_artifact_id: null,
    child_artifact_ids: [],
    intent_source: 'learning_intent',
    source: 'ai_generated',
    source_ref: null,
    outline_json: null,
    sections: null,
    tool_kind: null,
    tool_state: null,
    generation_status: 'ready',
    verification_status: 'verified',
    verification_summary: {
      verdict: 'pass',
      summary_md: '结构完整，未发现明显问题。',
      issues: [],
      confidence: 0.82,
    },
    generated_by: null,
    verified_by: { by: 'ai', task_kind: 'NoteVerifyTask' },
    history: [],
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });

  expect(result.success).toBe(true);
});

it('NoteVerificationResult rejects invalid confidence', () => {
  const result = NoteVerificationResult.safeParse({
    verdict: 'pass',
    summary_md: 'ok',
    issues: [],
    confidence: 2,
  });

  expect(result.success).toBe(false);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm vitest run src/core/schema/schema.test.ts
```

Expected: failure because `NoteVerificationResult` is not exported and `Artifact` does not know `verification_status`, `verification_summary`, or `verified_by`.

- [ ] **Step 3: Add lifecycle schemas**

In `src/core/schema/business.ts`, add these exports near `NoteSection` and `AgentRef`:

```ts
export const ArtifactGenerationStatus = z.enum(['pending', 'ready', 'failed']);
export type ArtifactGenerationStatusT = z.infer<typeof ArtifactGenerationStatus>;

export const ArtifactVerificationStatus = z.enum([
  'not_required',
  'not_started',
  'queued',
  'verified',
  'needs_review',
  'failed',
]);
export type ArtifactVerificationStatusT = z.infer<typeof ArtifactVerificationStatus>;

export const NoteVerificationIssue = z.object({
  section_id: z.string().nullable(),
  severity: z.enum(['info', 'warn', 'error']),
  category: z.enum(['factuality', 'coverage', 'clarity', 'subject_fit', 'format', 'safety']),
  message: z.string().min(1),
  suggested_fix_md: z.string().min(1).optional(),
});
export type NoteVerificationIssueT = z.infer<typeof NoteVerificationIssue>;

export const NoteVerificationResult = z.object({
  verdict: z.enum(['pass', 'needs_review']),
  summary_md: z.string().min(1).max(1000),
  issues: z.array(NoteVerificationIssue).max(10),
  confidence: z.number().min(0).max(1),
});
export type NoteVerificationResultT = z.infer<typeof NoteVerificationResult>;
```

- [ ] **Step 4: Add DB columns**

In `src/db/schema.ts`, extend `artifact`:

```ts
  verification_status: text('verification_status').notNull().default('not_required'),
  verification_summary: jsonb('verification_summary').$type<NoteVerificationResultT>(),
  verified_by: jsonb('verified_by').$type<AgentRefT>(),
```

Add `NoteVerificationResultT` to the existing import from `@/core/schema/business` at the top of the file.

- [ ] **Step 5: Align runtime Artifact schema**

In `src/core/schema/index.ts`, update the `Artifact` extension:

```ts
export const Artifact = g.ArtifactSelectGenerated.extend({
  type: b.ArtifactType,
  intent_source: z.enum(['learning_intent', 'declared', 'from_mistake', 'from_dream']),
  sections: z.array(b.NoteSection).nullable(),
  tool_state: b.ToolState.nullable(),
  tool_kind: z.enum(['quiz']).nullable(),
  generation_status: b.ArtifactGenerationStatus,
  verification_status: b.ArtifactVerificationStatus,
  verification_summary: b.NoteVerificationResult.nullable(),
  verified_by: b.AgentRef.nullable(),
});
export type NoteVerificationResult = z.infer<typeof b.NoteVerificationResult>;
export { NoteVerificationResult };
```

Important: include `learning_intent` in `intent_source`; current inserted artifacts already use that value.

- [ ] **Step 6: Generate and inspect migration**

Run:

```bash
pnpm db:generate
```

Expected: a new SQL file under `drizzle/` and journal metadata changes. Inspect the generated SQL and confirm it contains these operations:

```sql
ALTER TABLE "artifact" ADD COLUMN "verification_status" text DEFAULT 'not_required' NOT NULL;
ALTER TABLE "artifact" ADD COLUMN "verification_summary" jsonb;
ALTER TABLE "artifact" ADD COLUMN "verified_by" jsonb;
```

- [ ] **Step 7: Verify schema tests**

Run:

```bash
pnpm vitest run src/core/schema/schema.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add src/core/schema/business.ts src/core/schema/index.ts src/core/schema/schema.test.ts src/db/schema.ts drizzle
git commit -m "feat(artifacts): add note verification lifecycle"
```

---

### Task 2: Profile-Aware NoteVerifyTask

**Files:**
- Modify: `src/ai/registry.ts`
- Modify: `src/ai/task-prompts.ts`
- Modify: `src/ai/task-prompts.test.ts`

- [ ] **Step 1: Add failing prompt tests**

In `src/ai/task-prompts.test.ts`, add:

```ts
it('builds NoteVerifyTask prompt from the subject profile', () => {
  const prompt = getTaskSystemPrompt('NoteVerifyTask', mathProfile);

  expect(prompt).toContain('数学');
  expect(prompt).toContain('NoteVerificationResult');
  expect(prompt).toContain('factuality');
  expect(prompt).not.toContain('文言文经典原文');
});
```

Use the existing math profile fixture/import in the file. If the test file uses a local `profile` object rather than `mathProfile`, follow that local pattern but keep the assertions above.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm vitest run src/ai/task-prompts.test.ts
```

Expected: TypeScript/test failure because `NoteVerifyTask` is not a registered task kind.

- [ ] **Step 3: Register NoteVerifyTask**

In `src/ai/registry.ts`, add this task next to `NoteGenerateTask`:

```ts
  NoteVerifyTask: {
    kind: 'NoteVerifyTask',
    description:
      'Phase 3 Track A — second-pass verification for generated atomic note sections',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    fallbackChain: [{ provider: 'xiaomi', model: 'mimo-v2.5' }],
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    systemPrompt:
      '你是学习笔记质检员。检查 generated note sections 是否准确、完整、清晰、适合当前科目。严格输出 NoteVerificationResult JSON。',
  },
```

- [ ] **Step 4: Add profile-aware prompt builder**

In `src/ai/task-prompts.ts`, add:

```ts
function buildNoteVerifyPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}学习笔记质检员。输入 { artifact_id, title, knowledge_node, sections }，其中 sections 是 NoteGenerateTask 产出的 atomic note sections。
输出严格 JSON（不带 markdown 代码块包裹），shape 名称为 NoteVerificationResult：
{"verdict":"pass"|"needs_review","summary_md":"...","issues":[{"section_id":"s1"|null,"severity":"info"|"warn"|"error","category":"factuality"|"coverage"|"clarity"|"subject_fit"|"format"|"safety","message":"...","suggested_fix_md":"..."}],"confidence":0.0-1.0}
检查标准：
- factuality：内容是否自洽，是否明显编造；${profile.grounding.uncertaintyPolicy}
- coverage：definition/mechanism/example/pitfall/check 是否覆盖 atomic intent
- clarity：学习者是否能按 section 读懂，不要空泛套话
- subject_fit：是否符合 ${profile.displayName} 的表达、例子和检查题风格
- format：section_id 必须引用输入 section id；找不到具体 section 时用 null
判定：
- 没有 error 且 warn 不超过 2 条：verdict="pass"
- 任一 error，或 warn 超过 2 条，或 confidence < 0.6：verdict="needs_review"
- issues 最多 10 条；message 必须可执行；suggested_fix_md 只在有明确改法时填写
禁止：重写整篇 note、输出 markdown 代码块、输出 JSON 之外的文字。`;
}
```

Then update `getTaskSystemPrompt`:

```ts
    case 'NoteVerifyTask':
      return buildNoteVerifyPrompt(profile);
```

- [ ] **Step 5: Verify prompt tests**

Run:

```bash
pnpm vitest run src/ai/task-prompts.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/ai/registry.ts src/ai/task-prompts.ts src/ai/task-prompts.test.ts
git commit -m "feat(ai): add profile-aware note verification task"
```

---

### Task 3: note_verify Queue Handler

**Files:**
- Create: `src/server/boss/handlers/note_verify.ts`
- Create: `src/server/boss/handlers/note_verify.test.ts`

- [ ] **Step 1: Write failing handler tests**

Create `src/server/boss/handlers/note_verify.test.ts` with tests for:

```ts
it('returns skipped:not_found when artifact does not exist', async () => {});
it('returns skipped:not_ready when generation_status is not ready', async () => {});
it('returns skipped:no_sections when ready artifact has no sections', async () => {});
it('marks verification_status=verified and writes experimental note_verify event on pass', async () => {});
it('marks verification_status=needs_review and persists issues when verifier flags problems', async () => {});
it('passes subject profile from knowledge.domain to NoteVerifyTask', async () => {});
it('marks verification_status=failed when verifier output is invalid and rethrows', async () => {});
```

Use the seed pattern from `src/server/boss/handlers/note_generate.test.ts`: insert `knowledge`, insert `artifact`, use `resetDb()`/`testDb()`, and mock `runTaskFn`.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm vitest run src/server/boss/handlers/note_verify.test.ts
```

Expected: failure because `note_verify.ts` does not exist.

- [ ] **Step 3: Implement parser and runner**

Create `src/server/boss/handlers/note_verify.ts` with these exported types/functions:

```ts
export interface NoteVerifyJobData {
  artifact_id: string;
}

export type RunTaskFn = (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;

export interface RunNoteVerifyParams {
  db: Db;
  artifactId: string;
  runTaskFn: RunTaskFn;
}

export interface RunNoteVerifyResult {
  status:
    | 'verified'
    | 'needs_review'
    | 'skipped:not_found'
    | 'skipped:not_ready'
    | 'skipped:no_sections';
  issues_count?: number;
}
```

Implementation requirements:

```ts
const VerificationOutputSchema = NoteVerificationResult;

function parseVerificationOutput(text: string): NoteVerificationResultT {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseVerificationOutput: no JSON object found in text');
  }
  const parsed = VerificationOutputSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
  if (!parsed.success) {
    throw new Error(
      `parseVerificationOutput: schema invalid: ${parsed.error.issues
        .map((i) => i.message)
        .join('; ')}`,
    );
  }
  return parsed.data;
}
```

`runNoteVerify` must:

1. Load `artifact` by id.
2. Skip missing rows.
3. Skip rows where `generation_status !== 'ready'`.
4. Skip rows with no sections.
5. Load `knowledge` when `artifact.knowledge_id` exists.
6. Call `runTaskFn('NoteVerifyTask', input, { db, subjectProfile })`.
7. Parse `NoteVerificationResult`.
8. Update `artifact.verification_status` to `verified` for `verdict='pass'`, else `needs_review`.
9. Persist `verification_summary`, `verified_by={ by:'ai', task_kind:'NoteVerifyTask' }`, and `updated_at`.
10. Write one event via `writeEvent`:

```ts
await writeEvent(db, {
  id: createId(),
  session_id: null,
  actor_kind: 'agent',
  actor_ref: 'note_verify',
  action: 'experimental:note_verify',
  subject_kind: 'artifact',
  subject_id: artifactId,
  outcome: parsed.verdict === 'pass' ? 'success' : 'partial',
  payload: parsed,
  caused_by_event_id: null,
  task_run_id: null,
  cost_micro_usd: null,
  created_at: new Date(),
});
```

On parser/task failure, set `verification_status='failed'`, update `updated_at`, and rethrow so pg-boss retry policy remains visible.

- [ ] **Step 4: Implement pg-boss handler**

Add:

```ts
export function buildNoteVerifyHandler(
  db: Db,
  deps: { runTaskFn?: RunTaskFn } = {},
): (jobs: Job<NoteVerifyJobData>[]) => Promise<void> {
  const runTaskFn = deps.runTaskFn ?? defaultRunTaskFn;
  return async (jobs) => {
    for (const job of jobs) {
      const artifactId = job.data?.artifact_id;
      if (!artifactId) {
        console.warn('[note_verify] job missing artifact_id', job.id);
        continue;
      }
      const result = await runNoteVerify({ db, artifactId, runTaskFn });
      console.log(`[note_verify] ${artifactId} -> ${result.status}`);
    }
  };
}
```

- [ ] **Step 5: Verify handler tests**

Run:

```bash
pnpm vitest run src/server/boss/handlers/note_verify.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/boss/handlers/note_verify.ts src/server/boss/handlers/note_verify.test.ts
git commit -m "feat(boss): add note verification handler"
```

---

### Task 4: Queue Wiring From note_generate

**Files:**
- Modify: `src/server/boss/handlers/note_generate.ts`
- Modify: `src/server/boss/handlers/note_generate.test.ts`
- Modify: `src/server/boss/handlers.ts`

- [ ] **Step 1: Add failing note_generate tests**

Add two tests to `src/server/boss/handlers/note_generate.test.ts`:

```ts
it('marks generated atomic notes verification_status=queued', async () => {
  await seedAtomic({ artifactId: 'a1', knowledgeId: 'k1' });
  const runTaskFn = vi.fn(async () => ({ text: VALID_SECTIONS }));

  await runNoteGenerate({ db: testDb(), artifactId: 'a1', runTaskFn });

  const [updated] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
  expect(updated.generation_status).toBe('ready');
  expect(updated.verification_status).toBe('queued');
});

it('buildNoteGenerateHandler enqueues note_verify after ready generation', async () => {
  await seedAtomic({ artifactId: 'a1', knowledgeId: 'k1' });
  const runTaskFn = vi.fn(async () => ({ text: VALID_SECTIONS }));
  const onReady = vi.fn(async (_artifactId: string) => {});
  const handler = buildNoteGenerateHandler(testDb(), { runTaskFn, onReady });

  await handler([{ id: 'job1', data: { artifact_id: 'a1' } } as never]);

  expect(onReady).toHaveBeenCalledWith('a1');
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm vitest run src/server/boss/handlers/note_generate.test.ts
```

Expected: failure because `verification_status` is not set and `onReady` is not a supported dependency.

- [ ] **Step 3: Update note_generate**

In `src/server/boss/handlers/note_generate.ts`, update `DepsOverride`:

```ts
type DepsOverride = {
  runTaskFn?: RunTaskFn;
  onReady?: (artifactId: string) => Promise<void>;
};
```

When generation succeeds, set:

```ts
verification_status: 'queued',
```

In `buildNoteGenerateHandler`, after `runNoteGenerate` returns:

```ts
if (result.status === 'ready') {
  await deps.onReady?.(artifactId);
}
```

- [ ] **Step 4: Wire queue registration**

In `src/server/boss/handlers.ts`, import `buildNoteVerifyHandler`, then register before `note_generate` can enqueue:

```ts
await boss.createQueue('note_verify');
await boss.work(
  'note_verify',
  { pollingIntervalSeconds: 2, batchSize: 1 },
  buildNoteVerifyHandler(db),
);
```

Change `buildNoteGenerateHandler(db)` to:

```ts
buildNoteGenerateHandler(db, {
  onReady: async (artifactId) => {
    await boss.send('note_verify', { artifact_id: artifactId });
  },
})
```

- [ ] **Step 5: Verify queue tests**

Run:

```bash
pnpm vitest run src/server/boss/handlers/note_generate.test.ts src/server/boss/handlers/note_verify.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/boss/handlers.ts src/server/boss/handlers/note_generate.ts src/server/boss/handlers/note_generate.test.ts
git commit -m "feat(boss): queue note verification after generation"
```

---

### Task 5: API And UI Visibility

**Files:**
- Modify: `app/api/learning-items/[id]/route.ts`
- Modify: `app/api/learning-items/[id]/route.test.ts`
- Modify: `app/(app)/learning-items/[id]/page.tsx`
- Modify: `app/globals.css`

- [ ] **Step 1: Add failing API response test**

In `app/api/learning-items/[id]/route.test.ts`, add a GET test that inserts an artifact with verification fields:

```ts
it('returns primary artifact verification fields', async () => {
  const db = testDb();
  const now = new Date();
  await db.insert(learning_item).values(
    baseItem('li1', {
      primary_artifact_id: 'a1',
    }),
  );
  await db.insert(artifact).values({
    id: 'a1',
    type: 'note_atomic',
    title: '之的用法',
    knowledge_id: null,
    parent_artifact_id: null,
    child_artifact_ids: [],
    intent_source: 'learning_intent',
    source: 'ai_generated',
    source_ref: null,
    outline_json: null,
    sections: [],
    tool_kind: null,
    tool_state: null,
    generation_status: 'ready',
    verification_status: 'needs_review',
    verification_summary: {
      verdict: 'needs_review',
      summary_md: '例句可能不可靠。',
      issues: [
        {
          section_id: 's3',
          severity: 'error',
          category: 'factuality',
          message: '例句来源不清。',
        },
      ],
      confidence: 0.51,
    } as never,
    generated_by: null,
    verified_by: { by: 'ai', task_kind: 'NoteVerifyTask' } as never,
    history: [],
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });

  const res = await GET(getReq('li1'), { params: Promise.resolve({ id: 'li1' }) });
  const body = (await res.json()) as {
    primary_artifact: {
      verification_status: string;
      verification_summary: { verdict: string; issues: unknown[] };
    };
  };

  expect(body.primary_artifact.verification_status).toBe('needs_review');
  expect(body.primary_artifact.verification_summary.verdict).toBe('needs_review');
  expect(body.primary_artifact.verification_summary.issues).toHaveLength(1);
});
```

Add `artifact` to the test file import from `@/db/schema`.

- [ ] **Step 2: Run API test and verify failure**

Run:

```bash
pnpm vitest run 'app/api/learning-items/[id]/route.test.ts'
```

Expected: failure because the API does not select verification columns.

- [ ] **Step 3: Expose verification fields**

In `app/api/learning-items/[id]/route.ts`, extend `primaryArtifact` and the select:

```ts
verification_status: artifact.verification_status,
verification_summary: artifact.verification_summary,
verified_by: artifact.verified_by,
```

- [ ] **Step 4: Update UI types and rendering**

In `app/(app)/learning-items/[id]/page.tsx`, extend `PrimaryArtifact`:

```ts
  verification_status:
    | 'not_required'
    | 'not_started'
    | 'queued'
    | 'verified'
    | 'needs_review'
    | 'failed';
  verification_summary: {
    verdict: 'pass' | 'needs_review';
    summary_md: string;
    issues: Array<{
      section_id: string | null;
      severity: 'info' | 'warn' | 'error';
      category: string;
      message: string;
      suggested_fix_md?: string;
    }>;
    confidence: number;
  } | null;
```

In `ArtifactView`, render a second status badge:

```tsx
<span className={`artifact-status verify-${artifact.verification_status}`}>
  {VERIFICATION_STATUS_LABEL[artifact.verification_status]}
</span>
```

Add the label map:

```ts
const VERIFICATION_STATUS_LABEL: Record<PrimaryArtifact['verification_status'], string> = {
  not_required: '无需验证',
  not_started: '待验证',
  queued: '验证中…',
  verified: '已验证',
  needs_review: '需复核',
  failed: '验证失败',
};
```

Below sections, render issues when present:

```tsx
{artifact.verification_summary && (
  <div className="artifact-verification">
    <p>{artifact.verification_summary.summary_md}</p>
    {artifact.verification_summary.issues.length > 0 && (
      <ul>
        {artifact.verification_summary.issues.map((issue, idx) => (
          <li key={`${issue.section_id ?? 'global'}-${idx}`}>
            <strong>{issue.severity}</strong>
            <span>{issue.category}</span>
            <p>{issue.message}</p>
            {issue.suggested_fix_md && <pre>{issue.suggested_fix_md}</pre>}
          </li>
        ))}
      </ul>
    )}
  </div>
)}
```

- [ ] **Step 5: Add CSS**

In `app/globals.css`, add:

```css
.artifact-status.verify-queued,
.artifact-status.verify-not_started {
  background: color-mix(in srgb, var(--warn-bg) 70%, transparent);
  color: var(--warn-ink);
}

.artifact-status.verify-verified {
  background: color-mix(in srgb, var(--good-bg) 72%, transparent);
  color: var(--good-ink);
}

.artifact-status.verify-needs_review,
.artifact-status.verify-failed {
  background: color-mix(in srgb, var(--again-bg) 72%, transparent);
  color: var(--again-ink);
}

.artifact-verification {
  margin-top: var(--s-4);
  padding-top: var(--s-3);
  border-top: 1px solid var(--line);
}

.artifact-verification > p {
  margin: 0 0 var(--s-2) 0;
  color: var(--ink-2);
}

.artifact-verification ul {
  list-style: none;
  display: grid;
  gap: var(--s-2);
  margin: 0;
  padding: 0;
}

.artifact-verification li {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: var(--s-3);
  background: var(--paper-2);
}

.artifact-verification li strong {
  margin-right: var(--s-2);
  font-family: var(--font-mono);
}

.artifact-verification li span {
  color: var(--ink-4);
  font-family: var(--font-mono);
  font-size: var(--fs-meta);
}

.artifact-verification li p {
  margin: var(--s-2) 0 0 0;
}

.artifact-verification li pre {
  white-space: pre-wrap;
  margin: var(--s-2) 0 0 0;
}
```

- [ ] **Step 6: Verify API/UI compile**

Run:

```bash
pnpm vitest run 'app/api/learning-items/[id]/route.test.ts'
pnpm typecheck
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add 'app/api/learning-items/[id]/route.ts' 'app/api/learning-items/[id]/route.test.ts' 'app/(app)/learning-items/[id]/page.tsx' app/globals.css
git commit -m "feat(ui): show note verification state"
```

---

### Task 6: Documentation And Full Verification

**Files:**
- Modify: `docs/modules/lanes.md`
- Modify: `docs/superpowers/status.md`

- [ ] **Step 1: Update lane docs**

In `docs/modules/lanes.md`, change the note generation row from:

```md
| Note generation | ✅ `note_generate` job 填 atomic artifact sections |
```

to:

```md
| Note generation + verification | ✅ `note_generate` job 填 atomic artifact sections；`note_verify` job 二次检查并写 artifact verification metadata / `experimental:note_verify` event |
```

- [ ] **Step 2: Update status roadmap**

In `docs/superpowers/status.md`, under Product Track 1, change:

```md
⬜  NoteVerifyTask Pass 2           笔记内容双 pass 验证
```

to:

```md
🟡  NoteVerifyTask Pass 2           `note_verify` queue + artifact verification metadata landed; proposal-inbox rollback remains later
```

Do not mark the whole Product Track 1 complete.

- [ ] **Step 3: Run targeted suite**

Run:

```bash
pnpm vitest run src/core/schema/schema.test.ts src/ai/task-prompts.test.ts src/server/boss/handlers/note_generate.test.ts src/server/boss/handlers/note_verify.test.ts 'app/api/learning-items/[id]/route.test.ts'
```

Expected: all tests pass.

- [ ] **Step 4: Run repo checks**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm audit:schema
```

Expected:
- `pnpm typecheck`: pass
- `pnpm lint`: pass
- `pnpm audit:schema`: pass; if sandboxed `tsx` IPC fails with `listen EPERM`, rerun with normal permissions and record that as environment-only.

- [ ] **Step 5: Browser smoke**

Start dev server:

```bash
pnpm dev
```

Open a learning item detail page with a seeded artifact that has `verification_status='needs_review'`. Expected UI:
- generation badge still reflects `pending` / `ready` / `failed`
- verification badge shows `需复核`
- summary and issues render below the note sections
- no text overlaps on desktop or mobile viewport widths

- [ ] **Step 6: Commit**

```bash
git add docs/modules/lanes.md docs/superpowers/status.md
git commit -m "docs(status): record note verification lane"
```

---

## Self-Review

- Spec coverage: this implements Product Track 1 `NoteVerifyTask Pass 2` without expanding into embedded checks, note editing, proposal inbox, or rollback.
- Placeholder scan: no task uses TBD/TODO/fill-in language; every code-changing step points to exact files and snippets.
- Type consistency: `generation_status` remains `pending | ready | failed`; `verification_status` is a separate artifact field; `NoteVerificationResult` is the single parser/API/UI shape.

## Stop Point

Stop after the draft PR is opened and validation is green. The next plan after this should be either:

1. **Embedded Check MVP** — turn `check` sections into real lightweight questions, or
2. **Proposal Inbox Unification** — normalize note/graph/variant verification issues into one review surface.

Choose based on what the Claude review of PR #65 says: if correction-event design changes, do Proposal Inbox next; if #65 lands cleanly, do Embedded Check MVP next.
