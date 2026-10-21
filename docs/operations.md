# 运维

当前形态是 Hono API + Vite SPA（`web/`）+ 独立 pg-boss worker 的 self-hosted 单用户应用。本文只写进程、发布顺序、备份恢复和访问约束；环境变量见 [configuration.md](./configuration.md)（与 `.env.example`）；架构以当前代码与 ADR 为准（`docs/architecture.md` 部分过时）；恢复契约细节见 `docs/sub5-restore-cli.md`。

## 进程与 compose 服务

`docker-compose.yml` 定义六个服务，共用 `internal` bridge 网络：

| 服务 | 镜像 / target | 入口 | 角色 |
| --- | --- | --- | --- |
| `migrate` | `the-learning-project-app` / `runner` | `node dist/migrate.cjs` | 一次性应用 `drizzle/` 迁移，等 `postgres` healthy，成功后退出 |
| `app` | 同上 / `runner` | `node dist/server.cjs`（Dockerfile `CMD`） | Hono API + TanStack Start 前门，容器内 `:8787` |
| `worker` | `the-learning-project-worker` / `worker` | `node dist/worker.cjs` | 独立 pg-boss 进程：队列 handler + DBOS durable；夜间链主要由 DAG orchestrator（`dependsOn`）触发，少数 job 仍保留 cron |
| `mem0-init` | `the-learning-project-app` / `runner` | `chown -R node:node /var/lib/mem0` | 一次性修 `mem0data` 卷属主 |
| `postgres` | `pgvector/pgvector:0.8.2-pg16-bookworm` | — | 业务库，卷 `pgdata` |
| `cloudflared` | `cloudflare/cloudflared:2026.5.2` | `tunnel --no-autoupdate --metrics 0.0.0.0:2000 … run` | 可选公网入口，读 `TUNNEL_TOKEN` |

- `migrate` 幂等，靠 drizzle 的 `__drizzle_migrations` 记录已应用版本；`docker compose up` 每次都会先跑它。
- `app` 用 `RW_STATIC_DIR=/app/web/dist` 提供 SPA 静态文件。健康检查只请求 `/api/health`，任意 HTTP 响应算存活；`/api/health` 是进程活性（永远 200），readiness 由 `/api/ready` 的 200/503 表达。
- `worker` 是唯一执行 `worksheet_render` 的进程，所以单独用 `target: worker`：在 runner 上叠 `playwright-core@1.64.0` 和 `chromium-headless-shell`（`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`），并通过 `WORKSHEET_RENDER_APP_ORIGIN=http://app:8787` 打开 app 容器。它的健康检查读 `/proc/1/cmdline`，确认 PID 1 仍是 `worker.cjs`。
- 运行期只有 `worker` 写 `mem0data` 卷；`mem0-init` 在 worker 启动前修好属主。
- Dockerfile 最后一个 stage 是 `worker`；`app` / `migrate` / `mem0-init` 必须显式钉 `target: runner`，否则会构建到带 Chromium 的 worker 镜像。
- 没有 Redis：editing presence 走 Postgres 表 `editing_presence`。

本地开发的三进程与 compose 的对应关系（`scripts/dev-local.ts` 依次 spawn `pnpm rw:api` / `rw:web` / `worker:dev`）：

| dev 子进程 | 端口 | 对应 compose |
| --- | --- | --- |
| `rw:api`（`RW_WORKER=1 tsx watch server/index.ts`） | :8787 | `app`；同进程 pg-boss 只是兜底，不替代独立 worker |
| `rw:web`（`vite --config web/vite.config.ts`） | :5173 | 无独立服务；生产由 `app` 直接提供 `web/dist` |
| `worker:dev`（`tsx scripts/worker.ts`） | — | `worker` |

