# Phase 1a Sub 2 设计 — 录入闭环

> **Master spec**: `docs/superpowers/specs/2026-05-09-phase1a-design.md` § 四 Sub 2（行 212-214）
>
> Sub 1 (PR A + PR B) 已 ship — 知识图谱基础 + 5 类 mutation + KnowledgeReviewTask + UI。Sub 2 把"用户实际录入一道错题"这条线接通，用以驱动 KnowledgeProposeTask inline。

**Goal**：1.5 天，1 PR。完成 `/record` 页 → `POST /api/mistakes` → 同事务建 question + mistake → 异步触发 `KnowledgeProposeTask` 写 dreaming_proposal。Sub 1 的 `/knowledge/proposals` 自然显示新提议；用户可直接 approve/reject。

---

## 一、范围 / 不在范围

| 在 | 不在（推 Sub 3+） |
|---|---|
| 录入页表单：题面 / 参考答案 / 错答 / 知识点 multi-select / cause manual dropdown | 图片录入（VisionExtractTask）— 推 Sub 3 |
| `POST /api/mistakes`：建 question + mistake 行（DB 事务） | 批量录入页 — 推 Phase 2 |
| 录入完成后 inline 调 `KnowledgeProposeTask`（不阻塞 response） | AI 自动 cause（AttributionTask）— 推 Sub 3 |
| `KnowledgeProposeTask` 解析 LLM 输出 → 0-3 条 `propose_new` 写 dreaming_proposal | mistake 详情页 / 编辑页 — 推 Sub 4 |
| 录入页：成功后跳到 `/knowledge/proposals` 看 AI 提议 | mistake 列表页（除 `/_/inspect`）— 推 Sub 4 |
| 录入失败兜底：DB 错回 4xx；AI 失败不阻塞 | 复习闭环 — 推 Sub 4 |

---

## 二、关键决策（lock）

| 决策 | 选择 | 理由 |
|---|---|---|
| Question + Mistake 一次建 | POST 单端点同 D1 batch 建两行 | 简单、原子。用户不会单独建 question；Phase 1a 录入皆 mistake-driven。 |
| Question.kind | 默认 `short_answer`（前端可改） | 文言文录入主要短答；其他 kind 留 dropdown。 |
| Mistake.knowledge_ids | 跟 question.knowledge_ids 同一份 | 录入时 user 仅选一次。Phase 2 拆分 Q vs M tag 时再分。 |
| cause 字段 | Sub 2 强制手动选（10 类 enum）；空着也允许（Sub 3 AI 自动填） | Sub 3 AttributionTask 接 cause 时可识别"待归因"行。 |
| inline KnowledgeProposeTask | `c.executionCtx.waitUntil(...)` 异步触发 | Workers 推荐 pattern；不阻塞 POST response。 |
| Inline 失败兜底 | catch + cost_ledger log + return；不写 dreaming_proposal | mistake 已建好；AI 提议是 nice-to-have。 |
| KnowledgeProposeTask 输出格式 | LLM 直接产 JSON `{proposals: [{name, parent_id, reasoning}]}`（用 prompt 严格约束） | 已注册 `needsToolCall: false` `runTask` 单次返 text；解析后 each 写一条 dreaming_proposal。 |
| 录入页 routing | `/record`（不进主导航，URL 直访；`/_/inspect` 加 link） | 跟 `/knowledge` 一致 — Phase 1a 自用；不做导航。 |
| Auth | 沿用 `internalAuth`（worker `/api/*` 中间件） + 前端 `VITE_INTERNAL_TOKEN` | 已有 pattern。 |
| 提交后 UX | toast "已录入" + 跳 `/knowledge/proposals` | 闭环立竿见影。 |

---

## 三、Server 设计

### 3.1 端点

`POST /api/mistakes`（新建文件 `workers/src/routes/mistakes.ts`）

**Body**（zod 校验）：
```ts
{
  prompt_md: string,        // 题面 markdown，必填非空
  reference_md: string | null,  // 参考答案，可空
  wrong_answer_md: string,  // 错答 markdown，必填非空
  knowledge_ids: string[],  // user 选的知识点 id（≥1）；后端校验都存在且 archived_at IS NULL
  cause: {                  // 手动归因，可 null（Sub 3 AI 兜底）
    primary_category: CauseCategory,  // 10 类 enum
    user_notes: string | null,
  } | null,
  difficulty: number,       // 默认 3，1-5
  question_kind: QuestionKind,  // 默认 'short_answer'
}
```

**Response 200**：
```ts
{
  question_id: string,
  mistake_id: string,
  propose_task: 'queued' | 'skipped'  // 'skipped' 当 ANTHROPIC_API_KEY 缺失或 dev mode
}
```

**错误**：
- 400 `validation_error`：zod 失败 / knowledge_ids 含不存在或 archived 的 / knowledge_ids 空
- 500 `db_error`：D1 batch 失败

### 3.2 D1 写入

