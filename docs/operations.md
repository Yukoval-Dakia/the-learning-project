# 运维

当前形态是 Hono API + Vite SPA（`web/`）+ 独立 pg-boss worker 的 self-hosted 单用户应用。本文只写进程、发布顺序、备份恢复和访问约束；环境变量见 [configuration.md](./configuration.md)（与 `.env.example`）；架构以当前代码与 ADR 为准（`docs/architecture.md` 开头的运行时、capability、执行路径、Start 前门，以及「六、技术栈」已对齐当前代码；「七、八、九」及「五、AI 任务层」的细节尚待更新）；恢复契约细节见 `docs/sub5-restore-cli.md`。

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
- `app` 用 `RW_FRONTDOOR=1` 启用 Start 前门，页面与静态资产来自镜像内的 `dist/start`。健康检查只请求 `/api/health`，任意 HTTP 响应算存活；`/api/health` 是进程活性（永远 200），readiness 由 `/api/ready` 的 200/503 表达。
- `worker` 是唯一执行 `worksheet_render` 的进程，所以单独用 `target: worker`：在 runner 上叠 `playwright-core@1.64.0` 和 `chromium-headless-shell`（`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`），并通过 `WORKSHEET_RENDER_APP_ORIGIN=http://app:8787` 打开 app 容器。它的健康检查读 `/proc/1/cmdline`，确认 PID 1 仍是 `worker.cjs`。
- 运行期只有 `worker` 写 `mem0data` 卷；`mem0-init` 在 worker 启动前修好属主。
- Dockerfile 最后一个 stage 是 `worker`；`app` / `migrate` / `mem0-init` 必须显式钉 `target: runner`，否则会构建到带 Chromium 的 worker 镜像。
- 没有 Redis：editing presence 走 Postgres 表 `editing_presence`。

本地开发的两进程与 compose 的对应关系（`scripts/dev-local.ts` 依次 spawn `pnpm rw:api` / `worker:dev`）：

| dev 子进程 | 端口 | 对应 compose |
| --- | --- | --- |
| `rw:api`（`RW_WORKER=1 tsx watch server/index.ts`，dev-local 设 `RW_FRONTDOOR=dev`） | dev-local 下自动选 8788 起首个空闲端口（`DEV_PORT` 固定）；单独跑时按 `API_PORT`，缺省 8787 会在绑定前退出（8787 是本机 TEST 中继端口，容器内 API 由 Dockerfile 显式设 `API_PORT=8787`，不受影响） | `app`；页面由同进程的 Vite dev server（middleware 模式）提供，HMR 热更新；生产 `app` 仍直接提供 `dist/start`（`RW_FRONTDOOR=1`）；同进程 pg-boss 只是兜底，不替代独立 worker |
| `worker:dev`（`tsx scripts/worker.ts`） | — | `worker` |

dev 数据库与 TEST 隔离：`dev:local` 用独立的 `docker-compose.dev.yml`（项目名 `loom-dev`，服务 `postgres-dev`，profile `dev`，pgvector 同镜像，宿主端口 **5434**，用户 `loom_dev`，命名卷 `loom-dev_loom-dev-pgdata`）。同一个容器内每 worktree 一个库（`loom_dev_<name>_<path hash>`，由 worktree 根路径确定性派生，`DEV_DB_NAME` 可覆盖；旧共享库 `loom_dev` 可能仍在），多个 worktree 并行 dev 互不共享数据。TEST 的 `postgres`（宿主侧 :5433/:5544，2026-11-06 起中继已关闭这两个端口）与生产 compose 文件不含该服务，普通 `docker compose up` 不会启动它。使用方式只有一条：

```bash
pnpm dev:local      # 打开打印的地址（自动选 8788 起首个空闲端口）
```

`dev:local` 依次：`docker compose -f docker-compose.dev.yml --profile dev up -d --wait postgres-dev`（等 healthcheck）→ 本 worktree 库不存在则经 `postgres` 维护库创建 → `pnpm exec tsx scripts/migrate.ts`（生产迁移入口，对本 worktree 库；已有库只应用新迁移，并幂等补 subject-root seed 与 builtin subject/trait reconcile）→ 幂等写入代码当前的 contract epoch（新库只有隐式 legacy epoch，会让所有请求 503）→ `dbos schema` 建 `tlp_dbos` → `seed:dev-questions` 播种 → 启动 API 与 worker，`DATABASE_URL` 固定指向本 worktree 的 dev 库（忽略 `.env` 的 `POSTGRES_*`）。

