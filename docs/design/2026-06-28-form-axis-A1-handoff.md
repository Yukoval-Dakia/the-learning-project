# 形态轴 A1 · 稳态晨间交班缕 — 功能 handoff（给 claude design）

- **date**: 2026-06-28
- **status**: functional handoff（零风格规定）—— 视觉稿由 claude design (claude.ai/design) 出，回来 slice-by-slice 实现
- **epic**: YUK-354（产品形态轴）；本条 = 形态缺口 **A1**（gate doc `docs/design/2026-06-15-rethink-implementation-gate.md` §2.1 第 1 条）
- **数据状态**: ⚠️ **部分已实现**。交班缕的「先轻」侧（今日 due / 待裁决）有现成 endpoint；「后叙事」侧（昨夜 AI 替你做了什么）**所依赖的 digest 读模型尚不存在**——见文末「基础设施缺口」。本 handoff 描述目标形态，不假装后端已就位。

> 这是**功能** handoff：只描述交班缕该让 owner**理解什么、能做什么、看到哪些数据形状**，**不规定任何视觉风格/布局/配色/动效/图标/明暗**——那是 claude design 的活。实现回来后按项目既有 loom design 系统（tokens / primitives）落地。

---

## owner 想解决的问题

这是单人 AI 学习工具的「**稳态晨间交班**」体验（gate doc §2.1 A1：「先轻后叙事」felt-experience）。

设想：owner 每天早上打开 `/today`，AI 在**昨夜替他干了活**——夜间 job 跑了重标定、补了题库空缺、提了知识边、留了观察笔记、备了课。owner 想要的不是一屏冷冰冰的 KPI 数字，而是一条**叙事缕**：先一眼看到「今天有几项到期」（轻、即时可动作），再被 AI 以第一人称口吻交班「**昨夜我替你做了什么**」（叙事、建立代理信任）。这直接服务北极星锚的第 3 条「代理信任」——owner 要信任到放心把「今天学什么」交给 AI 编排，而交班缕是这份信任每天被**兑现一次**的地方：AI 不是黑箱，它昨夜的劳动对 owner 当下可见、可追溯、可裁决。

「**空夜态**」是这条缕的一等公民，不是边角（见专章）：首日（有档案但还没有过夜）、或连续无活动（昨夜 AI 确实没产出可交班的东西）时，绝不能让交班缕谎报「昨晚 Dreaming agent 跑过」之类的假叙事——那恰好摧毁代理信任。

---

## 现状反模式（锚真代码）

> 必读，A1 的设计要**修掉**这些。下列缺陷都锚在真实文件/行，非凭空。

### 反模式 1 — hero 的「昨夜叙事」被设计稿写死、又被迫中性化成空话
`src/capabilities/shell/ui/blocks/LoomHero.tsx:1-5`（文件头注释，逐字）：

> 偏差：eyebrow 去掉假 phase 戳；lead 句中性化——设计稿写死「昨晚 Dreaming agent 跑过」，真数据源（task_run 交班）M5 Copilot 收编后才可判定，**不写死假话**。

即：原 loom 设计稿**想要**一句「昨晚 Dreaming agent 替你跑过」的叙事，但因为没有真数据源支撑，实现者只能把它中性化成一句永远成立的空话——`LoomHero.tsx:47`：

> `这是你的工作台：复习队列、AI 的提议与改动都汇在这里。`

问候语（`LoomHero.tsx:17-27`）也只按**当前时钟小时**机械切「早上好/午安/下午好」，与昨夜 AI 活动**零关联**。**A1 的本质就是把这句被迫中性化的叙事真正接通**——但前提是后端能区分「真有昨夜活动」与「空夜」。

### 反模式 2 — 「今日之线」只派生「复习/裁决」两缕，交班缕被显式标注为缺失
`src/capabilities/shell/ui/TodayPage.tsx:50-81`（`deriveThreads` + 其上注释，逐字）：

> 「今日之线」派生：设计稿 DATA.threads 是策展假数据；真数据从 summary 聚合派生两缕（复习/裁决），**未来夜链交班缕随 M5 task_run 读模型补**。

