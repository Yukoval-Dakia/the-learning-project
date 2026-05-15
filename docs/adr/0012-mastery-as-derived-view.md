# Mastery / last_active_at 转 derived view（drop stub fields）

> 起源：2026-05-15 data-assumptions audit 揭露 `knowledge.base_mastery` / `ai_delta_mastery` / `last_active_at` 三个 stub 字段——schema 定义、零 write path。多份 plan / spec 假设它们活着（sub-0d Step 2.1 `update_ai_delta_mastery` tool / MaintenanceProposeTask "60d 无访问归档" / architecture.md Knowledge 表）。本 ADR 给 mastery / 活跃度数据一个统一决策：**不存为字段，从 events 派生**。

---

## 决策

**Drop 三个 stub 字段 + 改用 derived PG view（或函数）从 events 表派生**。

```sql
-- 删除（在 Phase 1c.1 Step 1 同步执行）
ALTER TABLE knowledge DROP COLUMN base_mastery;
ALTER TABLE knowledge DROP COLUMN ai_delta_mastery;
ALTER TABLE knowledge DROP COLUMN last_active_at;

-- 新增（Phase 1c.1 Step 1 events 表落地后即可建）
CREATE VIEW knowledge_mastery AS
  SELECT
    k.id AS knowledge_id,
    -- 见 §计算公式
    coalesce(mastery_calc.score, 0.5)::real AS mastery,
    mastery_calc.evidence_count,
    mastery_calc.last_evidence_at,
    -- 最后一次该 knowledge 被任何 event 触达
    coalesce(activity_calc.last_event_at, k.created_at) AS last_active_at
  FROM knowledge k
  LEFT JOIN (... 聚合见下 ...) mastery_calc ON ...
  LEFT JOIN (... last_event 聚合 ...) activity_calc ON ...;
```

读路径 API 不变（看到的是 `knowledge.mastery` 字段），只是底下从字段变 view 列。

---

## 为什么 derived

### 1. 与 ADR-0006 v2 event-driven 核一致

ADR-0006 v2 说"events 是真相"。如果 mastery 同时存为字段又能从 events 推出，存在**双 source of truth**——缓存可能漂移。derived view 直接把"events"作为唯一真相。

### 2. 单一用户 + Postgres，性能足

events 表年增量预估：
- 单用户每日 ~10-50 attempt events + ~20-100 review events
- 一年 ~10k events 上限
- 加 (knowledge_ids GIN) 索引后，"某 knowledge 的近 90d errors" 查询毫秒级

不需要 materialized view。**升级路径平滑**：如果 events 超 100k 行 / mastery 查询 > 50ms，加 `MATERIALIZED VIEW REFRESH CONCURRENTLY` 改造，client 代码不变。

### 3. 没人在写就别假装在写

audit 数据：base_mastery / ai_delta_mastery 自项目起 zero UPDATE；last_active_at 同。**事实就是 derived 在用**——所有"读 mastery"的代码（实际上现在没有）如果要落地，都会去聚合 mistakes / events。把这个事实在 schema 层正式化，**避免假定可写**。

### 4. 删字段比新建 write path 工时小

stored 方案要：dreaming agent 写 path + user review 写 path + event → mastery 投影 + 缓存一致性测试。**多人月**。

derived view 方案：一份 SQL view + 一份 cost 调优。**单人日**。

### 5. mastery 的语义本身是聚合派生

"我对 X 知识点的掌握度" 本质是 "我在 X 上的近期表现的 summary"。直接 derive 是语义一致；storing 是把派生值物化，本质是 cache。**先 view 后 cache（如果需要）** 是经典 schema 设计。

---

## 计算公式（first draft，可调优）

### Mastery（区间 [0, 1]）

针对每个 knowledge K：

```sql
WITH attempts AS (
  SELECT
    e.id,
    e.created_at,
    e.outcome,
    -- recency weight：30 天前的事件权重 ~0.5
    exp(-ln(2) * extract(days from (now() - e.created_at)) / 30.0) AS weight
  FROM event e
  WHERE e.action IN ('attempt', 'review')
    AND e.subject_kind = 'question'
    AND e.payload @> jsonb_build_object('referenced_knowledge_ids', jsonb_build_array(K))
    -- 或者 join 上 question.knowledge_ids
    AND e.created_at > now() - interval '180 days'
),
agg AS (
  SELECT
    sum(case when outcome = 'success' then weight else 0 end) AS weighted_success,
    sum(weight) AS weighted_total,
    count(*) AS evidence_count,
    max(created_at) AS last_evidence_at
  FROM attempts
)
SELECT
  CASE
    WHEN evidence_count = 0 THEN NULL              -- 新 / 未练知识点：UI 显示"未练习"
    WHEN evidence_count < 3 THEN 0.5                -- 证据太少时回中位
    ELSE (weighted_success / weighted_total)::real  -- 正常情况
  END AS score,
  evidence_count,
  last_evidence_at
FROM agg;
```