保护：TEST 目标判定只有一个 owner——`scripts/local-db-env.ts`：解析目标面用 `testDbRefusalReason`（端口按解析后的数字比，`05433`、带空白的 `5433` 都解析为 5433 被拒；或库名是 TEST 的 `loom`），直读 `DATABASE_URL` 的入口用同一文件新增的 `guardDatabaseUrl`（URL 解析后：回环 host + TEST 端口或库名 `loom` 即拒；容器/发版路径 host 为 `postgres` 等非回环名，一律放行）。解析目标面覆盖 `dev:local`、`dev:reset`、`db:migrate:local`、`drizzle.config.local.ts` 等；直读面覆盖 `db:generate`/`db:push`/`db:migrate`（`drizzle.config.ts`）、`worker:dev` 与所有 import `scripts/load-env.ts` 的本机 CLI（`seed:synthetic`、`db:backfill:*`、`db:recompute:bcalib` 等），全部连接前拒绝。本地脚本的目标解析（`resolveLocalDbTarget`）缺省即本 worktree 的 dev 库（`loom_dev` 凭据 @ `LOCAL_POSTGRES_HOST:LOCAL_POSTGRES_PORT`，缺省 `127.0.0.1:5434`）；`POSTGRES_USER`/`POSTGRES_PASSWORD` 属 TEST/生产栈，只在 `DEV_ALLOW_TEST_DB=1` 下生效——该开关是两个面共同的唯一覆盖（沿用旧行为，用 `.env` 的 `POSTGRES_*` 连 `LOCAL_POSTGRES_HOST:LOCAL_POSTGRES_PORT`，跳过启动/迁移 dev 库，启动日志打印醒目警告），且该路径同样没有指向 TEST 端口的默认值。回滚期本地栈（`docker-compose.mac.yml`/`docker-compose.local.yml` 的宿主 5433/5544）从本机脚本访问同样被拒——形态与 TEST 不可区分；要用 `docker compose exec` 进容器操作，或显式 `DEV_ALLOW_TEST_DB=1`。

重置 dev 库：`pnpm dev:reset` 只删本 worktree 的库（`DROP DATABASE … WITH (FORCE)`，下次 `pnpm dev:local` 重建、迁移并播种）。绝不 `down -v`——卷里装着全部 worktree 的库。

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

部署配置里 `app` 与 `worker` 必须带同一个 `BANK_GAP_EVIDENCE_SECRET`：在部署机上用 `openssl rand -hex 32` 生成，至少 32 个字符且不能等于 `INTERNAL_TOKEN`，只写进部署用的 env/compose，不进 git、日志或回执。缺了它，Copilot 的题库语义检索会返回 `snapshot_signing_unavailable`，`file_bank_gap` 会拒绝所有缺口登记。换值会让已签发、尚未被登记消费的检索证据失效。

## 备份与恢复

三层备份互不替代：

- **应用归档 API**：`GET /api/_/export` / `POST /api/_/import?confirm=wipe-and-reload`，只含 `src/capabilities/observability/server/backup/archive.ts` 登记的表，可选内联 R2 对象；需要 Hono 在运行。
- **Postgres custom dump**：完整库与 schema，灾难恢复用；不含对象存储字节。
- **对象存储**：TEST 的对象字节在 NAS 的 `the-learning-project-test-storage-1` 容器 `/data` 下，随下方日级备份出 `storage.tar`；归档 API 的 sidecar 只覆盖被引用的 key。

密钥/令牌（`INTERNAL_TOKEN`、`BANK_GAP_EVIDENCE_SECRET`、provider OAuth/API key、ssh key）刻意不进任何备份——恢复后按部署记录重新配置。

### 日级备份

`scripts/mac-daily-dump.sh` 由 `scripts/launchd/studio.yukoval.loom-daily-dump.plist` 在 Mac 上每日 07:15 触发，经 ssh 在 NAS 的 TEST 容器里依次取三段（NAS sshd 禁 TCP 转发，走 exec channel）：

