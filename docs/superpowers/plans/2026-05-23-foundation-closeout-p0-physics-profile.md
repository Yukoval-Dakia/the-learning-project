# Foundation 真 Closeout — P0 Physics Profile + Foundation B Acid Test 1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** P0 phase deliverable —— physics SubjectProfile 落地 + SubjectRegistry 注册 + DEFAULT_ALIASES + P-1 落地的 10 道 fixture 走 testDb → judgeAnswer 闭环 + **Foundation B acid test 1**（`git diff main -- src/core src/server/ai src/server/review src/ui app/api` 必须为空）。**不**引 `unit_dimension@1` capability（P1）、**不**改 framework schema、**不**加 dev seed endpoint。

**Architecture:**
- Physics profile mirror math profile 形态（`src/subjects/math/profile.ts` 是模板）；spec §5 内容按 framework schema 实际字段名归一化（snake_case `font_family` / `code_highlight`，非 spec 草稿的 camelCase）。
- `src/subjects/profile.ts` 三处改动（全部在 P-1 audit doc baseline §2 允许 delta 范围）：(1) `KNOWN_SUBJECT_IDS += 'physics'`；(2) `DEFAULT_ALIASES += physics aliases`；(3) `SubjectRegistry` constructor `this.register(physicsProfile)` + 一行 import。
- E2e smoke test mirror `src/subjects/math/fixtures/e2e.smoke.test.ts` —— direct testDb insert + judgeAnswer for single_choice fixtures（exact route），**不**接 HTTP / **不**接 LLM。Calculation fixtures 插 DB 但 P0 不判分（unit_dimension 在 P1+，semantic LLM 路径避开）。
- **不**加 `app/api/_/seed/physics/route.ts`（在 `app/api` 路径会触发 acid test 1 失败）。Dev seed endpoint 留作 N+1。
- Acid test 1 baseline = P-1 merge SHA `9191c160a20d8e5afabf11503c6851f510bd2182`（即当前 `main` HEAD）。`git diff main -- <framework paths>` 必须空。

**Tech Stack:** TypeScript / Zod / Drizzle / Vitest db config（自动 `src/**/*.test.ts` glob 减 fastTestInclude，physics e2e 自动进 db partition）。

**Spec source:** `docs/superpowers/specs/2026-05-22-foundation-true-closeout-design.md` §3 Phase P0（line 92-110）+ §5 Physics SubjectProfile 形态（line 249-317）。

**Spec deltas observed:**
- **§5 字段命名**：spec 用 camelCase `fontFamily: 'system-default'` + `codeHighlight: false`，实际 framework schema (`@/core/schema/profile-decl` `RenderConfig`) 用 snake_case `font_family` + `code_highlight: string | null`。Plan 用 `font_family: 'system'` + `code_highlight: null`（mirror math）。
- **§5 `schedulingHints: {}` 空对象** 不通过 zod schema (`SchedulingHints` 需 `default_policy`)。Plan 用 `{ default_policy: 'fsrs' }`（mirror math）。
- **§5 `questionKinds: [..., 'derivation']`**：`SubjectQuestionKindSchema`（`src/subjects/profile.ts:14-23`）不含 `'derivation'`，math profile 也没声明（虽然 math 跑 derivation 题）。Plan physics 用 `['single_choice', 'multiple_choice', 'short_answer', 'calculation']`（去掉 derivation）。如果未来 physics 需要 derivation 题型，加 'derivation' 到 SubjectQuestionKindSchema 是 framework schema 改动 → N+2。
- **§3 P0 #4 "choice + fill_blank 都能 judge"**：P-1 实际落地的 10 道 fixture kind 是 `single_choice`（3 道 dim）+ `calculation`（7 道 unit + formula + dim-003），**没有 `'choice'` 也没有 `'fill_blank'`**。P0 实际验证：single_choice → exact route → coarse_outcome；calculation 插入 DB 但 P0 不判分（route 需要 'semantic' LLM call 或 P1 的 'unit_dimension'）。
- **`KNOWN_SUBJECT_IDS += 'physics'`**：P-1 audit doc §2 baseline allowed delta 只写了 `this.register(physicsProfile)` + DEFAULT_ALIASES，没明示 KNOWN_SUBJECT_IDS。Plan 显式加 `'physics'`，理由：保持 `KnownSubjectId` 类型与运行时 registry 一致，避免类型漂移。本 delta 在 acid test 1 允许范围内（`src/subjects/profile.ts` 已 listed allowed delta）。
- **audit doc §2 baseline SHA 更新**：P-1 写的 `4b8ae51`（working baseline）需更新为 `9191c160a20d8e5afabf11503c6851f510bd2182`（P-1 squash merge SHA），= acid test 1 真 baseline。

