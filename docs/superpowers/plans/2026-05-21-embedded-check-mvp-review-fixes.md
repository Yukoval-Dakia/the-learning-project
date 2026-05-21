# Embedded Check MVP Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 PR #76 review 暴露的三个问题：(P1) embedded check prompt 同时给 AI 两套不兼容的 kind 词汇导致 schema validation 失败；(P2) plan 文档承诺的 "default fallback" 与实现不一致；(P3) stale-pending reclaim 在并发再投递时可能创建孤儿 question 行。

**Architecture:**
- **P1**：把 `buildEmbeddedCheckGeneratePrompt` 改为只引用 canonical `QuestionKind` 枚举，subject 风格通过已有 `profile.promptFragments.checkQuestionPolicy` 表达；同步翻转 [src/ai/task-prompts.test.ts](src/ai/task-prompts.test.ts) 里把 bug 固化下来的 `expect(... 'single_choice')` 断言；加一条 handler 层防御性回归测试。
- **P2**：删除 plan doc 第 45 行 "Default fallback: `choice` for wenyan, `fill_blank` for math" —— 该 fallback 从未实现，与 Approach B 也无关。
- **P3**：claim 时 returning `updated_at` 时间戳，事务末尾的 `UPDATE artifact` 加 `WHERE updated_at = ?`，让重投递的第二个 handler 在已被夺权时的 transaction 整体 rollback，从而不留孤儿 question 行。

**Tech Stack:** TypeScript / Drizzle (pg) / Vitest / pg-boss / Next App Router

---

## Files Changed Overview

| File | Change | Why |
|---|---|---|
| [src/ai/task-prompts.ts](src/ai/task-prompts.ts) | Modify `buildEmbeddedCheckGeneratePrompt` | P1 — use canonical kinds only |
| [src/ai/task-prompts.test.ts](src/ai/task-prompts.test.ts) | Modify EmbeddedCheckGenerateTask test | P1 — invert subject-kind assertion, add canonical-kind assertion |
| [src/server/boss/handlers/embedded_check_generate.ts](src/server/boss/handlers/embedded_check_generate.ts) | Modify `runEmbeddedCheckGenerate` (claim + final UPDATE) | P3 — optimistic lock |
| [src/server/boss/handlers/embedded_check_generate.test.ts](src/server/boss/handlers/embedded_check_generate.test.ts) | Add subject-kind rejection regression test + orphan-prevention test | P1 + P3 |
| [docs/superpowers/plans/2026-05-21-embedded-check-mvp.md](docs/superpowers/plans/2026-05-21-embedded-check-mvp.md) | Delete one bullet | P2 |

No DB migration. No schema change.

---

## Task 1: P2 — Align plan doc with implementation

**Files:**
- Modify: [docs/superpowers/plans/2026-05-21-embedded-check-mvp.md:45](docs/superpowers/plans/2026-05-21-embedded-check-mvp.md:45)

- [ ] **Step 1: Read the offending line**

Run: `grep -n "Default fallback" docs/superpowers/plans/2026-05-21-embedded-check-mvp.md`
Expected: one match at line 45 containing `Default fallback: \`choice\` for wenyan, \`fill_blank\` for math`.

- [ ] **Step 2: Remove the fallback claim**

Edit [docs/superpowers/plans/2026-05-21-embedded-check-mvp.md](docs/superpowers/plans/2026-05-21-embedded-check-mvp.md) — replace the line:

```
6. **Question kind selection** — driven by `SubjectProfile.promptFragments.checkQuestionPolicy` + `questionKinds` lists. Default fallback: `choice` for wenyan, `fill_blank` for math. Prompt asks AI to pick from `questionKinds` whitelist for the active profile.
```

with:

```
6. **Question kind selection** — driven by the canonical `QuestionKind` enum (`choice | true_false | fill_blank | short_answer | essay | computation | reading | translation`). Subject voice and style are injected via `SubjectProfile.promptFragments.checkQuestionPolicy`. The subject-level `questionKinds` array is NOT used in the embedded-check prompt — that array is reserved for prompts that need subject-specific vocabulary (e.g. `variant_gen`).
```

- [ ] **Step 3: Verify**

