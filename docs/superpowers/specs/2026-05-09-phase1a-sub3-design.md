# Phase 1a Sub 3 设计 — AttributionTask AI 接通

> **Master spec**: `docs/superpowers/specs/2026-05-09-phase1a-design.md` § 二 Sub 3（行 216-219）
>
> Sub 1 + Sub 2 已 ship — 知识图谱 5 类 mutation + KnowledgeReviewTask + 录入闭环 + KnowledgeProposeTask inline + 图字段。Sub 3 把 cause 从手填变成可选 AI 自动归因。

**Goal**：1.5 天，1 PR。POST /api/mistakes 时若 `cause === null` → `c.executionCtx.waitUntil` 异步跑 AttributionTask 写回 mistake.cause。新增 `/mistakes` 页给用户看到 cause 出现。失败兜底：cause 留 null + log。

---

## 一、范围 / 不在范围

| 在 | 不在（推 Sub 4+） |
|---|---|
| AttributionTask 单 shot LLM 调用（无 tools，Phase 1a tools registry 还没建） | 多模态归因（带图）— 推 Phase 2 |
| 解析 LLM 输出 → zod 校验 → optimistic `update mistake set cause` | 用户编辑 / 推翻 AI 归因 — 推 Sub 4 |
| GET /api/mistakes/recent（list 最近 N 条带 cause） | mistake 详情页 / 编辑页 — 推 Sub 4 |
| `/mistakes` 列表页：cause badge / "归因中..." / "待归因"（null 兜底） | mistake 删除 / archive — 推 Phase 2 |
| `/record` 提交后 navigate 到 `/mistakes`（用户立即看到自己刚录的 + AI cause 滚动出现） | dreaming_proposal kind='attribution_pending' 队列 — Sub 3 不做（cause 留 null 等 Sub 4 编辑 UI） |
| TanStack Query refetchInterval 5s，仅在有 null cause 行时轮询 | 通知 / push — 推 Phase 2 |

**spec 偏离**：master spec § 二 Sub 3 提"失败兜底：mistake.cause 留空 + 写「待人工归因」队列（用 dreaming_proposal kind='attribution_pending' 或独立 mistake 字段）"。Sub 3 选择**仅 cause 留 null + log**，不写 dreaming_proposal — 因为：(a) UI 已经把 null cause 显示为"待归因"，无需独立队列; (b) Sub 4 复习闭环会带 mistake 编辑功能，用户届时可手填; (c) dreaming_proposal 已经被 knowledge mutation 占用，混入 attribution_pending 让 /knowledge/proposals 视图复杂。

---

## 二、关键决策（lock）

| 决策 | 选择 | 理由 |
|---|---|---|
| AttributionTask 调用模式 | 单 shot via `runTask`（registry 改 `needsToolCall: false`） | Phase 1a tools registry 还没建；6 个 allowedTools 是 Phase 2 蓝图。pure JSON 输出最简单。 |
| 触发时机 | POST /api/mistakes 时若 `body.cause === null` → `waitUntil(runAttributionAndWrite)` 跟现有 runProposeAndWrite 并发 | 复用 Sub 2 已建好的 waitUntil 模式 |
| LLM 输入 | `{prompt_md, reference_md, wrong_answer_md, knowledge_context: [{id, name, effective_domain}]}` | 仅传用户 picked 的 knowledge node 信息（不传整 tree — token 友好）|
| LLM 输出格式 | 严格 JSON: `{primary_category, secondary_categories[], ai_analysis_md, confidence}` | 复用 src/core/schema/business.ts `Cause` 子集 |
| 解析 + 校验 | `parseAttributionOutput` 仿 Sub 2 `parseProposeOutput`：截 `{...}` + zod parse Cause subset | 一致的 error handling pattern |
| DB 写入 | `update mistake set cause = ?, version+1 where id = ? and version = ? and cause is null` | 乐观锁 + cause is null 防覆盖用户后填 |
| 失败兜底 | try/catch swallow + console.error + cost_ledger 自动记 | 跟 Sub 2 runProposeAndWrite 一致 |
| 新页 routing | `/mistakes` 不进主导航；`/_/inspect` 加 link | 跟 /record / /knowledge 一致 |
| /record 提交后跳转 | 改为 `/mistakes`（之前是 `/knowledge/proposals`） | 让用户立即看到自己刚录的 + AI cause appearing |
| Polling 策略 | TanStack Query `refetchInterval: 5000`，仅当列表有 null cause 时启用；全部归因完后停 | 自用 1-2 人，5s 够；不浪费请求 |

---

## 三、Server 设计

### 3.1 端点

`GET /api/mistakes/recent?limit=20`（在 `workers/src/routes/mistakes.ts` 新增 GET handler）

**Response 200**：
```ts
{
  rows: Array<{
    id: string;
    question_id: string;
    prompt_md: string;          // 截 200 字符 preview
    wrong_answer_md: string;    // 截 200 字符
    knowledge_ids: string[];
    cause: Cause | null;        // null = 归因中或失败
    created_at: number;
  }>;
}
```

`limit` zod 校验：默认 20，最大 100。

