# 待学习列表（LearningItem）

> 见 [架构基础](../architecture.md) 了解 `LearningItem` / `CompletionEvidence` schema。

新一等公民——不是错题、不是知识点、不是复习队列，是「还没学 / 不熟，要去做」的项。

---

## 四个来源汇入

```
错题归因后        ─┐
主动输入          ─┤
学习意图声明      ─┼→ 待学习列表 (LearningItem)
AI dreaming 推荐  ─┘   (dreaming 来源经待审核区)
```

学习意图声明（"我想学氧化还原反应"）是主动输入的特殊子类——不只创建 LearningItem，还触发 Note Artifact 生成 pipeline（见 [`notes.md`](notes.md)）。

## 完成判定（多路径）

不强制 quiz 才能 done。三条路径都接受：

| 路径 | 触发 | AI 角色 |
| --- | --- | --- |
| 用户自我宣告 | 用户点「完成」 | 看证据，足则 done，不足时反问 |
| AI 主动提议 | 长期信号积累后 | propose「我觉得你已掌握」，用户确认 |
| Quiz 通过 | 用户选择走严格路径 | 出题 + 评分；通过则 base mastery 硬跳升 |

## CompletionEvidence

所有路径都产生 `CompletionEvidence` 记录。每条 evidence 包含：

- 触发路径（`self_declare` / `ai_propose` / `quiz_pass`）
- `evidence_json`：AI 看到的信号快照
  - 近期错题正确率
  - 复习按时率
  - artifact 触达情况（哪些 atomic note 被读过、check 是否通过）
  - 对话痕迹（提到该知识点的次数与上下文）
- `decided_at`

可回放、可质疑。三个月后能问"为什么当时判 done"，看 evidence 即可。

## Schema

`LearningItem` / `CompletionEvidence` 详见 [架构基础 § 五](../architecture.md#五数据模型骨架)。

---

## 模块特定的待决策

- AI 主动提议路径的触发阈值（需要多少证据才主动提议）
- AI 反问 vs 阻断：用户 self_declare 但证据不足时，AI 是软反问（仍可强制通过）还是硬阻断
- LearningItem 的优先级算法（priority 字段如何排序：用户手动 vs AI 自动）