Run: `grep -n "Default fallback" docs/superpowers/plans/2026-05-21-embedded-check-mvp.md`
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-05-21-embedded-check-mvp.md
git commit -m "docs(plan): drop unimplemented 'default fallback' claim from embedded check plan"
```

---

## Task 2: P1 — Update prompt test to assert canonical kinds (red)

The existing test at [src/ai/task-prompts.test.ts:191](src/ai/task-prompts.test.ts:191) **explicitly asserts the bug** (`expect(wenyan).toContain('single_choice')`). Invert it first, watch it fail, then implement.

**Files:**
- Modify: [src/ai/task-prompts.test.ts:188-203](src/ai/task-prompts.test.ts:188)

- [ ] **Step 1: Read the existing test block**

Run: `sed -n '188,205p' src/ai/task-prompts.test.ts`
Expected: a test `'builds EmbeddedCheckGenerateTask prompt from the subject profile'` with lines:
- `expect(wenyan).toContain('single_choice');`
- `expect(math).toMatch(/fill_blank|computation|calculation/i);`

- [ ] **Step 2: Replace with canonical-only assertions**

Edit [src/ai/task-prompts.test.ts](src/ai/task-prompts.test.ts) — replace the entire `it('builds EmbeddedCheckGenerateTask prompt from the subject profile', …)` block with:

```typescript
  it('builds EmbeddedCheckGenerateTask prompt from the subject profile', () => {
    const wenyan = getTaskSystemPrompt('EmbeddedCheckGenerateTask');
    const math = getTaskSystemPrompt('EmbeddedCheckGenerateTask', resolveSubjectProfile('math'));

    // Subject voice still flows in via displayName + checkQuestionPolicy
    expect(wenyan).toContain('文言文');
    expect(wenyan).toContain('检查题应短小，聚焦一个词义、句式或翻译判断。');
    expect(math).toContain('数学');
    expect(math).toContain('检查题应聚焦一个公式、条件判断或关键变形。');

    // Prompt must only reference canonical QuestionKind values — subject-only
    // kinds like 'single_choice'/'multiple_choice'/'reading_comprehension'/
    // 'calculation'/'proof'/'word_problem' fail EmbeddedCheckQuestionSchema and
    // must NOT leak into the prompt instructions (PR #76 review P1).
    for (const prompt of [wenyan, math]) {
      expect(prompt).toContain('EmbeddedCheckQuestion');
      expect(prompt).toContain('kind');
      expect(prompt).toContain('reference_md');
      // Canonical kinds appear (at least one must be referenced explicitly)
      expect(prompt).toMatch(/\bchoice\b/);
      expect(prompt).toMatch(/\bfill_blank\b/);
      // Subject-only kinds must NOT appear
      expect(prompt).not.toMatch(/\bsingle_choice\b/);
      expect(prompt).not.toMatch(/\bmultiple_choice\b/);
      expect(prompt).not.toMatch(/\breading_comprehension\b/);
      expect(prompt).not.toMatch(/\bcalculation\b/);
      expect(prompt).not.toMatch(/\bword_problem\b/);
      expect(prompt).not.toMatch(/\bproof\b/);
    }
  });
