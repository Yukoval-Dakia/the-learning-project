# M2：练习流竖切 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans。

**Goal:** 应然练习面端到端：录入的题被 composeDailyStream 排进流 → 流 UI 作答（散题即时反馈 / 卷缓冲反馈）→ 判分 → FSRS 更新 → 不服判异步重判直接生效。验收后删除旧 review/practice 页。

**Architecture:** 总 spec REV 2 §4-M2 + P2 spec §2 概念设计（流编排器 / 卷架 / 申诉链 D15）。UI 按 claude design 设计稿（`.omc/design-handoff/loom-refresh/`，pface-* 系列；chat7 已答 §6 四开放题：织线纵轨 / 摞纸卷卡 / 增补珊瑚光+通知 pill / 双节奏语义色）。采伐配方沿用 M1 三联（随迁测试绿 + typecheck + 零残留 grep）。

**Linear:** YUK-316。分支 `yuk-316-m2-practice-stream`。

**红线：** 勘察 grep 含 tests/ 与注释路径；每 task typecheck 绿；UI 任务（T6）须用户 pre-flight 批准后动工；作答事实只写 event（stream_item 只是日程载体）；visible_to_user 门控（卷防作弊）迁移中显式测试覆盖。

**出范围：** 提议生命周期契约 + applier（M4）；questions CRUD / quiz-gen / timeline 路由（quiz 域 D16，留旧栈，vite proxy 兜底）；夜链容器（M4——M2 流生成 = lazy compose + 手动 recompose）。

---

### Task 1: 设计稿入库 + practice API 簇上 Hono（M1 配方复刻）

**Files:**
- Create: `docs/design/loom-refresh/`（从 `.omc/design-handoff/loom-refresh/` 拷入：chats/ + project/ 的 pface/practice 相关源 + README；截图/字体可裁剪）
- Modify: `src/capabilities/practice/api/*.ts`（8 个既有 body：kernel v2 签名核对）
- Create: `src/capabilities/practice/api/` 新 body（从 Next 壳采伐剩余路由：sessions×4、appeal、plan、due、solve 链×3、practice/[id] GET、answer PUT 等——以 manifest 18 条为准逐条核对现状）
- Modify: `src/capabilities/practice/manifest.ts`（18 条全部补 `load` thunk）
- Modify: `app/api/review/**`、`app/api/practice/**`、`app/api/questions/[id]/solve/**` 旧壳 → shim 形态（param 路由 `await ctx.params` 解包，M1 模式）
- Test: 测试随迁分区命名；`server/app.unit.test.ts` 不回归

**Steps:**
- [ ] 设计稿入库 commit（独立 commit，便于 review 时略过）
- [ ] 勘察：manifest 18 条 ↔ 包内 api/ 现状 ↔ Next 壳现状 三方对照表（哪些 body 已在包、哪些还在壳）
- [ ] 逐条迁移：git mv body → 包内命名 → kernel v2 签名（param 路由 `(req, params)`）→ 旧壳 shim → 测试随迁
- [ ] manifest 全量补 load thunk；`pnpm vitest run --config vitest.unit.config.ts src/capabilities/` 绿
- [ ] typecheck + 目标 db 测试绿 → commit
- [ ] rw:api 冒烟：GET /api/review/due 带 token 200、POST /api/review/sessions 200、param 路由透传

### Task 2: practice_stream_item 表 + composeDailyStream + 流 API

**Files:**
- Modify: `src/db/schema.ts`（practice_stream_item 表，按 P2 spec §2.1 形状：id/date/position/item_kind/ref_id/source/status/reasoning/added_by/created_at/updated_at）
- Create: `drizzle/` migration（`pnpm db:generate`）
- Create: `src/capabilities/practice/server/stream-composer.ts`（纯函数核心 `composeDailyStream(inputs) -> StreamPlan`：输入 = FSRS 到期投影（due-list 内化）+ 错题变体轮换 + 新学待检 + 当日已有卷；约束 = 日容量 warning 水位 + 硬顶（护栏两层语义）、跨学科 round-robin）
- Create: `src/capabilities/practice/server/stream-store.ts`（IO 壳：物化 StreamPlan → 表、状态推进、点播插入、composer_live 增补）
- Create: `src/capabilities/practice/api/stream.ts`（GET /api/practice/stream?date=today——当日为空时 lazy compose；POST /api/practice/stream/items（点播）；PATCH item 状态推进；POST /api/practice/stream/recompose（手动重排，dev/工作台入口））
- Test: `stream-composer.unit.test.ts`（纯函数：排序/容量/round-robin/来源混排）+ `stream.db.test.ts`（lazy compose、状态机 pending→in_progress→done/skipped、点播插入位置、双日隔离）
- Modify: `src/capabilities/practice/manifest.ts`（新路由 + events.actions 若有新 action）

**Steps:**
- [ ] schema + migration → `pnpm test:migration` 绿
- [ ] composer 纯函数 TDD：先写 unit 测试（到期优先/变式跟随错题/容量截断/卷置尾惯例——对照设计稿数据形状）→ 实现 → 绿
- [ ] stream-store + API TDD：db 测试先红后绿
- [ ] `pnpm audit:schema`（新表字段 write path 全覆盖，不进 allowlist）
- [ ] typecheck + commit

### Task 3: 申诉自动重判链（D15）

