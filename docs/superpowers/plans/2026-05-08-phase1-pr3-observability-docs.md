# Phase 1 PR 3 (观测 + 文档收尾) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec 的 PR 3（观测 UI + Phase 1 路线 + R2 / Dreaming 文档收尾）—— 改进 9 (`/_/inspect` 观测 UI) + 改进 3 (Phase 1 拆 1a/1b 文档) + 改进 11 文档主体 (R2) + 改进 12 文档主体 (Dreaming 实施栈) + Followup #29 (修 § 5.5 cross-ref)。

**Architecture:** Worker 端加 `/api/_/logs/tool_calls` + `/api/_/logs/cost` 两个 endpoint，从 D1 读 ToolCallLog / CostLedger，按 query param 过滤 / 聚合返 JSON。Client 加 `/_/inspect` 路由（不进主导航，URL 直访），双 tab 渲染表格。其余 4 项是文档改动。

**Tech Stack:** Hono routing extraction, Drizzle d1 (existing), React 19 + TanStack Query (existing), 文档改动 (markdown)。

**Spec reference:** `docs/superpowers/specs/2026-05-08-phase1-improvements-design.md` 改进 3 / 9 / 11 (doc) / 12 (doc)。

**Decisions resolved in this plan:**
- Logs endpoints → 提到独立文件 `workers/src/routes/logs.ts` + `app.route('/api/_/logs', logs)` mount，避免 `index.ts` 膨胀
- Dreaming 实施栈 → 写到 `§ 5.6`（§ 5.5 已被 PR 2 改进 7 占用为 "Tool calling 循环位置"），并修 § 5.5 内自引用
- 观测 UI → 无 unit 测试（页面 UI 简单，smoke test 在 dev mode 验证即可）；endpoints 走 TDD

---

## File Structure

### 创建（新文件）

- `workers/src/routes/logs.ts` — `/api/_/logs/tool_calls` + `/api/_/logs/cost` Hono sub-router
- `workers/src/routes/logs.test.ts` — endpoints 单测（mock D1）
- `src/routes/inspect.tsx` — `/_/inspect` 页面（双 tab 表格）

### 修改（已有文件）

- `workers/src/index.ts` — mount `logs` sub-router
- `src/App.tsx` — 加 `/_/inspect` route（不进主导航）
- `PLANNING.md` — `Phase 1` checklist 拆 `Phase 1a` / `Phase 1b`
- `docs/architecture.md`:
  - `§ 六 技术栈` 加 R2 行 + Cron Triggers / Queues 行
  - 加 `§ 5.6 Dreaming / Maintenance 实施栈` 新章节
  - 修 `§ 5.5 Tool calling 循环位置` 内 "见 § 5.5 Dreaming 实施栈" 自引用为 `§ 5.6`
- `docs/modules/mistakes.md` — `§ 2.3 vision_paper` 加一句：图片走 R2 存储
- `docs/modules/lanes.md` — `§ 调度` 引用 `architecture.md § 5.6`

### 不动

- `src/db/schema.ts`、`src/core/schema/` 单源不变
- `workers/src/ai/` 全部 PR 2 落地不动
- 其他模块文档（learning-items.md / progress.md / notes.md / quiz.md）不动

---

## Tasks

---

### Task 1: PLANNING.md Phase 1 拆 1a / 1b（改进 3）

**Goal:** 把现有 PLANNING.md 的 Phase 1 60+ 项 checklist 拆成 1a（最小可上手 MVP，5-7 天）和 1b（补完，1a 跑出第一周数据后做）。

**Files:**
- 修改：`PLANNING.md`

- [ ] **Step 1: 读现有 § Phase 1 内容**

```bash
grep -n "Phase 1" PLANNING.md | head -10
sed -n '/Phase 1 · 让一个闭环跑起来/,/Phase 1.5/p' PLANNING.md | head -120
```

记录 Phase 1 起始 / 结束行号 + 当前 checklist 大致清单。

- [ ] **Step 2: 替换 § Phase 1 段落**

把现有 `### Phase 1 · 让一个闭环跑起来（最小可用）` 整段（直到 `### Phase 1.5 · 批改识别` 之前）替换为：