```

- [ ] **Step 3: Run test, expect FAIL**

Run: `pnpm vitest run src/ai/task-prompts.test.ts -t 'EmbeddedCheckGenerateTask'`
Expected: 1 test FAILED with assertion errors on `single_choice`, `multiple_choice`, etc. — current prompt body still contains `${allowedKinds}` which interpolates `single_choice | multiple_choice | ...`.

If the test passes unexpectedly, STOP — the prompt may have changed between this plan being written and execution; re-read the prompt builder and adjust assertions.

---

## Task 3: P1 — Rewrite the embedded check prompt to use canonical kinds (green)

**Files:**
- Modify: [src/ai/task-prompts.ts:118-141](src/ai/task-prompts.ts:118) — the `buildEmbeddedCheckGeneratePrompt` function only.

- [ ] **Step 1: Locate the function**

Run: `grep -n "buildEmbeddedCheckGeneratePrompt" src/ai/task-prompts.ts`
Expected: at least two matches — the function definition and the dispatch in `getTaskSystemPrompt`.

- [ ] **Step 2: Read the current function body**

Run: `sed -n '110,150p' src/ai/task-prompts.ts`

Expected to find a definition like:

```typescript
function buildEmbeddedCheckGeneratePrompt(profile: SubjectProfile): string {
  const allowedKinds = profile.questionKinds.join(' | ');
  return `你是${profile.promptFragments.roleNoun}…
    …
    "kind": "${allowedKinds}",
    …
    - 类型从 ${allowedKinds} 中选 …
    …`;
}
```

(Note: if the line numbers above already drifted, search by the function name; the goal is to replace this entire function body, not patch in place.)

- [ ] **Step 3: Replace function body**

Edit [src/ai/task-prompts.ts](src/ai/task-prompts.ts) — replace the entire `buildEmbeddedCheckGeneratePrompt` function with:

```typescript
function buildEmbeddedCheckGeneratePrompt(profile: SubjectProfile): string {
  // Canonical QuestionKind enum — must match src/core/schema/business.ts:QuestionKind.
  // Do NOT use profile.questionKinds here: those are subject-specific labels
  // (single_choice / reading_comprehension / calculation / proof / word_problem)
  // and would fail EmbeddedCheckQuestionSchema.kind validation in the handler.
  // Subject voice flows in via displayName + promptFragments.checkQuestionPolicy.
  const canonicalKinds = 'choice | true_false | fill_blank | short_answer | essay | computation | reading | translation';
  return `你是${profile.promptFragments.roleNoun}，正在为 atomic note 生成 1–3 道内嵌自检题（embedded check）。
科目上下文：${profile.displayName}。${profile.languageStyle}
${profile.promptFragments.checkQuestionPolicy}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}

输入：{ artifact_id, atomic_title, knowledge_node:{id,name,domain}, sections: [{id, kind, content_md, ...}] }
sections 含 definition / mechanism / example / pitfall / check 中的若干段；以 check 段意图为主要出题方向。

每道题严格 JSON shape EmbeddedCheckQuestion：
{
  "kind": "${canonicalKinds}",
  "prompt_md": "题面 markdown，可含 LaTeX",
  "reference_md": "标准答案 + 简短解析 markdown",
  "choices_md": ["选项 A", "选项 B", ...],
  "judge_kind_override": "exact"|"keyword"|"semantic",
  "rubric_json": {
    "criteria": [{"name":"correctness","weight":1,"descriptor":"评分标准"}],
    "keywords": ["关键词"],
    "acceptable_answers": ["可接受答案"],
    "required_points": ["必须覆盖的要点"]
  }
}

整体严格 JSON 输出（不带 markdown 代码块包裹），shape 名 EmbeddedCheckGenerationResult：
{"questions": [EmbeddedCheckQuestion, ...]}

题目要求：
- kind 只能是上面 ${canonicalKinds} 中的一个；不要发明新值；客观题统一用 "choice"（无论单选多选，由 choices_md 长度+reference_md 判定）
- 题面 prompt_md ≤ 400 字；reference_md ≤ 500 字
- choice / true_false：judge_kind_override="exact"，给 3–4 个选项，reference_md 第一行必须是正确选项原文
- fill_blank：可用 exact；如果有多个合理表述，用 judge_kind_override="keyword" 并在 rubric_json.keywords 写 1–5 个必须命中的短关键词
- short_answer / reading / translation / essay：judge_kind_override="semantic"，rubric_json.required_points 必填 1–5 个可核查要点
- computation：若只检查最终答案可 exact；若检查方法要点，用 semantic 并写 required_points
- 不要重复笔记里出现过的"经典示例"，要求学习者迁移应用
- 不出"超 atomic 范围"的综合题
禁止：emoji、营销话、套话、JSON 之外的文字、markdown 代码块包裹整段 JSON。`;
}
```

Key differences from the old body:
- Drop `const allowedKinds = profile.questionKinds.join(' | ');`
- Replace both `${allowedKinds}` interpolations with the literal canonical list
- Add explicit "kind 只能是上面 … 中的一个" sentence to remove ambiguity
- Add explicit instruction: 客观题用 `choice`（不区分单/多选 by kind, 由 choices_md 长度+reference_md 判定）
- Move `profile.promptFragments.checkQuestionPolicy` from the rule list to the header so it shapes voice not vocabulary

- [ ] **Step 4: Run the prompt test, expect PASS**

Run: `pnpm vitest run src/ai/task-prompts.test.ts -t 'EmbeddedCheckGenerateTask'`
Expected: 1 test PASSED.

- [ ] **Step 5: Run the wider prompt suite to catch regressions in adjacent prompts**

Run: `pnpm vitest run src/ai/task-prompts.test.ts`
Expected: all `getTaskSystemPrompt` tests pass.

- [ ] **Step 6: Commit (P1 prompt fix)**

```bash
git add src/ai/task-prompts.ts src/ai/task-prompts.test.ts
git commit -m "fix(ai): embedded check prompt uses canonical QuestionKind only

