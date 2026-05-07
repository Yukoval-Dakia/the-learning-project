# 学习进度追踪

> 见 [架构基础](../architecture.md) 了解 `Knowledge` / `Session` / `WeeklyReview` schema。
> Quiz 评分喂 mastery 详见 [`quiz.md`](quiz.md)。

---

## 掌握度分两层

- **Base mastery（确定性）**：错题、复习、quiz 通过等事件触发，公式驱动。事实层。
- **AI delta（覆盖层）**：AI 基于额外信号 propose 调整。可见、可一键回滚。

最终展示 `mastery = base + delta`，但任何时候都能看到拆分。

**为什么分两层**：底层不可篡改的事实给三个月后还能信任的根；覆盖层给 AI 灵活性又不污染数据。

### Base mastery 公式

```
base_mastery = max(
  fsrs_retrievability,        # FSRS 自带 0~1，已含遗忘曲线
  quiz_pass_floor             # 通过 quiz 触发硬下限 = 0.7
)
```

**理由**：FSRS 已经把"时间衰减 + 复习强化"做好了，不重复造轮子。Quiz 通过给硬下限 0.7（不是 raw 分数），是「掌握度的硬触达」事件。

### Hub 节点的 mastery 聚合

Hub 节点的 mastery 是 atomic 子节点的加权平均：

```
hub_mastery = Σ(weight_i × atomic_mastery_i) / Σ(weight_i)
weight_i    = mistake_count_i + learning_item_count_i + 1   # +1 防 0 权
```

**理由**：投入越多的子节点权重越大，反映真实学习重心，不是均匀稀释。

### AI delta 输入信号

AI 在以下场景 propose delta：
- 对话中用户多次正确表达 → +
- 用户主动声明「这块我已经会了」 → +（但要看证据）
- 多个 atomic note 的 embedded check 都过 → +
- 用户长期没碰 → ±0（衰减由 base 处理，AI 不重复）

**单次最大幅度 ±0.15**（防止 AI 过度调整）。每次 AI propose 必须显示推理；用户可一键回滚。

## 行为层（辅助）

- 学习会话记录（番茄 / 自由计时）
- 连续打卡热力图
- 复习按时率

只观察行为习惯，不喧宾夺主——**不要把"刷时长"当掌握度信号**。行为信号只用作 dreaming / 周复盘的输入。

## 周复盘

每周 AI 自动生成（`WeeklyReportTask`）：
- 本周薄弱点 Top N
- 反复错的题
- 下周建议优先攻的知识点
- 一段「人话总结」

输出：
- 一个 `WeeklyReview` 记录
- 推到阅读流（不是任务流，不强制处理）
- 可关联到 LearningItem 的下周建议

## 与其他模块的接口

| 接口 | 方向 | 说明 |
| --- | --- | --- |
| 错题事件喂 base | mistake → progress | FSRS retrievability 自动驱动 |
| Note embedded check 通过 | notes → progress | 加 base（按知识点分摊） |
| **Quiz Judgment.score 喂 base** | **quiz → progress** | **按 question.knowledge_ids[] 分摊** |
| Quiz 通过硬跳升 | learning-item → progress | quiz_pass 路径触发 max(base, 0.7) |
| AI delta propose | dreaming → progress | 走 propose 路径，可回滚，单次 ≤ ±0.15 |
| 周报输出 | progress → reading flow | dreaming-like 推送 |

---

## 模块特定的待决策

- AI delta mastery 单次最大幅度 → **已定**：±0.15
- base mastery 公式 → **已定**：`max(fsrs_retrievability, quiz_pass_floor=0.7)`
- Hub mastery 聚合 → **已定**：按 `(错题数 + 学习项数 + 1)` 加权平均
- 周复盘 prompt 结构与"人话"风格 — Phase 2 第一版跑出来再迭代
- 学习会话的自动 vs 手动启动（移动端尤其敏感）— Phase 1 用手动，Phase 2 评估自动检测
- 跨知识点 quiz 的 mastery 分摊策略（按权重 / 等分）— 默认等分，runtime 调