SQL：
```sql
select m.id, m.question_id, m.knowledge_ids, m.cause, m.created_at,
       q.prompt_md, m.wrong_answer_md
from mistake m
join question q on q.id = m.question_id
where m.archived_at is null and m.deleted_at is null
order by m.created_at desc
limit ?
```

prompt_md / wrong_answer_md 在 worker 里 `slice(0, 200)` 后返。

### 3.2 AttributionTask wire

新文件 `workers/src/knowledge/attribute.ts`：

```ts
export interface AttributionInput {
  prompt_md: string;
  reference_md: string | null;
  wrong_answer_md: string;
  knowledge_context: Array<{ id: string; name: string; effective_domain: string | null }>;
}

export interface RunAttributionAndWriteParams {
  db: D1Database;
  mistakeId: string;
  expectedVersion: number;
  input: AttributionInput;
  runTaskFn: (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;
  env?: unknown;
}

export async function runAttributionAndWrite(params: ...): Promise<void> {
  try {
    const result = await params.runTaskFn('AttributionTask', params.input, { env: params.env });
    const cause = parseAttributionOutput(result.text);  // 含 zod 校验
    const causeJson = JSON.stringify({
      primary_category: cause.primary_category,
      secondary_categories: cause.secondary_categories,
      ai_analysis_md: cause.ai_analysis_md,
      confidence: cause.confidence,
      user_edited: false,
    });
    const now = Math.floor(Date.now() / 1000);
    const update = await params.db
      .prepare(`update mistake set cause = ?, updated_at = ?, version = version + 1
                where id = ? and version = ? and cause is null`)
      .bind(causeJson, now, params.mistakeId, params.expectedVersion)
      .run();
    const changes = (update as { meta?: { changes?: number } }).meta?.changes ?? 0;
    if (changes !== 1) {
      console.warn(`runAttributionAndWrite: skipped (cause already set or version mismatch) for ${params.mistakeId}`);
    }
  } catch (err) {
    console.error('runAttributionAndWrite: failed', err);
  }
}
```

`parseAttributionOutput` 使用 zod schema：

```ts
const AttributionOutputSchema = z.object({
  primary_category: CauseCategory,
  secondary_categories: z.array(CauseCategory).default([]),
  ai_analysis_md: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
});
```

### 3.3 Registry 更新（src/ai/registry.ts）

```diff
 AttributionTask: {
   ...
-  needsToolCall: true,
+  needsToolCall: false,
   isMultimodal: false,
-  allowedTools: [
-    'search_knowledge_by_concept',
-    ... 6 个 tool ...
-  ],
+  allowedTools: [],
   systemPrompt:
-    '你是错题归因助手。给定一道做错的题、用户的错答和参考答案，分析错因并选择最匹配的知识点。错因从 10 类中选...',
+    '你是错题归因助手。给定一道做错的题、用户的错答、参考答案和已挂的知识点上下文，分析错因。\n输出严格 JSON 格式（不带 markdown 代码块包裹）：\n{"primary_category": "<10 类之一>", "secondary_categories": [...], "ai_analysis_md": "<分析过程，含错答与参考答案差异 + 涉及的知识点 / 概念>", "confidence": 0.0-1.0}\n10 类 cause: concept | knowledge_gap | calculation | reading | memory | expression | method | carelessness | time_pressure | other。低信心走 other + 详细 ai_analysis_md。',
 },
```

### 3.4 POST /api/mistakes 触发

在现有 POST handler，紧跟 `c.executionCtx.waitUntil(runProposeAndWrite(...))` 后追加：

```ts
if (body.cause === null) {
  c.executionCtx.waitUntil(
    runAttributionAndWrite({
      db: c.env.DB,
      mistakeId,
      expectedVersion: 0,  // 刚 insert，version=0
      input: {
        prompt_md: body.prompt_md,
        reference_md: body.reference_md,
        wrong_answer_md: body.wrong_answer_md,
        knowledge_context: pickedNodes.map((n) => ({ id: n.id, name: n.name, effective_domain: n.effective_domain })),
      },
      runTaskFn: async (kind, input, ctx) => {
        const result = await runTask(kind, input, ctx as { env: typeof c.env });
        return { text: result.text };
      },
      env: c.env,
    }),
  );
}
```

`pickedNodes` 通过 loadTreeSnapshot 后 filter 得到（避免再查 DB）。

### 3.5 失败模式

| 场景 | 行为 |
|---|---|
| AttributionTask LLM 失败 | console.error；mistake.cause 仍 null；前端显"待归因" |
| LLM 输出非 JSON / schema 不合 | console.error；cause 仍 null |
| `update mistake` changes=0（用户已编辑了 cause / mistake 删了） | console.warn；不报错 |
| GET /api/mistakes/recent SQL 失败 | 500 onError middleware |

---

## 四、Client 设计

### 4.1 路由

`/mistakes`（新文件 `src/routes/mistakes-list.tsx`），mount 在 `App.tsx`：
```tsx
<Route path="/mistakes" element={<MistakesList />} />
```