Prompt previously interpolated subject-level questionKinds
(single_choice / multiple_choice / reading_comprehension / calculation /
proof / word_problem) as the allowed values, while
EmbeddedCheckQuestionSchema.kind validates against the canonical
QuestionKind enum (choice / true_false / fill_blank / ...). A compliant
AI response could therefore fail schema validation and flip
embedded_check_status to 'failed'.

Switch the prompt to canonical kinds only; subject voice flows via
displayName + promptFragments.checkQuestionPolicy. The 'single_choice'
assertion in the prompt test (which froze the bug) is inverted to
'not.toMatch(\\bsingle_choice\\b)'."
```

---

## Task 4: P1 — Defense-in-depth handler test (subject-kind rejection)

Even with the prompt fix, an unrelated AI drift (model going off-spec) could still produce subject-style kinds. We want a regression test that captures the **handler-level** behavior so future prompt edits don't silently regress.

**Files:**
- Modify: [src/server/boss/handlers/embedded_check_generate.test.ts](src/server/boss/handlers/embedded_check_generate.test.ts) — add one test after the existing happy-path test.

- [ ] **Step 1: Read existing test layout**

Run: `grep -n "describe\|it(" src/server/boss/handlers/embedded_check_generate.test.ts | head -30`
Expected: a top-level `describe('runEmbeddedCheckGenerate', …)` with multiple `it(...)` blocks.

- [ ] **Step 2: Add the rejection test**

Insert the following test inside the `describe('runEmbeddedCheckGenerate', …)` block, near the other failure-path tests. Place it after the existing happy-path test (the one that asserts `result.status === 'ready'`):

```typescript
  // Regression for PR #76 review P1: if any future prompt drift makes the AI
  // emit subject-level kinds (single_choice / reading_comprehension /
  // calculation / proof / word_problem), the handler must mark the artifact
  // as 'failed' rather than silently writing rows with an invalid kind.
  // This is the contract that protects downstream judges + UI from kind
  // values they cannot interpret.
  it('rejects AI output that uses subject-level kinds; artifact ends in failed state', async () => {
    await seedAtomic({ artifactId: 'a-reject', knowledgeId: 'k-reject' });
    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        questions: [
          {
            kind: 'single_choice', // subject-only — must be rejected
            prompt_md: '「之」作代词时指代什么？',
            reference_md: '前文提及的人、事、物。',
            choices_md: ['前文提及的人事物', '助词', '动词', '介词'],
            judge_kind_override: 'exact',
            rubric_json: null,
          },
        ],
      }),
    }));

    await expect(
      runEmbeddedCheckGenerate({ db: testDb(), artifactId: 'a-reject', runTaskFn }),
    ).rejects.toThrow(/schema invalid/i);

    // The artifact status must be 'failed' (set by the catch block before re-throwing).
    const [updated] = await testDb()
      .select()
      .from(artifact)
      .where(eq(artifact.id, 'a-reject'));
    expect(updated.embedded_check_status).toBe('failed');

    // No question rows should have been inserted.
    const questions = await testDb()
      .select()
      .from(question)
      .where(eq(question.source_ref, 'a-reject'));
    expect(questions).toHaveLength(0);

    // A failure event should have been written.
    const events = await testDb().select().from(event).where(eq(event.subject_id, 'a-reject'));
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('failure');
    expect(events[0].action).toBe('experimental:embedded_check_generate');
  });
