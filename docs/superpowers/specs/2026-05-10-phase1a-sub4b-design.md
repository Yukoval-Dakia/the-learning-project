# Phase 1a Sub 4B 设计 — LearningItem 三态 + CompletionEvidence

> **Master spec**: `docs/superpowers/specs/2026-05-09-phase1a-design.md` § 二 Sub 4 后半
>
> **Sub 4 拆分**：
> - Sub 4A（已 ship PR #15）：Mistake FSRS 复习闭环 + review_event log + /review UI
> - **Sub 4B（本文）**：LearningItem 三态状态机 + CompletionEvidence 写入路径 + /learning-items UI
> - Sub 5（后续）：JSON / CSV 数据导出
>
> **Phase 1a 闭环**：录入 → 归因 → 复习（4A）→ **学习项跟踪**（4B）→ 数据导出（5）。

**Goal**：1 天 / 1 PR。让用户能记录"想学什么 / 正在学什么 / 学完什么"。三态状态机：`pending → in_progress → done`；`done` 时必写一条 `completion_evidence`（self_declare 路径）作为证据留痕。

**为什么先做 4B**：Sub 4A 跑出错题复习数据后，"想主动学新东西"的入口缺失——没有正式承载体。LearningItem 是这个承载，且 CompletionEvidence 给未来 ai_propose / quiz_pass 路径预留接口（Phase 2 LearningIntent Orchestrator + JudgeRouter 接通时直接复用）。

---

## 一、范围 / 不在范围

| 在 | 不在（推 Phase 1b/2） |
|---|---|
| LearningItem CRUD：create / list / update / status transition | AI 自动生成 LearningItem（dreaming/learning_intent，Phase 2） |
| 三态状态机：`pending → in_progress → done`（含跳过 in_progress 直接 done）+ 反向 done → in_progress（重学） | 6 状态全开（dismissed / resting / archived 仅 schema 保留） |
| `completion_evidence.path = 'self_declare'` 路径写入 | `ai_propose` / `quiz_pass` 路径（依赖 dreaming / JudgeRouter） |
| 知识点关联（multi-select 复用 /record + /ingest 的 knowledge picker） | hub / atomic LearningItem 层级 UI（Phase 2 LearningIntent Orchestrator） |
| `/learning-items` 极简列表 + 状态筛选 + 内联编辑 | Note Artifact 自动生成 / embedded check（Phase 2） |
| 软删除：archive 操作 → status='archived' + archived_at | StudyLog 多对一关联（Phase 2 progress 模块） |
| 沿用 Sub 2/3/4A 模式：zod Body / 乐观锁 version / IIFE waitUntil（这次没有 LLM，所以无 waitUntil） | 复杂查询 / 全文搜索 / 批量操作 |

---

## 二、关键决策（lock）

| 决策 | 选择 | 理由 |
|---|---|---|
| 不改 schema | `learning_item` 和 `completion_evidence` 表已在 0001 migration 落地（Phase 1 PR 1），enum 也已 ship | 仅需 wire endpoints + UI；零 migration |
| 三态范围 | `pending / in_progress / done` 走通；`dismissed / resting / archived` 留 enum 但 UI 不暴露 | YAGNI；Phase 2 真用到再开 |
| 完成判定 path | 仅 `self_declare`（用户点"我学完了"按钮） | `ai_propose` 推 Phase 2，`quiz_pass` 推 Phase 1b（依赖 JudgeRouter） |
| Done → completed_at | UPDATE 时 set `completed_at = now`；反向 in_progress 时 set null | 跟 Schema 字段语义对齐 |
| 写 completion_evidence 的时机 | 仅在 status 转入 `done` 时写一条 | 复学（done → in_progress）不删旧 evidence，留痕 |
| 重学（done → in_progress） | UPDATE status + completed_at=null；**保留旧 completion_evidence 行**作为历史 | append-only audit 与 4A review_event 同语义 |
| evidence_json 内容 | `{ declared_at, user_notes?: string }` | self_declare 路径只有这俩字段；ai_propose/quiz_pass 时再加更复杂结构 |
| List 排序 | `status` 优先（pending → in_progress → done）；同 status 按 `updated_at desc` | 让"待办在前，已完成在后"的直觉对齐 |
| List 默认筛选 | 所有非 archived | 自用单人量级小 |
| 创建路径 | `/learning-items` 顶部内联表单（title + content + knowledge_ids） | 不需要单独创建页 |
| user_pinned 字段 | 留 schema，UI 不暴露 | YAGNI |
| ai_score / due_at / reviewed_at | 留 schema，UI 不暴露 | Phase 2 dreaming/orchestrator 要用 |
| 鉴权 | x-internal-token，沿用其他 admin 路由 | 一致 |

---

## 三、Server 设计

### 3.1 端点

#### `GET /api/learning-items`

