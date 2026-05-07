# Dreaming 与 Maintenance（两条 AI 主动 lane）

AI 主动产出走两条平行 lane，UI 模式一致：建议列表 + reason 展示 + 一键 approve / dismiss / batch。

---

## Dreaming（生产 lane）

| 产出 | 类别 | 触发 | 去向 |
| --- | --- | --- | --- |
| 每日总结 | 日报 | 自动 1/day | 阅读流 |
| 每日 quiz（1~3 题，≤3min） | 日报 | 自动 1/day | 任务流 |
| 题目推荐（自主） | 填充 | dreaming 不定期 | 待审核区 |
| 题目推荐（手动） | 即时 | 用户按钮 | 直接进待学习列表 |
| 知识点建议 | 填充 | dreaming 不定期 | 待审核区 |

**输入信号**：知识图谱邻接 + 薄弱点 + 久未触达 + 兴趣声明，四种皆用。

**健康指标**：dreaming 推荐的接受率。持续三月低于 30% 要砍信号或调 prompt。

## Maintenance（维护 lane）

| 操作 | AI 推荐时机 | 安全网 |
| --- | --- | --- |
| 删错题 | 重复 / 录入失败 / 孤儿 | soft delete，30 天可恢复 |
| 合并节点 | 节点名相似 / 关联错题/artifact 重叠率高 | canonical 节点保留 `merged_from[]`，可拆回 |
| 归档节点或学习项 | 久未触达（默认 90 天） | snapshot + 可回滚 |
| 重置 FSRS state | 用户标记「我忘了」 | snapshot |
| 重置 mastery | 推翻 AI 累积估计 | snapshot |

## 统一原则

**所有 AI-proposable 的破坏性操作必须 reversible 一段时间**。这是给 AI 推荐的「试错预算」——能撤回，你才敢相信它的推荐质量；推错就不可逆，会本能拒绝所有推荐，整个 lane 就废了。

---

## 模块特定的待决策

- 归档触发的久未触达阈值（默认 90 天）
- dreaming 接受率的阈值与窗口（默认三月低于 30% 调信号）
- soft delete 的 retention 期（默认 30 天）
- dreaming 与 Living note 触发器（见 [`notes.md`](notes.md) § 9）的执行顺序与去重