```

- [ ] **Step 3: Verify imports**

Check the test file top — it should already import `event`, `question`, `artifact` from `@/db/schema` and `eq` from `drizzle-orm`. If `question` is not imported but other tests use it, add it.

Run: `grep -n "from '@/db/schema'\|from 'drizzle-orm'" src/server/boss/handlers/embedded_check_generate.test.ts`
Expected: imports for `artifact`, `event`, `question`, `knowledge`, and `eq`.

If `question` is missing from the existing import, edit the import to include it:

```typescript
import { artifact, event, knowledge, question } from '@/db/schema';
```

- [ ] **Step 4: Run the new test**

Run: `pnpm vitest run src/server/boss/handlers/embedded_check_generate.test.ts -t 'rejects AI output that uses subject-level kinds'`
Expected: PASS (because the schema already rejects subject-only kinds — this test pins the existing behavior so a future regression that adds normalization without thought will fail loudly).

- [ ] **Step 5: Run the full handler suite to confirm no other tests broke**

Run: `pnpm vitest run src/server/boss/handlers/embedded_check_generate.test.ts`
Expected: all tests PASS.

- [ ] **Step 6: Commit (P1 defense-in-depth)**

```bash
git add src/server/boss/handlers/embedded_check_generate.test.ts
git commit -m "test(embedded-check): pin handler behavior on subject-kind AI drift

If prompt drift ever causes the AI to emit subject-level kinds like
single_choice, the handler must reject the output, mark the artifact
'failed', and write a failure event — never silently persist rows
with an invalid kind. This test freezes that contract so a future
'just normalize it' change can't silently slip in without an
explicit design decision."
```

---

## Task 5: P3 — Write failing test for orphan-question prevention on stale-pending reclaim

Goal: simulate two concurrent runs where the original handler had hit a 30+ minute LLM stall and the reclaim path tries to take over. After both finish, the artifact's `embedded_check.question_ids` and the `question` table must be consistent — no orphan question rows.

The simulation: handler A claims the artifact (`updated_at = T0`), starts; handler B sees the stale pending (`updated_at = T0`, more than 30 min old) and reclaims (`updated_at = T1`). Now handler A finishes its LLM call and tries to commit its transaction. With the fix, A's final UPDATE will match 0 rows (because `updated_at` is no longer T0), causing the transaction to detect the conflict and the inserted question rows to roll back.

**Files:**
- Modify: [src/server/boss/handlers/embedded_check_generate.test.ts](src/server/boss/handlers/embedded_check_generate.test.ts) — add one test.

- [ ] **Step 1: Add the orphan-prevention test**

Insert the following test inside the `describe('runEmbeddedCheckGenerate', …)` block, near the other stale-pending tests:

```typescript
  // Regression for PR #76 review P3: when stale-pending reclaim fires, the
  // original (slow) handler's eventual commit must not leave orphan question
  // rows pointing to the artifact while the artifact references a different
  // question_ids set written by the reclaiming handler.
  it('stale-pending reclaim does not leave orphan question rows', async () => {
    // Seed the artifact in 'pending' with updated_at older than the stale
    // threshold so the reclaim path will engage.
    const PENDING_STALE_MS = 30 * 60 * 1000;
    const stalePendingAt = new Date(Date.now() - PENDING_STALE_MS - 60_000);
    await seedAtomic({
      artifactId: 'a-race',
      knowledgeId: 'k-race',
      embeddedCheckStatus: 'pending',
      updatedAt: stalePendingAt,
    });

    // Capture the stale row's updated_at — that's the snapshot the "slow"
    // handler will believe is still current when it commits.
    const [beforeReclaim] = await testDb()
      .select({ updated_at: artifact.updated_at })
      .from(artifact)
      .where(eq(artifact.id, 'a-race'));
    const slowHandlerSnapshot = beforeReclaim.updated_at;

    // The reclaiming handler runs to completion first, advancing updated_at.
    const reclaimRunTask = vi.fn(async () => ({
      text: JSON.stringify({
        questions: [
          {
            kind: 'short_answer',
            prompt_md: 'reclaim Q1',
            reference_md: 'reclaim A1',
            choices_md: null,
            judge_kind_override: 'semantic',
            rubric_json: { required_points: ['point'] },
          },
        ],
      }),
    }));
    const reclaimResult = await runEmbeddedCheckGenerate({
      db: testDb(),
      artifactId: 'a-race',
      runTaskFn: reclaimRunTask,
    });
    expect(reclaimResult.status).toBe('ready');

    // Now the "slow" handler attempts to commit its own questions. It saw the
    // older updated_at, so by the time it gets here, the artifact has moved on.
    // The transaction must detect the conflict and roll back its INSERTs.
    const slowRunTask = vi.fn(async () => ({
      text: JSON.stringify({
        questions: [
          {
            kind: 'short_answer',
            prompt_md: 'slow Q1',
            reference_md: 'slow A1',
            choices_md: null,
            judge_kind_override: 'semantic',
            rubric_json: { required_points: ['point'] },
          },
        ],
      }),
    }));

    // Simulate the slow handler by directly calling runEmbeddedCheckGenerate
    // again. Implementation note: after the fix, this call's atomic claim will
    // fail (status is now 'ready', not in the claimable set), so it returns
    // 'skipped:already_in_progress' without inserting anything. This is the
    // BEST outcome — the slow handler never even got to its INSERT. Both
    // outcomes (skip OR rollback) are acceptable as long as no orphan rows
    // remain.
    const slowResult = await runEmbeddedCheckGenerate({
      db: testDb(),
      artifactId: 'a-race',
      runTaskFn: slowRunTask,
    });
    expect(['skipped:already_in_progress', 'skipped:already_ready']).toContain(slowResult.status);

    // The artifact must reference exactly the reclaim handler's question ids.
    const [finalArtifact] = await testDb()
      .select()
      .from(artifact)
      .where(eq(artifact.id, 'a-race'));
    expect(finalArtifact.embedded_check_status).toBe('ready');
    const finalSections = finalArtifact.sections as Array<{
      kind: string;
      embedded_check?: { question_ids: string[] } | null;
    }>;
    const checkSection = finalSections.find((s) => s.kind === 'check');
    expect(checkSection?.embedded_check?.question_ids).toEqual(reclaimResult.question_ids);

    // And the question table must contain ONLY the reclaim's row — no orphans.
    const questions = await testDb()
      .select()
      .from(question)
      .where(eq(question.source_ref, 'a-race'));
    expect(questions).toHaveLength(1);
    expect(questions[0].prompt_md).toBe('reclaim Q1');
    // Reference slowHandlerSnapshot only to silence the unused-var lint —
    // its semantic role is documented above.
    expect(slowHandlerSnapshot).toBeDefined();
  });