`/_/inspect` link 行追加 `/mistakes`：
```diff
- <a href="/record">/record</a> · <a href="/knowledge">/knowledge</a> · <a href="/knowledge/proposals">/knowledge/proposals</a>
+ <a href="/record">/record</a> · <a href="/mistakes">/mistakes</a> · <a href="/knowledge">/knowledge</a> · <a href="/knowledge/proposals">/knowledge/proposals</a>
```

### 4.2 列表 UI

```
┌──────────────────────────────────┐
│ 错题列表（最近 20 条）            │
│ AI 归因中: 2 / 已归因: 18         │
├──────────────────────────────────┤
│ #1 2026-05-09 18:32                │
│ 题: "之"在主谓之间... [短答]       │
│ 错答: 助词                          │
│ 标签: 虚词 [wenyan]                 │
│ 错因: [归因中...] (黄色 spinner)    │
├──────────────────────────────────┤
│ #2 2026-05-09 18:25                │
│ ...                                │
│ 错因: concept (蓝色 badge) - 用户...│
│  ai_analysis_md preview            │
└──────────────────────────────────┘
```

cause 状态徽章：
- `null` → 灰色 "待归因 / 归因中..."（区分：null 且 created < 30s 前 → "归因中"；> 30s → "待归因（AI 失败，可手动）"）
- `cause.user_edited === true` → 绿色 "用户填" + primary_category
- `cause.user_edited === false` → 蓝色 "AI" + primary_category + confidence%

### 4.3 数据流

- `useQuery({ queryKey: ['/api/mistakes/recent'], queryFn: fetchRecentMistakes, refetchInterval: hasNullCause ? 5000 : false })`
- `hasNullCause` 由 `data?.rows.some(r => r.cause === null)` 派生
- 全部归因完毕 → refetchInterval 自动停（`useQuery` rerender 时触发）

### 4.4 /record 提交跳转改

```diff
- navigate('/knowledge/proposals');
+ navigate('/mistakes');
```

`/mistakes` 页头部加 link "查看 AI 知识点提议 →" 指向 `/knowledge/proposals`，保留旧路径可达性。

---

## 五、文件 / 模块边界

| 路径 | 责任 | 新建/修改 |
|---|---|---|
| `workers/src/knowledge/attribute.ts` | `runAttributionAndWrite` + `parseAttributionOutput` | 新 |
| `workers/src/knowledge/attribute.test.ts` | 解析 + 写入 + 失败兜底 + cause-already-set guard | 新 |
| `workers/src/routes/mistakes.ts` | 加 GET `/recent`；POST 末尾触发 attribution | 改 |
| `workers/src/routes/mistakes.test.ts` | GET 列表 + POST 触发 attribution（waitUntilFns 计数从 1 → 1 或 2） | 改 |
| `src/ai/registry.ts` | AttributionTask 改 `needsToolCall: false`，allowedTools=[]，systemPrompt 改 JSON 输出约束 | 改 |
| `src/routes/mistakes-list.tsx` | `<MistakesList>` 列表页 | 新 |
| `src/App.tsx` | mount `/mistakes` | 改 |
| `src/routes/inspect.tsx` | 链 `/mistakes` | 改 |
| `src/routes/record.tsx` | navigate target 改 `/mistakes` | 改 |

---

## 六、约束 / 不变量

- **AttributionTask 不阻塞 POST 响应**：waitUntil + 永远 swallow
- **乐观锁防覆盖用户填的 cause**：`update ... where cause is null`
- **和 KnowledgeProposeTask 并发**：两个 waitUntil 同时跑；互不影响（不同 DB row）
- **registry needsToolCall 改回 true 时不会破坏 Sub 3**：runTask 不查 needsToolCall（仅 `app.post('/api/ai/:task')` 路由用）— 但 Sub 3 直接 import runTask，所以无影响
- **Cause user_edited=false 标记 AI 写入**：UI 据此区分 AI / 人填

---

## 七、估时 / PR

| 段 | 任务 | 估时 |
|---|---|---|
| Server | attribute.ts + tests / mistakes.ts GET + POST 触发 / registry update | ~0.6d |
| Client | mistakes-list.tsx / route mount / inspect link / record navigate | ~0.5d |
| 联调 / TDD 修复 | mock D1 / verify dual waitUntil | ~0.4d |
| **合计** | | **~1.5d** |

**1 个 PR**：`feat(attribution): AttributionTask AI 自动归因 + /mistakes 列表`

---

## 八、Open（实施时再定）

1. **Concurrency 问题**：用户连续录两条 mistake，两个 waitUntil 各自跑 AttributionTask — 总 LLM 请求数加倍。Phase 1a 自用无并发问题；Phase 2 加 batch 或 queue。
2. **AI 失败重试**：当前 swallow 后 cause 永远 null。Sub 4 加"重试 AI 归因"按钮（手触发）。
3. **prompt_md preview 截断 200 字符**：可能截到 markdown 中间断裂。Phase 2 加 markdown-aware 截断。Phase 1a 自用 OK。
4. **AI cause confidence < 0.3 时怎么办**：当前都接受。可选：confidence < 0.3 时拒写 + cause 留 null（让用户手填）。Phase 1a 不做，先看实际表现。