```ts
// 在 mistakes.ts 内：
const now = Math.floor(Date.now() / 1000);
const questionId = createId();
const mistakeId = createId();
const insertQuestion = db.prepare(`insert into question (
  id, kind, prompt_md, reference_md, knowledge_ids, difficulty,
  source, variant_depth, created_at, updated_at, version
) values (?, ?, ?, ?, ?, ?, 'manual', 0, ?, ?, 0)`)
  .bind(questionId, body.question_kind, body.prompt_md, body.reference_md,
        JSON.stringify(body.knowledge_ids), body.difficulty, now, now);
const insertMistake = db.prepare(`insert into mistake (
  id, question_id, wrong_answer_md, wrong_answer_image_refs, source,
  knowledge_ids, cause, variants, variants_generated_count, variants_max,
  status, created_at, updated_at, version
) values (?, ?, ?, '[]', 'manual', ?, ?, '[]', 0, 3, 'active', ?, ?, 0)`)
  .bind(mistakeId, questionId, body.wrong_answer_md,
        JSON.stringify(body.knowledge_ids),
        body.cause ? JSON.stringify({...body.cause, ai_analysis_md: '', user_edited: true})
                   : null,
        now, now);
await db.batch([insertQuestion, insertMistake]);
```

注意 `mistake.cause` schema（business.ts L109）：要 `primary_category` + `ai_analysis_md` + `user_edited`。Sub 2 手动录入：`ai_analysis_md = ''`、`user_edited = true`。

### 3.3 Inline KnowledgeProposeTask 触发

在 POST handler 末尾（response 已组装但未返回前）：

```ts
const taskRunFn = async () => {
  try {
    const tree = await loadTreeSnapshot(c.env.DB);  // GET /api/knowledge 复用 query
    const input = {
      mistake_content: {
        prompt_md: body.prompt_md,
        reference_md: body.reference_md,
        wrong_answer_md: body.wrong_answer_md,
        knowledge_ids_picked: body.knowledge_ids,
      },
      tree_snapshot: tree,
    };
    const result = await runTask('KnowledgeProposeTask', input, { env: c.env });
    const parsed = parseProposeOutput(result.text);  // 严格 JSON parse + 校验
    for (const p of parsed.proposals) {
      // 每条 propose_new 写 dreaming_proposal — 复用 PR A writeDreamingProposal
      await writeDreamingProposal(c.env.DB, {
        payload: { mutation: 'propose_new', name: p.name, parent_id: p.parent_id },
        reasoning: p.reasoning,
      });
    }
  } catch (err) {
    console.error('KnowledgeProposeTask failed (mistake still created)', err);
    // cost_ledger 已由 runTask 记。这里 swallow，不写 proposal。
  }
};
c.executionCtx.waitUntil(taskRunFn());
return c.json({ question_id, mistake_id, propose_task: 'queued' });
```

### 3.4 `parseProposeOutput` 解析

LLM 受 prompt 约束输出形如：
```json
{"proposals":[{"name":"之-主谓间用法","parent_id":"seed:wenyan:xuci","reasoning":"该错题..."}]}
```

解析步骤：
1. 截取首个 `{` 到末个 `}`（容错 LLM 加废话）
2. `JSON.parse` 失败 → throw（兜底到外层 catch）
3. zod 校验 `{proposals: z.array(z.object({name: z.string().min(1).max(80), parent_id: z.string().min(1), reasoning: z.string().min(1).max(500)})).max(3)}`
4. 校验 `parent_id` 存在 + archived_at IS NULL（防 LLM 编 id）；不存在的项跳过 + 警告 log
5. 返回剩余 `proposals[]`

### 3.5 GET /api/knowledge 复用

加 `loadTreeSnapshot(db)` helper（in `workers/src/knowledge/tree.ts`）：返 `{ id, name, parent_id, effective_domain }[]` —— 跟 GET /api/knowledge 同 shape。把现有 `knowledge.get('/')` handler 抽出复用。

### 3.6 失败模式

| 场景 | 行为 |
|---|---|
| zod 校验失败 | 400，不入库 |
| knowledge_ids 含不存在 / archived | 400，不入库 |
| D1 batch 失败 | 500，不入库；client 显示错误 |
| KnowledgeProposeTask LLM 失败 | mistake 仍建好；console.error；不写 proposal |
| AI 输出非 JSON 或 schema 不合 | mistake 仍建好；catch + log；不写 proposal |
| AI 生成的 parent_id 不存在 | 跳过该条；其他合规的仍写 |

---

## 四、Client 设计

### 4.1 路由

`/record`（新文件 `src/routes/record.tsx`），mount 在 `App.tsx`：
```tsx
<Route path="/record" element={<RecordMistake />} />
```

`/_/inspect` 顶部 link 行追加 `/record`：
```diff
- Other admin pages: <a href="/knowledge">/knowledge</a> · ...
+ Other admin pages: <a href="/record">/record</a> · <a href="/knowledge">/knowledge</a> · ...
```

