# Phase 1 改进 · 设计 spec

> 2026-05-08 · 输入：12 项改进（5 项 Tier 1 解锁 + 5 项 Tier 2 完善 + 2 项技术栈缺口前置）

---

## 背景

当前状态：文档 v0.11 完整、scaffold 已搭（Zod + Drizzle schema 与文档对齐、技术选型完毕），但 Phase 1 推进卡在 12 个决策 / 缺口。本 spec 把这十二项固化为可执行设计。

- **Tier 1（改进 1-5）**：解锁 Phase 1 推进的硬卡点，必须先动
- **Tier 2（改进 6-10）**：不阻塞但回报高的完善项，与 Tier 1 同 PR 周期内做完
- **技术栈前置（改进 11-12）**：Phase 1.5 + Phase 2 启动前必须就位的基础设施缺口（R2 图片存储 / Dreaming 实施栈）—— 不在 Phase 1 实现，但 Phase 1 PR 周期内**写明设计 + 占位配置**，避免到时候返工架构

---

## 改进 1：锁定本地存储路线 → D1 远程优先

### 决策

Phase 1 直接走 Cloudflare D1（远程模式），不接 sqlite-wasm + OPFS。离线推到 Phase 4 用 PWA cache 补。

### Why

- sqlite-wasm + drizzle-sqlite-proxy 整合是被低估的 1-2 周工程（worker thread + query executor 适配）
- 自用工具初期"能用"远比"离线"重要
- Phase 4 反正要上 D1，提前满足同步需求 → Phase 4 自动减负
- 避免架构摇摆（已经有 sqlite-wasm vs Tauri better-sqlite3 两条 future path，再加远程 = 三选一焦虑）

### 实施要点

- `src/db/client.ts` 不再尝试在浏览器跑 SQLite；改成"客户端不持 DB，所有 mutation/query 走 worker RPC"
- worker 通过 `[[d1_databases]] binding = "DB"` 拿 D1 connection
- 用 `drizzle-orm/d1` adapter
- migration 走 `drizzle-kit generate` + `wrangler d1 migrations apply`
- client side：TanStack Query 缓存 + 乐观更新管 UI state；不持本地 DB

### Trade-off

- 弱网体验差（移动端实测后再补 cache）
- 离线录入消失 — 自用场景影响有限
- 数据全在 Cloudflare，但有定期 export（Phase 1 checklist 已列"数据导出"）兜底

### 文档改动

- `docs/architecture.md § 六 技术栈` 把"本地存储 = OPFS-backed sqlite-wasm"改成"Phase 1 = D1 远程；Phase 4 = D1 + PWA cache 离线层；Phase 3 Tauri 端用 better-sqlite3 镜像"
- `README.md` 同步技术栈表

---

## 改进 2：Worker 加 shared-secret auth

### 决策

`/api/*` 路径加中间件，要求 `X-Internal-Token` header 与 `INTERNAL_TOKEN` 环境变量匹配。

### Why

- Worker endpoint 公开 → 任何人扫到都能 burn 你 Anthropic 配额
- 自用工具不需要 Cloudflare Access（要 OAuth、要域名挂托管，过重）
- 一个 long random shared secret 能挡掉 99% bot scan

### 实施要点

```ts
// workers/src/index.ts
app.use('/api/*', async (c, next) => {
  const token = c.req.header('x-internal-token');
  if (token !== c.env.INTERNAL_TOKEN) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});
```

- `workers/.dev.vars` 加 `INTERNAL_TOKEN=<long-random>`（git ignore）
- 部署用 `wrangler secret put INTERNAL_TOKEN`
- 客户端走 `import.meta.env.VITE_INTERNAL_TOKEN`，build time 注入
- `src/ai/client.ts` 在 fetch headers 里塞这个 token

### 已知局限

- VITE_ env var 会暴露到浏览器 bundle，view source 看得到
- 这层 auth 实际上只挡 bot scan，挡不住决心攻击者
- 真要严起来 → Phase 4 上 Cloudflare Access

---

## 改进 3：Phase 1 闭环再瘦身（拆 Phase 1a / 1b）

### 决策

