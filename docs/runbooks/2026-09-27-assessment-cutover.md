# 评估契约统一切换 runbook（YUK-1059，grounding §15–§16）

适用对象：YUK-1038 全量题目契约迁移的**一次集成 release**（contract lanes
1044–1057 + corrective 1091–1100 + meta 1058–1059）。**无部分翻转机制** —
epoch marker 是唯一开关；回滚边界只有两条（见 §5）。

> **授权边界**：本 runbook 是准备/执行手册，**不构成部署授权**。执行窗口前
> owner 需单独给出 final implementation-ready confirmation（decisions 文件
> PENDING 段）。D18 actual-output 评测是 owner-triggered，不在本窗口内。

## 0. 前置（窗口之前；全部只读，不动生产）

| 步骤 | 命令 | 判据 |
|---|---|---|
| 0.1 确认 release 面 | `pnpm release:manifest --target=<pg-url> --out=<out>/pre-cutover-manifest.json` | 输出 lanes（contract ≥14、corrective ≤10、meta）、migrations series=0104–0111；断言面此时允许 info/skip（`contract_epoch` 表尚不存在） |
| 0.2 生产只读 census 已做 | D19 工件（`yuk1038-census-20260924-223104`） | 已有；如需刷新跑 `pnpm migration:capture --out=<dir> --target=<pg>`（REPEATABLE READ READ ONLY，不写） |
| 0.3 restore 演练 | `pnpm restore:drill --dump=<最新 loom-daily-*.dump> --out=<dir>/restore-evidence.json` | `verified: true`；**必须**在窗口前完成（1056 的 OWNER-ACTIONS 第 1 条） |
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
pnpm cutover:final-backup --out=<cutover-dir>
# = scripts/cutover-final-backup.sh：DLQ tombstone 导出 → pg_dump -Fc →
#   TOC 核验 → migration:capture → cutover manifest（--strict 形参在
#   cutover-backup.ts 层，正式执行必备件缺失即 exit 1）
```

产出 `<cutover-dir>/loom-cutover-<ts>.dump` + `dlq-tombstones-*.json` +
`capture/manifest-*.json` + cutover manifest + `OWNER-ACTIONS.txt`。
**这份 dump 是 rollback 边界 A 的唯一载体** —— TOC 核验不过或 capture
失败都不进下一步。

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
| `no-runtime-fallback` | no-fallback | fence 覆盖所有写口 + 1097 映射冻结 + 1099 结构化发布 —— 无对旧路径的运行时猜测（静态证明为主） |
| `subscription-translations-zero` | translations | 旧 subscriber_version 上无非终态 delivery |
| `translate-outstanding-disposed` | translations | translate/fenced 存量计数落盘（处置决策证据） |
| `pending-evaluations-zero` | translations | `evaluation.status='pending'` = 0 |
| `migrations-applied` | integrity | `__drizzle_migrations` 行数 = `drizzle/*.sql` 文件数（zero drift） |

## 7. Rollback 边界（grounding §16 —— 只有两条，1057 已演练）

### 边界 A — 新写入之前（pre-cutover）

窗口内任何环节失败、或 activate 前中止：

```bash
# 恢复冻结快照（data/queues/subscriptions/assets 一致）
pnpm restore:drill --dump=<cutover-dir>/loom-cutover-<ts>.dump --out=<evidence.json>
# 生产路径等效：独立 target pg_restore → 核验表计数/迁移计数
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
- D18 actual-output 评测（`pnpm eval:d18 --lane=jev-openrouter …`）：
  owner-triggered，预算闸已就位，不在本窗口跑。
- 旧 columns/images 保留期与清理：保留作恢复安全，非 phased rollout；
  清理另立票。
