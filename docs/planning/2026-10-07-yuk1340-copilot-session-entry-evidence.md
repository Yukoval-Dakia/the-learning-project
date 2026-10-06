# YUK-1340 Copilot 会话入口 — 实施与验证证据

日期：2026-10-07。工作树 `tlp-yuk-1340-session-entry`（分支 `fix/yuk-1340-copilot-session-entry`）。方案见 [preflight](2026-10-07-yuk1340-copilot-session-entry-preflight.md)。浏览器验收为 **fixture-backed**（本地补丁 UI + 合成 API 夹具），不证明生产已修复；无付费消息发送、无生产数据写入。

## 变更文件

- `src/capabilities/copilot/ui/CopilotDock.tsx`（修改）：bootstrap 选择逻辑、`createConversation` 异步竞态防护、footer 只读提示 + 「开始新对话」。
- `src/capabilities/copilot/ui/CopilotDock.session-entry.unit.test.tsx`（新建）：4 条组件行为测试。
- 本文件与 preflight、`evidence/yuk1340-entry-*.png`（4 张流程截图）。

## RED（修复前）→ GREEN（修复后）

命令（工作树根）：
`pnpm vitest run --config vitest.unit.config.ts src/capabilities/copilot/ui/CopilotDock.session-entry.unit.test.tsx`

| 测试（真实组件渲染 + 多状态多日期会话夹具） | RED（修复前实际输出） | GREEN（修复后） |
| --- | --- | --- |
| 落位最近的可继续会话，不被更新的 ended 抢走 | `AssertionError: expected true to be false`（composer disabled） | ✓ |
| 仅有 ended/abandoned 时自动给出可用的新对话 | `AssertionError: expected [] to have a length of 1 but got +0`（无 POST，卡死只读） | ✓ |
| 显式查看历史只读 + 可见「开始新对话」+ 无隐藏变更 | `TestingLibraryElementError: Unable to find an element by: [data-testid="copilot-readonly-notice"]` | ✓ |
| 异步 bootstrap 建会话不抢用户选择 | `AssertionError: expected [] to have a length of 1 but got +0`（bootstrap 从不建会话） | ✓ |

RED 全量输出：`/tmp/yuk1340-red.txt`（会话内临时文件；表中为逐条失败断言原样）。

## 本机检查（scoped，未跑完整 pnpm test）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| copilot/ui 全量 unit | `pnpm vitest run --config vitest.unit.config.ts src/capabilities/copilot/ui` | 19 files / 117 tests 全过 |
| typecheck | `pnpm typecheck` | exit 0 |
| lint | `pnpm lint` | exit 0（0 error；297 warnings 为存量，ratchet 管辖） |
| build（pre-PR gate） | `pnpm build` | exit 0（web + server + worker + migrate） |

## 浏览器验收（fixture-backed）

- 服务：`pnpm exec vite preview --config web/vite.config.ts --port 8790 --strictPort`（工作树自有端口 8790；`localhost:8790`，node PID 69139；验收后已停止）。不使用生产 8787；未触碰生产 API/DB。
- 被测 UI：本工作树 `pnpm build` 产出的 `web/dist`（含本次 CopilotDock 补丁）。
- 合成夹具（Playwright `page.route` 全量拦截 `/api/**`）：`GET /api/copilot/sessions` 返回多状态会话（ended 最新 + idle + active；第二场景仅 ended+abandoned），`POST /api/copilot/sessions` 返回新 active 会话；`/api/auth/check`、`/api/workbench/summary`、`/api/copilot/turns`、`/api/today/copilot-summary`、`/api/copilot/nudges` 按合同返回空载荷。全程无模型调用、无消息发送。
- 浏览器通道：本会话 T3 `preview_status`/`preview_open` 不存在，`browser.preview` 报 `browser.disconnected`（与父会话结论一致），故用 Playwright 浏览器执行。

可观察状态（工具返回值原样）：

| 步骤 | 结果 |
| --- | --- |
| 1 打开抽屉（夹具：ended 最新 + idle + active） | `composerDisabled: false`（落位 idle 可继续会话），`createdPosts: 0` |
| 2 对话记录面板 | idle 行 `aria-current: "true"`（最新 live 胜过更新的 ended） |
| 3 显式点开最新 ended 会话 | `composerDisabled: true`；提示「这段对话已结束，仅供回看。」+「开始新对话」可见；`createdPosts: 0`（无隐藏自动建会话/历史变更） |
| 4 点击「开始新对话」 | `composerDisabled: false`，`createdPosts: 1`（显式动作才创建） |
| 5 仅 ended/abandoned 场景打开抽屉 | `composerDisabled: false`，本场景自动建 1 个新对话（bootstrap 走 createConversation） |

截图（docs/planning/evidence/）：

- `yuk1340-entry-resumable.png` — 落位可继续会话，composer 可用。
- `yuk1340-entry-history-readonly.png` — 历史只读 + 可见「开始新对话」（禁用控件旁）。
- `yuk1340-entry-start-new.png` — 显式开始新对话后可继续提问。
- `yuk1340-entry-only-ended-auto-start.png` — 仅 ended/abandoned 时自动落到可用新对话。