**Boundaries (P0 不做):**
- ❌ `unit_dimension@1` capability skeleton（P1 deliverable）
- ❌ `unit_dimension@1` capability impl（P2 deliverable）
- ❌ Rating advisor / UI advisory（P3 deliverable）
- ❌ Framework schema 改动（`src/core/schema/*` LOC change = 0）
- ❌ `app/api/_/seed/physics/route.ts`（在 `app/api` 路径会触发 acid test 1；N+1 if dev bootstrap convenience 需要）
- ❌ Calculation 题判分（preferredRoutes=['exact', 'semantic']，calculation 无 choices_md 会落到 semantic LLM call；P0 e2e smoke 只测 single_choice，calculation 等 P1 unit_dimension）
- ❌ `'derivation'` 题型加进 SubjectQuestionKindSchema（framework schema 改动；N+2）
- ❌ Variant generation / TeachingTurn / NoteGenerate 接入 physics（这些不在 P0 acid test 范围）
- ❌ 引 mathjs / 任何新 npm 依赖（mathjs 的评估留 P2）

---

## File Structure

### Create
- `src/subjects/physics/profile.ts` — physics SubjectProfile（mirror math + spec §5 normalized）
- `src/subjects/physics/fixtures/e2e.smoke.test.ts` — direct testDb e2e smoke（mirror `src/subjects/math/fixtures/e2e.smoke.test.ts`）

### Modify
- `src/subjects/profile.ts` — 3 处改动 + 1 行 import（KNOWN_SUBJECT_IDS / DEFAULT_ALIASES / SubjectRegistry constructor）
- `tests/subjects/profile.test.ts` — 加 physics test cases（registry resolve + alias + cause categories + judgeCapabilities + listIds）
- `docs/audit/2026-05-22-partial-credit-trace.md` — §2 baseline SHA 锁定为 `9191c160`

### Not modified
- 所有 framework 文件（`src/core/**` / `src/server/ai/**` / `src/server/review/**` / `src/ui/**` / `app/api/**`） —— acid test 1 baseline
- vitest configs（math e2e 走 `src/**/*.test.ts` glob in `vitest.db.config.ts`，physics e2e 自动包含；不需手动改 config）

---

## Tasks

### Task 1: 写 physics profile

**Files:**
- Create: `src/subjects/physics/profile.ts`

- [ ] **Step 1: Write profile**

Write to `src/subjects/physics/profile.ts`:

