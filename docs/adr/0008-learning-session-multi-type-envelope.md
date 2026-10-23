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

---

## 修订（2026-05-15）：agent_sessions / agent_messages 吸收进 learning_session + event

ADR-0006 v2（event-driven 核）落定后，本 ADR 的 `type` enum 中 `'conversation'` 不再需要独立的 agent_sessions / agent_messages 表（ADR-0004 原规划）。Copilot 对话即：

- 一个 `learning_session(type='conversation', status='active')` 容器
- 多行 `event(actor_kind='user'|'agent:copilot', action='experimental:ask_copilot'|'experimental:explain'|'rate'|'generate', subject_kind='event'|'artifact')`

好处：
- 复用 event 表的事件链 / 审计 / 重放能力
- 避免 agent_sessions 表与 learning_session 双轨
- Copilot 调 propose/generate 等 tool 时直接写 event，与后台 Backend Purpose Agent 共享 schema

Sub 0d plan 之前规划的 agent_sessions / agent_messages 表已**作废**——Sub 0d refresh 时按此调整。

## 归属修订（2026-10-23，YUK-1570）

`learning_session` 继续共用一张表，状态操作按 type 保留唯一业务 owner。type=ingestion 的现役状态命令归 `src/capabilities/ingestion/server/session-lifecycle.ts`，DOCX 文本初始化归同域 `docx/text-session-lifecycle.ts`；仅两者消费的 extract 事件写入与 DOCX omission 事实归同域叶子模块。其余 type 及共享 `server/session/guards.ts` 保持原位，旧混合入口退出 Ingestion 导出。

这次只归位已有完整操作。`markSessionPackageFailed` 的既有补偿也随状态 owner 迁入：已有产出时保留状态并尽力记录 provenance，否则沿原分支标记失败。它原本没有的事务、锁、事件和 type 筛选均不补加。各操作的 Db/Tx 合同、队列发送方式、调用顺序及付费/恢复边界保持；不能把历史“同事务”的描述外推到接受裸 Db 的所有调用。

录入 caller 直接消费同域实现，不新增跨能力状态写接口。共享题块事实继续调用已有 kernel 操作。本修订不授权 #2037 尚在途的 Db→Db|Tx 签名变化；该片后续在新 canonical 路径接线，沿各自原批准范围交付。