Query params:
- `status?: 'pending' | 'in_progress' | 'done'` — 单档筛选
- `limit?: number` — default 50, max 200

Behavior：默认返非 archived/dismissed 的所有项；按 `status_priority asc, updated_at desc` 排（status_priority 用 `case` SQL）。

```sql
select id, title, content, knowledge_ids, status, completed_at,
       created_at, updated_at, version
from learning_item
where archived_at is null and status != 'dismissed'
  and (? is null or status = ?)
order by case status
  when 'pending' then 0
  when 'in_progress' then 1
  when 'done' then 2
  else 3
end asc, updated_at desc
limit ?
```

Response: `{ rows: Array<LearningItem subset> }`。

#### `POST /api/learning-items`

Body:
```ts
{
  title: string;        // 1-200 chars
  content?: string;     // default ''
  knowledge_ids?: string[];  // default []，可空
}
```

Behavior：
1. zod parse → 400 on fail
2. 校验 knowledge_ids 全部存在 + non-archived（沿用 mistakes.ts assertKnowledgeIdsExist 模式）
3. INSERT learning_item with status='pending', source='manual', version=0
4. Return `{ id, ...row }`

#### `PATCH /api/learning-items/:id`

Body:
```ts
{
  title?: string;
  content?: string;
  knowledge_ids?: string[];
  status?: 'pending' | 'in_progress' | 'done';
  user_notes?: string;  // only used when transitioning to done; written into evidence_json
}
```

Behavior：
1. zod parse → 400
2. Load row by id; 404 if missing or archived
3. 校验 status transition：
   - `pending → in_progress | done` ✓
   - `in_progress → done | pending` ✓（pending = 撤回到待办）
   - `done → in_progress` ✓（重学）
   - 其他组合 → 400 `invalid_transition`
4. 如果 knowledge_ids 改了，校验存在
5. 计算 transition：
   - 转入 `done`: set `completed_at = now`, also queue completion_evidence INSERT
   - 转出 `done`（done → in_progress）: set `completed_at = null`，**不删旧 evidence**
   - 其他不动 completed_at
6. **D1 batch**（与 Sub 4A `review_event` 同模式）：
   - Stmt 0: UPDATE learning_item with optimistic lock `where id = ? and version = ?`
   - Stmt 1（仅当转入 done 时）: INSERT completion_evidence
7. 检查 batch[0].meta.changes:
   - `=== 1` → 200 + 新行
   - `=== 0` → 409 Conflict (并发修改)；如果有 evidence INSERT 它仍提交作 audit-only orphan，跟 Sub 4A 模式一致

Response: `{ id, ...updated row }` 或 `{ error: 'conflict', ... }` / `{ error: 'invalid_transition', from, to }`.

#### `DELETE /api/learning-items/:id`

软删 — UPDATE set `archived_at = now`, `archived_reason = 'user'`, `version + 1`. 乐观锁需带 If-Match 或 query param `version`，避免覆盖。简化：客户端先 GET 拿 version，DELETE 带 query `?version=N`。

Behavior：
1. 200 on success
2. 404 if not found / already archived
3. 409 if version mismatch

### 3.2 文件

| 路径 | 责任 | 新建/修改 |
|---|---|---|
| `workers/src/routes/learning_items.ts` | 4 个 handler（GET / POST / PATCH / DELETE）+ helpers | 新 |
| `workers/src/routes/learning_items.test.ts` | mockEnv + 全流程测试 | 新 |
| `workers/src/index.ts` | mount `/api/learning-items` | 改 |

### 3.3 失败模式

| 场景 | 行为 |
|---|---|
| zod body invalid | 400 `validation_error` |
| 未知 knowledge_id | 400 `validation_error` 含具体 id |
| GET status filter 不在 enum | 400（zod 已校验） |
| PATCH status transition 不合法 | 400 `invalid_transition` |
| version 不匹配 | 409 `conflict`；如果有 evidence stmt 仍提交（与 4A audit-only 同语义） |
| evidence_json 体积过大 | 不刻意 cap，self_declare 文本最多用户 notes 几百字 |
| 不存在的 learning_item_id | 404 |

---

## 四、Client 设计

### 4.1 路由

`/learning-items` 新页 `src/routes/learning-items.tsx`，挂在 `App.tsx`。`/_/inspect` 加链接。

### 4.2 数据流

- `useQuery({ queryKey: ['/api/learning-items', statusFilter] })` — refetch on status filter change
- 创建：`useMutation` POST → onSuccess invalidate
- 编辑：`useMutation` PATCH → onSuccess invalidate
- 软删：`useMutation` DELETE → invalidate

### 4.3 UI

