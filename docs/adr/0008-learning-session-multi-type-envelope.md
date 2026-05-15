# LearningSession — IngestionSession 演化为多态 session envelope

**决策**：ADR-0005 的 `src/server/ingestion/session.ts` 演化为 `src/server/session/`（多态 LearningSession 模块）。`learning_session` 表替代 `ingestion_session` 表，加 `type` 列承载多种会话子类型：`ingestion | review | tutor | explore | create | conversation`。每种 type 有独立的 status 状态机，由 LearningSession 多态模块内部分支。

**ADR-0005 的 single-owner invariant 完整保留**：所有 `learning_session.status` 写入只能通过模块的 transition 函数；route / handler 不允许直接 UPDATE。本 ADR 在更大范围内延伸该 invariant。

Phase 1c.1 实现 `type='ingestion'`（从 IngestionSession 平移而来）和 `type='review'`（新建最小状态机：`started → completed | abandoned`）。其余四类（`tutor / explore / create / conversation`）**enum 占位、行为延后**——等真实需求触发再实现状态机分支。

---

## 理由

1. **session 是通用学习概念**。CONTEXT.md "会话总结"词条暗示 ingestion 不是唯一 session 类型；review / tutor / explore 都是 session（每次坐下学习就是一次 session）。
2. **multi-type envelope 比 N 张 `*_session` 表干净**。若让 review 自己一张 `review_session`、tutor 一张 `tutor_session`，会出现"如何查询'今天我做了什么'"这种跨表问题；single table + `type` 列把 session 列表 / 总结 / goal 挂接 集中在一处。
3. **draft 期一次做对**（2026-05-14 grill）：等 1c.3 再做 R5 = 等不存在的反馈；并入 1c.1 一次拍板。
4. **ADR-0005 的 single-owner 已经验证**：在 IngestionSession 上落地的 invariant 现在拓展到全 session type，是已有结构的自然演化，不是 greenfield 设计。

---

## 接受的代价

- **模块变胖**：6 种 type，即使只实现 2 种，per-type 状态机分支 + per-type Zod 守护让 `src/server/session/` 比 `src/server/ingestion/session.ts` 大几倍。**接受**——见 ADR-0005 已经预演的"模块按 transition cluster 拆"路径。
- **`ingestion_session` → `learning_session` 数据迁移**：要保留所有现有 ingestion 数据 + 状态。**接受**——drizzle migration + 测试 round-trip 覆盖。
- **enum 占位 type 未实现**：客户端 / agent 不能依赖 `tutor / explore / create / conversation` 任何字段——只是 `type=value`，行为是空。**接受**——明文 enum 让未来扩展不重谈 schema 契约（per "draft 期一次做对" 原则）。

---

## 触发重新评估的条件

- session type 增长到 ≥8 种 → 拆 `src/server/session/<type>.ts` 子模块（保持 single-owner aggregator）
- 出现 cross-type query 性能问题 → 加部分索引或物化视图，**不**重新分表
- 用户行为暗示 review session 与 ingestion session 应该耦合（例：在 review 时拍照打卡新题）→ 加 session relationship 表，不破坏单 session 多态

---

**演化关系：**
- **演化（partial supersede）ADR-0005**：IngestionSession single-owner invariant 完整保留并扩大到全 session type；ADR-0005 仍作为 ingestion 子状态机的规范有效（同一文件、同一组方法，只是住进更大的 namespace）。
- **相关 ADR-0006**：encounter 与 learning_session 是 Phase 1c.1 双 first-class entity——相互独立但常一起被查询（例："今天的 review session 里答错了哪些 encounter"）。
