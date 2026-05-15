# Phase 1c Brainstorm — Encounter / Session 抽象 + UI 闭环

**Date**: 2026-05-14
**Status**: brainstorm（不是 plan，不是 spec）—— 待 grill → spec → plan
**Origin**: `docs/superpowers/audits/2026-05-14-phase1-pre-1c-audit.md`

---

## 为什么现在做（why-now）

Sub 0c 即将收尾（async lane + Tencent Mark Agent）。Sub 0d 已规划（agent layer 整理）。但**两个 sub 之间的真空地带藏着项目最大的两个问题**：

1. **UI 还没动过**——所有后端逻辑在 server 层完备，用户看不到一行
2. **架构隐含"错题→改对"范式**——`mistake` / `question` / `subject` / `FSRS` / `OCR` 五个核心抽象都暗中假设这个范式，与"通用学习框架"愿景矛盾

**这两个问题耦合**：

- 没 UI → 不知道架构对错（设计反馈失联）
- 错题范式锁死 → UI 长成"错题应用"，难再泛化

Phase 1c 试图同时啃这两个。

**先做 Sub 0d 还是 Phase 1c？** 倾向先 1c：
- Sub 0d 是 agent layer 内部整理，不影响"用户能不能用"
- 1c 完成后，0d 的 Provider Manager / 多 task 才有真实的 use case 验证
- 1c 期间产生的设计反馈会**重塑** 0d 需要建什么

---

## 方向

### R1 — `encounter` 替换 `mistake` 为 first-class

**现状**：`mistake` 是顶级实体，挂在 `question` 上。

**新形态**：

```
encounter（学习者与材料的一次交互）
  ├─ outcome: 'wrong' | 'right' | 'exposed' | 'created' | 'drilled' | 'reviewed'
  ├─ material_ref: question_id?, artifact_id?, source_document_id?, free_text?
  ├─ knowledge_ids: []
  ├─ evidence: { user_input, ai_judgment?, cause?, ... }
  └─ scheduled_for_retrieval: boolean
```

- `mistake` 退化成 `encounter where outcome = 'wrong'` 的视图（或表名继续存在，行为收窄）
- FSRS 调度的不是 `mistake`，而是 `encounter where scheduled_for_retrieval = true`
- 知识图谱挂的不是 mistake，而是 encounter

**unlock 的事**：

- 只是"读过没考过"也可以入库（`outcome='exposed'`）
- "我做了一道练习题做对了"也能进知识图（`outcome='right'`）
- "我写了一篇翻译"也可以挂知识点（`outcome='created'`，linked to artifact）

**需要 grill**：

- 现有 mistake 表要重命名 / 保留 / 视图化？三选一各有代价
- "scheduled_for_retrieval" 默认值如何？所有 encounter 都进 FSRS 还是只一部分？
- evidence schema 怎么承载这么多 outcome 类型而不变成"什么都能装"的 jsonb

### R5 — `learning_session` 通用 envelope

**现状**：只有 `ingestion_session`，其他 session（review / agent conversation）是隐式状态机。

**新形态**：

```
learning_session
  ├─ type: 'ingestion' | 'review' | 'tutor' | 'explore' | 'create' | 'conversation'
  ├─ status: state machine（每种 type 自己一套）
  ├─ timeline: linked job_events / encounters
  ├─ summary_md: AI 生成（CONTEXT.md "会话总结"概念落地）
  └─ goal_id?: 关联到某个学习目标（如未来加 goal trail）
```

- 现有 `IngestionSession` 模块（ADR-0005）退化为 `LearningSession` 的一个子状态机
- "我今天做了什么"在 UI 上的答案就是 `learning_session WHERE created_at >= today`
- agent_sessions（ADR-0004）变成 `learning_session WHERE type IN ('tutor', 'conversation')`

**需要 grill**：

- 6 种 type 是否都一开始就建？还是先 ingestion + review，其他延后？
- 状态机如何**多态**——每 type 自己一套 enum 还是统一？
- ADR-0005 刚定的 "IngestionSession 单一所有者" 如何顺势演化成 LearningSession 多态？

### UI 闭环（minimal viable）

不试图一次建完整 UI；只建**让架构反馈能被听见**的最小切片：

```
1. Capture（入口）
   - 拍照 + 上传（已有 API）→ ingestion session 启动 SSE
   - [拓展点：粘贴 / 文件 / 录音 —— R2 多模态铺路]

2. Inbox（待整理）
   - SSE-driven 实时显示抽取进度
   - 块编辑、合并、拆分、归属调整
   - 一键 import 或 "Mark as exposed-only"（R1 unlock 后）

3. Review（已有逻辑）
   - FSRS due queue
   - 一道题界面：prompt → 答 → judge → 反馈（呈现 cause！）

4. Knowledge tree（浏览）
   - 只读：看自己的知识图谱长什么样
   - 入口：进入一个节点 → 看挂在它下面的 encounters

5. Session history
   - "今天 / 这周做了什么"——session summaries 列表
```

