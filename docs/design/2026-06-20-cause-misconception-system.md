# 错因 / 误区系统设计（cause / misconception system）

> **Status**: design outline · **Date**: 2026-06-20 · **Upstream**: YUK-454（错因系统）· YUK-452（冷启 day-one MVP epic）· `docs/design/2026-06-20-cold-start-day-one-design.md`（§4.2 错因是最弱一环 / §6 Q7）· ADR-0036（dual-layer heterogeneous KG · RT1 misconception 节点）
>
> 触发：owner §6 Q7 拍 **两段式 retrieve-rerank**（override 我的「~7 类一发直选」），理由「**错因是会持续扩张的**」——系统必须为成长的 taxonomy 而设计。本文给错因系统的分层 outline。

## 0. 核心张力：两个粒度

错因系统贯穿**两个粒度**，别混：

- **粗：`cause_category`** —— 学科声明的**受控词表**（错因「类型空间」）。owner-fixed prior，归因即时消费，retrieve-rerank 在其上跑。
- **细：`misconception`** —— 复发晋升出的**图实体**（RT1 节点 + `misconception_edge`，「指向此点的误区」）。持久、参与诊断/推荐/复习图。

retrieve-rerank 解决「词表一长，一发 LLM 直选退化」；图节点解决「细误区要持久、要参与图」。

## 1. 六层架构

### L0 · 词表 / 目录层（Taxonomy）
- `cause_category`：按 `SubjectProfile.causeCategories` 声明（`profile-decl.ts` / `subjects/*/profile.ts`），专家种子，`source_pack` 槽可挂外部专家包（AAAS/Eedi 式目录）。
- **n=1**：owner-fixed prior（不从作答估）。**冷启**：day-one 种好、即时可用。
- **扩张机制（持续扩张的核心）**：owner 手加类目 / LLM-propose 新类目 → human-vet 收编 / 细误区从实例晋升成图节点（L4）。词表增长是常态 → 驱动 L1 的 retrieve-rerank。

### L1 · 归因层（Attribution）
- `attribute.ts` `runAttributionAndWriteJudgeEvent`：LLM 读（题 + 正确答案 + **真实错答** + KC 上下文）→ `CauseSchema {primary_category, secondary_categories[], analysis_md, confidence}`，**约束到词表 + 锚到正确答案 + `other` 逃生口**，按 ADR-0006 写成 chained 在 attempt 上的 JudgeOnEvent。触发：followup job / copilot / import / paper-submit。
- **Q7 落点 · retrieve-then-rerank**（Eedi 冠军形态，为成长 taxonomy）：
  1. **retrieve**：从（成长的）词表 + 已晋升误区节点召回候选错因（按 KC / pgvector 近邻 / 词表层级）。
  2. **rerank-with-rationale**：LLM 对候选逐一给「为何这么错」的理由式重排 → 定 primary + secondary。
  - 取代当前的一发直选；词表小时退化为直选（无害），词表大时显著优于直选。
- **冷启 OK**：对**每条真实错答**即时归因，零累积数据。**n=1**：产出是 HYPOTHESIS（confidence + draft 态），非标定量。

### L2 · 存储 / 实例层（Storage）
- `mistake_variant.cause_category` + cause 作 JudgeOnEvent（caused_by_event_id chained）。
- **per-learner 自状态**（单用户无 user_id，每行即本学习者）；误区**实例**在此累积。

### L3 · 复发 / 聚合层（Recurrence）
- `misconceptionRecurrence`（`candidate-signals.ts`，已 merge dark-ship，`MISCONCEPTION_RECURRENCE_ENABLED`）：按 cause-family（cause_category 维）的**跨 attempt 复发 tally**，归一化常数 `RECURRENCE_NORM` owner-fixed。
- **喂软选题信号**（bucketUnit → SelectionOrchestrator LLM prompt）；**绝不进 θ̂/p(L)**（红线，`candidate-signals.db.test.ts:1051` 断言）。
- 这是「你反复在某类错」浮现的地方；status 滤 `active`（排 draft/dismissed/broken 误判）。

### L4 · 晋升 / 图实体层（RT1 · ADR-0036）
- 复发 ≥k → **提议 RT1 `misconception` 图节点**（id/title/reasoning/weight/created_by/archived_at）+ `misconception_edge`（多态：misconception → KC，「指向此点的误区」）→ **human-accept**（draft→active）。
- KC 详情页「指向此点的误区 · misconception」section 的数据源（claude design fa5b0bb6 已画该屏）。
- **gated 在 ADR-0034 一致性闸**（caused_by 方向语义靠闸地基钉死；闸代码侧前置，RT1 在闸就位前不起跑）。误区在此成 first-class 图节点，持续扩张、参与诊断/推荐/复习图。

### L5 · 消费层（Consumption · 全软）
- `rating-advisor.ts` CC-1（cause → FSRS rating nudge，**LIVE**，粗心类轻推 rating 桶）。
- `misconceptionRecurrence` → 选题 nudge（SelectionOrchestrator）。
- KC 详情「指向此点的误区」（渲染 L4 图节点）。
- 教研团 conjecture 引擎读「哪些误区还 open」→ 开处方（YUK-405 / YUK-406）。

## 2. 三条贯穿约束

1. **n=1 红线**：词表 owner-fixed；归因是假设非标签（confidence + draft/active）；**绝不**从作答模式估「干扰项诊断力 / P(误解\|选项)」（= 跨被试方差量 = CDM slip/guess + IRT a/c 化身 = INADMISSIBLE）；错因**绝不喂 θ̂/p(L)/调度**，只软消费（选题/rating/展示/教学处方）。
2. **冷启 cold-start-first**：词表 day-one 种好；归因逐条即时可用（无需累积）；复发/图节点 day-one 为**空**（正确——无数据≠零，NEVER zero-fill）；随用长。
3. **两粒度协同**：粗词表（归因即时用、retrieve-rerank 在其上）→ 细图节点（复发晋升、持久参与图）。

## 3. 增量（落 YUK-454 子项）

- **L1 retrieve-rerank**（可先做）：把 `attribute.ts` 一发直选改成 retrieve → rerank-with-rationale；词表小时行为等价，为成长设计。
- **catalog 扩张机制**：owner 加类目 UI + LLM-propose-new-category + human-vet 收编流。
- **L4 RT1 图晋升**（后期，gated 一致性闸 ADR-0034）：复发≥k 晋升提议 + misconception 图节点/边 + KC 详情 section 消费。

## 4. 诚实天花板（cold-start doc §4.2）

错因推断是整个冷启栈**最弱的一环**（模拟学生命中人类选定干扰项仅 31-47%）。缓解已内建：目录来自学科声明（非 LLM 生成）、实例来自 live judge 对真实错答的归因、绝不从 student-simulation 播种 typed-misconception、永远保持假设态（用户可 dismiss）。**别把 LLM 推断的错因当确定标签直接驱动硬决策。**

## Linear 捕获

本文为 YUK-454 的设计 outline。增量（retrieve-rerank / catalog 扩张 / RT1 晋升）作 YUK-454 子项或后续拆分；RT1 晋升 gated 在 ADR-0034 一致性闸（与 YUK-344 关联）。