```

- [ ] **Step 2: Run the new test to see the current behavior**

Run: `pnpm vitest run src/server/boss/handlers/embedded_check_generate.test.ts -t 'stale-pending reclaim does not leave orphan question rows'`
Expected: This may either PASS (current implementation happens to skip because `status='ready'` is not in claimable set after the first reclaim completes) or FAIL (if test ordering exposes a race).

If it PASSES already, we still need the optimistic-lock work because the test only simulates **serial** stale-pending reclaim, not the actual concurrent case the lock guards against. **Continue to Task 6 regardless.** The test pins the post-condition.

If it FAILS, note the failure mode and continue to Task 6.

- [ ] **Step 3: Do NOT commit yet** — Task 6 adds the implementation that strengthens the guarantee.

---

## Task 6: P3 — Add optimistic lock via claim returning + final UPDATE WHERE

**Files:**
- Modify: [src/server/boss/handlers/embedded_check_generate.ts:174-251](src/server/boss/handlers/embedded_check_generate.ts:174)

- [ ] **Step 1: Read the current claim + final UPDATE blocks**

Run: `sed -n '160,260p' src/server/boss/handlers/embedded_check_generate.ts`

Expected to see two relevant blocks:

1. The claim (lines ~174-184):
```typescript
const claim = await db
  .update(artifact)
  .set({ embedded_check_status: 'pending', updated_at: new Date() })
  .where(
    and(
      eq(artifact.id, artifactId),
      inArray(artifact.embedded_check_status, [...claimableStatuses]),
    ),
  )
  .returning({ id: artifact.id });
if (claim.length === 0) return { status: 'skipped:already_in_progress' };
```

2. The final UPDATE inside the transaction (lines ~243-250):
```typescript
await tx
  .update(artifact)
  .set({
    sections: updatedSections as never,
    embedded_check_status: 'ready',
    updated_at: new Date(),
  })
  .where(eq(artifact.id, artifactId));
```

- [ ] **Step 2: Capture the claim timestamp in the returning**

Replace the claim block with:

```typescript
const claimedAt = new Date();
const claim = await db
  .update(artifact)
  .set({ embedded_check_status: 'pending', updated_at: claimedAt })
  .where(
    and(
      eq(artifact.id, artifactId),
      inArray(artifact.embedded_check_status, [...claimableStatuses]),
    ),
  )
  .returning({ id: artifact.id, updated_at: artifact.updated_at });