```markdown
### Phase 1 · 让一个闭环跑起来（最小可用）

只做错题管理 + 学习项 + 知识点挂载 + Note 录入 + tool_quiz 骨架，验证数据模型。

拆为 1a（最小可上手 MVP，5-7 天）和 1b（补完，1a 跑出第一周数据后做）。完整决策见 `docs/superpowers/specs/2026-05-08-phase1-improvements-design.md` 改进 3。

#### Phase 1a · 最小可用（目标 5-7 天上手）

**核心闭环（manual 录入 + 错因 + FSRS 复习）**
- [x] DB driver 接 D1（PR 1 已落）
- [x] Worker shared-secret auth（PR 1 已落）
- [x] AI Task Runner 骨架 + ToolCallLog / CostLedger（PR 2 已落）
- [ ] 知识点 schema seed（文言文课标 import + AI 自动建议节点 + 人工确认 UI）
- [ ] **manual 录入页**（粘贴题面 / 参考答案 / 错答 / 知识点 dropdown）
- [ ] AttributionTask 接通（10 类 cause + AI 自动归因 + 失败兜底走"待人工归因队列"）
- [ ] FSRS 复习队列（用 OSS lib `ts-fsrs`）+ 简陋复习 UI
- [ ] LearningItem 简化版（仅 pending / in_progress / done 三态走通；6 状态字段保留 schema，状态机本身先简化）
- [ ] 完成判定：自我宣告 + Evidence 留痕（多路径推 1b）

**最小观测**
- [x] AI 任务层 ToolCallLog + CostLedger 写入（PR 2）
- [x] `/_/inspect` 观测 UI（PR 3）

**项目结构**
- [x] 目录边界：`core/` vs `subjects/wenyan/`（PR 1 已落 wenyan 占位）
- [ ] 数据导出（JSON / Markdown）—— 给未来的自己买保险
- [x] PWA 基础（manifest + standalone + 安装到主屏；PR 2 已落，dev-mode SW 关）

目标：自己能用它备文言文一周，跑出第一批数据。

#### Phase 1b · 补完（1a 跑出第一周数据后做）

**录入扩展**
- [ ] **vision_single 录入路径**（视觉模型 + 一击确认页）
- [ ] **手动粘贴录入** UX 优化（如需要）

**Quiz 骨架 + StudyLog**
- [ ] tool_quiz embedded check（最小 standalone + inline）
- [ ] Schema: Answer / Judgment / UserAppeal（PR 1 schema 已 ready，本阶段接通流程）
- [ ] QuizGenTask + JudgeRouter（exact / keyword / semantic 三种 judge_kind）
- [ ] JudgeFlexibleTask + UserAppeal 流程（兜底必须 Phase 1 就有）
- [ ] Mistake 创建事件（incorrect/partial → mistake，appeal 翻盘撤销）
- [ ] mastery 反馈喂 base_mastery
- [ ] feedback_md 模板 + partial credit 计算
- [ ] **StudyLog 录入入口**（错题 / 题目 / note 旁批"+ 写学习日志"按钮）

**LearningItem 完整化**
- [ ] LearningItem 6 状态完整（pending / in_progress / done / dismissed / resting / archived）
- [ ] 完成时间戳字段（completed_at / dismissed_at / archived_at + archived_reason）
- [ ] LearningItem 优先级 score 公式（urgency 0.4 / weakness 0.3 / recency 0.3 / pin 顶部）
- [ ] AI 主动提议完成（DreamingProposal.kind=`learning_item_completion`，dismiss 后 7 天冷却）
- [ ] LearningItem 层级化字段（parent_learning_item_id / child_learning_item_ids[]，hub status 自动聚合）
- [ ] 完成判定多路径（自我宣告 + AI propose + quiz_pass，evidence 留痕，软反问 + 强制覆盖）

**Artifact 多态化骨架**
- [ ] Artifact schema 多态化（note_hub / note_atomic / tool_quiz）
- [ ] tool_quiz 可独立存在 + 可嵌入 note section（embedded_check inline 模式）

#### 推到 Phase 1.5+

- vision_paper 卷子拍照（已是 Phase 1.5）
- reverse_mark 反向标记（依赖 Note UI，本来就 Phase 2）
- LearningItem 复学机制 / 变式题双 pass / 错因差异化复习权重（Phase 2，依赖 dreaming）
- 学习时间线视图（Phase 2）
```

注：保留原 Phase 1.5 / Phase 2 / Phase 3 / Phase 4 段不动。

- [ ] **Step 3: 验证 markdown 渲染**

```bash
grep -n "^#### Phase 1[ab]\|^### Phase 1" PLANNING.md
```

Expected: 看到 `Phase 1`、`Phase 1a`、`Phase 1b`、`Phase 1.5` 等。

- [ ] **Step 4: 提交**

```bash
git add PLANNING.md
git commit -m "docs(planning): split Phase 1 into 1a / 1b (改进 3)"
```

## Context

- Working directory: `/Users/yukoval/yukoval-projects/the-learning-project/`
- On branch `phase1-pr3-observability-docs`
- 当前 PLANNING.md `Phase 1` 是大杂烩 60+ 项；spec 改进 3 拆 1a / 1b
- 注意：PR 1 + 2 已落地的项标 `[x]`，未落 `[ ]`

## Before You Begin

如果 sed pattern 没匹配（"Phase 1 · 让一个闭环..." 章节标题字面差异），用 `head -200 PLANNING.md` 直接读现有结构再决定替换边界。

## Your Job

1. Steps 1-4 顺序执行
2. 不动 Phase 1.5+ 和其他章节

## Report Format

- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- 改动文件
- Step 3 grep 输出确认 1a/1b 存在
- Commit SHA

---

### Task 2: R2 doc 落地（改进 11 文档主体）

**Goal:** `docs/architecture.md § 六 技术栈` 加 R2 行；`docs/modules/mistakes.md § 2.3 vision_paper` 加一句"图片走 R2 存储"。

**Files:**
- 修改：`docs/architecture.md`
- 修改：`docs/modules/mistakes.md`

- [ ] **Step 1: 定位 architecture.md § 六 技术栈表中的"数据存储"行**

```bash
grep -n "数据存储\|本地存储\|R2\|云同步" docs/architecture.md
```

PR 1 改进 1 已经把 "数据存储" 行改成 "Phase 1 = D1 远程；Phase 1.5 起 R2 存图片..."。本任务的 R2 改动主要在 mistakes.md 这边，architecture.md 数据存储行已经提到 R2，无需重复。

但是需要在 architecture.md § 六 技术栈表加一行 "图片存储 = Cloudflare R2"（或者跟 D1 合并的更详细 row）+ 在表格末尾加 Cron Triggers / Queues 行（这是 Task 3 范围，但跟 R2 一起改 § 六 更顺手）。

为了避免跟 Task 3 撞，本 Task 2 **只改 mistakes.md** + 在 architecture.md § 六 检查"R2"出现一次以上即可（已 PR 1 出现一次，不再加）。Task 3 单独负责 § 六 的 Dreaming 实施栈相关行（Cron Triggers / Queues）。

