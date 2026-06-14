# Phase 2 综合 · 四路 lane 原始产出（存档）

> cross-统合（落 `2026-06-14-product-rethink-phase2-synthesis.md`）的输入。这里是 4 路并行综合 agent 的原始产出，留作可追溯。终局以 cross-统合为准；冲突处 cross-统合已裁决。

---

## Lane 1 · 形态架构综合

I now have enough grounded现状 evidence. The actual inbox has 17 KIND_META entries (the doc says "18 kinds" — close enough; what matters is which need adjudication). I have confirmed: TodayPage derives only 2 strands (复习/裁决) from summary, Copilot CTA is a死占位 placeholder, PracticeFacePage only has 2 real views (stream/shelf) with modes (paper/retro), background jobs are 4 separate handlers in agency manifest with separate actor surfaces. This is sufficient to write the synthesis.

Let me compose the form-axis architecture synthesis.

---

# 形态轴综合 · 推荐产品形态架构

> **作者**：Phase 2 形态架构综合者 | **输入**：决策总账 §0+§2(A1-A4) / Phase 0 现状地图 / Phase 1 大调研 / Phase 1.5 关系结构 | **范围**：产品/feature 层（非像素稿，视觉后续交 claude design） | **下游消费者**：cross-统合 agent

## 0. 形态轴的一句话主线

> **现状是「把所有状态平铺给一个全知用户、把『编排』这件事甩给用户自己」；目标是「单编排者（D14）每天/每刻策展出一条有理由的主线，把全貌降为可下钻的次级上下文，人保留裁决权与方向盘、不再承担编排劳动」。**

四个面（A1 入口 / A2 练习 / A3 AI 角色 / A4 读vs判）是**同一个反模式的四个切面**，也是**同一个应然动作的四个落点**——「AI 从全集选一小撮 + 给理由 + 留可下钻全量 + 留可逆出口」。A4 的 A/B/C 出手强度表不是第四个面，而是**贯穿前三个面的统一出手契约**。

形态轴的安心结论（与算法轴一致）：**没有一个面需要新引擎/新基建**。工作是 UI 重排 + 接通已设计好的 seam（`composeDailyStream`/`ambient_context`/`actor_ref`/copilotTools 贡献制）+ 把现有零件按新叙事归位。

---

## 1. A1 · 一天入口 `/today`

### 现状（Phase 0 grounded）
- 主组件 `src/capabilities/shell/ui/TodayPage.tsx`（10.6KB）。布局序列 `hero → kpi-row → 今日之线 → 进行中·待裁决 dash-grid`（L203-241）。
- **「今日之线」是阉割态**：注释 L49-50 自述「设计稿 DATA.threads 是策展假数据；真数据从 summary 聚合派生两缕（复习/裁决），未来夜链交班缕随 M5 task_run 读模型补」。即当前只能从 `/api/workbench/summary` 派生 **2 缕**（due>0 → 复习缕 / proposals>0 → 裁决缕），全零不渲染。
- **三 hero CTA**（复习/录入/Copilot）是动作起点；其中 Copilot CTA 是**死占位**——`onCopilot` L216 弹 toast「Copilot 随 M5 收编后在新栈接通——当前请走旧页」。
- 数据中枢 `src/capabilities/shell/server/workbench-summary.ts` 仍靠**构造 internal Request 调 `handleReviewDue`**（非干净读模型）。
- CostRibbon 无预算数据源（Phase 0 §6.7 死占位）。

### 目标形态（A1 四层）
`/today` 是**AI 策展的「今日之线」**，不是聚合仪表盘。自上而下四层：

| 层 | 内容 | 数据来源 | 性质 |
|---|---|---|---|
| **① 交班缕** | 夜链 forethought：昨夜 D14 后台 job（dreaming/coach）跑出的「我帮你想了什么」 | event 派生（先轻：可解释的 event readable；后叙事化） | 叙事开场，**先轻后叙事** |
| **② 今日主缕** | AI 策展的 **3-5 候选缕**（每缕 = 一条有理由的学习主线，如「巩固通假字 + 一道迁移题」） | 合并引擎产出（算法轴 B3）+ mem0 prior | 主推面 |
| **③ 次级副歌** | 旧 4-strip / KPI-row / 周热力 | summary 聚合 | **降级为可下钻**，默认折叠 |
| **④ 完成度收尾锚** | 一天结束的完成度回收（「你今天织完了 3/4 缕」） | stream done 状态派生 | 收尾闭环 |

**关键产品约束（总账 §2 A1 + §0）**：
- **缕数封顶 5、上限内 AI 动态（1-5）**——防凑数防波动。
- **策展 ≠ 隐藏**：主推 3-5 缕，但**全量永远可下钻**（次级副歌就是全貌入口）。这是 §0「克制的策展」红线的 A1 落点。
- **交班缕先轻后叙事**：初期只渲 event 派生的可解释行，AI 叙事质量经使用验证后再叙事化（不在 AI 质量验证前激进押注）。
- **三 hero CTA 降级**：动作类型（复习/录入/Copilot）不是「今日下一步」——今日下一步应是主缕里的具体动作。CTA 从「主入口」降为「常驻动作类型快捷」。

### 关键 delta（建/改/接线）
1. **改**：`TodayPage.tsx` 布局从 `hero→kpi→今日之线→dash-grid` 重排为 `交班缕→今日主缕→(折叠)次级副歌→完成度锚`。
2. **建**：交班缕读模型——Phase 0 注释已标「随 M5 task_run 读模型补」，需把后台 job 产出（actor_ref 分轨，见 A3）聚合成「昨夜 forethought」读模型。
3. **接线**：今日主缕的 3-5 缕来自算法轴 B3 合并引擎（`composeDailyStream` 物化进 `practice_stream_item`）——`/today` 是该编排产出的**展示落点**，不自己做编排。
4. **接线**：Copilot CTA 死占位拆除——Copilot 是常驻 Drawer（见 A3），不需要 Today 局部 CTA 唤起；改为 Drawer 全局入口。
5. **降级**：4-strip/KPI/周热力包进可折叠的「次级副歌」section，默认收起。

### 与算法轴的接口（哪个 UI 是哪个算法信号的落点）
- **今日主缕的 3-5 缕** ← B3 合并引擎（FSRS due + frontier + mastery p(L) + mem0 prior + AI 判断）的今日流产出。**FSRS *when* 不进 AI**，缕内的「到期必复习」是确定性硬约束。
- **交班缕** ← 后台 job event 派生（D14 dreaming/coach，actor_ref 分轨）。
- **完成度锚** ← `practice_stream_item` 的 done 状态。
- **缕的「理由」一句话** ← B1 p(L) 掌握诊断的离散档（非干净「掌握度=78%」，是置信区间/低置信标记）。

---

## 2. A2 · 练习旅程 `/practice`

### 现状（Phase 0 grounded）
- 主组件 `src/capabilities/practice/ui/PracticeFacePage.tsx`。注释 L3 自述「卷架/散题作答/卷模式/结果/复盘；机制不暴露——页面只见 AI 的一句话」。
- **实际只有 2 个顶层 view**：`'stream' | 'shelf'`（L43-47），加 mode 子状态 `paper`（卷内）/ `retro`（复盘）/ 散题作答。**不是设计稿宣称的五平级状态机**——它已经是「流为主 + 卷架为存档视图 + 卷/复盘为流内 mode」的雏形，但叙事未理顺。
- 流自动推进逻辑已在（L85-105，散题完成推进下一道 pending）。
- **AI 调度未接进**：Phase 0 §6.3 + R5 张力——`due-list`/`review-session`/`stream-store` 三套近重复手抄 FSRS-due 选题；AI `review_plan` 另开 paper channel（ADR-0029）旁路，未接进 due 选题；`variant-rotation` 自称「唯一 seam」但 AI 实际没接。block↔interleave 切换无信号驱动。
- **复盘**当前是流内 `retro` mode，看 paper artifact，无周期性留存校验、无自校准 UI。

### 目标形态（A2 流为脊柱）
**流（stream）= 脊柱与默认入口**，其余四态从流**派生/回流**，不是五平级视图随意跳：

```
                  ┌─────── 流（默认入口，合并引擎产出今日缕）───────┐
                  │                                              │
            作答动作 ↓                                      存档 ↓
        散题（流内单题）  卷（流内 paper，节目化）          卷架（持久归宿，回看入口）
                  │              │                              │
                  └──── 回流 ────┴──── 事件触发 ───→ 复盘（B1 自校准 UI 落点）
```

- **流**：默认入口，B3 合并引擎产出的今日缕在此逐项推进。
- **散题 / 卷**：是**作答动作**（流内的单题 / 节目化的成组题），不是独立视图。
- **卷架**：是**存档与回看入口**（D12「卷架是持久归宿」），已在 `?view=shelf`。
- **复盘**：从流**事件触发**回流——见下。

**block↔interleave 由 p(L) 掌握阶段驱动（可 override）**：
- 新知阶段 → block（同知识点集中练）；巩固阶段 → interleave（跨知识点穿插）。
- 驱动信号 = B1 p(L) 离散掌握阶段；**用户可 override**。
- 切换阈值 = **产品决策 + 埋点**（总账明确：不声称文献规定，先埋点观测 N 周再定参）。

**复盘 = 事件触发 + B1 自校准 UI 落点**（总账 §2 A2 + B1）：
- **触发**：掌握阶段跃迁 / 每 N 次（周期性留存校验），**非随时手动跳**。
- **内容**：考 R 留存（延迟复测）+ transfer 换情境（迁移测）——这正是 Phase 1 §5 标记的 GPT 稿盲点补强（防假学习的延迟迁移测）。
- **认识论角色**：复盘是 **owner n=1 真实作答成为 ground-truth 锚点的入口**——B1 fixed-anchor 自校准（owner 客观题确定判分作干净锚，残差=miscalibration 信号）的 UI 落点。日常流则给**轻量回执**（不打断）。

### 关键 delta（建/改/接线）
1. **接线（核心）**：流的今日缕来自 B3 合并引擎 `composeDailyStream` 薄编排层物化进 `practice_stream_item`——**FSRS *when* 仍独立真相源，AI 合并 *what*+*mix***。这接通 Phase 0 §6.3 的「AI 调度旁路」张力。
2. **改**：叙事从「stream/shelf 二 view」理顺为「流为脊柱 + 四态派生」——代码侧已是雏形，主要是产品叙事 + 复盘回流接线，不是重写状态机。
3. **建**：block↔interleave 模式标记——流的组装层读 B1 p(L) 阶段决定 block/interleave，加 override 控件 + 埋点。
4. **建**：复盘事件触发器（掌握跃迁 / 每 N 次）+ 延迟复测 / transfer test 题型 + 自校准回执 UI。
5. **保留**：`variant-rotation.pickProbeForKnowledge` 作为 selector 复习侧子步骤（算法轴 B3 已定的「唯一可替换 selection step」）。

### 与算法轴的接口
- **流的缕排序与配比** ← B3 合并引擎（复习配比 = AI 每日建议；`review_plan` 退化为 proposer）。
- **block vs interleave 模式** ← B1 p(L) 掌握阶段（新知 block / 巩固 interleave）。
- **复盘的延迟复测项** ← FSRS R（记忆留存）；**transfer 换情境项** ← B1 transfer credit（只进 p(L)，不碰 R/调度）。
- **复盘自校准残差** ← B1 fixed-anchor（owner 客观题确定判分）。
- **空池/稀疏退化**（Phase 1 §4 缺口）：流为空时 ← B3「空 frontier LLM 填充」（低置信 propose-only）——需在流 UI 定义空态形态。

---

## 3. A3 · AI 角色

### 现状（Phase 0 grounded）
- **前台**：Copilot（D14）= 唯一对话式 agent，常驻 Drawer 根挂（非 Today-scoped），第一人称署名「我」。主循环 `src/capabilities/copilot/server/chat.ts`（57.8KB）。工具面动态切：自由对话 = COPILOT_TOOLS 25 工具 surface / 点 chip = 更宽的 mistake_action surface（`src/server/ai/tools/allowlists.ts`）。
- **后台**：`src/capabilities/agency/manifest.ts` 声明 **4 个独立 job handler**——`dreaming_nightly` / `coach_daily` / `coach_weekly` / `goal_scope_propose_nightly`，各有独立 actor surface。
- **「单人格」的真实语义被压缩**：Phase 0 §2 + R2 张力——面向用户的对话面唯一，但系统实有 **4 个 agent 人格**（前台 Copilot + 后台 3+1），surface 严格隔离、**互不知情**。
- **上下文是雏形未成契约**：`ambient_context` 只在 `chat.ts` 私有入参喂 Drawer（Phase 1 §2-3）。
- 张力：CORE_TOOLS bootstrap 全量 40+ 先到，copilotTools 贡献制实质 no-op（Phase 0 §6.4）；`author_artifact` 归属错位（应属 notes 实由 copilot 贡献）；solve/quiz inline 入口死占位。

### 目标形态（A3 单编排者统一叙事）
**单编排者 D14 = 前台 Copilot + 后台 4 job 合为同一个编排者的不同召唤姿势**，而非 4 个互不知情的人格：

| 召唤姿势 | 形态 | actor_ref 分轨 |
|---|---|---|
| **前台 Copilot** | 常驻 Drawer，用户自由对话 / 点 chip 触发 | `copilot` |
| **夜链 dreaming** | 后台 forethought，产出交班缕 | `dreaming` |
| **coach daily/weekly** | 后台规划/回看 | `coach` |
| **goal scope** | 后台目标范围提议 | `goal_scope` |

- **统一叙事**：四姿势是「同一个编排者」对用户讲的连贯故事——前台对话能引用昨夜后台想的（交班缕），后台 job 写入会话级工作记忆供前台读。
- **actor_ref 分轨保可观测**：合为一个叙事 ≠ 丢可观测性，留痕仍按 actor_ref 分轨（总账明确）。

**自主滑块默认 hint-first**（总账 §2 A3）：
- inline 解题默认**给提示**而非给完整解，可一次性走到完整答案后**交还用户控制**——防 Khanmigo 教训（强制 Socratic 赶走用户）。
- 提示具体形态待定（owner 未决，见 §6）——GPT 稿 Hint Ladder H0-H5 可直接借（Phase 1 §5）。

**上下文升级成两层正式契约**（总账 §2 A3 + Phase 1 §2-3）：

| 层 | 是什么 | 存储 | 读写 |
|---|---|---|---|
| **(a) 会话级工作记忆** | 短时上下文：当前面 / focused_entity / 上一轮练习结果 / **刚 dismiss 了哪条** | Postgres（现成） | 所有 surface（Drawer/inline/后台/composer）**写入**，编排者**读取** |
| **(b) 长时 attention prior** | mem0 混合层个性化软画像 | mem0（自管 pgvector） | 编排者**只读旁路**，永不偏置 judge/FSRS（三轴正交红线） |

**防循环注入五防必守**（既有红线）：注入事实非上一轮 prompt 装配物 / ambient 不进历史 / 鲜读 digest 不进历史 / 双层截断 / 专项单测。

### 关键 delta（建/改/接线）
1. **建**：会话级工作记忆契约——把 `ambient_context` 从 `chat.ts` 私有入参升格为所有 surface 共写、编排者共读的正式表/契约，纳入「刚 dismiss 哪条」（直接服务 A4 的 B 档 dismiss 信号回流）。
2. **接线**：长时 attention prior 接通 mem0 P3 读路径（算法轴 B4 `searchMemories` wrapper），定位只读旁路。
3. **建**：自主滑块——inline hint-first 控件 + 一次性走到完整解的「交还控制」出口。
4. **统一叙事接线**：交班缕（A1 ①）读后台 job 产出；前台对话能引用之——四 actor_ref 串成一个叙事。
5. **收口（算法轴交叉）**：copilotTools 贡献制 no-op → 真单一登记面（Phase 0 §6.4，属内核轴但影响 AI 工具面真相源）。

