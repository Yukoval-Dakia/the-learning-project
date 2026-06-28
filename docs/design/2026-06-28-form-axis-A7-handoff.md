# 成效趋势面 — 功能 handoff（给 claude design）

- **date**: 2026-06-28
- **status**: functional handoff（零风格规定）—— 视觉稿由 claude design (claude.ai/design) 出，回来 slice-by-slice 实现
- **epic**: 形态轴 YUK-354（gate doc `docs/design/2026-06-15-rethink-implementation-gate.md` §2 第 7 条）
- **数据已就位（2026-06-28 更新）**: 本面板的纵向聚合读模型**已建** = `effectiveness-trend.ts` + `GET /api/observability/effectiveness-trend`（PR #664，待 merge）。文末「## 基础设施缺口」记录的「needs issue」已由 YUK-519/PR #664 解决——视觉稿回来即可落到 live 读模型。
- **落点 IA（owner 拍定 2026-06-28，替代下方旧「observability/admin 侧」落点）**: 本面 = **Coach 复盘中枢**的「成效趋势」视图，详见下节。

> 这是**功能** handoff：只描述面板该让 owner**理解什么、能做什么**，**不规定任何视觉风格/布局/配色/组件选型**——那是 claude design 的活。实现回来后按项目 design tokens/primitives 落地。

## 落点 IA（owner 拍定 2026-06-28 — 必读，纠正原落点）

**背景（handoff 盲点修正）**：本 handoff 初版漏 ground 两个既有回溯面，导致 claude design 把成效趋势折进现有 Coach 周报、复用同名标题、做成二元「成效/诊断」toggle——撞车。owner 拍定的正确 IA 如下：

**Coach 不再是单一周报，是「我做得怎样」的复盘中枢**，含**三个正交视图**（分段切换，共用现有 Coach nav 入口，不新增顶层 nav）：

1. **活动量**（现有 `CoachPage.tsx`，不动）— FSRS 复习活动报表：reviews / 正确率 / 新增错题 / 成本 + 评分分布 + 归因分布 + 逐日复习量 + 失败排行。答「我**练了多少、对了几道**」。读 `/api/review/weekly`，7/30/90 天窗。
2. **校准诊断**（现校准成熟度面 PR #475，**从 admin 迁入 Coach**）— 横截面 θ̂/p(L) 点估计 + 置信。答「我现在这个知识点**会不会、多可信**」。带置信、绝不裸数字（⑥）。
3. **成效趋势**（**本面 = A7**，新）— 纵向 delta：per-KC/per-subject 相对自己的轨迹 + 方向 + 置信。答「**相比上次涨了吗**」。读 PR #664 读模型。

**IA 硬约束（给 claude design）**：
- 校准诊断（横截面「多准」）vs 成效趋势（纵向「涨没涨」）= **正交两面，同屏并列、绝不合并**——三视图分段是对的，但标签是**三视图**（活动量/校准诊断/成效趋势），不是二元「成效/诊断」。
- **标题别再叫「Coach 周报」**（与现有单一周报语义撞）；现在是「Coach 复盘中枢」之类，"周报" 降为活动量视图的窗口表达。
- 校准诊断从 admin 迁入是 IA 决策的一部分（详见 Coach 复盘中枢重构工单），但本 handoff 只负责定义「成效趋势」视图的功能；三视图的容器/迁移由重构工单承载。

> 与姊妹面的正交分工（保留，现升级为同一 Coach 中枢内的并列视图）：**校准成熟度面**（`2026-06-19-calibration-maturity-panel-handoff.md`，PR #475）答「数据现在**多准**」（横截面快照）；**本面（成效趋势）答「相比上次**涨了吗**」（纵向 delta）**。两者正交，别合并。

## owner 想解决的问题

这是 owner 提 rethink 的**原始动机之一**，也是北极星四判据里的「**成效**」（gate doc §0.2：「用一段时间后，某科相对我自己的趋势真的在涨」）。

**诊断 ≠ 成效**。诊断面（校准成熟度 / 节点详情）回答**横截面**问题——「我现在这个知识点会不会」（当前 θ̂ / p(L) 点估计 + 它有多可信）。成效面回答**纵向**问题——「我相比上一次**保持住了 / 退步了 / 涨了**吗」「在 A 知识点学的东西**迁移**到相邻 B 了吗」。同一个 p(L)=0.6 的截面读数，可能是「从 0.3 爬上来的进步」也可能是「从 0.85 滑下来的退步」——横截面读不出方向，**只有纵向 delta 能读出**。owner 想亲眼看到这个**方向与轨迹**，把抽象的「在进步」变成可观测的曲线。

