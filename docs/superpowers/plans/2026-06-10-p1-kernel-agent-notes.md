# 架构重设计 P1：内核立柱 + agent-notes 打样首包 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 立起 `src/kernel/`（manifest 类型 + 静态组合根 + events/http 薄 facade）与按文件名自动分区的新测试约定，并把 agent-notes 整体迁为第一个 capability 包，行为完全等价。

**Architecture:** spec = `docs/superpowers/specs/2026-06-10-architecture-redesign-design.md` §2.1/§2.2/§4-P1。P1 只立打样包实际行使的契约（manifest/组合、事件 facade、http facade）；投影/提议/能动/AI 运行时四契约**不写代码**，在 ARCHITECTURE.md 登记为 P2+ 槽位（第二实例原则——这本身就是「契约是否过度」体检的第一个执行结果）。agent-notes 零自有表（骑乘 event 表），是验证「包形状 + 事件契约 + 外壳挂载 + 测试约定」的最小完整样本。

**Tech Stack:** Next.js 15 App Router（外壳）、Drizzle/Postgres、Vitest（unit/db 双分区）、Biome。

**Linear:** YUK-311。分支：`yuk-311-p1-kernel-agent-notes`。Commit 消息含 `YUK-311`，最后一个 commit 用 `Closes YUK-311`。

**环境前置（执行开始前核对）：**
- 在主仓 `/Users/yukoval/yukoval-projects/the-learning-project` 切分支执行（推荐）。若在 fresh worktree 执行：先 `pnpm install`，再把主仓 `.env.local` 复制过来（DB 测试与 build 需要），参见项目记忆「worktree 需 .env token / build 需 DATABASE_URL」。
- Docker 运行中（db 分区测试用 testcontainer）。
- `git status` 干净区域确认：本计划只触碰下列文件，工作区里已有的无关未跟踪文件（docs/、png 等）**不要**加进任何 commit。

**Out of scope（明确不做）：** globals.css 样式归属不动；旧 vitest allowlist/audit:partition 不删（P6）；不动任何应然功能逻辑（流/卷架是 P2）；不建 proposal/projection/agency/AI-runtime 代码。

---

## 文件地图（全部改动一览）

**创建：**
- `src/kernel/manifest.ts` + `src/kernel/manifest.unit.test.ts`
- `src/kernel/events.ts`、`src/kernel/http.ts`、`src/kernel/index.ts`、`src/kernel/CONTEXT.md`
- `src/capabilities/index.ts`（组合根）+ `src/capabilities/composition.unit.test.ts`
- `src/capabilities/agent-notes/manifest.ts`、`src/capabilities/agent-notes/CONTEXT.md`
- `src/capabilities/agent-notes/api/notes.ts`
- `ARCHITECTURE.md`（仓库根）

**移动（git mv，保历史）：**
- `src/server/agents/notes.ts` → `src/capabilities/agent-notes/server/notes.ts`
- `src/server/agents/notes.test.ts` → `src/capabilities/agent-notes/server/notes.db.test.ts`
- `app/api/agents/notes/route.test.ts` → `src/capabilities/agent-notes/api/notes.db.test.ts`
- `src/ui/agent-notes/`（整目录 8 文件）→ `src/capabilities/agent-notes/ui/`（其中 `derive.test.ts`→`derive.unit.test.ts`、`meta.test.ts`→`meta.unit.test.ts`）
- `app/(app)/agent-notes/page.tsx` 的实现体 → `src/capabilities/agent-notes/ui/page.tsx`

**修改：**
- `vitest.shared.ts`（fastTestInclude 头部加 2 个约定 glob）
- `app/api/agents/notes/route.ts`（壳化）、`app/(app)/agent-notes/page.tsx`（壳化）
- import 更新 5 处：`src/server/knowledge/review.ts`、`src/server/boss/handlers/quiz_verify.ts`、`src/server/boss/handlers/dreaming_nightly.ts`、`src/server/boss/handlers/coach_daily.ts`、`app/(app)/today/page.tsx`

---

### Task 1: 分支 + 测试约定接线

**Files:**
- Modify: `vitest.shared.ts:45-46`

- [ ] **Step 1: 切分支**

```bash
git checkout -b yuk-311-p1-kernel-agent-notes
```

- [ ] **Step 2: fastTestInclude 头部加约定 glob**

`vitest.shared.ts` 中找到：

```ts
export const fastTestInclude = [
  'middleware.test.ts',
```

改为：