1. `loom-daily-YYYYMMDD.dump`：postgres 容器 `pg_dump -Fc`（custom format，供 `pg_restore`），写 runtime 目录顶层，落盘 `chmod go-rwx`（owner-only）。
2. `daily-private/YYYYMMDD/history.db`：worker 容器 `/var/lib/mem0/history.db` 的一致性快照——worker 可能正在写，脚本在容器内用 `better-sqlite3` 的 `.backup()`（SQLite online backup API）取快照再流出，不裸 cp。源文件不存在是全新库的正常态：当日 `history.db` 记为 0 字节（0 字节本身是合法空 SQLite 库），日志注明，不算失败；源文件存在时产物必须带 SQLite 头，否则该段判失败。
3. `daily-private/YYYYMMDD/storage.tar`：storage 容器 `/data` 的活拷贝 tar（`tar -C /data -cf - .`）。对象存储是 append-mostly，活拷贝中途被追加的对象可能内部不一致，接受为日级快照粒度；tar 非零退出时仅当 stderr 确实是 GNU「file changed as we read it」告警才放行（append-mostly 下常见），其余错误判失败。tar 里一个文件条目都没有（`/data` 空或挂错）也判失败。

`daily-private/YYYYMMDD/SHA256SUMS` 盖当天三件：`history.db`、`storage.tar` 与 `../../loom-daily-YYYYMMDD.dump`（校验：`cd daily-private/<date> && shasum -a 256 -c SHA256SUMS`）。目录与文件一律 `chmod go-rwx`（owner-only，不硬编码权限位），全部经 `.tmp`+`mv` 原子发布。

**这三件都是私有数据**（dump 的多张表、mem0 history、对象字节里都可能有学习者文本）：日志只记文件名/大小/sha256，内容不进日志、不进 git。落盘 owner-only 只是纵深——外置卷挂 `noowners`，文件权限本身不是真正的访问边界；真正的边界是 runtime 目录本身的 700。

保留窗口对 dump 与 `daily-private/` 目录相同（最新 14 份 + 每月 1 号，`daily-private` 整个日期目录为单位删），但两条链不各数各的：先按窗口清目录，再清 dump——**dump 只在超窗、非每月 1 号、且同日 `daily-private/` 目录已不存在时才删**。目录在则同日 dump 必在，`SHA256SUMS` 始终可校验；段 2/3 失败的日子只有 dump 没有目录，超窗后照常清理。三段任一失败 → 当日 `FAILED` 标记 + `exit 1`、成功戳不写（已发布的 dump 仍留盘，戳滞后表示当天不完整）；三段全发布成功才盖 `.loom-daily-dump-last-success`。Mac 关机当日不跑（ssh 与本机 docker 都不可用）——**那天就是没有任何一份备份**，Mac 回来后恢复。

**当日重跑**（手动补跑撞上已成功的那次之后）：检测到当日 `SHA256SUMS` 已存在 → dump 不再早发——三段全部 staging 并校验后，四件先各写 `.rtmp` 临时名，再一次 rename 统一提交，manifest 同批最后落。重跑任一步失败，**既有完整集原样、`shasum -c` 仍可校验**（FAILED 标记与退出码照旧）；`.rtmp` 残留不算备份件（不入保留窗、不入 manifest），失败路径与下次运行都会清。当日首次运行维持 dump 早发——段 2/3 失败也保住当天的库备份。

- 脚本与 launchd 日志必须装在内置盘 `~/Library/Application Support/loom-daily-dump/`：launchd 子进程对 `/Volumes/*` 的任何 I/O 都会被 TCC 拒绝（表现为 `spawn failed` / `EX_CONFIG 78`）。对 runtime 目录的读写全部经 `docker run -v` 在容器内完成。
- 失败写 `.loom-daily-dump-FAILED-YYYYMMDD` 并 `exit 1`，本机 docker daemon 不可达时改写到安装目录。`--check` 在戳龄超过 48 小时或当天失败标记存在时 `exit 1`，另汇报最新 `daily-private/` 目录及其 SHA256SUMS 是否列齐三件；标记按日命名，更早日期的标记要手动 `ls` runtime 目录和安装目录。
- 日志：runtime 目录的 `loom-daily-dump.log`，安装目录的 `launchd.log`。
- dump 有效性用 `pg_restore -l`（本地 `pgvector` 镜像容器里跑，读 staging 文件）验 TOC 判，不再单看大小；`LOOM_MIN_BYTES` 只是挡 0 字节/ssh 报错文本的低地板（默认 4KB，全新 schema 空库的 dump ~335KB，不会被误杀）。
- 可覆盖 `LOOM_RUNTIME_DIR`、`LOOM_PG_CONTAINER`、`LOOM_WORKER_CONTAINER`、`LOOM_STORAGE_CONTAINER`（均在 NAS 上）、`LOOM_DB_USER`、`LOOM_DB_NAME`、`LOOM_KEEP_DAILY`、`LOOM_MIN_BYTES`、`LOOM_DUMP_TIMEOUT`。