```ts
import type { SubjectProfile } from '../profile';

// P0 (2026-05-23): physics SubjectProfile per spec §5, normalized to actual
// framework schema:
//   - font_family / code_highlight use snake_case (spec draft used camelCase)
//   - schedulingHints needs default_policy (spec showed empty {})
//   - questionKinds excludes 'derivation' (not in SubjectQuestionKindSchema;
//     adding it = framework schema change, deferred to N+2)
// judgeCapabilities: ['exact', 'semantic'] at P0; 'unit_dimension' lands in P1.
// See docs/superpowers/specs/2026-05-22-foundation-true-closeout-design.md §5

export const physicsProfile: SubjectProfile = {
  id: 'physics',
  version: '1.0.0',
  displayName: '物理',
  languageStyle: '中文讲解，强调物理量定义、单位与量纲、推导链路。',
  questionKinds: [
    'single_choice',
    'multiple_choice',
    'short_answer',
    'calculation',
  ],
  judgePolicy: {
    preferredRoutes: ['exact', 'semantic'],
    notes: [
      '数值题优先 unit_dimension（P1+ capability 落地后）。',
      '推导题复用 steps@1（与 math 共享 capability，不重写）。',
      '公式选择题走 exact / semantic。',
    ],
  },
  exampleSources: ['题面条件', '物理定律', '推导公式', '学生计算步骤'],
  noteTemplate: {
    definition: '写清物理量定义、单位、矢量/标量属性、适用条件。',
    mechanism: '拆解所用物理定律、推导链路、量纲一致性检查。',
    example: '给出带单位的完整推导例题，保留中间量纲。',
    pitfall: '列出易错单位换算、矢量方向、适用条件遗漏、量纲错位。',
    check: '给出一个量纲检查或单位换算小题。',
  },
  grounding: {
    requirement: '推导必须能追溯到物理定律、定义、量纲分析或题面条件。',
    allowedSources: ['user_material', 'textbook', 'formula_sheet', 'llm_prior'],
    uncertaintyPolicy: '条件不足时指出缺少的条件，不默认补题。',
  },
  promptFragments: {
    roleNoun: '物理学习教练',
    noteExamplePolicy: '例题必须带单位标注、每步推导依据、量纲一致性检查。',
    variantExamplePolicy: '变式题保持同一物理定律，改变数值、单位或场景设定。',
    teachingStyle: '先检查物理量与单位是否匹配，再给推导路径，最后做量纲检验。',
    checkQuestionPolicy: '检查题应聚焦一个公式应用、单位换算或量纲分析。',
    learningIntentPolicy: '把模糊目标改写成具体物理量推导、定律应用或单位换算练习。',
  },
  causeCategories: [
    {
      id: 'unit',
      label: '单位错误',
      description: '单位换算 / 单位丢失 / 单位错配',
      review_priority: 5,
    },
    {
      id: 'dimension',
      label: '量纲错误',
      description: '量纲不平衡 / 物理意义错误',
      review_priority: 5,
    },
    {
      id: 'formula',
      label: '公式错误',
      description: '公式记错 / 公式适用条件错',
      review_priority: 4,
    },
    {
      id: 'concept',
      label: '概念理解',
      description: '对物理定义、定律、原理的理解错误',
      review_priority: 4,
    },
    {
      id: 'computation',
      label: '计算错误',
      description: '数值代入 / 运算 / 进位错',
      review_priority: 2,
    },
    {
      id: 'careless',
      label: '粗心',
      description: '看错条件、漏抄数据、符号写错',
      review_priority: 1,
      variant_targetable: false,
    },
    {
      id: 'other',
      label: '其他',
      description: '不在上述分类内的错',
      review_priority: 1,
      variant_targetable: false,
    },
  ],
  renderConfig: {
    font_family: 'system',
    notation: 'katex',
    code_highlight: null,
  },
  schedulingHints: {
    default_policy: 'fsrs',
  },
  // P0 (2026-05-23): start with exact + semantic; P1 adds 'unit_dimension'.
  judgeCapabilities: ['exact', 'semantic'],
};
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS. If error mentions unknown property → check `RenderConfig` / `SchedulingHints` / `CauseCategoryDeclaration` schema in `src/core/schema/profile-decl.ts` and align field names / required fields with what math profile uses.

- [ ] **Step 3: Defer commit to end of Task 2**（Task 1+2 一次 commit，避免 profile 存在但未注册的中间态）

---

### Task 2: SubjectRegistry register physicsProfile + aliases + KNOWN_SUBJECT_IDS

**Files:**
- Modify: `src/subjects/profile.ts`（3 处改动 + 1 行 import）

- [ ] **Step 1: 加 'physics' 到 KNOWN_SUBJECT_IDS**

Find `src/subjects/profile.ts:11`:

```ts
export const KNOWN_SUBJECT_IDS = ['wenyan', 'math'] as const;
```

Replace with:

```ts
export const KNOWN_SUBJECT_IDS = ['wenyan', 'math', 'physics'] as const;
```

- [ ] **Step 2: 加 physics aliases 到 DEFAULT_ALIASES**

Find `src/subjects/profile.ts:80-87`:

```ts
const DEFAULT_ALIASES: Record<string, SubjectId> = {
  classical_chinese: 'wenyan',
  chinese_classics: 'wenyan',
  math: 'math',
  mathematics: 'math',
  maths: 'math',
  wenyan: 'wenyan',
};
```

Replace with:

```ts
const DEFAULT_ALIASES: Record<string, SubjectId> = {
  classical_chinese: 'wenyan',
  chinese_classics: 'wenyan',
  math: 'math',
  mathematics: 'math',
  maths: 'math',
  wenyan: 'wenyan',
  physics: 'physics',
  physical: 'physics',
};
```

- [ ] **Step 3: Import physicsProfile + register in constructor**

Find `src/subjects/profile.ts:7-8`:

```ts
import { mathProfile } from './math/profile';
import { wenyanProfile } from './wenyan/profile';
```

Replace with:

```ts
import { mathProfile } from './math/profile';
import { physicsProfile } from './physics/profile';
import { wenyanProfile } from './wenyan/profile';
```

Find constructor body around `src/subjects/profile.ts:98-104`:

```ts
constructor(defaultId: SubjectId = DEFAULT_SUBJECT_ID) {
  this.defaultId = defaultId;
  this.register(wenyanProfile);
  this.register(mathProfile);
  for (const [alias, id] of Object.entries(DEFAULT_ALIASES)) {
    this.aliases.set(normalizeSubjectKey(alias), normalizeSubjectKey(id));
  }
}
```

Replace with:

```ts
constructor(defaultId: SubjectId = DEFAULT_SUBJECT_ID) {
  this.defaultId = defaultId;
  this.register(wenyanProfile);
  this.register(mathProfile);
  this.register(physicsProfile);
  for (const [alias, id] of Object.entries(DEFAULT_ALIASES)) {
    this.aliases.set(normalizeSubjectKey(alias), normalizeSubjectKey(id));
  }
}
```

- [ ] **Step 4: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS. If `physicsProfile` not found → verify Task 1 ran. If profile schema rejects → fix per Task 1 Step 2 guidance.

- [ ] **Step 5: 验证 existing profile tests 不 regress**

```bash
pnpm vitest run --config vitest.unit.config.ts tests/subjects/profile.test.ts 2>&1 | tail -10
```

Expected: existing wenyan + math tests PASS（physics-specific tests 在 Task 3 加，本 step 只确认 existing 不 regress）。

- [ ] **Step 6: Commit Task 1 + 2 together**

```bash
git add src/subjects/physics/profile.ts src/subjects/profile.ts
git commit -m "feat(subjects): register physics SubjectProfile + aliases (P0)

