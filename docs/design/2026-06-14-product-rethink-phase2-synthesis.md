# 整个产品重新想 · Phase 2｜综合（推荐产品架构 + 路线图 + gap/risk）

> **这是什么**：「整个产品重新想」三阶段的终局综合。Phase 0 现状地图 × Phase 1/1.5 大调研 × B1-B5/A1-A4 决策总账 × GPT 外部稿 → 推荐目标架构（形态/算法/内核）+ 依赖排序路线图 + gap/risk/有效性天花板 + 需 owner 拍的硬决策。
>
> **生成**：2026-06-14，workflow `product-rethink-phase2-synthesis`（全 opus，5 agent，~489k tokens）。4 路并行综合（form/algo/roadmap/gap-risk-critic）→ 1 路 cross-统合（有否决权的全局整合者）。
>
> **配套**：决策总账 `2026-06-14-product-rethink-decisions-ledger.md`（拍板留痕，最高权威）/ Phase 0 `...phase0-current-map.md` / Phase 1 `...phase1-research.md` / Phase 1.5 `...phase1_5-relations.md`。四路 lane 原始产出存档于 `...phase2-synthesis-lanes.md`。

---

I now have all four input documents fully grounded, plus the four downstream syntheses (form / algo / roadmap / gap-risk-critic). I have everything needed to produce the single coherent cross-统合 architecture document. I'll arbitrate the conflicts, deduplicate, and fill the global gaps the four lanes missed.

Let me compose the final synthesis. This is the terminal cross-统合 output — it becomes the body of the Phase 2 recommended architecture document.

---

## §1 一句话产品定位

> **这是一个单用户（n=1）的 AI 学习工具：人保留裁决权与方向盘，AI 作为唯一编排者（D14）每天/每刻从全量学习状态里策展出一条有理由的学习主线——把「编排」这件劳动从人身上收归 AI，把全貌降为可下钻的次级上下文，所有 AI 写入 propose-only、可追溯、可回滚。**

把三轴正交 + 克制策展 + 慢热自校准三个拍板词拼成一句话：

- **它不是什么**：不是聚合仪表盘（把所有状态平铺给一个全知用户，让用户自己编排）；不是多用户 SaaS；不是一个「万能掌握度模型」。
- **它是什么**：一台**证据驱动的策展引擎**。底层四个表征各管各（`R` 记忆调度 / `p(L)` 掌握诊断 / `mem0` 个性化软画像 / `KG` 结构），上层由单编排者 D14 把它们合成为「今日之线」「练习流」「inbox 裁决」三个面里的一句话主线 + 一个可下钻全量。
- **认识论的诚实底色**：owner 是唯一 n=1 真人，没有 cohort 基线。所以这个产品的所有「掌握度」「难度」绝对值长期低置信——**它对外承诺的是「相对排序可信、绝对值不可信」，靠 owner 真实作答（尤其客观题确定判分）逐步成为 ground-truth 锚点慢热自校准**。跨科开放/主观题型（作文、论述、鉴赏、古文翻译等）因 LLM 估难度差、judge 归因软，算法层强承诺（诊断/标定/误区/verify 闭环）基本无效——这是不计代价也买不到的有效性天花板，如实标在产品定位里，不藏。

一句话收束：**「克制的策展 + 三轴正交的证据底座 + 慢热的自校准」三者合一——AI 替你想、替你排、替你盯，但每一步都留痕、可撤、可问『为什么』，且诚实告诉你哪里它其实不知道。**

---

## §2 推荐目标架构 · 形态层

> 形态层主线：四个面（A1 入口 / A2 练习 / A3 AI 角色 / A4 读vs判）是**同一个反模式的四个切面**（把编排甩给用户），也是**同一个应然动作的四个落点**（AI 从全集选一小撮 + 给理由 + 留全量可下钻 + 留可逆出口）。A4 的 A/B/C 出手强度表不是第四个面，而是**贯穿前三个面的统一出手契约**——它的契约定义归 §4，这里只讲它在 inbox 的落点。
>
> **全形态层硬边界**：本架构只到产品/feature 层（结构形态），像素/微交互层整体留白，四面视觉稿后续交 claude design。本文是 design handoff 的功能输入（零风格规定），不是可直接实现的交互规范。

### 2.1 A1 · 一天入口 `/today`

**现状**：`TodayPage.tsx` 是聚合仪表盘（`hero → kpi-row → 今日之线 → dash-grid`）。「今日之线」阉割——只能从 `/api/workbench/summary` 派生 2 缕（复习/裁决），全零不渲染；夜链交班缕缺位。Copilot CTA 是死占位（toast 指旧页）。数据中枢 `workbench-summary.ts` 仍靠构造 internal Request 调 `handleReviewDue`。

**目标**：`/today` = AI 策展的「今日之线」四层（自上而下）：

| 层 | 内容 | 数据来源 | 性质 |
|---|---|---|---|
| ① 交班缕 | 夜链 forethought：昨夜 D14 后台 job 跑出的「我帮你想了什么」 | event 派生（先轻：可解释 event readable；后叙事化） | 叙事开场，先轻后叙事 |
| ② 今日主缕 | AI 策展 3-5 候选缕，每缕 = 一条有理由的学习主线 | B3 合并引擎产出（物化进 `practice_stream_item`）+ mem0 prior | 主推面 |
| ③ 次级副歌 | 旧 4-strip / KPI-row / 周热力 | summary 聚合 | 降级为可下钻，默认折叠 |
| ④ 完成度收尾锚 | 一天结束的完成度回收 | `practice_stream_item` done 状态派生 | 收尾闭环 |

**关键约束**：缕数封顶 5、上限内 AI 动态 1-5（防凑数防波动）；**策展 ≠ 隐藏**——主推 3-5 缕但全量永远可下钻（次级副歌就是全貌入口）；交班缕先轻后叙事（叙事化时机见 §7 待定项）；三 hero CTA 从「主入口」降为「常驻动作类型快捷」（今日下一步在主缕里）。

**delta**：① 改 `TodayPage.tsx` 布局重排为四层；② 建交班缕读模型（聚合后台 job 产出，按 actor_ref 分轨）；③ 接 B3 合并引擎产出（`/today` 是展示落点不自己编排）；④ 拆 Copilot CTA 死占位（Copilot 是常驻 Drawer 全局入口，不需 Today 局部 CTA）；⑤ 4-strip/KPI/周热力折叠进次级副歌。

**算法信号接口**：今日主缕 3-5 缕 ← B3 合并引擎（**FSRS *when* 不进 AI**，缕内「到期必复习」是确定性硬约束）；交班缕 ← 后台 job event 派生；完成度锚 ← `practice_stream_item` done；每缕的「理由一句话」← B1 p(L) 离散档（**置信区间/低置信标记，非干净「掌握度=78%」**）。

### 2.2 A2 · 练习旅程 `/practice`（流为脊柱）

**现状**：`PracticeFacePage.tsx` 实际只有 2 个顶层 view（`stream | shelf`）+ mode 子状态（paper/retro/散题）——**不是设计稿宣称的五平级状态机**，已是「流为主 + 卷架为存档」的雏形但叙事未理顺。AI 调度未接进：三套近重复手抄 FSRS-due 选题（`due-list`/`review-session`/`stream-store`）；AI `review_plan` 另开 paper channel（ADR-0029）旁路。复盘是流内 retro mode，无周期性留存校验、无自校准 UI。

**目标**：流（stream）= 脊柱与默认入口，其余四态从流派生/回流：

```
            ┌──── 流（默认入口，B3 合并引擎产出今日缕）────┐
       作答动作 ↓                                  存档 ↓
   散题（流内单题）  卷（流内 paper，节目化）      卷架（持久归宿，回看入口）
            │            │                            │
            └─── 回流 ───┴─── 事件触发 ──→ 复盘（B1 自校准 UI 落点）
```

- **散题/卷** = 作答动作（流内单题 / 节目化成组），非独立视图；**卷架** = 存档与回看入口（D12，已在 `?view=shelf`）；**复盘** = 从流事件触发回流。
- **block↔interleave 由 B1 p(L) 掌握阶段驱动**（新知 block / 巩固 interleave），用户可 override；切换阈值 = 产品决策 + 埋点（**不声称文献规定**）。
- **复盘 = 事件触发 + B1 自校准 UI 落点**：触发 = 掌握阶段跃迁 / 每 N 次（非随时手动跳）；内容 = 考 R 留存（延迟复测）+ transfer 换情境（迁移测，补 GPT 稿盲点防假学习）；认识论角色 = owner n=1 真实作答成为 ground-truth 锚点的入口（B1 fixed-anchor 自校准 UI 落点），日常流给轻量回执不打断。

