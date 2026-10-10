# 评估契约统一切换 runbook（YUK-1059，grounding §15–§16）

适用对象：YUK-1038 全量题目契约迁移的**一次集成 release**（contract lanes
1044–1057 + corrective 1091–1100 + meta 1058–1059）。**无部分翻转机制** —
epoch marker 是唯一开关；回滚边界只有两条（见 §5）。

> **授权边界**：本 runbook 是准备/执行手册，**不构成部署授权**。执行窗口前
> owner 需单独给出 final implementation-ready confirmation（decisions 文件
> PENDING 段）。D18 actual-output 评测是 owner-triggered，不在本窗口内。

> **2026-10-04 源码复核（YUK-1047）**：下方既有切换记录仍是当时的历史工件，
> 不证明当前八个正式评分入口完成迁移。当前检出源码仍有八个 legacy 入口与旧 invoker
> 执行分支；epoch active 只能约束 epoch，不能移除同一二进制内的旧评分逻辑。
> `release:manifest` 现在独立采集 `evaluation_source`（文件 SHA-256、入口/行号、
> 未解析调用与缺失入口），有旧执行路径即 fail/exit 1，包括无 `--target` 或库不可达。
> 未发现旧路径或缺证据只报告 info，必须另验部署镜像身份和端到端迁移；info 不是验收通过。
> 此次为本地源码复核，没有重新查询或操作生产。实际迁移继续 YUK-1047。

## 0. 前置（窗口之前；全部只读，不动生产）

| 步骤 | 命令 | 判据 |
|---|---|---|
| 0.1 确认 release 面 | `pnpm release:manifest --target=<pg-url> --out=<out>/pre-cutover-manifest.json` | 输出 lanes（contract ≥14、corrective ≤10、meta）、migrations series=0104–0111；断言面此时允许 info/skip（`contract_epoch` 表尚不存在） |
| 0.2 生产只读 census 已做 | D19 工件（`yuk1038-census-20260924-223104`） | 已有；如需刷新跑 `pnpm migration:capture --out=<dir> --target=<pg>`（REPEATABLE READ READ ONLY，不写） |
| 0.3 restore 演练 | `pnpm restore:drill --dump=<capture>/database.dump --source-manifest=<capture>/source-manifest.json --out=<dir>/restore-evidence.json` | 当前 version-2 parity receipt，最终 manifest 另加 `--require-restore-parity`；旧 daily dump 仅 `--restore-only` 历史有限证明；**必须**在窗口前完成（1056 的 OWNER-ACTIONS 第 1 条） |
| 0.4 daily dump 新鲜度 | `~/Library/Application Support/loom-daily-dump/mac-daily-dump.sh --check` | `exit 0`（fresh）；stale 则先手动补一份 dump |
| 0.5 环境解析 | `docker compose ps`（Mac 本机或 NAS；确认 `the-learning-project-*` 容器面、pg 发布端口 5433、app/worker image tag 记录备查） | 明确 compose project、DB URL、当前 image tag（回滚用） |
| 0.6 磁盘 | `df -h /` ≥10GB | 防 OrbStack 构建盘满事故（2026-09-12 教训） |
| 0.7 发布物就绪 | `pnpm build` + `docker compose build` 出 app/worker 新镜像 | 记录新 image tag；**不启动** |

## 1. 开窗 — 维护窗口（停接纳 + epoch preparing）

顺序有讲究：**先停接纳，再立 marker** —— marker 立起后 API middleware 与
boss delivery 全部 fenced（state≠active → `maintenance`），但已发起的
请求/job 有排空尾巴；先断流让尾巴收敛，再立 marker。

1.1 **停新 admission/生产者**（Mac 生产 compose）：

```bash
docker compose stop app      # HTTP 接纳停止；in-flight 最多排空 30s（README 停止语义）
docker compose stop worker   # pgboss 调度/消费停止（schedule 只随 worker 的 boss 起）
```

> NAS 生产为同款 compose 形态；`docker compose stop app worker`。
> **保留**：active sessions/drafts 不删不迁移（`assessment_response_draft` 等
> 行原样保留，新契约直接读）；浏览器未保存草稿按 D11 warn/save/export
> 由用户侧处理 —— 服务侧不补造。

1.2 **落 schema 迁移**（`contract_epoch` 与全部新表必须先于 marker 存在；
新镜像已 build 完成——§0.7）：

```bash
docker compose run --rm migrate   # 幂等 drizzle migrate → 0104–0111 落库
```

1.3 **立维护窗 marker**：

```bash
pnpm migration:epoch begin-prepare --target=<pg> \
  --epoch=assessment-contract-v1 --actor=<who> --confirm-write \
  --note='assessment cutover window open'
```

1.4 验证栅栏生效：