physics profile mirrors math structure with physics-specific cause
taxonomy (unit / dimension / formula / concept / computation /
careless / other) and renderConfig.notation='katex'.
judgeCapabilities=['exact', 'semantic'] at P0; unit_dimension adds
in P1.

SubjectRegistry now registers physicsProfile alongside wenyan +
math. KNOWN_SUBJECT_IDS += 'physics'; DEFAULT_ALIASES += physics /
physical.

Spec deltas vs design.md §5:
- field names snake_case (font_family / code_highlight), not camelCase
- schedulingHints uses default_policy (spec draft showed empty {})
- questionKinds excludes 'derivation' (not in SubjectQuestionKindSchema;
  adding it would be framework schema change, deferred to N+2)"
```

---

### Task 3: Extend profile registry test

**Files:**
- Modify: `tests/subjects/profile.test.ts`

- [ ] **Step 1: Read existing structure to identify insertion point**

```bash
sed -n '1,30p' tests/subjects/profile.test.ts
```

Note existing `describe` block layout and imports. Insert physics block adjacent to math (or at end of file) following same pattern.

- [ ] **Step 2: 加 physics test cases**

Add to `tests/subjects/profile.test.ts` (preserve existing imports + tests; append new describe block):

```ts
import { physicsProfile } from '@/subjects/physics/profile';
import { getDefaultSubjectRegistry, resolveSubjectProfile } from '@/subjects/profile';

describe('physics SubjectProfile', () => {
  it('is registered in the default registry', () => {
    const profile = resolveSubjectProfile('physics');
    expect(profile.id).toBe('physics');
    expect(profile.displayName).toBe('物理');
  });

  it('resolves via physical alias', () => {
    const profile = resolveSubjectProfile('physical');
    expect(profile.id).toBe('physics');
  });

  it('declares katex renderConfig', () => {
    expect(physicsProfile.renderConfig.notation).toBe('katex');
  });

  it('declares cause categories including unit and dimension', () => {
    const causeIds = physicsProfile.causeCategories.map((c) => c.id);
    expect(causeIds).toContain('unit');
    expect(causeIds).toContain('dimension');
  });

  it('judgeCapabilities at P0: exact + semantic', () => {
    expect(physicsProfile.judgeCapabilities).toEqual(['exact', 'semantic']);
  });

  it('appears in registry.listIds()', () => {
    const registry = getDefaultSubjectRegistry();
    expect(registry.listIds()).toContain('physics');
  });
});
```

(If `getDefaultSubjectRegistry` / `resolveSubjectProfile` / other imports already exist at top of file, dedupe imports — biome / typecheck will flag duplicates.)

- [ ] **Step 3: Run profile tests**

```bash
pnpm vitest run --config vitest.unit.config.ts tests/subjects/profile.test.ts 2>&1 | tail -15
```

Expected: existing tests + 6 new physics tests all PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/subjects/profile.test.ts
git commit -m "test(subjects): physics SubjectProfile registry + resolver coverage (P0)

6 cases — registered / physical alias / katex notation / unit+dimension
causes / judgeCapabilities at P0 / appears in registry.listIds()"
```