**delta**：① 接 B3 合并引擎 `composeDailyStream` 物化进 `practice_stream_item`（接通「AI 调度旁路」张力）；② 叙事从「stream/shelf 二 view」理顺为「流为脊柱 + 四态派生」（代码已是雏形，主要是产品叙事 + 复盘回流接线，非重写状态机）；③ 建 block↔interleave 模式标记（读 B1 p(L) 阶段 + override 控件 + 埋点）；④ 建复盘事件触发器 + 延迟复测/transfer test 题型 + 自校准回执 UI；⑤ 保留 `variant-rotation.pickProbeForKnowledge` 作复习侧 selector 子步骤。

**算法信号接口**：流的缕排序与配比 ← B3 合并引擎（复习配比 = AI 每日建议，`review_plan` 退化为 proposer）；block vs interleave ← B1 p(L) 阶段；复盘延迟复测 ← FSRS R，transfer 换情境 ← B1 transfer credit（**只进 p(L)，不碰 R/调度**）；复盘自校准残差 ← B1 fixed-anchor；流为空 ← B3「空 frontier LLM 填充」（低置信 propose-only，需定空态形态）。

### 2.3 A3 · 单编排者 + hint-first

**现状**：前台 Copilot（D14）= 唯一对话 agent，常驻 Drawer 根挂，第一人称署名「我」；后台 `agency` 4 个独立 job handler（dreaming/coach_daily/coach_weekly/goal_scope）各有独立 actor surface，**4 个 agent 人格互不知情**。`ambient_context` 只在 `chat.ts` 私有入参喂 Drawer（雏形未成契约）。张力：CORE_TOOLS bootstrap 全量 40+ 先到，copilotTools 贡献制实质 no-op。

**目标**：单编排者 D14 = 前台 Copilot + 后台 4 job 合为同一个编排者的不同**召唤姿势**（actor_ref 分轨保可观测）：

| 召唤姿势 | 形态 | actor_ref |
|---|---|---|
| 前台 Copilot | 常驻 Drawer，自由对话 / 点 chip | `copilot` |
| 夜链 dreaming | 后台 forethought，产出交班缕 | `dreaming` |
| coach daily/weekly | 后台规划/回看 | `coach` |
| goal scope | 后台目标范围提议 | `goal_scope` |

- **统一叙事**：四姿势对用户讲连贯故事——前台对话能引用昨夜后台想的（交班缕），后台 job 写会话级工作记忆供前台读。合为一个叙事 ≠ 丢可观测性，留痕仍按 actor_ref 分轨。
- **自主滑块默认 hint-first**：inline 解题默认给提示而非完整解，可一次性走到完整答案后交还用户控制（防 Khanmigo 强制 Socratic 教训）。提示阶数待 owner 拍（§7；GPT 稿 Hint Ladder H0-H5 可直接借为起点）。
- **上下文升级两层正式契约**：

| 层 | 是什么 | 存储 | 读写 |
|---|---|---|---|
| (a) 会话级工作记忆 | 当前面 / focused_entity / 上一轮练习结果 / 刚 dismiss 哪条 | Postgres | 所有 surface 写入，编排者读取 |
| (b) 长时 attention prior | mem0 个性化软画像 | mem0（自管 pgvector） | 编排者只读旁路，永不偏置 judge/FSRS |

防循环注入五防必守（注入事实非上一轮 prompt 装配物 / ambient 不进历史 / 鲜读 digest 不进历史 / 双层截断 / 专项单测）。

**delta**：① 建会话级工作记忆契约（把 `ambient_context` 从私有入参升格为所有 surface 共写、编排者共读的正式表，纳入「刚 dismiss 哪条」直接服务 A4 的 B 档 dismiss 回流）；② 接长时 attention prior 走 mem0 P3 读路径（§3 B4 `searchMemories` wrapper，只读旁路）；③ 建自主滑块（inline hint-first 控件 + 「交还控制」出口）；④ 统一叙事接线（交班缕读后台 job 产出，前台对话能引用）；⑤ 收口 copilotTools 贡献制 no-op（属内核轴但影响 AI 工具面真相源）。

**算法信号接口**：编排者读取的信号 ← B3 合并引擎输入；长时 attention prior ← B4 mem0（accepted semantic-trait 经 gate + episodic 全自动）；hint-first 提示内容 ← 题的 p(L) 难度档 + 错因（若 RT1 misconception 已晋升可指向具体误区）。

### 2.4 A4 · 读 vs 判（inbox 落点）

**现状**：两类 AI 输出面——`/inbox`（人审闸口，需裁决）vs `/agent-notes`（纯旁观 read-only）。inbox `KIND_META` 17 个 kind 全部走同一条逐条 accept/dismiss lane（doc 称 18，差异不影响裁决）。三个 kind（`defer`/`archive`/`judge_retraction`）只能 dismiss 不能 accept（accept applier 未实现，YUK-44）——它们本质不是「需人审的结构写入」，是状态/旁观动作却占着裁决 lane。

**目标**：按「可逆性 × 后果」分三档（契约定义见 §4）：

| 档 | 形态 | 落哪些 kind |
|---|---|---|
| A 自动 + 撤销窗口 | 后台静默应用 + 顶部可撤销提示，不进 inbox lane | 静态可逆性兜底选出的安全 kind（如 record_links / 某些 completion） |
| B 逐条人审 | inbox lane（现状 accept/dismiss） | knowledge_node/edge/mutation、variant_question、learning_item、relearn、goal_scope、block_merge、question_draft/edit 等真裁决项 |
| C 纯状态不进队列 | 移出裁决面 | defer→snooze 控件 / archive→直接软归档 / judge_retraction→agent-notes 旁观 |

**关键约束**：A 档 kind 用**静态可逆性兜底，不靠 confidence**（confidence 数据基础不足，现状只覆盖 1/18 kind 且校准从未验证）；**单用户硬顶熔断**（单位时间 auto-apply 上限超限退回全人审，护栏两层语义的 A 档落点）；指标落两档健康信号（A 档 revert 率 / B 档 dismiss 率），**不追抽象 appropriate-rate**（无法 n=1 校准）。

**delta**：① 为每个 inbox kind 标注 A/B/C 档（静态可逆性判定，非 confidence）；② 建 A 档自动应用通道（静默 apply + 可撤销提示 + 一键 revert + 单位时间熔断）；③ defer/archive/judge_retraction 移出 inbox lane（同时解决「三 kind 只能 dismiss」死占位——不是补 accept，是它们本就不该在裁决面）；④ 建两档健康信号埋点；⑤ B 档 dismiss 写会话级工作记忆（编排者下次不重复同类提议）。

**算法信号接口**：A 档可逆性判定 ← 静态规则（kind 级，零算法依赖，**可立即做**）；mem0 extraction gate（§3 B4）走同一 A/B/C 契约（semantic-trait → B 档 / episodic → A 档）；错因晋升 propose（RT1）→ B 档，但 gated 在一致性闸地基之后。

### 2.5 四面统一速查

| 面 | 现状反模式 | 目标 | 统一动作 | 算法接口 |
|---|---|---|---|---|
| A1 /today | 聚合仪表盘 + 3 hero CTA，今日之线只 2 派生缕 | 四层今日之线 | AI 选 3-5 缕 + 理由 + 全量可下钻 | B3 引擎 / B1 p(L) 档 / 后台 job event |
| A2 /practice | stream/shelf 二 view，AI 调度旁路 | 流为脊柱，四态派生回流 | AI 排今日缕 + 一句理由 | B3 what+mix / B1 block-interleave / FSRS R + transfer 复盘 |
| A3 AI 角色 | 4 互不知情人格 + ambient 私有入参 | 单编排者四姿势 + 两层上下文契约 | hint-first 自主滑块 | B4 mem0 prior 只读 / 五防 |
| A4 读vs判 | 17 kind 均一钉死 accept | A/B/C 三档 + 三 kind 移出裁决 | 静态可逆性兜底 + 两档指标 | 零算法依赖（可先做）/ B4 extraction gate 同契约 |

**贯穿性接线**：会话级工作记忆（A3）是 A4「刚 dismiss 哪条」的载体；交班缕（A1）是后台 job（A3）的展示落点；复盘（A2）是 B1 自校准的 UI 落点。四面经 D14 单编排者 + A/B/C 契约 + 两层上下文串成一个连贯叙事。

---

## §3 推荐目标架构 · 算法数据层

> 算法层主线（与形态层共识）：**不造新引擎、不引图库、不上 bi-temporal**。把已长在仓库里的对的骨架（FSRS 卡 / event 溯源 / prereq 边 / mem0 调和层 / rubric-validator 语义闸）收敛成一致形态，把「写了没人读 / 占位公式浪费 / 旁路未接通」的资产真正接通——一条「收敛 + 接通」主线。

