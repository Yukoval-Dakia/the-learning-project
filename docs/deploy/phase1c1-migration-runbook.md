# Phase 1c.1 生产部署 Runbook

> 适用：把 Phase 1c.1 Lane A（event-driven schema）+ Lane B（KnownEvent 契约）+ Step 3-7 应用代码上线到 NAS 自部署环境。
>
> 状态：**人工执行，禁止自动跑**。每一步执行前与用户确认，遇到异常立即停。

---

## 0. 前置说明

- 单用户工具，整体停机窗口可接受（数据量 ~k 行级，~分钟完成）。
- 部署目标：NAS 上 `docker-compose.yml`（app + Postgres + Cloudflare Tunnel）。
- 数据库 `DATABASE_URL` 指向 compose Postgres；本 Runbook 用 `pg_dump` 备份，用 `drizzle-kit migrate` + 一次性 `tsx` 跑数据迁移。
- **回滚不是无代价的**——见 §10。

---

## 1. Pre-flight checks（5 分钟）

```bash
# 1.1 确认在主干、commit 历史完整
git checkout main
git pull
git log --oneline | head -10
# 期望看到 Step 1-8 相关 commit 在最近 10 个内

# 1.2 确认 drizzle 迁移文件齐全
ls drizzle/
# 期望：0000_* … 0005_phase1c1_event_payload_gin_and_mastery_view.sql

# 1.3 确认迁移脚本能跑（typecheck + 测试通过）
pnpm typecheck
pnpm test
# 全绿才往下走

# 1.4 看一眼线上 schema 状态（连生产 DB，只读）
# 如果有 drizzle-kit check / schema diff 工具
pnpm drizzle-kit check --config=drizzle.config.ts
```

✅ Pass 条件：以上全无报错。任何一项失败 → STOP。

---

## 2. 维护窗口启动（人工确认）

通知 / 锁住自己：本次部署预计 ~10-15 分钟。

如果是日间，提前预告；如果是夜间则在执行前最后一次确认：

> 我现在要开始 Phase 1c.1 部署。预计 10-15 分钟无服务。确认继续？

得到明确"继续"答复后才进入下一步。

---

## 3. 数据库备份（关键，不能跳）

```bash
# 进入 NAS / compose 主机
TS=$(date +%Y%m%d-%H%M%S)
docker compose exec postgres pg_dump \
  -U ${POSTGRES_USER:-loom} \
  -F custom \
  -f /tmp/loom-pre-1c1-${TS}.dump \
  ${POSTGRES_DB:-loom}

# 拷出来一份冷备到 NAS 数据盘
docker compose cp postgres:/tmp/loom-pre-1c1-${TS}.dump ./backups/

# 验证文件存在 + 体积合理（不应是 0 字节）
ls -lh ./backups/loom-pre-1c1-${TS}.dump
```

✅ Pass 条件：dump 文件存在且 > 1 KiB（空 dump 也有 header；用 `pg_restore -l` 验证更稳）。

**记录文件名！** 回滚要用。

---

## 4. Schema 迁移（drizzle-kit migrate）

```bash
# 应用 drizzle/ 下所有未应用的 .sql 文件
# 0004 + 0005 是 Phase 1c.1 新增（Lane A schema + mastery view + GIN index）
pnpm db:migrate
```

drizzle-kit 会读 `drizzle/meta/_journal.json` 顺序应用未跑的迁移；已跑的会跳过（幂等）。

✅ Pass 条件：

- 终端打印 `migrations applied successfully!`
- 验证：
  ```bash
  docker compose exec postgres psql -U ${POSTGRES_USER:-loom} ${POSTGRES_DB:-loom} -c "\d knowledge_mastery"
  # 期望看到视图定义（不是 "Did not find any relation"）
  ```

如果失败：STOP，看错误，可能是 0005 view DDL 与现存 knowledge 表列不兼容。回到 §3 备份不需要恢复——schema 迁移失败应该只是 DDL 层报错，没污染数据。

---

## 5. 数据迁移（legacy → event 流）

```bash
# 一次性脚本：mistake / review_event / dreaming_proposal / ingestion_session
# → event / material_fsrs_state / learning_session
pnpm tsx scripts/migrate-phase1c1.ts
```

**关键特性**：

- 幂等：deterministic event ID + `ON CONFLICT DO NOTHING`，再跑一次是 no-op。
- 增量安全：失败重跑只补未写完的部分。
- §O2 precheck：跑前会检查 `judgment` 表是否为空（不存在则 OK）。如果有数据 → 脚本拒绝执行，需要先手工 triage。

✅ Pass 条件：

- 脚本退出码 0
- 无 `[migrate-phase1c1] aborting` 字样
- 看到 `[migrate-phase1c1] skip propose` 是 OK 的（缺 name/parent_id 的 dreaming_proposal 主动跳过）

---

## 6. 数据完整性 Smoke

```bash
# 6.1 event 表行数 >= 3 个 legacy 表的总和（attempt + judge + review + propose）
docker compose exec postgres psql -U ${POSTGRES_USER:-loom} ${POSTGRES_DB:-loom} <<'SQL'
SELECT
  (SELECT COUNT(*) FROM event) AS events,
  (SELECT COUNT(*) FROM mistake) AS mistakes,
  (SELECT COUNT(*) FROM review_event) AS reviews,
  (SELECT COUNT(*) FROM dreaming_proposal) AS proposals,
  (SELECT COUNT(*) FROM ingestion_session) AS ingestion_sessions,
  (SELECT COUNT(*) FROM learning_session WHERE type = 'ingestion') AS migrated_sessions;
SQL
```

**期望**：