- [ ] **Step 2: 改 mistakes.md § 2.3**

定位 vision_paper 段：

```bash
grep -n "vision_paper\|批改识别\|2\.3" docs/modules/mistakes.md
```

在 `### 2.3 卷子拍照 / 批改识别（vision_paper，Phase 1.5）` 章节中段，在描述 VisionExtractTask 输出之前或之后插入：

```markdown
**图片存储**：vision_paper 单次上传 1~N 张图片（每张 2-5MB），用户审核完批量录入时图片必须可重复读取。卷子图片走 Cloudflare R2 持久化（worker `[[r2_buckets]]` binding `IMAGES`，PR 1 已加 wrangler.toml 占位字段）；DB 中 `Mistake.wrong_answer_image_refs[]` / `Answer.image_refs[]` 持的是 R2 object key。client 上传时走 worker `POST /api/upload/image` → 写 R2 → 返 r2 key（实际 endpoint 落地推 Phase 1.5 实施时）。
```

精确位置：在 § 2.3 内列完 prompt 要点 / 默认行为之后、§ 2.4 manual 之前。

- [ ] **Step 3: 验证 grep**

```bash
grep -A 1 "图片存储" docs/modules/mistakes.md
grep -c "R2" docs/architecture.md  # 至少 ≥ 1
```

Expected: 看到新增段；architecture.md R2 出现 ≥ 1 次。

- [ ] **Step 4: 提交**

```bash
git add docs/modules/mistakes.md
git commit -m "docs(mistakes): vision_paper 图片走 R2 (改进 11 doc)"
```

## Context

- Working directory: `/Users/yukoval/yukoval-projects/the-learning-project/`
- 注意：本 task 只改 mistakes.md，避免跟 Task 3 在 architecture.md 上撞
- 跟 Task 1（PLANNING.md）和 Task 3（architecture.md 大改）独立，可并行

## Your Job

1. Steps 1-4 顺序执行
2. 不动 architecture.md（Task 3 集中改）

## Report Format

- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- 改动文件
- grep 输出
- Commit SHA

---

### Task 3: Dreaming 实施栈 + § 5.5 cross-ref 修（改进 12 文档主体 + Followup #29）

**Goal:** 在 `docs/architecture.md` 加 § 5.6 Dreaming / Maintenance 实施栈（Cron Triggers + Queues + Anthropic Batch API 三件接通）；§ 6 加 Cron Triggers / Queues 两行；修 § 5.5 内自引用 "见 § 5.5 Dreaming 实施栈" 为 § 5.6；`lanes.md § 调度` 引用 § 5.6。

**Files:**
- 修改：`docs/architecture.md`
- 修改：`docs/modules/lanes.md`

- [ ] **Step 1: 定位 § 5.5 + § 六**

```bash
grep -n "^### 5\." docs/architecture.md
grep -n "^## 六 技术栈" docs/architecture.md
```

确认 § 5.5 已存在（PR 2 改进 7 写的 Tool calling 循环位置），需要在它之后加 § 5.6。

- [ ] **Step 2: 修 § 5.5 内 cross-ref**

读 `docs/architecture.md` § 5.5 内容（可能在 line 197 附近）。找到这段：

```
Dreaming / Maintenance lane（见 § 5.5 Dreaming 实施栈—— Phase 2 加）也复用这套 runner
```

把里面的 `§ 5.5` 改成 `§ 5.6`：

```
Dreaming / Maintenance lane（见 § 5.6 Dreaming / Maintenance 实施栈—— Phase 2 加）也复用这套 runner
```

- [ ] **Step 3: 在 § 5.5 之后、§ 六 之前插入 § 5.6**

```markdown
### 5.6 Dreaming / Maintenance 实施栈

Dreaming 和 Maintenance lane 都是「定时触发 + 大批量产出 + 写 propose 表」的模式，跑在 Cloudflare 原生组件上。Phase 2 实施。

#### 触发：Cloudflare Cron Triggers

cron 表达式定义在 wrangler.toml：

```toml
[triggers]
crons = [
  "0 18 * * *",   # 每天 18:00 UTC = 北京 02:00，跑 dreaming 主流程
  "0 19 * * 0"    # 每周日 19:00 UTC，跑 weekly review
]
```

cron worker 不直接生成 proposal，只负责 dispatch（扫 D1 找候选 + 推 Queue），30s 内退出。

#### 任务分发：Cloudflare Queues

`DreamingTaskQueue` / `MaintenanceTaskQueue` 两个队列。

- Cron worker:
  1. 扫 D1 找触发条件命中的对象（mastery>0.8/14d、7 天 0 错、相似度高的节点对、久未触达对象 ...）
  2. 每个候选对象封装成一条 message 推 Queue
  3. cron worker 30s 内退出
- Consumer worker:
  - 各自消费一条 message → 调 LLM 生成单条 proposal → 写 DreamingProposal / MaintenanceSuggestion
  - 单 unit 30s budget 够（一次 LLM call + 写 DB）

#### 真重批量：Anthropic Batch API

针对真正大批量任务（变式题双 pass、周报全量分析、Note 全量 verify）：

- Worker submit batch（HTTP）→ 返 `batch_id`
- 24h 内 worker 主动轮询 / 用 Cloudflare Cron 第二天早晨拉结果
- 拉到结果 → 写 DreamingProposal / 更新 Question.draft_status 等
- 50% cost 折扣

#### Queue vs Batch API 选哪

| 场景 | 选哪 | 理由 |
| --- | --- | --- |
| 单 task 几秒、需要"明早就能看" | Queue | 一次 LLM call 即可，无折扣浪费 |
| 单 task 较重 + 不急 | Batch API | 等 24h，省一半钱 |
| 周报全量分析 | Batch API | 整周数据 prompt 长，缓存命中率低，靠 batch 折扣 |
| 每日 quiz 生成 | Queue | 用户当天醒来要看到 |
| 变式题双 pass | Batch API | 大量 + 不急 + 双 model verify |
| Maintenance 提议（合并 / 删除） | Queue | 每日少量，靠 cron 触发 |

混用即可。

#### 调度文件目录

所有 cron 入口、queue consumer、batch poller 都放在 `workers/src/dreaming/`：

```
workers/src/dreaming/
  cron.ts            # cron 触发入口
  consumer.ts        # queue 消费者
  batch-submit.ts    # batch API 提交
  batch-poll.ts      # batch API 结果拉取
  scanners/          # D1 扫描器（mastery 阈值、错题密度等）