代码实际只产出两缕：`due_count > 0` → 「复习」缕（`TodayPage.tsx:54-66`），`proposals.total > 0` → 「裁决」缕（`TodayPage.tsx:67-79`）。**「昨夜 AI 活动 → 今晨交班」缕从未实现**，注释自己承认它「随 M5 task_run 读模型补」——那个读模型至今不存在（见基础设施缺口）。

### 反模式 3 — AgentNotesBoard 是扁平流，不是叙事，也不按「昨夜」窗
`/today` 底部挂 `AgentNotesBoard`（`TodayPage.tsx:289-295`），数据走 `/api/agents/notes?limit=20`（`TodayPage.tsx:212-218`）。它是 AI 跨上下文观察的**只读旁观流**（newest-20 扁平列表，hints not facts），**不按时间窗聚合到「昨夜」**、不叙事、不交班。它是「AI 在想什么」的长流，不是「昨夜 AI 替你做了什么」的当日交班。

### 反模式 4 — 交班缕（A1·稳态）≠ 冷启拦截（YUK-473），别混淆
`TodayPage.tsx:236-238`：`s.kpi.goal_count === 0` → 渲染 `<ColdStart>`（YUK-473 Slice 1，`/welcome` 冷启 onboarding）。**那是首次零档案的冷启**。A1 是**有历史之后**的稳态晨间叙事缕——goal_count > 0、有过往活动。两者必须分开：A1 的「空夜态」（下章）发生在 **goal_count > 0 但昨夜无 AI 产出**，绝不能落回 ColdStart。

---

## A1 应呈现什么（功能层，非视觉）

「先轻后叙事」两段式：

### 段 1 — 先轻：一眼今日（即时可动作）
一眼看出今天要做什么，**不需要读叙事就能开始动作**：
- 今日 due 数（到期学习项）— 数据已就位（`due_count`）。
- 待裁决数（AI 提议待审）— 数据已就位（`proposals.total`）。
- 这一段是「轻」：低阅读量、直接 CTA（去复习 / 去裁决）。现有 KpiRow + 复习/裁决两缕已覆盖这一段的数据，A1 不必重造，但视觉上要让它**先于、轻于**叙事段。

### 段 2 — 后叙事：昨夜 AI 替你做了什么（建立代理信任）
AI 以第一人称口吻交班昨夜的劳动，**有内容才叙事，无内容走空夜态**。昨夜可交班的「AI 劳动」素材（均为真实夜间 job 产出，详见数据契约）：
- **重标定 / 掌握变化**：`recalibration_nightly` / `kt_estimate_nightly` / `axis_state_nightly` 跑过，某些 KC 的掌握估计更新了。
  - 硬约束（见下「mastery 展示约束」）：交班缕提及掌握变化时**绝不裸数字**。
- **题库补缺**：`question_supply_nightly` 为某些 KC 补了练习题；`frontier_fill_nightly` / `knowledge_edge_propose_nightly` 提了新知识边（落进待裁决提议）。
- **AI 观察**：昨夜 dreaming / maintenance / coach 留下的 agent notes（`signal_kind` 如 `question_pool_gap`）。
- **备课**：`research-meeting` 夜间 job 诱导出的 conjecture（备课台「为你而备」，`/api/prep-desk/conjectures`，≤3 条）。
- **录入改动**：近 24h AI 对笔记的 refine（`/api/artifacts/ai-changes/recent`）。

叙事缕的功能要求：
1. **第一人称、当日窗**：是「昨夜（自上次到访以来）我替你做了 X」的交班，不是「AI 历史观察长流」。时间窗 = 昨夜 / 自上次到访以来（**当前无 `last_visited_at` 锚点——见基础设施缺口**）。
2. **可下钻、可裁决**：每条交班项要能跳到它的归宿——重标定→该 KC 详情、补题→练习、提议→裁决收件箱、备课→备课台。交班缕是入口，不是终点。
3. **有限、不堆积**：交班是「昨夜这一档」的快照，不是 backlog；参照备课台 ≤3 的「有限 felt feed」克制原则（`prep-desk.ts:34-36`），避免把交班缕变成无限增长的任务列表。
4. **诚实**：昨夜 job 跑挂 / 无产出时，**不编造**昨夜活动（这正是反模式 1 当初被迫中性化的原因）。