### 与算法轴的接口
- **编排者读取的信号** ← B3 合并引擎输入（FSRS due + frontier + mastery + mem0 prior）。
- **长时 attention prior** ← B4 mem0（accepted semantic-trait 经 gate + episodic 全自动）。**mem0 软信号与 FSRS-R/frontier/confidence 的加权关系是 Phase 1 §4 标记的「孤儿输入」空白契约**——见 §6 未决。
- **hint-first 的提示内容** ← 题的 p(L) 难度档 + 错因（若 RT1 misconception 已晋升，提示可指向具体误区）。

---

## 4. A4 · 读 vs 判（贯穿所有面的统一出手契约）

> **A4 不是第四个面，而是 D14 单编排者对所有面（A1 交班缕/A2 流提议/A3 inline 动作 + inbox kind + mem0 extraction）的统一出手强度契约。** 这是 §0「全局出手强度表」的形态落点。

### 现状（Phase 0 grounded）
- **两类 AI 输出面**：`/inbox`（`src/capabilities/shell/ui/InboxPage.tsx`，人审闸口，需裁决）vs `/agent-notes`（`src/capabilities/agency/ui/AgentNotesBoard.tsx`，纯旁观 read-only，唯一交互是本地「已读」）。
- **inbox kind 均一钉死必须 accept**：`inbox-api.ts` 的 `KIND_META` 列了 **17 个 kind**（knowledge_node/knowledge_edge/knowledge_mutation/learning_item/note_update/variant_question/record_promotion/record_links/completion/relearn/goal_scope/block_merge/defer/archive/judge_retraction/image_candidate/question_draft/question_edit），全部走同一条逐条 accept/dismiss lane（L80-97 按 KIND_META 键序排 lane）。
- **三个 kind 只能 dismiss 不能 accept**（Phase 0 §6.7 + YUK-44）：`defer` / `archive` / `judge_retraction` 的 accept applier 未实现。
- **裁决面塞了不该裁决的东西**：`defer`（延后）/ `archive`（归档）/ `judge_retraction`（判定撤回）本质不是「结构性写入需人审」，是状态/旁观动作，却占着裁决 lane。
- 成功指标当前是 dismiss 数（Phase 0 隐含）。

### 目标形态（A4 全局出手强度表 A/B/C）
按「**可逆性 × 后果**」分三档（总账 §2 A4）：

| 档 | 语义 | 形态 | 落哪些 |
|---|---|---|---|
| **A 自动 + 撤销窗口** | 乐观应用，不打断不强制确认，留一键 revert | 不进 inbox lane；后台静默应用 + 顶部「可撤销」提示 | **静态可逆性兜底**选出的安全 kind（如 record_links/某些 completion） |
| **B 逐条人审** | 结构性/破坏性写入，逐条裁决 | inbox lane（现状 accept/dismiss） | knowledge_node/edge/mutation、variant_question、learning_item、relearn、goal_scope、block_merge、question_draft/edit 等真裁决项 |
| **C 纯状态不进队列** | 不是写入提议，是状态/旁观动作 | **移出裁决面**：defer→snooze 控件 / archive→直接软归档 / judge_retraction→agent-notes 旁观 | defer / archive / judge_retraction |

**关键产品约束（总账 §2 A4 + §0 + Phase 1 §2.4）**：
- **A 档 kind 用静态可逆性兜底**——**不靠 confidence**（数据基础不足，A4 现状 confidence 字段只覆盖 1/18 kind 且校准从未验证）。即「这个动作可不可逆」是静态可判的，比「AI 多自信」可靠。
- **defer/archive/judge_retraction 移出裁决面**——它们不是「需人审的结构写入」，塞在裁决 lane 是把状态动作误当写入提议。snooze / 直接软归档 / agent-notes 旁观各归各位。这同时解决 Phase 0 §6.7「三 kind 只能 dismiss」的死占位（不是补 accept，是它们本就不该在裁决面）。
- **单用户硬顶熔断**（Phase 1 §2.4）：单用户没有第二个审计人，A 档自动写入门槛必须比工业 HOTL 更严——单位时间 auto-apply 上限超限则退回全人审。这是 §0 护栏两层语义的 A 档落点（warning 水位只告知 / 硬顶防事故）。
- **指标落两档健康信号**：A 档 **revert 率**（自动应用错了多少被撤）/ B 档 **dismiss 率**（提议多少被拒）——**不追抽象 appropriate-rate**（无法 n=1 校准）。

### 关键 delta（建/改/接线）
1. **改**：为每个 inbox kind 标注 A/B/C 档（静态可逆性判定，非 confidence）。
2. **建**：A 档自动应用通道——后台静默 apply + 顶部可撤销提示 + 一键 revert + 单位时间熔断退回全人审。
3. **移**：defer→snooze 控件、archive→直接软归档、judge_retraction→agent-notes 旁观——三者移出 inbox 裁决 lane。
4. **建**：两档健康信号埋点（A 档 revert 率 / B 档 dismiss 率）。
5. **接线（A3 交叉）**：B 档 dismiss 写入会话级工作记忆（「刚 dismiss 哪条」），编排者下次不重复同类提议。

### 与算法轴的接口
- **A 档可逆性判定** ← 静态规则（kind 级，零算法依赖，可立即做——Phase 1 §2.4「零成本硬判据先行」）。
- **mem0 extraction gate**（B4）走同一 A/B/C 契约：semantic-trait → B 档（pending + 一键 reject/edit）；episodic 事件 → A 档（全自动可撤）。
- **错因晋升 propose**（RT1）→ B 档（人审 accept 才建 misconception 节点）——但 gated 在一致性闸地基之后。

---

## 5. 四面统一视图（cross-统合 速查）

| 面 | 现状反模式 | 目标 | 统一动作 | 算法接口 |
|---|---|---|---|---|
| A1 /today | 聚合仪表盘 + 3 hero CTA，今日之线只 2 派生缕 | 四层今日之线（交班/主缕/副歌/锚） | AI 选 3-5 缕 + 理由 + 全量可下钻 | B3 合并引擎 / B1 p(L) 档 / 后台 job event |
| A2 /practice | stream/shelf 二 view，AI 调度旁路 | 流为脊柱，四态派生回流 | AI 排今日缕 + 一句理由 | B3 *what*+*mix* / B1 block-interleave / FSRS R + transfer 复盘 |
| A3 AI 角色 | 4 互不知情人格 + ambient 私有入参 | 单编排者四姿势 + 两层上下文契约 | hint-first 自主滑块 | B4 mem0 prior（只读）/ 防循环注入五防 |
| A4 读vs判 | 17 kind 均一钉死 accept | A/B/C 三档 + 三 kind 移出裁决 | 静态可逆性兜底 + 两档指标 | 零算法依赖（可先做）/ B4 extraction gate 同契约 |

**贯穿性接线**：会话级工作记忆（A3）是 A4「刚 dismiss 哪条」的载体；交班缕（A1）是后台 job（A3）的展示落点；复盘（A2）是 B1 自校准的 UI 落点。四面经 D14 单编排者 + A/B/C 契约 + 两层上下文串成一个连贯叙事。

---

## 6. 形态侧未决/需 owner 拍的点

1. **【自主滑块提示具体形态】** hint-first 是几阶递进？直接借 GPT 稿 Hint Ladder H0-H5（Phase 1 §5 评其「更具体可直接借」），还是自定义阶数？这是 A3 唯一未定的交互形态。

2. **【mem0 软信号在编排里的优先级契约】** Phase 1 §4 标记的「孤儿输入」承重墙：A1 主缕排序 / A2 流配比 / A3 编排都把 mem0 prior 列为输入，但**没有任何一面定义 mem0 软信号 vs FSRS-R vs frontier vs confidence 的加权/优先级**。三轴正交说「各管各」，但落到「今日主缕怎么排」时必须有一个仲裁规则——这是横切 A1/A2/A3 的空白契约，需 owner 拍 mem0 prior 在编排里是「软重排 hint」还是「硬过滤」。

3. **【A 档初期放哪几个 kind + 熔断阈值】** 「AI 替人选择性隐藏的边界」触及「AI 能动 vs 人掌控」红线（Phase 1 §6.5）：A 档自动应用初期放哪几个 kind（静态可逆性兜底是判据，但「初期保守集」是产品决策）？单位时间 auto-apply 上限多少触发熔断退回全人审？归入「先埋点观测 N 周再定参」。

4. **【交班缕叙事化的时机判据】** 「先轻后叙事」的「后」由什么触发——AI 叙事质量怎么算「经使用验证」可以从 event 派生行升级为叙事化？这是 §0「不在 AI 质量验证前激进」在 A1 的具体 gate，需定一个观测信号（如交班缕被点开率 / revert 率）。

5. **【交互/像素层整体留白】** Phase 1 §4 明确：A 轴全部只到「结构形态」不到「交互形态」，像素/微交互层留白，直接进实现会在 handoff 集体卡住——**四面的视觉稿后续须交 claude design**（本综合按硬约束只做产品/feature 层）。cross-统合 agent 需明确：本架构是 design handoff 的功能输入（零风格规定），不是可直接实现的交互规范。

---

**形态轴与算法轴的依赖边界（提醒 cross-统合）**：A1 今日主缕 + A2 流配比都重度依赖 B3 合并引擎与 B1 p(L) 阶段信号，而 B1（PFA 双层）vs B3（FSRS R）的「统一掌握信号」硬矛盾若未二选一，A1/A2 落地会建在即将被改写的信号上（Phase 1 §4 矛盾 2 + Phase 1.5 §5.6）。**A4 三档契约是唯一零算法依赖、可立即做的形态工作**（Phase 1 §2.4「硬判据先行」）。

---

**Linear issue 捕获 gate**：本任务是 Phase 2 形态轴综合（产出供下游 cross-统合 agent 消费的结构化文档片段），属设计综合阶段，**不产生需立即建 Linear issue 的 actionable 跟进**——所有形态侧 delta 的工程化拆分应由 cross-统合后的统一计划阶段统一开 issue（避免本轴先行开 issue 与算法轴/内核轴重复或冲突）。§6 五条未决点是 owner 拍板项、非可执行 issue。无需本轴单独建 issue。

---

## Lane 2 · 算法/数据架构综合

全部核对到位。`evidence_count < 3 THEN 0.5::real` 占位公式确认在 `drizzle/0005_phase1c1_event_payload_gin_and_mastery_view.sql:59-62`,30 天半衰期 `exp(-ln(2)*…/(30*86400))` 在 line 22。rubric-validator 已实现的语义闸:`self_edge`/`cross_subject`/`parent_semantic_duplicate`/`prerequisite_no_order_evidence`/`contrasts_with_no_confusion`/`related_to_dumping_ground`——确认是**语义层闸**,**无**拓扑层(环检测/方向矛盾/传递冗余)。grounding 充分,开始综合输出。

---

# Phase 2 综合 · 算法/数据架构（推荐目标架构 + 落地路径）

> 综合者：算法/数据架构轴。输入＝决策总账 §0/§1 + 关系结构 RT1-4 + 一致性闸地基。代码侧 grounding 已逐项核对（分支 `yuk-342-memory-p2-reconcile`，= main + 5 memory commits）。下游 cross-统合 agent 可直接引用本文小标题。
>
> **本轴一句话**：算法层不造新引擎、不引图库、不上 bi-temporal。目标是把已长在仓库里的对的骨架（FSRS 卡 / event 溯源 / prereq 边 / mem0 调和层 / rubric-validator 语义闸）**收敛成一致形态**，把**写了没人读 / 占位公式浪费 / 旁路未接通**的资产真正接通——一条「收敛 + 接通」主线。

---

## §0 三轴正交红线（贯穿全文的不变量）

四个表征**各管各，永不互相对账写回**（总账 §0 + B4 升为架构红线）：

| 轴 | 实体 | 回答 | 喂谁 | 物理载体 |
|---|---|---|---|---|
| **R**（FSRS 记忆维度） | `material_fsrs_state`（知识点 keyed，ADR-0005 单 writer） | 记得牢不牢 / 何时复习（when） | **调度**（per-item due） | PG 表，FSRS 数学单一真相 |
| **p(L)**（PFA 掌握诊断） | `mastery_state`（新，派生） | 此刻会不会 / 迁移得了吗 | **诊断展示 + 调度 what 信号** | PG 表/物化（取代 view 占位） |
| **difficulty**（共享桥） | FSRS `D` ≡ PFA `β`（同一潜量两层读） | 这个知识点/题多难 | 两轴共享输入 | 派生 + `item_calibration` 锚 |
| **mem0**（个性化软画像） | mem0 collection（不在 Drizzle） | 偏好/习惯/弱点（attention prior） | 编排者只读，**永不偏置 judge/FSRS** | 自管 pgvector |
| **KG**（结构） | `knowledge` 树 + `knowledge_edge` 网 + `misconception` | 知识怎么组织 | frontier / credit / 对比题 | PG 表 |

**红线落地**：
- **R ⟂ p(L) 不对账**（B1）。Bjork 失用新论：storage strength（FSRS S/R）与 retrieval strength（即时 accuracy）两构念可双向解耦，健康的间隔学习**本就规律性背离**（间隔越长 R 越低但 S 越高）。无对账先例；统一靠 forgetting-aware KT（PFA logistic 内含遗忘项）。**两轴背离信号重定义为 fluency-illusion 防假学习软提示，绝非 error-grade**——不触发任何自动修正，只在复盘面提示「这点你近期答得顺但间隔拉长后留存可能虚高」。
- **transfer credit 只进 p(L)**（B1 + RT2），**不碰 R/调度**——FSRS 的 `when` 数学绝不被 credit 污染。
- **difficulty 是唯一允许的跨轴共享**：FSRS `D` 与 PFA `β` 是「同一知识点难度」的两个观测面，共享 `item_calibration` 的后验锚，但**各自更新各自的状态**（D 走 FSRS review，β 走 PFA 梯度），不互写。

---

## §1 掌握诊断三维（B1）

### 现状（grounded）
- **双脑分裂无对账**（Phase 0 §6 承重墙#2）。调度只认 `material_fsrs_state.due_at`（FSRS 卡）；展示/AI 用 `knowledge_mastery` **PG view**（`src/db/schema.ts:806`），两者从不互相校准。
- **占位公式硬伤**。view DDL `drizzle/0005_phase1c1_event_payload_gin_and_mastery_view.sql`：30 天半衰期 `exp(-ln(2)*Δt/(30*86400))`（line 22）+ `evidence_count < 3 THEN 0.5::real`（line 61）+ 纯加权比值 `weighted_success/weighted_total`（line 62）。即**头三条证据一律假装 0.5**、无先验、第一条证据不更新。
- difficulty 现为题 `question` 的静态字段（default=3 量级），不随作答后验更新。

### 目标
**掌握 = 三维分层、共享潜量、对外折叠成单标量 + 离散档 + 置信区间**：

1. **R（FSRS，记忆）** —— 不变，喂调度，per-item。`material_fsrs_state` 单一真相、单 writer（ADR-0005/0011/0012 守）。
2. **p(L)（PFA logistic，掌握诊断）** —— 新建派生层 `mastery_state`，喂诊断展示 + 调度 what 信号。
   - PFA（Performance Factors Analysis）logistic：`logit(p) = β_kc + γ·success_count + ρ·fail_count`，**有先验**（β 来自 `item_calibration` 难度锚，γ/ρ 来自学习曲线先验），**第一条证据就更新**（删 `evidence<3→0.5` 占位）。
   - **含 transfer**：经 RT2 credit（prereq 反向遍历的 implicit evidence）注入 p(L) 计算，回答「迁移得了吗」。
3. **difficulty（共享桥）** —— FSRS `D` ≡ PFA `β`，两层共享输入。`item_calibration` 提供后验难度锚（§2/§3）。

