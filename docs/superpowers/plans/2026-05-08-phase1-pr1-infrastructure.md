# Phase 1 PR 1 (基础设施) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec 的 PR 1（基础设施）— 把 8 项改进合并为一组 commit，让 Phase 1a 开发就绪。

**Architecture:** Cloudflare Workers + D1 远程优先；shared-secret auth；drizzle-zod 单一 schema 来源；vitest 测试基线；R2 / cron / queues 占位以备 Phase 1.5/2。

**Tech Stack:** TypeScript 5.7 strict, React 19 + Vite 6, Tailwind v4, Cloudflare Workers + Hono, Drizzle ORM (D1 dialect), Vercel AI SDK (主线), drizzle-zod, vitest, pnpm 9。

**Spec reference:** `docs/superpowers/specs/2026-05-08-phase1-improvements-design.md` 改进 1 / 2 / 4 / 5 / 10 / 11(占位) / 12(占位) / 13。

---

## File Structure

### 创建（新文件）

- `workers/wrangler.toml` — Cloudflare bindings (D1 + R2 占位 + cron/queues 注释占位)
- `workers/.dev.vars.example` — `ANTHROPIC_API_KEY` + `INTERNAL_TOKEN` 模板
- `workers/src/auth.ts` — `internalAuth` middleware
- `workers/src/auth.test.ts` — auth middleware test
- `workers/src/db.ts` — Drizzle D1 client helper
- `workers/src/types.ts` — `Bindings` / `AppEnv` 类型
- `vitest.config.ts` — vitest 根配置
- `src/__tests__/sanity.test.ts` — 验证 vitest 起步
- `src/core/schema/generated.ts` — drizzle-zod 自动生成 base
- `src/core/schema/business.ts` — JSON 内层 schema + 业务 enum
- `src/core/schema/index.ts` — 整合入口（re-export + extend JSON 字段）
- `src/core/schema/schema.test.ts` — schema parse 单测
- `src/subjects/wenyan/curriculum.json` — 文言文课标 seed 占位
- `src/subjects/wenyan/seed.ts` — seed transform helper
- `src/subjects/wenyan/index.ts` — re-export
- `src/subjects/wenyan/README.md` — 模块说明
- `drizzle/0000_initial.sql` + meta — drizzle-kit 生成的初始 migration

### 修改（已有文件）

- `package.json` — 升级 `ai` / `@ai-sdk/anthropic`，加 `drizzle-zod` / `vitest` / `@vitest/coverage-v8`，加 `test` script
- `.env.example` — 加 `VITE_INTERNAL_TOKEN`
- `src/db/client.ts` — 注释更新（不再有客户端 SQLite 计划）
- `src/ai/client.ts` — fetch 加 `x-internal-token` header
- `src/vite-env.d.ts` — 加 `ImportMetaEnv` 字段类型
- `workers/src/index.ts` — apply auth + use Drizzle D1 + `/api/health` 加 SELECT 1 smoke
- `docs/architecture.md` § 六 技术栈 — 本地存储行改为 D1 远程
- `README.md` — 数据存储行同步

### 删除

- `src/core/schema.ts` — 被 `src/core/schema/` 目录替代

### 不动

- `src/db/schema.ts`（Drizzle table definitions）— 单一来源
- `vite.config.ts` / `tsconfig.json` / `workers/tsconfig.json` / `biome.json` / `index.html`

---

## Tasks

---

### Task 1: 把现有 scaffold 提交为 baseline（改进 5 起手）

**Goal:** 让所有未追踪文件成为起点 commit，避免后续改动无锚。

**Files:**
- 修改：工作树所有 untracked 文件 → 进 git

- [ ] **Step 1: 列出当前 untracked + modified**

```bash
git status --short
```

Expected: 看到 `M  .gitignore`，并看到 `??  README.md` `??  package.json` `??  biome.json` `??  drizzle.config.ts` `??  index.html` `??  src/` `??  tsconfig.json` `??  vite.config.ts` `??  workers/` `??  .env.example` 等 untracked 项。

- [ ] **Step 2: 暂存全部**

```bash
git add README.md package.json biome.json drizzle.config.ts index.html tsconfig.json vite.config.ts .env.example .gitignore src/ workers/
git status --short
```

Expected: 全部进入 "Changes to be committed"，无 untracked 残留。

- [ ] **Step 3: 创建 baseline commit**

```bash
git commit -m "chore: scaffold Phase 1 baseline (untracked → tracked)"
```

Expected: commit 成功；`git log --oneline -2` 看到本 commit。

- [ ] **Step 4: 验证 working tree 干净**

```bash
git status
```

Expected: `nothing to commit, working tree clean`。

---

### Task 2: 升级 Vercel AI SDK 到主线版本（改进 13）

**Goal:** 把 `ai@^1.0.0` / `@ai-sdk/anthropic@^1.0.0` 升到主线。当前代码 SDK 调用面 = 0，升级零现存影响。

**Files:**
- 修改：`package.json`、`pnpm-lock.yaml`

- [ ] **Step 1: 查询当前主线版本**

```bash
pnpm view ai version
pnpm view @ai-sdk/anthropic version
```

Expected: 输出最新 stable 版本号（例如 `5.0.x` / `1.x.x`）。记录两个版本号备用。

- [ ] **Step 2: 升级到主线**

```bash
pnpm up ai @ai-sdk/anthropic --latest
```

