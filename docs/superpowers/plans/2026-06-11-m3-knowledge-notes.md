# M3：知识与笔记 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans。

**Goal:** 知识面可浏览可修订（图谱 + 节点页在 SPA 跑通），笔记链路通（阅读/块编辑/Living Note 新触发器）。验收后删除旧 knowledge/notes 页面与已迁 API 壳。

**Architecture:** 总 spec REV 2 §4-M3：knowledge + notes **两包**采伐（裁决见下）+ 图谱/节点页/笔记 UI 按 claude design 设计稿（`docs/design/loom-refresh/project/screen-knowledge.jsx` / `screen-knowledge-detail.jsx` / `note-editor.jsx` / `screen-note-reader.jsx`）在 `web/` 重建 + Living Note 触发器换源（D6：error_rate 死，流作答 = mastery_change 信号——**M2 submit 已接入** `enqueueMasteryNoteRefine`，practice/api/submit.ts L592）。采伐配方沿用 M1/M2 三联（随迁测试绿 + typecheck + 零残留 grep）。

**Linear:** YUK-317。分支 `yuk-317-m3-knowledge-notes`。

**Map 勘察资料：** `~/.claude/jobs/bac0b350/tmp/m3-map/`（synthesis.md + 各维报告；notes-server.md 与 schema-data.md 两份已证伪作废，notes 域以重勘报告为准——见 git 不入库，要点已内化进本 plan）。

**红线：** 勘察 grep 含 tests/ 与注释路径；每 task typecheck 绿；UI 任务（T6/T7）须用户 pre-flight 批准后动工；「科目是视角不是结构」——派生轴（getEffectiveDomain），任何新代码禁 subject 列；被砍功能的表不删（墓碑注释）；embedded-check attempt route 同时服务 teaching_check，**拆 error_rate 信号时不得误伤 teaching_check 分支**。

**出范围（M3 不动）：** 提议生命周期契约真身 + actions.ts applier 按 kind 进包（M4——M3 期间 knowledge/notes 包跨域 import `@/server/proposals/*`、`@/server/events/*` 照旧）；dreaming_nightly 夜链容器（M4）；embedded_check_generate handler 与 attempt route 本体（D6 链路，M5 拆除采石场统一删，M3 只断 error_rate 触发线 + 新 UI 不渲染 check 块）；dwell 遥测 / presence / editing-session 路由（⚖️ 争议行未裁——`src/server/artifacts/presence/` + `editing-session.ts` + `/api/editing-session/*` 全部留旧位置旧栈）；today/ai-changes 路由（M4 工作台）；学习记录 D11（study-log 已是 410 墓碑壳 + learning_record 表墓碑保留，M3 无事可做）。

---

## 裁决记录（Map 阶段 8 个确认点）

| # | 问题 | 裁决 | 理由 |
|---|---|---|---|
| 1 | knowledge 与 notes 一包还是两包 | **两包** | 两个 surface（图谱/节点页 vs 笔记阅读编辑）、两套 AI 任务族；node-page→notes-read 是单向读，走包导出即可。包 = 旅程内的 capability（practice 先例） |
| 2 | proposals/actions、writer、events/queries 归属 | M3 留旧位置 | 提议生命周期真身是 M4；过渡期跨域 import 是 M1/M2 既成模式 |
| 3 | Living Note 流作答信号契约 | mastery_change 即新信号源 | M2 submit persist 已接 `enqueueMasteryNoteRefine`；M3 删 error_rate（D6）后五信号剩四（mark_wrong/mastery_change/dwell/dreaming），无需新增 kind |
| 4 | embedded-check 墓碑边界 | 最小刀 | route/handler/UI 旧树原地不动（M5 删）；M3 只删 note-refine-triggers 的 error_rate kind 及其 attempt route 调用行；schema 列（artifact.embedded_check_status、artifact_block_ref.ref_kind='embedded_check'、question.source='embedded'）加墓碑注释；新 notes UI 不渲染 check 块 |
| 5 | 图谱重建范围 | 布局逻辑移植 + 渲染层重写 | `src/ui/knowledge-graph/{layout.ts,mastery-tone.ts}` 是纯逻辑（cytoscape+fcose headless）随迁包 ui/；1365 行 KnowledgeGraph.tsx 渲染层按设计稿在 web/ 重写 |
| 6 | presence/dwell | 不裁不搬不删 | spec 标 ⚖️ 非 M3 必裁；笔记保存（PATCH body-blocks）与 presence 无关，新编辑器不依赖它 |
| 7 | boss handlers 归属 | 代码随包归位，调度形态不动 | note_generate/note_verify/note-refine/hub_auto_sync_nightly → notes 包 jobs/；knowledge 域 handler（propose/edge-propose/attribution 等，实施时按主依赖核对）→ knowledge 包 jobs/；dreaming_nightly、embedded_check_generate 留旧。挂载沿 M2 rejudge 先例（handlers.ts 动态 import） |
| 8 | 测试随迁分区 | 照搬 M2 约定 | 包内 `*.db.test.ts`/`*.unit.test.ts` 命名分区；unit 白名单（vitest.shared.ts fastTestInclude）同步更新路径 |

