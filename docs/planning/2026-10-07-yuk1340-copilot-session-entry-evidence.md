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