Expected: package.json `dependencies` 中两包升到主线 caret range；`pnpm-lock.yaml` 更新。

- [ ] **Step 3: 验证 typecheck 通过**

```bash
pnpm typecheck
```

Expected: 无 error 输出。理由：`src/ai/client.ts` 仅 fetch、`src/ai/registry.ts` 仅 metadata，都不 import SDK。

- [ ] **Step 4: 提交**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): upgrade ai SDK to mainline (改进 13)"
```

---

### Task 3: 加 drizzle-zod + vitest 依赖

**Goal:** 安装 schema 单源 (drizzle-zod) 和测试基线 (vitest) 所需的包。

**Files:**
- 修改：`package.json`、`pnpm-lock.yaml`

- [ ] **Step 1: 安装 drizzle-zod（运行时依赖）**

```bash
pnpm add drizzle-zod
```

Expected: `dependencies` 新增 `drizzle-zod`。注意：drizzle-zod 必须与 drizzle-orm 同代；如果 pnpm 报 peer dep 警告，按提示处理（多半 OK，因为 drizzle-orm 已是 0.36+）。

- [ ] **Step 2: 安装 vitest（开发依赖）**

```bash
pnpm add -D vitest @vitest/coverage-v8
```

Expected: `devDependencies` 新增 `vitest` 和 `@vitest/coverage-v8`。

- [ ] **Step 3: 在 `package.json` 加 test script**

修改 `package.json` 的 `"scripts"` 字段，在现有 script 后追加：

```json
"test": "vitest run",
"test:watch": "vitest"
```

完整 scripts 段示例：

```json
"scripts": {
  "dev": "vite",
  "build": "tsc --noEmit && vite build",
  "preview": "vite preview",
  "typecheck": "tsc --noEmit",
  "lint": "biome check .",
  "format": "biome format --write .",
  "test": "vitest run",
  "test:watch": "vitest",
  "db:generate": "drizzle-kit generate",
  "workers:dev": "wrangler dev --config workers/wrangler.toml",
  "workers:deploy": "wrangler deploy --config workers/wrangler.toml"
}
```

- [ ] **Step 4: 验证 install + typecheck**

```bash
pnpm install
pnpm typecheck
```

Expected: install 完成无 error；typecheck 0 error。

- [ ] **Step 5: 提交**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): add drizzle-zod + vitest"
```

---

### Task 4: Vitest 配置 + sanity test

**Goal:** 让 `pnpm test` 能跑起来，作为后续 TDD 步骤的基础。

**Files:**
- 创建：`vitest.config.ts`
- 创建：`src/__tests__/sanity.test.ts`

- [ ] **Step 1: 写 sanity test**

创建 `src/__tests__/sanity.test.ts`：

```ts
import { describe, expect, it } from 'vitest';

describe('sanity', () => {
  it('basic math works', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 2: 创建 vitest 配置**

创建 `vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'workers/src/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
```

- [ ] **Step 3: 跑测试验证 pass**

```bash
pnpm test
```

Expected: `1 passed`，sanity test 通过。

- [ ] **Step 4: 提交**

```bash
git add vitest.config.ts src/__tests__/sanity.test.ts
git commit -m "chore(test): scaffold vitest with sanity test"
```

---

### Task 5: subjects/wenyan/ skeleton（改进 10）

**Goal:** 建文言文学科占位目录 + 4 个 stub 文件，避免 wenyan 特化代码灌进 `core/`。

**Files:**
- 创建：`src/subjects/wenyan/curriculum.json`
- 创建：`src/subjects/wenyan/seed.ts`
- 创建：`src/subjects/wenyan/index.ts`
- 创建：`src/subjects/wenyan/README.md`

- [ ] **Step 1: 创建 curriculum.json 占位**

写 `src/subjects/wenyan/curriculum.json`：

```json
{
  "version": 0,
  "domain": "wenyan",
  "knowledge_seeds": []
}
```

- [ ] **Step 2: 创建 seed.ts helper**

写 `src/subjects/wenyan/seed.ts`：

```ts
import curriculum from './curriculum.json';

export interface KnowledgeSeed {
  name: string;
  parent_name?: string;
}

export interface Curriculum {
  version: number;
  domain: string;
  knowledge_seeds: KnowledgeSeed[];
}

export function getCurriculum(): Curriculum {
  return curriculum as Curriculum;
}
```

- [ ] **Step 3: 创建 index.ts re-export**

写 `src/subjects/wenyan/index.ts`：

```ts
export { getCurriculum } from './seed';
export type { Curriculum, KnowledgeSeed } from './seed';
```

- [ ] **Step 4: 创建 README.md**

写 `src/subjects/wenyan/README.md`：

```markdown
# subjects/wenyan/

文言文学科 bundle。Phase 1 首发数据集。

- `curriculum.json` — 课标知识点 seed（Knowledge schema 的 source records）
- `seed.ts` — 把 curriculum.json transform 成 DB insert payload 的 helper
- `index.ts` — 包入口