---

### Task 1: 双包骨架

**Files:**
- Create: `src/capabilities/notes/manifest.ts`、`src/capabilities/notes/CONTEXT.md`
- Create: `src/capabilities/knowledge/manifest.ts`、`src/capabilities/knowledge/CONTEXT.md`
- Modify: `src/capabilities/index.ts`（组合根登记两包）

**Steps:**
- [x] 对照 practice 包 manifest 形态建两包骨架（routes 先空数组，T4 填）；CONTEXT.md 一页纸写明表认领（knowledge/knowledge_edge/knowledge_mastery → knowledge 包；artifact/artifact_block_ref → notes 包，注明 tool_quiz 形态由 practice 过渡期跨域写、M5 对账）与「科目是视角」红线
- [x] typecheck 绿 → commit

### Task 2: notes/artifacts 后端采伐 + Living Note 触发器换源

**Files:**
- Move: `src/server/artifacts/{note-page,notes-read,body-blocks,body-blocks-edit,block-refs,sections,hub-dismiss,note-refine-apply,note-refine-policy,note-refine-proposals,note-refine-triggers}.ts` → `src/capabilities/notes/server/`（**不搬**：editing-session.ts、presence/）
- Move: 随迁测试（block-refs 644 db / body-blocks-snippet 137 unit / hub-dismiss 165 unit / note-page 297 db / note-refine-triggers 95 unit / notes-read 201 db / sections 189 db）。**unit 测试沿 M2 先例处理：重命名为 `*.unit.test.ts` 让 `src/capabilities/**/*.unit.test.ts` 约定 glob 接管 + 从 vitest.shared.ts fastTestInclude 删除旧显式路径条目**（不是改路径——否则 audit:partition 报漂移）
- Move: `src/server/boss/handlers/{note_generate,note_verify,note-refine,hub_auto_sync_nightly}.ts` + 测试 → `src/capabilities/notes/jobs/`；`src/server/boss/handlers.ts` 挂载改动态 import（M2 rejudge 先例）
- Modify: `src/capabilities/notes/server/note-refine-triggers.ts`（删 error_rate：flag map + `enqueueErrorRateNoteRefine`；文件头注明 D6 + 新信号源 = 流作答 mastery_change）。**注意 `NoteRefineTriggerKind` 枚举真身在 `src/server/boss/handlers/note-refine.ts` L36-41（triggers.ts 只是 type-import）**——该 handler 正随本 task 迁 notes/jobs/，enum 删除在 handler 文件做
- Modify: `app/api/embedded-check/attempt/route.ts`（删 L182-189 error_rate 触发行 + import；route 其余原地不动——teaching_check 分支 + learning_record 写照旧，M5 拆）
- Modify: 域外 import 改道（按重勘报告第 7 节清单）：13 条旧路由 + `src/server/orchestrator/{learning_intent,teaching}.ts` + `src/server/proposals/actions.ts` + `src/server/boss/handlers/dreaming_nightly.ts`、`embedded_check_generate.ts` + `src/capabilities/practice/api/submit.ts`（enqueueMasteryNoteRefine）+ `src/server/knowledge/node-page.ts`（T3 再随包迁）
- Modify: schema.ts 三处墓碑注释（artifact.embedded_check_status / artifact_block_ref.ref_kind / question.source='embedded' 语义）