```bash
pnpm migration:epoch status --target=<pg>
# → assessment-contract-v1/preparing
# （此时旧镜像已停；若有残留 writer 连接仍在，fence 使其 delivery 全部
#   epoch_mismatch —— 由 boss-fence 探针语义保证，rehearsal step 06 实证）
```

## 2. 有界 drain / translate 处置（不删、不无限重试）

```bash
pnpm migration:epoch outstanding --target=<pg>
```

按 `JOB_EPOCH_DISPOSITION`（`src/server/contract-epoch/jobs.ts`）处置
`created/retry/active/failed` 存量：

- **drain 类**（housekeeping/mem0/订阅分发等）：preparing 下也被 fenced，
  但语义与判分合同无关——在开窗**前**让 worker 排空（先停 app、留 worker
  drain 一段），或接受其在 activate 后于新 epoch 恢复。bounded：给一个明确
  时间盒（建议 ≤15 min），超出的行留在队列，不删。
- **translate 类**（judge_run/quiz_gen/ingestion/校准/对话系等，payload 绑旧
  合同）：**绝不**在新 epoch 下原样执行（boss-fence 按出生 epoch 拒跑）。
  处置 = 逐队列裁决：cancel 后以新合同重发，或接受缺席并入 manifest
  `notes`。deadline：窗口内处理完或显式 tombstone。
- **fenced / `*_dlq`**：默认拒跑（设计内）；DLQ 残骸已在 final backup 的
  tombstone 导出里归档，worker 重启自清（1056 OWNER-ACTIONS 第 2/3 条）。
- **订阅 outstanding delivery**（`event_subscription_delivery` 在
  `pending/claimed/retry_wait` 且 `subscriber_version` 落后于 checkpoint）：
  bootstrap 语义不盲目 replay——版本 bump 的跳过只能标 `bootstrap_skipped`，
  outstanding 须显式处置（rehearsal/生产一致：要么旧 epoch 下送完，要么
  tombstone 记录）；manifest 断言 `subscription-translations-zero` 把关。

## 3. 最终备份 + manifest（停全部 writer 后）

```bash
pnpm cutover:final-backup --out=<cutover-dir> --target=<pg-url> --quiescence-evidence=<maintenance.json> --strict
# = scripts/cutover-final-backup.sh：存活 exported snapshot 的 dump/source inventory，
#   同外部 maintenance interval 的 DLQ/migration capture，TOC 与原子封存。
```

