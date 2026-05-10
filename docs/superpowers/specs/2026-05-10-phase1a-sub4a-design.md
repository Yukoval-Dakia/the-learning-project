# Phase 1a Sub 4A 设计 — Mistake FSRS 复习闭环 + review_event

> **Master spec**: `docs/superpowers/specs/2026-05-09-phase1a-design.md`（Sub 4 整体）
> Sub 1-3 + Phase 1.5 已 ship（PR #6-#13）。Sub 4 拆为：
> - **4A（本文）**：Mistake FSRS 复习 + 行为日志 + 极简 /review UI
> - **4B（后续 spec）**：LearningItem 三态状态机 + CompletionEvidence 写入路径
> - **5（后续）**：JSON / CSV 数据导出

**Goal**：1.5 天 / 1 PR。让用户能每天打开 `/review`，看到 due 的错题串行做一遍，键盘 1/2/3 投票，背后用 `ts-fsrs` 跑标准 FSRS 调度，每次复习写一条 `review_event` 行为日志。

**为什么先做 4A**：Phase 1a 目标是"自用一周备文言文跑出第一批数据"。没有复习闭环，AttributionTask 的 cause 分布合理性、文言文场景下 FSRS 默认参数适配性、vision_single OCR 准确率——三个关键风险都不能验证。

---

## 一、范围 / 不在范围

| 在 | 不在（推 4B / Phase 2） |
|---|---|
| `mistake.fsrs_state` 用 `ts-fsrs` 库做调度（不自己实现） | 错因（cause）差异化复习权重 / mastery 衰减自定义曲线 |
| `review_event` 单独一张表，append-only，结构化 + before/after JSON | "复习 session" 容器（多题打包成 standalone tool_quiz） |
| `GET /api/review/due` — 返到期 + 从未复习的 mistake 列表 | 自动判分（exact/keyword/semantic JudgeRouter）→ Phase 1b |
| `POST /api/review/submit` — 接收 rating，乐观更新 fsrs_state，写 review_event | UserAppeal 翻盘流程（依赖 Judge）→ Phase 1b |
| `/review` 极简 UI：单题串行 / 键盘 1/2/3 / 显示题面+错因+知识点 / 可选 response_md | 仪式感 SRS（卡片翻转动画 / 进度条 / "今日已学 X min"）→ Phase 2 |
| 沿用 Sub 2/3 错误模式：zod Body / 乐观锁 version 字段 / Hono onError 兜底 | mastery 反馈喂 base_mastery（依赖判分）→ Phase 1b |
| 不实测的可观测：每条 review_event 的 latency_ms 字段 |  cost_ledger 维度审计 dashboard → 之后做 |
| LearningItem 完成判定 → Sub 4B；本 PR 不动 LearningItem 表 | 复习推迟 / 跳过 / 标记"作废错题"等编辑能力 → Phase 2 |

---

## 二、关键决策（lock）

| 决策 | 选择 | 理由 |
|---|---|---|
| FSRS 实现 | OSS `ts-fsrs` (^4.x，npm 维护活跃) | 不自己实现；FSRS-4.5 / FSRS-5 算法社区版 |
| FSRS 应用范围 | 仅 Mistake；不调度 LearningItem | 错题适合"间隔复习"；学习项是"完成 / 复学"两态 |
| Rating 映射 | `incorrect → Again` / `partial → Hard` / `correct → Good` | 跟 Sub 1b 计划的 JudgeKind 对齐；Easy 暂不暴露（避免高估） |
| `mistake.fsrs_state` schema | 改 `FsrsState` zod 对齐 ts-fsrs `Card` 字段（due / stability / difficulty / elapsed_days / scheduled_days / reps / lapses / state / last_review） | 不 wrap；JSON 字段直接存 ts-fsrs 序列化形态 |
| review_event 表 | 单独表，**append-only**（无 update / delete） | 行为日志；将来要训练 / 替换调度器靠它 |
| review_event 字段 | `id, mistake_id, rating, response_md, latency_ms, fsrs_state_before (json), fsrs_state_after (json), due_at_before, due_at_next, created_at` | 结构化 + 全量 before/after 双 JSON snapshot；不丢任何信号 |
| 复习触发频率 | 用户主动打开 `/review`，无 push / 通知 | 自用 phase 1a 不做 notification |
| Due 排序 | `fsrs_state IS NULL`（never reviewed）优先，然后按 `fsrs_state.due` ASC | 新错题先暴露；老错题按 due 时间 |
| 一次返回数量 | 默认 20，最大 50 | 自用单人 1 天复习量上限内 |
| Submit 并发安全 | 乐观锁 `mistake.version` | 跟 Sub 3 attribution 写 cause 同模式 |
| Latency 测量 | 客户端记录"首次显示题面"→"点击 rating"耗时（毫秒），随 submit body 上报 | 服务器不可信任地计算 latency；客户端测对将来分析够用 |
| Response 文本 | 可空；rating 是必填，response_md 是可选证据 | 用户可不写答案（脑内复习），但存下答案对将来分析有用 |
| /review 走 internal-token 鉴权 | 跟其他 admin 路由一致（x-internal-token header） | Sub 1-3 已建好的 pattern |

