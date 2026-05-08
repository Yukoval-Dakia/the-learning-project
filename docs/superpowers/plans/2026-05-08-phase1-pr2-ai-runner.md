# Phase 1 PR 2 (AI 接通) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec 的 PR 2（AI 接通）—— 改进 6 (AI Task Runner) + 改进 7 (tool calling = server) + 改进 8 (PWA)。把 AI Task 抽象层接通到 Vercel AI SDK + D1，让 Phase 1a 业务任务（首先是 AttributionTask）有可用的执行框架。

**Architecture:** Worker 端 `runTask(kind, input, ctx)` 用 Vercel AI SDK v6 (`generateText` / `streamText` + `tools`) 执行 LLMTask；多步 tool call 循环跑在 worker，结果通过 stream Response 返回 client；每次 tool call 写 ToolCallLog + 总成本写 CostLedger 到 D1。LogicTask（JudgeExact / JudgeKeyword / JudgeRouter）单独走普通 function 不进 LLM registry。Client PWA 化用 `vite-plugin-pwa`（manifest + standalone display，Phase 1 不开 cache）。

**Tech Stack:** Vercel AI SDK v6 (`ai@^6.0.176` + `@ai-sdk/anthropic@^3.0.76`), Hono streaming, Drizzle d1, vite-plugin-pwa, vitest (含 AI SDK mock model)。

**Spec reference:** `docs/superpowers/specs/2026-05-08-phase1-improvements-design.md` 改进 6 / 7 / 8。

**Decisions resolved in this plan:**
- Registry 共享路径 → keep `src/ai/registry.ts`，worker 通过 `../../src/ai/registry` 相对路径 import（与 `workers/src/db.ts` 一致 pattern；不引 monorepo 工具）
- Streaming 响应方式 → AI SDK `streamText().toDataStreamResponse()` 直接 pipe 到 Hono response；client `fetch` 接 stream，Phase 1 buffer 全文（无 UI 消费 progress 信号）
- 测试 LLM 调用 → 用 AI SDK v6 的 `MockLanguageModelV3`（从 `'ai/test'` 导入；无真 Anthropic 调用，节流 + 可预测）

---

## File Structure

### 创建（新文件）

- `workers/src/ai/log.ts` — `writeToolCallLog()` + `writeCostLedger()` D1 写入
- `workers/src/ai/log.test.ts` — log 写入单测（用 in-memory mock D1）
- `workers/src/ai/judges/exact.ts` — `judgeExact(question, answer)` LogicTask
- `workers/src/ai/judges/exact.test.ts`
- `workers/src/ai/judges/keyword.ts` — `judgeKeyword(question, answer)` LogicTask
- `workers/src/ai/judges/keyword.test.ts`
- `workers/src/ai/judges/index.ts` — `judgeRouter(question, answer)` 派发到具体 LogicTask（仅 exact / keyword Phase 1，其他 throw 'not implemented'）
- `workers/src/ai/judges/index.test.ts`
- `workers/src/ai/runner.ts` — `runTask(kind, input, ctx)` + helper types
- `workers/src/ai/runner.test.ts` — runner 单测（mock model 注入）
- `public/icon-192.png` / `public/icon-512.png` — PWA icon 占位（最小 PNG）
- `public/manifest.webmanifest` — PWA manifest（vite-plugin-pwa 自动生成，但留一份 source-of-truth 注释参考）

### 修改（已有文件）

- `package.json` — 加 `vite-plugin-pwa` devDep
- `vite.config.ts` — 加 `VitePWA` plugin
- `index.html` — 加 manifest link + apple-touch-icon meta + theme-color
- `src/ai/registry.ts` — 扩 `TaskDef` 加 `systemPrompt` 字段
- `src/ai/client.ts` — 接 stream Response（同时兼容 JSON）
- `src/vite-env.d.ts` — 补 `vite-plugin-pwa/client` reference
- `workers/src/index.ts` — `/api/ai/:task` 路由调 `runTask`，pipe stream
- `docs/architecture.md` — § 5.4 之后插入 § 5.5 "Tool calling 循环位置"

### 不动

- `src/db/schema.ts`、`src/core/schema/` — 已是单源
- `workers/src/auth.ts` / `workers/src/db.ts` / `workers/src/types.ts` — 上一 PR 已就位

---

## Tasks

---

### Task 1: PWA scaffold（改进 8）

**Goal:** 装 `vite-plugin-pwa`，配最小 manifest（manifest + standalone display + theme color），让移动端能"加到主屏幕"。Phase 1 不开 runtime cache。

**Files:**
- 修改：`package.json`
- 创建：`vite.config.ts`（修改）
- 修改：`index.html`
- 创建：`public/icon-192.png`（占位 PNG，纯色单像素就够）
- 创建：`public/icon-512.png`（同上）
- 修改：`src/vite-env.d.ts`

- [ ] **Step 1: 安装 vite-plugin-pwa**

```bash
pnpm add -D vite-plugin-pwa
```

Expected: `devDependencies` 新增 `vite-plugin-pwa@^0.21.x` 或更新；pnpm-lock 更新。

- [ ] **Step 2: 创建占位 PNG icons**

最简：用 ImageMagick / sips 生成纯色 PNG，或者直接写一个最小有效的 PNG hex 入 file。优先 sips（macOS 自带）：

```bash
mkdir -p public
# 用 macOS sips 生成 192x192 + 512x512 占位（深色 #0f172a）
python3 -c "
import struct, zlib
def make_png(w, h, rgb):
    sig = b'\\x89PNG\\r\\n\\x1a\\n'
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
    raw = b''.join(b'\\x00' + bytes(rgb) * w for _ in range(h))
    idat = chunk(b'IDAT', zlib.compress(raw))
    iend = chunk(b'IEND', b'')
    return sig + ihdr + idat + iend
open('public/icon-192.png', 'wb').write(make_png(192, 192, (15, 23, 42)))
open('public/icon-512.png', 'wb').write(make_png(512, 512, (15, 23, 42)))
"
ls -la public/
```