```

实际实施推到 Phase 2。
```

注意：在 markdown 内嵌 ```toml 和 ``` 时不要让外层 fence 提前闭合 —— 用 4-tilde fence 或 4-backtick fence 包外层。具体在 grep 检查时确认渲染正确。

实操简化：把 `### 5.6` 整段当作一个独立 markdown 文件 append，不需要嵌套 fence。在 architecture.md 中直接 paste 上面的内容（保留原始三重反引号 toml 块，因为 architecture.md 整体不是被 ```fence 包起来的）。

- [ ] **Step 4: § 六 技术栈表加 Cron Triggers / Queues 行**

定位 § 六 技术栈表：

```bash
sed -n '/^## 六 技术栈/,/^##/p' docs/architecture.md | head -30
```

在表格末尾（最后一个数据行之后、表格结束前）加两行：

```
| 定时触发 | Cloudflare Cron Triggers | Phase 2 dreaming / weekly report 入口 |
| 任务队列 | Cloudflare Queues | Phase 2 dreaming task 分发 + consumer |
| 批量 LLM | Anthropic Batch API | Phase 2 重批量任务（变式题 / 周报 / Note verify），50% 折扣 |
```

- [ ] **Step 5: 改 lanes.md § 调度**

```bash
grep -n "调度\|两条 lane 都走 dreaming batch" docs/modules/lanes.md
```

把 `## 调度` 章节中类似 "两条 lane 都走 dreaming batch（夜间）..." 的段落改成：

```markdown
## 调度

两条 lane 的实施栈（Cron Triggers + Queues + Anthropic Batch API）详见 [`architecture.md § 5.6`](../architecture.md#56-dreaming--maintenance-实施栈)。Phase 2 落地。

成本控制详见 [`architecture.md § 5.3`](../architecture.md#53-成本控制)。
```

- [ ] **Step 6: 验证**

```bash
grep -c "Cron Triggers" docs/architecture.md  # ≥ 2 (§ 5.6 + § 六)
grep -c "5\.6" docs/architecture.md  # ≥ 1 (新增章节)
grep "§ 5\.5 Dreaming" docs/architecture.md  # 应该 0 次（cross-ref 已修）
grep "§ 5\.6" docs/modules/lanes.md  # ≥ 1
```

- [ ] **Step 7: 提交**

```bash
git add docs/architecture.md docs/modules/lanes.md
git commit -m "docs: add § 5.6 Dreaming 实施栈 + 修 § 5.5 cross-ref + § 六 加 cron/queues (改进 12 + followup #29)"
```

## Context

- Working directory: `/Users/yukoval/yukoval-projects/the-learning-project/`
- 现有 § 5.5 是 PR 2 改进 7 写的 Tool calling 循环位置；本任务在它后加 § 5.6
- followup #29 (修 § 5.5 cross-ref) 跟改进 12 一起做（spec PR 划分这两件本来就在 PR 3 一起）

## Your Job

1. Steps 1-7 顺序执行
2. **不要把 § 5.5 改成 § 5.6**（§ 5.5 内容不变，只修内部 cross-ref）
3. § 5.6 是新章节
4. 注意 markdown 嵌套 fence（toml block 在 § 5.6 内可能需要避免冲突）
5. 跟 Task 1 / Task 2 / Task 4 没文件冲突，可并行

## Report Format

- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- 改动文件
- 验证 grep 输出（4 个 check 都过）
- Commit SHA

---

### Task 4: Worker logs endpoints（改进 9 server side）

**Goal:** TDD 写 `/api/_/logs/tool_calls` + `/api/_/logs/cost` 两个 endpoint，从 D1 读 ToolCallLog / CostLedger 表。

**Files:**
- 创建：`workers/src/routes/logs.ts`
- 创建：`workers/src/routes/logs.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `workers/src/routes/logs.test.ts`：

```ts
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { logs } from './logs';
import type { AppEnv } from '../types';

function makeMockDb(rows: Record<string, unknown>[]) {
  const queries: string[] = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (..._binds: unknown[]) => ({
      all: async () => ({ results: rows, success: true, meta: {} }),
    }),
    all: async () => ({ results: rows, success: true, meta: {} }),
    first: async () => rows[0] ?? null,
  }));
  // Track all SQL invocations
  const wrapped = (sql: string) => {
    queries.push(sql);
    return prepare(sql);
  };
  return { db: { prepare: wrapped } as unknown as D1Database, queries };
}