**Steps:**
- [x] 改道前 `grep -rln "@/server/artifacts" --include='*.ts*' | wc -l` 记基线（实测 ≈34 文件）——完成判据 = 改道后仅剩 editing-session/presence 自引用与留守路由（heartbeat/blur、embedded-check attempt、today/ai-changes）
- [x] git mv 文件 + 测试（unit 重命名 `.unit.test.ts`）→ import 全仓改道至基线归零
- [x] error_rate kind 删除 + 调用行删除 + 触发器测试更新（断言 4 kind）
- [x] boss handlers 归位 + handlers.ts 动态 import；`pnpm test:unit` 包内绿
- [x] 随迁 db 测试绿（`pnpm vitest run --config vitest.db.config.ts src/capabilities/notes/`）+ typecheck → commit

### Task 3: knowledge 后端采伐

**Files:**
- Move: `src/server/knowledge/` 全部 16 文件 → `src/capabilities/knowledge/server/`；14 个测试随迁 + fastTestInclude 更新
- Move: knowledge 域 boss handlers（实施时核对 src/server/boss/handlers/ 中主依赖为 knowledge 的：propose / edge-propose / attribution / goal-scope 类）→ `src/capabilities/knowledge/jobs/`
- Modify: `node-page.ts` 的 artifacts import → `@/capabilities/notes/server/*`
- Modify: 域外引用改道（汇总报告 §1.5：practice/ingestion 包的 getEffectiveDomain / resolveSubjectProfileForKnowledgeIds / assertKnowledgeIdsExist / loadTreeSnapshot 等 10+ 处 + AI tools + 旧路由）

**Steps:**
- [x] 改道前 `grep -rln "@/server/knowledge" --include='*.ts*' | wc -l` 记基线（实测 ≈50 文件）——完成判据 = 基线归零
- [x] git mv + import 全仓改道（unit 测试沿 M2 先例重命名 `.unit.test.ts` + fastTestInclude 删旧条目，含 tree.unit/rubric-validator.unit/hub-mesh 等既有显式条目）
- [x] boss handlers 归位；随迁测试绿（unit + db 分区各自跑）
- [x] typecheck + `pnpm audit:profile`（subject-profile 移动不破注册）→ commit

### Task 4: API 上 Hono + proxy 切流

**Files:**
- Create/Move: knowledge 8 条路由 body 进 `src/capabilities/knowledge/api/`（按实际旧壳路径：`/api/knowledge`（树快照 GET）/ `[id]` / `proposals` / `proposals/[id]` / `edges` / `edges/proposals/[id]` / `review` / `review-due-summary`），kernel v2 签名 `(req, params)`
- Create/Move: notes 域 **9 条**进 `src/capabilities/notes/api/`：notes/[id] GET + artifacts/[id]/{body-blocks PATCH, sections/[sectionId], backlinks, correct, ai-changes, ai-changes/[eventId]/undo} + **artifacts/search（cross-link picker，YUK-95——critic 实测补漏）** + hubs/[id]/dismiss-link。**总数 17**
- Modify: 两包 manifest 路由声明（load thunk）；旧 Next 壳改 shim（M1 模式，T8 拆）
- Modify: `web/vite.config.ts` proxy：`/api/knowledge`、`/api/notes`、`/api/artifacts`、`/api/hubs` → 8787（`/api/editing-session`、`/api/embedded-check`、`/api/today` 留旧栈）
- Test: 路由测试随迁；rw:api 冒烟

**Steps:**
- [x] 三方对照表（旧壳 ↔ 包内 body ↔ manifest）→ 逐条迁移
- [x] rw:api 冒烟：GET /api/knowledge 带 token 200、GET /api/knowledge/:id 透传、PATCH body-blocks 乐观锁 409 路径
- [x] typecheck + 路由测试绿 → commit

### Task 5: 后端端到端验证（真栈）