## 现状反模式（锚真代码）

成效的**原子素材已经在写**，但**只是零散埋点，没有任何纵向聚合读路径**——面板没有数据可读。

1. **delta 埋点是 write-only 旁路，无聚合消费**。`src/capabilities/notes/server/mastery-progress-signal.ts:105` `emitMasteryProgressSignal()` 在每次作答成功后，按 KC EMIT 一条 `experimental:mastery_progress` 事件，payload 携带本次 attempt 的真实 `theta_delta`（Δθ̂）/ `p_learned`（当前 p(L)）/ `theta_hat`。两个 emit 站点：散题 solo 路径 `src/capabilities/practice/api/submit.ts`、卷题 paper 路径 `src/capabilities/practice/server/paper-submit.ts:835`。**这是「埋点」——不是读模型**。模块自己的红线注释（`mastery-progress-signal.ts:18-20`）写明：「只 READ + EMIT 一条观测事件，绝不写回。它是只读旁路埋点，不是反馈环」。

2. **埋点的设计目的本就不是「现在可视化」，而是「N 周后定阈值」**。`mastery-progress-signal.ts:154-157`：每条事件带 `threshold_deferred: true`——「跨阈阈值尚未定，埋点窗口里这条事件不 gate 任何行为」。即埋点是为了攒 Δ 分布、给 ADR-0040 决定2 的 note-refine 触发器挑阈值，**从设计上就没人把这些事件聚成趋势读出来**。

3. **唯一「消费者」只是文档引用，不做聚合**。grep `mastery_progress` 的全部命中里，除 emit 站点与测试外，只有 `src/capabilities/notes/server/note-refine-triggers.ts:191` 一处——而它只是注释里提到「以 `experimental:mastery_progress` 事件埋点，阈值 N 周后定」，**没有任何 SELECT / GROUP BY / 时间序列聚合**。没有 per-KC / per-subject 的纵向读路径存在。

4. **现有的「趋势」是活动量趋势，不是成效趋势**。`src/capabilities/practice/api/weekly.ts:100` 有个 `daily` trend buckets——但它按 UTC 天聚合的是**作答次数 / 正确率**（`count` / `correct`），是「我这周练了多少、对了几道」的**活动量 / 表现**趋势，**不是 mastery delta 的纵向轨迹**。owner 要的「某 KC 的掌握相对自己在涨」在现有任何读路径里都读不出。

**一句话现状**：素材（per-attempt Δθ̂ 事件）在持续落库，但**没有把它们聚成 per-KC / per-subject 时间序列 + 趋势的读模型**——面板要呈现的纵向 delta，目前**无处可读**。

## 数据契约

### 上游原子素材（已在写，wire 形状确定）

`experimental:mastery_progress` 事件落在通用 `event` 表（`src/db/schema.ts:716`），每次作答成功 per KC 一条。真实形状（锚 `mastery-progress-signal.ts:137-161` + 测试 `paper-mastery-progress.db.test.ts`）：

```jsonc
// event 行（per-KC，per-attempt）
{
  "action": "experimental:mastery_progress",
  "subject_kind": "knowledge",
  "subject_id": "k_pmp",              // KC id（subject 是派生视图，KC 上不存 subject 列）
  "outcome": null,                     // 观测读数，非判分
  "caused_by_event_id": "<attempt id>",// 串到触发它的 attempt，可追溯
  "created_at": "2026-06-28T09:12:03Z",// ← 纵向时间轴的唯一锚
  "payload": {
    "knowledge_id": "k_pmp",
    "theta_delta": 0.18,               // 本次 attempt 的 Δθ̂；null = 首作答前无 prior Δ（冷启）
    "p_learned": 0.61,                 // 当前 difficulty-aware p(L) point estimate（0..1）
    "theta_hat": 0.42,                 // 当前 θ̂ 绝对值
    "question_id": "q_pmp",
    "attempt_event_id": "<attempt id>",
    "threshold_deferred": true         // 埋点期不 gate 任何行为
  }
}
```

**per-subject 轴是派生的，不是存的**（项目铁律「科目是视角不是结构」）：KC 的科目经 `knowledge.domain`（`schema.ts:61`）→ `effective_domain`（派生视图，`src/ui/lib/subject.ts:131`）解析，**绝不在事件 / KC 上加 subject 列**。聚合到「某科目的成效趋势」必须沿这条派生轴 group。

### 本面板要消费的 wire 形状（**尚不存在，需新建读模型 → 文末 issue**）