### 3.1 掌握诊断三维（B1）

**现状（grounded）**：双脑分裂无对账——调度只认 `material_fsrs_state.due_at`，展示/AI 用 `knowledge_mastery` PG view（`schema.ts:806`），从不互相校准。占位公式硬伤：view DDL（`drizzle/0005...sql`）30 天半衰期（line 22）+ `evidence_count < 3 THEN 0.5::real`（line 61）+ 纯加权比值（line 62）——头三条证据一律假装 0.5、无先验、第一条证据不更新。

**目标**：掌握 = 三维分层、共享潜量、对外折叠成单标量 + 离散档 + 置信区间：

1. **R（FSRS 记忆）** —— 不变，喂调度，per-item，单 writer（ADR-0005/0011/0012）。
2. **p(L)（PFA logistic 掌握诊断）** —— 新建派生层取代 view 占位。`logit(p) = β_kc + γ·success_count + ρ·fail_count`，**有先验**（β 来自 `item_calibration` 难度锚），**第一条证据就更新**（删 `evidence<3→0.5`）；**含 transfer**（RT2 credit 注入）。
3. **difficulty（共享桥）** —— FSRS `D` ≡ PFA `β`，**同一潜量两层读**。共享 `item_calibration` 后验难度锚，但**各自更新各自状态**（D 走 FSRS review，β 走 PFA 梯度，不互写）。

呈现口径：**置信区间/低置信标记**，慢热期一律低置信只信相对排序。

R 与 p(L) 背离重定义为 **fluency-illusion 防假学习软提示**（非 error-grade，不触发任何自动修正，只在复盘面提示「这点你近期答得顺但间隔拉长后留存可能虚高」）。

### 3.2 LLM 标定分轨（B1 标定）

**目标**：走全诊断栈但分轨——

- **硬轨（可 n=1 自校验）**：IRT 难度 `b` + 知识点 `θ`，仅客观题（答案对得上语料即确定判分，闭环可自校验，owner 客观题 = 干净 ground-truth 锚）。
- **软轨（标低置信）**：区分度 `a`、猜测 `c`、CDM、KT、开放/主观题型——`a/c` 是 n=1 认识论死路（Stocking 1990，需大样本跨考生方差才可辨识，单用户结构性不可辨）；全部标低置信、隔离呈现、绝不进硬轨自校验闭环。

**LLM 标定方法**（实证驱动，不 prompt 直接估）：不直接 prompt 估难度（实证 `r≈0`）；LLM 抽教学特征（`r≈0.78`，抽认知负荷/步骤数/概念深度回归到难度）+ LLM 模拟考生 ensemble（客观题 `r=0.75-0.82`，多 persona/弱模型优先反推难度）。

**零成本基线 gate**：全合成标定 vs「题型/知识点难度历史均值」朴素基线 head-to-head，不显著赢就回退轻量基线（算法侧的「不计代价 ≠ 不计有效性」执行点）。

### 3.3 自校准慢热四阶段（B1，时间序列不能跳）

| 阶段 | 信号源 | 置信 | 机制 |
|---|---|---|---|
| ① 纯 LLM 先验 | LLM 抽特征 + 模拟考生 | 全低置信，只信相对排序 | 冷启动；难度/θ 仅排序不报绝对值 |
| ② Elo/Urnings 追 θ | owner 真实作答 | 中 | O(1) 更新 θ，**锁 item 难度防方差膨胀**（单用户稀疏，同时动 θ 和 b 会发散） |
| ③ fixed-anchor + PPI + 三自检 | owner 客观题确定判分 | 中高（硬轨） | fixed-anchor 残差 = miscalibration 信号；PPI 数学保证「合成标定 + 真答」≥ 只用真答；active learning 选题（Fisher info p≈0.5 + 先验分歧最大） |
| ④ per-knowledge 滚动解锁外推 | 达标知识点 | 该点高置信 | 某知识点客观题锚足够后才允许校准外推到该点开放题 |

### 3.4 调度合并引擎（B3）

**现状（grounded）**：三套近重复 FSRS-due 选题逐行手抄；AI `review_plan` 另开 paper channel（ADR-0029）不接进 due 选题；`variant-rotation` 自称「唯一 seam」但 AI 没接进；frontier 无一等公民实现。

**目标**：一个 AI 编排引擎通盘吃 → 产今日流，输入 = `FSRS due（R）+ frontier（KG）+ mastery p(L) + mem0 prior + AI 判断`：

- **合并 what + mix，FSRS when 数学不并进 AI**（独立真相源）：AI 决定 what（学哪些）+ mix（block↔interleave 配比、新知/巩固比），FSRS 决定 when（AI 只读 due 列表作约束输入）。
- **三约束**：① 确定性硬约束嵌入（到期必复习/孤儿 draft 排除作 hard constraint，**AI 不能违反**——见 §4 正交破口处置）；② 可解释可追溯（每条流项带 AI 理由，接 propose-only 留痕三表）；③ fallback（AI 挂了退化到确定性 due 队列）。
- **frontier 一等公民**：`learnable_frontier` = prerequisite-gating 递归 CTE（已有 prereq 边 + 一条 CTE，不重建 ALEKS 全局 knowledge space）；**空 frontier LLM 填充**（图稀疏/冷启动时 LLM 用语义 + 课程结构猜临时 frontier，低置信 propose-only，慢热被真实边替换）。
- **退役**：`review_plan` job 退役并入引擎（从 separate paper channel 降为引擎的 proposer 角色或全删，**ADR-0029 被推翻需 supersede**）；三套手抄收敛到单一 picker；**FIRe 已砍**（A 面涨掌握由 B1 transfer credit 做；B 面抵扣 due 砍——地基软仅 justinmath.com 无学术论文 + 耦合 R 制造信号混乱；信号保持正交）。

### 3.5 关系结构（双层异构图 · RT1-4）

**核心裁决**：双层异构图（**否决 GPT 三层平行图**）——树骨架（`parent_id` 只读）+ 同构 typed-edge 网（5 核心）+ 渐进晋升的 misconception 异构层。三层分离：身份层 / 观测层（event 唯一真相，错因现活这）/ 派生层（mastery/credit，不写回）。

- **RT1 错因图谱**（晋升而非复制）：同 effective_cause 同知识点跨 attempt 复现 ≥k 次 → 调和环 propose『晋升为 misconception 节点』→ 人审 accept 才建；只出现一次的永远留 event 层。独立 `misconception` 表（**不进树、不加 subject 列**——科目经 caused_by 指向的 knowledge 节点 effective_domain 派生）+ `misconception_edge` 异构边（caused_by / confusable_with / observed_in / remediated_by）。SISM 措辞收紧为「并列/可共存建模」（非统计独立）。误区节点**不持独立掌握度/独立调度**（remediated_by 复用 FSRS 管线做复习偏置）。**gated 在一致性闸地基之后**（§3.6）。
- **RT2 credit**（派生量不物化回边）：复用 prerequisite 反向遍历（to→from）+ `encompassing_weight` nullable 列，`weight × encompassing_weight` 连乘衰减递归 CTE 算 implicit evidence；**不新建 encompasses 边、不新建第六 relation_type**；**credit 进 p(L) 不进 R/调度**。tree parent 链向上 rollup（科目/簇掌握%），prereq 反向向下 credit——两个算子两组边两个方向不混。
- **RT3 题型**（不建图）：`question.kind` 字段 + `SubjectProfile.judgePolicy.routeByKind` 配置；题型→知识点 = `question.knowledge_ids[]`（策划标注非统计推断）。
- **RT4 治理**：5 核心 `relation_type` 闭集 + `experimental:*` 受闸逃逸阀；`weight` 钉死 confidence-only（grep 证实无 strength 消费路径，strength/salience 留 future 第二列）；promote = experimental→Core 走 migration + ADR 摩擦（四闸：频次≥N / pgvector 语义内聚单峰 / 类型签名可声明 / 可泛化跨数据集，promote/pass/fail 作 event 留痕）；新增 `audit:relations` 脚本。**rubric-validator 比假设成熟**——`related_to` 加严是微调阈值（已实现，非新建）；新增的是拓扑层闸（归 §3.6）。

### 3.6 一致性闸地基（YUK-344 重定向，priority High，独立前置 · 全悬空树根）

**现状（grounded 复核）**：bi-temporal 完全未落地（`knowledge_edge` 只有 `archived_at` 单轴软删，无 `valid_at/invalid_at`）；`getEffectiveTruth` + `CorrectionKind` 实现完整但作用域在 EVENT 层（practice 包），不是知识节点/边的事实时效；**写入期结构一致性闸（环检测/方向矛盾/传递冗余）代码侧零实现**（grep 复核：`cycle/direction/transitive` 在 `src/capabilities/knowledge/` 与 `src/server/` 零命中）。