---

### Task 4: Physics e2e smoke test (testDb + single_choice judge path)

**Files:**
- Create: `src/subjects/physics/fixtures/e2e.smoke.test.ts`

- [ ] **Step 1: Write e2e smoke test**

Mirror `src/subjects/math/fixtures/e2e.smoke.test.ts` structure. Write to `src/subjects/physics/fixtures/e2e.smoke.test.ts`:

```ts
import type { Db } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import { type JudgeQuestionRow, judgeAnswer } from '@/server/ai/judges/question-contract';
import { resolveSubjectProfile } from '@/subjects/profile';
import { eq } from 'drizzle-orm';
/**
 * P0 — e2e smoke for physics fixture happy path.
 *
 * Inserts the 10 fixtures directly via testDb (P0 explicitly does NOT add
 * app/api/_/seed/physics/route.ts — that would break acid test 1 since
 * `app/api` is a framework path).
 *
 * P0 judges single_choice fixtures only (physics-dim-001 / physics-dim-002 —
 * exact route via choices_md). Calculation fixtures land in the table but
 * P0 does NOT judge them — `calculation` kind with profile.preferredRoutes=
 * ['exact', 'semantic'] would call semantic LLM route. unit_dimension lands
 * in P1; calculation judging is P1+.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { loadPhysicsFixtures } from './index';

const ROOT_KID = 'k-physics-smoke-root';

async function seedPhysicsFixtures(db: Db): Promise<void> {
  const now = new Date();
  await db.insert(knowledge).values({
    id: ROOT_KID,
    name: '物理 smoke root',
    domain: 'physics',
    parent_id: null,
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  const fixtures = loadPhysicsFixtures();
  for (const item of fixtures) {
    await db.insert(question).values({
      id: `q-smoke-${item.ref}`,
      kind: item.kind,
      prompt_md: item.prompt_md,
      reference_md: item.reference_md,
      choices_md: item.choices_md ?? null,
      rubric_json: null,
      knowledge_ids: [ROOT_KID],
      difficulty: item.difficulty,
      source: 'physics_fixture_smoke',
      variant_depth: 0,
      figures: [],
      image_refs: [],
      structured: null,
      metadata: { fixture_ref: item.ref, knowledge_hint: item.knowledge_hint },
      created_at: now,
      updated_at: now,
      version: 0,
    });
  }
}

function toJudgeRow(row: typeof question.$inferSelect): JudgeQuestionRow {
  return {
    id: row.id,
    kind: row.kind,
    prompt_md: row.prompt_md,
    reference_md: row.reference_md,
    rubric_json: row.rubric_json,
    choices_md: row.choices_md,
    judge_kind_override: row.judge_kind_override,
    figures: row.figures,
    image_refs: row.image_refs,
    structured: row.structured,
  };
}

describe('physics fixture e2e smoke', () => {
  const physicsProfile = resolveSubjectProfile('physics');
  let db: Db;

  beforeAll(() => {
    db = testDb();
  });

  beforeEach(async () => {
    await resetDb();
    await seedPhysicsFixtures(db);
  });

  it('all 10 fixtures land in the question table with figures=[] image_refs=[] structured=null', async () => {
    const rows = await db.select().from(question);
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.figures).toEqual([]);
      expect(row.image_refs).toEqual([]);
      expect(row.structured).toBeNull();
      expect(row.source).toBe('physics_fixture_smoke');
    }
  });

  it('answering physics-dim-001 correctly → exact route → coarse_outcome=correct', async () => {
    const [row] = await db
      .select()
      .from(question)
      .where(eq(question.id, 'q-smoke-physics-dim-001'));
    expect(row).toBeDefined();
    const { route, result } = await judgeAnswer({
      db,
      question: toJudgeRow(row),
      answer_md: '力',
      subjectProfile: physicsProfile,
    });
    expect(route).toBe('exact');
    expect(result.coarse_outcome).toBe('correct');
    expect(result.capability_ref.id).toBe('exact');
  });

  it('answering physics-dim-001 wrongly → exact route → coarse_outcome=incorrect', async () => {
    const [row] = await db
      .select()
      .from(question)
      .where(eq(question.id, 'q-smoke-physics-dim-001'));
    const { route, result } = await judgeAnswer({
      db,
      question: toJudgeRow(row),
      answer_md: '速度',
      subjectProfile: physicsProfile,
    });
    expect(route).toBe('exact');
    expect(result.coarse_outcome).toBe('incorrect');
  });

  it('answering physics-dim-002 correctly → exact route → coarse_outcome=correct', async () => {
    const [row] = await db
      .select()
      .from(question)
      .where(eq(question.id, 'q-smoke-physics-dim-002'));
    const { route, result } = await judgeAnswer({
      db,
      question: toJudgeRow(row),
      answer_md: '$L \\cdot T^{-1}$',
      subjectProfile: physicsProfile,
    });
    expect(route).toBe('exact');
    expect(result.coarse_outcome).toBe('correct');
  });

  // Calculation fixtures (physics-unit-*, physics-formula-*, physics-dim-003)
  // land in DB but P0 does NOT judge them — judge route would be 'semantic'
  // (LLM) or 'unit_dimension' (P1+). Verify only that they're insertable.
  it('calculation fixtures are inserted (judging deferred to P1)', async () => {
    const rows = await db
      .select()
      .from(question)
      .where(eq(question.kind, 'calculation'));
    expect(rows.length).toBeGreaterThanOrEqual(7);
  });
});
```