面板需要的是把上面零散事件**聚成的**纵向读模型。建议形状（参照姊妹 `loadCalibrationMaturity` 的 `{ rows, aggregate }` 范式，`calibration-maturity.ts:139`）——**最终契约由基础设施 issue 定，这里只描述面板要能拿到什么**：

```jsonc
{
  // per-KC 时间序列（哪些 KC 在涨 / 保持 / 退）
  "series": [
    {
      "knowledge_id": "k_pmp",
      "name": "宾语前置",
      "effective_domain": "wenyan",     // 派生轴，用于 per-subject 卷起
      "points": [                        // 按 created_at 升序的 p(L) / θ̂ 轨迹
        { "at": "2026-06-20T...", "p_learned": 0.31, "theta_hat": -0.2, "evidence_count": 2 },
        { "at": "2026-06-24T...", "p_learned": 0.48, "theta_hat": 0.1,  "evidence_count": 5 },
        { "at": "2026-06-28T...", "p_learned": 0.61, "theta_hat": 0.42, "evidence_count": 8 }
      ],
      // 趋势摘要——见「⑥硬约束」：方向 + 置信，绝不裸 delta 数字
      "trend": {
        "direction": "rising",          // rising | holding | falling | insufficient
        "confidence": "low",            // 趋势本身的置信（n=1 慢热，常 low）
        "span_evidence": 8              // 这条趋势建立在几次作答上
      }
    }
  ],
  // 跨 KC 迁移信号（在 A 学的迁移到相邻 B 了吗）—— owner 留白2，形态待定
  "transfer": [ /* … */ ],
  // 整科 / 整图卷起
  "aggregate": {
    "by_subject": [
      { "effective_domain": "wenyan", "direction": "rising", "confidence": "low", "kc_count": 12 }
    ]
  }
}
```

> 上面 `series` / `trend` / `transfer` 的字段名是**示意**，不是定契约——真实字段由基础设施 issue 实现时锁定。claude design 需要的是「面板能拿到 per-KC 时间序列 + 方向 + 置信 + 跨 KC 迁移」这个**信息可供性**，不是这些 key 的字面。

## 面板应呈现什么（功能层，非视觉）

1. **纵向 delta 的 felt：方向 + 轨迹**。一眼看出某 KC / 某科目相对自己**在涨 / 保持 / 退**，以及**这个方向是怎么走出来的**（轨迹，不只是终点）。这是与横截面诊断面最本质的体验差别——诊断面给「现在多高 + 多可信」一个点，成效面给「从哪来、往哪去」一条线。

2. **横截面 vs 纵向的对比体验**。owner 看校准成熟度面知道「这个 KC 现在 firm 了、p(L)≈0.6」；切到本面要立刻读到「而且它是**从 0.3 爬上来的**」——同一个 0.6 的方向感。两个面要让 owner 感到**互补而非重复**：一个答「准不准」，一个答「涨没涨」。

3. **跨 KC 迁移的 felt**。成效不止单点涨，还包括「在 A 知识点练的东西**迁移**到相邻 B 上了吗」（相邻 KC 一起抬升 = 真理解，孤立单点抬升 = 可能只是记住了这道题）。这是「成效」区别于「刷题数」的核心信号。**迁移的可视化形态属 owner 留白2**——本期可只在数据契约里预留，形态待定。

4. **不确定性诚实地织进趋势本身**。趋势 delta 的呈现必须遵守 ⑥硬约束（下一节单列）——这是**功能约束**，不是视觉偏好：n=1 慢热下趋势本身常常低置信，面板不能把一条嫩数据画成笃定的上升箭头。

## ⑥硬约束 —— 趋势 delta 绝不裸数字 + 置信标记（功能级红线，非像素）

来源：gate doc §1.5.2 ⑥（owner 选最强档）+ ADR-0035 §决定1。原文：「mastery / 难度**绝对值一律带置信区间 / 低置信标记呈现，绝不给干净数字**」。**本面板的趋势 delta 是这条约束的最尖锐适用场景**，因为：

- **趋势是 delta 的 delta，置信比截面更脆**。横截面 p(L) 已经要带置信标记；趋势是「两个本就不确定的点之间的差」，不确定性叠加——n=1 慢热下，前几次作答的 Δθ̂ 噪声极大，**一条「上涨」趋势很可能只是噪声**。

具体功能约束（claude design 必须让视觉稿满足；具体像素表达由 claude design 定）：

1. **趋势方向绝不裸数字呈现**。**不准**出现「掌握 +18%」「θ̂ 涨了 0.18」这类裸 delta 数。方向用**定性档**（涨 / 保持 / 退 / 数据不足）表达，数字若出现必须**始终伴随置信区间或低置信标记**，绝不单独成立。