**呈现口径**（总账 §1 末）：**置信区间 / 低置信标记**，不是干净「掌握度=78%」。慢热期（§3 阶段①②）一律低置信、只信相对排序。

### Delta
| 动作 | 形状 |
|---|---|
| 删占位 | 移除 view 的 `evidence<3→0.5` + 纯比值；改 PFA logistic（有先验、首条证据即更新） |
| view → 表 | `knowledge_mastery` view 升级为 `mastery_state` 派生表（§schema 落地）。**view 可保留为 PFA 输出的薄读层兼容旧消费者**，或直接退役——cross-统合需拍 |
| 接 transfer | RT2 credit 的 implicit evidence 进 PFA 的 success/fail 计数（带 encompassing_weight 衰减），**只进 p(L)** |
| fluency-illusion 提示 | 新增 R 与 p(L) 背离监测（纯派生，不写回），输出软提示到复盘面 |

### 有效性天花板（如实标）
- **n=1 无 cohort**：PFA 的 β/γ/ρ 系数工业上靠跨学习者拟合，单用户只能用先验 + 个体逐步纠偏（§3 自校准）。p(L) 绝对值长期低置信，**相对排序可信、绝对掌握度不可信**。
- R↔p(L) 背离「应正相关做对账」是 Phase 1 标注的**未验证假设、无文献**（Phase 1 §4 弱证据）——所以总账拍板「不对账」是对的，背离只做软提示不做 error-grade。

---

## §2 LLM 标定分轨（B1 标定）

### 现状（grounded）
- 难度是 `question` 静态字段，无校准管线。无 `item_calibration` 表。
- registry 里 `maxCost`/`fallbackChain`/多数 `systemPrompt` 是死装饰元数据（Phase 0 §6#9 / R8）——标定若新增 LLM 任务要走真通的 task 而非死字段。

### 目标
**走全诊断栈但分轨**（不计代价 + 分轨）：

**硬轨（可 n=1 自校验）**：
- **IRT 难度 `b` + 知识点 `θ`**，**仅客观题**（答案对得上语料即确定判分，闭环可自校验）。owner 客观题确定判分 = 干净 ground-truth 锚。

**软轨（标低置信）**：
- 区分度 `a`、猜测 `c`、CDM、KT、**古文开放题**——`a/c` 是 n=1 认识论死路（Stocking 1990：区分度/猜测参数需大样本跨考生方差才可辨识，单用户结构性不可辨）。全部**标低置信、隔离呈现**，绝不进硬轨自校验闭环。

**LLM 标定方法**（实证驱动，不 prompt 直接估）：
- **不直接 prompt 估难度**（实证 `r≈0`，LLM 自报难度与真实难度无关）。
- **LLM 抽教学特征**（`r≈0.78`）：抽认知负荷/步骤数/概念深度等特征 → 回归到难度。
- **LLM 模拟考生 ensemble**（客观题 `r=0.75-0.82`）：多 persona / ensemble / 弱模型优先（弱模型更接近学习者错误分布）模拟作答，从模拟正确率反推难度。

**零成本基线 gate**（防过度工程的有效性闸）：
- 全合成标定 vs 朴素基线（「题型/知识点难度历史均值」）**head-to-head**；不显著赢就**回退轻量基线**。这是算法侧的「不计代价 ≠ 不计有效性」执行点。

### Delta
| 动作 | 形状 |
|---|---|
| 建表 | `item_calibration`（§schema）：硬轨 `b/θ` 高置信列 + 软轨 `a/c/cdm/kt` 低置信列 + `confidence` + `track`(hard/soft) |
| 建 task | LLM-抽特征 task + LLM-模拟考生 ensemble task（走真通 registry，非死字段） |
| gate | 标定上线前跑零成本基线 head-to-head 比较脚本，不赢回退 |

### 有效性天花板
- **古文开放题 LLM 估难度差**（总账 §0 + Phase 1.5 §6）：开放题无 distractor、judge cause 归因软，模拟考生 ensemble 对开放题失效。**开放题难度长期停在软轨低置信**，靠 §3 阶段④ per-knowledge 滚动外推有限补救。
- `a/c` 单用户**永远不可辨识**——不是慢热能解的，是认识论死路。

---

## §3 自校准慢热四阶段（B1）

### 现状
无自校准管线。owner 是唯一 n=1 真人，真实作答尚未被用作 ground-truth 锚点。

### 目标：四阶段滚动解锁
| 阶段 | 信号源 | 置信 | 机制 |
|---|---|---|---|
| **① 纯 LLM 先验** | LLM 抽特征 + 模拟考生 | 全低置信，**只信相对排序** | 冷启动；难度/θ 仅作排序，不报绝对值 |
| **② Elo / Urnings 追 θ** | owner 真实作答 | 中 | **Elo/Urnings O(1) 更新 θ**，**锁 item 难度防方差膨胀**（单用户数据稀疏，同时动 θ 和 b 会发散） |
| **③ fixed-anchor + PPI + 三自检** | owner 客观题确定判分作干净锚 | 中高（硬轨） | **fixed-anchor**：客观题确定判分残差 = miscalibration 信号；**PPI**（Prediction-Powered Inference，数学保证「合成标定 + 真答」≥ 只用真答，不引入偏差）；**active learning 选题**（Fisher info p≈0.5 + 先验分歧最大，最大化每次作答的信息量）；三自检 = 三条独立 miscalibration 监测 |
| **④ per-knowledge 滚动解锁外推** | 达标知识点 | 该点高置信 | per-knowledge **滚动达标解锁开放题外推**——某知识点客观题锚足够后，才允许把校准外推到该点的开放题 |

### Delta
- 新增 Elo/Urnings 更新器（O(1)，锁 item 难度）；PPI 合成器；active-learning 选题器（接 §4 调度引擎的 what 选题）。
- ③ 的 fixed-anchor 残差 = §1 fluency-illusion 之外的第二条校准信号，落 `mastery_state` 的 `calibration_residual` 派生。
- **复盘面 = 自校准 UI 落点**（呼应 A2）：考 R 留存 + transfer 换情境 = owner n=1 锚点入口。

### 有效性天花板
- 阶段②的 Elo 在 n=1 收敛慢（单用户每天作答量小），**慢热是结构性的，不是 bug**——总账 §5「先埋点观测 N 周再定参」对此适用。
- PPI 的「数学保证」前提是合成标定无系统偏差；LLM 模拟考生若对某科目系统性偏（如古文）则 PPI 保证失效——**PPI 仅对硬轨客观题成立**。

---

## §4 调度合并引擎（B3）

### 现状（grounded）
- **三套近重复实现**（Phase 0 §6#3 / R5）：`due-list.ts` / `review-session.ts#planReviewSession` / `stream-store.ts` 的 FSRS-due 选题几乎逐行手抄。
- **AI 与确定性两条隔离通道**：AI `review_plan` job（独立 paper channel，ADR-0029）另开卷，**不接进 due 选题**。`variant-rotation` 自称「未来 AI scheduler 唯一 seam」但 AI 实际没接进。
- frontier 无一等公民实现（无 `learnable_frontier` CTE）。

### 目标：合并引擎（收回双通道）
**一个 AI 编排引擎通盘吃 → 产今日流**，输入：
```
FSRS due（R 轴）+ frontier（KG 结构）+ mastery p(L)（诊断）+ mem0 prior（个性化）+ AI 判断
```

**关键边界：合并 what + mix，FSRS when 数学不并进 AI**（独立真相源）：
- AI 引擎决定 **what**（学哪些知识点 / 哪些到期项主推）+ **mix**（block↔interleave 配比、新知/巩固比例）。
- FSRS 决定 **when**（到期时间 due_at）——**数学独立、不进 AI 循环**，AI 只读 due 列表作约束输入。

**三约束**（总账 §1 B3）：
1. **确定性硬约束嵌入**：到期必复习、孤儿 draft 排除——作 **hard constraint** 嵌入引擎（非 AI 软建议），AI 不能违反。
2. **可解释可追溯**：每条流项带 AI 理由（接 propose-only 留痕三表）。
3. **fallback**：AI 挂了退化到确定性 due 队列（degenerate 态设计，Phase 1 §4 缺口的算法侧补全）。

**frontier 一等公民**（B3 核心增值）：
- `learnable_frontier` = prerequisite-gating **递归 CTE**（已有 prereq 边 + 一条 CTE，**不重建 ALEKS 全局 knowledge space**）：所有 prereq 已掌握、自身未掌握的知识点。
- **空 frontier LLM 填充**：图稀疏/冷启动时 frontier 空，LLM 用语义 + 课程结构**猜临时 frontier**（低置信 propose-only），慢热被真实 prereq 边替换。这是冷启动/稀疏图退化态的算法侧解（Phase 1 §4 缺口）。

**退役**：
- `review_plan` job **直接退役并入引擎**（从 separate paper channel 降为引擎的一个 proposer 角色或全删）。**ADR-0029（AI 是独立 paper channel）被本决策推翻**，需 ADR supersede。
- 三套手抄选题逻辑收敛到引擎单一选题层（`due-list`/`review-session`/`stream-store` 共享一个 picker）。
- **FIRe 已砍**（总账 §1 + §3）：A 面（涨掌握）已由 B1 transfer credit 做；B 面（抵扣 due）砍——地基软（仅 justinmath.com 无学术论文）+ 耦合 R 制造信号混乱。**信号保持正交：R / p(L)+transfer credit / difficulty，三者不并。**

### Delta
| 动作 | 形状 |
|---|---|
| 建引擎 | `composeDailyStream` 编排层物化进 `practice_stream_item`，吃 5 输入产今日流 |
| 收敛选题 | 三套手抄 → 单一 picker（复用 `variant-rotation` 的 `pickProbeForKnowledge` 作复习侧子步骤） |
| frontier CTE | `learnable_frontier` 递归 CTE（prereq 反向 gating） |
| 空 frontier 填充 | LLM 临时 frontier task（低置信 propose-only） |
| 退役 review_plan | ADR-0029 supersede；job 降级/删除 |
| 砍 FIRe | 不新增 encompasses-抵扣-due 路径；信号正交 |

### 有效性天花板 + 依赖
- **A2 block↔interleave 阶段判定建在 mastery 信号上**（Phase 1 §4#2 依赖矛盾）——`mastery_state`（§1）必须**先于**调度引擎的 mix 逻辑落地，否则 mix 建在即将被改写的占位 view 上。
- block→interleave 切换阈值 = **产品决策 + 埋点**，不声称文献规定（总账 A2）。

---

## §5 关系结构（双层异构图 · RT1-4）

### 现状（grounded）
- `knowledge_edge`（`src/db/schema.ts:688`）：`relation_type text`（line 700）+ `weight real default 1`（line 702）+ `archived_at`（line 706，**单轴软删，无 valid_at/invalid_at**）+ UNIQUE(from,to,type)（line 709）。
- **无 misconception 表**（grep 零命中）。错因现活 event 层 per-attempt cause。
- **rubric-validator 已实现语义闸**（`src/capabilities/knowledge/server/rubric-validator.ts`）：`self_edge` / `cross_subject` / `parent_semantic_duplicate` / `prerequisite_no_order_evidence` / `contrasts_with_no_confusion` / `related_to_dumping_ground`——**全是语义层闸，无拓扑层**（环检测/方向矛盾/传递冗余确认零实现）。

### 目标：双层异构图（否决 GPT 三层平行图）
**树骨架（`parent_id` 只读）+ 同构 typed-edge 网（5 核心）+ 渐进晋升的 misconception 异构层**。三层分离：身份层（节点/边/misconception）/ 观测层（event 唯一真相，错因现活这）/ 派生层（mastery/credit，不写回）。

**RT1 错因图谱**（升，但「晋升而非复制」）：
- 同 effective_cause 同知识点跨 attempt 复现 **≥k 次** → 调和环 propose『晋升此错因为 misconception 节点』→ 人审 accept 才建；**只出现一次的永远留 event 层**。
- 独立 `misconception` 表（**不进树、不加 subject 列**——科目经其 caused_by 指向的 knowledge 节点 `effective_domain` 派生）+ `misconception_edge` 异构边（`caused_by` / `confusable_with` / `observed_in` / `remediated_by`）。
- SISM 措辞收紧为「并列 / 可共存建模」（**非统计独立**）。
- **gated 在一致性闸地基之后**（§6）。
- 误区节点**不持独立掌握度、不持独立调度**——`remediated_by` 复用 FSRS 管线做复习偏置。

**RT2 credit**（派生量，不物化回边）：
- 复用 prerequisite **反向**遍历（to→from）+ `encompassing_weight` 列；`weight × encompassing_weight` 连乘衰减，递归 CTE 算 implicit evidence。
- **不新建 encompasses 边、不新建第六 relation_type**。
- **credit 进 p(L)**（不进 R/调度）——接 §1 transfer。
- tree parent 链做向上 rollup（科目/簇掌握%），prereq 反向做向下 credit——**两个算子两组边两个方向，不混**。

**RT3 题型**（不建图）：
- 留 `question.kind` 字段 + `SubjectProfile.judgePolicy.routeByKind` 配置。题型→知识点 = `question.knowledge_ids[]`（已有，策划标注非统计推断）。

**RT4 治理**（enum 闭集 + 逃逸阀）：
- 5 核心 `relation_type` **闭集** + `experimental:*` 受闸逃逸阀。
- `weight` **钉死 confidence-only**（grep 证实无 strength 消费路径；strength/salience 留 future 第二列）。
- promote = experimental→Core 走 **migration + ADR 摩擦**（刻意）；四闸判定（频次≥N / pgvector 语义内聚单峰 / 类型签名可声明 / 可泛化跨数据集）+ promote/pass/fail 作 event 留痕。
- 新增 `audit:relations` 脚本（照 `audit:schema`/`audit:profile` 同形）。

### Delta
| 动作 | 形状 |
|---|---|
| misconception 表 | 新建（§schema），gated 在一致性闸后 |
| misconception_edge | 异构边表，先 `experimental` 试水；多态 vs 四窄表**待 owner 拍**（§未决） |
| encompassing_weight | `knowledge_edge` 加 nullable 列；**触发 audit:schema write-path**，需 propose 子类型（属性更新，非新边） |
| rubric-validator 整改 | `related_to` 加严 = **微调阈值**（已实现，非新建）；新增拓扑层闸归 §6 一致性闸 |
| audit:relations | 新脚本 + weight confidence-only 断言 |

### 有效性天花板
- **misconception_edge 多态破坏 knowledge_edge 同构性**（Phase 1.5 §6）——rubric-validator 所有闸假设两端是 knowledge，异构边需平行闸逻辑，**复用成本被 RT1 低估**。
- 开放题 `observed_in` 证据精度退化（judge cause 归因软）——**开放题为主科目误区图实际可用性存疑**，需打样数据集实测。
- 数值阈值（晋升 k、频次 N=15~20、encompassing_weight=0.3-0.4）单用户无基线，**观测窗口期内误区图/credit/promote 不可用**（特性非 bug，owner 须接受空窗期）。

---

## §6 一致性闸地基（YUK-344 重定向，priority High，独立前置）

### 现状（grounded）
- **bi-temporal 完全未落地**（Phase 0 §6#5）。`knowledge_edge` 只有 `archived_at` 单轴软删，无 `valid_at/invalid_at`。`getEffectiveTruth` + `CorrectionKind` 实现完整但作用域在 **EVENT 层**（practice 包），不是知识节点/边的事实时效。
- **写入期一致性闸零实现**（Phase 1.5 §4）：`src/server/memory/reconcile-llm` 是 mem0 个性化侧，不碰 knowledge_edge；knowledge capability 内无 cycle/direction/transitive 命中。

### 目标：YUK-344 从「补双轴」重定向为「一致性闸地基」
**bi-temporal 推翻**（总账 §3 + B2）：结构是 timeless 不变量；「不再为真」≈ curation 纠错（epistemic 轴）而非 valid-time；单用户不问历史结构态。**YUK-344 原第一条（knowledge_edge 补 valid_at/invalid_at）被推翻**，重定向为：