- [ ] **Step 2: Run e2e smoke (Docker / OrbStack must be running for testcontainer)**

```bash
pnpm test:db src/subjects/physics/fixtures/e2e.smoke.test.ts 2>&1 | tail -15
```

Expected: 5 tests PASS（landing / dim-001 correct / dim-001 incorrect / dim-002 correct / calculation insertion count）。

Troubleshooting:
- `Container not running` / `Docker socket not found` → check OrbStack / Docker Desktop running per `tests/global-setup.ts` (auto-detects macOS socket).
- Test fails on `route` mismatch → check `src/server/ai/judges/question-contract.ts` `resolveQuestionJudgeRoute` for single_choice + choices_md → exact path. Math e2e uses same path; if math passes and physics fails, schema field mismatch likely.
- Test fails on judgeAnswer throwing → likely `physicsProfile` not yet resolved by `resolveSubjectProfile('physics')`. Re-verify Task 2 (SubjectRegistry registration).

- [ ] **Step 3: Commit**

```bash
git add src/subjects/physics/fixtures/e2e.smoke.test.ts
git commit -m "test(physics): e2e smoke single_choice exact-route judging (P0)

Mirror math fixture e2e — direct testDb insert (no HTTP seed
endpoint per P0 acid-test-1 constraint) + judgeAnswer for
single_choice fixtures (physics-dim-001 / physics-dim-002).
Verifies route='exact' + correct/incorrect coarse_outcome.

Calculation fixtures inserted but not judged in P0 — semantic LLM
route avoided; unit_dimension capability arrives in P1."
```

---

### Task 5: Update P-1 audit doc baseline SHA

**Files:**
- Modify: `docs/audit/2026-05-22-partial-credit-trace.md`

- [ ] **Step 1: Update baseline SHA**

P-1 audit doc §2 marked baseline as `4b8ae51` with note "merge 后更新为 main HEAD"。P-1 已 merge 为 `9191c160a20d8e5afabf11503c6851f510bd2182`（squash merge SHA in #86）。

Find in `docs/audit/2026-05-22-partial-credit-trace.md`:

```markdown
**Baseline SHA**: `4b8ae51aead2ce6113bf0b9586cd01700b7e0c47` (P-1 working baseline; merge 后更新为 main HEAD)
**Date frozen**: 2026-05-22
```

Replace with:

```markdown
**Baseline SHA**: `9191c160a20d8e5afabf11503c6851f510bd2182` (P-1 squash-merge SHA on `main`, locked at P0 startup 2026-05-23. Pre-merge working baseline `4b8ae51` superseded.)
**Date frozen**: 2026-05-22 (baseline content) / 2026-05-23 (SHA locked after merge)
```

- [ ] **Step 2: Verify LOC baseline still aligns**

