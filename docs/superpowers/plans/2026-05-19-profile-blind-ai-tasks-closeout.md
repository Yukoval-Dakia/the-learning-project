# Profile-Blind AI Tasks Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the remaining profile-blind AI tasks (`SessionSummaryTask`, `KnowledgeReviewTask`) through `SubjectProfile` so math/wenyan behavior no longer depends on static wenyan registry prompts.

**Architecture:** Keep `src/ai/registry.ts` as historical fallback metadata; render runtime prompts through `getTaskSystemPrompt(task, subjectProfile)`. Resolve a subject profile at owner-service boundaries from existing knowledge domains, and fall back to default only when the reviewed scope is mixed or unknown.

**Tech Stack:** TypeScript, Zod, Next.js server modules, Drizzle, Claude Agent SDK runner, Vitest, Biome.

---

## File Structure

### Modify

| File | Responsibility |
| --- | --- |
| `src/ai/task-prompts.ts` | Add profile-rendered prompts for `SessionSummaryTask` and `KnowledgeReviewTask`. |
| `src/ai/task-prompts.test.ts` | Lock math prompt behavior for summary + maintenance review. |
| `src/server/session/summary.ts` | Resolve reviewed subject profile from review-event knowledge refs and pass it to `runTaskFn`. |
| `src/server/session/summary.test.ts` | Verify `SessionSummaryTask` receives math profile when the session reviewed math knowledge. |
| `src/server/knowledge/review.ts` | Resolve dominant tree subject profile and pass it to `streamTask`. |
| `src/server/knowledge/review.test.ts` | Verify `KnowledgeReviewTask` gets math profile/system prompt in stream wiring. |
| `docs/superpowers/status.md` | Mark remaining high-use AI prompt profile coverage complete after verification. |

---

## Task 1: Runtime Prompt Builders

- [ ] **Step 1.1: Add failing prompt tests**

In `src/ai/task-prompts.test.ts`, add:

```ts
it('builds subject-specific SessionSummaryTask prompts', () => {
  const prompt = getTaskSystemPrompt('SessionSummaryTask', resolveSubjectProfile('math'));
  expect(prompt).toContain('科目上下文：数学');
  expect(prompt).toContain('条件和目标');
  expect(prompt).not.toContain('文言文');
});

it('builds subject-specific KnowledgeReviewTask prompts', () => {
  const prompt = getTaskSystemPrompt('KnowledgeReviewTask', resolveSubjectProfile('math'));
  expect(prompt).toContain('科目上下文：数学');
  expect(prompt).toContain('数学定义、条件、方法或易错模式');
  expect(prompt).toContain('mcp__loom__write_proposal');
  expect(prompt).not.toContain('文言文');
});
```

Run:

```bash
pnpm vitest run src/ai/task-prompts.test.ts
```

Expected: FAIL because both tasks still use registry static prompts.

- [ ] **Step 1.2: Implement prompt builders**

In `src/ai/task-prompts.ts`, add:

```ts
function buildSessionSummaryPrompt(profile: SubjectProfile): string { ... }
function buildKnowledgeReviewPrompt(profile: SubjectProfile): string { ... }
```

Then route these cases:

```ts
case 'SessionSummaryTask':
  return buildSessionSummaryPrompt(profile);
case 'KnowledgeReviewTask':
  return buildKnowledgeReviewPrompt(profile);
```

Run:

```bash
pnpm vitest run src/ai/task-prompts.test.ts
```

Expected: PASS.

---

## Task 2: Session Summary Subject Profile

- [ ] **Step 2.1: Add failing owner-service test**

In `src/server/session/summary.test.ts`, seed math knowledge, put that knowledge id in review events, call `runSessionSummary`, and assert:

```ts
const ctx = runTaskFn.mock.calls[0]?.[2] as { subjectProfile?: { id: string } };
expect(ctx.subjectProfile?.id).toBe('math');
```

Run:

```bash
pnpm vitest run src/server/session/summary.test.ts
```

Expected: FAIL because summary currently calls `runTaskFn('SessionSummaryTask', input, { db })`.

- [ ] **Step 2.2: Resolve profile from reviewed knowledge**

In `src/server/session/summary.ts`:

- import `knowledge` from `@/db/schema`
- import `resolveSubjectProfile`
- collect `referenced_knowledge_ids` from the review events
- query the first referenced knowledge domain
- call:

```ts
const result = await runTaskFn('SessionSummaryTask', input, {
  db,
  subjectProfile: resolveSubjectProfile(firstDomain),
});
```

Run:

```bash
pnpm vitest run src/server/session/summary.test.ts
```

Expected: PASS.

---

## Task 3: Knowledge Review Subject Profile

- [ ] **Step 3.1: Add failing stream wiring test**

In `src/server/knowledge/review.test.ts`, seed a math knowledge tree and run `streamReviewTask({ db })`. After draining the mocked stream, assert:

```ts
const queryOpts = mockAgentSdk.capturedQueryOptions as { systemPrompt?: string };
expect(queryOpts.systemPrompt).toContain('科目上下文：数学');
expect(queryOpts.systemPrompt).not.toContain('文言文');
```

Run:

```bash
pnpm vitest run src/server/knowledge/review.test.ts
```

Expected: FAIL until `streamReviewTask` passes a subject profile to `streamTask`.

- [ ] **Step 3.2: Resolve profile from the knowledge tree**

In `src/server/knowledge/review.ts`, make `buildReviewInput` return both `input` and `subjectProfile`. Use a single non-null domain only when every non-null tree domain is the same; otherwise fall back to default:

```ts
const domains = new Set(tree.map((row) => row.domain).filter(Boolean));
const subjectProfile = resolveSubjectProfile(domains.size === 1 ? [...domains][0] : null);
```

Then call:

```ts
return streamTask('KnowledgeReviewTask', input, {
  db: ctx.db,
  subjectProfile,
  mcpServers: { loom: mcpServer },
});
```

Run:

```bash
pnpm vitest run src/server/knowledge/review.test.ts
```

Expected: PASS.

---

## Task 4: Verify, Update Status, Commit

- [ ] **Step 4.1: Run targeted verification**

```bash
pnpm vitest run src/ai/task-prompts.test.ts src/server/session/summary.test.ts src/server/knowledge/review.test.ts
pnpm typecheck
pnpm lint
```

Expected: PASS.

- [ ] **Step 4.2: Update status**

In `docs/superpowers/status.md`, change the Foundation B prompt line to:

```text
✅  剩余 high-use AI task prompt 抽 profileFragments  attribution / graph proposal / variant / teaching / summary / knowledge review 已走 SubjectProfile
```

- [ ] **Step 4.3: Commit**

```bash
git add src/ai/task-prompts.ts src/ai/task-prompts.test.ts src/server/session/summary.ts src/server/session/summary.test.ts src/server/knowledge/review.ts src/server/knowledge/review.test.ts docs/superpowers/status.md
git commit -m "feat(ai): close remaining profile-aware task prompts"
```