Expected: `icon-192.png` ~600B、`icon-512.png` ~2KB。两个都能在浏览器打开看到深蓝色方块。

- [ ] **Step 3: 修改 vite.config.ts 加 VitePWA plugin**

```ts
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'AI 学习工具',
        short_name: '学习',
        description: '自用 AI 学习系统（错题 / 进度 / Note）',
        theme_color: '#0f172a',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        // Phase 1 D1 远程优先，不缓存任何 API 响应
        runtimeCaching: [],
      },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
```

- [ ] **Step 4: 修改 index.html 加 manifest 和 apple-touch-icon**

替换 `<head>` 段：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#0f172a" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="apple-touch-icon" href="/icon-192.png" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <title>AI 学习工具</title>
  </head>
  <body class="antialiased">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: 更新 vite-env.d.ts 加 PWA client types**

替换 `src/vite-env.d.ts`：

```ts
/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_INTERNAL_TOKEN?: string;
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

- [ ] **Step 6: 验证 build 通过**

```bash
pnpm build
```

Expected: tsc 0 error；vite build 输出含 `dist/manifest.webmanifest` 和 `dist/sw.js`（service worker）。

- [ ] **Step 7: dev 模式启动验证 manifest 被读到**

```bash
pnpm dev &
sleep 5
curl -s http://localhost:5173/manifest.webmanifest | head -20
kill %1
```

Expected: 看到 manifest JSON 输出（`name: 'AI 学习工具'` 等）。

- [ ] **Step 8: 提交**

```bash
git add package.json pnpm-lock.yaml vite.config.ts index.html src/vite-env.d.ts public/
git commit -m "feat(pwa): manifest + standalone display via vite-plugin-pwa (改进 8)"
```

---

### Task 2: AI log writers（workers/src/ai/log.ts）

**Goal:** TDD 写 `writeToolCallLog()` 和 `writeCostLedger()` 两个 D1 insert helper，runner 在每次 tool call 完成后调，总成本调 CostLedger。

**Files:**
- 创建：`workers/src/ai/log.ts`
- 创建：`workers/src/ai/log.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `workers/src/ai/log.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { writeCostLedger, writeToolCallLog } from './log';

function makeMockDb() {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      return { run: async () => ({ success: true }) };
    },
  }));
  return { db: { prepare } as unknown as D1Database, calls };
}

describe('writeToolCallLog', () => {
  it('inserts a row with all required fields', async () => {
    const { db, calls } = makeMockDb();
    await writeToolCallLog(db, {
      task_run_id: 'tr_1',
      task_kind: 'AttributionTask',
      tool_name: 'search_knowledge_by_concept',
      input_json: { concept: '宾语前置' },
      output_json: { results: [] },
      iteration: 1,
      latency_ms: 234,
      cost: 0.001,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/insert into.*tool_call_log/i);
    // id, task_run_id, task_kind, tool_name, input_json, output_json, iteration, latency_ms, cost, occurred_at
    expect(calls[0].binds).toHaveLength(10);
    expect(calls[0].binds[1]).toBe('tr_1');
    expect(calls[0].binds[2]).toBe('AttributionTask');
    expect(calls[0].binds[3]).toBe('search_knowledge_by_concept');
  });
});

describe('writeCostLedger', () => {
  it('inserts a row with all required fields', async () => {
    const { db, calls } = makeMockDb();
    await writeCostLedger(db, {
      task_kind: 'AttributionTask',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      cost: 0.012,
      tokens_in: 1234,
      tokens_out: 567,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/insert into.*cost_ledger/i);
    expect(calls[0].binds).toHaveLength(8);
    expect(calls[0].binds[1]).toBe('AttributionTask');
    expect(calls[0].binds[2]).toBe('anthropic');
    expect(calls[0].binds[3]).toBe('claude-sonnet-4-6');
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
pnpm test
```

Expected: `Cannot find module './log'` —— 红。

- [ ] **Step 3: 实现 log.ts**

写 `workers/src/ai/log.ts`：

```ts
import type { D1Database } from '@cloudflare/workers-types';
import { createId } from '@paralleldrive/cuid2';

export interface ToolCallLogEntry {
  task_run_id: string;
  task_kind: string;
  tool_name: string;
  input_json: unknown;
  output_json: unknown;
  iteration: number;
  latency_ms: number;
  cost: number;
}

export async function writeToolCallLog(db: D1Database, entry: ToolCallLogEntry): Promise<void> {
  const id = createId();
  const occurredAt = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `insert into tool_call_log (id, task_run_id, task_kind, tool_name, input_json, output_json, iteration, latency_ms, cost, occurred_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      entry.task_run_id,
      entry.task_kind,
      entry.tool_name,
      JSON.stringify(entry.input_json),
      JSON.stringify(entry.output_json),
      entry.iteration,
      entry.latency_ms,
      entry.cost,
      occurredAt,
    )
    .run();
}

export interface CostLedgerEntry {
  task_kind: string;
  provider: string;
  model: string;
  cost: number;
  tokens_in: number;
  tokens_out: number;
}