**目标**：YUK-344 从「补双轴」重定向为「一致性闸地基」（bi-temporal 推翻：结构是 timeless 不变量，「不再为真」≈ curation 纠错 epistemic 轴而非 valid-time，单用户不问历史结构态，**YUK-344 原第一条被推翻**）：

1. **写入期结构一致性闸**（补 rubric-validator 语义闸之外的拓扑层）：环检测（prereq 不得成环，hard-reject）/ 方向矛盾（A prereq B 且 B prereq A，hard-reject）/ 传递冗余（A→B→C 已存在时拒绝/降权直接 A→C，warning）。
2. **写入期调和环**（复用 mem0 P2 reconcile 骨架设计，挂进 `runProposeAndWrite`）。
3. **取代复用 CorrectionKind**（epistemic 纠错走 correction event，不引 valid-time）。

**这是 RT1（misconception 晋升环）/ RT2（传递冗余拦截）/ RT4（四闸③类型签名）共同前置，代码侧零实现**——闸不就位，所有升一等实体 / promote / credit 物化全悬空。它本身 `blockedBy YUK-342`（共享 P2 reconcile prompt 骨架）但 **YUK-342 P2 已 live，前置已满足，可立即起跑**。

### 3.7 记忆 P3 + extraction gate（B4）

**现状（grounded）**：P1+P2 已 live（mem0ai 3.0.6 in-process + 自建调和层 + jsonb 软取代 `superseded_by`/`invalid_at`）；落自管 pgvector collection（不在 Drizzle，audit:schema 看不到）。**P3 读路径完全未落地**——`searchMemories` wrapper 全仓 grep 无果，两读点（`search_memory_facts` 工具 + brief `searchFacts`）不过滤 P2 已软取代的 fact（被取代的记忆仍被检索甚至固化进 brief，软取代是「写了没人读」的半环）。

**目标**：
- **P3 读路径接通（task #23）**：`searchMemories` wrapper = topK 放大 + superseded 过滤 + recency 半衰期重排；两消费者透明获益。
- **喂信号收窄**（三轴正交升级架构红线）：**携带自然语言陈述的 event 才喂 mem0；数值留结构表**（mem0 本就不从数值推断）。
- **mem0 extraction gate**（全局出手强度表 A/B/C 的算法侧落点）：semantic-trait（偏好/习惯/弱点）→ **B 档 accept gate**（pending + 来源 episodic 事件链 + 时间戳 + 一键 reject/edit，编排者只读 accepted）；episodic 客观事件 → **A 档全自动可撤**。证据：Gharat WSDM'26（记忆 summary 73.17% 有偏）+ Jiang AIES'19 + Sharma ICLR'24 + Chaney RecSys'18（顶会）。诚实标：「semantic 比 episodic 更易固化」无 head-to-head 直证，是机制 + 间接实证推断，gate 是保守防御非已证最优。
- **透明视图 + 一键 retract**：「AI 关于你的记忆」面。

### 3.8 出题 verify 契约（B5）

**现状（grounded）**：三套不一致信任闸（OCR-path 弱链单信号 / QuizGen-path 五轴多信号 gate / Variant-path accept-first 反模式）；题 draft→active 经 Option B 验证闸才 enroll，`auto-enroll` 默认 observe-only（enroll 真入库分支生产从未跑过）。

**目标**：
- **统一 verify 契约 = Verifier Router**（GPT 稿吸收）：三闸收敛到 QuizGen 五轴多信号模板，统一 verify-then-promote。
- **plan-then-generate + 客观题确定性校验**：答案对得上语料即放行，不烧 LLM 再问一次（接 B1 客观题 anchor）。
- **item-model 变式**：人 accept 模板 / 代码确定性实例化，杜绝所见≠入库；Variant 翻转 verify-then-promote；auto-enroll source-tier 灰度（先 authentic + 客观题 + 确定校验通过）。
- **QuizVerify 扩 'error' 通道**（区分 transport/parse 失败 vs 真实 verdict）——**独立无依赖，先做**。

### 3.9 Schema 落地清单

| 表/列 | 动作 | audit:schema | ADR |
|---|---|---|---|
| `item_calibration` | 新表（硬轨 b/θ 高置信列 + 软轨 a/c/cdm/kt 低置信列 + confidence + track + source） | 是（软轨列慢热期长期 NULL → allowlist `resolves_when: phase`） | 需（掌握诊断三维：R⟂p(L) 不对账 + PPI/fixed-anchor + 零成本基线 gate） |
| `mastery_state` | 新表（取代 view 占位：p_l + ci + success/fail_count 含 transfer + beta 桥 + calibration_residual + fluency_illusion_flag） | 是（慢热阶段未启用列 → allowlist `resolves_when: phase`） | 需（推翻双脑分裂隐含设计，同上或独立） |
| `misconception` | 新表（gated 闸后；不进树不加 subject 列） | 是（gating 期表空 → allowlist `resolves_when: phase`） | 需（RT1 一等实体是 KG 本体变更） |
| `misconception_edge` | 新表（experimental；多态 vs 四窄表待 owner 拍） | 是（allowlist `resolves_when: phase`） | 需（同 RT1，异构边破坏同构性需记 rubric-validator 平行闸成本） |
| `knowledge_edge.encompassing_weight` | 加列（仅 prereq 行有意义，NULL=不可 trickle-down） | 是（触发 write-path，需新 propose 子类型=属性更新非新边 → allowlist `resolves_when: pr`） | 需/并入 RT2 |
| mem0 P3 / extraction gate pending | wrapper + gate（pending 存哪待拍） | 视 pending 落 PG 与否（落 PG 进 audit，落 mem0 metadata 需文档兜底） | 建议（memory-architecture §修订） |

---

## §4 内核 / 三轴正交契约

> 这是整个架构的不变量层。四个表征各管各、永不互相对账写回；A/B/C 出手强度表是统一出手契约；既有七条红线延续。

### 4.1 三轴正交红线（R ⟂ p(L) ⟂ mem0 ⟂ KG）

| 轴 | 实体 | 回答 | 喂谁 | 物理载体 | 边界 |
|---|---|---|---|---|---|
| **R**（FSRS 记忆维度） | `material_fsrs_state`（知识点 keyed，ADR-0005 单 writer） | 记得牢不牢 / 何时复习（when） | 调度（per-item due） | PG 表，FSRS 数学单一真相 | **不被 transfer credit / accuracy / mem0 污染** |
| **p(L)**（PFA 掌握诊断） | `mastery_state`（新，派生） | 此刻会不会 / 迁移得了吗 | 诊断展示 + 调度 what 信号 | PG 表/物化 | **含 transfer credit；与 R 不对账（背离只做 fluency-illusion 软提示）** |
| **difficulty**（共享桥） | FSRS `D` ≡ PFA `β` | 这个知识点/题多难 | 两轴共享输入 | 派生 + `item_calibration` 锚 | **唯一允许的跨轴共享：共享输入，各自独立估计，不共享估计值（见 §6 C4）** |
| **mem0**（个性化软画像） | mem0 collection（不在 Drizzle） | 偏好/习惯/弱点（attention prior） | 编排者只读 | 自管 pgvector | **永不偏置 judge/FSRS；只读旁路非真相源（ADR-0017）** |
| **KG**（结构） | `knowledge` 树 + `knowledge_edge` 网 + `misconception` | 知识怎么组织 | frontier / credit / 对比题 | PG 表 | **树只读不动；边 confidence-only；misconception 不加 subject 列** |

**红线落地三条**：① R ⟂ p(L) 不对账（Bjork 失用新论：storage strength 与 retrieval strength 可双向解耦，健康间隔学习本就规律性背离）；② transfer credit 只进 p(L)，FSRS when 数学绝不被 credit 污染；③ difficulty 是唯一允许的跨轴共享，但**是「同一输入喂两个独立估计」不是「同一个估计两处读」**（这条 §6 C4 标为潜在破口，需 ADR 明文钉死）。

### 4.2 全局出手强度表 A/B/C（统一出手契约）

D14 单编排者对所有面（inbox kind / mem0 extraction / inline 动作 / Today 交班缕 / 练习流提议）的统一出手契约，按「**可逆性 × 后果**」分三档：

| 档 | 语义 | 判据 | 指标 |
|---|---|---|---|
| **A 自动 + 撤销窗口** | 乐观应用，不打断不强制确认，留一键 revert + 单位时间熔断退回全人审 | **静态可逆性兜底，不靠 confidence** | revert 率 |
| **B 逐条人审** | 结构性/破坏性写入逐条裁决 | 静态判定为不可逆/高后果 | dismiss 率 |
| **C 纯状态不进队列** | 不是写入提议，是状态/旁观动作 | 本就不是结构写入 | 不入队列 |