**Files:**
- Modify: `src/capabilities/practice/api/`（appeal body 升级：写 appeal_request event 照旧 + 入 rejudge job）
- Create: `src/capabilities/practice/jobs/rejudge.ts`（pg-boss handler：原题+原作答+原判分+用户理由重跑 judge（提示词明示异议）→ 改判 correction event supersede 原 judge / 不改判维持 event 留痕 → FSRS 单一入口重写 → SSE 通知）
- Modify: `src/server/boss/handlers.ts`（registry 挂 rejudge——旧 worker 兼容，M1-T3 模式）
- Test: `rejudge.db.test.ts`（E2E：appeal→job 消费→correction→FSRS 重投影断言；幂等键 = appeal_request event id；不改判分支留痕）

**Steps:**
- [ ] 勘察现 appeal stub 与 correction/supersede 既有机制（effective-truth.ts）
- [ ] TDD：db 测试先行 → handler 实现 → 绿
- [ ] typecheck + commit

### Task 4: 卷架查询 API

**Files:**
- Modify/Create: `src/capabilities/practice/api/papers-list.ts`（扩展：状态（待做/在做/完成）× 来源（AI 打包/点播/导入）筛选 + 完成卷成绩摘要）
- 复盘读路径：paper-detail 既有逻辑重组（逐题作答+判分+整卷小结+错题去向 trace：归因事件 + 变式排期）
- Test: papers-list.db.test.ts 扩展用例

**Steps:**
- [ ] 对照设计稿 shelf/retro 数据形状（PFACE.shelf）定 wire shape
- [ ] TDD → 实现 → 绿 → typecheck + commit

### Task 5: 真题端到端验收（后端链路）

- [ ] 单进程栈（RW_WORKER=1）：用 M1 录入链放入真题 → recompose → GET stream 见 item → 作答 submit → 判分 + FSRS 更新断言 → appeal → rejudge job 消费 → correction 生效 → stream 反馈更新
- [ ] 验收数据全家清理（M1 教训：脚本放 .omc/ 下跑、exit code 不接管道）

### Task 6: 流 UI（⚠️ 须 pre-flight 批准后动工）

**pre-flight 内容（动工前向用户提交）：**
- 引用设计稿：`docs/design/loom-refresh/project/pface-{stream,solo,paper,shelf}.jsx` + `screen-pface.jsx` + `pface.css` + chat7 四开放题答案
- 组件类型：SPA 路由页（/practice）+ 视图组件（流/散题/卷/结果/卷架/复盘）+ 解题会话抽屉
- 文件清单：Create `src/capabilities/practice/ui/`（PracticeFacePage + PfStream/PfSolo/PfPaper/PfResult/PfShelf/PfRetro/PfCoach + practice-face.css（pface.css 按 tokens 对齐移植））；Modify `web/src/router.tsx`（登记 /practice）

**Slices（每 slice：实现 → playwright 截图对照设计稿 → commit）：**
- [ ] slice 1: 壳 + seg 切换（流/卷架）+ css 移植
- [ ] slice 2: 流视图（织线轨/开场白/进度/item 卡（散题平卡+卷摞纸）/跳过流尾/收尾短结）
- [ ] slice 3: 散题作答态（选项 1-4 键/文本/手写上传/即时判分着色/评级三档可改/不服判表单+pending+改判回执/解题会话抽屉——后端 solve 链）
- [ ] slice 4: 卷模式（缓冲横幅/中性 pip/←→ 导航/草稿保存/退出保留/交卷确认）+ 结果页（分数 hero/分布条/整卷小结/逐题展开/trace）
- [ ] slice 5: 卷架（三区+来源筛选）+ 复盘 + 点播 composer（生成中占位→完成 toast）+ 增补通知 pill
- [ ] 视觉环：全 slice 对照设计稿截图（丰富数据，先整体形态后细节）

### Task 7: 退役 + 全 gate + PR

- [ ] 拆除：`app/(app)/review/` + `app/(app)/practice/`（单 commit 可整体 revert）；残留链接 404 属预期
- [ ] 旧 Next review/practice/solve API 壳拆除（manifest 已挂 Hono 的 18 条）；vite proxy 更新（/api/review、/api/practice、/api/questions/[id]/solve 切 8787——questions CRUD 留 3000）
- [ ] postman spec 同步（删已迁路径）+ `pnpm gen:postman`
- [ ] 零残留 grep（含 tests/ 与注释）
- [ ] 全 gate：typecheck / lint / audit×3 / `pnpm test` / next build / vite build
- [ ] PR（含 `Closes YUK-316`）→ **停等用户 merge**

## Self-Review

- spec M2 验收行 ↔ T5（端到端）+ T3（申诉）+ T2（排流/FSRS）；设计稿四开放题 ↔ T6 slices；D15 直接生效语义 ↔ T3 correction 无 proposal；D16 quiz 出范围 ↔ 红线区。
- 占位符：无 TBD；T1 勘察步骤显式（三方对照表）；T6 等 pre-flight 是刻意 gate 非占位。
- 风险：submit 532 行已在 P2a 拆三段（validate/judge/persist），T1 只动签名不动语义；Coach 协议切换风险随夜链推迟到 M4 消失；流表与 event 不变量冲突已在 spec §2.1 论证（status 由作答事件驱动）。
