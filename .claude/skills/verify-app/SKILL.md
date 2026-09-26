---
name: verify-app
description: 本项目的控制面/验证 harness：启动、健康检查、驱动真实应用（web UI / Hono API / pg-boss worker）、抓运行证据、清理。任何"验证在真实应用上的行为"（bug 复现、feature 验收、UI/后端 smoke、overnight loop 的 check 步）必须先走这里，而不是猜或看编译。Use when需要 repro 真实 bug、验收新行为、跑 UI/API/worker smoke、或需要可重放的运行时证据。
---

# Verify App — 本项目验证 harness

控制面分三层：**Web SPA**（playwright 真驱动）、**Hono API**（curl 直调）、**pg-boss worker**（日志/DB 状态）。证据 = 动作 + 结果状态 + 副作用，三者都要。

## Launch

```bash
# 依赖就绪后一条命令起全套（api :8787 + web :5173 + worker）
pnpm dev:local          # = tsx scripts/dev-local.ts，spawn 三进程
# Postgres（本地 5433）未起时先：
docker compose -f docker-compose.yml -f docker-compose.local.yml up postgres -d
pnpm db:migrate:local
```

- `pnpm dev` 是 `dev:local` 别名。三进程缺一不可：`LISTEN` loop 不消费 boss job，独立 `worker:dev` 必须有。
- readiness 信号：api 打 `GET http://localhost:8787/api/health` 返 200；web `http://localhost:5173` 可加载。
- **不要用 stale `.env.local` 里的 remote DATABASE_URL** 做 UI smoke。

## Doctor（只读，不改状态）

按顺序做，任一失败先修环境再谈产品 bug：

1. `docker compose ps` — postgres 容器活着、`127.0.0.1:5433` 监听。
2. `curl -sf http://localhost:8787/api/health` — 200 = api + token 通道通。
3. `pnpm worker:dev` 对应的独立 worker 进程在跑（`pgrep -f "scripts/worker.ts"`）；缺了 boss job 会堆积。
4. `.env.local` 里 `INTERNAL_TOKEN` 已设（api 除 `/api/health` 外全拦 `x-internal-token`，未设服务端 fail-closed 拒一切）。
5. `git status` 干净或已知脏——别在不明基线上测。

## Drive

- **UI**：用 playwright 工具真驱动 `http://localhost:5173`（`browser_navigate` → 点真 selector 的真路径）。要选应用真实的用户路径，不挑捷径。视觉证据截图存 artifact。
- **API**：`curl -H "x-internal-token: $INTERNAL_TOKEN" http://localhost:8787/api/<route>`。200 本身就是 token 校验通过的证据。路由清单以 `postman/api-endpoints.json` 为准，改过的先 `pnpm gen:postman`。
- **Worker/job**：观察 `worker:dev` 输出；DB 真相用 `psql $DATABASE_URL` 查对应表/job 状态（pg-boss queue），不推断。
- **Migration**：`pnpm test:migration`（migration smoke 独立 loop）。

## Evidence 契约

1. 每条 claim 带可重跑证据：命令 + 真实输出、`file:line`、SHA、或 artifact 路径（截图/trace/JSON dump 存 `docs/planning/evidence/` 或 `.remember/`，大证据入仓小证据本地）。
2. UI 证据必须包含**动作 + 动作后的状态**（不只终态截图）；副作用（DB 行、job 状态、文件）与可见状态一起验。
3. 判定只有三档：`VERIFIED` / `NOT VERIFIED` / `INCONCLUSIVE`。INCONCLUSIVE 不是过，写进报告并标原因。
4. "编译过/启动没报错/文件时间戳新"不是证据。验证失败时先怀疑观测方法，再怀疑系统。

## Cleanup

- 只停本次启动的进程（`dev:local` 的三进程组）；postgres 容器只在你本次起的才停。
- 清掉本次产生的运行残留（测试行、临时 job），但**证据文件不删**。
- 不在验证过程中改产品代码——发现缺陷记录并报告，不在 verify lane 顺手修。

## Feature map（驱动面速查）

| 面 | 入口 | 主要命令/工具 |
|---|---|---|
| Web SPA | `:5173` | playwright（真用户路径） |
| API | `:8787` | curl + `x-internal-token`，route 清单 `postman/api-endpoints.json` |
| Worker | `pnpm worker:dev` | 日志 + `psql` 查 boss queue/业务表 |
| DB | `postgres @ :5433` | `psql` / drizzle migrations |
| AI route | 经 API | provider key 只在服务端；验证 AI 行为走 route 或 worker，不在浏览器注入 key |