**关键原则**：A 档判据是「静态硬判据先行、软 confidence 后迁」——先用零成本硬判据（kind 可逆性表）拿 80% 价值且完全可解释，软 triage 推迟到埋点观测真实分布、confidence 校准验证后。**单用户没有第二个审计人**，所以 A 档门槛必须比工业 HOTL 更严（熔断）。这是 §2.4（inbox）、§3.7（mem0 extraction）、RT1（错因晋升 → B 档 gated 在闸后）三处的统一契约。

### 4.3 既有红线延续

七条产品红线（locked，§5 Phase 0）+ 既有工程红线一并延续：evidence-first（AI actions 可追溯，runs log 到 `src/server/ai/log.ts`）/ propose-only（破坏性动作无直接 write tool）/ 不动树（`parent_id` 只读）/ 科目是视角不是结构（派生轴禁加 subject 列）/ 防循环注入五防 / 护栏两层语义（warning 水位只告知 + 可观测；硬顶 3-5× 只防事故）/ 原图同步留存 / FSRS 单 writer / 记忆是 attention prior 非 SoT（ADR-0017）。

---

## §5 依赖排序路线图（单一权威版）

> 把全部拍板排成依赖排序的落地路线图。五条不可违反的排序定律先固化，所有波次从这里推导。

### 5.0 全局依赖定律（承重墙）

| # | 定律 | 后果 |
|---|------|------|
| **D-1** | 一致性闸地基（YUK-344）是 RT1/RT2/RT4 共同前置且代码侧零实现；本身 `blockedBy YUK-342` 已满足（P2 live） | 所有「升一等实体/promote/credit 物化」排在它之后；但它**可立即起跑** |
| **D-2** | `mastery_state` 重写（B1 PFA logistic）是 RT2 credit 注入 p(L) + A2 阶段判定 + B3 frontier 排序的前置；B1vsB3 矛盾已被总账三轴正交调和 | view/表重写解锁整个 Wave 2 |
| **D-3** | 埋点观测 N 周：所有数值阈值单用户无基线 | 观测窗口期内误区图/credit/promote 不可用是**特性非 bug**；埋点是「攒数据」不阻塞代码 |
| **D-4** | scope 决策（全科底座 vs 单科深耕）gate 扩科相关投入；YUK-347 中性 general PR #406 已 APPROVE，事实上选了泛用框架路径 | 一致性闸/weight/verify-error 零 scope 依赖先做；misconception/credit/routeByKind 受 gate |
| **D-5** | 慢热自校准四阶段是时间序列（①纯先验→②Elo→③fixed-anchor+PPI→④外推），不能跳 | 每阶段前置上一阶段真实作答锚点累积；是 D-3 埋点的算法侧消费者 |

### 5.1 波次表（deliverable / 前置 / 解锁 / Linear）

#### Wave 0 — 零依赖立即起跑（无 owner gate / 无前置，可并行）

| 候选 | deliverable | 为什么零依赖 | Linear |
|------|-------------|--------------|--------|
| A0-1 | QuizVerify 'error' 通道 | 零结构改动、独立于建不建图/scope | B5 子项，独立小 issue |
| A0-2 | mem0 P3 读路径（task#23）`searchMemories` wrapper | P1/P2 已 live，唯一缺口是读侧；解锁 A1/A3/B3 读到的 mem0 不再脏 | YUK-322 记忆半边新子 issue |
| A0-3 | 一致性闸地基本身（YUK-344）拓扑闸 + 调和环 | `blockedBy YUK-342` 已满足；rubric-validator 语义闸已成熟，只补拓扑层；priority High，gate 整个 Wave 3 | **YUK-344**（父 YUK-322） |
| A0-4 | weight 钉死 confidence-only | grep 证实无 strength 消费路径，纯语义固化 + 文档 | RT4，并进 YUK-344 或独立小 PR |
| A0-5 | rubric-validator 阈值微调 | 闸已成熟，`related_to` 加严其实已做 | RT4，独立小 PR |
| A0-6 | 文档↔代码诚实对齐（机会性） | 不阻塞功能但「在错误地图上设计」是隐性税 | 各域 follow-up |

#### Wave 1 — 掌握信号地基（承重墙）

| deliverable | 前置 | 解锁 | Linear |
|---|---|---|---|
| B1 `mastery_state` 重写（删 `evidence<3→0.5` 换 PFA logistic，含 transfer 但只进 p(L)） | owner sign-off「统一掌握信号」（总账已三轴正交调和，仅排序层确认） | RT2 credit / A2 阶段判定 / B3 frontier 排序（D-2 全部解锁） | **YUK-203 P3** + calibration 子 issue |
| B1 慢热阶段① 纯 LLM 先验 | LLM 抽特征 + 模拟考生 | 给 view 非占位冷启动先验 | YUK-203 P3 |
| 零成本基线 gate | B1 view | 全合成 vs 朴素基线 head-to-head | B1，落 audit 脚本或 calibration job |

#### Wave 2 — 派生层接通（读 Wave 1 重写后的 mastery_state）

| deliverable | 前置 | Linear |
|---|---|---|
| B3 合并编排引擎（吃 5 输入产今日流，what+mix，FSRS when 独立） | B1 mastery + frontier CTE | YUK-203 P3 延伸 / 新引擎 issue（review_plan 退役，ADR-0029 supersede） |
| frontier 一等公民（prereq-gating CTE）+ 空 frontier LLM 填充 | 已有 prereq 边（独立可并行 B1） | YUK-203 / 新 issue |
| RT2 credit 注入 p(L)（encompassing_weight 列 + 反向遍历 CTE） | **B1 重写（D-2 硬前置）** + encompassing_weight 加列（触发 audit，需 propose 子类型） | RT2，YUK-322 关系族新 issue |
| A2 block↔interleave 阶段判定 | **B1 mastery（D-2 硬前置）** | A2 形态 issue |

#### Wave 3 — 关系增量（受一致性闸 + scope 双 gate + 埋点 N 周）

| deliverable | 前置 | Linear |
|---|---|---|
| RT1 misconception 晋升环 + misconception 表 + misconception_edge | **YUK-344（D-1 硬前置）** + scope gate（D-4）+ 埋点定 k（D-3）+ 命名同一性判据（§6 B1） | RT1，YUK-322 关系族新 issue（gated YUK-344 后） |
| RT4 promote 四闸 + `audit:relations` 脚本 | **YUK-344（类型签名闸悬空依赖一致性闸，D-1）** + 埋点定 N | RT4，新 issue + 新 audit 脚本 |
| RT3 routeByKind 配置 | scope gate（D-4） | RT3，落 SubjectProfile（同 YUK-347 profile 体系） |

#### Wave 4 — 形态/编排叙事（可与 W1-3 部分并行；交互层交 claude design）

| deliverable | 前置 | Linear |
|---|---|---|
| A1 今日之线四层 | 主缕候选最终接 B3（W2），但交班缕 event 派生 + 结构形态可先做 | A1 形态 issue |
| A3 单编排者统一叙事 + 自主滑块 hint-first + 上下文两层契约 | 防循环注入五防；mem0 只读旁路（A0-2 后更干净） | A3，与 YUK-346（GLM 评估）解耦——provider 评估不阻塞 A3 叙事 |
| A4 出手强度表 A/B/C（静态可逆性兜底；defer/archive/judge_retraction 移出裁决面） | confidence 不足 → 静态兜底（不阻塞） | A4，关联 YUK-44 |
| B5 统一 verify 契约 + plan-then-generate + item-model + auto-enroll 灰度 | A0-1 'error' 通道；客观题校验接 B1 anchor | B5，挂 YUK-203 quiz 域 |
| 横切：埋点遥测铺设 | 让 N 周窗口尽早计时 | 新 observability 子 issue |

### 5.2 有向依赖图

