# M1：录入竖切 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans。

**Goal:** 一份真实 PDF 走全新栈进题库：web 录入面 → Hono（manifest 挂载）→ ingestion 包管线 → 进程内 pg-boss worker → Postgres/R2。验收后拆除旧 record 页与旧 ingestion/assets Next 路由。

**Architecture:** 总 spec REV 2 §4-M1（D17-D20）。采伐配方沿用 P2a 三联（随迁测试绿 + typecheck + 零残留 grep）；新增三个首例：param 路由（kernel RouteHandler v2）、SSE 挂载、multipart 挂载。

**Linear:** YUK-314。分支 `yuk-314-m1-ingestion`。

**红线：** 勘察 grep 含 tests/ 与注释路径；每 commit typecheck 绿；旧 worker（scripts/worker.ts）在 M1 期间必须保持可用（handlers registry 改 import 新路径）；UI 任务（T6）须用户 pre-flight 批准后动工。

---

### Task 1: 分支 + kernel RouteHandler v2（TDD）

- `git checkout -b yuk-314-m1-ingestion`
- `src/kernel/manifest.ts`：`RouteHandler = (req: Request, params: Record<string, string>) => Promise<Response>`（M0 的无参 handler 兼容——多余实参 JS 层无害；注释记 param 首例到来）
- `server/app.ts`：挂载处传 `c.req.param()`；`server/app.unit.test.ts` 增 param 路由用例（fake `/api/fake/[id]` 断言 params.id 透传）
- 验证 M0 既有测试不回归 → commit

### Task 2: ingestion server 簇采伐

`src/server/ingestion/`（含 `docx/` 子目录整体）→ `src/capabilities/ingestion/server/`。配方同 P2a：
- 测试改名按 DB 依赖归类（执行时逐文件 grep tests/helpers/db；已知 block-assembly.unit.test.ts 已是 unit 命名）
- helpers 相对深度修正；包内上跳引用 → `@/` 别名；`@/server/ingestion/X` 全仓（src app scripts tests）sed → `@/capabilities/ingestion/server/X`
- 外部进口方（勘察清单）：boss handlers tencent_ocr_extract/auto_enroll、proposals/actions + image-candidate-accept、ai/tools/question-edit-tools、api routes、question-blocks figures route
- 包骨架：manifest.ts（events/api 声明，路由 load 下一任务接）+ CONTEXT.md + 组合根登记（composition 测试先红后绿）

### Task 3: boss handlers 采伐（旧 worker 兼容）

`src/server/boss/handlers/{tencent_ocr_extract,auto_enroll}.ts`（+tests）→ `src/capabilities/ingestion/jobs/`。
旧 `src/server/boss/handlers.ts` registry 改 import 新路径——**旧 worker 继续可用**（kernel jobs 契约真身 M4 再立）。

### Task 4: API 簇迁包 + Hono 挂载

13 条 route body → `src/capabilities/ingestion/api/`，manifest routes 加 `load` thunk：
- param 首例：`/api/ingestion/[id]/*`×7 —— 包 handler 签名改 `(req, params)`（从 Next 的 `{params: Promise<>}` 改写，行为不变）
- SSE 首例：`[id]/events`（标准 ReadableStream，直接可挂；注意 EventSource 无法带 header——勘察旧实现的 token 方案，如 query token 则 Hono 中间件加对应豁免逻辑，**保持与旧行为一致**）
- multipart 首例：`assets` POST（req.formData() Web 标准）
- 旧 Next route 文件此阶段**保留**（import 已指包内，双栈并存到 T7 拆除）
- 每条迁移：测试随迁 → 目标测试绿 → typecheck

### Task 5: 进程内 worker（单进程拓扑）

`server/index.ts`：`RW_WORKER=1`（dev 脚本默认开）时启动 pg-boss worker——复用旧 handlers registry 整表挂载（含已采伐的 ingestion jobs），关闭时优雅 shutdown。验收:新栈单进程下上传→OCR job 被消费。

### Task 6: web 录入面（⚠️ 须 pre-flight 批准后动工）

- pre-flight：引用总 spec §1.3-④（录入=任何题目的通道，错题是标记非通道）+ D11；组件类型 = SPA 路由页 + feature 组件；文件 = `src/capabilities/ingestion/ui/`（从 app/(app)/record/page.tsx 采伐改造：去学习记录 mode、去 next 依赖、navigate prop）+ `web/src/router.tsx` 登记 `/record`
- SSE 进度、上传、blocks review、import 全链交互保持旧行为
- playwright 截图视觉环（对照旧页同构）

### Task 7: 端到端验收 + 拆除 + PR

- 真实 PDF（tests/fixtures 或用户材料）走新栈全链：upload→pdf render→OCR→blocks→review→import→题库可查
- **拆除**：`app/(app)/record/` + `app/api/ingestion/**` + `app/api/assets/**`（单 commit 可整体 revert）；today 页等残留链接 404 属预期
- 全 gate（typecheck/lint/audit×2/test/Next build/vite build）+ 零残留 grep + PR（停等 merge）

## Self-Review

- spec M1 验收三条 ↔ T7；param/SSE/multipart 首例 ↔ T1/T4；单进程 ↔ T5；handoff 已另行发出。
- 占位符：无 TBD；SSE token 方案是显式勘察步骤（带「保持旧行为」决策规则）。
- 风险：import route 529 行最厚——迁移时整体平移不拆分（拆分非 M1 目标）。