把当前 60+ 条 Phase 1 checklist 拆成两子段，1a 是「能上手」MVP，1b 是「补完」。

### Phase 1a · 最小可用（目标 5-7 天上手）

- DB driver 接 D1
- Worker auth 中间件
- Knowledge schema seed（文言文课标 import + AI 自动建议节点的人工确认 UI）
- Question + Mistake schema 接通 D1
- **manual** 录入页（粘贴题面 / 参考答案 / 错答 / 知识点 dropdown）
- AttributionTask 接通（10 类 cause + AI 自动归因 + 失败兜底走"待人工归因队列"）
- FSRS 复习队列（一个 OSS lib 搞定，如 `ts-fsrs`）+ 简陋复习 UI
- LearningItem 简化版（仅 pending / in_progress / done 三态走通；6 状态字段保留 schema，状态机本身先简化）
- AI Task runner 骨架（接通 AttributionTask 时顺手做最小版本：单 task / 单 provider / 写 ToolCallLog + CostLedger；多 task fallback chain 推 1b 或 Tier 2）

### Phase 1b · 补完（1a 跑出第一周数据后做）

- vision_single 录入路径（视觉模型 + 一击确认页）
- tool_quiz embedded check（Phase 1 quiz 骨架最小落地）
- StudyLog 录入入口（错题 / 题目 / note 旁批"+ 写学习日志"按钮）
- LearningItem 6 状态完整 + 优先级 score 公式
- AI 主动提议完成（DreamingProposal.kind=learning_item_completion）

### 推到 Phase 1.5+

- vision_paper（已是 Phase 1.5）
- reverse_mark（依赖 Note UI，本来就 Phase 2）
- LearningItem 复学机制 / hub status 自动聚合（Phase 2，依赖 dreaming）

### Why

- 当前 Phase 1 checklist 一周做不完，会陷入"一直在搭基础设施，没用过"困境
- "30 秒手动录一题 + 错因 + 明天能复习"的最小闭环 1a 5-7 天能上手
- 拿到第一周数据再迭代，避免设计-数据脱节
- 6 状态机 / Hub status 聚合 / 优先级公式都依赖"用了一段时间才知道权重对不对"，1a 不上无损

### 文档改动

- `PLANNING.md § Phase 1` 拆 1a / 1b 两段；保留模块文档 Phase 1 总观不变
- 各模块文档"已定 / 待 push"不动

---

## 改进 4：用 drizzle-zod 单一来源

### 决策

`drizzle-zod` 自动从 Drizzle 表生成 base Zod schema；`src/core/schema.ts` 只手写业务 union / refinement / cross-table validation。

### Why

- 现在 `src/core/schema.ts`（Zod）和 `src/db/schema.ts`（Drizzle）字段对齐靠人工，第一周改字段必漏
- `drizzle-zod` 是 Drizzle 团队维护的官方 OSS（符合"用 OSS 解成熟问题"偏好）
- 单测可以直接用生成的 schema 验证 DB roundtrip

### 实施要点

- `pnpm add drizzle-zod`
- `src/core/schema.ts` 拆两块：
  - 一个 generated 入口（用 `createInsertSchema` / `createSelectSchema` 自动生成）
  - 一个 business 入口（在 generated 上 `extend()` 收紧 enum / 加 refinement）
- 现有手写 Zod 中"业务 union 类"（如 `CauseCategory` enum、`MistakeStatus` enum、`Cause` 复合 schema 这种 JSON 内层结构）保留
- 现有手写 Zod 中"和 db 表字段一对一"的部分（如 `Knowledge` 顶层字段）改为 generated

### 风险

- drizzle-zod 在 nullish / json column 上的具体行为需要 verify（可能需要手动 cast）
- 实施时如发现 generated schema 不够精确，逐字段 `extend()` 收紧

### 验证

- 改完后 typecheck 必须通过
- 手写一份 Knowledge / Question / Mistake 的 insert + parse 单测，roundtrip 通过

---

## 改进 5：代码进库 + 配置补全

### 决策

创建一个 scaffold commit 把现有未追踪的代码全部进库，同时补缺的配置文件。

### 缺失文件清单