```
[Wave 0 零依赖]
  A0-1 QuizVerify'error' · A0-2 mem0 P3(task#23) · A0-3 一致性闸地基(YUK-344) · A0-4 weight钉死 · A0-5 rubric阈值
       │ A0-3+A0-4 ──────────────────────────────────────┐
       │ A0-2 ─────────────┐                              │
[Wave 1 掌握信号地基]       │                              │
  B1 mastery_state 重写(PFA)│  ◀── owner sign-off(总账已调和)│
       │                   │                              │
[Wave 2 派生层]            │                              │
  RT2 credit ◀── B1(D-2)   │   A2 block-interleave ◀── B1(D-2)
  B3 合并引擎 ◀── B1+frontier CTE                          │
[Wave 3 关系增量(一致性闸+scope 双gate+埋点N周)]            │
  RT1 误区晋升环 ◀── YUK-344(D-1) ─────────────────────────┘ + scope(D-4) + 埋点k(D-3)
  RT4 promote 四闸 ◀── YUK-344(D-1) + 埋点N
  RT3 routeByKind ◀── scope(D-4)
[Wave 4 形态叙事(可与 W1-3 部分并行)]
  A1 今日之线 · A3 单编排者+滑块 · A4 强度表 · B5 verify 契约
[埋点观测 N 周] ══ 横切 Wave1 起持续运行 ══▶ 喂 Wave3 数值 + B1 自校准③④
```

### 5.3 观测窗口（攒数据 ≠ 写代码的空窗期）

埋点遥测代码 Wave 1 起就铺（写 event 维度，让窗口尽早计时），但「攒够 N 周再定参」是纯等待空窗期。窗口期内**误区图 / credit / promote 三者整体不可用是特性非 bug**（D-3 + D-1 叠加），owner 须接受。涉及参数：缕数上限、k 晋升阈值、encompassing_weight、频次 N、block-interleave 切换、auto-enroll 灰度、外推闸门、B1 自校准②③④。

### 5.4 关键路径与瓶颈

两条并行承重墙：`YUK-344 一致性闸地基`（gate 整个 Wave 3）与 `B1 mastery 重写`（gate 整个 Wave 2）。二者就位后 RT1/RT2/RT4 代码可跟进，但**真正「全可用」被两个不可压缩的时间瓶颈钉死**：

| 瓶颈 | 性质 | 缓解 |
|------|------|------|
| 埋点 N 周数据累积 | 时间瓶颈（n=1 无 cohort，工程不可压缩） | 埋点 Wave 1 铺好让窗口尽早计时；代码先于参数就位（参数化默认 NULL/封顶硬值） |
| B1 自校准时间序列（D-5） | 时间瓶颈（owner 作答节奏即上限） | 阶段①纯先验立即上线给非占位冷启动；后续随作答自然推进 |

工程能做的是「让代码在参数到位前先就位、让埋点尽早开始计时」——缩短的是工程延迟，不是时间瓶颈本身。

### 5.5 Linear 映射总表

