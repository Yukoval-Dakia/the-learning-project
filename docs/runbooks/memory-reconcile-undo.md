# Runbook — mem0 记忆调和误操作回滚（YUK-557）

> 单元 `memory-reconcile-policy`，设计 SoT：`docs/design/2026-07-03-memory-reconcile-spec.md`。
> 前提：`client.restoreVerbatim` 已落地（S3，`src/server/memory/client.ts`）——本 runbook 的逐字恢复 hop 依赖它。

调和 job（`memory_reconcile`）用 GLM 判定新记忆与既有记忆的关系并执行破坏性动作
（MERGE 改写+删、RETRACT_NEW 删、SUPERSEDE 软取代覆写）。YUK-557 后每条决策的原文/payload
在 **write-ahead 阶段**快照进 `memory_reconciliation_log.prev_text`/`prev_metadata`，破坏性硬删
额外经 mem0 官方 `delete()` 留 SQLite `memory_history` 墓碑。本 runbook 是最小充分的**手动**
undo 面（专家 owner + psql/脚本权限；无一键 UI）。

## 检测面（先知道「发生了一次误销毁」）

owner 现实中几乎不会自发注意到某条记忆被误删——回滚依赖可检测。两个信号源：

1. **结构化日志**（可 grep / 可计数）——每次破坏性 apply / 每次降级 / floor 跳过都打一行：
   ```
   [memory_reconcile] destructive apply MERGE new_memory_id=… old_memory_id=… log_id=…
   [memory_reconcile] destructive apply RETRACT_NEW new_memory_id=… log_id=…
   [memory_reconcile] per-kind MERGE suppressed (kind=…) new_index=…
   [memory_reconcile] score-floor downgrade (score=…) new_index=…
   [memory_reconcile] score-floor skipped (no candidate score) action=… new_index=…
   ```
2. **场景 C 批量核查 SQL**（见下）——按窗口统计破坏性决策 + 降级计数。

## 场景 A：MERGE/RETRACT_NEW 误删了一条记忆

1. 从 `memory_reconciliation_log` 按嫌疑窗口/`user_id` 查候选：
   ```sql
   SELECT id, action, reason, new_memory_id, old_memory_id, prev_text, prev_metadata, llm_raw
   FROM memory_reconciliation_log
   WHERE user_id = 'self' AND action IN ('MERGE','RETRACT_NEW')
   ORDER BY planned_at DESC LIMIT 20;
   ```
2. **主恢复源 = `prev_text`（WAL，在 `archive.ts` 备份边界内）**：非空 → 直接用它，跳到步 4。
   - MERGE 删的是 `new_memory_id`（被吸收的新行）；RETRACT_NEW 删的是 `new_memory_id`（噪声/重复的新行）。
   - `prev_text` 对 RETRACT_NEW = 被丢弃的新行原文；对 MERGE 场景若要恢复被吸收的新行，其原文亦在 `prev_text`（RETRACT 语义）；被覆写的 old 行走场景 B。
3. **副保底 = mem0 SQLite 墓碑**（仅当 `prev_text` 为空，即 YUK-557 上线前的历史遗留行；注意此库在
   `mem0data` 卷、**不在逻辑备份内**，可能与 PITR 全库 restore 分叉）：
   ```
   sqlite3 <historyDbPath> "SELECT previous_value, created_at FROM memory_history
     WHERE memory_id='<uuid>' AND action='DELETE' ORDER BY id DESC LIMIT 1;"
   ```
   - `<historyDbPath>`：prod 挂载卷 `/var/lib/mem0/history.db`；dev 经 `MEM0_HISTORY_DB_PATH` 覆盖。
   - `<uuid>`：RETRACT_NEW / MERGE 删的 `new_memory_id`。
   - 亦可经 `client.history('<uuid>')` 读同一墓碑。
4. **诚实预期**：恢复是「把原文经 `restoreVerbatim` 重新入库」，产**新 UUID 新行**（重 embed），**非原行复活**。
   metadata：`prev_metadata` 有值（SUPERSEDE/MERGE 覆写场景）可一并恢复；RETRACT_NEW 场景 `prev_metadata`
   为 NULL，需从 `event` 表按 `event_id`（`llm_raw` 溯源）重推，或接受「文本对、metadata 缺」降级。
5. 逐字恢复（**用 `restoreVerbatim`，绝不用 `addEventMemory`**——后者 infer:true + eventToText 信封会重跑抽取
   LLM、非逐字）：
   ```ts
   import { createMemoryClient } from '@/server/memory/client';
   const client = createMemoryClient();
   await client.restoreVerbatim(prevText, reconstructedMetadata /* 从 prev_metadata / event 表重建 */);
   ```

## 场景 B：SUPERSEDE/MERGE 覆写了错误内容

1. 查 `memory_reconciliation_log`，关注 `action='SUPERSEDE'`/`'MERGE'`。
2. `prev_text`/`prev_metadata` 是**被覆写前**的原文/完整 payload（write-ahead 快照）。
3. 恢复（这两个动作的 old 行**未物删**，字面恢复可行）：
   - **MERGE**（`rewriteMemoryText` 覆写了 old 行 `payload.data`）→ 用同款 raw-SQL jsonb merge 把 `prev_text`
     写回 `payload.data`（**原行字面恢复**）：
     ```sql
     UPDATE "<collection>"
     SET payload = payload || jsonb_build_object('data', '<prev_text>')
     WHERE id = '<old_memory_id>'::uuid;
     ```
   - **SUPERSEDE**（只加了 `superseded_by`/`invalid_at` 标记）→ 删两键，重对 P3 读路径可见：
     ```sql
     UPDATE "<collection>"
     SET payload = payload - 'superseded_by' - 'invalid_at'
     WHERE id = '<old_memory_id>'::uuid;
     ```

## 场景 C：批量核查某窗口内破坏性决策（检测面之一）

```sql
SELECT action, count(*), avg((llm_raw->>'confidence')::float) AS avg_confidence,
       count(*) FILTER (WHERE (llm_raw->>'structurally_corroborated')::bool = false) AS floor_downgraded
FROM memory_reconciliation_log
WHERE planned_at > now() - interval '7 days'
GROUP BY action;
```

配合上面的结构化日志——两者构成本波的最小检测面，使 owner 能主动发现误删并触发本 runbook。

## 已知限制（如实标注）

- 全程手动 SQL + 脚本，无一键 undo（最小充分形态；未来若 undo 频率超预期，只读 admin 端点
  `GET /api/_/memory-reconcile/:id` 是自然增量，本波不建）。
- mem0 墓碑只存文本、不存 vector/完整 metadata，且**在备份边界外**（副保底，非主源）——主源是 WAL `prev_text`。
- YUK-557 上线前的历史 WAL 行无 `prev_text`/`prev_metadata`，只能依赖 mem0 墓碑（若涉硬删）或不可回滚。
- `restoreVerbatim` 依赖 mem0 `add(...,{infer:false})` 语义（装机 mem0ai 3.0.6 已核验走 `addToVectorStore`
  → `createMemory` 直存、无 MD5-dedup）；若未来升级 mem0 改变该语义，退路是直接 pgvector INSERT + 手动 embed。