1. `workers/wrangler.toml`（PR 1 完成后的最终形态，含改进 11/12 的占位字段）：

```toml
name = "the-learning-project-api"
main = "src/index.ts"
compatibility_date = "2026-04-01"
compatibility_flags = ["nodejs_compat"]

# Phase 1 D1 binding（database_id 创建后填）
[[d1_databases]]
binding = "DB"
database_name = "learning-project"
database_id = "<TBD-after-d1-create>"

# 改进 11: Phase 1.5 起 R2 存图片
[[r2_buckets]]
binding = "IMAGES"
bucket_name = "learning-project-images"
preview_bucket_name = "learning-project-images-preview"

# 改进 12: Phase 2 起 dreaming / maintenance cron + queues（先注释掉占位，
# Phase 2 实施时再启用 + 填值）
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

2. `workers/.dev.vars.example`：

```
ANTHROPIC_API_KEY=sk-ant-xxx
INTERNAL_TOKEN=<generate-with: openssl rand -hex 32>
```

3. `.env.example` 补 `VITE_INTERNAL_TOKEN=<same-as-workers/.dev.vars>`

### Commit 内容

`chore: scaffold Phase 1 skeleton`

包含：

- 修改：`.gitignore`
- 新增：`README.md` / `package.json` / `biome.json` / `drizzle.config.ts` / `vite.config.ts` / `tsconfig.json` / `index.html` / `.env.example`
- 新增：`src/` 全部内容
- 新增：`workers/` 全部 + 新建的 `wrangler.toml` + `.dev.vars.example`

### Why

- 9 个 commit 都是 doc，所有代码 untracked → 没有起点 commit 后续重构无锚
- `wrangler.toml` 不在的话 `pnpm workers:dev` 直接报错
- `.dev.vars.example` 给后续协作（包括三月后的自己）一个 onboarding 锚

---

## 改进 6：AI Task Runner 落地

### 决策

worker 端实现一个 `runTask(taskKind, input, ctx)` 函数，把 metadata 查询 + Vercel AI SDK 调用 + ToolCallLog/CostLedger 写入一并做了。同时分层 `LLMTask` vs `LogicTask`，纯逻辑路由（如 `JudgeRouter` / `JudgeExactTask`）不进 LLM registry。

### Why

- 当前 `src/ai/registry.ts` 只有 metadata，没 runner，无法实际跑 task
- Phase 1 checklist 的"AI Task Layer 骨架 / Tool registry / Budget / 观测"四件互相依赖
- 一并落地避免分散返工
- 不分层 LLM/Logic 会让 registry 长出半数没意义的 budget / fallback 字段

### 实施要点

- 文件位置：`workers/src/ai/runner.ts`（worker 端）
- registry 共享：`src/ai/registry.ts` 当前在 client 侧；改进 6 时把 registry 移到 `shared/ai/registry.ts`，同时被 client 和 worker import（vite + wrangler 都通过相对路径访问）
- runner 三件事：
  1. 查 TaskDef → 拿 model / provider / budget / allowed tools
  2. 调 Vercel AI SDK：单轮用 `generateObject`（structured output），多轮 tool calling 用 `generateText` + `tools` array
  3. 每次 tool call 完成 → write ToolCallLog；总 token / cost → write CostLedger
- Budget enforcement：
  - `maxIterations` → AI SDK 的 `maxSteps` 参数
  - `maxCost` → 每轮 tool call 后累计检查，超 budget 抛 `BudgetExceededError`
  - `timeout` → AbortController + setTimeout
- 失败降级：超 budget 1 轮 nudge "必须给最终答案"；仍不收敛 → fallback 到 `degraded=true` 的 stub 返回，标记到 caller

### LogicTask 处理

`JudgeRouter` / `JudgeExactTask` / `JudgeKeywordTask` 不调 LLM，**不进 registry**。封装成普通 function（`workers/src/ai/judges/`），在 worker 端按需调用。Schema 上保持 `JudgeKind` enum 一致即可。

### 文档改动

- `docs/architecture.md § 五 AI 任务层` 加一段 "5.5 Runner 实现" 说明 runner 在 worker 端、依赖关系
- `architecture.md § 七 数据模型骨架` 中 `Task {}` registry 注释加 "LLM-only；LogicTask 不进此处"

---

## 改进 7：tool calling 循环位置 → server (worker)

### 决策

tool calling 多步循环跑在 **worker 端**，client 只负责发起请求 + 接 stream。

### Why

- client 跑 → API key 暴露（无解）
- server 跑 + 跨请求保留 turn state → 需要 KV / Durable Objects 持 state，复杂且不必要
- server 一次跑完整循环 + stream progress 给 client：业界标准做法
- Vercel AI SDK 的 `streamText` / `streamObject` 已经把这件事的实现细节封掉了

### 实施要点

- worker `/api/ai/:task` 用 Hono 的 `streamText` / `streamSSE` 返回
- AI SDK `streamText({...tools, maxSteps})` 自带 tool call 循环 + stream 输出
- client 用 `fetch` + `ReadableStream` 接，TanStack Query mutation 配合 progress callback
- 单轮 task（如 AttributionTask 单 generateObject）走普通 POST 不开 stream；只有 tool calling 多轮的 task 开 stream
- ToolCallLog 在 worker 端 stream 过程中实时写入

### 文档改动

- `docs/architecture.md § 五 AI 任务层` 加一段明确：tool calling 循环位置 = server (worker)；client 只发起 + 接 stream
- 跟改进 6 的 doc 改动合并到 § 5.5

---

## 改进 8：PWA manifest + service worker

### 决策

用 `vite-plugin-pwa` + `workbox`（OSS 成熟方案）落 PWA 基础设施。Phase 1 只配 manifest + 安装 prompt，不开 cache 策略；Phase 4 真要离线时再加 workbox runtime caching。

### Why

- Phase 1 checklist 已列 "PWA 跑通"
- vite-plugin-pwa 是行业标准，零自建（符合"用 OSS 解成熟问题"）
- 移动端"加到主屏幕"靠 manifest；不上 PWA 等于在桌面浏览器里跑，移动端体验差
- Phase 4 离线层基于这个 cache 自然演化

### 实施要点

- `pnpm add -D vite-plugin-pwa`
- `vite.config.ts` 加 plugin + manifest 配置：
  - `name: "AI 学习工具"`、`short_name: "学习"`、`theme_color: "#0f172a"`
  - `display: "standalone"`、`start_url: "/"`、`scope: "/"`
  - `icons`: 192/512 PNG（暂用占位 SVG → PNG，后续 Phase 4 再美化）
- `index.html` 加 `<link rel="manifest">` 和 `<link rel="apple-touch-icon">`
- `registerType: 'prompt'`：让用户决定何时更新（自用工具不强推刷新）
- `workbox: { runtimeCaching: [] }` 显式留空 —— Phase 1 不缓存任何 API 响应

### Trade-off

- Phase 1 离线访问没用，但安装到主屏 + 启动闪屏 + standalone 模式有了
- icon 是占位，Phase 4 体验打磨阶段再换

---

## 改进 9：观测 UI（`/_/inspect`）

### 决策

加一个简陋但能用的 `/_/inspect` 路由，显示最近 N 条 ToolCallLog + CostLedger 聚合。调 prompt 用，不进主导航。

### Why

- ToolCallLog + CostLedger 都建表了但没看的入口 → 等于白建
- 调 prompt 时绝对需要看 raw input/output，否则瞎调
- 自用工具，UI 简陋无所谓，能查就行

### 实施要点

- `src/routes/inspect/index.tsx`（不出现在主导航；URL 直接访问）
- 两个 tab：
  - **ToolCallLog**：最近 50 条 + filter by `task_kind` + 展开看 `input_json` / `output_json`
  - **CostLedger**：按日期 + task + model 聚合，显示当日 / 当周 / 当月累计 + 接近预算上限警告
- 数据走 worker 新增 endpoints：
  - `GET /api/_/logs/tool_calls?limit=50&task_kind=...`
  - `GET /api/_/logs/cost?range=day|week|month`
- 这两个 endpoint 也走 `/api/*` 的 auth 中间件保护
- Phase 1 不做实时刷新；手动 reload 即可

### 文档改动

- 无（操作型工具，不需要文档化）

---

## 改进 10：`subjects/wenyan/` 目录占位 + 课标 seed 路径

### 决策

建 `src/subjects/wenyan/` 目录 + 占位文件，明确 wenyan-specific 代码归属。`core/` 不依赖 `subjects/`；`subjects/` 可依赖 `core/`。

### Why

- README 提了但目录不存在 → 文言文课标 seed 等 wenyan-specific 代码会找不到归属
- 不立刻建路径 → 第一波 wenyan 逻辑必然灌进 `core/`，污染未来扩展
- 路径建好的成本是 5 分钟，污染后清理是几小时

### 实施要点

- `src/subjects/wenyan/curriculum.json` —— 文言文课标的初始 seed（先放空数组占位 `{ "version": 0, "knowledge_seeds": [] }`）
- `src/subjects/wenyan/seed.ts` —— 导入 curriculum.json + 生成 Knowledge schema insert payload 的 helper（实际写 D1 的逻辑在 worker；这个文件只负责 transform）
- `src/subjects/wenyan/README.md` —— 一句话说明这里放什么 + curriculum.json 的 schema 链接
- `src/subjects/wenyan/index.ts` —— re-export `seed`、`curriculum`
- 校验依赖方向：core/ 里 `import` 不能出现 `from '@/subjects/...'`（biome / eslint 后续可加 lint rule）

### 文档改动

- 无（README 已经说了 core/ vs subjects/ 边界）

---

## 改进 11：Cloudflare R2 提前到 Phase 1.5（图片存储）

### 决策

把 R2 接入提前到 Phase 1.5（`vision_paper` 上线时），不等 Phase 4 云同步阶段。Phase 1 阶段在 wrangler.toml 加占位 binding 字段。

### Why

- `vision_paper` 卷子拍照单张 2-5MB，多页一次上传 10MB+
- Workers KV 单 value 25MB 上限，且不适合二进制 / 列表检索
- 客户端 blob URL 不持久 → 用户审核后批量录入时图片消失
- R2 是 Cloudflare object storage，免费 10GB / 月 + 与 Workers 同账号一行 binding 接通
- vision_single（Phase 1）原本可以用 base64 inline 传给 vision API 不存 R2，但 vision_paper 多图必存
- 文档里 R2 在 Phase 4，是过期假设（写在 vision_paper 提前到 Phase 1.5 之前）

### 实施要点

**Phase 1（本 spec 范围内做的占位）**：

- `workers/wrangler.toml` 加：

```toml
[[r2_buckets]]
binding = "IMAGES"
bucket_name = "learning-project-images"
preview_bucket_name = "learning-project-images-preview"
```

- bucket 实际创建（`wrangler r2 bucket create`）推到 Phase 1.5 实施时

**Phase 1.5（实施改进 11 主体）**：

- worker `POST /api/upload/image`：接 multipart → 写 R2 → 返 r2 key
- DB schema 复用现有 `Mistake.wrong_answer_image_refs[]` / `Answer.image_refs[]`，存 r2 key 字符串
- vision pipeline：worker 从 R2 拉图 → 调 Anthropic Vision（base64 inline 给 API）
- 安全：R2 bucket 私有，所有读写走 worker auth 中间件（改进 2 已覆盖 `/api/*`）

### 与现有改进的依赖

- 改进 5（wrangler.toml 补全）：包含 r2_buckets binding 占位（仅占位，不创建 bucket）
- 改进 2（worker auth）：覆盖未来的 `/api/upload/*` / `/api/r2/*` 路径

### 文档改动

- `docs/architecture.md § 六 技术栈` 把"云同步 = D1 + R2 (Phase 4)"改成"Phase 1.5 起 R2 存图片；Phase 4 起 R2 用作云同步附件层"
- `docs/modules/mistakes.md § 2.3` vision_paper 流程加一句：图片走 R2 存储，传 r2 key 给 vision pipeline

---

## 改进 12：Dreaming 实施栈写入 architecture

### 决策

`docs/architecture.md` 加一节 `§ 5.5 Dreaming 实施栈`，明确 Dreaming / Maintenance 在 Cloudflare 上的具体接通方式（Cron Triggers + Queues + Batch API）。Phase 1 不实现，但 Phase 1 PR 周期内 doc 必须写明，避免 Phase 2 实施时现写架构。

### Why

- 当前 `architecture.md § 5.3` 写了"异步 batch 夜间跑 50% 折扣"，但没说"夜间"怎么触发、batch API 怎么提交、N 条任务怎么分散
- 文档 § 6 技术栈里也没列 Cron Triggers / Queues
- Phase 2 实施 dreaming 时如果架构没定，会拖延整个 Phase 2
- 三个 Cloudflare 原生组件（Cron Triggers / Queues / Workers）+ Anthropic Batch API 都是成熟方案，写明就是"用 OSS 解成熟问题"的延伸

### 拟新增内容（写入 architecture.md § 5.5）

```markdown
### 5.5 Dreaming / Maintenance 实施栈

Dreaming 和 Maintenance lane 都是"定时触发 + 大批量产出 + 写 propose 表"的模式，
跑在 Cloudflare 原生组件上：

#### 触发：Cloudflare Cron Triggers

cron 表达式定义在 wrangler.toml：

```toml
[triggers]
crons = [
  "0 18 * * *",   # 每天 18:00 UTC = 北京 02:00，跑 dreaming 主流程
  "0 19 * * 0"    # 每周日 19:00 UTC，跑 weekly review
]
```

cron worker 不直接生成 proposal，只负责 dispatch（扫 D1 找候选 + 推 Queue）。

#### 任务分发：Cloudflare Queues

DreamingTaskQueue / MaintenanceTaskQueue 两个队列。

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

#### 调度文件
所有 cron 入口、queue consumer、batch poller 都放在 `workers/src/dreaming/` 目录：

```
workers/src/dreaming/
  cron.ts            # cron 触发入口
  consumer.ts        # queue 消费者
  batch-submit.ts    # batch API 提交
  batch-poll.ts      # batch API 结果拉取
  scanners/          # D1 扫描器（mastery 阈值、错题密度等）
```
```

### 与现有改进的依赖

- 改进 5（wrangler.toml）：补 `[triggers] crons = []` 和 `[[queues.producers]]` / `[[queues.consumers]]` 占位字段
- 改进 6（AI Runner）：runner 接口要兼容"批量提交 batch + 后续拉结果"模式（不需要立刻实现，但接口 shape 留出）
- 改进 7（tool calling = server）：dreaming 也跑在 server，复用同一套 Workers + AI SDK 设施

### 文档改动

- `docs/architecture.md` 在 § 5.4 后插入新的 § 5.5 Dreaming / Maintenance 实施栈
- `docs/architecture.md § 六 技术栈` 增加 Cron Triggers / Queues 两行
- `docs/modules/lanes.md § 调度` 把 "两条 lane 都走 dreaming batch（夜间）" 改成引用 `architecture.md § 5.5`

---

## 顺序 + 依赖

```
[改进 5: 进库 + wrangler.toml]
  ├→ [改进 1 + 2: D1 + Worker auth]   一个 PR 做（都改 worker）
  │     └→ [改进 6 + 7: AI runner + tool calling = server]   依赖 1+2 worker 已上
  │           └→ [改进 9: 观测 UI]    依赖 6 跑出真数据
  ├→ [改进 4: drizzle-zod]            独立纯重构，可并行
  ├→ [改进 8: PWA]                    独立，纯前端配置
  ├→ [改进 10: subjects/wenyan/]       独立，目录占位
  └→ [改进 3: Phase 1 拆分文档改动]   最后，前面真落地后再调路线图
```

依赖说明：

- 改进 5 必先：commit 锚点
- 改进 1 + 2 强相关：合并一个 PR
- 改进 6 + 7 强相关：runner 实现就涉及 tool calling 位置，文档改动同步（架构 § 5.5）
- 改进 9 需要 6 已经能产出 ToolCallLog / CostLedger 数据
- 改进 4 / 8 / 10 互相独立，可任意穿插
- 改进 3 最后：前面真落地了，路线图调整才有意义

### 推荐执行 batch 划分

可以拆三个 PR 节奏推进：

1. **PR 1（基础设施）**：改进 5 + 1 + 2 + 4 + 10 + 11(占位) + 12(占位)
   一次把 D1、auth、code 进库、schema 单源、subjects 路径占位、R2 binding 占位、cron/queues 占位全做了。完成后 Phase 1a 可启动开发
2. **PR 2（AI 接通）**：改进 6 + 7 + 8
   AI runner + tool calling stream + PWA 一起。完成后 AttributionTask 真能跑、移动端能装
3. **PR 3（路线 + 观测 + 文档）**：改进 9 + 3 + 11(doc) + 12(doc)
   观测 UI + Phase 1 拆 1a/1b + R2 文档改动 + dreaming 实施栈写入 architecture.md
   注：改进 11 和 12 的"占位配置"在 PR 1，"主体设计 doc 写入"在 PR 3；R2 bucket 实际创建和 cron worker 实现都不在本 spec 范围

完整实现（R2 上线 / dreaming 跑起来）：

- **改进 11 实施主体**：Phase 1.5 vision_paper 落地时
- **改进 12 实施主体**：Phase 2 dreaming 启动时

---

## 完成标准

| Item | Done 标志 |
| --- | --- |
| 1. D1 路线 | `pnpm workers:dev` 起来 + client 能从 D1 读到 seed knowledge node |
| 2. Worker auth | curl 不带 header 返 401；带正确 header 通过 |
| 3. Phase 1 拆分 | PLANNING.md § Phase 1 拆 1a / 1b；1a checklist 每条单天内完成 |
| 4. drizzle-zod | core/schema 不再与 db/schema 重复定义字段；typecheck + roundtrip 单测通 |
| 5. 进库 | git log 看到 scaffold commit；wrangler.toml + .dev.vars.example 在仓库 |
| 6. AI Runner | `runTask('AttributionTask', {...})` 在 worker 端跑通，写一条 ToolCallLog + CostLedger |
| 7. Tool calling = server | architecture.md § 5.5 写明位置；改进 6 实现走 stream 跑通 |
| 8. PWA | 移动端 Safari "添加到主屏幕" 出现安装按钮；启动后是 standalone 模式 |
| 9. 观测 UI | `/_/inspect` 能看到改进 6 跑过的 ToolCallLog；CostLedger 当日累计正确 |
| 10. subjects/wenyan/ | 目录 + 4 个文件存在；core/ 中 grep 不到 `from '@/subjects'` |
| 11. R2 占位 + 文档 | wrangler.toml 含 r2_buckets binding 占位；architecture.md § 六 + mistakes.md § 2.3 doc 改动落地 |
| 12. Dreaming 实施栈文档 | architecture.md § 5.5 + § 六 + lanes.md § 调度 改动落地；wrangler.toml 含 cron / queues 占位字段 |

---

## Open questions（实施时再决）

- D1 production database id：等用户 `wrangler d1 create` 后填
- INTERNAL_TOKEN 生成策略：脚本一次生成 + 同步 client/server，还是 wrangler secret put 后人工同步到 .env
- drizzle-zod 在 json column / nullish 上的具体生成结果：实施时 verify
- registry 共享路径：放 `shared/ai/registry.ts` 还是用 path mapping 让 worker 直接 import `src/ai/registry`？实施 6 时决定（取决于 wrangler 对 monorepo 路径的支持）
- AI SDK `streamText` vs `streamObject` 在 Cloudflare Workers 上的稳定性：实施 7 时 verify（Workers runtime 对 Node stream API 支持有限）
- PWA icon 占位：先用 1 张 SVG 转 192/512 PNG 还是直接 emoji-png？Phase 4 真正美化前都是占位
- R2 bucket 命名 / 分区策略（per-user prefix? per-domain prefix?）：Phase 1.5 实施时再决
- Cron 表达式具体时间（北京 02:00 是默认，要不要按用户作息调）：Phase 2 实施时再决
- Queue 名字 + consumer batch_size / max_concurrent：Phase 2 实施时按真实负载调
- Phase 1a 跑通后，下一步是 Phase 1b 还是直接跳 Phase 1.5（批改识别）？等数据出来再决，不在本 spec 范围