1. **写入期结构一致性闸**（补 rubric-validator 语义闸之外的**拓扑层**）：
   - **环检测**：prerequisite 边不得成环（A→B→C→A 是逻辑矛盾）。
   - **方向矛盾**：A prereq B 且 B prereq A 拒绝。
   - **传递冗余**：A→B→C 已存在时拒绝/降权直接 A→C（保图简洁）。
2. **写入期调和环**（复用 mem0 P2 调和骨架的设计，挂进 `runProposeAndWrite`）。
3. **取代复用 CorrectionKind**（epistemic 纠错走 correction event，不引 valid-time）。

**代码侧零实现，是 RT1（misconception 晋升环）/ RT2（传递冗余拦截）/ RT4（四闸③类型签名）共同前置**——闸不就位，所有升一等实体 / promote / credit 物化全悬空。

### Delta
| 动作 | 形状 |
|---|---|
| 拓扑闸 | knowledge capability 新增 cycle/direction/transitive 检测，挂写入期 |
| 调和环 | 复用 mem0 P2 reconcile 骨架设计，接 `runProposeAndWrite` |
| ADR | YUK-344 重定向需 ADR（推翻原 bi-temporal 第一条 + 记 memory-architecture §4.1/§8.2/§8.4 修订） |
| 排序 | **独立前置 phase**，先于 RT1/RT2/RT4 任何增量（Phase 1.5 §5#1） |

### 有效性天花板
- 写入期一致性闸零实现是四份建议**共同的乐观假设与现实的最大张力**（Phase 1.5 §6）——环形依赖盲区：caused_by 方向语义靠一致性闸钉死，而闸还没建。**这是承重墙级前置，不能跳。**

---

## §7 记忆 B4

### 现状（grounded）
- **P1+P2 已 live**：mem0ai 3.0.6 in-process（GLM 5.2 抽取 + 百炼 v4 1024 维 embedding）+ 自建调和层（reconcile job + GLM per-kind 决策 + jsonb 软取代 `superseded_by`/`invalid_at` + write-ahead log + 失败降级 KEEP_BOTH）；落自管 pgvector collection（不在 Drizzle，audit:schema 看不到）。
- **P3 读路径完全未落地**（Phase 0 §6#6）。`searchMemories` wrapper 全仓 grep 无果。后果：`search_memory_facts` 工具 + brief `searchFacts` 两读点**不过滤 P2 已软取代的 fact**——被取代的记忆仍被检索、甚至固化进 brief。软取代是「写了没人读」的半环。

### 目标
- **P3 读路径接通**（= task #23）：`searchMemories` wrapper = topK 放大 + superseded 过滤 + recency 半衰期重排；两消费者（`search_memory_facts` + brief `searchFacts`）透明获益。
- **喂信号收窄**（三轴正交升级架构红线）：**携带自然语言陈述的 event 才喂 mem0；数值留结构表**（mem0 本就不从数值推断）。
- **mem0 extraction gate（证据驱动，全局出手强度表 A/B/C 的算法侧落点）**：
  - **semantic-trait**（偏好/习惯/弱点）→ **加 accept gate**：pending + 来源 episodic 事件链 + 时间戳 + 一键 reject/edit；**编排者只读 accepted**。
  - **episodic**（客观事件）→ **全自动可撤**。
  - 证据：Gharat WSDM'26（记忆 summary 73.17% 有偏）+ Jiang AIES'19 + Sharma ICLR'24 + Chaney RecSys'18（顶会）。
- **透明视图 + 一键 retract**：「AI 关于你的记忆」面。

### Delta
| 动作 | 形状 |
|---|---|
| P3 wrapper | `searchMemories`（topK 放大 + superseded 过滤 + recency 半衰期重排）；两消费者改调它 |
| 喂信号收窄 | 抽取触发改为「仅含自然语言陈述的 event」；数值信号不进 mem0 |
| extraction gate | semantic 走 accept gate（pending 表 + reject/edit）；episodic 全自动可撤 |
| retract UI | 透明视图（B4 retract，交互层留白交 claude design） |

### 有效性天花板
- 「semantic 比 episodic 更易固化」**无 head-to-head 直证**，是机制 + 间接实证推断（总账 §1 B4 诚实标）——所以 gate 是保守防御，不是已证最优。
- mem0 collection 不在 Drizzle → `audit:schema` 看不到，需 `audit:relations` 之外的独立审计或文档兜底。

---

## §8 出题 B5

### 现状（grounded）
- **三套不一致信任闸**：OCR-path 弱链单信号 / QuizGen-path 五轴多信号 gate / Variant-path accept-first 反模式。
- 题 draft→active 经 Option B 验证闸（`quiz_verify`/`source_verify`）才 enroll；`auto-enroll` 默认 observe-only（enroll 真入库分支生产从未跑过，Phase 0 §6#7）。
- 难度静态 default=3，不随作答后验更新。

### 目标
- **统一 verify 契约 = Verifier Router**（GPT 稿吸收）：三闸（OCR/QuizGen/Variant）收敛到 QuizGen 五轴多信号模板，统一 **verify-then-promote**。
- **plan-then-generate + 客观题确定性校验**：答案对得上语料即放行，**不烧 LLM 再问一次**（接 B1 客观题 anchor）。
- **item-model 变式**：人 accept 模板 / 代码确定性实例化，**杜绝所见≠入库**。
- **Variant 翻转 verify-then-promote**（从 accept-first 反模式翻转）；auto-enroll source-tier 灰度（先 authentic + 客观题 + 确定校验通过）。
- **QuizVerify 扩 'error' 通道**（区分 transport/parse 失败 vs 真实 verdict）——**独立无依赖，先做**（Phase 1.5 §5#9 无条件先做）。
- 难度/客观校验/对比题/迁移题/题型存储已在 B1/RT1/RT3 钉。

### Delta
| 动作 | 形状 |
|---|---|
| Verifier Router | 抽 QuizGen 五轴 gate 成共享 verify 契约，OCR/Variant 复用 |
| 'error' 通道 | `QuizVerifyCheckVerdict` 扩 'error'（零结构改动，先做） |
| plan-then-generate | 出题先 plan 后 generate + 客观题确定性校验（接语料锚） |
| item-model 变式 | 模板 accept + 代码实例化 |
| Variant 翻转 | accept-first → verify-then-promote |

### 有效性天花板
- 客观题确定性校验高可靠；**开放题（古文鉴赏/论述）的 verify 环实际无可行方案**（Phase 1 §4 弱证据 + Phase 1.5 §6）——「provenance 锚 ground-truth」自承缺实证。开放题出题质量长期依赖软 judge，是天花板。

---

## §9 Schema 落地清单

> 形状 = 表/字段；audit = 是否触发 `pnpm audit:schema`「字段须有 write-path」；ADR = 是否需新 ADR。所有破坏性结构动作走 propose-only（红线）。

### 9.1 `item_calibration`（新表，B1 标定）
```
item_calibration(
  id                uuid pk,
  question_id       uuid fk → question,        -- 或 knowledge_id（题/知识点级，待定）
  track             text 'hard'|'soft',         -- 分轨硬约束
  irt_b             real null,                  -- 硬轨：难度（客观题高置信）
  knowledge_theta   real null,                  -- 硬轨：知识点掌握 θ
  irt_a             real null,                  -- 软轨：区分度（n=1 不可辨，低置信）
  irt_c             real null,                  -- 软轨：猜测
  cdm_json          jsonb null,                 -- 软轨：CDM/KT 派生
  confidence        real not null,              -- 置信度（呈现口径）
  source            text,                       -- 'llm_feature'|'sim_examinee'|'fixed_anchor'|'elo'
  calibrated_at     timestamptz,
  archived_at       timestamptz null
)
```
- **audit:schema**：所有列必须有 write-path。`item_calibration` 由标定 task INSERT + Elo/PPI UPDATE，**有 write-path**。但 `irt_a/irt_c/cdm_json` 在慢热期长期 NULL（软轨未上线）→ **须进 allowlist 标 `resolves_when: phase`**（软轨上线 phase）。
- **ADR**：**需**。「掌握诊断三维 + 标定分轨」是核心算法决策，应立 ADR（含 R⟂p(L) 不对账理由、PPI/fixed-anchor 自校准、零成本基线 gate）。

### 9.2 `mastery_state`（新表，取代 view 占位，B1 p(L)）
```
mastery_state(
  knowledge_id        uuid pk fk → knowledge,
  p_l                 real null,                -- PFA logistic p(L)；NULL=无证据（不再 0.5 占位）
  p_l_ci_low          real null,                -- 置信区间下界（呈现口径）
  p_l_ci_high         real null,
  success_count       real not null default 0,  -- 含 transfer credit（带 encompassing_weight 衰减）
  fail_count          real not null default 0,
  beta                real null,                -- difficulty 共享桥（≡ FSRS D 的诊断面）
  calibration_residual real null,              -- fixed-anchor 残差（§3 阶段③）
  fluency_illusion_flag boolean default false,  -- R↔p(L) 背离软提示（不写回 R）
  evidence_count      integer not null default 0,
  updated_at          timestamptz
)
```
- **形状抉择（cross-统合需拍）**：物化表（写侧更新）vs 升级版 PG view（即时算）。倾向**物化表**——PFA 需累积 success/fail 计数 + transfer credit 注入，纯 view 难承载 transfer 的递归 CTE 性能。`knowledge_mastery` view 可保留为薄兼容读层或退役。
- **audit:schema**：物化表所有列须有 write-path（PFA 更新器 UPDATE）。`fluency_illusion_flag` / `calibration_residual` 在慢热阶段①②未启用 → allowlist `resolves_when: phase`。
- **ADR**：与 9.1 同一 ADR（掌握诊断三维），或独立「mastery_state 取代占位 view」ADR。**推翻现状双脑分裂的隐含设计，必须 ADR 留痕。**

### 9.3 `misconception`（新表，RT1，gated 在一致性闸后）
```
misconception(
  id           uuid pk,
  title        text not null,                 -- 误区名（命名规范未定，§未决）
  reasoning    text,
  weight       real not null default 1,        -- confidence-only（RT4 钉死）
  created_by   text,                           -- 'reconcile_propose'|'human_accept'
  archived_at  timestamptz null
)                                              -- 不进树、不加 subject 列
```
- **audit:schema**：晋升环 propose + 人审 accept INSERT，**有 write-path**。但**建第一个节点 gated 在一致性闸 + ≥k 复现 + owner 拍板之后** → 上线初期表为空、列无 write-path 实跑 → **须进 allowlist 标 `resolves_when: phase`**（RT1 晋升环上线 phase）。
- **ADR**：**需**。RT1 升一等实体是 KG 本体变更。

### 9.4 `misconception_edge`（新表，RT1，先 experimental）
```
misconception_edge(
  id          uuid pk,
  from_id     uuid not null,                   -- 多态：misconception
  from_kind   text,                            -- 多态 from
  to_id       uuid not null,                   -- 多态：knowledge/misconception/event/probe
  to_kind     text 'knowledge'|'misconception'|'event'|'probe',
  edge_type   text 'caused_by'|'confusable_with'|'observed_in'|'remediated_by',
  weight      real not null default 1,         -- confidence-only
  created_by  text,
  archived_at timestamptz null
)
```
- **形态待 owner 拍**：**一张多态边表**（灵活，需平行闸逻辑）**vs 四张窄专表**（严但碎）。Phase 1.5 §5#4 未决。
- **audit:schema**：有 write-path（晋升环 + 组卷对比题消费）。同 misconception 受 gating → allowlist `resolves_when: phase`。
- **ADR**：与 misconception 同一 ADR。异构边破坏 knowledge_edge 同构性，需在 ADR 显式记 rubric-validator 平行闸成本。

### 9.5 `knowledge_edge.encompassing_weight`（加列，RT2）
```
ALTER TABLE knowledge_edge ADD COLUMN encompassing_weight real null;
-- 仅对 prerequisite 行有意义；NULL = 不可 trickle-down credit
```
- **audit:schema**：**触发 write-path 检查**。需新 **propose 子类型 = 属性更新**（非新边），比「加一列」重（Phase 1.5 §6 标）。上线前若无 propose 路径 → allowlist `resolves_when: pr`（实现 encompassing_weight propose 的 PR）。
- **ADR**：建议**需**（RT2 credit 派生 + encompassing_weight 语义 + 反向遍历 CTE），或并入 RT1/RT2 合并 ADR。

### 9.6 mem0 P3 / extraction gate（无 Drizzle schema，但有审计盲区）
- `searchMemories` wrapper、extraction accept gate 的 pending 状态——**mem0 collection 不在 Drizzle**，`audit:schema` 看不到。semantic-trait accept gate 的 pending 表**若落 PG** 则进 audit:schema（有 write-path：propose + reject/edit）；若落 mem0 metadata 则需文档兜底。**cross-统合需拍 pending 存哪。**
- **ADR**：B4 extraction gate（semantic accept / episodic 自动）+ 喂信号收窄是记忆架构决策，建议补 memory-architecture §修订或独立 ADR。

### Schema 落地汇总表
| 表/列 | 动作 | audit:schema | ADR |
|---|---|---|---|
| `item_calibration` | 新表 | 是（软轨列 allowlist:phase） | 需（掌握诊断三维） |
| `mastery_state` | 新表（取代 view 占位） | 是（慢热列 allowlist:phase） | 需（同上或独立） |
| `misconception` | 新表（gated 闸后） | 是（gating 期 allowlist:phase） | 需（RT1 一等实体） |
| `misconception_edge` | 新表（experimental；多态 vs 四窄表待拍） | 是（allowlist:phase） | 需（同 RT1） |
| `knowledge_edge.encompassing_weight` | 加列 | 是（需 propose 子类型；allowlist:pr） | 需/并入 RT2 |
| mem0 P3 / gate pending | wrapper + gate（pending 存哪待拍） | 视 pending 落 PG 与否 | 建议（memory-arch 修订） |

---

## §10 算法侧未决 / 需 owner 拍（cross-统合收口候选）

1. **`mastery_state` 物化表 vs 升级版即时算 view**。PFA 需累积计数 + transfer 递归 CTE 注入，倾向物化表；但物化引入写侧更新器 + 一致性维护。**`knowledge_mastery` view 退役还是保留为薄兼容层**也连带未决。（影响 §1/§4 落地形状 + audit:schema 形态）

2. **`misconception_edge` 单多态表 vs 四窄专表**（Phase 1.5 §5#4）。多态灵活但破坏 knowledge_edge 同构性、需平行闸逻辑；四窄表严但碎。直接决定 §9.4 schema 形状 + rubric-validator 异构闸的复用成本。

3. **`item_calibration` keyed 在 question 还是 knowledge_id**（题级难度 b vs 知识点级 θ 是否同表）。IRT `b` 天然题级、`θ` 知识点级，混一表 vs 拆两表影响标定管线与 PFA β 桥的接法。

4. **mem0 extraction gate 的 pending 状态落 PG 表还是 mem0 metadata**（§9.6）。落 PG → 进 audit:schema 受治理；落 mem0 → 审计盲区需文档兜底。连带 reconciliation_log「知识侧 / 个性化侧共表与否」（总账 §5）。

5. **零成本基线 gate 的「不显著赢」判据 + 慢热期所有数值阈值**（晋升 k、频次 N=15~20、encompassing_weight=0.3-0.4、PFA γ/ρ 先验、Elo K 因子）。总账 §5 已拍「先埋点观测 N 周再定参」——但**埋点观测的最小数据量 / 何时算「攒够」** 本身需 owner 定，否则慢热期无终点。古文开放题因 LLM 估难度差，其阈值可能**永远达不到外推闸门**（§2/§8 天花板），需 owner 接受「开放题为主科目部分算法资产长期不可用」。

---

