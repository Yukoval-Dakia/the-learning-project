# Dreaming 与 Maintenance（两条 AI 主动 lane）

AI 主动产出走两条平行 lane，UI 模式一致：建议列表 + reason 展示 + 一键 approve / dismiss / batch。

---

## 0. 实施现状（2026-05-18）

> 主动 lane 的底座已经从旧设计收敛到 pg-boss + event proposal。当前已落地的是知识点/关系提议、note generation、variant draft、review session summary 等具体 job；更完整的 dreaming/coach/weekly review 仍是后续能力。

| 设计概念 | 现状 |
|---|---|
| Proposal landing | ✅ `event(action='propose', actor_kind='agent')`；旧 proposal 表已 DROP |
| pg-boss worker / schedules | ✅ `scripts/worker.ts` + `src/server/boss/handlers.ts` |
| Knowledge proposal | ✅ `knowledge_propose_nightly` 写 `subject_kind='knowledge'` proposal |
| Knowledge edge proposal | ✅ `knowledge_edge_propose_nightly` 写 `subject_kind='knowledge_edge'` proposal |
| Note generation | ✅ `note_generate` job 填 atomic artifact sections |
| Variant generation | ✅ `variant_gen` job 写 draft `question(source='mistake_variant')` |
| Review session summary | ✅ `session_summary` job |
| Maintenance lane 6 个 action（archive/merge/etc.） | ❌ 仍是 Phase 2+ |
| Broader dreaming / coach / weekly review | ❌ 仍是 Phase 2+ |
| Accept / dismiss UI | ✅ `/knowledge` mesh proposal strip + `/api/knowledge/edges/proposals/[id]` accept-handler |
| 用户手工 knowledge_edge | ✅ `/knowledge` "新建关系" form，直接 POST `/api/knowledge/edges` |

**目前能看到 propose / mesh 接受动作的入口**：
- `/knowledge` 树 + Graph + 节点抽屉里的 "AI 建议关系" 段（rate/accept/reverse/change_type/dismiss）
- `/knowledge` "新建关系" 按钮（手工跳过 propose）

下面 §1+ 描述的是 lane 产品意图；具体调度以 pg-boss worker 为准。

---

## Dreaming（生产 lane）

| 产出 | 当前状态 / 目标形态 | 触发 | 去向 |
| --- | --- | --- | --- |
| 每日总结 | 目标 | 自动 1/day | 阅读流 |
| 每日 quiz（1~3 题，≤3min） | 目标 | 自动 1/day | 任务流（详见 [`quiz.md`](quiz.md)） |
| 题目推荐（自主） | 目标 | dreaming 不定期 | 待审核区 |
| 题目推荐（手动） | 目标 | 用户按钮 | 直接进待学习列表 |
| 知识点建议 | ✅ 已有 event proposal | pg-boss schedule / user-triggered path | `/knowledge` proposal UI |
| 知识关系建议 | ✅ 已有 event proposal | pg-boss schedule | `/knowledge` mesh proposal UI |
| Note section 更新建议 | 目标 | living note 触发器（见 [`notes.md`](notes.md) § 9） | 待审核区 |
| **LearningItem 完成提议** | 目标 | mastery>0.8 持续 14 天 ∨ 关联 check 全过 ∨ 7 天错 0 | 待审核区，approve 后创建 CompletionEvidence(path=ai_propose) |
| **LearningItem 复学提议** | 目标 | done → resting 后 mastery 衰减 < 0.5 持续 N 天 | 待审核区，approve 后 status 回 pending |

**输入信号**：知识图谱邻接 + 薄弱点 + 久未触达 + 兴趣声明 + LearningRecord（Phase 2+ 用 open_question / reflection / insight 类作为额外输入），多种综合用。

**健康指标**：dreaming 推荐的接受率。**滚动 30 天 < 30% 触发砍信号**或调 prompt。

### 每日 quiz 设计约束

- **1~3 题，3 分钟内做完**（不是 5+，否则次日不会想点开）
- 题源混合：
  1. 当天 FSRS 到期错题（占大头）
  2. 薄弱知识点变式题
  3. 1 道随机抽样（防止只刷弱点）
- 题目都是 `Question` 实例（`source: daily`），由 `QuizGenTask` 产出，用户答时走 [`quiz.md`](quiz.md) 的 JudgeRouter

---

## Maintenance（维护 lane）

| 操作 | AI 推荐时机 | 安全网 |
| --- | --- | --- |
| 删错题 | 重复 / 录入失败 / 孤儿 | soft delete，**30 天可恢复** |
| 合并节点 | 节点名相似 / 关联错题/artifact 重叠率高 | canonical 节点保留 `merged_from[]`，可拆回 |
| 归档节点或学习项 | 久未触达（**默认 90 天**） | snapshot + 可回滚 |
| 重置 FSRS state | 用户标记「我忘了」 | snapshot |
| 重置 mastery | 推翻 AI 累积估计 | snapshot |
| 归档 atomic / hub note | 节点 90 天没触达 | snapshot |
| 归档 LearningItem | 90 天未触达 | snapshot |

---

## 统一原则

**所有 AI-proposable 的破坏性操作必须 reversible 一段时间**。这是给 AI 推荐的「试错预算」——能撤回，你才敢相信它的推荐质量；如果一推就是不可逆操作，你会本能拒绝所有推荐，整个 lane 就废了。

---

## 调度

两条 lane 的实施栈详见 [`architecture.md § 5.6`](../architecture.md#56-dreaming--maintenance-实施栈)：当前是 self-hosted Node worker + pg-boss + Postgres。

成本控制详见 [`architecture.md § 5.3`](../architecture.md#53-成本控制)。

---

## 模块特定的待决策

- 归档触发的久未触达阈值 → **已定**：90 天
- dreaming 接受率阈值 → **已定**：滚动 30 天 < 30% 触发砍信号
- soft delete retention → **已定**：30 天
- 每日 quiz 的题源混合比例（FSRS 到期 / 变式 / 随机）— Phase 2 跑数据后调
- 待审核区是否分类显示（按产出类型 / 按提议时间）— Phase 2 UX 决策
- 接受 / dismiss 操作是否影响 dreaming 后续推荐（个性化 vs 简洁）— Phase 2+ 决策
- LearningItem 完成提议被 dismiss 后的冷却期（默认 7 天）是否需要差异化
- 复学提议触发的 mastery 阈值（默认 0.5，runtime 调）
- LearningRecord 喂 dreaming 信号的具体方式（Phase 2+ 决策：open_question 类直接 propose 答疑 / reflection 类喂 weekly report 等）