读取返回的唯一 `<capture>` 目录：`database.dump`、`source-manifest.json`、
`dlq-tombstones.json`、`migration/manifest-*.json`、cutover manifest 与 `OWNER-ACTIONS.txt`。
外部 owner 持续隔离全部 writer/客户端/序列写入直到 helper 完成，不由这些观察代替隔离。
完整当前契约见 [Full Postgres disaster recovery](../sub5-restore-cli.md#full-postgres-disaster-recovery)。
`--strict` 是 capture 必备件规则；随后对同一 dump/source 运行 drill，并重建 manifest：

```bash
pnpm restore:drill --dump=<capture>/database.dump --source-manifest=<capture>/source-manifest.json --out=<capture>/restore-evidence.json
pnpm cutover:backup --capture-dir=<capture>/migration --dump=<capture>/database.dump --dlq=<capture>/dlq-tombstones.json --source-manifest=<capture>/source-manifest.json --restore-evidence=<capture>/restore-evidence.json --out=<capture> --strict --require-restore-parity
```

这份 dump 是 rollback 边界 A 的载体；失败 inspection/TOC/restore/comparison 都不进下一步。
只认可当前 receipt 的完整 phases、artifact links 和重算 comparison，不认可单独 `verified:true`。
旧 receipt 原件不改，归为 `legacy-limited/reported_verified`，不能通过当前 gate。

## 4. 迁移执行（窗内，fence 下单写者）

```bash
# 4.1 数据迁移（评估合同对象改写；单写者 advisory lock，崩溃可续跑）
pnpm migration:apply --artifacts=<cutover-dir>/capture --target=<pg> \
  --revisions=<registry.json> --confirm-write
# 报告：<artifacts>/apply-report-<runId>.json；幂等——崩溃后同参重跑即
# resume（rehearsal step 07 实证）

# 4.2 迁移核验通过 → 待激活安静窗（epoch 名在 ready 这步完成切换）
pnpm migration:epoch mark-ready --target=<pg> \
  --epoch=assessment-contract-v1 --actor=<who> --confirm-write
pnpm migration:epoch status --target=<pg>   # → assessment-contract-v1/ready
```

ready 态仍全 fenced（安静窗证据：rehearsal step 08）。

## 5. 激活 + 启动 matched app/worker

```bash
pnpm migration:epoch activate --target=<pg> \
  --epoch=assessment-contract-v1 --actor=<who> --confirm-write

docker compose up -d app worker   # 新镜像；worker-boot 的 waitForRunnableEpoch
                                  # 在 recovery/handlers/cron 之前开门
```

> **health ≠ readiness**：`/api/health` 豁免 epoch gate（只证明进程活着）；
> readiness 证据 = `pnpm migration:epoch status` active + 下文验证命令 +
> worker 日志 `[contract-epoch] unfenced`（`CONTRACT_EPOCH_LOG_TAG`）。

## 6. Post-release 验证（三验证点 → manifest 断言）

```bash
pnpm release:manifest --target=<pg> --out=<cutover-dir>/post-release-manifest.json
pnpm delivery:evidence                      # 容器健康/API/队列/迁移 drift 块
pnpm migration:epoch status --target=<pg>   # assessment-contract-v1/active
pnpm migration:epoch outstanding --target=<pg>  # translate 应清零或已 tombstone
```

manifest 断言表（fail 即 exit 1）：

| 断言 | 组 | 验证点 |
|---|---|---|
| `epoch-active` | unified-write | marker=assessment-contract-v1/active —— 只有新写口可跑，旧代码 epoch_mismatch |
| `epoch-history` | unified-write | preparing→ready→active 全序落表（窗口审计证据） |
| `no-runtime-fallback` | no-fallback | 检出源码仍有旧调用/执行分支即 fail；其他情形 info（缺部署证明），active epoch 不能代替迁移证据 |
| `subscription-translations-zero` | translations | 旧 subscriber_version 上无非终态 delivery |
| `translate-outstanding-disposed` | translations | translate/fenced 存量计数落盘（处置决策证据） |
| `pending-evaluations-zero` | translations | `evaluation.status='pending'` = 0 |
| `migrations-applied` | integrity | `__drizzle_migrations` 行数 = `drizzle/*.sql` 文件数（zero drift） |

## 7. Rollback 边界（grounding §16 —— 只有两条，1057 已演练）

### 边界 A — 新写入之前（pre-cutover）

窗口内任何环节失败、或 activate 前中止：

```bash
# 恢复冻结快照（data/queues/subscriptions/assets 一致）
pnpm restore:drill --dump=<capture>/database.dump --source-manifest=<capture>/source-manifest.json --out=<evidence.json>
# 生产路径等效：独立 scratch pg_restore → 完整 schema/table 内容与 sequence 比较；迁移前先证明 parity
# （rehearsal step 04 实证：snapshotDbState 逐表比对 identical）

# 旧镜像回起（回滚镜像，非新代码）：
docker compose up -d app worker   # 用 0.5 记录的旧 image tag
# contract_epoch 留着 preparing/ready 行也无害：legacy 代码读不到该表的
# 业务语义（旧代码无 epoch gate）；如需清表：`pnpm migration:epoch
# begin-prepare --epoch=legacy …` 回显旧 epoch，或让 DBA 决策。
```

### 边界 B — 新写入之后（post-cutover）

**默认 = 继续维护窗 + roll-forward**（修问题前进，不回退）。
**不存在无损 image rollback** —— 旧 app 无法表示新 shape（新 evaluation/
submission/draft 行旧代码读不了，勉强起旧镜像会产出错误判分）。

若确实必须回到旧代码服务，唯一有证明的路径（rehearsal step 11–12 实证形态）：

```bash
# B1. 导出全部 post-cutover 新写入（submissions/drafts/eval/receipt/blobs
#     + 事件水位）——生产用 pg_dump 全量或按
#     src/server/rehearsal/post-write.ts exportPostWriteDelta 的表序导出
#     到 canonical JSON + digest。
# B2. 独立 target restore pre-cutover dump（恢复旧 shape）。
# B3. 回放 delta（replayPostWriteDelta 拓扑序 insert；冲突即 fail）。
# B4. reconcilePostWriteDelta 逐行 canonicalHash 对账 + 计数断言。
# B5. 对账 identical 后，旧镜像接 restored target 起服务；新库冻结保留。
```

演练对应物：`pnpm rehearsal:cutover` 的 steps 11–12 + `rollback-b-reconcile.json`
`identical: true`。生产执行前先按 §0.3 的 restore-drill 手法在隔离
target 上预演一遍 B1–B4，证据归档进 `<cutover-dir>/rollback-b/`。

## 8. 不收尾事项（owner 另行授权）

- 生产部署/维护窗口执行：待 owner final implementation-ready confirmation。
- D18 actual-output 评测：原 `pnpm eval:d18` runner 已在 YUK-1401（#1631）删除，
  需要时从 `87f66b3e2^` 取回再由 owner 触发，不在本窗口跑。
- 旧 columns/images 保留期与清理：保留作恢复安全，非 phased rollout；
  清理另立票。