---

## 三、Server 设计

### 3.1 Schema

**新增表 `review_event`**（drizzle 0004 migration）：

```ts
export const review_event = sqliteTable('review_event', {
  id: text('id').primaryKey(),
  mistake_id: text('mistake_id').notNull(),
  rating: text('rating').notNull(), // 'again' | 'hard' | 'good'
  response_md: text('response_md'),
  latency_ms: integer('latency_ms'),
  fsrs_state_before: text('fsrs_state_before', { mode: 'json' }), // null = never-reviewed before this event
  fsrs_state_after: text('fsrs_state_after', { mode: 'json' }).notNull(),
  due_at_before: integer('due_at_before', { mode: 'timestamp' }), // null on first review
  due_at_next: integer('due_at_next', { mode: 'timestamp' }).notNull(),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
});
```

**Append-only**：no `version`, no `updated_at`. 行为日志的不可变性是 schema 设计的一部分。

**修改 `FsrsState` zod**（`src/core/schema/business.ts`）—— 对齐 `ts-fsrs` `Card`：

```ts
export const FsrsRating = z.enum(['again', 'hard', 'good']);
export const FsrsCardState = z.enum(['new', 'learning', 'review', 'relearning']);

export const FsrsState = z.object({
  due: z.coerce.date(),
  stability: z.number(),
  difficulty: z.number(),
  elapsed_days: z.number(),
  scheduled_days: z.number(),
  reps: z.number().int(),
  lapses: z.number().int(),
  state: FsrsCardState,
  last_review: z.coerce.date().nullable(),
});
```

旧 `FsrsState`（due_at / interval / ease / repeat / lapses / retrievability_at）废弃。**当前生产 mistake 表 `fsrs_state` 列全部为 `null`**（Sub 1-3 没人调度过任何错题），所以无数据迁移成本——直接换 zod 形态。

新增 zod export：

```ts
// src/core/schema/index.ts
export const ReviewEventInsert = g.ReviewEventInsertGenerated.extend({
  rating: b.FsrsRating,
});
export const ReviewEvent = g.ReviewEventSelectGenerated.extend({
  rating: b.FsrsRating,
});
export type ReviewEvent = z.infer<typeof ReviewEvent>;
```

### 3.2 端点

#### `GET /api/review/due`

Query: `limit?: number`（default 20，max 50）

Behavior:
1. Now = `Math.floor(Date.now()/1000)`.
2. SQL:
   ```sql
   select m.id, m.question_id, m.knowledge_ids, m.cause, m.fsrs_state,
          m.created_at, q.prompt_md, q.reference_md
   from mistake m
   join question q on q.id = m.question_id
   where m.archived_at is null and m.deleted_at is null and m.status = 'active'
     and (m.fsrs_state is null
          or json_extract(m.fsrs_state, '$.due') <= ?)
   order by
     m.fsrs_state is null desc,        -- never-reviewed first
     json_extract(m.fsrs_state, '$.due') asc,
     m.created_at asc
   limit ?
   ```
   binds: `[<now-iso-string>, limit]`. Note: ts-fsrs `Card.due` is JSON serialized as ISO string (Date.toJSON), so SQLite `json_extract` returns ISO string for comparison. SQLite string compare works lexicographically and is correct for ISO 8601.

3. Worker layer parses `m.fsrs_state` JSON, returns rows.