```ts
export const fastTestInclude = [
  // ARCH-P1 (YUK-311) — 新 kernel/capabilities 树的约定式快分区：
  // *.unit.test.ts 按【命名约定】跑 no-DB 车道，零逐文件登记；*.db.test.ts
  // 落到 db 分区（匹配 allTestInclude 的 src/**/*.test.ts，又被下面这两个
  // glob 排除出 fast）。audit:partition 的 P0 检查照常生效：约定树里
  // *.unit.test.ts 若未 mock 就 import DB，审计直接报错。
  'src/kernel/**/*.unit.test.ts',
  'src/capabilities/**/*.unit.test.ts',
  'middleware.test.ts',
```

- [ ] **Step 3: 验证现状无回归（glob 当前匹配 0 文件，行为不变）**

```bash
pnpm test:unit 2>&1 | tail -5
pnpm audit:partition 2>&1 | tail -5
```

Expected: 两者都 PASS，数字与改动前一致（新 glob 还没有匹配文件）。

- [ ] **Step 4: Commit**

```bash
git add vitest.shared.ts
git commit -m "test(arch): convention-based unit/db partition globs for kernel+capabilities tree (YUK-311)"
```

---

### Task 2: kernel manifest（TDD）

**Files:**
- Create: `src/kernel/manifest.unit.test.ts`
- Create: `src/kernel/manifest.ts`

- [ ] **Step 1: 写失败测试** — 创建 `src/kernel/manifest.unit.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { type CapabilityManifest, defineCapability, validateComposition } from './manifest';

const base = (over: Partial<CapabilityManifest> & { name: string }): CapabilityManifest =>
  defineCapability({ description: 'test capability', ...over });

describe('validateComposition', () => {
  it('accepts unique names, actions and routes', () => {
    expect(() =>
      validateComposition([
        base({
          name: 'a',
          events: { actions: ['experimental:x'] },
          api: { routes: [{ method: 'GET', path: '/api/a' }] },
        }),
        base({
          name: 'b',
          events: { actions: ['experimental:y'] },
          api: { routes: [{ method: 'GET', path: '/api/b' }] },
        }),
      ]),
    ).not.toThrow();
  });

  it('rejects duplicate capability names', () => {
    expect(() => validateComposition([base({ name: 'a' }), base({ name: 'a' })])).toThrow(
      /duplicate capability name/,
    );
  });

  it('rejects one event action declared by two capabilities', () => {
    expect(() =>
      validateComposition([
        base({ name: 'a', events: { actions: ['experimental:x'] } }),
        base({ name: 'b', events: { actions: ['experimental:x'] } }),
      ]),
    ).toThrow(/declared by both 'a' and 'b'/);
  });

  it('rejects one method+path declared by two capabilities', () => {
    expect(() =>
      validateComposition([
        base({ name: 'a', api: { routes: [{ method: 'GET', path: '/api/x' }] } }),
        base({ name: 'b', api: { routes: [{ method: 'GET', path: '/api/x' }] } }),
      ]),
    ).toThrow(/declared by both 'a' and 'b'/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run --config vitest.unit.config.ts src/kernel/manifest.unit.test.ts
```

Expected: FAIL — `Cannot find module './manifest'`（或等价的解析错误）。

- [ ] **Step 3: 实现** — 创建 `src/kernel/manifest.ts`：