**delibrately out-of-scope**：

- 多 subject 切换（Phase 2）
- Tutor 模式 / Coach 模式（待 R8）
- Goal trail（R4）
- Mobile-native 表现（先 web）

---

## 待 grill 的开放问题（最重要的部分）

### Q1: R1 实施粒度——**rename / 视图 / 表替换**？

- **(a) Rename in place**：把 `mistake` 表改名 `encounter`，加 `outcome` 列，老数据 outcome='wrong'。**最干净、最伤筋动骨**。
- **(b) 新增 `encounter` 表，`mistake` 保留**：双表共存期，逐步迁移。**伤痕少、二元性长期存在**。
- **(c) `encounter` 作为视图（VIEW）**：mistake 物理表不动，encounter 是 SELECT。**最保守、长期束缚**。

### Q2: UI 优先 vs schema 优先

- **UI 先**：用现有 schema（mistake-centric）建 UI；架构反馈到位后再迁
  - 优点：快、能立刻看到东西
  - 缺点：UI 代码会绕着旧 schema 长，迁移时改 UI
- **Schema 先**：R1 落地（encounter 抽象）+ R5 部分落地，然后 UI
  - 优点：UI 长在对的形状上
  - 缺点：schema 迁移本身没 UI 反馈，可能走偏

**倾向**：**先小切片 UI**（review 页 + inbox 列表）用现有 schema → 立刻拿到反馈 → 再做 schema 迁移 → 再扩 UI。

### Q3: 多模态 ingestion（R2）何时进？

- Sub 0c 即将固化 Tencent OCR 作为唯一抽取路径
- 多模态需要"source plugin"抽象，Tencent 降级为 image plugin 的一种
- **如果 Sub 0c 刚落地就推翻其单 source 假设，会非常吵**
- 但**如果 Phase 1c 不在抽象上铺路**，未来要加视频 / 音频时 Sub 0c 的所有契约都得重谈

**倾向**：Phase 1c 在 IngestionSession 模块加 `source_kind` 字段（image / pdf / audio / ...），仅实现 image，其余 throw not-implemented。**不**做 multi-source 抽象，但留口子。

### Q4: goal trail（R4）现在做还是延后？

R4 引入 `goal` / `plan` / `progress` 三表，是"从工具到框架"的标志。但：

- 没 UI 时，goal 是个抽象概念，无法验证用户接不接受
- 加 goal 会拉长 Phase 1c

**倾向**：**延后**。先让用户用上看着像"工具"的版本，等数据进来再决定要不要 goal 层。

### Q5: 单用户 vs 多用户

整个架构都是单用户（`x-internal-token` middleware）。"通用学习框架"暗示多用户。但：

- 加 user_id 是不可逆的 schema 改动
- 单用户假设让所有 query 简单 50%
- 个人工具不需要多用户

**倾向**：**保持单用户**，明文记入 ADR。如果未来要多用户，认了"破坏性 migration"代价。

---

## 风险

1. **mistake → encounter 迁移触面巨大**——`mistake` 在 schema、AI prompts、route handlers、tests、imports 等几十处。粗估 3-5 天单人。
2. **UI 是新栈**——`src/ui/` 空目录，React 19 + Tailwind v4 + Zustand + TanStack Query + Next.js App Router 全是新的（虽然 deps 已装）。第一份 UI plan 要建组件库 + 数据 fetch 模式 + 状态管理约定。
3. **Sub 0c 仍在飞**——同时改两个方向（async lane + encounter 抽象）容易冲突。Phase 1c 应**严格等 Sub 0c merge 后**才动 schema。
4. **设计反馈缺失风险**——没有真用户用过的产品，我对"通用学习框架"的判断也是猜。**最大的实验是把 UI 推到真实使用**，然后用真实数据驱动 R1 / R5 / R2 / R4 的优先级。

---

## 下一步

1. 用户 grill 这份 brainstorm，定 Q1-Q5 答案
2. 转换 → `docs/superpowers/specs/2026-05-15-phase1c-design.md`
3. 拆 → `docs/superpowers/plans/2026-05-15-phase1c-*.md`（多 PR）
4. 如果 R1 / R5 拍板，起 ADR-0006（encounter）+ ADR-0007（learning_session）

**Sub 0c 不动**——它的 IngestionSession 模块（ADR-0005）就是 Phase 1c R5 演化路径的起点，没浪费。