2. **低置信趋势必须显著降级呈现**。趋势的 `confidence` 为 `low`（或证据量 `span_evidence` 低于 firm 门槛，参照校准面 `COLD_START_EVIDENCE_FLOOR=4` / `calibration-maturity.ts:39`）时，面板必须让 owner**一眼看出「这条趋势还不可信、别当真」**——而不是和一条 firm 趋势用同样笃定的视觉重量。口径同 ADR-0035：「低置信只信相对排序，不渲染干净的精确值」。

3. **`direction: "insufficient"` 是一等公民态**。证据太少（如只 1-2 次作答）连方向都不该断言——这是合法状态，不是错误态。面板要为它留显式表达，**不能**把数据不足的 KC 默默画成平线或上升线。

4. **来源二态可分（延伸 §1.5.2 第二条）**。趋势若混入软轨先验回吐（prior-echo）与硬轨真实作答校准（firm-up）的成分，至少要二态可视区分——「这条上升是你真练出来的」vs「这是模型先验的回声」不能混为一谈。**本期若数据契约暂不区分来源，标 owner 留白3**。

## 空态 / 失信兜底 / 故障态（显式功能约束）

每个都是**功能约束**（claude design 必须为其设计明确状态），不是边角：

- **全空态（零作答 / 首日）**：新用户或刚开始用，`event` 表里**一条 `experimental:mastery_progress` 都没有**——没有任何趋势可画。面板要有「还没有成效数据，去练几道就会长出趋势」的引导态，**不能**渲染空坐标轴 / 0 值平线（那会误导成「掌握一直是 0」）。

- **单点态（只 1 次作答的 KC）**：有读数但连 delta 都算不出（`theta_delta` 在首作答前是 `null`，`mastery-progress-signal.ts:42`）。这是 ⑥硬约束第 3 条的 `insufficient` 态——显式呈现「数据不足以判方向」，不是退步也不是上涨。

- **低置信趋势态（嫩数据）**：有几个点但 `confidence: low`。**这是本面板的默认态、不是异常态**——n=1 慢热下大量 KC 长期处于此态。必须显著降级呈现（⑥硬约束第 2 条），且这个降级要做得**不让面板看起来「坏了 / 没数据」**——它有数据，只是数据还不笃定。

- **退步态（falling）**：趋势向下是**合法且必须诚实呈现**的信号（认识论诚实，北极星 §0.4）——**不准**因为「负向不好看」就隐藏或柔化成平线。但同样受 ⑥硬约束：低置信的「退步」也要标低置信，别把噪声画成确定的下滑。

- **聚合读模型故障态（endpoint 失败 / 超时）**：读模型是新建的聚合查询（文末 issue），可能慢或失败。面板要有明确的加载 / 失败态，失败时**不能**回落成「全部 0」或「全部平线」——那是把「读不到」伪装成「没涨」，违反认识论诚实。要如实显示「成效数据暂时取不到」。

- **开放题为主科目的三量退化态**：见 owner 留白4——这类科目 IRT 三量退化，连 `theta_delta` / `p_learned` 都可能无效，面板需要**替代可视化**，否则会对这些科目呈现一片虚假的「无变化」。

## 不在本面板范围

- **不改 mastery / θ̂ / p(L) 的计算**（那是 B1）；本面纯读、纯展示，红线同 `mastery-progress-signal.ts:18-20`（只 READ + 聚合，绝不写回任何 mastery 通道）。
- **不定 note-refine 的跨阈阈值**（ADR-0040 决定2 那条埋点的下游用途）——本面板与「N 周后挑阈值」是**两个独立用途**，共享同一批 `experimental:mastery_progress` 事件作素材但互不依赖。
- **不做练习触发的写操作**（若要「点退步 KC 去补练」的跳转，是后续增量，本期可不含）。

## owner 留白（标出让 owner 拍）

1. **留白1 — 趋势窗口 / 粒度**：纵向趋势按什么时间窗（近 7 天 / 30 天 / 全程）、按 attempt 序还是日历日聚合？n=1 低频作答下，日历日可能大量空桶（参照 `weekly.ts` 的 UTC 日桶），按 attempt 序可能更稳——owner 拍。

2. **留白2 — 跨 KC 迁移的形态**：「在 A 练的迁移到 B」这个信号怎么 felt（相邻 KC 联动高亮 / 子图热力 / 单独迁移列表）？数据怎么定义「迁移」（相邻 prerequisite 边上的 KC 同期抬升）？本期可只在契约预留，形态 owner 拍。