```
┌──────────────────────────────────────┐
│ 学习项                                 │
│ [全部] [待办] [进行中] [已完成]         │  ← status 筛选 tabs
├──────────────────────────────────────┤
│ + 新增                                 │
│ ┌─────────────────────────────────┐  │
│ │ 标题: ___________________        │  │
│ │ 备注 (可空): _________________   │  │
│ │ 知识点: [k1 ✓] [k2 ✓] ...        │  │
│ │ [创建]                           │  │
│ └─────────────────────────────────┘  │
├──────────────────────────────────────┤
│ ⚪ 待办  虚词的活用                    │
│   2026-05-10 创建 · 知识点: 虚词       │
│   [开始学] [详情]                     │
├──────────────────────────────────────┤
│ 🟡 进行中  之于的用法                 │
│   2026-05-09 开始 · 知识点: 虚词       │
│   备注: 看了一篇 stackoverflow ...    │
│   [我学完了] [改回待办] [详情]        │
├──────────────────────────────────────┤
│ ✅ 已完成  古今异义词整理              │
│   2026-05-08 完成 · 知识点: 实词        │
│   [重学] [详情]                       │
└──────────────────────────────────────┘
```

每张卡片：
- Status badge（圆点 + 颜色）
- 标题（点击展开 details）
- Meta: 创建/开始/完成日期 + knowledge_ids tags
- 内联状态转换按钮（pending→开始学 / in_progress→我学完了 + 改回待办 / done→重学）
- 详情：展开 content textarea（可编辑；inline patch on blur OR 保存按钮）

#### 转 done 时的 user_notes prompt

点击"我学完了" → 弹出 inline prompt 让用户写一句话总结（可空）→ 提交 PATCH with `status: 'done', user_notes: '...'`. notes 写进 `completion_evidence.evidence_json.user_notes`。

#### 软删

Card 角落小 × 按钮 → confirm("删除这条?") → DELETE `?version=N`。

### 4.4 文件

| 路径 | 责任 | 新建/修改 |
|---|---|---|
| `src/routes/learning-items.tsx` | `<LearningItems>` 列表 + 筛选 + 创建 + 状态转换 + 软删 | 新 |
| `src/App.tsx` | mount `/learning-items` | 改 |
| `src/routes/inspect.tsx` | 加链接 | 改 |

---

## 五、约束 / 不变量

- **Status transition 严格**：只允许 spec § 3.1 PATCH 步骤 3 列出的转换；其他 400。
- **completion_evidence append-only**：与 4A review_event 同语义，每次进入 `done` 写新行；重学不删旧行。
- **D1 batch 原子性**：UPDATE + INSERT evidence 同 batch（与 4A 同模式）；版本不匹配的 409 仍可留 audit-only orphan evidence（罕见但允许）。
- **completed_at 与 status 一致**：status='done' ↔ completed_at != null；其他 status ↔ completed_at = null（PATCH 内统一管理，不让 client 直接传 completed_at）。
- **archived 软删不可逆**：UPDATE archived_at + archived_reason；不开恢复 UI（Phase 2 维护页才有）。
- **knowledge_ids 校验存在**：写入路径必须 verify against `knowledge` table 非 archived（沿用 mistakes.ts 模式）。
- **乐观锁 version**：所有 UPDATE / DELETE 必带 `where version = ?`；mismatch 返 409。

---

## 六、估时 / PR

| 段 | 任务 | 估时 |
|---|---|---|
| Server | learning_items.ts 4 handler + tests（GET 3 测 + POST 4 测 + PATCH 8 测含 transition / done audit-orphan / 409 + DELETE 3 测） | ~0.5d |
| Client | learning-items.tsx 列表 + 筛选 + 创建 + 状态按钮 + 软删 + done notes prompt | ~0.4d |
| 整合 | route mount / inspect link / 跑通 | ~0.1d |
| **合计** | | **~1d** |

**1 个 PR**：`feat(learning-items): Phase 1a Sub 4B — three-state lifecycle + completion_evidence (self_declare)`

---

## 七、Open（实施时再决）

1. **inline edit vs separate edit form**：先用 inline blur=save。如果体验差再加 modal。
2. **PATCH status='done' 时的 user_notes prompt UX**：用 `window.prompt` 还是自定义弹窗？MVP 用 `window.prompt`（一行简单输入）。
3. **DELETE 版本冲突的客户端处理**：onError 提示"刷新后再试"，让用户手动 refetch（同 4A 复习冲突逻辑）。
4. **List 上限 max=200**：如果用户真有 >200 个学习项，先要分页（Phase 2）。自用初期不会到。
5. **status 筛选 tabs 的 URL 持久化**：暂不做（query param）；URL 不持有 filter，刷新回到默认"全部"。
6. **completion_evidence 看历史的 UI**：Phase 2 学习时间线视图才有；4B 不暴露（写就够了）。
7. **重学时是否 reset 任何 mistake.fsrs_state**：不（学习项和错题不直接绑）。Sub 4A 已经独立调度错题。