竞态防护（等待期间用户改选不被 async bootstrap 抢走）由组件测试第 4 条覆盖（deferred create）；浏览器流程未重复该竞态注入。

## 边界与未做

- 未改 backend / schema / route / provider / 默认值 / admission；未动 `CopilotSessionPanel`（历史面板保持只读展示）。
- 未跑完整 `pnpm test`（归 exact-head GitHub CI）；实施提交 e11405d46 已交回；PR 与发布由 parent 负责。
- 不宣称生产已修复：生产缺陷记录在 `2026-10-07-local-release-result.md`，待本分支经 PR + CI Gate 合并部署后才能在生产复验。


## 父线程独立验收

在提交 `e11405d466db8d5658389e9acdbbf555deb49767` 的实际构建产物上复验：19 个 Copilot UI 文件、117 项测试，以及 typecheck、lint、build 全部 exit 0。原 RED 日志包含四项失败，修复后四项通过。

T3 `preview_status` 与 `preview_open` 都明确返回没有可用的 automation host，因此使用独立 Playwright 浏览器访问隔离端口 `127.0.0.1:8791`。复用仓库 `tests/usability/api-fixtures.ts` 的合成工作台合同，并局部覆盖 Copilot 会话/turns API；全部 API 请求都被夹具接住，无生产访问或模型调用。

父线程从用户可见的“打开 Copilot”按钮进入，验证了：

- ended 更新但仍有 idle 时默认进入 idle；显式点选 ended 后只读，点击“开始新对话”才发起一次创建。
- 仅 ended/abandoned 时自动创建一次新会话并可输入。
- 首次创建返回 503 时显示失败、保留可点击的新建入口；显式重试第二次成功，无自动重试风暴。
- 创建响应延迟时改选历史，响应回来后仍保持该历史的选择与只读状态。

每个场景只产生预期的 `/api/copilot/sessions` 合成 POST，没有其他 mutation 或未处理请求。证据位于父工作树 `.remember/evidence/2026-10-07-yuk1340-parent-validation/`，包含脚本、状态 JSON、截图和检查日志。此验证仍是补丁 SPA 加合成服务合同；真实生产会话验收须在发布后完成。

390×844 窄屏下等待抽屉宽度过渡结束，再确认抽屉 x=0、页面无横向溢出、只读提示和“开始新对话”可见；截图 `parent-history-mobile.png` 经父线程目视核对。父线程自有 8791 预览服务在验收后已停止。初次使用被 shell 隐藏的内部 trigger 导致脚本超时，改为用户可见入口后通过，不将脚本定位错误记为产品故障。

## 独立初审与集成

OpenCode Go MiMo 2.6 Pro 独立初审固定读取 `e11405d466db8d5658389e9acdbbf555deb49767` 相对 `bccb6df1121912a5bd6f36ce59f4d31f3ef41b1e` 的真实 diff、组件与服务端会话合同，结论无 P0/P1。审查为只读源码核对，没有独立重跑测试或生产操作；父线程验收见上。

两组成组 P2 已去重记录到 YUK-1343：补齐失败重试、显式创建时改选及非空消息隔离的组件回归；评估自动创建失败后关闭/重开抽屉的 latch 语义。当前失败后有可见手动重试入口，浏览器已验证该入口，因此延期，不称已修复。

PR1582 已合并 main `8a53792855580fc1eec2c344b70f4122e5310bb7`。本分支正常合入该 main，合并提交 `0cb2659f3c7e140e5797c4ad47669363d403c5cf`；依赖安装使用 frozen lockfile，实际更新 sharp0.35.5 与 MCP SDK1.32.1。合并后的检查另存父工作树 `.remember/evidence/2026-10-07-yuk1340-combined-validation/`，不把旧检查结果冒称为新依赖树的验证。

合并后父线程重新运行 Copilot UI 的 19 文件 / 117 项测试、typecheck、lint、build，全部 exit 0。检查运行于上述合并提交；后续提交仅更新 PLAN 与本证据文档。未运行完整本机 pnpm test、未新增付费调用、未修改生产。

---

## P1 修复：自动续接遵循 24h 复用窗口（GitHub discussion 4200151363）

### 旧验收与新修复的区分

以上「RED→GREEN」「本机检查」「浏览器验收」均对应 e11405d46 的 4 项组件测试与 117 项全量 UI 测试——即**初版会话入口修复**（bootstrap 落位 active/idle + 历史只读 + 新建入口 + 竞态防护）。本节记录的是**初审后新增 P1 缺口的第二轮修复**：bootstrap 自动续接遗漏了服务端 `COPILOT_REUSE_WINDOW_MS`（24h）年龄检查。

### 缺陷根因

`CopilotDock.tsx` bootstrap `resumable` find 仅检查 `status === 'active' || status === 'idle'`，遗漏 `updated_at >= now - 24h`。服务端 `findReusableCopilotConversation`（`src/server/session/conversation.ts:138-160`）同时检查 status 与 `gte(updated_at, cutoff)`（cutoff = now − 24h，`:112` `COPILOT_REUSE_WINDOW_MS`）。当列表含最新 ended + 过期 active/idle（>24h）时，UI 自动选旧 row 并把新消息附到过时历史；服务端本来会新建。

