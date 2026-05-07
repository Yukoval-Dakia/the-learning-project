# Dreaming 与 Maintenance（两条 AI 主动 lane）

AI 主动产出走两条平行 lane，UI 模式一致：建议列表 + reason 展示 + 一键 approve / dismiss / batch。

---

## Dreaming（生产 lane）

| 产出 | 类别 | 触发 | 去向 |
| --- | --- | --- | --- |
| 每日总结 | 日报 | 自动 1/day | 阅读流 |
| 每日 quiz（1~3 题，≤3min） | 日报 | 自动 1/day | 任务流（详见 [`quiz.md`](quiz.md)） |
| 题目推荐（自主） | 填充 | dreaming 不定期 | 待审核区 |
| 题目推荐（手动） | 即时 | 用户按钮 | 直接进待学习列表 |
| 知识点建议 | 填充 | dreaming 不定期 | 待审核区 |
| Note section 更新建议 | 填充 | living note 触发器（见 [`notes.md`](notes.md) § 9） | 待审核区 |

**输入信号**：知识图谱邻接 + 薄弱点 + 久未触达 + 兴趣声明，四种皆用。

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

---

## 统一原则

**所有 AI-proposable 的破坏性操作必须 reversible 一段时间**。这是给 AI 推荐的「试错预算」——能撤回，你才敢相信它的推荐质量；如果一推就是不可逆操作，你会本能拒绝所有推荐，整个 lane 就废了。

---

## 调度

两条 lane 都走 dreaming batch（夜间）：
- 异步 batch（50% 折扣）
- prompt caching（知识图谱作稳定 prefix）
- 一次产出，第二天用户醒来批量审

成本控制详见 [架构基础 § 3.3](../architecture.md#33-成本控制)。

---

## 模块特定的待决策

- 归档触发的久未触达阈值 → **已定**：90 天
- dreaming 接受率阈值 → **已定**：滚动 30 天 < 30% 触发砍信号
- soft delete retention → **已定**：30 天
- 每日 quiz 的题源混合比例（FSRS 到期 / 变式 / 随机）— Phase 2 跑数据后调
- 待审核区是否分类显示（按产出类型 / 按提议时间）— Phase 2 UX 决策
- 接受 / dismiss 操作是否影响 dreaming 后续推荐（个性化 vs 简洁）— Phase 2+ 决策
- Dreaming 与 Living note 触发器的执行顺序 / 去重 — 同一夜 batch 内统一调度，重复 propose 用户 dismiss 即可