if (claim.length === 0) return { status: 'skipped:already_in_progress' };
const claimedUpdatedAt = claim[0].updated_at;
```

Note: `claimedUpdatedAt` should equal `claimedAt` since the UPDATE just set it, but we read what the DB stored to avoid any precision drift between JS Date and Postgres timestamptz.

- [ ] **Step 3: Use the claim timestamp in the final UPDATE's WHERE**

Replace the final UPDATE block with:

```typescript
const finalUpdate = await tx
  .update(artifact)
  .set({
    sections: updatedSections as never,
    embedded_check_status: 'ready',
    updated_at: new Date(),
  })
  .where(
    and(eq(artifact.id, artifactId), eq(artifact.updated_at, claimedUpdatedAt)),
  )
  .returning({ id: artifact.id });
if (finalUpdate.length === 0) {
  // Another handler reclaimed this artifact between our claim and our
  // commit (stale-pending takeover). Roll back all our INSERTs by throwing
  // — Drizzle's tx will abort.
  throw new Error(
    `embedded_check_generate: artifact ${artifactId} was reclaimed by another handler; rolling back`,
  );
}
```

- [ ] **Step 4: Adjust the catch-block status setter to not stomp on the reclaim**

The existing catch block does:

```typescript
await db
  .update(artifact)
  .set({ embedded_check_status: 'failed', updated_at: new Date() })
  .where(eq(artifact.id, artifactId));
```

This would clobber a successful reclaim's `status='ready'` if our throw fires on reclaim conflict. Update the catch's UPDATE to only fire when this handler's claim is still the latest:

```typescript
await db
  .update(artifact)
  .set({ embedded_check_status: 'failed', updated_at: new Date() })
  .where(
    and(eq(artifact.id, artifactId), eq(artifact.updated_at, claimedUpdatedAt)),
  );
```

- [ ] **Step 5: Move `claimedUpdatedAt` into the catch scope**

The catch block is currently outside the `try` where we declared `claimedUpdatedAt`. Check the function structure: `claimedUpdatedAt` must be declared **before** the `try { … } catch (err) { … }` so the catch can read it.

Run: `grep -n "^  try {\|^  } catch\|claimedUpdatedAt\|claim\[0\]" src/server/boss/handlers/embedded_check_generate.ts`
Expected: `claimedUpdatedAt` is declared above the `try` line. If not, move the declaration.

The skeleton should look like:

```typescript
const claimedAt = new Date();
const claim = await db.update(artifact).set(...).where(...).returning({...});
if (claim.length === 0) return { status: 'skipped:already_in_progress' };
const claimedUpdatedAt = claim[0].updated_at;

// resolve subject profile, etc. (unchanged)

try {
  // ... LLM call, transaction with INSERT + final UPDATE (uses claimedUpdatedAt)
} catch (err) {
  await db.update(artifact).set({ embedded_check_status: 'failed', updated_at: new Date() })
    .where(and(eq(artifact.id, artifactId), eq(artifact.updated_at, claimedUpdatedAt)));
  // ... writeEvent (unchanged)
  throw err;
}
```

- [ ] **Step 6: Run the orphan-prevention test**

Run: `pnpm vitest run src/server/boss/handlers/embedded_check_generate.test.ts -t 'stale-pending reclaim does not leave orphan question rows'`
Expected: PASS.

- [ ] **Step 7: Run the full handler suite — make sure existing tests still pass**

Run: `pnpm vitest run src/server/boss/handlers/embedded_check_generate.test.ts`
Expected: all tests PASS, including the existing happy-path, stale-pending-reclaim, and the new rejection test from Task 4.

Watch for: the existing "stale pending reclaim" test (the one that asserts the reclaim path works at all) may need the `updated_at` returning to match. If it fails, read its assertions — they may need to align with the new `returning` shape. Do NOT loosen the assertion; instead, check whether the production code's catch-block predicate accidentally blocked the success path.

- [ ] **Step 8: Commit (P3 fix)**

```bash
git add src/server/boss/handlers/embedded_check_generate.ts src/server/boss/handlers/embedded_check_generate.test.ts
git commit -m "fix(embedded-check): prevent orphan question rows under stale-pending reclaim