**Steps:**
- [x] RW_WORKER=1 起 rw:api；种最小知识树 + 一篇带 knowledge label 的笔记
- [x] 链路验证：GET 树快照 → GET 节点页（聚合含笔记 section + backlinks）→ PATCH body-blocks 编辑（version bump + block-ref 同步）→ M2 流内作答一道挂该知识点的题 → 断言 `note_refine` job 入队且 mastery_change kind 消费成功（mutator 小改直接落 / 超阈值走 proposal）→ undo 事件还原
- [x] 验证数据全家清零（vzt6 配方）

### Task 6: 图谱页 + 节点页 SPA 重建（UI · pre-flight 后动工）

**Files:**
- Move: `src/ui/knowledge-graph/{layout.ts,layout.test.ts,mastery-tone.ts}` → `src/capabilities/knowledge/ui/`（测试随迁）
- Create: `src/capabilities/knowledge/ui/`（图谱页 + 节点页组件族 + css，对 `screen-knowledge.jsx` / `screen-knowledge-detail.jsx`）
- Modify: `web/src/router.tsx`（/knowledge、/knowledge/$id 登记）

**Steps:**
- [x] **design-doc pre-flight**：逐字引用两张稿关键段 + 组件类型声明 + touch 文件清单 → **等用户批准**
- [x] 实现（布局逻辑移植 + 渲染层重写；图谱用丰富数据测——贫数据掩盖布局问题，先判整体形态再核细节）
- [x] 视觉环：真数据 playwright 对照设计稿 → 修 → commit

### Task 7: 笔记阅读器 + 块编辑器 SPA 重建（UI · pre-flight 后动工）

**Files:**
- Create: `src/capabilities/notes/ui/`（三栏阅读器 + 块编辑器 + 斜杠菜单，对 `note-editor.jsx` / `screen-note-reader.jsx` + `note-reader.css`）
- Modify: `web/src/router.tsx`（/notes/$id 登记）

**Steps:**
- [x] **design-doc pre-flight** → **等用户批准**（2026-06-11 已批，含一条用户增量：
  **quiz 块删除后允许 note 引用 question**——纯引用块（题面预览 + kind 徽章），
  无作答判分交互；@ 选择器扩展可选题；M3 不做跳转（题库面 M5 收口）；
  存量 check 块渲染灰色墓碑占位）
- [x] 实现（保存走 PATCH body-blocks 乐观锁；AI 痕迹/correction 状态渲染；**不渲染 embedded check 块**——D6；question 引用块按用户增量落地）
- [x] 视觉环：含「编辑→保存→version bump→AI refine 痕迹」的真数据回路 → commit

### Task 8: 退役 + 全 gate + PR

**Steps:**
- [x] 拆除（单 commit 可整体 revert）：`app/(app)/knowledge/`（1313+645 行）+ `app/(app)/notes/`（790 行）+ 已迁 API 旧壳 + 孤儿组件（KnowledgeGraph.tsx 1365 行、block-tree/ 与 NoteRenderer 等按反向引用核实后定）
- [x] postman spec 删已迁路径 + `pnpm gen:postman`
- [x] 零残留 grep（含 tests/ 与注释；历史叙述合法、现状指针 repoint）
- [x] 全 gate：typecheck / lint / `pnpm audit:schema` / `pnpm audit:partition`（fastTestInclude 旧条目清干净的判据）/ `pnpm audit:profile` / `pnpm test` / next build / vite build
- [ ] PR（含 `Closes YUK-317`）→ **停等用户 merge**

## Self-Review

- spec M3 验收行「知识面可浏览可修订」↔ T4/T6（树+节点页 API/UI）+「笔记链路通」↔ T2/T5/T7（采伐+触发器+编辑器）；「Living Note 新触发器」↔ T2（error_rate 删 + mastery_change 确认）+ T5（端到端断言）。
- D6 边界双向核对：删的只有 error_rate 信号线 + 新 UI 不渲染；route/handler/表全墓碑——「删除项误伤」风险（spec §5）由 teaching_check 红线 + 墓碑注释覆盖。
- 占位符：无 TBD；T3 boss handler 清单标注「实施时按主依赖核对」是显式勘察步骤非占位。
- 风险：采伐爆炸面（getEffectiveDomain 等 10+ 处引用）由「保持导出名不变、只改 import 路径」+ typecheck 兜底；幻觉报告风险已由重勘 + 实测裁决消解（plan 不引用作废报告的任何断言）。