```ts
// 内核契约「manifest/组合」（spec §2.1/§2.2，YUK-311 P1）。
// P1 字段只覆盖打样包实际行使的面（events/api/ui 声明元数据）；tasks/
// proposals/jobs/projections 等字段在第一个需要它们的包迁入时再加（第二
// 实例原则，spec 反框架护栏）。manifest 是声明元数据 + 组合期校验，不是
// 运行时插件总线；组合根见 src/capabilities/index.ts（静态、类型检查）。

export interface ApiRouteDecl {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string; // 形如 '/api/agents/notes'
}

export interface UiPageDecl {
  route: string; // 形如 '/agent-notes'
}

export interface CapabilityManifest {
  name: string;
  description: string;
  /** 本包拥有/骑乘的 event actions（组合期查跨包重复声明） */
  events?: { actions: string[] };
  /** 本包的 API 面归属元数据（真实 route 文件由外壳挂载） */
  api?: { routes: ApiRouteDecl[] };
  /** 本包的 UI 面：页面路由 + today/工作台贡献块标识 */
  ui?: { pages?: UiPageDecl[]; todayBlocks?: string[] };
}

/** identity helper — 只为类型推断与调用点可读性。 */
export function defineCapability(manifest: CapabilityManifest): CapabilityManifest {
  return manifest;
}

/** 组合期校验：包名、event action、API 路由声明全局唯一，冲突即抛错。 */
export function validateComposition(capabilities: CapabilityManifest[]): void {
  const names = new Set<string>();
  for (const cap of capabilities) {
    if (names.has(cap.name)) throw new Error(`duplicate capability name: ${cap.name}`);
    names.add(cap.name);
  }
  const actionOwner = new Map<string, string>();
  for (const cap of capabilities) {
    for (const action of cap.events?.actions ?? []) {
      const owner = actionOwner.get(action);
      if (owner !== undefined) {
        throw new Error(`event action '${action}' declared by both '${owner}' and '${cap.name}'`);
      }
      actionOwner.set(action, cap.name);
    }
  }
  const routeOwner = new Map<string, string>();
  for (const cap of capabilities) {
    for (const route of cap.api?.routes ?? []) {
      const key = `${route.method} ${route.path}`;
      const owner = routeOwner.get(key);
      if (owner !== undefined) {
        throw new Error(`api route '${key}' declared by both '${owner}' and '${cap.name}'`);
      }
      routeOwner.set(key, cap.name);
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm vitest run --config vitest.unit.config.ts src/kernel/manifest.unit.test.ts
```

Expected: PASS（4 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/kernel/manifest.ts src/kernel/manifest.unit.test.ts
git commit -m "feat(kernel): capability manifest types + composition validation (YUK-311)"
```

---

### Task 3: kernel facades + 组合根（TDD）

**Files:**
- Create: `src/kernel/events.ts`、`src/kernel/http.ts`、`src/kernel/index.ts`、`src/kernel/CONTEXT.md`
- Create: `src/capabilities/index.ts`、`src/capabilities/composition.unit.test.ts`

- [ ] **Step 1: 写失败测试** — 创建 `src/capabilities/composition.unit.test.ts`：

```ts
import { validateComposition } from '@/kernel/manifest';
import { describe, expect, it } from 'vitest';
import { capabilities } from './index';