**Linear 捕获**：本任务是 Phase 2 综合稿（产品/feature 层架构综合，非实现），未产生独立可执行代码 follow-up——所有落地动作（item_calibration / mastery_state / misconception 等）须经 cross-统合 agent 收束成统一计划后才拆 Linear issue，此时单独建 issue 会与 cross-统合产出重复。一致性闸地基的独立前置性（YUK-344 重定向）已在 Phase 1.5 §5#1 标为「建议单独 Linear issue」——这是**唯一**已可确定的 Linear 动作，建议 cross-统合或 owner 落地时补建 YUK-344 重定向 issue（推翻 bi-temporal 第一条 + 拓扑闸 + 调和环）。本综合者不越权代建。

---

## Lane 3 · 依赖排序路线图

I have everything I need. The four design docs plus the live Linear state of YUK-203, YUK-249, YUK-344, YUK-346, YUK-347 are all grounded. Now I'll synthesize the dependency-ordered roadmap.

A few key Linear facts that sharpen the mapping: YUK-344 is `blockedBy YUK-342` (shares the P2 reconcile prompt skeleton — note YUK-342 = memory P2 reconcile layer, already live per Phase 0); YUK-249 and YUK-347 are mutually exclusive scope-naming proposals both In Progress (YUK-347 PR #406 already APPROVED, taking the "neutral general" path that supersedes YUK-249's rename); YUK-203 P3 (FSRS-by-knowledge + AI scheduling) is In Progress and is the home for the `knowledge_mastery` view rewrite work.

Here is the synthesis.

---

# Phase 2 综合 · 依赖排序落地路线图

> **这是什么**：把决策总账（算法 B1-B5 + 形态 A1-A4 + 关系 RT1-4 + 记忆）的全部拍板，排成一条「依赖排序的落地路线图」。下游 cross-统合 agent 消费。
>
> **不是什么**：不是像素级设计稿（视觉后续交 claude design）；不是重新选型（拍板已锁，本稿只排序拼装）；不是 ROI 否决（工程代价不作否决理由，但有效性天花板如实标）。
>
> **读法**：§A 零依赖立即起跑 → §B 依赖链分波（含有向阻塞图）→ §C 观测窗口空窗期 → §D 关键路径与瓶颈 → §E 需 owner 拍的排序决策。

---

## §0 全局依赖事实（贯穿所有波次的承重墙）

把四份文档的依赖事实先固化为五条不可违反的排序定律，后面所有波次都从这里推导：

| # | 定律 | 来源 | 后果 |
|---|------|------|------|
| **D-1** | **一致性闸地基（YUK-344）是 RT1 误区晋升环 / RT2 传递冗余拦截 / RT4 类型签名闸的共同前置，且代码侧零实现** | Phase1.5 §4 big bet #1；总账 §1 关系结构 | 所有「升一等实体 / promote / credit 物化」必须排在它之后。它本身又 `blockedBy YUK-342`（共享 P2 reconcile prompt 骨架）——但 YUK-342 P2 已 live（Phase0 §3 记忆），所以**前置已满足，YUK-344 可立即起跑** |
| **D-2** | **`knowledge_mastery` view 重写（B1 PFA logistic）是 RT2 credit 注入 p(L) 的前置；而 view 重写本身卡在 B1 vs B3 二选一硬矛盾** | Phase1 §4 矛盾 1+2；Phase1.5 §5.6 | view 重写解锁 A2 阶段判定 + RT2 credit。但 owner 必须先拍「统一掌握信号」（总账已拍三轴正交=R⟂p(L)⟂difficulty，B1vsB3 已被总账调和——见 §B-Wave2 注） |
| **D-3** | **埋点观测 N 周**：所有数值阈值（缕数上限/k 晋升/encompassing_weight/block-interleave 切换/auto-enroll 灰度/外推闸门）单用户无基线 | 总账 §5；Phase1 §4 缺口；Phase1.5 §6 | 观测窗口期内**误区图/credit/promote 不可用是特性非 bug**。埋点是「攒数据」不是「写代码」，与代码波次并行但不阻塞代码 |
| **D-4** | **scope 决策（全科 vs 文言文深耕，YUK-249/YUK-347 命运）gate 扩科相关投入** | 总账 §5；Phase1 §6.3 | 一致性闸地基 + weight 钉死 + verify 'error' 通道**零 scope 依赖**先做；misconception/credit/routeByKind 等扩科向投入受此 gate。注意 YUK-347（中性 general）PR #406 已 APPROVE，事实上已选「泛用框架」路径，YUK-249 改名方案待 owner 正式废止 |
| **D-5** | **慢热自校准四阶段是时间序列**（① 纯 LLM 先验 → ② Elo 追 θ → ③ fixed-anchor 纠偏+PPI+三自检 → ④ per-knowledge 滚动达标解锁开放题外推），不能跳 | 总账 B1；Phase1 §3 bet1 | 每阶段前置上一阶段的真实作答锚点累积；阶段③④本质是 D-3 埋点的算法侧消费者 |

---

## §A 零依赖可立即起跑（无 owner gate / 无前置）

这些可以**今天就并行开工**，互不阻塞，且不依赖任何未拍决策或观测数据：

| 候选 | deliverable | 为什么零依赖 | Linear 映射 |
|------|-------------|--------------|-------------|
| **A0-1 QuizVerify 'error' 通道** | `QuizVerifyCheckVerdict` 扩 'error'（区分 transport/parse 失败 vs 真实 verdict） | 零结构改动、独立于建不建图、独立于 scope；Phase1.5 §5.9 明列「无条件先做」 | B5 子项；新 issue（建议挂 YUK-203 P 系或独立小 issue） |
| **A0-2 mem0 P3 读路径接通（task #23）** | `searchMemories` wrapper（topK 放大 + superseded 过滤 + recency 半衰期重排）；两消费者 `search_memory_facts` + brief `searchFacts` 透明获益 | P1/P2 已 live（Phase0 §3），唯一缺口是读侧；纯接通已写入资产，不依赖任何拍板 | B4；YUK-322 epic 下（记忆半边） |
| **A0-3 一致性闸地基本身（YUK-344）** | 写入期结构一致性闸（环检测 hard-reject / 方向矛盾 hard-reject / 传递冗余 warning）+ 写入期调和环（复用 YUK-342 P2 reconcile 骨架）+ 取代复用 `getEffectiveTruth`+`CorrectionKind`（补「晋升错了」走 retract） | `blockedBy YUK-342` 已满足（P2 live）；rubric-validator 语义闸已成熟（Phase1.5 §4 意外发现），本 issue 只补拓扑层 + 调和环；priority High | **YUK-344**（父 YUK-322） |
| **A0-4 weight 钉死 confidence-only** | `knowledge_edge.weight` 语义固定为 confidence-only；strength/salience 留 future 第二列文档化 | grep 证实无 strength 消费路径（Phase1.5 §5.2）；纯语义固化 + 文档，无下游 | RT4；可并进 YUK-344 或独立小 PR |
| **A0-5 rubric-validator 阈值微调** | `related_to` dumping-ground 等已实现语义闸的**阈值微调**（非新建——闸已成熟） | Phase1.5 §4 意外发现：闸比假设成熟，RT4 说的「related_to 加严」其实已做 | RT4；独立小 PR |
| **A0-6 文档↔代码诚实对齐**（机会性） | ARCHITECTURE.md 六契约表回填 / docs/architecture.md 概念段去 embedded_check / actor_ref 'tencent_ocr' 误导 / cost_ledger mimo 恒记 0 标注 | Phase0 §6 张力 9；不阻塞功能但「在错误地图上设计」是隐性税；可与任意波次并行 | 各域 follow-up；不开 epic |

> **零依赖波的安心结论**（呼应 Phase1 §1）：起跑波**没有一个需要新引擎/新图库/新基建**。全是「接通已写入的 seam（A0-2）+ 固化已有语义（A0-4/A0-5）+ 补已设计的拓扑闸（A0-3）」。

---

## §B 依赖链分波

### 有向依赖图（A 阻塞 B，箭头 = 阻塞方向）

```
[Wave 0 零依赖] ───────────────────────────────────────────────┐
  A0-1 QuizVerify 'error'                                       │
  A0-2 mem0 P3 读路径(task#23) ──────────┐                      │
  A0-3 一致性闸地基(YUK-344) ──┬──────────┼─────────┐           │
  A0-4 weight 钉死 ────────────┘          │         │           │
  A0-5 rubric 阈值微调                    │         │           │
                                          │         │           │
[Wave 1 掌握信号地基]                     │         │           │
  B1 knowledge_mastery view 重写(PFA) ◀───┘(独立)   │           │
    │  └─ 需 owner 拍「统一掌握信号」(已被总账三轴正交调和)      │
    ▼                                               │           │
[Wave 2 派生层接通]                                 │           │
  RT2 credit 注入 p(L) ◀── B1 view 重写(D-2)        │           │
  A2 block↔interleave 阶段判定 ◀── B1 view(矛盾2)   │           │
  B3 合并编排引擎(what+mix) ◀── B1 view + frontier  │           │
  frontier 一等公民(prereq-gating CTE) ◀── 独立     │           │
                                                    │           │
[Wave 3 关系增量(受一致性闸+scope 双 gate)]         │           │
  RT1 misconception 晋升环 ◀── YUK-344(D-1) ────────┘           │
    └─ 受 scope gate(D-4) + 埋点 k(D-3)                         │
  RT4 promote 四闸(类型签名闸) ◀── YUK-344(D-1)                 │
  RT3 routeByKind 配置 ◀── scope gate(D-4)                      │
                                                                │
[Wave 4 形态/编排叙事(可与 W1-3 部分并行)] ◀────────────────────┘
  A1 今日之线四层
  A3 单编排者统一叙事 + 自主滑块 hint-first
  A4 出手强度表 A/B/C
  B5 统一 verify 契约 + auto-enroll 灰度

[埋点观测 N 周] ══ 横切 Wave1 起持续运行，喂 Wave3 数值参数 + B1 自校准③④
```

### 各波 deliverable / 前置 / 解锁 / Linear 映射

#### Wave 0 — 零依赖起跑（见 §A，可立即并行）
- **解锁**：A0-2 解锁「AI 看到的记忆不再含已取代 fact」（影响所有读 mem0 的 surface）；A0-3+A0-4 解锁整个 Wave 3 关系增量；A0-1 解锁 B5 verify 契约的失败态可观测。

#### Wave 1 — 掌握信号地基（承重墙）

| deliverable | 前置 | 解锁了什么 | Linear |
|-------------|------|-----------|--------|
| **B1 `knowledge_mastery` view 重写**：删 `evidence<3→0.5` 占位，换 PFA logistic（有先验、首证更新、含 transfer 但 transfer 只进 p(L) 不碰 R） | owner 拍「统一掌握信号」（**总账已调和**：三轴正交 R⟂p(L)⟂difficulty，B1 双层 + 分轨；B1vsB3 矛盾已被「R 喂调度 / p(L) 喂诊断展示 / accuracy 仅旁观」消解） | RT2 credit / A2 阶段判定 / B3 引擎 frontier 排序全部解锁（D-2） | **YUK-203 P3**（FSRS 按知识点 + 与 knowledge_mastery 对齐，In Progress）；mastery view = drizzle/0005 |
| **B1 慢热阶段①纯 LLM 先验** | LLM 抽教学特征（r≈0.78）+ LLM 模拟考生 ensemble（客观题 r=0.75-0.82）；**不直接 prompt 估难度（r≈0）** | 给 view 一个非占位的冷启动先验 | YUK-203 P3 / 新 calibration 子 issue |
| **零成本基线 gate** | B1 view | 全合成标定 vs「题型/知识点难度历史均值」朴素基线 head-to-head；不显著赢就回退轻量基线 | B1；落 audit 脚本或 calibration job |

> **有效性天花板（如实标）**：B1 软轨（区分度 a、猜测 c、CDM、KT、古文开放题）是 n=1 认识论死路（Stocking 1990），标低置信；古文开放题 LLM 估难度 r≈0，外推闸门必须保守。这些是天花板不是 bug，不作否决理由但呈现口径必须用置信区间/低置信标记，非干净「掌握度=78%」。

#### Wave 2 — 派生层接通（读 Wave 1 重写后的 view）

| deliverable | 前置 | 解锁了什么 | Linear |
|-------------|------|-----------|--------|
| **B3 合并编排引擎**（一个 AI 编排引擎吃 FSRS due + frontier + mastery + mem0 prior → 今日流；**合并 what+mix，FSRS when 数学独立真相源不并入 AI**；三约束=硬约束嵌入+可解释+fallback） | B1 view（frontier 排序读 p(L)）+ frontier CTE | A1 今日主缕的候选来源；A2 流为脊柱 | YUK-203 P3 延伸 / 新引擎 issue；review_plan 退役并入 |
| **frontier 一等公民**（prerequisite-gating 递归 CTE）+ **空 frontier LLM 填充**（低置信 propose-only，慢热被真实边替换） | 已有 prerequisite 边（独立，可与 B1 并行） | B3 引擎的「学什么」轴 | YUK-203 / 新 issue |
| **RT2 credit 注入 p(L)**（prereq 反向遍历 + `encompassing_weight` nullable 列，weight×encompassing_weight 连乘衰减递归 CTE，不写回边） | **B1 view 重写（D-2 硬前置）** + `encompassing_weight` 加列（触发 audit:schema，需新 propose 子类型=属性更新非新边） | 高阶知识点 attempt 的隐式 credit 喂掌握诊断 | RT2；YUK-322 关系族下新 issue |
| **A2 block↔interleave 阶段判定**（B1 p(L) 掌握阶段驱动：新知 block / 巩固 interleave，可 override） | **B1 view（矛盾 2 硬前置）** | A2 练习旅程的视图切换逻辑 | A2；形态向 issue |

> **encompassing_weight 加列代价（如实标）**：触发 audit:schema「字段须有 write path」，需新 propose 子类型（属性更新而非新边），比「加一列」重（Phase1.5 §6）。落地前先人工抽样标 N 条 prereq 边看 component 重合率（owner 拍板 §E）。

#### Wave 3 — 关系增量（受「一致性闸地基 + scope」双 gate + 埋点 N 周）

| deliverable | 前置 | 解锁了什么 | Linear |
|-------------|------|-----------|--------|
| **RT1 misconception 晋升环**（同 effective_cause 同知识点跨 attempt 复现 ≥k 才 propose 晋升、人审 accept；独立 `misconception` 表不进树不加 subject 列 + `misconception_edge` 异构边 caused_by/confusable_with/observed_in/remediated_by） | **YUK-344 一致性闸地基（D-1 硬前置）** + scope gate（D-4）+ 埋点定 k（D-3） | 跨 attempt 追踪同一误区 / 对比辨析题 / 按误区组补救卷 | RT1；YUK-322 关系族下新 issue（gated 在 YUK-344 之后） |
| **RT4 promote 四闸**（类型签名闸 = 四闸③，频次≥N + pgvector 语义内聚 + 类型签名可声明 + 可泛化）+ `audit:relations` 脚本 + promote 走 migration+ADR 摩擦 | **YUK-344（类型签名闸悬空依赖一致性闸，D-1）** + 埋点定 N（D-3） | experimental:* → Core enum 的受控晋升 | RT4；新 issue + 新 audit 脚本 |
| **RT3 routeByKind 配置**（不建图，`question.kind` 字段 + `SubjectProfile.judgePolicy.routeByKind`） | scope gate（D-4，扩科才需多学科 verifier） | 题型→验证器路由 | RT3；落 SubjectProfile（同 YUK-347 profile 体系） |

> **观测窗口期内 RT1/RT2-credit/promote 不可用是特性非 bug**（D-3）。开放题（古文鉴赏/论述）的 `observed_in` 证据精度退化——开放题为主科目误区图实际可用性存疑，需打样数据集实测（Phase1.5 §6，有效性天花板）。

#### Wave 4 — 形态/编排叙事（可与 Wave 1-3 部分并行；交互层留待 claude design）

| deliverable | 前置 | 解锁了什么 | Linear |
|-------------|------|-----------|--------|
| **A1 今日之线四层**（交班缕夜链 forethought event 派生 + 今日主缕策展 3-5 候选 + 次级副歌降可下钻 + 完成度收尾；缕数封顶 5 上限内 AI 动态 1-5；策展≠隐藏全量可下钻） | 主缕候选来源最终接 B3 引擎（W2）；但交班缕 event 派生 + 结构形态可先做；缕数上限是埋点参数（D-3） | 一天的入口形态 | A1；形态向 issue（结构层；交互层 claude design） |
| **A3 单编排者统一叙事**（前台 Copilot + 后台 4 job 合为同一 D14，actor_ref 分轨）+ **自主滑块 hint-first**（可一次走到完整答案，防 Khanmigo）+ 上下文两层契约（会话级工作记忆 + 长时 attention prior mem0 只读） | 防循环注入五防必守；mem0 只读旁路（A0-2 接通后更干净） | AI 角色的统一性 | A3；YUK-346（主 agent 换 GLM 评估）解耦——是 provider 评估，不阻塞 A3 叙事 |
| **A4 出手强度表 A/B/C**（A 自动+撤销窗口 / B 逐条人审 / C 纯状态不进队列；A 档 kind 用静态可逆性兜底不靠 confidence；defer/archive/judge_retraction 移出裁决面） | confidence 数据基础不足 → 用静态可逆性兜底（不阻塞）；撤销窗口是埋点参数（D-3） | 读 vs 判两面边界；inbox 18-kind → 7 真裁决项 | A4；YUK-44（inbox accept 未实现）相关 |
| **B5 统一 verify 契约**（三闸 OCR/QuizGen/Variant 收敛到 QuizGen 五轴多信号模板，verify-then-promote）+ plan-then-generate + 客观题确定性校验 + item-model 变式 + auto-enroll source-tier 灰度 | A0-1 'error' 通道（失败态可观测）；auto-enroll 灰度阈值是埋点参数（D-3）；客观题确定性校验接 B1 客观题 anchor | 出题闭环 + 生成→入库通路 | B5；YUK-203 P 系（quiz 域） |

---

## §C 观测窗口（埋点攒数据 ≠ 写代码的空窗期）

**埋点本身是 Wave 1 起就该并行铺设的轻量代码**（写 event/遥测），但「攒够 N 周数据再定参」是**纯等待的空窗期**，下列能力在窗口期内显式不可用（特性非 bug，owner 须接受）：

| 阶段/能力 | 空窗期性质 | 何时解除 |
|-----------|-----------|----------|
| **缕数上限（1-5 动态）** | 先封顶 5 硬值，AI 在上限内动态；最优上限待埋点真实分布 | 埋点 N 周后定参 |
| **k 晋升阈值（RT1）** | 误区晋升环代码可先就位，但 k 未定 → 晋升不触发 | 埋点 N 周 + owner 拍 k |
| **encompassing_weight（RT2，0.3-0.4 候选）** | credit 注入代码可就位，但 weight 默认 NULL（不 trickle-down）→ credit 静默 | 人工抽样标 component 重合率 + 埋点 |
| **频次 N（RT4 四闸①，N=15~20 候选）** | promote 四闸可就位，但 N 未定 → 无 promote 触发 | 埋点 N 周 |
| **block-interleave 切换阈值（A2）** | 阶段判定代码就位，但切换点是产品决策+埋点（不声称文献规定） | 埋点 N 周 |
| **auto-enroll 灰度阈值（B5）** | 默认 observe-only（只写审计事件零 domain 行，Phase0 §3），灰度先 authentic+客观题+确定校验通过 | 埋点 + owner 拍灰度门 |
| **外推闸门（B1 阶段④）** | per-knowledge 滚动达标才解锁开放题外推 | 慢热 D-5 阶段③累积锚点后 |
| **B1 自校准阶段②③④** | ① 纯先验可立即；② Elo 追 θ 需真实作答序列；③ fixed-anchor 需 owner 客观题干净判分锚累积；④ 需 per-knowledge 达标 | D-5 时间序列，按真实作答节奏推进 |

> **关键**：窗口期内**误区图 / credit / promote 三者整体不可用**（D-3 + D-1 叠加）。这不是 bug，是单用户 n=1 无 cohort 基线的固有约束。埋点遥测代码（写 event 维度）应在 Wave 1 就铺好，让窗口尽早开始计时。

---

## §D 关键路径（从今天到「误区图+credit+自校准全可用」的最短路径 + 瓶颈）

### 最短关键路径（串行不可压缩段）

```
今天
 │
 ├─[关键路径 a: 误区图+credit]
 │   YUK-344 一致性闸地基 (Wave0, 可立即起跑, blockedBy YUK-342 已满足)
 │        │
 │        ├──▶ RT1 误区晋升环代码 (Wave3) ─┐
 │        └──▶ RT4 类型签名闸代码 (Wave3) ─┤
 │                                          │
 │   B1 knowledge_mastery view 重写 (Wave1) │
 │        │                                 │
 │        └──▶ RT2 credit 注入 p(L) 代码 (Wave2) ─┤
 │                                                │
 │   [埋点 N 周 攒数据] ═══════════════════════════╪══▶ 定 k / N / encompassing_weight
 │                                                │         │
 │                                                ▼         ▼
 │                              误区图 + credit「全可用」(代码就位 ∧ 参数定 ∧ 一致性闸在)
 │
 └─[关键路径 b: 自校准]
     B1 阶段① 纯 LLM 先验 (Wave1, 可早起)
          │
          ▼ (需真实作答序列累积 — 时间序列 D-5)
     阶段② Elo 追 θ
          │
          ▼ (需 owner 客观题干净判分锚累积)
     阶段③ fixed-anchor 纠偏 + PPI + 三自检
          │
          ▼ (需 per-knowledge 滚动达标)
     阶段④ 开放题外推「全可用」
```

### 瓶颈识别

| 瓶颈 | 性质 | 为什么是瓶颈 | 缓解 |
|------|------|-------------|------|
| **瓶颈 1：埋点 N 周数据累积** | **时间瓶颈（不可用工程压缩）** | 误区图/credit/promote 全部参数依赖真实作答分布；单用户 n=1 无法借 cohort 基线 | 埋点代码 Wave 1 就铺好，让窗口尽早计时；代码可先于参数就位（参数化默认 NULL/封顶硬值） |
| **瓶颈 2：B1 自校准时间序列（D-5）** | **时间瓶颈** | 阶段②③④逐级前置上一阶段的真实锚点累积；owner 是唯一 n=1 真人，作答节奏即上限 | 阶段①纯先验可立即上线给非占位冷启动；后续阶段随作答自然推进 |
| **瓶颈 3：B1 view 重写卡 owner「统一掌握信号」拍板** | **决策瓶颈（已被总账调和）** | 历史上 B1vsB3 硬矛盾（Phase1 §4 矛盾1）会阻塞 view 重写；但**总账三轴正交 + 分轨已消解**（R 喂调度 / p(L) 喂诊断 / accuracy 旁观） | owner 在路线图层确认调和成立即可解锁（§E-1） |
| **瓶颈 4：YUK-344 单点前置整个 Wave 3** | **结构瓶颈** | RT1/RT4 全悬空依赖它，代码侧零实现 | 它零依赖可立即起跑（§A-A0-3），优先级 High，应作为最早启动的「重活」之一 |

**一句话关键路径**：`YUK-344 一致性闸地基` 与 `B1 view 重写` 是两条并行的承重墙，二者就位后 RT1/RT2/RT4 代码可跟进，但**真正「全可用」被埋点 N 周（瓶颈 1）与自校准时间序列（瓶颈 2）这两个不可压缩的时间瓶颈钉死**——工程能做的是「让代码在参数到位前先就位、让埋点尽早开始计时」，缩短的是工程延迟而非时间瓶颈本身。

---

## §E 路线图层面需 owner 拍的排序决策

> 这些是**排序/启动 gate** 级决策（区别于总账 §5 已列的参数/形态细节）。不拍则对应波次无法启动或会返工。

| # | 排序决策 | 阻塞什么 | 建议默认 |
|---|---------|---------|----------|
| **E-1** | **确认 B1vsB3「统一掌握信号」调和成立**（总账三轴正交 R⟂p(L)⟂difficulty + 分轨是否就是最终裁决） | B1 view 重写（瓶颈 3）→ 整个 Wave 2 | 确认成立（总账已拍三轴正交，此处仅是排序层 sign-off） |
| **E-2** | **scope 正式拍板：YUK-249（改名语文）废止 vs 保留**（YUK-347 中性 general PR #406 已 APPROVE 事实选了泛用框架路径） | RT1/RT3 扩科向投入（D-4）；YUK-249 当前仍 In Progress 与 YUK-347 方案互斥 | 废止 YUK-249，采 YUK-347 中性 general（泛用框架 + 学科插件，呼应 GPT 稿） |
| **E-3** | **YUK-344 是否作为「最早启动的重活」立即起跑**（它 gate 整个 Wave 3，零依赖 + High） | Wave 3 全部（瓶颈 4） | 是，与 B1 view 重写并行起跑 |
| **E-4** | **埋点遥测在 Wave 1 即铺设**（让 N 周窗口尽早计时；接受窗口期误区图/credit/promote 显式不可用） | 误区图/credit/promote「全可用」时点（瓶颈 1） | 是，埋点代码优先于参数化能力 |
| **E-5** | **RT1 代码是否在参数（k）未定前先就位**（代码就位但 k=NULL 不触发，vs 等参数齐再写代码） | RT1 上线节奏 | 代码先就位（默认值守门，参数后填），与埋点并行 |
| **E-6** | **encompassing_weight 加列前是否先做 component 重合率人工抽样**（决定 RT2 credit 是否值得物化此列） | RT2 credit 启动（Wave 2） | 先抽样 N 条 prereq 边标重合率（Phase1.5 §5.5），低重合则 credit 降级或押后 |
| **E-7** | **A1/A4 结构层是否先于 B3 引擎落地**（A1 主缕候选最终接 B3，但交班缕/结构形态可先做） | A1/A4 启动节奏 vs Wave 2 引擎 | A1 交班缕（event 派生）+ A4 静态可逆性表先做（不依赖引擎/confidence），主缕候选接 B3 时再 thread |
| **E-8** | **misconception_edge 单多态表 vs 四窄表**（影响 RT1 代码形态 + rubric-validator 平行闸复用成本） | RT1 代码形态 | 单多态边表先 experimental 试水（Phase1.5 §2 倾向），异构边需平行闸逻辑成本须计入 |

---

## §F Linear epic/issue 映射总表（供 cross-统合直接消费）

| Wave | deliverable | Linear |
|------|-------------|--------|
| W0 | A0-3 一致性闸地基 + A0-4 weight 钉死 | **YUK-344**（父 YUK-322，High，blockedBy YUK-342 已满足） |
| W0 | A0-2 mem0 P3 读路径(task#23) | YUK-322 epic 记忆半边新子 issue |
| W0 | A0-1 QuizVerify 'error' / A0-5 rubric 阈值微调 | 独立小 issue（B5/RT4 子项） |
| W1 | B1 view 重写 + 慢热阶段① + 基线 gate | **YUK-203 P3**（FSRS 按知识点 + mastery 对齐，In Progress）+ calibration 子 issue |
| W2 | B3 合并引擎 / frontier CTE | YUK-203 P3 延伸 / 新引擎 issue（review_plan 退役） |
| W2 | RT2 credit 注入 + encompassing_weight 列 / A2 阶段判定 | YUK-322 关系族新 issue（gated D-2）/ A2 形态 issue |
| W3 | RT1 误区晋升环 / RT4 promote 四闸 + audit:relations / RT3 routeByKind | YUK-322 关系族新 issue 群（全 gated YUK-344 + scope）；RT3 落 SubjectProfile |
| W4 | A1 今日之线 / A3 单编排者+滑块 / A4 强度表 / B5 verify 契约 | 形态向 issue 群；A3 与 YUK-346（GLM 评估）解耦；A4 关联 YUK-44；B5 挂 YUK-203 quiz 域 |
| 横切 | 埋点遥测铺设 | 新 observability 子 issue（喂 D-3 全部参数 + B1 自校准②③④） |

---

## Linear 捕获 gate 声明

本路线图综合识别出若干**排序层 follow-up**（§E-1~E-8、§F 映射）。其中 YUK-344/203/249/347/346/322 均已存在且状态已核对（YUK-249 与 YUK-347 方案互斥待 owner 正式裁决 = E-2）。**本稿不创建新 Linear issue**：理由是它是 Phase 2 综合的中间产物，下游 cross-统合 agent 会基于全局统一计划再决定 issue 切分（避免重复/过早开 issue）；新 issue（RT1/RT2/RT4 关系族、B3 引擎、A1/A3/A4 形态、埋点遥测、calibration、mem0 P3）的正式创建应在 cross-统合拍定全局计划后、由 to-issues 流程统一落 tracer-bullet 切片，届时挂 YUK-322 / YUK-203 epic。此处明确登记「无需即刻建 issue 的理由」以满足捕获 gate，不留 verified follow-up 仅在 prose。

---

**关键文件路径**（供下游引用，全部绝对路径）：
- 决策总账：`/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-14-product-rethink-decisions-ledger.md`
- 现状地图：`/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-14-product-rethink-phase0-current-map.md`
- Phase 1 调研：`/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-14-product-rethink-phase1-research.md`
- Phase 1.5 关系：`/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-14-product-rethink-phase1_5-relations.md`

---

## Lane 4 · gap / risk 对抗批判

两个关键代码侧事实核实完毕，与文档自述一致:一致性闸地基确实零实现(grep 无任何命中)、searchMemories wrapper 确实未落地(P3 读路径空)、knowledge_mastery view 的 `evidence<3→0.5` 占位确实活在 `drizzle/0005...sql:61`。这给我的悬空依赖判断提供了 grounded 锚点。下面产出对抗性审视报告。

---

# Phase 2 综合 · gap/risk 对抗性审视

> 视角:攻击这套已拍板架构的可落地性,不重新选型。代码侧关键事实已 grep 核实(一致性闸地基零实现 / searchMemories 未落地 / `evidence<3→0.5` 活在 `drizzle/0005...sql:61`),与文档自述一致。下游按问题→严重度→blocker/known-limitation→处置组织。

---

## A. 悬空依赖 / 环形依赖

### A1. 一致性闸地基是「全悬空树根」——下游三条 RT 全部依赖一个零实现地基
- **问题**:总账 §1.4 把「写入期结构一致性闸(环检测/方向矛盾/传递冗余)+ 写入期调和环」定为 RT1/RT2/RT4 共同前置,Phase 1.5 §4 明确这地基**代码侧零实现**(我 grep 复核:`cycle/direction/transitive` 在 `src/capabilities/knowledge/` 与 `src/server/` 零命中)。而 RT1 误区晋升环、RT4 四闸③类型签名、RT2 传递冗余拦截全部 gated 在它之后。这是一棵以空根为基的依赖树:地基不动,RT1/RT2/RT4 全部不能动。
- **严重度**:高
- **定性**:blocker(对 RT1/RT2/RT4 而言)。但它本身**不依赖任何未决项**,可独立先建——所以是「最该先做的那块」而非死锁。
- **处置**:**先做地基**。单独 Linear issue + ADR,作为关系结构线的 P0。在它 green 之前,RT 线的一切增量停留在「埋点观测 + 入口把关(rubric-validator)+ 派生计算」三件已有能力内(Phase 1.5 §4 原则)。owner 须接受关系结构线有一个明确的「地基期」前置,不能并行抢跑。

### A2. credit(RT2)悬空依赖一个「卡在未决二选一」的 view 重写——双层悬空
- **问题**:RT2 credit「进 p(L)」(总账 §RT2),但 p(L) 这条诊断派生本身要靠重写 `knowledge_mastery` view 落地(总账 B1「删 evidence<3→0.5 换 PFA logistic」)。而这张 view 的重写方向**正是 B1(PFA 双层)vs B3(FSRS R 唯一)的硬矛盾交汇点**(Phase 1 §4 矛盾#1+#2)。Phase 1.5 §5.6 已点破:credit 注入排在 view 重写之后,view 重写卡在二选一未拍。所以 credit 是「悬空依赖一个悬空依赖」:credit → view 重写 → 二选一拍板。我 grep 确认 `evidence<3→0.5` 占位仍活在 `drizzle/0005...sql:61`,view 重写一行未动。
- **严重度**:高
- **定性**:blocker(对 RT2 而言)。
- **处置**:**需 owner 拍**「统一掌握信号」(下见 H1),才能解锁 view 重写;view 重写落地后 credit 才闭环。在此之前 credit 标 future,不进任何实施 lane。

### A3. misconception_edge 异构边破坏 rubric-validator 同构假设——「复用」是隐性重写
- **问题**:总账 RT1 引入 `misconception_edge`(caused_by/confusable_with/observed_in/remediated_by),Phase 1.5 §2 标其为 `from_kind/to_kind` 多态异构边。但 Phase 1.5 §6 自承:rubric-validator **所有闸假设两端都是 knowledge_id**(同构),异构边需要平行闸逻辑,「复用成本被 RT1 低估」。这不是依赖环,是**伪复用**:总账把 misconception_edge 描述成「在已成熟的 rubric-validator 上加」,实际是要在同构验证器旁另起一套异构验证器。而异构验证器的「方向语义」(caused_by independent/dependent 两型)恰恰又依赖 A1 的一致性闸地基(方向矛盾检测)。
- **严重度**:中
- **定性**:known-limitation 升 blocker(若把 misconception_edge 排进与一致性闸同期)。
- **处置**:**降级 + 标 future**。misconception_edge 先走 `experimental:*` 逃逸阀单类型试水(只 caused_by),并显式声明「异构验证器是新建不是复用」的工作量。地基期不碰异构边。

### A4. encompassing_weight 加列触发 audit:schema 反噬——「加一列」实为「加一个 propose 子类型」
- **问题**:RT2 的 `encompassing_weight nullable 列`(总账 §RT2)看似最轻。但 Phase 1.5 §6 指出:`audit:schema` 要求每个业务字段有 write path,这列没有 INSERT/UPDATE 路径就会 fail lint;补 write path 意味着新增一个「属性更新」propose 子类型(不是新建边),这又落进 A1 提议生命周期的承重墙(Phase 0 §6.1:dispatchAccept 22-case 中心 switch 未下放)。「加一列」实际牵动 propose 契约 + audit gate 两处。
- **严重度**:低
- **定性**:known-limitation。
- **处置**:**先埋点**——加列时同步进 `scripts/audit-schema-allowlist.json` 标 `resolves_when`(kind:phase,指向 credit 落地 phase),避免 lint 红;真正 write path 与 credit 落地同期做。

### A5. 提议生命周期承重墙是 RT1/RT2 落地的隐藏前置(总账未显式登记)
- **问题**:总账把一致性闸地基列为 RT 前置,但**没把「提议生命周期契约」列为前置**。然而 RT1 误区晋升(propose 晋升 misconception 节点)、RT2 encompassing_weight 属性更新、RT4 promote(migration+ADR)全都要新增 proposal kind,而 Phase 0 §6.1 标明 dispatchAccept 仍是 1003 行中心 22-case switch、`acceptAiProposal` 住旧 `src/server`、三包跨界 import。每加一个 RT proposal kind 都要回到这个未下放的中心 switch。总账的「各包真正自治」愿景与这堵墙正面冲突,却没在依赖图里出现。
- **严重度**:中
- **定性**:known-limitation(短期可在中心 switch 加 case)升 blocker(若要求各包自治先于 RT)。
- **处置**:**需 owner 拍**优先级——是「先下放 dispatchAccept 再做 RT」还是「RT 暂在中心 switch 加 case,下放押后」。建议后者(避免双前置叠加把 RT 线推到很远),但 owner 须知此决策让承重墙继续承重。

---

## B. 欠规约(只到方向没到形状)

### B1. misconception 命名规范完全未定
- **问题**:Phase 1.5 §6 自承「misconception 命名规范未定(自由文本 vs 受控词表),同义去重靠 pgvector 近邻缓解非根治」。而 RT1 整个「跨 attempt 复现 ≥k 才晋升」的判定**前提就是能识别「同一个误区」**——没有命名规范/同一性判据,「同 effective_cause」无法机器判定,晋升环的触发条件悬空。这不是参数没定,是核心机制的输入未定义。
- **严重度**:高
- **定性**:blocker(对 RT1 晋升环)。
- **处置**:**需 owner 拍** + 先埋点。建议:观测窗口期先用「自由文本 + pgvector 近邻聚类」收集真实误区分布,再据分布定受控词表 vs 阈值。RT1 晋升环在命名同一性判据确定前不可实现。

### B2. 自主滑块提示阶数未定
- **问题**:总账 A3「默认 hint-first,可一次性走到完整答案……提示具体形态待定」,§5 列为开放项「几阶递进」。Phase 1 §5 指出 GPT 稿的 Hint Ladder H0-H5 可直接借。但「几阶 / 每阶给什么 / 如何从 hint 滑到完整解」全无形状。这是直接面向用户的交互核心,空着无法进 claude design handoff。
- **严重度**:中
- **定性**:known-limitation(不阻塞算法线,阻塞 A3 交互落地)。
- **处置**:**需 owner 拍**阶数 + 借 GPT H0-H5 做起点。可默认推进:先定「3 阶(方向提示 / 关键步骤 / 完整解)」做 v0,埋 revert/escalate 率再调。

### B3. 出手强度表 A/B/C 的 kind 归档表未完成
- **问题**:总账 A4 定了 A/B/C 三档语义 + 「A 档用静态可逆性兜底」+ 「defer/archive/judge_retraction 移出裁决面」,但**18(或现状)kind → A/B/C 的完整归档表没给**。Phase 1 §2.2 说收敛到「7 个真裁决项」,Phase 0 §6.7 说现状 3 个 kind 只能 dismiss(YUK-44 未实现 accept)。到底哪几个 kind 进 A、哪几个进 B、哪几个降 C,没有逐 kind 落表。这是 inbox 重做的直接 spec,缺它无法实施。
- **严重度**:中
- **定性**:known-limitation。
- **处置**:**需 owner 拍**逐 kind 归档表(一次性拍 ~18 行)。这是低风险高确定性的拍板,应在 Phase 2 收口时一次定清。

### B4. credit 载体三选一未定 + 注入层未定
- **问题**:总账 RT2 写「复用 prerequisite 反向遍历 + encompassing_weight」,看似已定。但 Phase 1.5 §5.5 仍列为开放:credit 载体 = (a)prereq 反向+encompassing_weight / (b)tree-down side-car / (c)直接复用 prereq weight,且「落地前先人工抽样标 N 条 prereq 边看 component 重合率」。同时 §6 末:credit 注入 p(L) 诊断层还是 FSRS R 调度层,取决于未拍的 B1/B3 二选一。所以 credit 既未定载体形态、又未定注入层。
- **严重度**:中
- **定性**:blocker(对 RT2)。
- **处置**:**先埋点**(抽样标 prereq 边 component 重合率)+ **依赖 H1 拍板**。credit 整体标 future,在 view 重写 + 二选一拍板后再定形。

### B5. misconception_edge 单多态表 vs 四窄表 + reconciliation_log 共表与否
- **问题**:总账 §5 与 Phase 1.5 §5.4 都列为开放:misconception_edge 一张多态表(灵活需平行闸)vs 四张窄专表(严但碎);reconciliation_log 知识侧/个性化侧共表与否。这是 schema 形态决策,影响 A3 异构验证器工作量。
- **严重度**:低
- **定性**:known-limitation(gated 在一致性闸地基后,届时再定)。
- **处置**:**标 future**,与 misconception_edge 试水同期拍。

### B6. 「合并引擎」三约束的具体形态欠规约
- **问题**:总账 B3「一个 AI 编排引擎通盘吃 FSRS due+frontier+mastery+mem0 prior……合并 what+mix,FSRS when 不并进」,三约束「确定性硬约束嵌入 + 可解释可追溯 + fallback」。但「硬约束如何嵌入一个 LLM 编排步骤而不被 LLM 软化」「fallback 触发条件」「mem0 prior 以什么权重进编排」全无形状。Phase 1 §4 矛盾#4 直接点名:六主题都把 mem0 列输入,但**没有任何一个**给出 mem0 软信号与 FSRS-R/frontier/confidence 的加权关系——这是横切空白契约。注意 Phase 1 本身建议「不合并后端引擎」(双通道+对账点),总账却拍了「合并引擎」——这是总账对 Phase 1 的覆盖,合法,但意味着合并引擎是**比 Phase 1 更激进**的方向,欠规约风险更高。
- **严重度**:高
- **定性**:known-limitation 升 blocker(若直接实施合并引擎而不先定 mem0 权重契约)。
- **处置**:**需 owner 拍** mem0 prior 进编排的方式——建议作为「只读软提示进 prompt 上下文、不进数值权重」(与 C2 正交红线一致),且硬约束走代码侧 post-filter(LLM 产出后确定性裁剪)而非 prompt 约束。先做 fallback(纯确定性 due 队列)兜底再叠 AI 层。

---

## C. 三轴正交红线的潜在破口

### C1. credit「进 p(L)」是否回灌调度——正交红线的最细裂缝
- **问题**:总账 RT2 明确「credit 进 p(L)」、B3「FIRe B 面(抵扣 due)砍……信号保持正交:R / p(L)+transfer credit / difficulty」。方向是干净的。但破口在:p(L) 派生 view 一旦被「合并引擎」(B3)读去做 what 决策,而合并引擎同时也读 FSRS due 做 when——credit 经 p(L) 影响了「学什么」,若编排者把「学什么」的结论又反馈成「跳过某些 due」,credit 就经一条隐性路径影响了调度。总账靠「FSRS when 数学不并进 AI」守这条线,但「what 决策能否裁掉 when 队列里的项」没有硬约束(Phase 1 §6.5 owner 待拍:「策展 due 能接受 AI 裁掉部分到期项不主推吗」)。
- **严重度**:中
- **定性**:known-limitation(设计上可守,需显式约束)。
- **处置**:**需 owner 拍** + 埋约束。建议硬约束:到期必复习项是 hard constraint,AI 只能改呈现顺序/主推不主推,不能从队列删除(总账 B3 已含此意,需落成代码侧 invariant + 测试)。

### C2. mem0 prior 进合并引擎是否回灌掌握信号
- **问题**:三轴红线 mem0⟂p(L)。但合并引擎(B3)同时吃 mem0 prior + mastery。若 mem0 里固化了「owner 弱于虚词」这类 semantic-trait,而编排者据此降低某知识点呈现,再据「呈现少→作答少→evidence 少」回到 mastery 派生——mem0 软画像经一条「编排→曝光→证据」的长路径间接污染了 p(L)。这正是 Phase 0 ADR-0017「记忆永不偏置 judge/FSRS」红线的灰色地带:mem0 不直接写 mastery,但经曝光偏置间接影响证据采集。Phase 1 §4 矛盾#4(mem0 是孤儿输入,无加权契约)放大此风险。
- **严重度**:中
- **定性**:known-limitation。
- **处置**:**先埋点**(actor_ref 分轨可观测 mem0 影响了哪些曝光决策)。建议 future:mem0 prior 只进「平局打破/排序微调」不进「是否曝光」的二元决策,保证每个知识点都有最小曝光底线。

### C3. confirmation loop:mem0 extraction 喂自然语言 event,event 又被编排者会话写入
- **问题**:总账 B4「喂信号收窄(携带自然语言陈述的 event 才喂)」+ A3「会话级工作记忆所有 surface 写入/编排者读取」。破口:编排者的会话输出本身可能成为 event(自然语言),被 mem0 extraction 抽成 semantic-trait,下一轮又作为 attention prior 喂回编排者——AI 把自己说过的话固化成「关于你的记忆」。这正是 memory `feedback_no_recursive_prompt_injection`(防循环注入五防)要防的。总账 A3 写了「防循环注入五防必守」,但没说清「编排者输出是否算可喂 event」。
- **严重度**:高
- **定性**:blocker(对 mem0 extraction 接通而言,违反既有红线)。
- **处置**:**需 owner 拍** + 五防落地。硬规则:只有「用户作答/用户陈述」类 event 可喂 mem0,编排者自身输出永不进 extraction 源。这条要写成 extraction gate 的 invariant + 单测(五防中的「注入事实非上一轮 prompt 装配物」)。

### C4. difficulty 共享桥(FSRS D = PFA β)双向耦合
- **问题**:总账 B1「difficulty(FSRS 的 D = PFA 的 β,两层共享输入桥)」。这是三轴里**唯一刻意打通的共享点**。风险:D 和 β 若真共享同一更新源,FSRS 评级(again/hard/good)产生的 D 调整会经桥影响 PFA 的 β,反之亦然——这恰恰是「三轴正交」想避免的耦合,只是被重命名为「共享桥」。总账把它当 feature(B1),但没说明共享是「同一输入喂两个独立估计」还是「同一个估计两处读」。前者正交,后者耦合。
- **严重度**:中
- **定性**:known-limitation。
- **处置**:**需 owner 拍**桥的语义。建议:共享的是 *输入*(作答 correctness/RT),各自独立估计 D 与 β,不共享 *估计值*——否则正交红线在 difficulty 处破。落成 ADR 明文。

---

## D. 未验证数值阈值(magic number 清单)

> 逐个标:来源 / 单用户能否验证 / 风险。总账 §5 已统一「先埋点观测 N 周再定参」,以下是该埋点清单的 grounded 展开。

| # | 数值 | 出处 | 来源性质 | 单用户 n=1 能否验证 | 风险 |
|---|---|---|---|---|---|
| D1 | k(晋升阈值,「复现≥k」) | 总账 RT1 / P1.5 §6 | 拍脑袋(无文献) | **否**——单用户误区复现样本极稀疏,k 取 2 或 3 结果差异大却无 ground-truth 校验 | 高:k 太小则误区图噪声爆炸,太大则永不晋升,RT1 价值归零 |
| D2 | N=15-20(RT4 promote 频次闸) | P1.5 §2/§6 | 拍脑袋(范围本身是猜) | **否**——单用户一个 experimental relation 攒到 15-20 次需很久,可能永远到不了 | 中:闸门事实上常关,promote 几乎不触发(可接受,刻意有摩擦) |
| D3 | encompassing_weight=0.3-0.4 | P1.5 §6 | 拍脑袋 | **否**——credit 衰减系数无 n=1 校验信号(credit 本是派生量无 ground-truth) | 中:credit 大小直接影响 p(L),错的系数静默偏置诊断 |
| D4 | 2σ(背离/miscalibration 信号) | 总账(经修正)/ P1 §3 | 文献措辞但总账 §3 已收紧「2σ 别当承诺」 | 部分——可观测残差分布,但 2σ 阈值本身无 n=1 依据 | 中:误报 fluency-illusion 软提示频率受此控,过严则形同虚设 |
| D5 | 66 天(习惯养成) | 总账 §3 已收紧「别当承诺」/ P1 §4 弱证据 | 文献(Lally,作者自己已削弱) | **否** | 低(已降级为机制 instigation+context stability,不再作阈值承诺) |
| D6 | 缕数封顶 5 / 动态 1-5 | 总账 A1 | 产品决策(拍脑袋,UI 容量考量) | 可——日用主观体验即可验证 | 低:纯 UI,易调 |
| D7 | r≈0.78(LLM 抽教学特征) | 总账 B1 / P1 | 文献(客观题场景) | **否**——古文开放题无此 r 的来源,外推存疑 | 高:整个 LLM 标定的有效性 claim 建在此 r 上,古文场景可能 r≈0 |
| D8 | r=0.75-0.82(LLM 模拟考生,客观题) | 总账 B1 | 文献(客观题) | 部分——客观题可 n=1 自校验(硬轨),开放题不行 | 高:同 D7,仅客观题成立,总账已分轨标软轨低置信 |
| D9 | 30 天半衰期(现状 mastery view) | Phase 0 §3 | 拍脑袋(现状占位) | 否 | 低(即将被 PFA 重写删除) |
| D10 | per-kind 半衰期(mem0 recency 重排) | 总账 B3 / §5 | 拍脑袋 | **否** | 中:影响 searchMemories 召回哪些记忆,错值静默偏置编排者上下文 |
| D11 | auto-enroll 灰度阈值 / block-interleave 切换阈值 | 总账 A2/B5 / §5 | 产品决策 | 部分(可日用观测) | 中 |
| D12 | 撤销窗口时长(A 档) | 总账 §5 | 拍脑袋 | 可——日用即可调 | 低 |

**总判断**:D1/D3/D7/D8/D10 是「单用户无法验证 + 错值静默偏置认知核心」的高/中危组,且全部是 N 周埋点也未必能攒够样本的(n=1 固有)。这意味着**「先埋点 N 周再定参」对 D1/D3 这类可能永远拿不到足够样本**——埋点策略本身需要 owner 接受「某些参数将长期停在先验值」。

---

## E. 有效性天花板(目标架构实际可能跑不起来的地方)

### E1. 软轨 a/c 是 n=1 认识论死路(Stocking 1990)——已诚实标,但波及面比标注更大
- **问题**:总账 B1 标「区分度 a、猜测 c 是 n=1 死路」。但软轨不止 a/c——CDM、KT、开放题难度都在软轨。Phase 1 §4 弱证据列出 B5「古文开放题用 provenance 锚 ground-truth」自承缺实证、「古文鉴赏/论述题验证环实际没有可行方案」。这意味着**对古文为主的科目,整个软轨 + 出题 verify 闭环 + observed_in 证据精度三处同时退化**(P1.5 §6:开放题 observed_in 退化到比 MCQ distractor 软)。天花板不是某个参数,是「古文开放题这一大类内容的算法层基本无效」。
- **严重度**:高
- **定性**:known-limitation(诚实标,非 blocker——硬轨/客观题仍成立)。
- **处置**:**标 known-limitation 写进决策文档**。明确:算法层的强承诺(诊断/标定/误区/verify)仅对客观题成立,古文开放题降级为「LLM 软提示 + owner 锚点为主,算法辅助为辅」。这直接关联 scope 决策(H4):若产品定位古文深耕,则算法轴大半价值打折。

### E2. 自校准慢热四阶段可能永远到不了第四阶段
- **问题**:总账 B1 慢热四阶段:①纯 LLM 先验 ②Elo 追 θ ③fixed-anchor+PPI+三自检 ④per-knowledge 滚动达标解锁开放题外推。第④阶段「per-knowledge 滚动达标」需要每个知识点攒够 owner 真实作答,但单用户 + 知识点数量大 + 古文开放题无干净锚——多数知识点可能永远停在①②阶段。总账 §0「慢热自校准:owner 是唯一 n=1 真人」承认了节奏慢,但没承认**可能存在永远到不了④的知识点集**。
- **严重度**:中
- **定性**:known-limitation。
- **处置**:**标 known-limitation**。设计上保证停在①②阶段的知识点也能正常工作(纯先验+低置信展示),不让「未达④」成为功能不可用。这是 degenerate 态设计(Phase 1 §4 缺口:故障态设计几乎全缺)。

### E3. 零成本基线 gate 可能让整个合成标定栈被自己的 gate 否掉
- **问题**:总账 B1「全合成标定 vs 题型/知识点难度历史均值朴素基线 head-to-head,不显著赢就回退轻量基线」。这是诚实的护栏,但对 n=1:head-to-head 需要 holdout 集 + 统计显著性,单用户样本可能**永远达不到显著性**,gate 默认回退轻量基线——即整套 LLM 标定 + PPI + Elo + fixed-anchor 复杂栈,在 n=1 下可能被自己的 gate 判定为「没显著赢」而长期不启用。
- **严重度**:中
- **定性**:known-limitation(护栏正确,但意味着复杂栈 ROI 在 n=1 下可能为负——不计代价红线允许,但有效性要标)。
- **处置**:**标 known-limitation** + **需 owner 拍**「显著性达不到时是默认回退轻量基线,还是接受低置信启用合成栈」。owner 已表态不计代价,但 gate 本身会与「不计代价」打架——这是矛盾点须澄清。

### E4. 空 frontier LLM 填充可能产出系统性错误的临时边
- **问题**:总账 B3「空 frontier LLM 填充(语义+课程结构猜临时 frontier,低置信 propose-only,慢热被真实边替换)」。冷启动期(Phase 1 §4 缺口:冷启动/空池/稀疏图全缺)真实 prerequisite 边稀疏,LLM 猜的临时 frontier 主导练习排序,而 LLM 猜古文知识点先后序的准确性无验证。若系统性猜错,练习旅程在冷启动期被错误临时边引导,且「慢热被真实边替换」依赖真实边攒够——又回到 E2 的慢热问题。
- **严重度**:中
- **定性**:known-limitation。
- **处置**:**先埋点**(临时边 vs 后续真实边的吻合率)+ 冷启动期临时边只做软建议不做硬 gating。

---

## F. 与现状的最大张力(诚实标成本,不为否决)

### F1. 「合并引擎」vs 现状三套近重复 + 双隔离通道 + AI 未接入
- **问题**:总账 B3 拍「合并引擎」,Phase 0 §6.3 现状是 `due-list`/`review-session`/`stream-store` 三套 FSRS-due 选题逐行手抄 + `review_plan` 另开 paper channel(ADR-0029 锁定双通道)+ `variant-rotation` 自称唯一 seam 但 AI 没接进。注意 ADR-0029/0006(Phase 0 §5 已锁)明文「双通道而非统一引擎」——**总账的「合并引擎」直接推翻已锁 ADR-0029/0006**。这不仅是工程距离大,是与已锁决策冲突。Phase 1 本身也建议不合并(双通道+对账点),总账更激进。
- **严重度**:高
- **定性**:known-limitation(成本)+ 需 owner 确认推翻已锁 ADR。
- **处置**:**需 owner 拍**——明确「合并引擎推翻 ADR-0029/0006」,并接受三套手抄收敛 + AI 真接入 variant-rotation seam 的成本。这是算法轴落地成本最被低估处(Phase 1 §1「不缺基础设施缺一致性」的乐观结论在这里最经不起推敲:从双通道到单引擎是真重构,不是接通)。

### F2. capability 贡献制是过渡态双轨,RT 新增 proposal kind/job 会踩双轨
- **问题**:Phase 0 §6.4:jobs 双轨(manifest 仅迁 12,handlers.ts 仍持 18 个 boss.work)、copilotTools 实质 no-op(CORE_TOOLS bootstrap 全量先到)、`validateComposition` 不在生产路径只 test 调用。RT1/RT4 要新增 proposal kind + 可能新 job,会落进这个未收口的双轨。总账多处假设「manifest 是唯一登记面」(新增走贡献制),但现状是名义双轨。
- **严重度**:中
- **定性**:known-limitation。
- **处置**:**先做地基**(若要 RT 经干净贡献制登记,需先收口双轨)或**标 future**(RT 暂走现状双轨,接受技术债)。建议后者+埋 Linear issue 跟踪双轨收口,避免与一致性闸地基双前置叠加。

### F3. 单编排者「合为同一 D14」vs 现状 4 人格 + copilotTools no-op
- **问题**:总账 A3「后台 4 job + 前台 Copilot 合为同一 D14」。Phase 0 §2/R2:现状是 4 个 agent 人格 surface 隔离,且 copilotTools 贡献制 no-op(CORE_TOOLS latch)、worker 不走贡献制、author_artifact 归属错位。「合为同一 D14」要让后台 job 与前台 Copilot 共享同一工具层+记忆面+叙事,而现状工具贡献制本身还没真生效。
- **严重度**:中
- **定性**:known-limitation。
- **处置**:**标 future** + 分阶段。先让 copilotTools 贡献制真生效(退役 CORE_TOOLS latch),再谈 4 job 收编。actor_ref 分轨(总账已含)是对的可观测前提。

### F4. mem0 P3 读路径缺口虽小但卡住三个上游主题
- **问题**:Phase 0 §6.6 + 我 grep 确认 `searchMemories` 零命中。总账 B4 把它列为 task #23(最高 ROI 最小缺口)。张力不在成本(确实小),在**依赖广度**:A1 交班缕、A3 上下文契约、B3 合并引擎都读 mem0,但读到的是未过滤 superseded 的脏记忆。这个小缺口是多个目标的隐性前置。
- **严重度**:中
- **定性**:known-limitation(可独立先做,成本小)。
- **处置**:**先做地基**(无依赖、ROI 高、解锁多个上游)。这是与一致性闸地基并列的第二块「应先做的小地基」。

---

## G. 横切 Phase 1 critic 已标但总账可能漏接的硬矛盾

- **G1 UI/交互形态层整体缺位**(Phase 1 §4):A1/A2/A4 + B4 retract UI + A3 hint ladder 全部只到结构形态,像素/交互留白,需 claude design。总账没把「交互形态空白」登记为依赖——直接进实现会在 handoff 集体卡住。**处置:标 future + 显式声明这批是 claude design 前置,不进算法 lane。**
- **G2 event 表读放大无人评估**(Phase 1 §4):六主题同时从 event 流即时算(mastery view/credit/frontier CTE/今日之线派生),无「物化 vs 即时算」统一决策。Phase 0 §R4 已现 `loadTreeSnapshot` 5000 行 OOM cap。**处置:先埋点(测真实 event 量级下的查询延迟)+ 需 owner 拍物化策略。**严重度中。
- **G3 confidence 校准方法论全栈缺失**(Phase 1 §4):A4/B5/B1 都依赖「AI 自报置信度可信」,无验证方案。总账多处用 confidence(虽 A4 已改静态可逆性兜底)。**处置:标 known-limitation,confidence 类决策一律先走静态硬判据,软 confidence 推迟到有校准方案。**严重度中。

---

## H. 必须 owner 拍才能继续的硬决策清单(blocker 级,区别于软决策)

> 以下不拍,下游对应 lane 无法启动或会建在错误地基上。按解锁广度排序。

1. **【H1·解锁最广】统一掌握信号二选一 / 显式分层**(对应 Phase 1 矛盾#1#2、A2、RT2、view 重写)。总账 B1 已倾向「分层(R 喂调度 / p(L) 喂诊断展示)」,但 view 重写、A2 block-interleave 阶段判定、RT2 credit 注入层全卡在此。**须 owner 正式确认 B1 分层方案为终裁**(总账已写但 Phase 1 critic 要求「不能两个 high 并列放行」,需一句显式拍板),否则 view 重写无法动,连锁 A2/RT2 全停。

2. **【H2·撞已锁 ADR】合并引擎是否推翻 ADR-0029/0006 双通道**(对应 F1)。总账 B3 拍了合并引擎但 Phase 0 §5 表中 ADR-0029/0006 是 locked 的双通道决策,Phase 1 也建议不合并。**须 owner 显式确认推翻**,并接受三套手抄收敛 + AI 真接入的重构成本(这是「收敛接通」叙事下被低估的真重构)。

3. **【H3·撞既有承诺,已倾向但需正式落字】bi-temporal 去留**(对应 Phase 1 §6.1)。总账 B2 已拍「不做 bi-temporal,YUK-344 重定向为一致性闸地基」,但需正式授权修订 `memory-architecture.md §4.1/§8.2/§8.4`,否则设计稿与总账并存矛盾(Phase 1 §4 矛盾#3:B4 仍默认 P4 bi-temporal 存在)。

4. **【H4·scope】全科 vs 古文深耕**(对应总账 §5、Phase 1 §6.3、E1)。这条决定 E1 有效性天花板的影响面:若定古文深耕,算法轴大半(软轨/标定/误区/开放题 verify)价值打折,产品价值更靠 mem0+UI 编排;若定通用底座+学科插件,则算法轴对客观题科目成立。**scope 不定,无法判断算法轴投入 ROI 边界。**

5. **【H5·mem0 进编排的契约】mem0 prior 以什么方式进合并引擎**(对应 Phase 1 矛盾#4、C2、B6)。六主题的孤儿输入,须定:mem0 进数值权重 vs 只进 prompt 软提示;是否能影响「是否曝光」二元决策。不定则正交红线在编排层有破口。

6. **【H6·防循环注入】编排者自身输出是否可作 mem0 extraction 源**(对应 C3)。须硬规则:只有用户作答/陈述可喂,编排者输出永不进 extraction。这是既有五防红线的直接落地,不拍则 mem0 extraction 接通会违反红线。

7. **【H7·misconception 同一性判据】命名规范:自由文本 vs 受控词表**(对应 B1)。RT1 晋升环的输入定义,不拍则「同一误区复现≥k」无法机器判定,RT1 无法实现。建议:观测窗口期自由文本+pgvector 聚类先行,据分布再定。

8. **【H8·能动边界】AI 能否裁掉部分到期项不主推**(对应 C1、Phase 1 §6.5)。触及「AI 能动 vs 人掌控」红线。须定到期项是否 hard constraint(只能改呈现不能删队列)。

9. **【H9·提议契约前置优先级】先下放 dispatchAccept 再做 RT,还是 RT 暂在中心 switch 加 case**(对应 A5)。决定 RT 线是否被「提议生命周期承重墙」二次前置。建议后者,但 owner 须知此选择让承重墙继续承重。

### 可默认推进的软决策(无须 owner 拍,记录即可)
- 一致性闸地基先建(总账已定 priority High,A1)。
- searchMemories P3 读路径先做(F4,无依赖高 ROI)。
- QuizVerify 扩 'error' 通道先做(Phase 1.5 §5.9,零结构改动无依赖)。
- 缕数封顶/撤销窗口/block-interleave 等纯 UI 阈值(D6/D11/D12)——先取保守默认值,日用调。
- 自主滑块先做 3 阶 v0 借 GPT H0-H5(B2),埋 revert/escalate 率后调。
- A/B/C kind 归档表(B3)——低风险一次性落表,Phase 2 收口拍。

---

## 一句话总结

这套架构**没有致命的环形死锁**(一致性闸地基/searchMemories/QuizVerify-error 三块无依赖可先做,是真地基不是空根),但有**两条「悬空依赖悬空依赖」的长链**(credit→view 重写→H1 二选一;RT1 晋升→misconception 同一性判据 H7)和**两处推翻已锁决策的隐藏成本**(合并引擎撞 ADR-0029/0006;bi-temporal 撞 YUK-344——后者已倾向但需正式落字)。最危险的不是工程量,是**古文开放题这一大类内容的算法层基本无效(E1)** 与 **n=1 让 D1/D3/D7 等高危参数可能永远拿不到验证样本(D 节)**——这两条是「不计代价也买不到有效性」的真天花板,必须如实进决策文档。

相关文件路径(供下游下钻):
- `/Users/yukoval/yukoval-projects/the-learning-project/drizzle/0005_phase1c1_event_payload_gin_and_mastery_view.sql:61`(evidence<3→0.5 占位现存)
- `src/server/proposals/actions.ts`(dispatchAccept 1003 行中心 switch,A5/F2 承重墙)
- `src/capabilities/knowledge/server/rubric-validator.ts`(同构验证器,A3 异构破口)
- `scripts/audit-schema-allowlist.json`(A4 encompassing_weight lint 反噬处置点)