### 变更文件

| 文件 | 动作 |
| --- | --- |
| `src/capabilities/copilot/session-reuse.ts` | 新建：`COPILOT_REUSE_WINDOW_MS` + `isWithinCopilotReuseWindow()` 共享叶模块（UI 不能 import `@/server/`） |
| `src/server/session/conversation.ts` | 修改：import 共享常量替换本地定义，re-export 保持兼容 |
| `src/capabilities/copilot/ui/CopilotDock.tsx` | 修改：bootstrap `resumable` find 增加 `isWithinCopilotReuseWindow(session.updated_at)` 年龄检查 |
| `src/capabilities/copilot/ui/CopilotDock.session-entry.unit.test.tsx` | 修改：新增 7 条组件测试（冻结时钟 `2026-10-07T20:00:00Z`） |
| `src/capabilities/copilot/ui/CopilotDock.durable-retry.unit.test.tsx` | 修改：夹具 `updated_at` 改为相对时间（P1 年龄检查使旧硬编码日期不可续接） |
| `src/capabilities/copilot/ui/CopilotDock.tool-use.unit.test.tsx` | 修改：同上 |

### RED（修复前实际输出）→ GREEN（修复后）

命令：`pnpm vitest run --config vitest.unit.config.ts src/capabilities/copilot/ui/CopilotDock.session-entry.unit.test.tsx`

| 测试（真实组件渲染 + 冻结时钟 2026-10-07T20:00:00Z） | RED（修复前） | GREEN（修复后） |
| --- | --- | --- |
| P1: 超过24h的 idle 不能自动续接（应新建） | `expected [] to have a length of 1 but got +0`（bootstrap 选了过期 idle，无 POST） | ✓ |
| P1: 超过24h的 active 不能自动续接（应新建） | 同上 | ✓ |
| 窗口内 active/idle 仍自动续接，不新建 | ✓（无回归） | ✓ |
| 恰好24h边界的 idle 仍在复用窗口内（gte 语义） | ✓（无回归） | ✓ |
| 刚好超过24h边界的 idle 不可自动续接（应新建） | `expected [] to have a length of 1 but got +0` | ✓ |
| updated_at 非法时保守处理为不可续接（应新建） | 同上 | ✓ |
| 显式选择超过24h的 idle 仍可继续 | `expected [] to have a length of 1 but got +0`（首步 waitFor 未建会话） | ✓ |

RED 全量输出：`/tmp/yuk1340-p1-red.txt`（本轮会话临时文件；表中为逐条失败断言原样）。

### 24h 边界与显式选择语义

- **边界（与服务端 `gte` 一致）**：`updated_at === now - 24h` → 在窗口内（可续接）；`updated_at < now - 24h` → 窗口外（新建）。恰好 24h 仍可续接。
- **非法时间**：`updated_at` 为 NaN/invalid → 保守判定为不可续接（不自动选）。
- **显式选择**：用户点选历史会话（含 >24h 的 active/idle）不受年龄限制——与服务端显式 `sessionId` 路径（`conversation.ts:322-355`）一致，仅检查 status。显式选择旧行为不变。
- **自动 vs 显式**：仅 bootstrap 自动续接遵循 status + 24h；用户显式选择只看 status。

### 本机检查（scoped，未跑完整 pnpm test）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| copilot/ui 全量 unit | `pnpm vitest run --config vitest.unit.config.ts src/capabilities/copilot/ui` | 19 files / 124 tests 全过（原 117 + 新增 7） |
| typecheck | `pnpm typecheck` | exit 0 |
| lint | `pnpm lint` | exit 0（0 error；297 warnings 存量） |
| build | `pnpm build` | exit 0 |

日志：`/tmp/yuk1340-p1-ui-tests.log`、`/tmp/yuk1340-p1-typecheck.log`、`/tmp/yuk1340-p1-lint.log`、`/tmp/yuk1340-p1-build.log`。

### 共享常量跨层变动说明

`COPILOT_REUSE_WINDOW_MS` 从 `conversation.ts` 模块私有提取到 `src/capabilities/copilot/session-reuse.ts`（UI 不能 import `@/server/`，server 已有 import capability public 的先例）。`conversation.ts` re-export 保持既有导入兼容。不改 API/DB 行为；服务端 predicate 语义不变。`conversation.test.ts`（DB 测试）未在本机运行，归 exact-head CI。

### 边界与未做

- 未改服务端 24h 窗口政策、显式 sessionId 语义、API/DB/schema。
- 未跑完整 `pnpm test`；`conversation.test.ts` / `turns.db.test.ts` 等 DB 测试归 exact-head CI。
- 本修复待父线程独立核验后 push，再启动一次 P0/P1 验证审（当前 PR 初审已用，无第三轮）。
- 不宣称生产已修复：待 PR + CI Gate 合并部署后复验。