| Wave | deliverable | Linear |
|------|-------------|--------|
| W0 | 一致性闸地基 + weight 钉死 | **YUK-344**（父 YUK-322，High，blockedBy YUK-342 已满足） |
| W0 | mem0 P3 读路径(task#23) | YUK-322 记忆半边新子 issue |
| W0 | QuizVerify 'error' / rubric 阈值微调 | 独立小 issue |
| W1 | B1 mastery 重写 + 慢热阶段① + 基线 gate | **YUK-203 P3** + calibration 子 issue |
| W2 | B3 合并引擎 / frontier CTE / RT2 credit / A2 阶段判定 | YUK-203 P3 延伸 + YUK-322 关系族 + A2 形态 issue |
| W3 | RT1 误区晋升环 / RT4 promote + audit:relations / RT3 routeByKind | YUK-322 关系族 issue 群（gated YUK-344 + scope）；RT3 落 SubjectProfile |
| W4 | A1 / A3 / A4 / B5 | 形态 issue 群；A3 与 YUK-346 解耦；A4 关联 YUK-44；B5 挂 YUK-203 quiz 域 |
| 横切 | 埋点遥测铺设 | 新 observability 子 issue |

---

## §6 gap / risk / 有效性天花板

> 整合 critic 四类。每条标严重度 + blocker/known-limitation + 处置。**裁决说明**：critic 与 roadmap 对「合并引擎」存在张力——critic 标 F1「合并引擎撞已锁 ADR-0029/0006 是被低估的真重构」，roadmap 把它当 Wave 2 接通。**我裁决采 critic 视角**：合并引擎是推翻已锁决策的真重构（不是「接通」），其推翻动作进 §7 硬决策 H2，工程量如实标，但不作否决理由（总账「不计代价」）。

### 6.1 悬空依赖 / 环形依赖

| # | 问题 | 严重度 | 定性 | 处置 |
|---|------|--------|------|------|
| A1 | 一致性闸地基是「全悬空树根」：RT1/RT2/RT4 全 gated 在一个零实现地基（grep 复核零命中） | 高 | blocker（对 RT），但本身不依赖任何未决项 | **先做地基**（YUK-344 P0，零依赖可立即起跑）；在它 green 前 RT 线只停留在「埋点 + 入口把关 + 派生计算」 |
| A2 | credit→view 重写→B1vsB3 二选一，双层悬空 | 高 | blocker（对 RT2） | 需 owner sign-off H1（总账已三轴正交调和，仅排序层确认）；view 重写后 credit 闭环 |
| A3 | misconception_edge 异构边破坏 rubric-validator 同构假设——「复用」是隐性重写 | 中 | known-limitation 升 blocker（若与一致性闸同期） | **降级 + future**：先 experimental 单类型（只 caused_by）试水，显式声明「异构验证器是新建不是复用」 |
| A4 | encompassing_weight 加列触发 audit:schema 反噬（需新 propose 子类型） | 低 | known-limitation | 加列时同步进 allowlist 标 `resolves_when: pr`；真 write-path 与 credit 同期 |
| A5 | 提议生命周期承重墙（dispatchAccept 1003 行 22-case 中心 switch 未下放）是 RT1/RT2/RT4 隐藏前置，总账未显式登记 | 中 | known-limitation 升 blocker（若要求各包自治先于 RT） | 需 owner 拍 H9：**建议 RT 暂在中心 switch 加 case，下放押后**（避免双前置叠加），但 owner 须知承重墙继续承重 |

### 6.2 欠规约（只到方向没到形状）

| # | 问题 | 严重度 | 处置 |
|---|------|--------|------|
| B1 | misconception 命名规范未定（自由文本 vs 受控词表）——RT1「同 effective_cause」无法机器判定，晋升环触发条件悬空 | 高 | blocker（对 RT1）；需 owner 拍 H7：观测窗口期先「自由文本 + pgvector 近邻聚类」收集真实误区分布，据分布再定 |
| B2 | 自主滑块提示阶数未定 | 中 | known-limitation（阻塞 A3 交互）；建议默认 3 阶 v0 借 GPT H0-H5，埋 revert/escalate 率再调 |
| B3 | A/B/C 的 18-kind → A/B/C 完整归档表没给 | 中 | known-limitation；owner 一次性拍 ~18 行（低风险高确定性，Phase 2 收口） |
| B4 | credit 载体三选一 + 注入层未定 | 中 | blocker（对 RT2）；先埋点（抽样标 prereq 边 component 重合率）+ 依赖 H1 |
| B6 | 合并引擎三约束具体形态欠规约（硬约束如何嵌入 LLM 步骤不被软化 / fallback 触发条件 / mem0 prior 权重）；**总账「合并引擎」比 Phase 1「不合并双通道」更激进** | 高 | known-limitation 升 blocker（若直接实施而不先定 mem0 权重契约）；需 owner 拍 H5 + 硬约束走代码侧 post-filter（LLM 产出后确定性裁剪）非 prompt 约束，先做确定性 fallback 兜底再叠 AI 层 |

### 6.3 三轴正交红线的潜在破口

| # | 问题 | 严重度 | 处置 |
|---|------|--------|------|
| C1 | credit「进 p(L)」是否经「what 决策裁掉 due 队列项」隐性回灌调度 | 中 | known-limitation（可守）；需 owner 拍 H8 + 硬约束：到期必复习项是 hard constraint，AI 只能改呈现顺序/主推不主推，**不能从队列删除**（落代码侧 invariant + 测试） |
| C2 | mem0 prior 经「编排→曝光→证据」长路径间接污染 p(L)（曝光偏置） | 中 | 先埋点（actor_ref 分轨可观测 mem0 影响哪些曝光）；future：mem0 prior 只进「平局打破/排序微调」不进「是否曝光」二元决策，保证每个知识点有最小曝光底线 |
| C3 | confirmation loop：编排者自身输出成 event → mem0 抽成 semantic-trait → 下轮喂回（违反防循环注入五防） | 高 | blocker（对 mem0 extraction 接通）；需 owner 拍 H6 硬规则：**只有用户作答/陈述类 event 可喂 mem0，编排者自身输出永不进 extraction 源**（写成 extraction gate invariant + 单测） |
| C4 | difficulty 共享桥（FSRS D = PFA β）双向耦合——是「同一输入喂两独立估计」还是「同一估计两处读」未明 | 中 | known-limitation；需 ADR 明文：共享的是**输入**（作答 correctness/RT），各自独立估计 D 与 β，**不共享估计值**——否则正交红线在 difficulty 处破 |

### 6.4 未验证数值阈值（n=1 magic number 高危组）

逐个标来源/能否 n=1 验证：**D1 晋升 k**（拍脑袋，单用户误区样本极稀疏，**否**，高危——太小噪声爆炸太大永不晋升）/ **D3 encompassing_weight 0.3-0.4**（拍脑袋，credit 无 ground-truth，**否**，中危——错系数静默偏置诊断）/ **D7 r≈0.78 LLM 抽特征**（文献仅客观题场景，开放/主观题外推存疑，**否**，高危——整个 LLM 标定有效性建在此 r）/ **D8 r=0.75-0.82 LLM 模拟考生**（文献仅客观题，开放题不成立，部分）/ **D10 per-kind 半衰期**（拍脑袋，**否**，中危——错值静默偏置 searchMemories 召回）。

**关键判断**：D1/D3/D7/D8/D10 是「单用户无法验证 + 错值静默偏置认知核心」的高/中危组，且 D1/D3 即使 N 周埋点也未必攒够样本（n=1 固有）——**「先埋点 N 周再定参」对 D1/D3 可能永远拿不到足够样本**，埋点策略本身需 owner 接受「某些参数将长期停在先验值」。纯 UI 阈值（缕数封顶 D6 / 撤销窗口 D12 / block-interleave D11）可日用主观体验验证，低危。

### 6.5 有效性天花板（不计代价也买不到的真天花板）

| # | 问题 | 严重度 | 处置 |
|---|------|--------|------|
| E1 | **跨科开放/主观题型（作文/论述/鉴赏/古文翻译等）算法层基本无效**——软轨 a/c/CDM/KT 是 n=1 认识论死路（Stocking 1990），开放/主观题 LLM 估难度 r≈0 + observed_in 证据精度退化 + verify 环实际无可行方案。对开放题为主科目，整个软轨 + 出题 verify 闭环 + observed_in 三处同时退化 | 高 | known-limitation（诚实标，非 blocker——硬轨/客观题仍成立）；写进决策文档：算法层强承诺仅对客观题成立，开放/主观题降级为「LLM 软提示 + owner 锚点为主，算法辅助为辅」。直接关联 scope 决策 H4 |
| E2 | 自校准慢热四阶段可能永远到不了第四阶段（多数知识点停在①②） | 中 | known-limitation；设计上保证停在①②的知识点也能正常工作（纯先验 + 低置信展示），不让「未达④」成功能不可用（degenerate 态设计） |
| E3 | 零成本基线 gate 可能让整个合成标定栈被自己的 gate 否掉（n=1 显著性可能永远达不到，gate 默认回退轻量基线） | 中 | known-limitation + 需 owner 拍：显著性达不到时默认回退轻量基线 vs 接受低置信启用合成栈。**owner「不计代价」与 gate 本身打架——这是矛盾点须澄清** |
| E4 | 空 frontier LLM 填充可能产出系统性错误临时边（冷启动期 LLM 猜弱前置科目知识点先后序无验证） | 中 | known-limitation；先埋点（临时边 vs 后续真实边吻合率）+ 冷启动期临时边只做软建议不做硬 gating |

### 6.6 横切缺口（Phase 1 critic 已标，总账可能漏接）

- **G1 UI/交互形态层整体缺位**：A1/A2/A4 + B4 retract UI + A3 hint ladder 全部只到结构形态——**标 future + 显式声明这批是 claude design 前置，不进算法 lane**。
- **G2 event 表读放大无人评估**：六主题同时从 event 流即时算（mastery/credit/frontier CTE/今日之线），无「物化 vs 即时算」统一决策，Phase 0 §R4 已现 `loadTreeSnapshot` 5000 行 OOM cap——先埋点（测真实 event 量级下查询延迟）+ 需 owner 拍物化策略。**这条直接关联 §3.9 `mastery_state` 物化表 vs 即时算 view 的形状抉择**（§7 软决策）。
- **G3 confidence 校准方法论全栈缺失**：A4/B5/B1 都依赖「AI 自报置信度可信」无验证方案——confidence 类决策一律先走静态硬判据（A4 已改静态可逆性兜底），软 confidence 推迟到有校准方案。
- **F2 capability 贡献制双轨**（jobs 双轨 / copilotTools no-op / validateComposition 不在生产路径）：RT 新增 proposal kind/job 会踩双轨——建议 RT 暂走现状双轨 + 埋 Linear issue 跟踪双轨收口，避免与一致性闸地基双前置叠加。
- **F3 单编排者「合为同一 D14」vs 现状 copilotTools no-op**：先让 copilotTools 贡献制真生效（退役 CORE_TOOLS latch），再谈 4 job 收编；actor_ref 分轨是对的可观测前提。

### 6.7 一句话风险总结

这套架构**没有致命环形死锁**（一致性闸地基 / searchMemories / QuizVerify-error 三块无依赖可先做，是真地基不是空根），但有**两条「悬空依赖悬空依赖」的长链**（credit→view 重写→H1 二选一；RT1 晋升→misconception 同一性判据 H7）和**两处推翻已锁决策的隐藏成本**（合并引擎撞 ADR-0029/0006；bi-temporal 撞 YUK-344——后者已倾向但需正式落字）。最危险的不是工程量，是 **E1 跨科开放/主观题型算法层基本无效** 与 **D1/D3/D7 高危参数 n=1 可能永远拿不到验证样本**——这两条是「不计代价也买不到有效性」的真天花板，必须如实进决策文档。

---

## §7 需 owner 拍的硬决策清单

> 区分「硬决策必须拍」（不拍则下游 lane 无法启动或建在错误地基上）vs「软决策可默认推进」（记录即可）。硬决策给推荐选项，按解锁广度排序。

### 7.1 硬决策（必须拍）

| # | 决策 | 阻塞 | 推荐选项 |
|---|------|------|----------|
| **H1** | 确认 B1vsB3「统一掌握信号」调和成立（三轴正交 R⟂p(L)⟂difficulty + 分轨是否就是终裁） | B1 view 重写 → 整个 Wave 2（瓶颈 3） | **确认成立**（总账已拍三轴正交，此处仅排序层 sign-off；Phase 1 critic 要求「不能两个 high 并列放行」需一句显式拍板） |
| **H2** | 合并引擎是否推翻已锁 ADR-0029/0006 双通道（B3 拍合并，Phase 0 §5 双通道 locked，Phase 1 建议不合并） | B3 引擎落地 + 三套手抄收敛 | **推翻**，接受三套手抄收敛 + AI 真接入 variant-rotation seam 的真重构成本（这是「收敛接通」叙事下被低估处，需 ADR-0029 supersede） |
| **H3** | bi-temporal 去留 + 授权修订 memory-architecture §4.1/§8.2/§8.4（B2 已拍不做，需正式落字消解设计稿矛盾） | YUK-344 重定向 + 设计稿一致性 | **正式落字推翻原第一条**，YUK-344 重定向为一致性闸地基 |
| **H4** | scope：全科底座 vs 单科深耕（决定 E1 天花板影响面） | RT1/RT3 扩科向投入（D-4） | **采 YUK-347 中性 general（泛用底座 + 学科插件）**，废止 YUK-249 改名方案（PR #406 已 APPROVE 事实选了此路径）；若定单科深耕则算法轴大半价值打折须接受 |
| **H5** | mem0 prior 以什么方式进合并引擎（六主题孤儿输入，无加权契约） | B3 引擎 + 正交红线 | **只读软提示进 prompt 上下文，不进数值权重**（与 C2 正交红线一致）；是否能影响「是否曝光」二元决策须定（建议不能，保最小曝光底线） |
| **H6** | 编排者自身输出是否可作 mem0 extraction 源（防循环注入五防直接落地） | mem0 extraction 接通 | **硬规则：只有用户作答/陈述可喂，编排者输出永不进 extraction**（gate invariant + 单测） |
| **H7** | misconception 同一性判据：自由文本 vs 受控词表（RT1 晋升环输入定义） | RT1 晋升环实现 | **观测窗口期自由文本 + pgvector 聚类先行，据分布再定** |
| **H8** | AI 能否裁掉部分到期项不主推（触及「AI 能动 vs 人掌控」红线） | C1 正交破口 | **到期项是 hard constraint，只能改呈现不能删队列**（落代码 invariant + 测试） |
| **H9** | 先下放 dispatchAccept 再做 RT，还是 RT 暂在中心 switch 加 case（A5 承重墙二次前置） | RT 线启动节奏 | **后者**（RT 暂在中心 switch 加 case，下放押后），但 owner 须知此选择让承重墙继续承重 + 埋 Linear issue 跟踪 |
| **H10** | difficulty 共享桥语义：共享输入 vs 共享估计值（C4 正交破口） | difficulty 桥 ADR | **共享输入，各自独立估计 D 与 β，不共享估计值**（ADR 明文，否则正交红线在 difficulty 处破） |
| **H11** | 零成本基线 gate 显著性达不到时：默认回退轻量基线 vs 接受低置信启用合成栈（E3，owner「不计代价」与 gate 本身打架） | 合成标定栈是否实际启用 | **澄清矛盾**：建议「相对排序用合成栈（不需显著性）+ 绝对值标低置信」，回退只针对「合成栈系统性差于基线」而非「未显著赢」 |

### 7.2 软决策（可默认推进，记录即可）

- 一致性闸地基先建（总账已定 priority High，YUK-344）。
- searchMemories P3 读路径先做（无依赖高 ROI）。
- QuizVerify 扩 'error' 通道先做（零结构改动无依赖）。
- 缕数封顶 5 / 撤销窗口 / block-interleave 等纯 UI 阈值——先取保守默认值，日用调。
- 自主滑块先做 3 阶 v0 借 GPT H0-H5，埋 revert/escalate 率后调。
- A/B/C kind 归档表——低风险一次性落表，Phase 2 收口拍。
- RT1 代码在参数（k）未定前先就位（默认值守门，参数后填），与埋点并行。
- encompassing_weight 加列前先做 component 重合率人工抽样（低重合则 credit 降级或押后）。
- A1 交班缕（event 派生）+ A4 静态可逆性表先做（不依赖引擎/confidence）。
- misconception_edge 单多态表先 experimental 试水（异构边平行闸成本计入）。
- `mastery_state` 倾向物化表（PFA 需累积计数 + transfer 递归 CTE，纯 view 难承载性能）——但连带 G2「物化 vs 即时算」统一策略，cross-统合后由统一计划定形。
- `item_calibration` keyed 在 question 还是 knowledge_id（IRT b 题级 / θ 知识点级，混一表 vs 拆两表）——倾向分列同表，落地时拍。
- mem0 extraction gate pending 落 PG（进 audit:schema 受治理）vs mem0 metadata（审计盲区需文档兜底）——倾向落 PG。

---

## §8 与 GPT 外部稿的对账

> GPT 稿（Universal Learning Evidence Architecture L1-L7 / 三层 KG / 三态 mastery / Verifier Router / Hint Ladder）已被总账吸收。这里说明采纳/否决/为什么——GPT 稿是单源，本架构是 Phase 1 双视角×9主题并行交叉核 + Phase 1.5 关系结构专项 + owner 逐项拍板的产物，故以本架构为准、GPT 稿为候选增量来源。

| GPT 稿元素 | 裁决 | 理由 |
|---|---|---|
| **三层平行 KG（学科/题型/错因）** | **否决** | Phase 1.5 三主题独立否决——它把「设计期论证脚手架」（ECD）和「runtime 数据结构」混为一谈，把本属观测/字段层的东西强行升身份层。**改为双层异构图**（树骨架 + 同构 typed-edge 网 + 渐进晋升的 misconception 异构层）。题型不建图（RT3：`question.kind` + profile 配置）；错因不平铺建图而是「晋升而非复制」（RT1：≥k 复现才升一等实体）。 |
| **三态 mastery（mastery / retrievability / transfer）** | **采纳但重映射为三维** | 概念呼应，但重映射为更落地的形态：`R`（FSRS retrievability，喂调度）+ `p(L)`（PFA logistic 含 transfer，喂诊断）+ `difficulty`（共享桥）。用 PFA 而非 GPT 暗示的 BKT/DKT——单用户稀疏数据下 PFA logistic 有先验、第一条证据即更新更合适。transfer 不独立成态而是**作为 credit 注入 p(L)**（RT2，只进 p(L) 不碰 R）。 |
| **Verifier Router（多评分器路由）** | **采纳** | 强呼应。三套不一致信任闸（OCR/QuizGen/Variant）收敛到 QuizGen 五轴多信号模板，统一 verify-then-promote（B5 §3.8）。 |
| **Hint Ladder H0-H5** | **采纳为 hint-first 起点** | 呼应自主滑块。GPT 的 H0-H5 比本稿「hint-first」更具体可直接借——定为 A3 自主滑块的 v0 阶数起点（§7 软决策：3 阶 v0 借 H0-H5，埋 revert/escalate 率后调）。 |
| **延迟复测 / 迁移测（一等评估变量防假学习）** | **采纳补盲点** | Phase 1 标记的 GPT 稿盲点补强——A2 复盘内容 = 考 R 留存（延迟复测）+ transfer 换情境（迁移测）（§2.2）。fluency-illusion 软提示（§3.1）也是这条的算法侧落点。 |
| **通用证据层 + 学科插件（扩展性哲学）** | **采纳，同构** | 与本架构「收敛已有骨架 + 接通资产」同构，都指向「不靠万能模型」。落地 = scope 决策 H4 采中性 general 泛用底座 + 学科 verifier 插件。 |
| **工程假设（Neo4j / Kafka / Feature Store / 多用户 / 学校集成）** | **否决/剥离** | 全部留在 Postgres / 单用户 / 无图库（pgvector 承载关系结构 + mem0）。Phase 1 守住既有约束，GPT 稿这些与单用户 n=1 定位冲突。 |
| **L1-L7 通用证据架构分层** | **部分吸收为三层分离** | 不照搬七层，吸收为「身份层 / 观测层（event 唯一真相）/ 派生层（不写回）」三层分离（§3.5）——这是关系本体的核心裁决。 |
| **bi-temporal（GPT 稿未强调）** | **本架构主动否决** | 结构是 timeless 不变量，YUK-344 重定向为一致性闸地基（H3）——这是本架构比 GPT 稿更明确的立场。 |

**一句话对账**：GPT 稿在「验证路由」「Hint Ladder」「延迟迁移测」「通用证据层哲学」四处提供了可直接借的增量并已采纳；在「三层平行 KG」「重型工程假设」「bi-temporal 隐含」三处被否决或剥离，因为它们把设计脚手架当 runtime 结构、且与单用户 n=1 无图库约束冲突。本架构 = GPT 稿候选增量 + Phase 1/1.5 双视角交叉核 + owner 拍板的三方综合。

---

**Linear 捕获 gate 声明**：本文是「整个产品重新想」三阶段的终局 cross-统合综合（产品/feature 层架构终稿，非实现），是下游 to-issues 流程的输入而非可执行 issue 集。**本综合不创建新 Linear issue**：所有落地动作（item_calibration / mastery_state / misconception / encompassing_weight / B3 引擎 / A1-A4 形态 / 埋点遥测 / mem0 P3）须经 owner 拍定 §7 硬决策后，由 to-issues 流程统一落 tracer-bullet 切片挂 YUK-322 / YUK-203 epic，此时单独建会与统一计划重复。已核对的现存 issue：YUK-344（一致性闸地基，可立即起跑）/ YUK-203 P3（mastery 重写宿主，In Progress）/ YUK-249 与 YUK-347（scope 互斥待 H4 正式裁决，YUK-347 PR #406 已 APPROVE）/ YUK-346（GLM 评估，与 A3 解耦）/ YUK-322（记忆 epic）。唯一已可确定的 Linear 动作是 YUK-344 重定向（推翻 bi-temporal 第一条 + 拓扑闸 + 调和环），建议 owner 落地时正式补写 issue body——本综合者不越权代建。

---

**关键文件路径**（供下游下钻，全部绝对路径）：
- 决策总账：`/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-14-product-rethink-decisions-ledger.md`
- 现状地图：`/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-14-product-rethink-phase0-current-map.md`
- Phase 1 调研：`/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-14-product-rethink-phase1-research.md`
- Phase 1.5 关系：`/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-14-product-rethink-phase1_5-relations.md`
- 占位公式现存：`/Users/yukoval/yukoval-projects/the-learning-project/drizzle/0005_phase1c1_event_payload_gin_and_mastery_view.sql:61`（`evidence<3→0.5`）+ `:22`（30 天半衰期）
- 提议承重墙：`/Users/yukoval/yukoval-projects/the-learning-project/src/server/proposals/actions.ts`（dispatchAccept 1003 行中心 22-case switch，A5/F2）
- 同构验证器：`/Users/yukoval/yukoval-projects/the-learning-project/src/capabilities/knowledge/server/rubric-validator.ts`（A3 异构破口）
- audit 处置点：`/Users/yukoval/yukoval-projects/the-learning-project/scripts/audit-schema-allowlist.json`（A4 encompassing_weight lint 反噬）
