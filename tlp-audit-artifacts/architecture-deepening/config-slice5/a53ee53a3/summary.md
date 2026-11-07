# 配置片 5 证据（YUK-1869 / YUK-1677）

- tested head: `a53ee53a3`（本目录后续的文档/回执提交不改代码）
- base: `e6ed70762b66546bfabc2ba3dc2a4973dc3c2979`
- 外部证据目录：`/Volumes/YukovalSBak/yukoval-projects/tlp-build/slice5/`（依赖与 dist 不在此处，不提交）
- 隔离 PG：`127.0.0.1:5434` 的 `loom_dev_slice5_{base,head,prod}`（共享 dev Postgres，非 TEST；用完已 drop）

## 1. 管理写面 base/head 同输入逐字节

同一份探针（`probe-head.ts` 与由它生成的 base 版本；差异只在导入路径/writer 端口绑定）对两个隔离库执行相同序列。逐字节比较结果（`base.out` / `head.out`，SHA256 见 `evidence-sha256.txt`）：

| section | 结构 diff |
|---|---|
| WRITE_SUCCESS / BAD_VALUE / UNREGISTERED / EPOCH_CONFLICT / CONCURRENT / JOURNAL_CONCURRENT | 0 |
| HTTP_WRITE / HTTP_BAD_REQUEST_BODY / JOURNAL_HTTP | 文本相等 |
| READ_UNINJECTED / READ_INJECTED（含 165KB 全 facts 包） | 1：仅 `snapshot.hydrated_at`（水合墙钟时间，非配置事实） |

折叠项只有 `snapshot.hydrated_at`（两次运行的水合时刻）；没有其它规范化。
`base.err` / `head.err` 逐字节相同。

## 2. audit:flags 拆分前后逐字节

同一 `--base e6ed70762...`，base 树（`git archive` + `GIT_DIR` 指回本仓库）与 head 树：

| 场景 | 输出 SHA256 | 退出码 |
|---|---|---|
| 正常 `--strict` | `17414ec4…60a`（两边相同） | 0 / 0 |
| 注入 `SLICE5_UNREGISTERED_ENABLED` + `process.env.JUDGE_DURABLE_ENABLED` 直读 | `dca0c64f…361`（两边相同） | 1 / 1（UNREGISTERED 1 + DIRECT-ENV-READ 1） |
| `--base deadbeef…`（不可读 base） | `908461be…d64`（两边相同） | 1 / 1（fail closed） |

扫描边界唯一变化：`EXCLUDE_FILES` 增加 `scripts/lib/config-audit/{source-scan,contract-compare}.ts`，即把原来单一 `scripts/audit-flags.ts` 的自指内容换到两个新文件；没有新增被扫描/少扫描的产品文件。

## 3. 生产形态双进程（外置盘构建）

`git archive a53ee53a3` 导出到外部目录，同一目录复用一份 `node_modules`；直接执行 `pnpm build` 的五个 esbuild/vite 命令（产物：`dist/{server,worker,migrate,question-preparer-ticket}.cjs` + `dist/start/`）。

- DB：`loom_dev_slice5_prod`（`dist/migrate.cjs` 迁移；插入 active `assessment-contract-v1`）
- API：`node dist/server.cjs`（`API_PORT=8798`，`RW_WORKER=0`），日志 `prod-api.log`
- worker：`node dist/worker.cjs`，日志 `prod-worker.log`（`[worker] running, handlers registered`）
- PATCH `TASK_FAILURE_ALERT_MIN_RUNS=2` + `TASK_FAILURE_ALERT_RATE=0`：
  - 响应 `committed_epoch=1, snapshot_epoch=1, snapshot_current=true`（`prod-patch.json`）
  - GET `/api/admin/config` 两键 `source=db, revision=1`
  - journal：两行 `action=set, actor=panel:admin`
- worker 侧同一配置生效：写入前 job `active=0 new=0`；worker 15s 刷新后 `active=1 new=1`，并写入 `experimental:task_failure_alert` 事件 1 条（`prod-worker.log:564,1006-1007`）

## 4. 两个真实变更场景的改动文件数

同一份假设改动分别应用到 base/head 的 `git archive` 树：

| 场景 | base | head |
|---|---|---|
| 给配置加一个带校验的新键（registry + reader + `KEY_CONSUMERS`） | 3 文件 | 3 文件 |
| 改配置写面的 epoch 冲突处理（`bumpEpoch` 公式） | 1 文件（`src/server/config/write.ts`） | 1 文件（`src/core/config/server/write.ts`） |

**没有改善。** 本片的收益是依赖方向和 owner（core 不再 import AI/capability，写面事实可替换），不是这两个场景的编辑面；写面文件行数从 1065 增到 1144（端口合同 + 注释）。

## 5. 门与测试

- `pnpm typecheck`（含 Start tsconfig）
- `lint-ratchet`：81 warnings / 0 infos，与 base 81 / 0 相同；biome 0 errors
- `audit:capability-boundaries`：new dependency edges=0；core→server/capability 无新增 value 边
- `audit:architecture-deepening`：通过；pass-through +0；dependency totals 193/0/1
- `audit:flags --strict`、`audit:schema`、`audit:partition`、`audit:api-client`、`audit:profile`、`audit:task-census`、`audit:draft-status`、`audit:test-policy`、`audit:provider-lanes`：通过
- 触及的 6 个 DB 测试文件 / 19 cases：通过（`vitest.db.config.ts`，testcontainer）

## 没验证的

- 未跑完整 `pnpm test`（只走 exact-head CI Gate）。
- `pnpm build` 在导出目录用等价 esbuild/vite 命令直接执行（`pnpm build` 的 pnpm deps-status 检查要求 purge/重装，未在外部盘重装）；产物与脚本参数逐字相同。
- 未调模型；worker 生效证据用零 AI 的 `task_failure_alert_hourly` 阈值变化。
- 两个 repo-docs 哈希（`docs/adr/0072-question-bank-agent-tools.md`、`docs/design/2026-11-03-notes-m3e.md`）在本次改动前已与 MANIFEST/SHA256SUMS 不一致，未代改。