describe('GET /tool_calls', () => {
  function makeApp(rows: Record<string, unknown>[]) {
    const { db, queries } = makeMockDb(rows);
    const app = new Hono<AppEnv>();
    app.route('/api/_/logs', logs);
    return {
      app,
      env: { DB: db } as unknown as AppEnv['Bindings'],
      queries,
    };
  }

  it('returns recent tool call rows', async () => {
    const fakeRows = [
      {
        id: 'tcl_1',
        task_run_id: 'tr_1',
        task_kind: 'AttributionTask',
        tool_name: 'search_knowledge_by_concept',
        input_json: '{"concept":"x"}',
        output_json: '{"results":[]}',
        iteration: 1,
        latency_ms: 234,
        cost: 0.001,
        occurred_at: 1715000000,
      },
    ];
    const { app, env } = makeApp(fakeRows);
    const res = await app.request('/api/_/logs/tool_calls?limit=50', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1);
    expect((body.rows[0] as { tool_name: string }).tool_name).toBe(
      'search_knowledge_by_concept',
    );
  });

  it('clamps limit to safe range', async () => {
    const { app, env, queries } = makeApp([]);
    await app.request('/api/_/logs/tool_calls?limit=99999', {}, env);
    // limit param should be capped (we use 200 as max)
    const sql = queries.find((q) => /tool_call_log/i.test(q)) ?? '';
    expect(sql).toMatch(/limit\s+\?/i);
  });

  it('filters by task_kind when provided', async () => {
    const { app, env, queries } = makeApp([]);
    await app.request(
      '/api/_/logs/tool_calls?task_kind=AttributionTask',
      {},
      env,
    );
    const sql = queries.find((q) => /tool_call_log/i.test(q)) ?? '';
    expect(sql).toMatch(/task_kind\s*=\s*\?/i);
  });
});