`dev:local` 从 `POSTGRES_*` 派生 `DATABASE_URL`（默认 `127.0.0.1:5433`），数据库仍是 compose 的 `postgres`：

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up postgres -d
pnpm db:migrate:local
pnpm dev:local
```

## 发布与启动顺序

```bash
docker compose build      # 或 pnpm compose:build
pnpm compose:up           # 先跑 scripts/cloudflared-preflight.ts，再 docker compose up -d
```

`pnpm compose:up` 在创建容器前检查 `TUNNEL_TOKEN` 非空且 `TUNNEL_PROTOCOL` 是 `auto`、`http2` 或 `quic`；空 token 直接失败，不进入 cloudflared 重启循环。不用 Tunnel 时显式列出服务（见下文 Mac overlay）。

启动顺序由 compose 条件约束：

1. `postgres` healthy；
2. `migrate` 成功退出（`service_completed_successfully`）；
3. `app` 与 `worker` 启动，`worker` 还等 `mem0-init` 成功；
4. `cloudflared` 只声明 `depends_on: app`，不等待健康。

迁移成功后先重启 `worker`，再启动 `app`。手动重跑迁移前先停 writer；迁移准备会取表锁，5 秒内拿不到就失败：

```bash
docker compose stop app worker
docker compose run --rm migrate
```

从旧 Copilot mailbox 版本升级时，`migrate` 会拒绝未排空的 mailbox，排空步骤见 [ADR-0063](adr/0063-retire-copilot-mailbox-execution.md)。正常停止时 `app` 最多排空 30 秒 HTTP + 30 秒 pg-boss + 5 秒连接池（总期限 65 秒，compose 留 70 秒），`worker` 排空 30 秒（compose 留 40 秒）。

部署前应固定镜像提交、保存当前配置与数据、先做隔离恢复与迁移预演，再停 writer、取最终备份、执行迁移。

## 备份与恢复

三层备份互不替代：

- **应用归档 API**：`GET /api/_/export` / `POST /api/_/import?confirm=wipe-and-reload`，只含 `src/server/export/archive.ts` 登记的表，可选内联 R2 对象；需要 Hono 在运行。
- **Postgres custom dump**：完整库与 schema，灾难恢复用；不含 R2 对象字节。
- **R2 对象备份**：单独做；归档 API 的 R2 sidecar 只覆盖被引用的 key。

### 日级 dump（Mac 本机）

`scripts/mac-daily-dump.sh` 由 `scripts/launchd/studio.yukoval.loom-daily-dump.plist` 每日 07:15 触发，向 runtime 目录写 `loom-daily-YYYYMMDD.dump`（custom format，供 `pg_restore`），保留最近 14 份，更老的只留每月 1 号。

- 脚本与 launchd 日志必须装在内置盘 `~/Library/Application Support/loom-daily-dump/`：launchd 子进程对 `/Volumes/*` 的任何 I/O 都会被 TCC 拒绝（表现为 `spawn failed` / `EX_CONFIG 78`）。对 runtime 目录的读写全部经 `docker run -v` 在容器内完成。
- 成功写 `.loom-daily-dump-last-success`（epoch 戳）；失败写 `.loom-daily-dump-FAILED-YYYYMMDD` 并 `exit 1`，容器/daemon 不可达时改写到安装目录。`--check` 在戳龄超过 48 小时或当天失败标记存在时 `exit 1`；标记按日命名，更早日期的标记要手动 `ls` runtime 目录和安装目录。
- 日志：runtime 目录的 `loom-daily-dump.log`，安装目录的 `launchd.log`。
- 可覆盖 `LOOM_RUNTIME_DIR`、`LOOM_PG_CONTAINER`、`LOOM_DB_USER`、`LOOM_DB_NAME`、`LOOM_KEEP_DAILY`、`LOOM_MIN_BYTES`；`LOOM_MIN_BYTES` 默认拒收小于 100KB 的 dump。

```bash
mkdir -p ~/Library/Application\ Support/loom-daily-dump
cp scripts/mac-daily-dump.sh ~/Library/Application\ Support/loom-daily-dump/
chmod +x ~/Library/Application\ Support/loom-daily-dump/mac-daily-dump.sh
cp scripts/launchd/studio.yukoval.loom-daily-dump.plist ~/Library/LaunchAgents/
launchctl bootout gui/$(id -u)/studio.yukoval.loom-daily-dump  # 若已装载
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/studio.yukoval.loom-daily-dump.plist
```

### 手动 dump / restore

```bash
pnpm db:dump                                   # 走 compose postgres，写 /tmp/loom-<时间戳>.sql
pnpm db:restore < /tmp/loom-20260101-000000.sql
```

### 完整 Postgres 恢复

外部 maintenance owner 必须先建立并持续持有 writer / 客户端 / 序列写入的隔离边界；`scripts/cutover-final-backup.sh` 只做 capture，不停也不重启 writer。`--out` 是父目录：脚本在它下面新建 `capture-*` 目录，并往 stdout 打印 `{"directory", "source_manifest", "manifest"}`，后续命令统一用 `CAPTURE_DIR`：

```bash
CAPTURE_DIR=$(bash scripts/cutover-final-backup.sh --target=<pg-url> \
  --quiescence-evidence=<maintenance.json> --out=<capture-root> --strict |
  jq -er .directory)
bash scripts/restore-drill.sh --dump="$CAPTURE_DIR/database.dump" \
  --source-manifest="$CAPTURE_DIR/source-manifest.json" \
  --out="$CAPTURE_DIR/restore-evidence.json"
pnpm exec tsx scripts/cutover-backup.ts --capture-dir="$CAPTURE_DIR/migration" \
  --dump="$CAPTURE_DIR/database.dump" --dlq="$CAPTURE_DIR/dlq-tombstones.json" \
  --source-manifest="$CAPTURE_DIR/source-manifest.json" \
  --restore-evidence="$CAPTURE_DIR/restore-evidence.json" \
  --out="$CAPTURE_DIR" --strict --require-restore-parity
```

`--strict` 只检查 capture 工件是否存在；`--require-restore-parity` 才是恢复门，要求当前成功的 version-2 receipt 并重算 artifact 哈希与对比。`scripts/restore-drill.sh` 默认在 `--network=none` 的 scratch 容器里比较，不接触生产库。

用 custom dump 覆盖现有库（完整说明见 [sub5-restore-cli.md](sub5-restore-cli.md#full-postgres-disaster-recovery)）。先挡住 ingress / dispatch，并记录最后一次 provider 流量的时间；任何边界不明就保持关闭，`app` 与 `worker` 用同一个 `AI_PROVIDER_SESSION_ADMISSION_MODE` 一起启动：

```bash
DUMP="$CAPTURE_DIR/database.dump"
docker compose stop app worker
docker compose exec -T postgres sh -c '
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --single-transaction --exit-on-error
' < "$DUMP"
docker compose run --rm migrate
docker compose exec -T postgres sh -c '
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "TRUNCATE TABLE provider_session_admission"
'
# 等待检查点：距最后 provider 流量 60 秒、捕获到的 restore_quarantine_until 已过，以及（除非有
# 应用级正常排空证据）停止时刻 + 45 秒 SDK 启动预算 + 最大执行超时 + 30 秒 abort grace。
# 任一上界不明就保持 fail-closed，不要执行下面这条启动命令。
docker compose up -d app worker
```

`POSTGRES_USER` / `POSTGRES_DB` 由 `docker-compose.yml` 注入 postgres 容器，命令交给容器内 `sh` 展开，宿主 `.env` 里的值没 export 也不会连错库。

### 逻辑归档 import 的硬门

import 需要 Hono 运行，所以不是“停掉所有进程”的恢复。步骤是：先挡 ingress、暂停 job dispatch、等 central SDK session 正常结束，再只保留 admin Hono 并以 `AI_PROVIDER_SESSION_ADMISSION_MODE=off` 运行，import 期间不放普通流量。

- `schema_version` 与运行中的 API 不一致时返回 400 `schema_version_mismatch`；表名、列、行形状先校验，失败返回 400 且不写库。
- YUK-1614：带 completion contract 的 `event_subscription_effect` 若没有下游完成回执，import 在破坏性事务前拒绝，返回 400 `downstream_completion_unproven`；逻辑 ZIP 没有 pg-boss 行，无法重放这些工作。缺 contract 的 legacy 行不算未完成。
- 数据库替换在单个事务内，失败整体回滚；内联 R2 对象在提交后写入，失败列在 `failed_keys`，需要重试。

## 网络与访问

- 基础 `docker-compose.yml` 不把 `app` 的 8787 暴露到宿主，`postgres` 也没有宿主端口；唯一外部路径是 `cloudflared`。
- `docker-compose.local.yml` 给宿主开 `postgres` 的 5433（供 `pnpm db:migrate` / 本机测试），并把 `cloudflared` 放进 `production` profile，`docker compose up` 不会要求 `TUNNEL_TOKEN`。
- `docker-compose.mac.yml` 把 `app` 绑到 `127.0.0.1:8787`，`postgres` 绑 `127.0.0.1:5433` 和 `127.0.0.1:5544`（OrbStack 偶发占住 5433 时的备用宿主端口），并通过显式列服务排除 `cloudflared`：

```bash
docker compose -f docker-compose.yml -f docker-compose.mac.yml \
  up -d --build migrate app worker postgres
```

### 容器 DNS

Mac 宿主的 fake-IP 解析会把域名答成 `198.18.0.0/15`，容器继承后会被图片候选的 SSRF 守卫按设计拒绝。`docker-compose.mac.yml` 因此给 `app` 和 `worker` 固定公共递归 DNS `223.5.5.5`、`119.29.29.29`；私有 compose 重建后要核对：

```bash
docker compose -f docker-compose.yml -f docker-compose.mac.yml exec app getent hosts www.jyeoo.com
docker compose -f docker-compose.yml -f docker-compose.mac.yml exec worker getent hosts www.jyeoo.com
```

不要放行 `198.18.0.0/15`，也不要改宿主代理来“修”它。这个探针不覆盖 jyeoo Rust 子进程和 Exa 抓取路径。

### 可选远程入口

- **Cloudflare Tunnel**：创建 tunnel 时把 hostname 指到 `http://app:8787`，token 放进 `TUNNEL_TOKEN`；UDP/7844 被封时用 `TUNNEL_PROTOCOL=http2`。cloudflared 健康检查读 `--metrics 127.0.0.1:2000` 的 `/ready`，只有至少一条 edge 连接注册后才 healthy：

```bash
docker compose ps cloudflared
docker compose logs --tail 50 cloudflared
```

- **Tailscale**：Serve 把私有 HTTPS 转发到本机 loopback；访问设备须在同一 tailnet，Mac 开机且用户会话内的 daemon 在运行。没有开启 Funnel，主机名与令牌属于本机私有配置，不写进仓库。
- **局域网**：私有 Compose 的 `services.app.ports` 同时保留 `127.0.0.1:8787:8787` 和一条具体 LAN 地址绑定，不要用 `0.0.0.0`；具体地址见 owner 本机私有记录。保留应用登录和 `x-internal-token`，只豁免 `/api/health`、`/api/ready`；Postgres 只走 loopback，storage / worker 没有宿主绑定。改绑定要在共享部署 mkdir 锁下只重建 `app`，验证两个地址、API 401、health/ready 200，以及 `worker` / PG / storage 身份未变。同机探针不能代替 iPad 实测；普通 LAN HTTP 目前获批，需要 secure context 的功能另行决定 HTTPS。
