# 学习进度追踪

> 见 [架构基础](../architecture.md) 了解 `knowledge` / `knowledge_mastery` view / `learning_session` / `study_log` schema。
> Quiz 评分喂 mastery 详见 [`quiz.md`](quiz.md)。

---

## 0. 实施现状（2026-05-17）

> Phase 1 sketch 期的"掌握度双层"模型在 1c.1 Step 1（ADR-0012）拍板转**单层 derived view**。下面 §1+ 还是历史叙述。

| 设计概念 | 现状 | 备注 |
|---|---|---|
| Mastery 双层（base_mastery + ai_delta_mastery） | ❌ DROPped (ADR-0012) | 两列 1c.1 Step 1 同步删除 |
| Mastery derived view (`knowledge_mastery`) | ✅ Phase 1c.1 Step 1 落地 | 30 天指数衰减，权重 attempts/reviews |
| StudyLog 5 kind | ✅ schema + UI (`/study-log`, Cand 3 commit `d279089`) | highlight / insight / question / reflection / observation |
| 学习时间线视图（统一 auto event + StudyLog） | ❌ Phase 2 | 现在 /today KPI strip 是简单聚合，没真 timeline |
| WeeklyReview Cron 跑批 | ❌ Phase 2 | 整个 Dreaming/Maintenance lane 都未跑 |
| 按 cause 差异化复习权重 / mastery 衰减 | ❌ Phase 2 | 跑数据后才决定权重 |
| 周复盘 / Coach Orchestrator | ❌ Phase 3 | `/today` Phase 3 lane 是 disabled stub |

**当前可看进度的 UI**：
- `/today` KPI strip（4 KPI + 3 lane stub） — Phase 1c.2 落地（commit `4eab5f9`）
- `/today` cost ribbon — Phase 1d 接 cost_ledger（commit `6da0fa1`）
- `/knowledge/[id]` per-node mistake 列表
- `/study-log` 5 kind 记录 — Phase 1c.2 Cand 3
- `/events/[id]` 单事件 chain 浏览 — Phase 1d Cand 4a

---

## 1. 掌握度分两层

- **Base mastery（确定性）**：错题、复习、quiz 通过等事件触发，公式驱动。事实层。
- **AI delta（覆盖层）**：AI 基于额外信号 propose 调整。可见、可一键回滚。

最终展示 `mastery = base + delta`，但任何时候都能看到拆分。

**为什么分两层**：底层不可篡改的事实给三个月后还能信任的根；覆盖层给 AI 灵活性又不污染数据。

### 1.1 Base mastery 公式

```
base_mastery = max(
  fsrs_retrievability,        # FSRS 自带 0~1，已含遗忘曲线
  quiz_pass_floor             # 通过 quiz 触发硬下限 = 0.7
)
```

**理由**：FSRS 已经把"时间衰减 + 复习强化"做好了，不重复造轮子。Quiz 通过给硬下限 0.7（不是 raw 分数），是「掌握度的硬触达」事件。

### 1.2 Hub 节点的 mastery 聚合

Hub 节点的 mastery 是 atomic 子节点的加权平均：

```
hub_mastery = Σ(weight_i × atomic_mastery_i) / Σ(weight_i)
weight_i    = mistake_count_i + learning_item_count_i + 1   # +1 防 0 权
```

**理由**：投入越多的子节点权重越大，反映真实学习重心，不是均匀稀释。

### 1.3 AI delta 输入信号

AI 在以下场景 propose delta：
- 对话中用户多次正确表达 → +
- 用户主动声明「这块我已经会了」 → +（但要看证据）
- 多个 atomic note 的 embedded check 都过 → +
- 用户长期没碰 → ±0（衰减由 base 处理，AI 不重复）

**单次最大幅度 ±0.15**（防止 AI 过度调整）。每次 AI propose 必须显示推理；用户可一键回滚。

---

## 2. 行为层（自动事件）

观察学习行为习惯，不喂 mastery 但喂 dreaming / 周复盘信号：

- 学习会话记录（番茄 / 自由计时） → `Session`
- 连续打卡热力图
- 复习按时率
- artifact 触达 + 时长

**关键原则**：行为信号只用作 dreaming / 周复盘的输入，**不直接喂 mastery**——避免"刷时长"成为掌握度信号。

---

## 3. StudyLog（用户主动记录）

学习过程不只是错题。用户做对的题、顿悟的瞬间、未解的疑问、阶段性反思——这些「非错题但值得记录」的内容由 `StudyLog` 承载。

### 3.1 5 种 kind

| kind | 用途 | 例子 |
| --- | --- | --- |
| `highlight` | 标记值得保留的内容 | "这题对了但思路很妙" |
| `insight` | 顿悟瞬间 | "我终于搞懂了为什么 X = Y" |
| `question` | 疑问待解 | "为什么 sin² + cos² = 1 而不是别的？" |
| `reflection` | 阶段性反思 | "这周做错的题集中在 X，可能我对 Y 不熟" |
| `observation` | 一般学习观察 | "做这类题用 method A 比 method B 快" |

### 3.2 关联（多对一）

StudyLog 可挂任意学习对象（一对多关联）：

```
StudyLog
  → knowledge_ids[]?       # 关联知识点（最常见）
  → question_id?           # 可挂题目（含做对的）
  → mistake_id?            # 可挂错题（额外反思，跟 mistake.cause.user_notes 共存）
  → artifact_id?           # 可挂 note / tool 旁批
```

