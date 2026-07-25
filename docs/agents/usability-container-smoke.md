# 容器级可用性回归门禁

这组门禁只测试 Docker 构建出的 Vite 生产 bundle，不接受独立 Vite dev server。浏览器里的
API 由确定性 fixture 拦截，因此不会调用付费 LLM，也不会改容器数据库。

## 首次准备

```bash
pnpm test:usability:install
```

该命令只安装 Chromium。Playwright 版本固定在 `package.json`，不要用全局版本替代。

## 运行

先用隔离 compose project 或等价方式构建并启动 `app`，不要指向正在服务用户的生产容器。
确认 `/api/health` 为 2xx 后执行：

```bash
USABILITY_BASE_URL=http://127.0.0.1:18787 pnpm test:usability:container
```

命令会先生成当前 checkout 的 Vite production bundle；preflight 再把本地
`assets/index-<hash>.js` 与容器 `/today` 引用的 hash 逐字对比。若目标是 Vite dev server、
陈旧 build/checkout 或不可达容器，测试会在打开浏览器前失败，并报告 target、route、期望
状态和实际状态。

静态门禁可独立快速运行：

```bash
pnpm test:usability:static
```

它同时执行：

- shipped surface inventory：router、capability manifest、导航、搜索和标题双向对账；
- learner-copy audit：阻止 M4/M5、工程术语、未接线动作和 dead placeholder handler；
- 显式 allowlist：`scripts/audit-learner-copy-allowlist.json`，每条例外必须写明精确片段和原因，
  失效条目会让门禁失败。

ship 前合并运行：

```bash
USABILITY_BASE_URL=http://127.0.0.1:18787 pnpm test:usability
```

## CI 接线（YUK-789）

`.github/workflows/ci-gate.yml` 的 `usability` job 在每个 PR / push 上跑这条门禁：
`pnpm build` 产出 `dist/server.cjs` + `web/dist` → 以 `RW_STATIC_DIR=web/dist API_PORT=18787`
起同一个构建产物 → 轮询 `/api/health` → `USABILITY_BASE_URL=http://127.0.0.1:18787 pnpm
test:usability:container`。docs-only PR 与主 gate 用同一套 merge-base 判定跳过。

CI 里**不起 Postgres**：浏览器侧 `/api/*` 全量被 fixture 拦截，server 只服务静态面 +
`/api/health`（subject hydrate 内部 never-throws，DB 不可达时走代码种子地板）。失败时
`test-results/usability` 作为 artifact 上传。

## 覆盖场景

- `/today`：无 active goal 但已有题目/待复习；真正空库；401 立即回 TokenGate。
- `/practice`：mutation 失败不乐观提交，原位提示并可重试。
- `/today` 390px：移动 drawer 的 dialog/modal、焦点 trap、Escape 和焦点恢复。
- `/questions`：20/25 到 25/25 的服务端分页累加载。
- `/today` 教研简报：四块 landmark + 反内疚文案锁；**点击**「就按这个方向验证」→ 断言
  `POST /api/proposals/:id/decisions` 真被打中、band 就地推进到 `probe_ready`（出现「现在就
  试做这道题」、finding 两个 CTA 消失、aria-live 播报一次）、且 `brief_seen` +
  `primary_action_started` 两条 telemetry 真的发出去了（YUK-789 前只 focus/Tab，接空的按钮也能过）。

失败 trace 和截图只在失败时写到 `test-results/usability/`；截图用于定位，不作为像素差断言。
截图默认落 `test-results/usability/`，本地可用 `USABILITY_SHOT_DIR` 改写。