describe('composition root', () => {
  it('passes composition validation', () => {
    expect(() => validateComposition(capabilities)).not.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run --config vitest.unit.config.ts src/capabilities/composition.unit.test.ts
```

Expected: FAIL — `Cannot find module './index'`。

- [ ] **Step 3: 创建组合根** — `src/capabilities/index.ts`：

```ts
// 静态组合根 —— 架构重设计的「迁移进度表」（spec §2.1，YUK-311）。
// 每迁入一个 capability 包就在此登记一行；composition.unit.test.ts 跑
// validateComposition 保证包名 / event action / 路由声明全局无冲突。
// 反框架护栏：静态数组、类型检查、无动态加载。
import type { CapabilityManifest } from '@/kernel/manifest';

export const capabilities: CapabilityManifest[] = [];
```

- [ ] **Step 4: 创建 facades** — `src/kernel/events.ts`：

```ts
// 内核契约「事件存储」facade（P1 薄壳，YUK-311）。
// 包装遗留单一写入口 writeEvent（ADR-0005 single-owner）。capability 包只许
// import '@/kernel/events'；底层模块在事件契约完整立起时（P2+）迁入内核本体。
export { writeEvent as emitEvent } from '@/server/events/queries';
export type { EventT } from '@/core/schema/event';
```

`src/kernel/http.ts`：

```ts
// 内核 http 错误整形 facade（P1 薄壳，YUK-311）— 包装遗留 @/server/http/errors，
// capability 包的 API handler 统一从这里取 ApiError/errorResponse。
export { ApiError, errorResponse } from '@/server/http/errors';
```

`src/kernel/index.ts`：

```ts
export * from './events';
export * from './http';
export * from './manifest';
```

- [ ] **Step 5: 写 kernel CONTEXT.md** — `src/kernel/CONTEXT.md`：

```md
# kernel — 内核（P1，YUK-311）

只承载产品不变量的六契约（spec §2.1）。P1 已立：manifest/组合校验（manifest.ts）、
事件 facade（events.ts）、http facade（http.ts）。投影 / 提议生命周期 / 能动性策略 /
AI 运行时四契约 P2+ 按第二实例原则立——槽位登记在根部 ARCHITECTURE.md。

反框架护栏（spec 红线）：契约封顶 6、静态组合根（src/capabilities/index.ts）、
无动态加载、单使用方的钩子降级回包。新增字段/钩子前先问：第二个使用方在哪？
```

- [ ] **Step 6: 跑测试确认通过 + typecheck**

```bash
pnpm vitest run --config vitest.unit.config.ts src/capabilities/composition.unit.test.ts
pnpm typecheck
```

Expected: 两者 PASS。

- [ ] **Step 7: Commit**

```bash
git add src/kernel src/capabilities
git commit -m "feat(kernel): events/http facades + static composition root (YUK-311)"
```

---

### Task 4: agent-notes server 模块迁移（测试先行）

**Files:**
- Move: `src/server/agents/notes.test.ts` → `src/capabilities/agent-notes/server/notes.db.test.ts`
- Move: `src/server/agents/notes.ts` → `src/capabilities/agent-notes/server/notes.ts`
- Modify: `src/server/knowledge/review.ts:28`、`src/server/boss/handlers/quiz_verify.ts:47`、`src/server/boss/handlers/dreaming_nightly.ts:5`、`src/server/boss/handlers/coach_daily.ts:16`、`app/api/agents/notes/route.ts:8`

- [ ] **Step 1: 先迁测试（战伤保全规则：测试是等价性的 spec）**

```bash
mkdir -p src/capabilities/agent-notes/server
git mv src/server/agents/notes.test.ts src/capabilities/agent-notes/server/notes.db.test.ts
```

编辑 `src/capabilities/agent-notes/server/notes.db.test.ts`，把 helpers 相对路径加深一级：

```ts
// 旧（第 15 行）：
import { resetDb, testDb } from '../../../tests/helpers/db';
// 新：
import { resetDb, testDb } from '../../../../tests/helpers/db';
```

（`import ... from './notes'` 一行不动。）

- [ ] **Step 2: 跑测试确认失败（红）**

```bash
pnpm vitest run --config vitest.db.config.ts src/capabilities/agent-notes/server/notes.db.test.ts
```

Expected: FAIL — 无法解析 `./notes`（实现还没搬过来）。

- [ ] **Step 3: 迁实现 + 换内核 facade**

```bash
git mv src/server/agents/notes.ts src/capabilities/agent-notes/server/notes.ts
rmdir src/server/agents
```

编辑 `src/capabilities/agent-notes/server/notes.ts`：

```ts
// 旧（第 36 行）：
import { writeEvent } from '@/server/events/queries';
// 新：
import { emitEvent } from '@/kernel/events';
```

调用点（writeAgentNote 函数体内）：

```ts
// 旧：
  await writeEvent(db, {
// 新：
  await emitEvent(db, {
```

- [ ] **Step 4: 更新全部 5 个 import 站点**（旧字符串 → 新字符串，逐文件）：

```ts
// src/server/knowledge/review.ts:28
import { readAgentNotes } from '@/server/agents/notes';
// →
import { readAgentNotes } from '@/capabilities/agent-notes/server/notes';

// src/server/boss/handlers/quiz_verify.ts:47
import { writeAgentNote } from '@/server/agents/notes';
// →
import { writeAgentNote } from '@/capabilities/agent-notes/server/notes';

// src/server/boss/handlers/dreaming_nightly.ts:5
import { type AgentNote, readAgentNotes } from '@/server/agents/notes';
// →
import { type AgentNote, readAgentNotes } from '@/capabilities/agent-notes/server/notes';

// src/server/boss/handlers/coach_daily.ts:16
import { type AgentNote, readAgentNotes } from '@/server/agents/notes';
// →
import { type AgentNote, readAgentNotes } from '@/capabilities/agent-notes/server/notes';

// app/api/agents/notes/route.ts:8
import { readAllAgentNotes } from '@/server/agents/notes';
// →
import { readAllAgentNotes } from '@/capabilities/agent-notes/server/notes';
```

- [ ] **Step 5: 绿 + 全局核验**

```bash
pnpm vitest run --config vitest.db.config.ts src/capabilities/agent-notes/server/notes.db.test.ts
pnpm typecheck
grep -rn "@/server/agents/notes" src app --include='*.ts' --include='*.tsx'
```

Expected: 测试 PASS（与迁移前同数）；typecheck PASS；grep **零输出**。

- [ ] **Step 6: Biome + Commit**

```bash
pnpm biome check --write src/capabilities/agent-notes/server src/server/knowledge/review.ts src/server/boss/handlers/quiz_verify.ts src/server/boss/handlers/dreaming_nightly.ts src/server/boss/handlers/coach_daily.ts app/api/agents/notes/route.ts
git add -A src/capabilities/agent-notes src/server app/api/agents/notes
git commit -m "refactor(agent-notes): move server module into capability package, ride kernel events facade (YUK-311)"
```

---

### Task 5: agent-notes API 迁移（测试先行）

**Files:**
- Move: `app/api/agents/notes/route.test.ts` → `src/capabilities/agent-notes/api/notes.db.test.ts`
- Create: `src/capabilities/agent-notes/api/notes.ts`
- Modify: `app/api/agents/notes/route.ts`（壳化）

- [ ] **Step 1: 先迁测试**

```bash
mkdir -p src/capabilities/agent-notes/api
git mv app/api/agents/notes/route.test.ts src/capabilities/agent-notes/api/notes.db.test.ts
```

编辑 `src/capabilities/agent-notes/api/notes.db.test.ts` 头部 import：

```ts
// 旧：
import { writeAgentNote } from '@/server/agents/notes';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './route';
// 新：
import { writeAgentNote } from '../server/notes';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './notes';
```

（注意：`tests/helpers/db` 的相对深度恰好不变——原文件在 `app/api/agents/notes/` 也是 4 层。）

- [ ] **Step 2: 红**

```bash
pnpm vitest run --config vitest.db.config.ts src/capabilities/agent-notes/api/notes.db.test.ts
```

Expected: FAIL — 无法解析 `./notes`。

- [ ] **Step 3: 创建 handler 本体** — `src/capabilities/agent-notes/api/notes.ts`：

```ts
// GET /api/agents/notes — 「AI 观察」只读 feed 的 handler 本体（YUK-311 P1 迁入包）。
// 外壳 app/api/agents/notes/route.ts 仅 re-export；行为与迁移前完全等价
//（原 app/api/agents/notes/route.ts @ YUK-294）。

import { z } from 'zod';

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { readAllAgentNotes } from '../server/notes';

const QuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse({
      limit: url.searchParams.get('limit') ?? undefined,
    });
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const rows = await readAllAgentNotes(db, { now: new Date(), limit: parsed.data.limit });
    return Response.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}
```

- [ ] **Step 4: 壳化 route** — `app/api/agents/notes/route.ts` 整文件替换为：

```ts
// 外壳挂载 — handler 本体在 agent-notes capability 包（架构重设计 P1 打样，YUK-311）。
export const runtime = 'nodejs';
export { GET } from '@/capabilities/agent-notes/api/notes';
```

- [ ] **Step 5: 绿**

```bash
pnpm vitest run --config vitest.db.config.ts src/capabilities/agent-notes/api/notes.db.test.ts
pnpm typecheck
```

Expected: 两者 PASS。

- [ ] **Step 6: Commit**

```bash
pnpm biome check --write src/capabilities/agent-notes/api app/api/agents/notes/route.ts
git add -A src/capabilities/agent-notes/api app/api/agents/notes
git commit -m "refactor(agent-notes): move GET handler into capability, shell-mount the route (YUK-311)"
```

---

### Task 6: agent-notes UI 迁移

**Files:**
- Move: `src/ui/agent-notes/` 整目录 → `src/capabilities/agent-notes/ui/`（两个测试文件改名）
- Move: `app/(app)/agent-notes/page.tsx` 实现体 → `src/capabilities/agent-notes/ui/page.tsx`
- Modify: `app/(app)/today/page.tsx:4-5`

- [ ] **Step 1: 整目录平移 + 测试改名**

```bash
git mv src/ui/agent-notes src/capabilities/agent-notes/ui
git mv src/capabilities/agent-notes/ui/derive.test.ts src/capabilities/agent-notes/ui/derive.unit.test.ts
git mv src/capabilities/agent-notes/ui/meta.test.ts src/capabilities/agent-notes/ui/meta.unit.test.ts
```

（目录内部全是 `./` 相对 import 和 `@/ui/primitives`/`@/ui/lib` 共享件 import，平移后无需改动——已核对。）

- [ ] **Step 2: 页面实现体迁入包**

```bash
git mv "app/(app)/agent-notes/page.tsx" src/capabilities/agent-notes/ui/page.tsx
```

编辑 `src/capabilities/agent-notes/ui/page.tsx`，把 5 行包内 import 改为相对路径（其余 import 与正文不动，`'use client'` 保留在此文件）：

```ts
// 旧：
import { AgentNoteCard } from '@/ui/agent-notes/AgentNoteCard';
import { dayGroupOf } from '@/ui/agent-notes/derive';
import { SIGNAL_META, signalMeta } from '@/ui/agent-notes/meta';
import type { AgentNotesResponse, BoardAgentNote } from '@/ui/agent-notes/types';
import { useAgentReads } from '@/ui/agent-notes/useAgentReads';
// 新：
import { AgentNoteCard } from './AgentNoteCard';
import { dayGroupOf } from './derive';
import { SIGNAL_META, signalMeta } from './meta';
import type { AgentNotesResponse, BoardAgentNote } from './types';
import { useAgentReads } from './useAgentReads';
```

- [ ] **Step 3: 壳化 app 页面** — 新建 `app/(app)/agent-notes/page.tsx`：

```tsx
// 外壳挂载 — 页面本体在 agent-notes capability 包（架构重设计 P1 打样，YUK-311）。
export { default } from '@/capabilities/agent-notes/ui/page';
```

- [ ] **Step 4: 更新 today 页 import** — `app/(app)/today/page.tsx` 第 4-5 行：

```ts
// 旧：
import { AgentNotesBoard } from '@/ui/agent-notes/AgentNotesBoard';
import type { AgentNotesResponse } from '@/ui/agent-notes/types';
// 新：
import { AgentNotesBoard } from '@/capabilities/agent-notes/ui/AgentNotesBoard';
import type { AgentNotesResponse } from '@/capabilities/agent-notes/ui/types';
```

- [ ] **Step 5: 验证**

```bash
pnpm vitest run --config vitest.unit.config.ts src/capabilities/agent-notes/ui/derive.unit.test.ts src/capabilities/agent-notes/ui/meta.unit.test.ts
pnpm typecheck
grep -rn "@/ui/agent-notes" src app --include='*.ts' --include='*.tsx'
```

Expected: 两个 unit 测试 PASS（通过**新约定 glob** 被快车道收集——这就是约定分区的实证）；typecheck PASS；grep **零输出**。

- [ ] **Step 6: Commit**

```bash
pnpm biome check --write src/capabilities/agent-notes/ui "app/(app)/agent-notes" "app/(app)/today/page.tsx"
git add -A src/capabilities/agent-notes/ui "app/(app)/agent-notes" "app/(app)/today/page.tsx"
git commit -m "refactor(agent-notes): move UI into capability package, shell-mount the page (YUK-311)"
```

---

### Task 7: manifest 挂接 + 文档

**Files:**
- Create: `src/capabilities/agent-notes/manifest.ts`、`src/capabilities/agent-notes/CONTEXT.md`、`ARCHITECTURE.md`
- Modify: `src/capabilities/index.ts`、`src/capabilities/composition.unit.test.ts`

- [ ] **Step 1: 测试先行** — `src/capabilities/composition.unit.test.ts` 的 describe 块内追加：

```ts
  it('includes the agent-notes pilot capability', () => {
    expect(capabilities.map((c) => c.name)).toContain('agent-notes');
  });
```

```bash
pnpm vitest run --config vitest.unit.config.ts src/capabilities/composition.unit.test.ts
```

Expected: FAIL — `expected [] to contain 'agent-notes'`。

- [ ] **Step 2: 写 manifest** — `src/capabilities/agent-notes/manifest.ts`：

```ts
import { defineCapability } from '@/kernel/manifest';

export const agentNotesCapability = defineCapability({
  name: 'agent-notes',
  description:
    'AI 内部协调信道：小 task 给 dreaming/maintenance/coach 留观察信号（hints not facts）；用户侧只读观察窗。',
  events: { actions: ['experimental:agent_note'] },
  api: { routes: [{ method: 'GET', path: '/api/agents/notes' }] },
  ui: { pages: [{ route: '/agent-notes' }], todayBlocks: ['agent-notes-board'] },
});
```

- [ ] **Step 3: 登记组合根** — `src/capabilities/index.ts`：

```ts
// 静态组合根 —— 架构重设计的「迁移进度表」（spec §2.1，YUK-311）。
// 每迁入一个 capability 包就在此登记一行；composition.unit.test.ts 跑
// validateComposition 保证包名 / event action / 路由声明全局无冲突。
// 反框架护栏：静态数组、类型检查、无动态加载。
import type { CapabilityManifest } from '@/kernel/manifest';
import { agentNotesCapability } from './agent-notes/manifest';

export const capabilities: CapabilityManifest[] = [agentNotesCapability];
```

- [ ] **Step 4: 绿**

```bash
pnpm vitest run --config vitest.unit.config.ts src/capabilities/composition.unit.test.ts
```

Expected: PASS（2 tests）。

- [ ] **Step 5: 包一页纸** — `src/capabilities/agent-notes/CONTEXT.md`：

```md
# agent-notes — AI 内部协调信道（P1 打样首包，YUK-311）

小 task（quiz_verify 等）给三个定时大 agent（dreaming/maintenance/coach）留观察信号；
hints not facts，带 provenance + expires_at。存储零新表：骑乘
event(action='experimental:agent_note')（U0 D10 / AF §4）。用户面只有只读观察窗
（/agent-notes 页 + today 块）。应然定位 = spec D7：幕后基础设施；观察窗去留是
菜单 ⚖️ 行（P4 关口裁决）。

- server/notes.ts — writeAgentNote / readAgentNotes / readAllAgentNotes
- api/notes.ts — GET /api/agents/notes（外壳 app/api/agents/notes/route.ts 挂载）
- ui/ — 看板/卡片/derive/meta/已读态/页面（外壳 app/(app)/agent-notes/page.tsx 挂载；
  today 页直接 import AgentNotesBoard）
- 包外读写方：写 = src/server/boss/handlers/quiz_verify.ts；
  读 = dreaming_nightly / coach_daily / src/server/knowledge/review.ts
```

- [ ] **Step 6: 根部架构图** — 仓库根创建 `ARCHITECTURE.md`：

```md
# ARCHITECTURE — 装进脑子的那张图

> 架构重设计进行中（spec：docs/superpowers/specs/2026-06-10-architecture-redesign-design.md）。
> 本文件 + `src/capabilities/index.ts`（组合根 = 迁移进度表）是新形状的导航起点；
> 未迁部分仍按 CLAUDE.md「Layering」一节阅读。

## 内核（src/kernel/）— 六契约

| 契约 | 状态 | 位置 |
|---|---|---|
| manifest/组合 | ✅ P1 | src/kernel/manifest.ts + src/capabilities/index.ts |
| 事件存储 | ✅ P1 薄 facade（包装 writeEvent） | src/kernel/events.ts |
| 投影引擎 | ⏳ P2（practice 首用时立） | — |
| 提议生命周期 | ⏳ P2（首批 applier 迁入时立） | — |
| 能动性策略层 | ⏳ P2+ | — |
| AI 运行时 | ⏳ P2+（现 src/server/ai/runner.ts） | — |

（http.ts 是公共件不是契约。）

## capability 包（src/capabilities/）

| 包 | 状态 |
|---|---|
| agent-notes | ✅ P1 打样已迁（CONTEXT.md 在包内） |
| ingestion / practice / knowledge / notes / quiz / agency / copilot / subjects / memory / observability / shell | ⏳ 见 spec §2.3 与 §4 分期 |

## 规则（spec §2.2）

1. 包只依赖 `@/kernel/*` + 自身 + 共享 UI 件（`@/ui/primitives`、`@/ui/lib`）；包间走 manifest 公共接口，禁深层 import。
2. 事实经事件，查询经接口。
3. 横切面（today/工作台块、Copilot 工具）由包 manifest 贡献，外壳只组装。
4. **迁移期豁免**：kernel facade 可包装遗留 `src/server/**`；capability 暂可 import `@/db/client`/`@/db/schema`（schema 切片 P2 起）。

## 测试约定（新形状）

`src/kernel/**` 与 `src/capabilities/**`：`*.unit.test.ts` 自动进无 DB 快车道，
`*.db.test.ts` 自动进 testcontainer 车道。命名即分区，零 allowlist。
```

- [ ] **Step 7: Commit**

```bash
pnpm biome check --write src/capabilities
git add src/capabilities/agent-notes/manifest.ts src/capabilities/agent-notes/CONTEXT.md src/capabilities/index.ts src/capabilities/composition.unit.test.ts ARCHITECTURE.md
git commit -m "feat(agent-notes): manifest + composition registration + architecture map seed (YUK-311)"
```

---

### Task 8: 全量 gate + 等价性核验 + PR

**Files:** 无新改动（只验证；若 gate 揪出问题，修复后补 commit）

- [ ] **Step 1: 全量 gate（顺序执行，每条贴出尾部输出作为证据）**

```bash
pnpm typecheck
pnpm lint
pnpm audit:partition
pnpm audit:schema
pnpm test 2>&1 | tail -15
pnpm build 2>&1 | tail -10
```

Expected：全绿。逐条说明：
- `audit:partition`：0 P0；新树文件按约定归位（`*.unit.test.ts`→unit、`*.db.test.ts`→db）。
- `audit:schema`：与改动前一致（本计划零 schema 改动）。
- `pnpm test`：含 audit:profile + unit + db + migration 四段，全部 PASS，db 段需要 Docker。
- `pnpm build`：成功（主仓有 .env.local；fresh worktree 则 `DATABASE_URL=postgres://placeholder:5432/x pnpm build`）。

- [ ] **Step 2: 残留引用终检**

```bash
grep -rn "@/server/agents/notes\|@/ui/agent-notes" src app scripts postman --include='*.ts' --include='*.tsx' --include='*.json'
ls src/server/agents 2>&1
```

Expected: grep 零输出；`ls` 报 `No such file or directory`。

- [ ] **Step 3: 行为等价抽查（可选但推荐）** — 起 dev（注意先查 :3000 是否被 OrbStack 容器占用，端口漂移则用实际端口）：

```bash
pnpm dev:local &
sleep 8
curl -s -H "x-internal-token: $(grep INTERNAL_TOKEN .env | cut -d= -f2)" "http://localhost:3000/api/agents/notes?limit=5" | head -c 300
```

Expected: `{"rows":[...]}`（结构同迁移前；空库则 `{"rows":[]}`）。验完杀掉 dev。

- [ ] **Step 4: 内核契约体检（spec P1 验收项）** — 在 PR 描述里回答并记录：

1. manifest 三个字段（events/api/ui）打样中是否都被真实消费（组合校验 + 架构图）？有无写了没人读的字段？→ 有则删。
2. `emitEvent` facade 签名是否够用，agent-notes 有没有被迫绕过它直接 import 遗留模块？
3. 测试约定有没有任何一步需要「记得去登记」？（目标答案：没有——命名即分区。）
4. 结论一句话：契约保留 / 调整 / 降级回包。

- [ ] **Step 5: 推分支 + 开 PR（不自动 merge）**

```bash
git commit --allow-empty -m "chore(arch): P1 pillar complete — kernel + agent-notes pilot

Closes YUK-311

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin yuk-311-p1-kernel-agent-notes
gh pr create --title "arch(P1): kernel pillars + agent-notes pilot capability (YUK-311)" --body "$(cat <<'EOF'
## Summary
- 架构重设计 P1（spec: docs/superpowers/specs/2026-06-10-architecture-redesign-design.md §4-P1）
- src/kernel/：manifest 类型 + 组合校验、events/http 薄 facade、CONTEXT
- src/capabilities/agent-notes/：server/api/ui 全量平移，外壳壳化，5 处 import 更新，测试随迁改名
- 测试新约定：kernel/capabilities 树 *.unit.test.ts / *.db.test.ts 命名即分区（零 allowlist）
- ARCHITECTURE.md 种子：六契约状态图 + 包迁移进度表

## 内核契约体检（P1 验收）
（执行 Task 8 Step 4 后填写）

## 等价性证据
- 原 agent-notes 测试全部随迁通过（notes.db / api notes.db / derive.unit / meta.unit）
- 残留引用 grep 零输出；全量 gate 绿（输出见下）

Closes YUK-311

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR 创建成功，URL 输出。**停在这里等用户 merge**（项目惯例：PR 一律不自动 merge）。

---

## Self-Review 记录（计划作者自检）

- **Spec 覆盖**：spec §4-P1 三件套（kernel 立柱 / 组合根+测试约定 / agent-notes 打样）→ Task 1-3 / Task 1+3 / Task 4-7；P1 验收四条 → Task 8。四个未立契约显式登记为 ARCHITECTURE.md 槽位（spec 反框架护栏优先于「六契约全立」的字面读法，偏差已在计划头部声明）。
- **占位符扫描**：无 TBD；唯一运行时参数（YUK-311）已实号烤入。
- **类型一致性**：`emitEvent` 命名在 Task 3（定义）与 Task 4（消费）一致；`CapabilityManifest.events/api/ui` 字段与 Task 7 agent-notes manifest 用法一致；`defineCapability`/`validateComposition` 签名贯穿 Task 2/3/7。
- **路径核对**：tests/helpers/db 相对深度（server 4 层 ✓、api 4 层不变 ✓）；today/page.tsx 第 4-5 行、notes.ts 第 36 行、各 import 站点行号均来自 2026-06-10 实仓 grep。