**约束**：`core/` 不依赖 `subjects/`；`subjects/` 可依赖 `core/`。
```

- [ ] **Step 5: 验证 typecheck + import**

```bash
pnpm typecheck
```

Expected: 无 error；`getCurriculum()` 返回 `Curriculum` 类型推断 OK（json import 启用了，因为 `tsconfig.json` 已 `resolveJsonModule: true`）。

- [ ] **Step 6: 提交**

```bash
git add src/subjects/wenyan
git commit -m "feat(subjects): scaffold wenyan skeleton (改进 10)"
```

---

### Task 6: drizzle-zod schema 单一来源重构（改进 4）

**Goal:** 用 drizzle-zod 自动从 Drizzle 表生成 base zod，删除 `src/core/schema.ts` 中与 db/schema.ts 重复的字段定义；JSON 内层结构（Cause / FsrsState 等）保留手写。

**Files:**
- 创建：`src/core/schema/generated.ts`
- 创建：`src/core/schema/business.ts`
- 创建：`src/core/schema/index.ts`
- 创建：`src/core/schema/schema.test.ts`
- 删除：`src/core/schema.ts`

- [ ] **Step 1: 写失败测试（TDD）**

创建 `src/core/schema/schema.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { CauseCategory, KnowledgeInsert, Mistake } from './index';