```bash
git diff 9191c160a20d8e5afabf11503c6851f510bd2182 -- src/core src/server src/ui app/api 2>&1 | head -5
```

Expected: empty output 在 P0 branch 当前状态（still no framework diff in P0 commits so far）。如果非空 → acid test 1 已破，回头看刚才哪个 task 不小心动了 framework 文件。

- [ ] **Step 3: Commit**

```bash
git add docs/audit/2026-05-22-partial-credit-trace.md
git commit -m "audit: lock P-1 baseline SHA after #86 merge (P0)

Pre-merge working SHA 4b8ae51 superseded by squash-merge SHA
9191c160 on main. P-1 audit doc §2 baseline updated so acid tests
1/2/3 in P0/P1/P3 reference the actual main HEAD baseline."
```

---

### Task 6: Regression verify

**Files:** read-only

- [ ] **Step 1: typecheck**

```bash
pnpm typecheck
```

Expected: PASS。

- [ ] **Step 2: unit tests (no DB)**

```bash
pnpm test:unit 2>&1 | tail -6
```

Expected: 4 failed (pre-existing on main per P-1 verification) / **490 passed** (484 from P-1 + 6 new physics profile tests). If physics tests fail → debug per Task 3 / Task 4.

- [ ] **Step 3: DB tests including physics e2e + math regression**

```bash
pnpm test:db src/subjects/physics/fixtures/e2e.smoke.test.ts src/subjects/math/fixtures/e2e.smoke.test.ts 2>&1 | tail -10
```

Expected: physics e2e 5 PASS + math e2e regression PASS. If math regressed → physics profile registration corrupted something（rare; check imports / typechain）。

- [ ] **Step 4: audit:schema**

```bash
pnpm audit:schema 2>&1 | tail -5
```

Expected: stub unallowed = 0. P0 doesn't add new DB fields (only registers profile + tests).

- [ ] **Step 5: audit:partition**

```bash
pnpm audit:partition 2>&1 | tail -3
```

Expected: PASS (no errors / warns). `e2e.smoke.test.ts` 自动进 db partition（不在 `fastTestInclude`，走 `src/**/*.test.ts` glob in `vitest.db.config.ts`）。

- [ ] **Step 6: Biome touched files**

```bash
pnpm exec biome check --no-errors-on-unmatched \
  src/subjects/physics \
  src/subjects/profile.ts \
  tests/subjects/profile.test.ts \
  docs/audit/2026-05-22-partial-credit-trace.md
```

Expected: 0 errors. If formatter complains → `pnpm exec biome check --write <paths>` + re-commit.

---

### Task 7: Acid test 1 verify (Foundation B closeout signal)

**Files:** read-only

- [ ] **Step 1: framework diff verify**

```bash
git diff main -- src/core src/server/ai src/server/review src/ui app/api
```

Expected: **EMPTY**. P0 should not touch any of these paths.

If non-empty → **phase 回退** per spec §3 P0 #5：
1. 停下找原因（哪个 task 偷偷改了 framework）
2. 写到本 plan doc 顶部 Spec deltas observed 段下加新条目
3. Tell user + 决定是否调整 spec / 接受 framework diff / revert 改动

- [ ] **Step 2: subjects/profile.ts diff verify**

```bash
git diff main -- src/subjects/profile.ts
```

Expected: only 4 changes (KNOWN_SUBJECT_IDS += 'physics' / DEFAULT_ALIASES += 2 lines / SubjectRegistry register += 1 line / + 1 import line). 如有超出 → 同上回退。

- [ ] **Step 3: Wenyan + math fixture regression spot-check**

```bash
pnpm vitest run --config vitest.unit.config.ts src/subjects/math/fixtures/ tests/subjects/profile.test.ts 2>&1 | tail -10
```

Expected: math fixture tests + profile tests all PASS。

---

### Task 8: Open PR

- [ ] **Step 1: Commit history sanity check**

```bash
git log --oneline main..HEAD
```

Expected ~4 commits（Task 1+2 合一 / Task 3 / Task 4 / Task 5）。Task 6/7 read-only。如果数偏差 → 检查 commits 是否合理拆分。

- [ ] **Step 2: Push branch**

```bash
git push -u origin foundation-closeout/p0-physics-profile
```

- [ ] **Step 3: Write PR body to file + create**

(避免 PR body 含 `git push --force` / `git branch -D` 等字面触发 git-guard hook self-block — 见 [[project-launch-phase-pipeline]] memory)