恢复后两件。备份字节在 Mac 外置盘，经与备份同一条 ssh exec channel 流向 NAS；写 bind mount 一律用 `docker run --rm` 短命容器，绝不 `docker exec` 进在跑的服务；先停容器、写完再启动。

```bash
# 用函数包 ssh：zsh（Mac 默认 shell）不对未加引号的变量做词分割，
# SSH='ssh …' + $SSH 的写法在 zsh 下会整条当成一个命令名报错。
nas() { ssh -i ~/.ssh/tlp_nas_ed25519 -o BatchMode=yes yukoval@bancho-nb2.local "$@"; }

# history.db → worker 的 bind mount /volume1/docker/tlp-test/mem0data（容器内 /var/lib/mem0）
# 先删残留 -wal/-shm：旧 WAL 会在下次打开时回放到新文件上；属主用数字 1000:1000——
# worker 以 UID 1000 跑，pgvector 镜像里没有 node 用户。0 字节文件 = 空库，照常放。
nas 'docker stop the-learning-project-worker-1'
nas 'docker run --rm -i -v /volume1/docker/tlp-test/mem0data:/var/lib/mem0 \
  pgvector/pgvector:0.8.2-pg16-bookworm \
  sh -c "rm -f /var/lib/mem0/history.db-wal /var/lib/mem0/history.db-shm &&
         cat > /var/lib/mem0/history.db &&
         chown 1000:1000 /var/lib/mem0/history.db"' \
  < daily-private/<date>/history.db
nas 'docker start the-learning-project-worker-1'

# storage.tar → storage 的 bind mount /volume1/docker/tlp-test/storage（容器内 /data）。
# 完整恢复 = 先清空目标目录再放字节——破坏性步骤：先校验备份三件（shasum -c 必须
# 全 OK，不过即停，别拿坏档去清空线上数据），再 tar -tf 核对内容、确认目标挂载点
# 没写错才动手。恢复用 storage 自己的镜像（busybox tar，与产出端一致）。
(cd daily-private/<date> && shasum -a 256 -c SHA256SUMS)   # 必须三件全 OK；不过即停
tar -tf daily-private/<date>/storage.tar | head -20        # 再核对要还原的内容
nas 'docker stop the-learning-project-test-storage-1'
nas 'docker run --rm -i --entrypoint sh -v /volume1/docker/tlp-test/storage:/data \
  ghcr.io/chrislusf/seaweedfs:4.48 \
  -c "find /data -mindepth 1 -delete && tar -C /data -xf -"' \
  < daily-private/<date>/storage.tar
nas 'docker start the-learning-project-test-storage-1'
# 只想回灌个别对象（非完整恢复）：去掉 find 行只做解包，属增量覆盖、不清空。
```

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
- `docker-compose.local.yml` 给宿主开 `postgres` 的 5433（本机手动操作本地 compose 栈的 DB 用——5433 是 TEST 中继的历史端口，本地 pnpm 脚本一律不用它，`db:migrate:local` 等默认走 dev 库 :5434），并把 `cloudflared` 放进 `production` profile，`docker compose up` 不会要求 `TUNNEL_TOKEN`。
- `docker-compose.mac.yml` 把 `app` 绑到 `127.0.0.1:8787`，`postgres` 绑 `127.0.0.1:5433` 和 `127.0.0.1:5544`（OrbStack 偶发占住 5433 时的备用宿主端口），并通过显式列服务排除 `cloudflared`。TEST 已不在 Mac 上跑——这份文件只保留给回滚期（Mac 容器 stopped 不删，至少 7 天并经过一个成功 release）；这些宿主端口自 2026-11-06 起不再由下方 relay 占用（中继只留 8787），回滚启动前仍应确认没有残留的中继或 dev 进程占着它们：

```bash
docker compose -f docker-compose.yml -f docker-compose.mac.yml \
  up -d --build migrate app worker postgres
```

### TEST on NAS

