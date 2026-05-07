# 待学习列表（LearningItem）

> 见 [架构基础](../architecture.md) 了解 `LearningItem` / `CompletionEvidence` schema。
> Quiz 通过路径详见 [`quiz.md`](quiz.md)。

新一等公民——不是错题、不是知识点、不是复习队列，是「还没学 / 不熟，要去做」的项。

---

## 四个来源汇入

```
错题归因后        ─┐
主动输入          ─┤
学习意图声明      ─┼→ 待学习列表 (LearningItem)
AI dreaming 推荐  ─┘   (dreaming 来源经待审核区)
```

| 来源 | 触发 | 是否经待审核 |
| --- | --- | --- |
| `mistake` | 归因发现缺口时自动 | 否 |
| `manual` | 用户手动加学习目标 / 材料 | 否 |
| `learning_intent` | 用户声明 "我想学 X" | 否（但同步触发 Note 生成 pipeline） |
| `ai_dream` | dreaming 主动 propose | 是（先进待审核区） |

学习意图声明（"我想学氧化还原反应"）是主动输入的特殊子类——不只创建 LearningItem，还触发 Note Artifact 生成 pipeline（见 [`notes.md`](notes.md)）。

## 完成判定（多路径）

不强制 quiz 才能 done。三条路径都接受：

| 路径 | 触发 | AI 角色 |
| --- | --- | --- |
| 用户自我宣告 | 用户点「完成」 | 看证据：足则 done；不足时**软反问**「证据不足，要做个 quick check 吗？」，但**保留强制覆盖**按钮（强制时 evidence_json 标 `user_overrode_low_evidence=true`） |
| AI 主动提议 | 满足任一：mastery>0.8 持续 14 天 ∨ 关联 check 全过 ∨ 该知识点 7 天错 0 | propose「我觉得你已掌握」，用户确认 |
| Quiz 通过 | 用户选择走严格路径 | 出题 + 评分（详见 [`quiz.md`](quiz.md)）；通过 = 所有关联 Question 的 effective Judgment.verdict==correct，base mastery 硬跳升到 ≥ 0.7 |

## 优先级算法（Hybrid）

UI 默认按 score 降序，用户可手动 pin 顶部或 dismiss。

```
score = w1 · urgency       (due 临近度)
      + w2 · weakness      (1 − mastery)
      + w3 · recency       (最近错题密度)
      + w4 · user_pin      (用户置顶 boost)

priority = if user_pinned: HIGH (always top)
           else: ai_score
```

权重待 Phase 2 跑数据调。

## CompletionEvidence

所有路径都产生 `CompletionEvidence` 记录。每条 evidence 包含：

- 触发路径（`self_declare` / `ai_propose` / `quiz_pass`）
- `evidence_json`：AI 看到的信号快照
  - 近期错题正确率
  - 复习按时率
  - artifact 触达情况（哪些 atomic note 被读过、check 是否通过）
  - 对话痕迹（提到该知识点的次数与上下文）
  - quiz_pass 路径下：所关联 Question 的 Judgment 列表
- `user_overrode_low_evidence?`: 仅 self_declare 强制覆盖时为 true
- `decided_at`

可回放、可质疑。三个月后能问"为什么当时判 done"，看 evidence 即可。

## Schema

`LearningItem` / `CompletionEvidence` 详见 [架构基础 § 五](../architecture.md#五数据模型骨架)。

---

## 模块特定的待决策

- AI 主动提议触发阈值 → **已定**：mastery>0.8 持续 14 天 ∨ 关联 check 全过 ∨ 7 天错 0
- AI 反问 vs 阻断 → **已定**：软反问 + 保留强制覆盖
- 优先级算法 → **已定**：Hybrid（用户 pin + AI score），具体权重 Phase 2 调
- LearningItem 完成后是否归档 / 保留多久 — Phase 2 决策（默认建议 done 后保留 90 天显示，归档后仍可搜索）