至少关联一个对象，多对一允许（"针对这道错题 + 这个知识点的反思"）。

### 3.3 录入入口

- 错题详情页 "+ 写学习日志"
- 题目页（含做对）"+ 标记"
- Note / atomic 阅读时 "+ 旁批"
- 知识点详情页 "+ 反思"
- 全局快捷入口 "记一笔"

### 3.4 跟 Mistake.cause.user_notes 的区别

| | Mistake.cause.user_notes | StudyLog |
| --- | --- | --- |
| 范围 | 局部，仅错题归因 | 全局，跨学习对象 |
| 用途 | 补充错因分析 | 记录任意学习内容 |
| 数据可发现性 | 错题详情页内 | 时间线 / 反思页 / 跨对象搜索 |

两者共存。

---

## 4. 学习时间线视图

整合所有学习事件 + StudyLog 到时间线（Phase 2 实施）：

```
[自动事件]
- quiz answer (correct / incorrect / partial)
- 复习按时完成 / 失败
- artifact 阅读触达 + 时长
- LearningItem 状态变更（开始 / 完成 / 重学）
- mastery 跳变（如 quiz_pass 触发）
- 错题创建 / appeal 翻盘

[用户主动]
- StudyLog (5 种 kind)
```

**UI 视图**：

```
2026-05-08 14:30  ✅ quiz_pass: "氧化还原反应 - 概念定义"
2026-05-08 14:25  📝 insight (我写的): "电子转移和氧化还原是同一回事"
2026-05-08 14:10  ❌ mistake: 题 q-123（concept 错因）
2026-05-08 13:50  📖 read note: "电子转移机制" (8 分钟)
2026-05-08 12:00  🔄 review: 5 道到期错题，4 对 1 错
```

**过滤维度**：
- 时间范围（今天 / 本周 / 本月 / 自定义）
- 知识点（按节点过滤）
- 事件类型（quiz / 复习 / 错题 / artifact / StudyLog 等）
- 学科（domain）
- 仅 StudyLog（看自己写的反思）

---

## 5. 周复盘

每周 AI 自动生成（`WeeklyReportTask`）：
- 本周薄弱点 Top N
- 反复错的题
- 下周建议优先攻的知识点
- **按 cause 类型统计错题分布**（"本周 60% 错题是 calculation 类，建议加强计算训练"）
- **整合 StudyLog**（用户的 reflection / question 作为 weekly 输入信号）
- 一段「人话总结」

输出：
- 一个 `WeeklyReview` 记录
- 推到阅读流（不是任务流，不强制处理）
- 可关联到 LearningItem 的下周建议

---

## 6. cause 差异化复习权重 / mastery 衰减（Phase 2）

不同错因的复习频率 / mastery 影响不同（详见 [`mistakes.md`](mistakes.md) § 4.4）：

| Cause | 复习频率 | mastery 影响 |
| --- | --- | --- |
| `knowledge_gap` / `concept` | 高 | 大 |
| `calculation` / `reading` / `memory` / `method` | 中 | 中 |
| `expression` / `carelessness` / `time_pressure` | 低 | 小 |
| `other` | 中 | 中 |

具体权重 Phase 2 跑数据后调。

---

## 7. 与其他模块的接口

| 接口 | 方向 | 说明 |
| --- | --- | --- |
| 错题事件喂 base | mistake → progress | FSRS retrievability 自动驱动 |
| Note embedded check 通过 | notes → progress | 加 base（按知识点分摊） |
| Quiz Judgment.score 喂 base | quiz → progress | 按 question.knowledge_ids[] 分摊 |
| Quiz 通过硬跳升 | learning-item → progress | quiz_pass 路径触发 max(base, 0.7) |
| AI delta propose | dreaming → progress | 走 propose 路径，可回滚，单次 ≤ ±0.15 |
| 周报输出 | progress → reading flow | dreaming-like 推送 |
| **StudyLog 喂时间线** | StudyLog → progress | 用户主动记录可见于时间线 |
| **StudyLog 喂 dreaming** | StudyLog → dreaming (Phase 2+) | 未解 question / reflection 作为 dreaming 输入 |
| **学习时间线整合** | progress ← all modules | 时间线视图整合所有事件 + StudyLog |

---

## 模块特定的待决策

### 已定

- AI delta mastery 单次最大幅度 → ±0.15
- base mastery 公式 → `max(fsrs_retrievability, quiz_pass_floor=0.7)`
- Hub mastery 聚合 → 按 `(错题数 + 学习项数 + 1)` 加权平均
- 行为信号不直接喂 mastery → 仅用作 dreaming / 周复盘输入
- **StudyLog 5 种 kind**（highlight / insight / question / reflection / observation）
- **StudyLog 多对一关联**（knowledge / question / mistake / artifact 任一/多个）
- **学习时间线视图**（Phase 2 整合自动事件 + StudyLog）
- 复习权重 / mastery 衰减按 cause 差异化（具体权重 Phase 2 跑数据后调）

### 待 push

- 周复盘的具体 prompt 结构与"人话"风格 — Phase 2 第一版跑出来再迭代
- 学习会话的自动 vs 手动启动（移动端尤其敏感）— Phase 1 用手动，Phase 2 评估自动检测
- 跨知识点 quiz 的 mastery 分摊策略（按权重 / 等分）— 默认等分，runtime 调
- 时间线视图的默认时间范围与过滤组合（影响 UX）