export async function writeCostLedger(db: D1Database, entry: CostLedgerEntry): Promise<void> {
  const id = createId();
  const occurredAt = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `insert into cost_ledger (id, task_kind, provider, model, cost, tokens_in, tokens_out, occurred_at) values (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      entry.task_kind,
      entry.provider,
      entry.model,
      entry.cost,
      entry.tokens_in,
      entry.tokens_out,
      occurredAt,
    )
    .run();
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
pnpm test
```

Expected: log.test.ts 2 cases pass，全部 tests 增至 12 passed。

- [ ] **Step 5: typecheck**

```bash
pnpm typecheck
```

Expected: 0 error.

- [ ] **Step 6: 提交**

```bash
git add workers/src/ai/log.ts workers/src/ai/log.test.ts
git commit -m "feat(ai): add ToolCallLog + CostLedger writers (改进 6)"
```

---

### Task 3: JudgeExactTask（LogicTask 例子）

**Goal:** 第一个 LogicTask —— 字面比对 judge。**不调 LLM**，纯函数。展示 LogicTask 的 pattern。

**Files:**
- 创建：`workers/src/ai/judges/exact.ts`
- 创建：`workers/src/ai/judges/exact.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `workers/src/ai/judges/exact.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { judgeExact } from './exact';

describe('judgeExact', () => {
  it('returns correct verdict on exact match', () => {
    const r = judgeExact({ reference: '宾语前置' }, { content: '宾语前置' });
    expect(r.verdict).toBe('correct');
    expect(r.score).toBe(1);
  });

  it('returns incorrect on mismatch', () => {
    const r = judgeExact({ reference: '宾语前置' }, { content: '主谓倒装' });
    expect(r.verdict).toBe('incorrect');
    expect(r.score).toBe(0);
  });

  it('trims whitespace before comparing', () => {
    const r = judgeExact({ reference: '宾语前置' }, { content: '  宾语前置  ' });
    expect(r.verdict).toBe('correct');
  });

  it('case-insensitive for ASCII text', () => {
    const r = judgeExact({ reference: 'Yes' }, { content: 'yes' });
    expect(r.verdict).toBe('correct');
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
pnpm test
```

Expected: red.

- [ ] **Step 3: 实现 exact.ts**

写 `workers/src/ai/judges/exact.ts`：

```ts
export interface JudgeInput {
  reference: string;
}

export interface AnswerInput {
  content: string;
}

export interface JudgeResult {
  verdict: 'correct' | 'partial' | 'incorrect';
  score: number;
  feedback_md: string;
  evidence_json: Record<string, unknown>;
}

export function judgeExact(question: JudgeInput, answer: AnswerInput): JudgeResult {
  const normalize = (s: string) => s.trim().toLowerCase();
  const match = normalize(answer.content) === normalize(question.reference);
  return {
    verdict: match ? 'correct' : 'incorrect',
    score: match ? 1 : 0,
    feedback_md: match
      ? `正确答案：${question.reference}。`
      : `参考答案：${question.reference}。你的答案：${answer.content}。`,
    evidence_json: { match, normalized_reference: normalize(question.reference) },
  };
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
pnpm test
```

Expected: 4 cases all pass.

- [ ] **Step 5: 提交**

```bash
git add workers/src/ai/judges/exact.ts workers/src/ai/judges/exact.test.ts
git commit -m "feat(judges): add JudgeExact LogicTask (改进 6)"
```

---

### Task 4: JudgeKeywordTask

**Goal:** 关键词命中率 judge。`question.keywords[]` + `answer.content` → 命中数 / 总数。

**Files:**
- 创建：`workers/src/ai/judges/keyword.ts`
- 创建：`workers/src/ai/judges/keyword.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `workers/src/ai/judges/keyword.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { judgeKeyword } from './keyword';

describe('judgeKeyword', () => {
  it('correct when all keywords hit', () => {
    const r = judgeKeyword(
      { keywords: ['宾语', '前置', '动词'] },
      { content: '宾语在动词前面，叫宾语前置' },
    );
    expect(r.verdict).toBe('correct');
    expect(r.score).toBe(1);
  });

  it('partial when some keywords hit', () => {
    const r = judgeKeyword({ keywords: ['宾语', '前置', '动词'] }, { content: '宾语前置' });
    expect(r.verdict).toBe('partial');
    expect(r.score).toBeCloseTo(2 / 3, 2);
  });

  it('incorrect when no keywords hit', () => {
    const r = judgeKeyword({ keywords: ['宾语', '前置'] }, { content: '主谓倒装' });
    expect(r.verdict).toBe('incorrect');
    expect(r.score).toBe(0);
  });

  it('feedback lists missing keywords', () => {
    const r = judgeKeyword({ keywords: ['A', 'B', 'C'] }, { content: 'has A only' });
    expect(r.feedback_md).toMatch(/缺失/);
    expect(r.feedback_md).toContain('B');
    expect(r.feedback_md).toContain('C');
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
pnpm test
```

Expected: red.

- [ ] **Step 3: 实现 keyword.ts**

写 `workers/src/ai/judges/keyword.ts`：

```ts
import type { AnswerInput, JudgeResult } from './exact';

export interface KeywordJudgeInput {
  keywords: string[];
}

export function judgeKeyword(question: KeywordJudgeInput, answer: AnswerInput): JudgeResult {
  const total = question.keywords.length;
  const lowerContent = answer.content.toLowerCase();
  const hits = question.keywords.filter((kw) => lowerContent.includes(kw.toLowerCase()));
  const missing = question.keywords.filter((kw) => !lowerContent.includes(kw.toLowerCase()));
  const score = total === 0 ? 0 : hits.length / total;
  let verdict: JudgeResult['verdict'];
  if (score >= 0.85) verdict = 'correct';
  else if (score > 0.4) verdict = 'partial';
  else verdict = 'incorrect';
  return {
    verdict,
    score,
    feedback_md:
      missing.length === 0
        ? `命中所有关键词 (${hits.length}/${total})。`
        : `命中关键词 ${hits.length}/${total}：缺失 [${missing.join(', ')}]。`,
    evidence_json: { hits, missing, total },
  };
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
pnpm test
```

Expected: 4 cases pass.

- [ ] **Step 5: 提交**

```bash
git add workers/src/ai/judges/keyword.ts workers/src/ai/judges/keyword.test.ts
git commit -m "feat(judges): add JudgeKeyword LogicTask"
```

---

### Task 5: JudgeRouter

**Goal:** 派发 judge_kind 到具体 LogicTask。Phase 1 仅 exact / keyword 实现，其他 (`semantic` / `rubric` / `steps` / `multimodal_direct` / `ai_flexible`) throw 'not implemented'。

**Files:**
- 创建：`workers/src/ai/judges/index.ts`
- 创建：`workers/src/ai/judges/index.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `workers/src/ai/judges/index.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { judgeRouter } from './index';

describe('judgeRouter', () => {
  it('dispatches to judgeExact for kind=exact', () => {
    const r = judgeRouter({
      kind: 'exact',
      question: { reference: 'A' },
      answer: { content: 'A' },
    });
    expect(r.verdict).toBe('correct');
  });

  it('dispatches to judgeKeyword for kind=keyword', () => {
    const r = judgeRouter({
      kind: 'keyword',
      question: { keywords: ['A', 'B'] },
      answer: { content: 'A and B' },
    });
    expect(r.verdict).toBe('correct');
  });

  it('throws for unimplemented kinds', () => {
    expect(() =>
      judgeRouter({
        kind: 'semantic',
        question: { reference: 'A' },
        answer: { content: 'A' },
      }),
    ).toThrow(/not implemented/i);
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
pnpm test
```

Expected: red.

- [ ] **Step 3: 实现 index.ts**

写 `workers/src/ai/judges/index.ts`：

```ts
import { judgeExact } from './exact';
import { judgeKeyword } from './keyword';
import type { AnswerInput, JudgeResult } from './exact';

export type JudgeKind =
  | 'exact'
  | 'keyword'
  | 'semantic'
  | 'rubric'
  | 'steps'
  | 'multimodal_direct'
  | 'ai_flexible';

export interface JudgeRouterInput {
  kind: JudgeKind;
  question: { reference?: string; keywords?: string[]; [k: string]: unknown };
  answer: AnswerInput;
}

export function judgeRouter(input: JudgeRouterInput): JudgeResult {
  switch (input.kind) {
    case 'exact':
      if (typeof input.question.reference !== 'string') {
        throw new Error('judgeExact requires question.reference');
      }
      return judgeExact({ reference: input.question.reference }, input.answer);
    case 'keyword':
      if (!Array.isArray(input.question.keywords)) {
        throw new Error('judgeKeyword requires question.keywords[]');
      }
      return judgeKeyword({ keywords: input.question.keywords }, input.answer);
    case 'semantic':
    case 'rubric':
    case 'steps':
    case 'multimodal_direct':
    case 'ai_flexible':
      throw new Error(`Judge kind '${input.kind}' not implemented (Phase 2 / quiz feature work)`);
    default: {
      const _exhaustive: never = input.kind;
      void _exhaustive;
      throw new Error(`Unknown judge kind: ${String(input.kind)}`);
    }
  }
}

export { judgeExact, judgeKeyword };
export type { JudgeResult, AnswerInput };
```

- [ ] **Step 4: 跑测试验证通过**

```bash
pnpm test
```

Expected: 3 cases pass.

- [ ] **Step 5: typecheck**

```bash
pnpm typecheck
```

Expected: 0 error.

- [ ] **Step 6: 提交**

```bash
git add workers/src/ai/judges/index.ts workers/src/ai/judges/index.test.ts
git commit -m "feat(judges): add JudgeRouter dispatch (改进 6)"
```

---

### Task 6: 扩 TaskDef registry + AI Runner core (no tools, no streaming)

**Goal:** 扩 `src/ai/registry.ts` TaskDef 加 `systemPrompt`，写 `workers/src/ai/runner.ts` 的 `runTask` 函数最小版（用 `generateText` 单轮，无 tool calling，无 streaming）。**关键**：使用 AI SDK v6 的 `MockLanguageModelV3` 注入测试 model。

**Files:**
- 修改：`src/ai/registry.ts`
- 创建：`workers/src/ai/runner.ts`
- 创建：`workers/src/ai/runner.test.ts`

- [ ] **Step 1: 扩 src/ai/registry.ts**

读 `src/ai/registry.ts` 现有结构。在 `TaskDef` interface 加 `systemPrompt` 字段：

```ts
export interface TaskDef {
  kind: string;
  description: string;
  defaultProvider: Provider;
  defaultModel: ModelId;
  fallbackChain: Array<{ provider: Provider; model: ModelId }>;
  budget: TaskBudget;
  needsToolCall: boolean;
  isMultimodal: boolean;
  allowedTools: string[];
  systemPrompt: string;
}
```

更新现有 `tasks.AttributionTask` 和 `tasks.VisionExtractTask` 加 `systemPrompt` 字段（最小可用 prompt 即可）：

```ts
AttributionTask: {
  kind: 'AttributionTask',
  description: '错题归因 + 知识点挂载（10 类 cause）',
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-6',
  fallbackChain: [{ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }],
  budget: { ...DEFAULT_BUDGET, maxIterations: 4 },
  needsToolCall: true,
  isMultimodal: false,
  allowedTools: [
    'search_knowledge_by_concept',
    'get_knowledge_node',
    'get_node_neighbors',
    'find_similar_mistakes',
    'create_knowledge_node',
    'link_mistake_to_node',
  ],
  systemPrompt: '你是错题归因助手。给定一道做错的题、用户的错答和参考答案，分析错因并选择最匹配的知识点。错因从 10 类中选：concept / knowledge_gap / calculation / reading / memory / expression / method / carelessness / time_pressure / other。低信心走 other + 详细 ai_analysis_md。',
},
VisionExtractTask: {
  kind: 'VisionExtractTask',
  description: '错题图片 → 题面 / LaTeX / 选项',
  defaultProvider: 'anthropic',
  defaultModel: 'claude-haiku-4-5-20251001',
  fallbackChain: [],
  budget: { ...DEFAULT_BUDGET, maxIterations: 1 },
  needsToolCall: false,
  isMultimodal: true,
  allowedTools: [],
  systemPrompt: '识别图片中的题目题面、参考答案（如可见）、选项；输出结构化 JSON。',
},
```

- [ ] **Step 2: 写 runner 失败测试**

创建 `workers/src/ai/runner.test.ts`：

```ts
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { runTask } from './runner';

function makeMockDb() {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      return { run: async () => ({ success: true }) };
    },
  }));
  return { db: { prepare } as unknown as D1Database, calls };
}

describe('runTask (single-shot, no tools)', () => {
  it('calls model and returns text + writes CostLedger', async () => {
    const mockModel = new MockLanguageModelV3({
      doGenerate: async () => ({
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        content: [{ type: 'text', text: '归因结果：concept' }],
        warnings: [],
      }),
    });

    const { db, calls } = makeMockDb();
    const result = await runTask(
      'AttributionTask',
      { question: '...', wrong_answer: '...' },
      { env: { DB: db } as any, model: mockModel },
    );

    expect(result.text).toBe('归因结果：concept');
    expect(calls.some((c) => /cost_ledger/i.test(c.sql))).toBe(true);
  });

  it('returns finishReason in result', async () => {
    const mockModel = new MockLanguageModelV3({
      doGenerate: async () => ({
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        content: [{ type: 'text', text: 'ok' }],
        warnings: [],
      }),
    });
    const { db } = makeMockDb();
    const r = await runTask(
      'AttributionTask',
      {},
      { env: { DB: db } as any, model: mockModel },
    );
    expect(r.finishReason).toBe('stop');
  });

  it('throws for unknown task kind', async () => {
    const { db } = makeMockDb();
    await expect(
      runTask('NonexistentTask', {}, { env: { DB: db } as any }),
    ).rejects.toThrow(/unknown task/i);
  });
});
```

- [ ] **Step 3: 跑测试验证失败**

```bash
pnpm test
```

Expected: red (Cannot find module './runner').

- [ ] **Step 4: 实现 runner.ts**

写 `workers/src/ai/runner.ts`：

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { generateText, type LanguageModel } from 'ai';
import { createId } from '@paralleldrive/cuid2';
import { tasks, type TaskKind } from '../../../src/ai/registry';
import { writeCostLedger } from './log';
import type { Bindings } from '../types';

export interface RunTaskCtx {
  env: Bindings;
  /** Override model for testing (defaults to anthropic provider with task's defaultModel) */
  model?: LanguageModel;
}

export interface RunTaskResult {
  task_run_id: string;
  text: string;
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

const TASK_KINDS = Object.keys(tasks) as TaskKind[];

function isKnownTask(k: string): k is TaskKind {
  return (TASK_KINDS as string[]).includes(k);
}

export async function runTask(
  kind: string,
  input: unknown,
  ctx: RunTaskCtx,
): Promise<RunTaskResult> {
  if (!isKnownTask(kind)) {
    throw new Error(`Unknown task kind: ${kind}`);
  }
  const def = tasks[kind];
  const model = ctx.model ?? anthropic(def.defaultModel);
  const taskRunId = createId();

  const result = await generateText({
    model,
    system: def.systemPrompt,
    prompt: typeof input === 'string' ? input : JSON.stringify(input),
    abortSignal: AbortSignal.timeout(def.budget.timeout),
  });

  await writeCostLedger(ctx.env.DB, {
    task_kind: kind,
    provider: def.defaultProvider,
    model: def.defaultModel,
    cost: 0, // Phase 1 no cost calc; just record tokens
    tokens_in: result.usage.inputTokens ?? 0,
    tokens_out: result.usage.outputTokens ?? 0,
  });

  return {
    task_run_id: taskRunId,
    text: result.text,
    finishReason: result.finishReason,
    usage: {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    },
  };
}
```

- [ ] **Step 5: 跑测试验证通过**

```bash
pnpm test
```

Expected: 3 cases pass. 如果 `MockLanguageModelV3` import path 不是 `'ai/test'`，根据 ai SDK v6 实际导出调整（试 `'ai/v2/test'` 或 `'@ai-sdk/test'`）。如果 v6 没有 mock，回到 vitest `vi.mock('ai', ...)` 方案。

- [ ] **Step 6: typecheck**

```bash
pnpm typecheck
```

Expected: 0 error.

- [ ] **Step 7: 提交**

```bash
git add src/ai/registry.ts workers/src/ai/runner.ts workers/src/ai/runner.test.ts
git commit -m "feat(ai): runTask core (single-shot, no tools, with CostLedger) (改进 6)"
```

---

### Task 7: AI Runner streaming + tool calling

**Goal:** 扩 `runTask` 支持 `streamText` + `tools` 多步循环。每步 tool call 写 ToolCallLog。返回 stream Response。

**Files:**
- 修改：`workers/src/ai/runner.ts`
- 修改：`workers/src/ai/runner.test.ts`

- [ ] **Step 1: 加 streaming + tools 测试**

在 `workers/src/ai/runner.test.ts` 末尾追加：

```ts
import { stepCountIs } from 'ai';

describe('runTask streaming with tools', () => {
  it('streams text and writes ToolCallLog per tool call', async () => {
    const mockModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: 'tool-call',
              toolCallId: 'tc1',
              toolName: 'echo_tool',
              input: { msg: 'hi' },
            });
            controller.enqueue({
              type: 'finish',
              finishReason: 'tool-calls',
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            });
            controller.close();
          },
        }),
      }),
    });

    const { db, calls } = makeMockDb();
    const stream = streamTask(
      'AttributionTask',
      { test: true },
      {
        env: { DB: db } as any,
        model: mockModel,
        tools: {
          echo_tool: {
            description: 'echo input back',
            inputSchema: z.object({ msg: z.string() }),
            execute: async ({ msg }: { msg: string }) => ({ echoed: msg }),
          },
        },
      },
    );

    // Drain the stream
    const chunks: string[] = [];
    const reader = stream.body!.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(new TextDecoder().decode(value));
    }

    // Verify ToolCallLog was written
    const toolCallLogged = calls.find((c) => /tool_call_log/i.test(c.sql));
    expect(toolCallLogged).toBeDefined();
    expect(toolCallLogged?.binds[3]).toBe('echo_tool');
  });
});
```

注：上面 import 需要在文件顶部加 `import { stepCountIs } from 'ai';` 和 `import { z } from 'zod';` 以及 `streamTask` 从 './runner' 导入。

- [ ] **Step 2: 跑测试验证失败**

```bash
pnpm test
```

Expected: red (streamTask not exported from runner.ts).

- [ ] **Step 3: 扩 runner.ts**

在 `workers/src/ai/runner.ts` 加：

```ts
import { streamText, stepCountIs, type Tool } from 'ai';
import { writeToolCallLog, writeCostLedger } from './log';

export interface StreamTaskCtx extends RunTaskCtx {
  tools?: Record<string, Tool>;
}

/**
 * Stream a task. Returns a Response with streaming body.
 * Caller is responsible for piping to client (Hono c.body).
 */
export function streamTask(
  kind: string,
  input: unknown,
  ctx: StreamTaskCtx,
): Response {
  if (!isKnownTask(kind)) {
    throw new Error(`Unknown task kind: ${kind}`);
  }
  const def = tasks[kind];
  const model = ctx.model ?? anthropic(def.defaultModel);
  const taskRunId = createId();
  let iteration = 0;
  const startTime = Date.now();

  const result = streamText({
    model,
    system: def.systemPrompt,
    prompt: typeof input === 'string' ? input : JSON.stringify(input),
    tools: ctx.tools,
    stopWhen: stepCountIs(def.budget.maxIterations),
    abortSignal: AbortSignal.timeout(def.budget.timeout),
    onStepFinish: async ({ toolCalls, toolResults, usage }) => {
      iteration += 1;
      // Write a ToolCallLog row per tool call this step
      for (const [idx, tc] of toolCalls.entries()) {
        const tr = toolResults?.[idx];
        await writeToolCallLog(ctx.env.DB, {
          task_run_id: taskRunId,
          task_kind: kind,
          tool_name: tc.toolName,
          input_json: tc.input ?? {},
          output_json: tr ?? {},
          iteration,
          latency_ms: Date.now() - startTime,
          cost: 0,
        });
      }
    },
    onFinish: async ({ usage }) => {
      await writeCostLedger(ctx.env.DB, {
        task_kind: kind,
        provider: def.defaultProvider,
        model: def.defaultModel,
        cost: 0,
        tokens_in: usage?.inputTokens ?? 0,
        tokens_out: usage?.outputTokens ?? 0,
      });
    },
  });

  return result.toTextStreamResponse();
}
```

注：AI SDK v6 提供两种 stream Response：
- `toTextStreamResponse()` → 纯文本流（Phase 1 用这个，client 简单 buffer 即可）
- `toUIMessageStreamResponse()` → 带 UIMessage 协议的 SSE 流（适合后续给 UI 消费 progress / tool call 状态）

Phase 1 用 `toTextStreamResponse()`。未来 UI 加 progress 显示再切 UIMessage。

- [ ] **Step 4: 跑测试验证通过**

```bash
pnpm test
```

Expected: streaming test pass + 之前的 runTask single-shot 测试仍 pass。如果 mock model 的 streaming 部分 API 不匹配，根据 `ai` v6 文档调整 mock 的 stream chunk shape（可能要 `type: 'tool-call'` 还是 `type: 'tool-input-start'` 等）。

- [ ] **Step 5: typecheck**

```bash
pnpm typecheck
```

Expected: 0 error.

- [ ] **Step 6: 提交**

```bash
git add workers/src/ai/runner.ts workers/src/ai/runner.test.ts
git commit -m "feat(ai): streamTask with tool calling loop + ToolCallLog (改进 6/7)"
```

---

### Task 8: Worker /api/ai/:task 路由 wire

**Goal:** `workers/src/index.ts` 的 `/api/ai/:task` 不再返 501，而是调 `runTask` (单轮) 或 `streamTask` (多轮)。靠 task registry 的 `needsToolCall` 字段决定走哪条。

**Files:**
- 修改：`workers/src/index.ts`

- [ ] **Step 1: 改 worker index.ts**

替换现有的 `/api/ai/:task` handler：

```ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { internalAuth } from './auth';
import { runTask, streamTask } from './ai/runner';
import { tasks } from '../../src/ai/registry';
import { getDb } from './db';
import type { AppEnv } from './types';

const app = new Hono<AppEnv>();

app.use(
  '*',
  cors({
    origin: '*',
    allowHeaders: ['Content-Type', 'x-internal-token'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    maxAge: 600,
  }),
);
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

app.post('/api/ai/:task', async (c) => {
  const taskKind = c.req.param('task');
  const body = (await c.req.json().catch(() => ({}))) as { input?: unknown };
  const def = (tasks as Record<string, { needsToolCall: boolean }>)[taskKind];
  if (!def) {
    return c.json({ error: 'unknown_task', task: taskKind }, 404);
  }

  if (def.needsToolCall) {
    // Multi-step tool calling → stream Response
    // Phase 1: tools registry not yet built; pass empty object to validate streaming pipeline
    const stream = streamTask(taskKind, body.input ?? {}, {
      env: c.env,
      tools: {},
    });
    return stream;
  }

  // Single-shot → JSON
  const result = await runTask(taskKind, body.input ?? {}, { env: c.env });
  return c.json(result);
});

export { getDb };
export default app;
```

- [ ] **Step 2: typecheck**

```bash
pnpm typecheck
```

Expected: 0 error.

- [ ] **Step 3: smoke 测试 worker boot**

```bash
pnpm exec wrangler dev --config workers/wrangler.toml --local --persist-to .wrangler-state &
sleep 8
TOKEN=$(grep '^INTERNAL_TOKEN=' workers/.dev.vars | cut -d= -f2-)
echo 'unknown task →'
curl -s -i -H "x-internal-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"input":{}}' http://localhost:8787/api/ai/UnknownTask | head -5
echo
echo 'health →'
curl -s -H "x-internal-token: $TOKEN" http://localhost:8787/api/health
echo
kill %1
```

Expected:
- `/api/ai/UnknownTask` → HTTP 404 + `{"error":"unknown_task","task":"UnknownTask"}`
- `/api/health` → `{"ok":true,"db_ok":true}`

注：不测真 AttributionTask 调用（会真打 Anthropic API + 没 ANTHROPIC_API_KEY 的话直接挂）。Task 11 留给用户手动 smoke。

- [ ] **Step 4: 提交**

```bash
git add workers/src/index.ts
git commit -m "feat(worker): wire /api/ai/:task to runTask + streamTask (改进 6/7)"
```

---

### Task 9: Client `runTask` 接 stream

**Goal:** `src/ai/client.ts` 的 `runTask` 同时支持 stream 和 JSON 响应。Phase 1 client 不消费 progress（直接 buffer 全文），但接口已就绪。

**Files:**
- 修改：`src/ai/client.ts`

- [ ] **Step 1: 替换 client.ts 全文**

```ts
// 浏览器侧 AI 调用入口。
// 所有调用都走 /api/ai/<task>，Cloudflare Workers 持有 ANTHROPIC_API_KEY。
// 浏览器代码绝不直接拿 API key。

const INTERNAL_TOKEN = import.meta.env.VITE_INTERNAL_TOKEN ?? '';

export interface RunTaskOptions {
  signal?: AbortSignal;
  /** Called with text chunks as they stream in. Phase 1 most callers ignore this. */
  onChunk?: (chunk: string) => void;
}

/**
 * Run an AI task on the worker. Returns:
 * - For single-shot tasks (`needsToolCall: false` in registry): parsed JSON.
 * - For multi-step tasks: full text after stream completes (chunks delivered via onChunk).
 *
 * Worker decides which mode to use based on task registry.
 */
export async function runTask<TInput, TOutput = unknown>(
  taskKind: string,
  input: TInput,
  options: RunTaskOptions = {},
): Promise<TOutput | string> {
  const res = await fetch(`/api/ai/${taskKind}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-token': INTERNAL_TOKEN,
    },
    body: JSON.stringify({ input }),
    signal: options.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Task ${taskKind} failed: ${res.status} ${text}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return (await res.json()) as TOutput;
  }

  // Stream mode: read chunks, optionally pipe to onChunk callback, then return full text
  const reader = res.body?.getReader();
  if (!reader) return '' as unknown as TOutput;
  const decoder = new TextDecoder();
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    full += chunk;
    options.onChunk?.(chunk);
  }
  return full;
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm typecheck
```

Expected: 0 error.

- [ ] **Step 3: 提交**

```bash
git add src/ai/client.ts
git commit -m "feat(client): handle stream + JSON response in runTask (改进 7)"
```

---

### Task 10: Architecture doc § 5.5（改进 7 doc）

**Goal:** `docs/architecture.md` 在 § 5.4 之后插入新的 § 5.5 `Tool calling 循环位置`，明确 tool calling 在 worker 端 + stream pipe 给 client。

**Files:**
- 修改：`docs/architecture.md`

- [ ] **Step 1: 定位插入点**

```bash
grep -n "5\.4 Skill\|^### 5\.4\|## 六 技术栈" docs/architecture.md | head -10
```

确认 § 5.4 的结尾行号 + § 六 的起始行号。新内容插在两者之间。

- [ ] **Step 2: 在 § 5.4 之后、§ 六 之前插入 § 5.5**

```markdown
### 5.5 Tool calling 循环位置

**决策**：tool calling 多步循环跑在 **worker 端**（Cloudflare Workers），client 只负责发起请求 + 接 stream。

#### 实现

- worker `/api/ai/:task`：
  - `needsToolCall: false` 的 task → `generateText` 单轮 → 返 JSON
  - `needsToolCall: true` 的 task → `streamText({ tools, stopWhen: stepCountIs(N) })` → 返 stream Response
- AI SDK 的 `streamText` 自带 tool call 循环（multi-step），每步完成调 `onStepFinish`，每个 tool call 写一条 `ToolCallLog`
- 总 finish 时 `onFinish` 写一条 `CostLedger`（按 task / provider / model 聚合）
- client `src/ai/client.ts` 用 `fetch` + `ReadableStream`，按 `content-type` 分流：JSON 走 `res.json()`，stream 走 reader 循环（Phase 1 buffer 全文，未来 UI 消费 progress 再加 callback）

#### 为什么不在 client 跑

- Anthropic API key 不能暴露到浏览器
- 跨请求保留 turn state 复杂（要 KV / Durable Objects），server 一次跑完最简

#### 与 Dreaming 实施栈的关系

Dreaming / Maintenance lane（见 § 5.5 Dreaming 实施栈—— Phase 2 加）也复用这套 runner：cron worker / queue consumer 调 `runTask` / `streamTask` 同样的入口；区别只是触发方式（HTTP 请求 vs cron / queue message）和是否走 Anthropic Batch API（重批量任务）。
```

- [ ] **Step 3: 验证 markdown 渲染**

```bash
grep -A 3 "### 5.5" docs/architecture.md
```

Expected: 看到新增的 § 5.5 标题 + 内容。

- [ ] **Step 4: 提交**

```bash
git add docs/architecture.md
git commit -m "docs(architecture): add § 5.5 tool calling 循环位置 (改进 7)"
```

---

### Task 11: 端到端 smoke（手动可选）

**Goal:** 用 wrangler dev + 真 ANTHROPIC_API_KEY 验证一次 AttributionTask 调用能跑通（可选；Task 8 step 3 已验证 worker 不调 LLM 的路径）。

**Files:**
- 无文件改动

- [ ] **Step 1: 准备 .dev.vars 真 key（用户操作）**

确认 `workers/.dev.vars`：

```
ANTHROPIC_API_KEY=sk-ant-真key
INTERNAL_TOKEN=...
```

如果你不想花钱跑 smoke，跳过此 task —— Task 8 已经验证了 worker boot + 路由分流。

- [ ] **Step 2: 起 wrangler dev**

```bash
pnpm exec wrangler dev --config workers/wrangler.toml --local --persist-to .wrangler-state &
sleep 10
```

- [ ] **Step 3: 调 AttributionTask（multi-step / stream）**

```bash
TOKEN=$(grep '^INTERNAL_TOKEN=' workers/.dev.vars | cut -d= -f2-)
curl -s -N -H "x-internal-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"input":{"question":"翻译：宾语前置是什么？","wrong_answer":"主谓倒装"}}' \
  http://localhost:8787/api/ai/AttributionTask
```

Expected: 看到 streaming 输出（一段一段的文本块，AI SDK data stream 格式）。**注意**：tools 是空 `{}`，所以 AttributionTask 走的是无 tool 单轮。Phase 1a 实施 AttributionTask 的 tools 之后，这里能看到 multi-step 输出。

- [ ] **Step 4: 检查 D1 写入**

```bash
TOKEN=$(grep '^INTERNAL_TOKEN=' workers/.dev.vars | cut -d= -f2-)
curl -s -H "x-internal-token: $TOKEN" http://localhost:8787/api/health
# 确认 db_ok: true
# 然后通过 wrangler d1 命令查 cost_ledger 表
pnpm exec wrangler d1 execute learning-project --local --command 'select task_kind, model, tokens_in, tokens_out from cost_ledger order by occurred_at desc limit 5'
```

Expected: 看到一行 AttributionTask 调用记录（model = claude-sonnet-4-6，tokens > 0）。

- [ ] **Step 5: 关 wrangler dev**

```bash
kill %1
```

- [ ] **Step 6: 不需要 commit**

本 task 仅 smoke 验证，无 file change。

---

## PR 2 完成验收

回到 spec 改进 6/7/8 的 Done 标志，逐条验证：

- [ ] **改进 6（AI Runner）** — `runTask` / `streamTask` 在 `workers/src/ai/runner.ts`；写一条 ToolCallLog + CostLedger 通过 mock 测试验证（`pnpm test` 全绿）
- [ ] **改进 7（tool calling = server）** — architecture.md § 5.5 写明位置；`workers/src/index.ts` 用 `streamText().toDataStreamResponse()` pipe 给 client；`src/ai/client.ts` 接 stream
- [ ] **改进 8（PWA）** — `pnpm build` 输出含 manifest + sw.js；`pnpm dev` 起来后浏览器 devtools application tab 能看到 manifest

---

## Troubleshooting

**Q: `MockLanguageModelV3` 找不到**

A: AI SDK v6 测试 utility 的 import 路径可能是 `'ai/test'` 或 `'@ai-sdk/test'`。试两个；如果还是找不到，回到 vitest `vi.mock('ai', () => ({ generateText: vi.fn(...) }))` 方案。

**Q: streamText().toTextStreamResponse() vs toUIMessageStreamResponse()**

A: AI SDK v6 没有 `.toDataStreamResponse()`。Phase 1 用 `toTextStreamResponse()`（纯文本流）。如果未来要给 UI 消费 tool-call progress / step boundary，切 `toUIMessageStreamResponse()`。

**Q: PWA manifest 在 dev 模式不生效**

A: vite-plugin-pwa 的 dev mode 默认不开 SW。在 `VitePWA({...})` 配置加 `devOptions: { enabled: true }` 调试。

**Q: `streamTask` Response 在 Hono return 后不流**

A: 确认 Hono 没把 Response.body 提前消费；`return stream` 直接 return 就行，不用 `c.body(...)`。

---

## Open Questions（实施时再决）

- ~~AI SDK v6 mock model 实际 import 路径~~ → 已 verify：`MockLanguageModelV3` from `'ai/test'`
- ~~`streamText` Response method~~ → 已 verify：`toTextStreamResponse()`（Phase 1）/ `toUIMessageStreamResponse()`（未来 UI progress）
- `streamText` 在 Workers runtime 上的具体兼容性（特别是 `ReadableStream` 的 transfer 给 Hono）：Task 7/8 verify
- Phase 1 tools registry：Task 8 用空 `{}`，实际工具实现（search_knowledge_by_concept 等）是 Phase 1a feature work
- ToolCallLog 写入是否阻塞 stream：当前 `onStepFinish` 是 async，写入应该 fire-and-forget；如果阻塞 stream，改成 `await Promise.all(writes).catch(...)` 防止失败传播