---

## 空态 / 失信兜底 / 故障态（一等公民，显式功能约束）

> 这一章是 A1 的核心，不是边角。交班缕的价值高度依赖**诚实**——空夜与故障态处理错了，直接摧毁代理信任。

### 空夜态（headline 状态，不是边角）
**定义**：`goal_count > 0`（已过冷启、有档案）**但**昨夜窗内无任何可交班的 AI 产出。两种触发：
- **首日**：有档案但还没有过任何一个夜晚（job 没跑过）。
- **连续无活动**：昨夜 job 跑了但无新产出，或 owner 多日未到访、无「自上次以来」的增量。

**功能约束**：
- 段 1（先轻）照常显示今日 due / 待裁决——即便昨夜无 AI 活动，今天该练的还在。
- 段 2（叙事）**不渲染假交班**。空夜态要有**自己的 felt 表达**：诚实地说「昨夜没有需要交班的活动」（首日可略说明 AI 夜间会做什么、何时开始），而非套一句通用空话或硬塞一条无意义叙事。
- **绝不落回 ColdStart**（那是 goal_count===0 的冷启路径，反模式 4）。空夜态是稳态的一种合法日常态。

### 失信兜底（昨夜活动「有但低质」时）
- 交班缕里凡涉及 **mastery / 难度的绝对值**，一律带置信区间 / 低置信标记，**绝不给干净数字**（gate doc §1.5.2 owner 选最强档）。
- 涉及 AI 提议 / conjecture 时，区分「这是 AI 的软提议（待你裁决）」vs「这是已确认的事实」——交班缕措辞不能让软提议看起来像既成事实。
- conjecture 交班严格沿用备课台的反内疚铁律（`prep-desk.ts:7-26`）：**内部校准概率**（`confidence` / `predicted_p` / `baseline_p`）**绝不上线**到交班卡面，避免 owner「优化那个数字」。

### 故障态
- **digest 读模型不可用 / 报错**：交班缕段 2 走标准 error 态（参照现有 `Stateful` 的 error + retry，`TodayPage.tsx:148-154`），段 1（今日 due）独立加载、不被段 2 的故障拖垮——两段必须**独立可降级**。
- **部分素材源失败**（如重标定数据有、备课台 endpoint 挂）：交班缕**部分降级**呈现可得的部分，缺失的部分静默或标注，绝不整缕崩。
- **昨夜 job 实际跑挂**（不是读模型挂，是夜间 job 自己 error）：交班缕应**如实交代**「昨夜某项没跑成」属于诚实交班的一部分（认识论诚实锚），而非假装一切正常——这是 A1 与「永远报喜」的关键区别。

---

## 数据契约（wire 形状 + 真实字段 sample）

> ⚠️ 分两层：**(A) 已存在的素材源**（A1 段 1 + 段 2 部分可直接取）；**(B) 缺失的 digest 读模型**（段 2 的「昨夜交班」聚合所必需，尚不存在）。字段名全部从真实代码取，非 mock。

### (A) 已存在 — 段 1「先轻」+ 段 2 部分素材

**`GET /api/workbench/summary`**（`src/capabilities/shell/server/workbench-summary.ts:38-51`，真实 wire 形状）：
```jsonc
{
  "proposals": {
    "total": 3,
    "by_kind": { "knowledge_edge": 2, "learning_item": 1, "knowledge_node": 0, "conjecture": 0 /* ...全 kind 枚举，aiProposalKinds */ },
    "status": "pending"
  },
  "kpi": {
    "due_count": 7,                      // 今日到期学习项（段 1 主数）
    "pending_attribution_count": 2,
    "knowledge_count": 41,
    "goal_count": 3                      // >0 = 已过冷启；A1 在此前提下运行
  },
  "active_sessions": [ /* 最近 review 会话 */ ],
  "week_heat": [ { "day": "2026-06-28", "count": 4 } /* 近 7 天 */ ]
}
```

