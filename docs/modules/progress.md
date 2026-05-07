# 学习进度追踪

> 见 [架构基础](../architecture.md) 了解 `Knowledge` / `Session` / `WeeklyReview` schema。

---

## 掌握度分两层

- **Base mastery（确定性）**：错题、复习、quiz 通过等事件触发，公式驱动。事实层。
- **AI delta（覆盖层）**：AI 基于额外信号 propose 调整（「这周三次提到这个点都答得很顺，建议 +0.15」）。可见、可一键回滚。

最终展示 `mastery = base + delta`，但任何时候都能看到拆分。

**为什么分两层**：底层不可篡改的事实给三个月后还能信任的根；覆盖层给 AI 灵活性又不污染数据。

## 行为层（辅助）

- 学习会话记录（番茄 / 自由计时）
- 连续打卡热力图
- 复习按时率

只观察行为习惯，不喧宾夺主——行为不直接喂 mastery，只用作 dreaming / 周复盘的输入信号。

## 周复盘

每周 AI 自动生成（`WeeklyReportTask`）：
- 本周薄弱点 Top N
- 反复错的题
- 下周建议优先攻的知识点
- 一段「人话总结」

---

## 模块特定的待决策

- AI delta mastery 单次最大幅度（防止 AI 过度调整，建议 ±0.2 上限）
- base mastery 的具体公式（FSRS retrievability + quiz 通过 + 复习按时率的加权）
- 周复盘的具体 prompt 结构与 skill 抽离时机
- 跨知识点的 mastery 聚合（hub 节点的 mastery 怎么从 atomic 子节点算）