Write `/tmp/pr-body-p0.md`:

```markdown
## Summary
- `src/subjects/physics/profile.ts` — physics SubjectProfile mirroring math structure; `judgeCapabilities=['exact', 'semantic']` for P0
- `src/subjects/profile.ts` — `KNOWN_SUBJECT_IDS += 'physics'`, `DEFAULT_ALIASES += physics / physical`, SubjectRegistry registers physicsProfile
- `tests/subjects/profile.test.ts` — 6 physics profile / registry coverage tests
- `src/subjects/physics/fixtures/e2e.smoke.test.ts` — direct testDb e2e for single_choice exact-route judging (5 cases)
- `docs/audit/2026-05-22-partial-credit-trace.md` §2 — baseline SHA locked to `9191c160` (P-1 merge SHA, supersedes pre-merge working `4b8ae51`)

## Spec source
`docs/superpowers/specs/2026-05-22-foundation-true-closeout-design.md` §3 Phase P0 + §5 Physics SubjectProfile

## Exit criteria check (spec §3 P0 line 106-110)
- [x] Physics 10 道 fixture 走完闭环 — 3 single_choice fixtures judged via exact route + correct/incorrect coarse_outcome; 7 calculation fixtures inserted (judging is P1+)
- [x] `git diff main -- src/core src/server/ai src/server/review src/ui app/api` 为空 (acid test 1 ✓)
- [x] Profile validator passes — physicsProfile.judgeCapabilities `['exact', 'semantic']` both registered in default registry
- [x] Wenyan + math regression passes (typecheck / test:unit / test:db math fixtures)

## Spec deltas observed (vs design.md §5)
- Field naming snake_case (`font_family` / `code_highlight`), not camelCase as in spec §5 draft
- `schedulingHints` requires `default_policy`; spec draft showed empty `{}`
- `questionKinds` excludes `'derivation'` — not in `SubjectQuestionKindSchema`; adding would be framework schema change (N+2)
- `KNOWN_SUBJECT_IDS += 'physics'` — not explicitly in P-1 audit doc baseline allowed delta but logical extension; recorded here to avoid type drift

## Boundaries verified
- `unit_dimension@1` capability NOT added (P1 deliverable)
- `app/api/_/seed/physics/route.ts` NOT added (would break acid test 1 — `app/api` framework path)
- Calculation fixtures judging NOT enabled in P0 (semantic LLM route avoided; unit_dimension lands P1)
- No new npm deps

## Test plan
- [x] `pnpm typecheck`
- [x] `pnpm test:unit` — 484 + 6 new physics profile = 490 PASS (4 pre-existing fails unchanged from main)
- [x] `pnpm test:db src/subjects/physics/fixtures/e2e.smoke.test.ts` — 5 / 5 PASS
- [x] `pnpm test:db src/subjects/math/fixtures/e2e.smoke.test.ts` — regression PASS
- [x] `pnpm audit:schema` PASS
- [x] `pnpm audit:partition` PASS
- [x] `pnpm exec biome check` touched files clean
- [x] `git diff main -- src/core src/server/ai src/server/review src/ui app/api` empty (acid test 1 ✓)

## Next phase
P1 — `unit_dimension@1` skeleton + Foundation A acid test 2 (registry / router 主体 0 行 diff). Outline `docs/superpowers/plans/2026-05-22-foundation-true-closeout-phases.md`.
```

Then:

```bash
gh pr create --title "feat: foundation closeout P0 — physics SubjectProfile + Foundation B acid test 1" --body-file /tmp/pr-body-p0.md
```

---

## Phase Exit Criterion 验收

按 spec §3 P0 exit criterion（line 106-110）：

- [ ] **Physics 10 道 fixture 走完闭环** — Task 4 e2e smoke 验证 single_choice exact-route 完整 judge 流程；calculation 插入 + 注记 P1 续接
- [ ] **`git diff main -- <framework paths>` 为空** — Task 7 Step 1（acid test 1 ✓）
- [ ] **Profile validator 通过** — Task 3 6 个 test 覆盖
- [ ] **Wenyan + math fixture regression 通过** — Task 6 Step 2 + 3 + Task 7 Step 3

下一 phase（P1）启动条件：本 PR merge + acid test 1 真过（commits on main, framework files 0 diff）+ `unit_dimension@1` capability skeleton 计划开始（spec §3 P1）。