- `events ≈ mistakes + (mistakes with cause) + reviews + (valid proposals)`
- `migrated_sessions == ingestion_sessions`

```sql
-- 6.2 mastery view 对活跃 knowledge 返回非空
SELECT * FROM knowledge_mastery
WHERE mastery IS NOT NULL
ORDER BY last_evidence_at DESC NULLS LAST
LIMIT 5;
```

**期望**：≥1 行（如果你最近练过任何 knowledge）；如果全空，说明 mistake / review_event 经过迁移没产生有效 event，需要回到 §5 看脚本日志。

✅ Pass 条件：行数符合预期 + mastery view 可查。

---

## 7. 应用代码部署

```bash
# 7.1 docker compose 拉新镜像
docker compose pull
docker compose up -d

# 7.2 等容器健康
sleep 5
docker compose ps
# 看到 app / postgres / cloudflared 都 healthy
```

✅ Pass 条件：所有容器 healthy。app 容器无 crash loop。

---

## 8. 部署后 Smoke

```bash
# 8.1 健康检查（无 token）
curl -fsS https://<your-tunnel-hostname>/api/health
# 期望 200，body 包含 "ok"

# 8.2 鉴权路径（带 token）
INTERNAL=$(grep INTERNAL_TOKEN .env | cut -d= -f2)
curl -fsS -H "x-internal-token: $INTERNAL" \
  https://<your-tunnel-hostname>/api/mistakes/recent?limit=5
# 期望 200 + JSON 数组（≤5 个最近错题）

# 8.3 event 流可查
curl -fsS -H "x-internal-token: $INTERNAL" \
  'https://<your-tunnel-hostname>/api/events?action=attempt&limit=5'
# 期望 200 + ≤5 个 attempt event
```

✅ Pass 条件：3 个请求都 200 且返回符合预期形状。

---

## 9. 维护窗口结束

```bash
# 通知 / 解锁
echo "Phase 1c.1 deployed at $(date)" >> ./deploy-log.txt
```

记一笔到 `deploy-log.txt`（自留底）。

---

## 10. 回滚预案（**慎用**）

### 风险等级

**HIGH**——Step 4 + Step 6 的 server / routes 只读 event 流；本次部署落地后，回滚意味着丢掉从 §7 开始进入系统的新写入（如果有任何 ingestion / mistake 在 §7-§9 之间产生）。

### 何时回滚

- §8 smoke 大面积失败（如 mistakes/recent 返回 500、event 流为空）
- §6 数据完整性检查发现 event 行数明显偏低（> 50% 缺失）
- 上线后用户体感 break（如 UI 看不到错题）

### 不应该回滚的情况

- 单个 API 报错可以热修，**别**因为局部 bug 启动回滚
- mastery view 行为不符预期但 API 仍工作——这是数据/参数问题，不是部署事故

### 回滚步骤

```bash
# R1: 停应用容器
docker compose stop app

# R2: 恢复数据库
TS=<§3 记录的 dump 文件时间戳>
docker compose exec -T postgres pg_restore \
  -U ${POSTGRES_USER:-loom} \
  -d ${POSTGRES_DB:-loom} \
  --clean --if-exists \
  < ./backups/loom-pre-1c1-${TS}.dump

# R3: 切回前一版本镜像 / commit
# 如果用 git tag：
git checkout <pre-1c1-tag>
docker compose build app
docker compose up -d

# R4: smoke /api/health
curl -fsS https://<host>/api/health
```

⚠️ **回滚后必须告知用户**：从部署到回滚之间的任何操作（错题录入、AI 提议、复习）**全部丢失**。需要用户重做。

---

## 11. 已知 caveats

- **`db:migrate` 的 journal 行为**：drizzle-kit 通过 `drizzle/meta/_journal.json` + DB 内 `__drizzle_migrations` 表追踪已应用迁移。如果生产 DB 已有部分 hand-written SQL 通过其他方式（psql 手动）应用过，`db:migrate` 不会感知到，可能尝试重跑——多数 DDL 用 `IF NOT EXISTS`（如 0005 的 GIN index），但 `CREATE VIEW` 没有 `OR REPLACE`，会冲突。**预防**：上线前 §1.4 跑 `drizzle-kit check` 看 diff。
- **`scripts/migrate-phase1c1.ts` 的幂等性**：靠 deterministic ID（`deterministicId(prefix, sourceId)`）+ `ON CONFLICT DO NOTHING`。重跑场景下，**新增** legacy 行会被补迁移；**修改** legacy 行的迁移结果**不会**自动重算（因为 ID 已存在则跳过）。如果生产期间 legacy 表被改写过，需要手工 triage。
- **mastery view 是 `VIEW` 不是 `MATERIALIZED VIEW`**：每次查询实时计算。当前数据量（~k 行）毫秒级 OK；ADR-0012 触发条件（>100k events + >50ms 查询）出现时再升级为 MV。

---

## 12. Step 9 的预告（不在本 Runbook 范围）

Phase 1c.1 Step 9 计划 DROP 4 个 legacy 表（`mistake` / `review_event` / `dreaming_proposal` / `ingestion_session`），那是**不可逆**节点。建议：

- 本 Runbook 上线后**留 2-4 周观察期**
- 期间所有读取走 event 流（Step 6 已落实）
- 观察期无异常 → 跑 Step 9 DROP（先备份；DROP 后基本不可回滚）
- 观察期有异常 → 修 bug，**留着 legacy 表当 forensic 数据源**

---

## 一句话总结

> 备份 → drizzle-kit migrate → tsx migrate-phase1c1.ts → smoke → 部署应用 → smoke 二次 → 完成。
> 回滚是 break glass，不是首选——优先热修。