TEST 跑在 NAS（`bancho-nb2.local`，x86_64）的 `/volume1/docker/tlp-test/`：compose 项目 `the-learning-project` + 私有 `compose.private.json`；`app` 只绑 NAS 侧 `127.0.0.1:18787`、`postgres` 只绑 `127.0.0.1:15433`，容器带内存/CPU 限额，`restart: unless-stopped`。

NAS sshd 禁 TCP 转发（`AllowTcpForwarding no`，系统配置不改），Mac 访问 TEST 靠本机两个 LaunchAgent（源文件在 `scripts/test-nas/`，运行副本装在 `~/Library/Application Support/tlp-nas-tunnel/`）：

- `studio.yukoval.tlp-nas-tunnel`（`relay.py`）：只监听本机 `127.0.0.1:8787`（→NAS 18787），每条连接开一个 ssh exec channel 在 NAS 上跑 `nc`；常驻几条预热通道，新连接通常跳过 ssh 建链。数据库端口 5433/5544→15433 已于 2026-11-06 关闭——本地 dev 脚本曾默认 5433，任何指向它们的连接都可能落到 TEST；查 TEST 数据改用 `ssh yukoval@bancho-nb2.local docker exec … psql` 一类方式。
- `studio.yukoval.tlp-nas-watch`（`nas-watch.sh`）：NAS 重启后拉回 memory watchdog（watchdog 在 MemAvailable < 2 GB 时停 TEST 容器）；memory stop 或 TEST 不健康时写 `ALERT` 文件并弹通知。NAS 重启与 watchdog 恢复之间只有容器内存限额兜底；Mac 关机则 watchdog 无人重启。

Mac 关机：TEST 在 NAS 上继续跑，但外部不可达、Tailscale 入口断、当日日级 dump 不跑。

依赖：`~/.ssh/tlp_nas_ed25519` 以 `yukoval@bancho-nb2.local` 登录（BatchMode，key 属 owner 私有）。release 构建不再在 Mac 上跑，构建方式待定。

换装/重装（只装 Mac 侧，不改 NAS）：

```bash
mkdir -p ~/Library/Application\ Support/tlp-nas-tunnel
cp scripts/test-nas/relay.py scripts/test-nas/nas-watch.sh \
  ~/Library/Application\ Support/tlp-nas-tunnel/
chmod +x ~/Library/Application\ Support/tlp-nas-tunnel/nas-watch.sh
cp scripts/test-nas/studio.yukoval.tlp-nas-*.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/studio.yukoval.tlp-nas-tunnel.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/studio.yukoval.tlp-nas-watch.plist
```

### 容器 DNS

NAS 侧容器出站解析由 mihomo 的 fake-IP（`198.18.x`）经其 TUN 设备应答，海外域名可达性取决于 owner 的代理节点。原来针对图片候选的 `198.18.0.0/15` 拒绝路径已退役（YUK-1664）；SSRF 守卫 `src/core/net/private-host.ts` 运行时只剩前端 `ProposalCard` 消费。`docker-compose.mac.yml` 给 `app`/`worker` 固定公共递归 DNS（`223.5.5.5`、`119.29.29.29`）是为回滚期 Mac 形态保留的。仍不要放行 `198.18.0.0/15`。

### 可选远程入口

- **Cloudflare Tunnel**：创建 tunnel 时把 hostname 指到 `http://app:8787`，token 放进 `TUNNEL_TOKEN`；UDP/7844 被封时用 `TUNNEL_PROTOCOL=http2`。cloudflared 健康检查读 `--metrics 127.0.0.1:2000` 的 `/ready`，只有至少一条 edge 连接注册后才 healthy：

```bash
docker compose ps cloudflared
docker compose logs --tail 50 cloudflared
```

- **Tailscale**：Serve 把私有 HTTPS 转发到 Mac 本机 loopback（`127.0.0.1:8787` 中继进 NAS TEST）；访问设备须在同一 tailnet，Mac 开机且用户会话内的 daemon 在运行——Mac 关机该入口即断。没有开启 Funnel，主机名与令牌属于本机私有配置，不写进仓库。
- **局域网**：TEST 在 NAS 只绑 loopback（`127.0.0.1:18787`），`app` 不直接暴露到 LAN；Mac 侧入口同样是 `127.0.0.1` 中继。保留应用登录和 `x-internal-token`，只豁免 `/api/health`、`/api/ready`；Postgres 只走 loopback，storage / worker 没有宿主绑定。具体地址见 owner 本机私有记录。