Response:
```ts
{
  rows: Array<{
    id: string;
    question_id: string;
    prompt_md: string;        // 截 1000 字符 (long passages)
    reference_md: string | null; // 截 1000
    knowledge_ids: string[];
    cause: Cause | null;
    fsrs_state: FsrsState | null; // null = never-reviewed
    created_at: number;
  }>
}
```

#### `POST /api/review/submit`

Body:
```ts
{
  mistake_id: string;
  rating: 'again' | 'hard' | 'good';
  response_md?: string | null;   // 用户答案文本（可空）
  latency_ms?: number;            // 客户端测量
}
```

Behavior:
1. zod parse body, 400 on fail.
2. Load mistake row by id; 404 if missing or archived/deleted.
3. **`prevState = mistake.fsrs_state ? FsrsState.parse(JSON.parse(...)) : null`** —— 必须经 zod，因为 `FsrsState.due` / `last_review` 是 `z.coerce.date()`，DB JSON 反序列化拿到的是 ISO 字符串而不是 Date 对象，直接传给 ts-fsrs 会让 elapsed/scheduled days 计算错误。
4. ts-fsrs `FSRS().next(card, now, rating)` → 返回 next card + 新的 due。
5. Compute `nextState` (zod-shaped) 和 `dueAt`。
6. **D1 batch 原子写**（both UPDATE + INSERT 同 batch）：
   ```ts
   const updateStmt = db.prepare(
     `update mistake set fsrs_state = ?, updated_at = ?, version = version + 1
      where id = ? and version = ?`
   ).bind(JSON.stringify(nextState), now, mistakeId, prevVersion);
   const insertStmt = db.prepare(
     `insert into review_event (id, mistake_id, rating, response_md, latency_ms,
        fsrs_state_before, fsrs_state_after, due_at_before, due_at_next, created_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
   ).bind(...);
   const results = await db.batch([updateStmt, insertStmt]);
   ```
   D1 batch 的语义：要么所有 stmt 都提交，要么全部回滚。任何 D1 错误 → 两条都没写。
7. 检查 `results[0].meta.changes`：
   - `=== 1` → 正常成功，return 200 with `{ next_due_at, new_state }`
   - `=== 0` → version 不匹配（极罕见，单用户场景几乎不会发生）。**review_event 仍然提交**（作为 audit log 记录这次 attempt），response 409 Conflict 让客户端知道 fsrs_state 没动。
8. Return `{ next_due_at, new_state }` 或 `{ error: 'conflict', ... }`。

**为什么 review_event 在 409 路径下仍然写**：

`review_event` 的语义从这次设计开始改为"所有 submit attempt 的审计日志"，不是"成功 fsrs_state 变更的伴随日志"。原因：
- 用户实际按了那个键 / 做了那次复习决定，是真实发生的行为；
- `fsrs_state_before` / `fsrs_state_after` 仍然是有意义的快照（after = 这次 attempt 计算出的预期下一态）；
- 后续分析（BMMS 风格）想知道"用户怎么 rating"比想知道"哪些 rating 成功 mutate"更有用；
- D1 batch 让 UPDATE no-op 和 INSERT success 共存的概率成 0（要么俩都进，要么俩都不进）；不存在"UPDATE 成 + INSERT 丢"或"UPDATE 丢 + INSERT 成"两种半失败。

**Failure modes**:
- ts-fsrs 抛错（不应该发生，纯计算）→ Hono onError 5xx，batch 未触发
- D1 batch 整体失败（网络 / 限额 / 内部错误）→ Hono onError 5xx，**两条 stmt 都没提交**
- `prevState` JSON shape 异常（不应发生，因为我们写入路径走 ts-fsrs 直出 + JSON.stringify）→ FsrsState.parse 抛错 → 5xx
- 并发 submit（用户 double-click） → 第一次成功 + 第二次 409 + 一条 audit-only review_event。前端 disable submit while pending 减少误触发。

### 3.3 mount

`workers/src/routes/review.ts` 新文件，挂在 `workers/src/index.ts` 的 `app.route('/api/review', review)`.

---

## 四、Client 设计

### 4.1 路由

`/review` 新页 `src/routes/review.tsx`，挂在 `App.tsx`。`/_/inspect` 加链接。

### 4.2 数据流

- `useQuery({ queryKey: ['/api/review/due'], queryFn: fetchDue })` —— 一次拉 due 列表
- 本地维护 `currentIndex: number`，从 0 开始
- `currentMistake = data?.[currentIndex]`
- 用户点 rating → `useMutation` POST submit → 成功后 `setCurrentIndex(i + 1)`
- 客户端不重新请求 due 列表（一轮复习就是一次 fetch）
- 全部复习完 → 显示"今日复习完毕（N 条）" + 链接 `/mistakes` 看列表

### 4.3 UI（极简）

```
┌──────────────────────────────────┐
│ 复习  3 / 12                       │  ← 进度
├──────────────────────────────────┤
│                                    │
│ 题面                                │
│ ├─ "之"在主谓之间的用法?            │
│                                    │
│ 知识点: 虚词                        │
│ AI 错因: concept (87%)              │
│ ├─ 用户混淆了"之"的助词和动词用法    │
│                                    │
│ 你的答案 (可空):                    │
│ ┌─────────────────────────────┐    │
│ │ [textarea]                   │    │
│ └─────────────────────────────┘    │
│                                    │
│ ┌──────┐ ┌──────┐ ┌──────┐        │
│ │ 不会  │ │ 模糊  │ │ 会了  │        │
│ │  (1)  │ │  (2)  │ │  (3)  │        │
│ └──────┘ └──────┘ └──────┘        │
└──────────────────────────────────┘
```

键盘：1/2/3 直接对应 again/hard/good，按下后立即 submit + 进入下一题。

显示参考答案：用 `<details>` 折叠，标题"参考答案"，用户主动展开（避免提前看到）。

### 4.4 Latency 测量

客户端在 `useEffect(() => { startTimeRef.current = performance.now() }, [currentIndex])` 记录 currentMistake 显示瞬间。submit 时计算 `Math.round(performance.now() - startTimeRef.current)` 作为 `latency_ms`。

不在客户端做"思考时间过短/过长警告"——只测量 + 上报，分析留给以后。

---

## 五、文件 / 模块边界

### Server
| 路径 | 责任 | 新建/修改 |
|---|---|---|
| `package.json` | + `ts-fsrs` 依赖 | 改 |
| `src/core/schema/business.ts` | + `FsrsRating`, `FsrsCardState` enum；改 `FsrsState` 字段对齐 ts-fsrs Card | 改 |
| `src/db/schema.ts` | + `review_event` 表 | 改 |
| `src/core/schema/generated.ts` | + `ReviewEventInsert/Select` drizzle-zod | 改 |
| `src/core/schema/index.ts` | + `ReviewEvent` typed export | 改 |
| `src/core/schema/schema.test.ts` | + ReviewEvent 接受 / FsrsState 接受新字段 | 改 |
| `drizzle/0004_*.sql` + meta | 1 张新表 | 新（drizzle generate） |
| `workers/src/review/fsrs.ts` | thin wrapper around ts-fsrs：`scheduleReview(prevState, rating, now) → {nextState, dueAt}` 纯函数，可单测 | 新 |
| `workers/src/review/fsrs.test.ts` | 覆盖 first review / again-resets / good-progresses | 新 |
| `workers/src/routes/review.ts` | GET /due + POST /submit | 新 |
| `workers/src/routes/review.test.ts` | mockEnv + 全流程 + 乐观锁 + null-state 路径 | 新 |
| `workers/src/index.ts` | mount /api/review | 改 |

### Client
| 路径 | 责任 | 新建/修改 |
|---|---|---|
| `src/routes/review.tsx` | `<ReviewSession>` 串行 UI + 键盘快捷键 + latency 测量 | 新 |
| `src/App.tsx` | mount /review | 改 |
| `src/routes/inspect.tsx` | + /review link | 改 |
| `src/routes/mistakes-list.tsx` | 顶部加"+ 开始复习 (N 题 due)"按钮 | 改 |

---

## 六、约束 / 不变量

- **review_event = 所有 submit attempt 的审计日志**：每次 `POST /api/review/submit` 通过 zod 校验后必产生一条 review_event。append-only schema（无 update / version / updated_at）。
- **fsrs_state 与 review_event 双写原子性**：UPDATE mistake.fsrs_state + INSERT review_event 必须放在同一个 `c.env.DB.batch([...])`。D1 batch 是原子的：要么俩都提交，要么俩都不提交。
- **乐观锁 vs audit log 的分离**：UPDATE 用 `where version = ?` gate；如果 version 不匹配 → UPDATE no-op (`meta.changes === 0`)，但因为 D1 batch 整体提交，INSERT review_event 仍然成功 → 留下一条 audit-only 记录（fsrs_state 没动，但用户的 rating 行为被记录）。客户端拿到 409 知道这次没生效。
- **State 读路径必须经 zod**：JSON.parse 后再 `FsrsState.parse()`，依赖 `z.coerce.date()` 把 ISO 字符串转成 Date 对象。直接传 string 给 ts-fsrs 会让间隔计算错乱。
- **rating 三档闭合**：客户端只暴露 again/hard/good 三按钮；server zod enum 三档；ts-fsrs scheduling 用三档（不用 Easy）。
- **Latency 不可信但有用**：上报值由客户端计算，可被篡改 / NaN / 极端值；server 只 store，不据此做决策。
- **Due 列表无副作用**：GET /due 不修改 DB；纯 read。

---

## 七、估时 / PR

| 段 | 任务 | 估时 |
|---|---|---|
| Schema | review_event 表 + FsrsState zod 改 + drizzle 0004 + 测试 | ~0.3d |
| FSRS wrapper | fsrs.ts + fsrs.test.ts（4-6 个单测覆盖 first/again/good/hard/repeat-lapses 路径） | ~0.4d |
| Routes | review.ts GET/due + POST/submit + review.test.ts（10+ tests） | ~0.5d |
| Client | review.tsx 极简 UI + 键盘 + latency + 路由 mount + nav 链接 | ~0.3d |
| **合计** | | **~1.5d** |

**1 PR**：`feat(review): Phase 1a Sub 4A — Mistake FSRS + review_event log + /review UI`

---

## 八、跑出来后的预期数据信号

Sub 4A ship 后跑一周（自用 wenyan）能验证：

1. **AttributionTask cause 分布**：录入 ~30 错题后看 10 类 cause 计数。如果 90% 集中在 `concept` + `memory` 而其他 8 类几乎为 0 → 可能 prompt 偏置或 cause 类目对文言文不切实际。
2. **FSRS 默认参数适配**：默认 ts-fsrs 参数为通用记忆卡片；错题不一样。一周后看 review_event：
   - again 比率（如果 > 50% 说明默认间隔过激进，要调 retention target）
   - 间隔分布（如果都集中在 1-3 天 → 用户感知是"天天复习同一批"，可能要调 stability 增长率）
3. **Vision OCR 准确率**：用 vision_single 录入 10 张文言文卷子题，看用户编辑率 / 编辑量 / OCR 错字率。
4. **复习耗时分布**：latency_ms 的 p50 / p90 / 极端值。如果 p90 > 2 分钟 → 题面太长 / UI 阻碍 / 用户在边复习边查资料。

数据落点都在 `review_event` + 现有 `mistake.fsrs_state` + AttributionTask 的 cost_ledger / cause 字段。Sub 5（导出）让数据能拉出来分析。

---

## 九、Open（实施时再决）

1. **ts-fsrs 默认参数 vs 自定 fsrs.parameters**：先用默认（`fsrs_4_5_default_parameters`）。第一周数据回来再调。
2. **`/review` 完成后跳转**：跳 `/mistakes` 还是停留在"复习完毕"页 + 链接？建议停留页（避免误导用户"必须继续"）。
3. **due 列表为空时的 UI**：显示"今天没有要复习的，太好了"+ 链接 `/record` 录新错题 / `/mistakes` 看历史。
4. **mistake 已 archived 但 due 命中**：SQL 已经 filter `archived_at is null`；如果用户在 review 中途 archive，前端 list 已经在内存，submit 会 404 OR 写入成功——可接受，自用罕见。
5. **网络抖动 retry**：客户端 useMutation 默认 0 retry。手动重试由用户点。
6. **第一次 review 时 fsrs_state 还是 null 的并发**：`UPDATE ... where version = 0` —— version 字段在 mistake 表创建时为 0，所以走通。
7. **review_event 表索引**：当前不加 index，scan 量小。Phase 2 真要分析时再加 `CREATE INDEX idx_review_event_mistake_id`。