**`GET /api/agents/notes?limit=20`**（`src/capabilities/agency/ui/types.ts:7-23`，昨夜 AI 观察素材）：
```jsonc
{ "rows": [ {
  "id": "agent_note_xxx",
  "created_at": "2026-06-28T02:14:00.000Z",   // 可按此过滤「昨夜」窗
  "source_task_kind": "quiz_verify",
  "signal_kind": "question_pool_gap",         // 真实词表值
  "summary_md": "k1 的练习池只有 1 道题",
  "refs": [ { "kind": "knowledge", "id": "k1" } ],
  "target_agents": ["coach"],
  "confidence": 0.6                            // 内部信号，交班卡面不渲染裸值
} ] }
```

**`GET /api/prep-desk/conjectures`**（`src/capabilities/shell/server/prep-desk.ts:54-83`，昨夜 research-meeting 备课产出，≤3）：
```jsonc
{ "conjectures": [ {
  "id": "prop_xxx",
  "claim": "你可能把 X 误当成 Y",
  "knowledge_id": "k7",
  "cause_category": "concept_confusion",
  "probe_md": "下面这道题只有持此误解的人会答错……",  // 未跑的探针文本
  "recurrence_count": 3,
  "discriminating": true,
  "evidence": [ { "kind": "question", "id": "q123" } ],
  "proposed_at": "2026-06-28T03:00:00.000Z"
  // 注意：predicted_p / baseline_p / confidence 故意不在 wire 上（反内疚铁律）
} ] }
```

**`GET /api/artifacts/ai-changes/recent`**（`src/capabilities/notes/ui/notes-api.ts:135-145`，近 24h AI 笔记改动）：返回 `{ window_hours: 24, rows: AiChangeRow[] }`，每行 `{ event_id, artifact_id, created_at, actor_ref, ops_count, new_blocks, undone, ... }`。

**`ai_task_runs` 表**（`src/db/schema.ts:538-561`）：每个夜间 job 跑都落一行 `{ task_kind, status, started_at, finished_at, cost_usd, usage_json, error_message }`。**这是「昨夜哪些 job 跑了 / 跑挂了」的事实源**，但目前只有 admin 观测面（`/api/_/admin/jobs`）读它，**无面向 /today 的当日交班 digest 端点**。

### (B) 缺失 — 段 2「昨夜交班」digest 读模型

A1 段 2 需要一个**当日交班 digest 读模型**，把上述素材按「昨夜 / 自上次到访以来」时间窗**聚合成一条叙事就绪的 payload**，并显式产出**空夜态信号**（has_overnight_activity = false）。这个端点**不存在**，必须新建——见基础设施缺口。建议的 wire 形状（待后端实现时定稿，此处只表达 A1 所需的数据形状）：
```jsonc
{
  "window": { "since": "<上次到访 or 昨日界>", "until": "<now>" },
  "has_overnight_activity": true,            // false → 空夜态
  "strands": [
    { "kind": "recalibration", "count": 4, "route": "/knowledge", "summary": "更新了 4 个知识点的掌握估计" },
    { "kind": "question_supply", "count": 6, "route": "/practice", "summary": "为 3 个知识点补了 6 道题" },
    { "kind": "proposal", "count": 3, "route": "/inbox", "summary": "3 条新提议待裁决" },
    { "kind": "conjecture", "count": 2, "route": "/today#prep-desk", "summary": "备了 2 道辨析题" },
    { "kind": "job_failure", "count": 1, "summary": "frontier_fill 昨夜未跑成" }  // 诚实交代
  ]
}
```
> mastery 相关 strand 的「掌握更新」**不带绝对数字**，只表达「更新了/方向」+ 可下钻；具体数值口径由节点详情页按 ADR-0035 §决定1 + gate §1.5.2 渲染（带置信/来源二态）。

---

## mastery / 难度展示约束（A1 涉及，硬契约）