**Decay 半衰期 30d** 是初始选择；后续可调。Sub 0d 的 "weak point" 阈值（mastery < 0.4）依此 view 工作。

### last_active_at

```sql
SELECT max(e.created_at) AS last_event_at
FROM event e
WHERE 
  -- 任何提到该 knowledge 的 event
  (e.subject_kind = 'knowledge' AND e.subject_id = K)
  OR (e.payload @> jsonb_build_object('referenced_knowledge_ids', jsonb_build_array(K)))
  OR (e.payload @> jsonb_build_object('knowledge_ids', jsonb_build_array(K)));
```

GIN 索引 `event_payload_idx ON event USING GIN (payload jsonb_path_ops)` 让上述查询毫秒级。

### AI delta（可选 v1，可推迟）

ADR-0006 v2 ProposeKnowledge / RateEvent 完整 chain 落地后，AI 主动的 mastery 调整也可入 view。**v1 不做**——先用上面单纯基于 attempt/review outcome 的 mastery；AI 影响通过它产生新 events 间接体现。

---

## 接受的代价

- **查询路径切换**：原代码假设 `knowledge.base_mastery` 字段（虽然只读到 0）。改 view 后该字段不存在。需要扫一遍 SELECT 改为 join `knowledge_mastery` view。**audit 结果显示当前零代码读这字段**，所以代价微乎其微
- **空 events 表期间 mastery 永远是 NULL**：UI 要友好显示"未练习"。这本来就是事实，存为 0.0 反而误导（"掌握度 0%" ≠ "未练习"）
- **跨节点 mastery 聚合（"父节点的子节点平均 mastery"）需要额外 SQL**：但这是聚合本身的需求，不是 view 的成本
- **未来如果引入"AI 直接 override mastery"** —— 比如用户的某个 quiz 通过后 AI 给 mastery boost：那时再加一个 events 路径（`action='set_mastery_delta'` 或类似），view 自然把它纳入。**不需要回退到 stored**

---

## 触发重新评估

- **events 表超 100k 行 + mastery 查询 > 50ms** → 升级到 materialized view（client 代码不变）
- **多用户来时**（ADR-0007 retrofit 触发） → mastery view 加 user_id filter，逻辑同
- **mastery 公式被发现误导** → 重写公式不需改 schema，只改 view 定义 SQL
- **如果发现需要"mastery 历史曲线"** → 不变 view 决策；建另一个 view `knowledge_mastery_timeseries`

---

## 落地步骤

**Phase 1c.1 Step 1 加入**：

1. 建 events 表（per ADR-0006 v2 + ADR-0010 + ADR-0011）
2. **同步**：DROP `knowledge.base_mastery` / `ai_delta_mastery` / `last_active_at`
3. 建 `knowledge_mastery` PG view（含 mastery / last_active_at）
4. `src/core/schema/`：`KnowledgeSelectGenerated` 自动同步（drizzle introspect view 当作只读表）。**但 drizzle-zod 0.7 generated.ts 重生时 view 列要手挂**——验证一遍

**Sub 0d refresh 时同步改**：

1. Step 1.1 `get_weak_points` 改为 `SELECT FROM knowledge_mastery WHERE mastery < 0.4`
2. Step 2.1 `update_ai_delta_mastery` tool **删除**（mastery 不再可写）
3. Step 13 MaintenanceProposeTask `60d 无访问` 查询走 `knowledge_mastery.last_active_at`

**Sub 1 / 其他 plans**：跟随 sub-0d。

---

## 与其它 ADR 关系

- **ADR-0006 v2** —— 本 ADR 是它"events 是真相"原则的延伸应用。
- **ADR-0010**（mesh）—— mesh edge 提议时的 reasoning（"近 30 天错答 78%"）数据来源于 `knowledge_mastery` view + 聚合查询。
- **ADR-0011**（tool-use / chip / edge events）—— `query_knowledge` tool 调用本 view 拿 mastery。
- **ADR-0007**（单用户）—— view 当前不带 user_id，多用户来时 retrofit。

---

## 一句话总结

> **mastery 不是状态，是聚合摘要——所以它住 view，不住列。**