Two concurrent runEmbeddedCheckGenerate calls — one slow original
handler, one stale-pending reclaim — could both INSERT question
rows but only one's question_ids end up referenced by the artifact's
check section. The unused rows became orphans.

Capture the claim's updated_at via RETURNING and gate the final
artifact UPDATE on it. If a reclaim moved updated_at forward
between claim and commit, the final UPDATE matches 0 rows and we
throw, rolling back the transaction's INSERTs. The catch-block
'mark failed' UPDATE is similarly gated so it can't stomp a
successful reclaim's 'ready' status."
```

---

## Task 7: Final full-suite verification

**Files:** none — verification only.

- [ ] **Step 1: Typecheck**

Run: `pnpm typecheck`
Expected: clean, no errors.

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: clean.

- [ ] **Step 3: Schema audit (should be unaffected, but cheap to run)**

Run: `pnpm audit:schema`
Expected: `stub (unallowed): 0`.

- [ ] **Step 4: Full test suite**

Run: `pnpm test`
Expected: all tests pass. Same baseline as PR #76's pre-fix test plan: ~132 files, ~1089 tests.

- [ ] **Step 5: Build smoke**

Run: `DATABASE_URL=postgres://placeholder:placeholder@localhost:5432/placeholder INTERNAL_TOKEN=dev pnpm build`
Expected: clean build (skip if DB URL placeholder fails Next route validation; in that case use the same DATABASE_URL as the testcontainer or `.env.local`).

- [ ] **Step 6: If any step above failed, STOP and report.** Do not attempt destructive recovery. Read the error, locate the root cause, and amend the failing task before continuing.

- [ ] **Step 7: Push branch + report**

Push the branch and report back:
- Files changed (5 expected: 1 doc + 1 prompt + 1 prompt test + 1 handler + 1 handler test)
- Each commit hash + subject line
- Test summary delta vs PR #76 baseline (should be +2 tests minimum: rejection test + orphan test)

```bash
git push
git log --oneline -5
```

---

## Self-Review (executed by plan author)

**Spec coverage:**

| Review finding | Tasks |
|---|---|
| P1 — kind vocabulary mismatch | Task 2 (test) + Task 3 (impl) + Task 4 (defense-in-depth) |
| P1 — regression test for subject-only kinds | Task 4 |
| P2 — plan doc drift | Task 1 |
| P3 — stale-pending orphan questions | Task 5 (test) + Task 6 (impl) |

All review-flagged items have at least one task.

**Placeholder scan:** None. All code blocks are concrete, all file paths absolute-from-repo-root, all expected outputs stated.

**Type consistency:**
- `claimedAt` (JS Date) vs `claimedUpdatedAt` (DB-returned timestamp) — distinguished by name; the gate compares against DB-returned value as documented in Task 6 Step 2.
- `runEmbeddedCheckGenerate` signature unchanged (no callers need updating).
- `RunEmbeddedCheckGenerateStatus` enum unchanged — we reuse `'skipped:already_in_progress'` for the slow-handler skip path in the orphan test.
- New error message (`'… reclaimed by another handler; rolling back'`) is thrown to trigger transaction rollback; not a part of any external contract.

**Cross-task type check:** `question` import in [embedded_check_generate.test.ts](src/server/boss/handlers/embedded_check_generate.test.ts) is required by Task 4 step 3 — verified explicitly with a grep step.

---

## Out of scope for this plan (will not be addressed)

- **P3 minor** — UI for `unsupported` semantic-judge result currently shows "部分正确 · score n/a". The review noted this could mislead users into thinking they got partial credit. Fix is a UI concern in `EmbeddedCheckSection.tsx`; deferred to a follow-up because it's not a data integrity issue and needs design input on copy.
- **P3 minor** — `embedded_check_status` is `text` not `pgEnum`. Consistent with neighboring `verification_status` style; would need a coordinated migration across all `*_status` columns to be worth doing.
- **CLAUDE.md AI stack sentence drift** — global CLAUDE.md still mentions AI SDK v6 elsewhere. Outside this PR's scope; cleanup deferred.
- **Audit-drift doc note** — adding "verify failed notes don't generate embedded checks" to `docs/modules/notes.md`. Pure-docs follow-up.