describe('schema generated from drizzle', () => {
  it('KnowledgeInsert accepts valid record', () => {
    const result = KnowledgeInsert.safeParse({
      id: 'k1',
      name: '宾语前置',
      domain: 'wenyan',
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(result.success).toBe(true);
  });

  it('CauseCategory rejects unknown category', () => {
    const result = CauseCategory.safeParse('not_a_real_category');
    expect(result.success).toBe(false);
  });

  it('Mistake parses with typed cause field', () => {
    const result = Mistake.safeParse({
      id: 'm1',
      question_id: 'q1',
      wrong_answer_md: null,
      wrong_answer_image_refs: [],
      source: 'manual',
      source_ref: null,
      knowledge_ids: [],
      cause: {
        primary_category: 'concept',
        secondary_categories: [],
        ai_analysis_md: '理解偏差',
        user_edited: false,
      },
      fsrs_state: null,
      variants: [],
      variants_generated_count: 0,
      variants_max: 3,
      status: 'active',
      archived_reason: null,
      archived_at: null,
      deleted_at: null,
      delete_reason: null,
      created_at: new Date(),
      updated_at: new Date(),
      version: 0,
    });
    if (!result.success) console.error(result.error.format());
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
pnpm test
```

Expected: 测试 fail —— `Cannot find module './index'`（schema/ 目录下的文件还不存在）。

- [ ] **Step 3: 创建 generated.ts**

写 `src/core/schema/generated.ts`：

```ts
// 由 drizzle-zod 从 src/db/schema.ts 自动生成。
// 改字段请改 src/db/schema.ts，不要在这里手写。
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import * as t from '../../db/schema';

export const KnowledgeInsertGenerated = createInsertSchema(t.knowledge);
export const KnowledgeSelectGenerated = createSelectSchema(t.knowledge);

export const QuestionInsertGenerated = createInsertSchema(t.question);
export const QuestionSelectGenerated = createSelectSchema(t.question);

export const MistakeInsertGenerated = createInsertSchema(t.mistake);
export const MistakeSelectGenerated = createSelectSchema(t.mistake);

export const LearningItemInsertGenerated = createInsertSchema(t.learning_item);
export const LearningItemSelectGenerated = createSelectSchema(t.learning_item);

export const StudyLogInsertGenerated = createInsertSchema(t.study_log);
export const StudyLogSelectGenerated = createSelectSchema(t.study_log);

export const ArtifactInsertGenerated = createInsertSchema(t.artifact);
export const ArtifactSelectGenerated = createSelectSchema(t.artifact);

export const AnswerInsertGenerated = createInsertSchema(t.answer);
export const AnswerSelectGenerated = createSelectSchema(t.answer);

export const JudgmentInsertGenerated = createInsertSchema(t.judgment);
export const JudgmentSelectGenerated = createSelectSchema(t.judgment);

export const UserAppealInsertGenerated = createInsertSchema(t.user_appeal);
export const CompletionEvidenceInsertGenerated = createInsertSchema(t.completion_evidence);
export const DreamingProposalInsertGenerated = createInsertSchema(t.dreaming_proposal);
export const ToolCallLogInsertGenerated = createInsertSchema(t.tool_call_log);
export const CostLedgerInsertGenerated = createInsertSchema(t.cost_ledger);
```

- [ ] **Step 4: 创建 business.ts**

写 `src/core/schema/business.ts`：

```ts
import { z } from 'zod';

// ---------- 业务 enum ----------

export const CauseCategory = z.enum([
  'concept',
  'knowledge_gap',
  'calculation',
  'reading',
  'memory',
  'expression',
  'method',
  'carelessness',
  'time_pressure',
  'other',
]);

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

export const QuestionSource = z.enum([
  'embedded',
  'daily',
  'final',
  'dreaming',
  'manual',
  'vision_single',
  'vision_paper',
  'reverse_mark',
  'mistake_variant',
]);

export const MistakeSource = z.enum([
  'quiz_answer',
  'manual',
  'vision_single',
  'vision_paper',
  'reverse_mark',
]);

export const MistakeStatus = z.enum(['draft', 'active', 'resting', 'archived']);

export const LearningItemSource = z.enum([
  'mistake',
  'manual',
  'learning_intent',
  'ai_dream',
]);

export const LearningItemStatus = z.enum([
  'pending',
  'in_progress',
  'done',
  'dismissed',
  'resting',
  'archived',
]);

export const StudyLogKind = z.enum([
  'highlight',
  'insight',
  'question',
  'reflection',
  'observation',
]);

export const ArtifactType = z.enum(['note_hub', 'note_atomic', 'tool_quiz']);

export const JudgeKind = z.enum([
  'exact',
  'keyword',
  'semantic',
  'rubric',
  'steps',
  'multimodal_direct',
  'ai_flexible',
]);

export const DreamingProposalKind = z.enum([
  'problem',
  'knowledge',
  'quiz',
  'summary',
  'note_section_update',
  'learning_item_completion',
  'learning_item_relearn',
]);

// ---------- JSON 内层 schema ----------

export const Rubric = z.object({
  criteria: z.array(
    z.object({
      name: z.string(),
      weight: z.number(),
      descriptor: z.string(),
    }),
  ),
});

export const Cause = z.object({
  primary_category: CauseCategory,
  secondary_categories: z.array(CauseCategory).default([]),
  ai_analysis_md: z.string(),
  user_notes: z.string().nullish(),
  partial: z.boolean().nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  user_edited: z.boolean().default(false),
});

export const FsrsState = z.object({
  due_at: z.coerce.date(),
  interval: z.number(),
  ease: z.number(),
  repeat: z.number(),
  lapses: z.number(),
  retrievability_at: z.coerce.date().nullish(),
});

export const MistakeVariant = z.object({
  question_id: z.string(),
  status: z.enum(['draft', 'active', 'broken', 'dismissed']),
  failure_reasons: z.array(z.string()).default([]),
});

export const NoteSection = z.object({
  id: z.string(),
  kind: z.enum(['definition', 'mechanism', 'example', 'pitfall', 'check']),
  body_md: z.string(),
  source_tier: z.enum(['llm_only', 'search_grounded', 'textbook', 'user_verified']),
  user_verified: z.boolean().default(false),
  embedded_check: z.object({ question_ids: z.array(z.string()) }).nullish(),
  version: z.number().int().nonnegative(),
});

export const ToolState = z.object({
  question_ids: z.array(z.string()),
  session_meta: z.record(z.unknown()).nullish(),
});
```

- [ ] **Step 5: 创建 index.ts**

写 `src/core/schema/index.ts`：

```ts
import { z } from 'zod';
import * as b from './business';
import * as g from './generated';

export * from './business';

// ---------- Knowledge ----------
export const KnowledgeInsert = g.KnowledgeInsertGenerated.extend({
  approval_status: z.enum(['pending', 'approved', 'rejected']).default('approved'),
});
export const Knowledge = g.KnowledgeSelectGenerated.extend({
  approval_status: z.enum(['pending', 'approved', 'rejected']),
});
export type Knowledge = z.infer<typeof Knowledge>;

// ---------- Question ----------
export const QuestionInsert = g.QuestionInsertGenerated.extend({
  kind: b.QuestionKind,
  source: b.QuestionSource,
  rubric_json: b.Rubric.nullish(),
  visual_complexity: z.enum(['low', 'medium', 'high']).nullish(),
  draft_status: z.enum(['draft', 'active']).nullish(),
});
export const Question = g.QuestionSelectGenerated.extend({
  kind: b.QuestionKind,
  source: b.QuestionSource,
  rubric_json: b.Rubric.nullable(),
  visual_complexity: z.enum(['low', 'medium', 'high']).nullable(),
});
export type Question = z.infer<typeof Question>;

// ---------- Mistake ----------
export const Mistake = g.MistakeSelectGenerated.extend({
  source: b.MistakeSource,
  cause: b.Cause.nullable(),
  fsrs_state: b.FsrsState.nullable(),
  variants: z.array(b.MistakeVariant),
  status: b.MistakeStatus,
  archived_reason: z.enum(['mastered', 'obsolete', 'user']).nullable(),
  delete_reason: z.enum(['user', 'merge', 'duplicate', 'misjudged']).nullable(),
});
export type Mistake = z.infer<typeof Mistake>;

// ---------- LearningItem ----------
export const LearningItem = g.LearningItemSelectGenerated.extend({
  source: b.LearningItemSource,
  status: b.LearningItemStatus,
  archived_reason: z.enum(['maintenance', 'user']).nullable(),
});
export type LearningItem = z.infer<typeof LearningItem>;

// ---------- StudyLog ----------
export const StudyLog = g.StudyLogSelectGenerated.extend({
  kind: b.StudyLogKind,
});
export type StudyLog = z.infer<typeof StudyLog>;

// ---------- Artifact ----------
export const Artifact = g.ArtifactSelectGenerated.extend({
  type: b.ArtifactType,
  intent_source: z.enum(['declared', 'from_mistake', 'from_dream']),
  sections: z.array(b.NoteSection).nullable(),
  tool_state: b.ToolState.nullable(),
  tool_kind: z.enum(['quiz']).nullable(),
  generation_status: z.enum(['pending', 'partial', 'complete']),
});
export type Artifact = z.infer<typeof Artifact>;

// ---------- Quiz 子系统 ----------
export const Answer = g.AnswerSelectGenerated.extend({
  input_kind: z.enum(['text', 'option', 'image', 'voice']),
});
export type Answer = z.infer<typeof Answer>;

export const Judgment = g.JudgmentSelectGenerated.extend({
  judge_kind: b.JudgeKind,
  verdict: z.enum(['correct', 'partial', 'incorrect']),
  triggered_by: z.enum(['initial', 'borderline', 'appeal', 'force']).nullable(),
});
export type Judgment = z.infer<typeof Judgment>;

export const UserAppeal = g.UserAppealInsertGenerated;
export type UserAppeal = z.infer<typeof UserAppeal>;

// ---------- LearningItem 完成证据 ----------
export const CompletionEvidence = g.CompletionEvidenceInsertGenerated.extend({
  path: z.enum(['self_declare', 'ai_propose', 'quiz_pass']),
});
export type CompletionEvidence = z.infer<typeof CompletionEvidence>;

// ---------- Dreaming ----------
export const DreamingProposal = g.DreamingProposalInsertGenerated.extend({
  kind: b.DreamingProposalKind,
  status: z.enum(['pending', 'accepted', 'dismissed']),
});
export type DreamingProposal = z.infer<typeof DreamingProposal>;

// ---------- 观测 ----------
export const ToolCallLog = g.ToolCallLogInsertGenerated;
export type ToolCallLog = z.infer<typeof ToolCallLog>;

export const CostLedger = g.CostLedgerInsertGenerated;
export type CostLedger = z.infer<typeof CostLedger>;
```

- [ ] **Step 6: 跑测试验证通过**

```bash
pnpm test
```

Expected: schema.test.ts 3 个 case 全部 pass。如果失败：
- "KnowledgeInsert accepts valid record" 失败 → drizzle-zod 在 timestamp 列上要 `Date` vs `number`，调整 test fixture 或在 generated 上 `extend({ created_at: z.date() })`
- "Mistake parses with typed cause field" 失败 → 看 `result.error.format()` 输出哪个字段挂了，调整 index.ts 的 extend

- [ ] **Step 7: typecheck**

```bash
pnpm typecheck
```

Expected: 无 error。

- [ ] **Step 8: 删除旧 schema.ts**

```bash
git rm src/core/schema.ts
```

如果有引用旧路径的地方，typecheck 会报错。当前代码 `src/core/schema.ts` 没有被 import（grep 验证）：

```bash
grep -rn "from '@/core/schema'" src workers
grep -rn "from '../core/schema'" src workers
grep -rn "from '../../core/schema'" src workers
```

Expected: 全部无结果（仅 schema 内部互相引用）。

- [ ] **Step 9: 提交**

```bash
git add src/core/schema/
git commit -m "refactor(schema): drizzle-zod 单一来源 (改进 4)"
```

---

### Task 7: Worker auth middleware（改进 2 server side）

**Goal:** TDD 实现 `internalAuth` 中间件，挡掉缺 / 错 token 请求。

**Files:**
- 创建：`workers/src/types.ts`
- 创建：`workers/src/auth.ts`
- 创建：`workers/src/auth.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `workers/src/auth.test.ts`：

```ts
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { internalAuth } from './auth';
import type { AppEnv } from './types';

describe('internalAuth middleware', () => {
  function makeApp() {
    const app = new Hono<AppEnv>();
    app.use('/api/*', internalAuth);
    app.get('/api/ping', (c) => c.json({ ok: true }));
    return app;
  }

  const env = { INTERNAL_TOKEN: 'secret-token' } as unknown as AppEnv['Bindings'];

  it('returns 401 when header missing', async () => {
    const app = makeApp();
    const res = await app.request('/api/ping', {}, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns 401 when token wrong', async () => {
    const app = makeApp();
    const res = await app.request(
      '/api/ping',
      { headers: { 'x-internal-token': 'wrong-token' } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it('passes through when token matches', async () => {
    const app = makeApp();
    const res = await app.request(
      '/api/ping',
      { headers: { 'x-internal-token': 'secret-token' } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
pnpm test
```

Expected: 3 个 test fail —— `Cannot find module './auth'` 或 `Cannot find module './types'`。

- [ ] **Step 3: 创建 types.ts**

写 `workers/src/types.ts`：

```ts
import type { D1Database } from '@cloudflare/workers-types';

export type Bindings = {
  ANTHROPIC_API_KEY: string;
  INTERNAL_TOKEN: string;
  DB: D1Database;
};

export type AppEnv = { Bindings: Bindings };
```

- [ ] **Step 4: 实现 internalAuth**

写 `workers/src/auth.ts`：

```ts
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './types';

export const internalAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = c.req.header('x-internal-token');
  if (!token || token !== c.env.INTERNAL_TOKEN) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
};
```

- [ ] **Step 5: 跑测试验证通过**

```bash
pnpm test
```

Expected: `auth.test.ts` 3 个 case 全部 pass。

- [ ] **Step 6: 提交**

```bash
git add workers/src/auth.ts workers/src/auth.test.ts workers/src/types.ts
git commit -m "feat(worker): add internal auth middleware (改进 2)"
```

---

### Task 8: wrangler.toml + .dev.vars.example + .env.example（改进 5/11/12 配置）

**Goal:** 落地 worker 配置和环境变量样板，含 D1 + R2 + cron/queues 占位。

**Files:**
- 创建：`workers/wrangler.toml`
- 创建：`workers/.dev.vars.example`
- 修改：`.env.example`

- [ ] **Step 1: 创建 wrangler.toml**

写 `workers/wrangler.toml`：

```toml
name = "the-learning-project-api"
main = "src/index.ts"
compatibility_date = "2026-04-01"
compatibility_flags = ["nodejs_compat"]

# Phase 1 D1 binding
# 注意：database_id 需要先跑 `pnpm exec wrangler d1 create learning-project` 后填回。
# wrangler dev --local 模式下 wrangler 会自动 mock D1，不强制需要真实 ID；
# 但 wrangler 仍会要求字段存在，所以保留 placeholder。
[[d1_databases]]
binding = "DB"
database_name = "learning-project"
database_id = "REPLACE_AFTER_WRANGLER_D1_CREATE"

# 改进 11: Phase 1.5 起 R2 存图片
[[r2_buckets]]
binding = "IMAGES"
bucket_name = "learning-project-images"
preview_bucket_name = "learning-project-images-preview"

# 改进 12: Phase 2 起 dreaming / maintenance cron + queues
# Phase 2 实施时启用 + 填值
# [triggers]
# crons = ["0 18 * * *"]      # 北京 02:00 跑 dreaming
#
# [[queues.producers]]
# binding = "DREAMING_TASKS"
# queue = "dreaming-tasks"
#
# [[queues.consumers]]
# queue = "dreaming-tasks"
# max_batch_size = 1
# max_batch_timeout = 30
```

- [ ] **Step 2: 创建 .dev.vars.example**

写 `workers/.dev.vars.example`：

```
# 复制为 workers/.dev.vars 后填实际值（gitignored）
ANTHROPIC_API_KEY=sk-ant-xxx
INTERNAL_TOKEN=GENERATE_WITH_OPENSSL_RAND_HEX_32
```

- [ ] **Step 3: 更新 .env.example**

读取当前 `.env.example`：

```bash
cat .env.example
```

把内容改成：

```
# 客户端公共变量（VITE_ 前缀才会注入到浏览器）。
# Anthropic API key **不在这里** —— 走 workers/.dev.vars，浏览器代码绝不持有 key。

# VITE_API_BASE=/api
VITE_INTERNAL_TOKEN=SAME_AS_WORKERS_DEV_VARS_INTERNAL_TOKEN
```

- [ ] **Step 4: 验证 wrangler 解析 toml**

```bash
pnpm exec wrangler --version
```

Expected: 输出 wrangler 版本号。如果 wrangler 不可执行 → 升级或修复（见 troubleshooting 段）。

跑一次 `wrangler dev` 仅检查 toml 是否被认下（不实际启动）：

```bash
pnpm exec wrangler dev --config workers/wrangler.toml --dry-run 2>&1 | head -30 || true
```

Expected: wrangler 识别 toml；可能因 `database_id` placeholder 输出 warning（"Invalid database_id" 等），但不报"toml syntax error"。这一步只是 sanity check。

如果 wrangler 完全拒绝 placeholder，跑：

```bash
pnpm exec wrangler d1 create learning-project
```

把返回的 UUID 填回 wrangler.toml 的 `database_id`。

- [ ] **Step 5: 提交**

```bash
git add workers/wrangler.toml workers/.dev.vars.example .env.example
git commit -m "chore(wrangler): toml + env templates with all bindings (改进 5/11/12)"
```

---

### Task 9: D1 driver wiring + worker index 改造（改进 1 + 改进 2 server-side 接通）

**Goal:** 把 worker 改造成走 D1 + auth；`/api/health` 探测 D1 连通。

**Files:**
- 创建：`workers/src/db.ts`
- 修改：`workers/src/index.ts`

- [ ] **Step 1: 写 D1 client helper**

写 `workers/src/db.ts`：

```ts
import { drizzle } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '../../src/db/schema';

export function getDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof getDb>;
```

- [ ] **Step 2: 改 worker index 加 auth + DB smoke**

替换 `workers/src/index.ts` 全文：

```ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { internalAuth } from './auth';
import { getDb } from './db';
import type { AppEnv } from './types';

const app = new Hono<AppEnv>();

app.use('*', cors({ origin: '*' }));
app.use('/api/*', internalAuth);

app.get('/api/health', async (c) => {
  let db_ok = false;
  try {
    const result = await c.env.DB.prepare('SELECT 1 as ok').first<{ ok: number }>();
    db_ok = result?.ok === 1;
  } catch {
    db_ok = false;
  }
  return c.json({ ok: true, db_ok });
});

// AI Task 调度入口（Phase 1 留壳，PR 2 改进 6 实现）。
app.post('/api/ai/:task', async (c) => {
  const task = c.req.param('task');
  const body = await c.req.json().catch(() => ({}));
  return c.json({ error: 'not_implemented', task, received: body }, 501);
});

// 让 TS / wrangler 知道 db helper 存在（runtime 还没用，PR 2+ 启用）
export { getDb };

export default app;
```

- [ ] **Step 3: typecheck**

```bash
pnpm typecheck
```

Expected: 无 error。如果 `workers/tsconfig.json` 不包含 `src/db/schema.ts` 路径 → 检查 workers/tsconfig.json 的 `include`，必要时加 `"../src/db/schema.ts"`。

- [ ] **Step 4: 准备 .dev.vars 实际值**

```bash
[ -f workers/.dev.vars ] || cp workers/.dev.vars.example workers/.dev.vars
```

编辑 `workers/.dev.vars`，把占位换成真实值（用户操作）：

```
ANTHROPIC_API_KEY=sk-ant-...your-real-key...
INTERNAL_TOKEN=$(openssl rand -hex 32)
```

也把同一个 INTERNAL_TOKEN 写到客户端：

```bash
[ -f .env.local ] || touch .env.local
```

编辑 `.env.local`：

```
VITE_INTERNAL_TOKEN=...same-as-workers-internal-token...
```

注：`.env.local` 是 gitignore（已在 .gitignore）。

- [ ] **Step 5: 启动 wrangler dev（local 模式）**

```bash
pnpm exec wrangler dev --config workers/wrangler.toml --local --persist-to .wrangler-state
```

Expected: 控制台显示 `Ready on http://localhost:8787`。**保持运行**，下面 step 在另一个 shell 跑 curl。

如果 wrangler 报 `database_id` 错误 → 跑 `pnpm exec wrangler d1 create learning-project --location wnam`，把 UUID 填回 wrangler.toml 后重启。

- [ ] **Step 6: smoke 401 path（auth 生效）**

新 shell 跑：

```bash
curl -i http://localhost:8787/api/health
```

Expected:
```
HTTP/1.1 401 Unauthorized
{"error":"unauthorized"}
```

- [ ] **Step 7: smoke 200 path（auth + DB）**

```bash
TOKEN=$(grep INTERNAL_TOKEN workers/.dev.vars | cut -d= -f2)
curl -i -H "x-internal-token: $TOKEN" http://localhost:8787/api/health
```

Expected:
```
HTTP/1.1 200 OK
{"ok":true,"db_ok":true}
```

如果 `db_ok: false` → 检查 wrangler 是否在 `--local` 模式下创建了 mock D1；`--persist-to` 路径下应有 `v3/d1/...` 目录。

- [ ] **Step 8: 关掉 wrangler dev**

切回 wrangler shell 按 Ctrl+C。

- [ ] **Step 9: 提交**

```bash
git add workers/src/db.ts workers/src/index.ts
git commit -m "feat(worker): D1 driver + auth + /api/health smoke (改进 1/2)"
```

---

### Task 10: 客户端 AI 调用加 INTERNAL_TOKEN header（改进 2 client side）

**Goal:** 让 `src/ai/client.ts` 在 fetch 时塞 `x-internal-token`，token 从 `import.meta.env.VITE_INTERNAL_TOKEN` 读。

**Files:**
- 修改：`src/ai/client.ts`
- 修改：`src/vite-env.d.ts`

- [ ] **Step 1: 读 vite-env.d.ts 当前内容**

```bash
cat src/vite-env.d.ts
```

Expected: 一行 `/// <reference types="vite/client" />`。

- [ ] **Step 2: 改 vite-env.d.ts 加 ImportMetaEnv 字段**

替换 `src/vite-env.d.ts` 全文：

```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_INTERNAL_TOKEN?: string;
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

- [ ] **Step 3: 改 src/ai/client.ts**

替换 `src/ai/client.ts` 全文：

```ts
// 浏览器侧 AI 调用入口。
// 所有调用都走 /api/ai/<task>，Cloudflare Workers 持有 ANTHROPIC_API_KEY。
// 浏览器代码绝不直接拿 API key。

const INTERNAL_TOKEN = import.meta.env.VITE_INTERNAL_TOKEN ?? '';

export async function runTask<TInput, TOutput = unknown>(
  taskKind: string,
  input: TInput,
  signal?: AbortSignal,
): Promise<TOutput> {
  const res = await fetch(`/api/ai/${taskKind}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-token': INTERNAL_TOKEN,
    },
    body: JSON.stringify({ input }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Task ${taskKind} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as TOutput;
}
```

- [ ] **Step 4: typecheck**

```bash
pnpm typecheck
```

Expected: 无 error。

- [ ] **Step 5: 提交**

```bash
git add src/ai/client.ts src/vite-env.d.ts
git commit -m "feat(client): add internal token header in AI client (改进 2)"
```

---

### Task 11: drizzle-kit 生成初始 migration

**Goal:** 让 D1 schema 可一键 apply，配合 `wrangler d1 migrations` workflow。

**Files:**
- 创建：`drizzle/0000_initial.sql` + `drizzle/meta/...`（drizzle-kit 自动产生）

- [ ] **Step 1: 跑 drizzle-kit generate**

```bash
pnpm db:generate
```

Expected: `drizzle/` 目录下生成 `0000_<random>.sql` + `meta/_journal.json` + `meta/0000_snapshot.json`。

- [ ] **Step 2: 验证 SQL 完整**

```bash
ls drizzle/
head -80 drizzle/0000_*.sql
```

Expected: 看到 `CREATE TABLE \`knowledge\` ...`、`CREATE TABLE \`question\` ...`、`CREATE TABLE \`mistake\` ...` 等约 12 张表的 DDL。

- [ ] **Step 3: 提交**

```bash
git add drizzle/
git commit -m "chore(db): generate initial drizzle migration"
```

注：实际 apply 到真 D1 的步骤（用户操作，不在自动化范围）：

```bash
# 1) 创建真实 D1 数据库（如果还没有）
pnpm exec wrangler d1 create learning-project

# 2) 把返回的 UUID 填回 workers/wrangler.toml 的 database_id

# 3) Apply migration 到 production D1
pnpm exec wrangler d1 migrations apply DB --remote

# 4) Apply migration 到 local mock D1（dev）
pnpm exec wrangler d1 migrations apply DB --local
```

---

### Task 12: 文档改动（改进 1 doc）

**Goal:** 把 `architecture.md § 六 技术栈` 和 `README.md` 的"本地存储"行同步成 D1 远程优先。

**Files:**
- 修改：`docs/architecture.md`
- 修改：`README.md`

- [ ] **Step 1: 定位 architecture.md 的本地存储行**

```bash
grep -n "本地存储\|sqlite-wasm\|OPFS\|D1\|R2" docs/architecture.md | head -20
```

记录关键行号（约在 § 六 技术栈表中）。

- [ ] **Step 2: 修改 architecture.md § 六 技术栈表**

把这一行：

```
| 本地存储 | SQLite（Tauri 原生集成） | 错题/进度天然适合关系型 |
```

替换为：

```
| 数据存储 | Phase 1 = D1 远程；Phase 1.5 起 R2 存图片；Phase 4 = D1 + PWA cache 离线层；Phase 3 Tauri 端 = better-sqlite3 镜像 | 自用初期"能用"远比"离线"重要，避免 sqlite-wasm 集成的 1-2 周硬骨头 |
```

把这一行（如果存在）：

```
| 云同步 | Cloudflare D1 + R2 | 已有账号 |
```

替换为（合并到上面一行，或保留单独一行说"云同步走同一个 D1 + R2"）：

```
| 云同步 | 与上同源（D1 + R2）；Phase 4 加 PWA cache 离线层 | 自用规模够，已有账号 |
```

如果"反模式"段有 sqlite-wasm 相关（搜 `OPFS-backed` / `sqlite.org/sqlite-wasm`），删除或改写到当前路线。

- [ ] **Step 3: 修改 README.md 技术栈表**

定位：

```bash
grep -n "本地存储\|sqlite-wasm\|OPFS\|D1" README.md
```

把这一行：

```
| 本地存储 | OPFS-backed `@sqlite.org/sqlite-wasm`（Phase 1）→ better-sqlite3 via Tauri（Phase 3） |
```

替换为：

```
| 数据存储 | Cloudflare D1（Phase 1 远程优先；Phase 1.5 起 R2 存图片；Phase 4 加 PWA cache；Phase 3 Tauri 端 better-sqlite3 镜像） |
```

- [ ] **Step 4: 验证无残留旧描述**

```bash
grep -rn "sqlite-wasm\|OPFS-backed" docs/ README.md
```

Expected: 无结果。如果命中，按上下文再改一处。

- [ ] **Step 5: 提交**

```bash
git add docs/architecture.md README.md
git commit -m "docs: 数据存储路线 → D1 远程优先 (改进 1)"
```

---

## PR 1 完成验收

回到 spec 改进 1/2/4/5/10/11(占位)/12(占位)/13 的 Done 标志，逐条验证：

- [ ] **改进 5（进库）** — `git log --oneline | head -15` 看到 baseline + 11 个改进 commit
- [ ] **改进 13（AI SDK）** — `pnpm list ai @ai-sdk/anthropic` 显示主线版本（不再 1.x）
- [ ] **改进 4（drizzle-zod）** — `pnpm test` 全部通过；`grep -l "createInsertSchema" src/core/schema/` 命中 generated.ts；`grep -l "z.enum" src/core/schema/` 命中 business.ts；旧 `src/core/schema.ts` 不再存在
- [ ] **改进 10（subjects/wenyan）** — `ls src/subjects/wenyan/` 看到 4 个文件；`grep -rn "from '@/subjects'" src/core/ src/ai/` 无结果（core/ 不依赖 subjects/）
- [ ] **改进 2（worker auth）** — Task 9 step 6/7 已 smoke 401 / 200 path
- [ ] **改进 1（D1）** — Task 9 step 7 `db_ok: true`（local mock 即可）；架构 doc 已更新
- [ ] **改进 11 占位** — `grep "r2_buckets" workers/wrangler.toml` 命中
- [ ] **改进 12 占位** — `grep "crons\|queues" workers/wrangler.toml` 命中（注释也算）

如果任何一项不通过 → 回到对应 Task，按 step 重跑。

---

## Troubleshooting

**Q: drizzle-zod 跟 drizzle-orm 0.36 不兼容**

A: 跑 `pnpm view drizzle-zod peerDependencies`，确认 peer range 含 0.36。如果不含，按提示升级 drizzle-orm 或降低 drizzle-zod 版本。

**Q: vitest 在 workers/ 下找不到测试**

A: 检查 `vitest.config.ts` 的 `include` glob 是否含 `workers/src/**/*.test.ts`。

**Q: wrangler dev 报 `database_id` 必须是 UUID**

A: 跑 `pnpm exec wrangler d1 create learning-project`，把返回的 UUID 填回 `workers/wrangler.toml`。

**Q: `app.request()` 在 Hono 测试里返回 404**

A: 确认 `app.use('/api/*', internalAuth)` 在 `app.get('/api/ping', ...)` **之前**注册（middleware 顺序）。

**Q: typecheck 在 workers/src/index.ts 报 `D1Database` 找不到**

A: 检查 `@cloudflare/workers-types` 是否在 `workers/tsconfig.json` 的 `types` 里（应该已经在）。

---

## Open Questions（实施时遇到再决）

- D1 production database id：用户在 Cloudflare 建好后填回 `wrangler.toml`
- INTERNAL_TOKEN 生成与同步：建议 `openssl rand -hex 32` 一次生成，client `.env.local` + worker `.dev.vars` 各放一份；部署用 `wrangler secret put INTERNAL_TOKEN`
- drizzle-zod 在 nullable / json 列上的具体行为：Task 6 实施时 verify；如果 generated schema 把 nullable 字段标错，逐字段 `.extend()` 收紧
- vitest 是否需要拆 src 与 workers 两个 workspace：本 plan 用单 vitest config 统一 include，未来负载大再拆
- AI SDK 是 4.x 还是 5.x：Task 2 step 1 决定；如果 5.x 太新，可降到 4.x LTS