3. **留白3 — 来源二态是否本期做**：趋势是否本期就区分硬轨 firm-up vs 软轨 prior-echo 成分（⑥硬约束第 4 条），还是先只画硬轨真实作答轨迹、prior-echo 留后续增量。

4. **留白4 —【brief 指定】开放题为主科目的替代可视化**：开放题为主的科目（如人文 / 主观题型科目）IRT 三量（能力 θ̂ / 难度 b / 区分度 a）会全退化——干净二分作答证据稀薄，`theta_delta` / `p_learned` 信号失真甚至无效。这类科目的成效要怎么可视化？候选：**owner 自评趋势**（owner 周期性自评「这科我感觉相对上次涨了吗」作为输入）——但**这个自评趋势的输入 modality 完全未定义**（什么时候问、问几档、存哪、和系统 θ̂ 轨迹怎么并置）。**这是 owner 必须拍的设计空白**，claude design 在视觉稿里需为「系统算不出三量的科目」留一条平行的、以 owner 主观输入为主的趋势表达路径。

## 边界提醒（给实现者，非 claude design）

- **落点（2026-06-28 修正）**：用户面落 **Coach 复盘中枢的「成效趋势」视图**（见上节落点 IA），**不是** admin 侧——原「observability/admin 侧」落点已被 owner 拍定推翻。后端**读模型**仍挂 observability 包（`effectiveness-trend.ts`，与 `calibration-maturity.ts` 同形态，纯 drizzle 读、零写）；前后端分离：读模型在 observability，用户面在 Coach。
- 动 UI 代码前仍走项目 design-doc pre-flight；本 handoff + claude design 视觉稿 = pre-flight 的输入。

## 基础设施缺口（✅ 已解决 — YUK-519 / PR #664）

> **2026-06-28 更新**：下述「成效层纵向聚合读模型」已建 = `src/capabilities/observability/server/effectiveness-trend.ts` + `GET /api/observability/effectiveness-trend`（YUK-519，PR #664 待 merge）。纯读零写、沿 `effective_domain` 派生轴 per-subject 卷起、⑥ 置信不裸 delta、用 θ̂（logit 线性）非 p(L)（sigmoid 压缩方向）。**视觉稿回来即可落 live 读模型**。以下为原缺口记录（留作背景）。

**成效层纵向聚合读模型——（原）当前不存在，是本 handoff 的数据前置。**

- **现状**：`experimental:mastery_progress` 事件（per-KC、per-attempt 的 Δθ̂ / p(L) / θ̂ + `created_at`）在持续落库（`mastery-progress-signal.ts:105`，两个 emit 站点 solo `submit.ts` + paper `paper-submit.ts:835`），但**没有任何读路径把它们聚成纵向时间序列**。唯一引用者 `note-refine-triggers.ts:191` 只在注释里提及、不聚合；`weekly.ts:100` 的 daily trend 是活动量 / 正确率趋势，**不是** mastery delta 轨迹。grep 确认零纵向聚合读路径。

- **要建**：一个**只读聚合读模型 + endpoint**（形态参照姊妹 `loadCalibrationMaturity` / `calibration-maturity.ts`，挂 observability 包），把零散 `experimental:mastery_progress` 事件按 `subject_id`（KC）+ `created_at` 聚成：
  - **per-KC 时间序列**：按 `created_at` 升序的 `p_learned` / `theta_hat` / `evidence_count` 轨迹点。
  - **per-KC 趋势摘要**：方向（rising / holding / falling / insufficient）+ 置信（low / …）+ 证据量——**遵守 ⑥硬约束，绝不输出裸 delta**。
  - **per-subject 卷起**：沿 `knowledge.domain` → `effective_domain` 派生轴（项目铁律：科目是派生视图，不在事件 / KC 上存列）group 出整科趋势。
  - （留白2 待定）**跨 KC 迁移信号**：相邻 prerequisite 边上的 KC 同期抬升检测。

- **红线**：纯读 + 聚合，零写路径——绝不写回 `mastery_state` / `item_calibration` / FSRS（同 `mastery-progress-signal.ts:18-20` 三轴正交红线）。

- **依赖关系**：这是 claude design 视觉稿落地的**数据前置**——视觉稿可以先出（基于本 handoff 描述的信息可供性），但 slice-by-slice 实现前，此读模型必须先建。

- **建议**：作为形态轴 epic（YUK-354）下成效趋势面工单的**第一个子工单 / 技术前置**，与 claude design 视觉稿并行起跑。

> 草案见本 handoff 返回消息——交 team-lead 汇总后建 Linear issue（不在本分支直接建）。