### 4.2 表单

简陋单页 form（不拆 component；single-file ~150 行）：

```
┌──────────────────────────────┐
│ 录入错题                       │
├──────────────────────────────┤
│ 题面 (prompt_md)              │  textarea, required
│ ┌──────────────────────────┐  │
│ │                            │  │
│ └──────────────────────────┘  │
│ 参考答案 (reference_md)         │  textarea, optional
│ ┌──────────────────────────┐  │
│ └──────────────────────────┘  │
│ 错答 (wrong_answer_md) *      │  textarea, required
│ ┌──────────────────────────┐  │
│ └──────────────────────────┘  │
│ 题型: [short_answer ▼]         │  select QuestionKind enum
│ 难度: [● ○ ○ ○ ○]               │  radio 1-5, default 3
│ 知识点*: ☐ 实词 ☐ 虚词 ☐ ...   │  checkbox list from GET /api/knowledge
│ 错因（可选）: [▼ 选择... ]      │  select CauseCategory + 留空 = AI 兜底（Sub 3）
│ 备注: [_____________]          │  text, optional, → cause.user_notes
│                              │
│       [提交]   [清空]          │
└──────────────────────────────┘
```

### 4.3 数据流

- `useQuery(['/api/knowledge'])`：拉 tree（同 KnowledgeTree 页面）
- `useMutation` post mistake：
  - body 组装 + POST `/api/mistakes`
  - onSuccess: toast "已录入 ✓ 跳转到提议页..." + `navigate('/knowledge/proposals')`（react-router）
  - onError: toast 错误消息

### 4.4 验证

前端轻校验：
- prompt_md 非空
- wrong_answer_md 非空
- knowledge_ids ≥ 1
- 其他依赖 server zod 兜底

---

## 五、文件 / 模块边界

| 路径 | 责任 | 新建/修改 |
|---|---|---|
| `workers/src/routes/mistakes.ts` | POST 路由 + zod 校验 + D1 batch + 触发 propose | 新 |
| `workers/src/routes/mistakes.test.ts` | 路由单测（mock DB） | 新 |
| `workers/src/knowledge/propose.ts` | `loadTreeSnapshot` + `parseProposeOutput` + `runProposeAndWrite`（包装 runTask + 写 dreaming_proposal） | 新 |
| `workers/src/knowledge/propose.test.ts` | 解析单测 + AI 失败兜底 + parent_id 校验单测 | 新 |
| `workers/src/index.ts` | mount `/api/mistakes` 路由 | 改（+1 行） |
| `workers/src/routes/knowledge.ts` | GET 中提取 `loadTreeSnapshot`（避免重复 query） | 改（refactor，不改语义） |
| `src/routes/record.tsx` | RecordMistake 表单页 | 新 |
| `src/routes/inspect.tsx` | 追加 `/record` link | 改（1 行） |
| `src/App.tsx` | mount `/record` route | 改（1 行 + import） |
| `src/__tests__/record.test.tsx`（如已有 vitest browser）or skip | 表单基础渲染 / 提交后 navigate | 新（如基础设施支持） |

---

## 六、约束 / 不变量

- **录入即建 mistake**：question 不能孤立存在；POST 失败两个都不建（D1 batch 原子）
- **knowledge_ids 必须有效**：至少 1 个、都存在且未 archived；防 LLM 错挂
- **cause 可空**：Sub 2 仅手动；Sub 3 AI 写回会修补
- **AI propose 非阻塞**：`waitUntil` 让 response 立即返
- **AI propose 失败不影响 mistake**：try/catch swallow
- **复用 PR A `writeDreamingProposal`**：不重写
- **复用 PR A `internalAuth`**：mistakes 路由自动套上

---

## 七、估时 / PR

| 段 | 任务 | 估时 |
|---|---|---|
| Server | mistakes route + tests / propose helper + tests / mount + tree refactor | ~0.7d |
| Client | record.tsx / 接 useMutation / inspect link / route mount | ~0.6d |
| 联调 / TDD 修复 | mock D1 / verify propose flow | ~0.2d |
| **合计** | | **~1.5d** |

**1 个 PR**：`feat(record): mistake 录入闭环 + KnowledgeProposeTask inline trigger`

---

## 八、Open（实施时再定）

1. **propose 输入 token 大小**：tree 当前 7 顶级，未来 expand 可能上百节点。Sub 2 不做截断；Sub 3 / Phase 2 加裁剪策略（如限 mistake 关联节点的 ancestors + siblings + 2 跳）。
2. **多次提交时 dedup**：用户连续录两条相似 mistake，可能产生重复 propose。Sub 2 不 dedup（一条一条审无负担）；KnowledgeReviewTask（PR B 已 ship）会兜底合并。
3. **/record 不进主导航**：跟 /knowledge 一致；Phase 2 加首页 navigation 时再统一处理。