describe('GET /cost', () => {
  function makeApp(rows: Record<string, unknown>[]) {
    const { db, queries } = makeMockDb(rows);
    const app = new Hono<AppEnv>();
    app.route('/api/_/logs', logs);
    return {
      app,
      env: { DB: db } as unknown as AppEnv['Bindings'],
      queries,
    };
  }

  it('returns aggregated cost rows for default range', async () => {
    const rows = [
      {
        bucket: '2026-05-08',
        task_kind: 'AttributionTask',
        model: 'claude-sonnet-4-6',
        cost_sum: 0.012,
        tokens_in_sum: 1234,
        tokens_out_sum: 567,
        call_count: 3,
      },
    ];
    const { app, env } = makeApp(rows);
    const res = await app.request('/api/_/logs/cost', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; range: string };
    expect(body.rows).toHaveLength(1);
    expect(body.range).toBe('day');
  });

  it('accepts range=week and range=month', async () => {
    const { app, env } = makeApp([]);
    const r1 = await app.request('/api/_/logs/cost?range=week', {}, env);
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { range: string }).range).toBe('week');

    const r2 = await app.request('/api/_/logs/cost?range=month', {}, env);
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { range: string }).range).toBe('month');
  });

  it('rejects invalid range', async () => {
    const { app, env } = makeApp([]);
    const res = await app.request('/api/_/logs/cost?range=bogus', {}, env);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
pnpm test
```

Expected: red (Cannot find module './logs').

- [ ] **Step 3: 实现 logs.ts**

写 `workers/src/routes/logs.ts`：

```ts
import { Hono } from 'hono';
import type { AppEnv } from '../types';

export const logs = new Hono<AppEnv>();

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

logs.get('/tool_calls', async (c) => {
  const rawLimit = Number.parseInt(c.req.query('limit') ?? `${DEFAULT_LIMIT}`, 10);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MAX_LIMIT)
      : DEFAULT_LIMIT;
  const taskKind = c.req.query('task_kind');

  const sql = taskKind
    ? `select id, task_run_id, task_kind, tool_name, input_json, output_json, iteration, latency_ms, cost, occurred_at from tool_call_log where task_kind = ? order by occurred_at desc limit ?`
    : `select id, task_run_id, task_kind, tool_name, input_json, output_json, iteration, latency_ms, cost, occurred_at from tool_call_log order by occurred_at desc limit ?`;

  const stmt = c.env.DB.prepare(sql);
  const bound = taskKind ? stmt.bind(taskKind, limit) : stmt.bind(limit);
  const result = await bound.all<Record<string, unknown>>();

  return c.json({ rows: result.results, limit });
});

type CostRange = 'day' | 'week' | 'month';

function rangeBucketExpr(range: CostRange): string {
  // SQLite date(...) with unixepoch occurred_at
  switch (range) {
    case 'day':
      return "date(occurred_at, 'unixepoch')";
    case 'week':
      return "strftime('%Y-W%W', occurred_at, 'unixepoch')";
    case 'month':
      return "strftime('%Y-%m', occurred_at, 'unixepoch')";
  }
}

logs.get('/cost', async (c) => {
  const rangeParam = c.req.query('range') ?? 'day';
  if (rangeParam !== 'day' && rangeParam !== 'week' && rangeParam !== 'month') {
    return c.json({ error: 'invalid_range', allowed: ['day', 'week', 'month'] }, 400);
  }
  const range: CostRange = rangeParam;

  const bucketExpr = rangeBucketExpr(range);
  const sql = `
    select
      ${bucketExpr} as bucket,
      task_kind,
      model,
      sum(cost) as cost_sum,
      sum(tokens_in) as tokens_in_sum,
      sum(tokens_out) as tokens_out_sum,
      count(*) as call_count
    from cost_ledger
    group by bucket, task_kind, model
    order by bucket desc, cost_sum desc
    limit 200
  `;

  const result = await c.env.DB.prepare(sql).all<Record<string, unknown>>();
  return c.json({ rows: result.results, range });
});
```

- [ ] **Step 4: 跑测试验证通过**

```bash
pnpm test
```

Expected: 6 logs cases pass，total tests now 34 (28 + 6).

如果 mock 的 `bind(...).all()` chain 跟实际 D1 type 不完全一致，按测试 fail 信息调整 mock helper。重点是 `prepare(sql).bind(...).all()` 这条链能 work。

- [ ] **Step 5: typecheck**

```bash
pnpm typecheck
```

Expected: 0 error.

- [ ] **Step 6: 提交**

```bash
git add workers/src/routes/logs.ts workers/src/routes/logs.test.ts
git commit -m "feat(worker): /api/_/logs/{tool_calls,cost} endpoints (改进 9)"
```

## Context

- Working directory: `/Users/yukoval/yukoval-projects/the-learning-project/`
- On branch `phase1-pr3-observability-docs`
- D1 schema 已有 `tool_call_log` 和 `cost_ledger` 表（PR 1 drizzle migration）
- PR 2 已写过 ToolCallLog / CostLedger 数据
- 不要碰 workers/src/index.ts —— Task 5 mount

## Before You Begin

如果 Hono `app.request()` 和 sub-router pattern 不熟，参考 `workers/src/auth.test.ts` 的 `makeApp()` —— 一样的 pattern。

## Your Job

1. Steps 1-6 严格 TDD 顺序
2. 不动 workers/src/index.ts
3. 跟 Task 1/2/3 没冲突，可并行（Task 4 → Task 5 必须串行）

## Report Format

- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- 创建文件
- Step 2 fail + Step 4 pass 输出
- typecheck 输出
- Commit SHA

---

### Task 5: Mount logs router 到 workers/src/index.ts

**Goal:** 把 Task 4 的 `logs` sub-router mount 到 `/api/_/logs`，让 endpoint 真正可访问。

**Files:**
- 修改：`workers/src/index.ts`

- [ ] **Step 1: 加 import + mount**

读 `workers/src/index.ts`。在 import 段加：

```ts
import { logs } from './routes/logs';
```

在现有 `app.use('/api/*', internalAuth);` 之后、`app.get('/api/health', ...)` 之前加：

```ts
app.route('/api/_/logs', logs);
```

最终 wiring 顺序应是：cors → internalAuth (`/api/*`) → logs router (`/api/_/logs`) → health (`/api/health`) → ai task (`/api/ai/:task`)。

注意 internalAuth 路径 `/api/*` 也覆盖 `/api/_/logs/*`，所以 logs endpoint 也要带 `x-internal-token` header（这是预期的，避免观测端点裸奔）。

- [ ] **Step 2: typecheck**

```bash
pnpm typecheck
```

Expected: 0 error.

- [ ] **Step 3: smoke 测试**

```bash
pnpm exec wrangler dev --config workers/wrangler.toml --local --persist-to .wrangler-state &
WRANGLER_PID=$!
sleep 8
TOKEN=$(grep '^INTERNAL_TOKEN=' workers/.dev.vars 2>/dev/null | cut -d= -f2-)

echo '=== /api/_/logs/tool_calls (200) ==='
curl -s -H "x-internal-token: $TOKEN" 'http://localhost:8787/api/_/logs/tool_calls?limit=10'
echo
echo '=== /api/_/logs/cost (200) ==='
curl -s -H "x-internal-token: $TOKEN" 'http://localhost:8787/api/_/logs/cost'
echo
echo '=== /api/_/logs/tool_calls (401 no token) ==='
curl -s -i 'http://localhost:8787/api/_/logs/tool_calls' | head -3

kill $WRANGLER_PID 2>/dev/null
sleep 2
```

Expected:
- `/api/_/logs/tool_calls` (200): `{"rows":[],"limit":10}`（空，因为 PR 1+2 在 local D1 mock 没真写过日志）—— 或非空如果你之前手 smoke 过
- `/api/_/logs/cost` (200): `{"rows":[],"range":"day"}`
- `/api/_/logs/tool_calls` (401 no token): `HTTP/1.1 401`

如果 D1 表不存在（local mock 重置），smoke 可能报 "no such table"。这种情况：先跑 `pnpm exec wrangler d1 migrations apply DB --local` 给本地 D1 apply migration，再重 smoke。如果 migration 命令也不工作，记录到 report 但不阻塞 task（endpoint 代码本身正确，需要的只是 D1 schema）。

- [ ] **Step 4: 提交**

```bash
git add workers/src/index.ts
git commit -m "feat(worker): mount /api/_/logs router (改进 9)"
```

## Context

- 依赖 Task 4 的 `logs` export
- 跟 Task 6 (client UI) 串行不可并行（client 调这个 endpoint）

## Before You Begin

如果 wrangler dev 启动失败，按 PR 2 Task 8 的同样 troubleshooting：检查 `.dev.vars` 是否有 INTERNAL_TOKEN。

## Your Job

1. Steps 1-4 顺序执行
2. 不动其他文件

## Report Format

- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- workers/src/index.ts 改动摘要
- typecheck 输出
- Step 3 smoke 三个 path 的 curl 输出
- Commit SHA

---

### Task 6: Client `/_/inspect` 路由 + UI

**Goal:** 加一个 `/_/inspect` 路由，双 tab 渲染 ToolCallLog / CostLedger 数据。Phase 1 不进主导航，URL 直访。

**Files:**
- 创建：`src/routes/inspect.tsx`
- 修改：`src/App.tsx`

- [ ] **Step 1: 写 inspect 页面**

创建 `src/routes/inspect.tsx`：

```tsx
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

const INTERNAL_TOKEN = import.meta.env.VITE_INTERNAL_TOKEN ?? '';

interface ToolCallLogRow {
  id: string;
  task_run_id: string;
  task_kind: string;
  tool_name: string;
  input_json: string;
  output_json: string;
  iteration: number;
  latency_ms: number;
  cost: number;
  occurred_at: number;
}

interface CostLedgerRow {
  bucket: string;
  task_kind: string;
  model: string;
  cost_sum: number;
  tokens_in_sum: number;
  tokens_out_sum: number;
  call_count: number;
}

async function fetchLogs<T>(path: string): Promise<{ rows: T[] }> {
  const res = await fetch(`/api/_/logs/${path}`, {
    headers: { 'x-internal-token': INTERNAL_TOKEN },
  });
  if (!res.ok) throw new Error(`logs fetch failed: ${res.status}`);
  return (await res.json()) as { rows: T[] };
}

function ToolCallLogTab() {
  const [taskKindFilter, setTaskKindFilter] = useState('');
  const params = new URLSearchParams({ limit: '50' });
  if (taskKindFilter) params.set('task_kind', taskKindFilter);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['tool_calls', taskKindFilter],
    queryFn: () => fetchLogs<ToolCallLogRow>(`tool_calls?${params}`),
  });

  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center">
        <label className="text-sm text-slate-600">Filter task_kind:</label>
        <input
          type="text"
          value={taskKindFilter}
          onChange={(e) => setTaskKindFilter(e.target.value)}
          placeholder="(any)"
          className="border px-2 py-1 text-sm rounded"
        />
        <button
          type="button"
          onClick={() => refetch()}
          className="px-2 py-1 bg-slate-200 text-sm rounded"
        >
          Refresh
        </button>
      </div>

      {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {error && (
        <p className="text-sm text-red-600">Error: {(error as Error).message}</p>
      )}
      {data && (
        <table className="w-full text-xs border-collapse">
          <thead className="bg-slate-100">
            <tr>
              <th className="text-left p-2">When</th>
              <th className="text-left p-2">Task</th>
              <th className="text-left p-2">Tool</th>
              <th className="text-right p-2">Iter</th>
              <th className="text-right p-2">Latency (ms)</th>
              <th className="text-left p-2">Input → Output</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={6} className="p-4 text-center text-slate-500">
                  No tool call logs yet.
                </td>
              </tr>
            )}
            {data.rows.map((r) => (
              <tr key={r.id} className="border-t align-top">
                <td className="p-2 text-slate-500 whitespace-nowrap">
                  {new Date(r.occurred_at * 1000).toLocaleString()}
                </td>
                <td className="p-2 whitespace-nowrap">{r.task_kind}</td>
                <td className="p-2 font-mono whitespace-nowrap">{r.tool_name}</td>
                <td className="p-2 text-right">{r.iteration}</td>
                <td className="p-2 text-right">{r.latency_ms}</td>
                <td className="p-2 font-mono text-[10px] max-w-md truncate">
                  <details>
                    <summary>view</summary>
                    <pre className="whitespace-pre-wrap break-all">
                      input: {r.input_json}
                      {'\n'}output: {r.output_json}
                    </pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CostLedgerTab() {
  const [range, setRange] = useState<'day' | 'week' | 'month'>('day');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['cost', range],
    queryFn: () =>
      fetchLogs<CostLedgerRow>(`cost?range=${range}`) as Promise<{
        rows: CostLedgerRow[];
        range: string;
      }>,
  });

  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center">
        <label className="text-sm text-slate-600">Range:</label>
        {(['day', 'week', 'month'] as const).map((r) => (
          <button
            type="button"
            key={r}
            onClick={() => setRange(r)}
            className={`px-2 py-1 text-sm rounded ${
              range === r ? 'bg-slate-900 text-white' : 'bg-slate-200'
            }`}
          >
            {r}
          </button>
        ))}
        <button
          type="button"
          onClick={() => refetch()}
          className="px-2 py-1 bg-slate-200 text-sm rounded"
        >
          Refresh
        </button>
      </div>

      {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {error && (
        <p className="text-sm text-red-600">Error: {(error as Error).message}</p>
      )}
      {data && (
        <table className="w-full text-xs border-collapse">
          <thead className="bg-slate-100">
            <tr>
              <th className="text-left p-2">Bucket</th>
              <th className="text-left p-2">Task</th>
              <th className="text-left p-2">Model</th>
              <th className="text-right p-2">Calls</th>
              <th className="text-right p-2">Tokens in</th>
              <th className="text-right p-2">Tokens out</th>
              <th className="text-right p-2">Cost</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={7} className="p-4 text-center text-slate-500">
                  No cost ledger entries yet.
                </td>
              </tr>
            )}
            {data.rows.map((r, idx) => (
              <tr key={`${r.bucket}-${r.task_kind}-${r.model}-${idx}`} className="border-t">
                <td className="p-2 whitespace-nowrap">{r.bucket}</td>
                <td className="p-2 whitespace-nowrap">{r.task_kind}</td>
                <td className="p-2 font-mono whitespace-nowrap">{r.model}</td>
                <td className="p-2 text-right">{r.call_count}</td>
                <td className="p-2 text-right">{r.tokens_in_sum}</td>
                <td className="p-2 text-right">{r.tokens_out_sum}</td>
                <td className="p-2 text-right">${r.cost_sum.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function Inspect() {
  const [tab, setTab] = useState<'tool_calls' | 'cost'>('tool_calls');
  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-xl font-semibold mb-4">/_/inspect</h1>
      <p className="text-sm text-slate-500 mb-4">
        Recent ToolCallLog + CostLedger from D1. Manual refresh; no auto-poll.
      </p>

      <div className="flex gap-2 mb-4 border-b">
        <button
          type="button"
          onClick={() => setTab('tool_calls')}
          className={`px-3 py-2 text-sm border-b-2 ${
            tab === 'tool_calls'
              ? 'border-slate-900 font-semibold'
              : 'border-transparent text-slate-500'
          }`}
        >
          ToolCallLog
        </button>
        <button
          type="button"
          onClick={() => setTab('cost')}
          className={`px-3 py-2 text-sm border-b-2 ${
            tab === 'cost'
              ? 'border-slate-900 font-semibold'
              : 'border-transparent text-slate-500'
          }`}
        >
          CostLedger
        </button>
      </div>

      {tab === 'tool_calls' ? <ToolCallLogTab /> : <CostLedgerTab />}
    </main>
  );
}
```

- [ ] **Step 2: 加 route 到 App.tsx**

读 `src/App.tsx`，加 `Inspect` import 和 `/_/inspect` route：

```tsx
import { Route, Routes } from 'react-router-dom';
import { Home } from './routes/index';
import { Inspect } from './routes/inspect';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/_/inspect" element={<Inspect />} />
    </Routes>
  );
}
```

- [ ] **Step 3: typecheck + build**

```bash
pnpm typecheck
pnpm build
```

Expected: 0 error；build 输出 dist/ 含 inspect chunk（如有 code split）或合进主 bundle。

- [ ] **Step 4: dev mode smoke**

```bash
pnpm dev &
DEV_PID=$!
sleep 5
echo '=== inspect page HTML loads ==='
curl -s http://localhost:5173/_/inspect | grep -o '<title>.*</title>'
kill $DEV_PID 2>/dev/null
sleep 1
```

Expected: 看到 `<title>AI 学习工具</title>` —— SPA 入口。inspect 实际渲染要走浏览器 SPA hydrate 才能看到表格 UI；本 task 不要求 e2e 浏览器测试。

- [ ] **Step 5: 提交**

```bash
git add src/routes/inspect.tsx src/App.tsx
git commit -m "feat(client): /_/inspect 观测页 (ToolCallLog + CostLedger 双 tab) (改进 9)"
```

## Context

- Working directory: `/Users/yukoval/yukoval-projects/the-learning-project/`
- 依赖 Task 5 的 endpoints `/api/_/logs/{tool_calls,cost}` 已 mount
- TanStack Query 已在 PR 1 装；不需要新 dep
- Tailwind v4 已配；可直接用 utility classes
- 不进主导航：只通过 URL 访问 `/_/inspect`

## Before You Begin

如果 build 报 `useQuery` 找不到，确认 `@tanstack/react-query` 已在 dependencies。如果 type 不匹配 v5 API，按 TanStack Query v5 规范用 `{ queryKey, queryFn }` object form（不是 v4 的 positional args）。

## Your Job

1. Steps 1-5 顺序执行
2. UI 简陋够用就行（table + tab）；不要扩展到搜索 / 导出 / 排序等
3. 不要修改 main.tsx 的 QueryClientProvider（已在）

## Report Format

- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- 创建 / 修改文件
- typecheck + build 输出
- dev smoke 输出
- Commit SHA

---

## PR 3 完成验收

回到 spec 改进 3 / 9 / 11(doc) / 12(doc) 的 Done 标志：

- [ ] **改进 3** — `PLANNING.md` § Phase 1 拆 1a / 1b（grep 命中）
- [ ] **改进 9** — `/api/_/logs/{tool_calls,cost}` endpoints + tests pass；`/_/inspect` 页面在 dev mode 能加载
- [ ] **改进 11 (doc)** — `mistakes.md § 2.3` 含 R2 提及；`architecture.md § 六` 已含 R2 行（PR 1 已落）
- [ ] **改进 12 (doc)** — `architecture.md § 5.6` Dreaming 实施栈写明；§ 六 含 Cron Triggers / Queues / Batch API 三行；`lanes.md § 调度` 引用 § 5.6
- [ ] **Followup #29** — `architecture.md § 5.5` 内自引用已修为 § 5.6（grep `§ 5\.5 Dreaming` 应 0 命中）

---

## Troubleshooting

**Q: D1 local mock 没 schema，smoke 报 "no such table"**

A: 跑 `pnpm exec wrangler d1 migrations apply DB --local` 给本地 D1 apply 初始 migration（PR 1 落地的 `drizzle/0000_*.sql`）。

**Q: TanStack Query v5 API 跟 plan 写的 v4 风格不符**

A: 已写 v5 object form `{ queryKey, queryFn }`。如果 import 路径变化，确认 `@tanstack/react-query` v5+。

**Q: `app.route('/api/_/logs', logs)` 路径不工作**

A: Hono 的 `route(prefix, subApp)` 把 subApp 内 `.get('/tool_calls', ...)` 自动 prefix 成 `/api/_/logs/tool_calls`。如果不工作，确认 sub-router 内路径用相对（`/tool_calls` 不是 `/api/_/logs/tool_calls`）。

---

## Open Questions（实施时再决）

- D1 cost_ledger 当前所有行 `cost` 都是 0（PR 2 留待 Phase 2 实施成本计算）；observation UI 显示 0 不算 bug
- inspect 页面是否要加 auto-refresh（每 30s polling）？Phase 1 手动 refresh 即可；如果用 TanStack Query `refetchInterval` 一行加上也行
- inspect 页面是否需要 mobile responsive？Phase 1 只在桌面用 OK