交班缕段 2 会提及「昨夜重标定了某些 KC 的掌握」。凡触及 mastery / 难度，沿用 gate doc §1.5.2 owner 选定的最强档：
1. **绝对值一律带置信区间 / 低置信标记，绝不给干净数字**——交班缕不显示「掌握 78%」裸值；表达「更新了」「方向变化」「可下钻看详情」即可。
2. **来源二态可分**：硬轨真实作答校准（firm up）vs 软轨 LLM 先验回吐（prior-echo）至少二态可视区分（gate §1.5.2 第 2 条）。冷启盲区 KC 的「掌握」是 prior-echo，交班缕不能让它看起来像可信校准结果。
3. 数值精度 / 下钻详情归节点详情页（形态缺口 A5 `/knowledge` 探索面），A1 只做「指过去」的入口，不在交班缕里渲染精确画像。

---

## 不在本 A1 范围
- 不实现 digest 读模型本身（那是后端 follow-up，本 handoff 末尾开 issue）。
- 不改任何夜间 job 的产出逻辑（A1 纯读、纯叙事呈现既有产出）。
- 不做节点详情页 / 诊断下钻面（那是 A5）；A1 只提供跳转入口。
- 不重做 KpiRow / 复习·裁决两缕的现有数据层（段 1 复用既有 summary）。
- 不碰冷启 onboarding（YUK-473 `/welcome` 链，反模式 4）。

---

## 基础设施缺口（needs issue）

> gate 铁律：handoff 依赖的后端不存在就显式列出，不假装存在。A1 段 2 直接依赖以下两项，缺一不可落地。

### 缺口 1 — 「昨夜 AI 活动」当日交班 digest 读模型不存在
- **问题**：A1 段 2「昨夜我替你做了什么」需要一个把夜间 job 产出（`ai_task_runs` + agent notes + proposals + prep-desk conjectures + ai-changes）按时间窗聚合成叙事就绪 payload 的读模型，并显式产出**空夜态信号**。当前无此端点——素材散在 5 个互不关联的 endpoint，且 `ai_task_runs` 只有 admin 观测面读它，没有面向 /today 的当日交班聚合。`LoomHero.tsx:1-5` 与 `TodayPage.tsx:50-51` 两处注释都已自承这个读模型「M5 task_run 收编后才补」，至今未补。
- **锚点**：`src/capabilities/shell/ui/blocks/LoomHero.tsx:1-5`、`src/capabilities/shell/ui/TodayPage.tsx:50-51`、`src/db/schema.ts:538-561`（ai_task_runs 事实源）、`src/capabilities/shell/server/workbench-summary.ts`（聚合 read model 的现成落点参照）。
- **依赖关系**：A1 段 2 与空夜态判定**硬依赖**此读模型。段 1（先轻）与现有两缕不依赖，可先行。

### 缺口 2 — 无 `last_visited_at`（「自上次到访以来」窗算不出）
- **问题**：交班缕的诚实窗口理想是「自上次到访以来」，但系统无任何「owner 上次打开 /today 的时间」锚点，因此只能退化成固定「昨夜（昨日日界）」窗。固定窗在 owner 多日未访时会漏报中间几夜的产出，或无法表达「距上次 3 天，这三夜 AI 做了这些」。
- **影响**：可接受的降级 = 先用固定「昨夜」窗交付 A1，`last_visited_at` 作为后续增强。但需 owner 拍：A1 首版用固定昨日窗，还是同期补 `last_visited_at`。

---

## 留给 owner 的开放决策
1. **交班窗口口径**：A1 首版用固定「昨夜（昨日日界）」窗，还是同期实现 `last_visited_at` 走「自上次到访以来」窗？（缺口 2）
2. **空夜态文案基调**：首日空夜态是否要顺带「预告」AI 夜间会做什么（建立预期），还是只诚实说「昨夜无活动」保持极简？（claude design 出形态前需 owner 定基调倾向）
3. **job 失败是否上交班缸**：昨夜 job 跑挂时，是在交班缕里如实交代「某项没跑成」（认识论诚实，但可能噪），还是静默？（默认建议：如实交代，但措辞克制）
