# Cold-Start Openable Sprint — 执行图（2026-06-21）

> 源：owner 2026-06-20/21「单项目深度冲刺」决策 + 原则 [defer flip not build]。
> 上游设计：`docs/design/2026-06-20-cold-start-day-one-design.md`（day-one n=1-safe 栈 + inc A-F）。
> 本文 = 把那份设计**翻译成一条可走的执行线** + dark-ship 分类 + 精炼尾。两个 READ-ONLY code-grounding 勘察（2026-06-21）支撑下述每条判断。

## 核心原则（本 sprint 的纪律）

**数据门只 gate「翻转」(act)，绝不 gate「实现」(build)。** 每个 feature 拆 ① collect 路径（写信号 + live 接线 + UI 露出，哪怕标"校准中/低置信")=立刻做穿到 live；② act 翻转（信号驱动行为的那一刻）= 唯一等数据的部分，ungate 条件**绑到 harness 的具体读数**。collect 不通电 → 数据永不到 → 门永不解锁 = 死循环。`dark-ship + 无 UI + 开 follow-up` 在 day-one 关键路径上**不算做完**。（记忆 `feedback_defer_flip_not_build`）

**UI 实现**：用最新版 claude design 原型、1:1 保真；design↔backend 有差异时自主判断哪个更好/补充是否有意义（记忆 `feedback_claude_design_workflow` 2026-06-21 补），走 design-doc pre-flight 报 owner。

---

## 图一 · 关键路径："产品第一次能打开"（depth-first）

一个零数据新用户走通：**落地 → 立目标 → 拿到有界 placement 题 → 作答（judge+θ̂+FSRS 已 live）→ 看到带不确定性的起始档案**。卡点全在下面 5 步，**没有一步需要数据**；compute 栈（judge/θ̂/FSRS/选题数学/先验）已全 ready。

> **内容模型锁定（owner 2026-06-21）**：day-one 内容来源三层——**① 用户上传（主路）**：带自己的材料 → ingestion 抽题（引擎+`/record` 已建）；**② 薄 seed = 仅科目 domain-root 节点**（挂靠锚 + 兜底，树非空；不放 curriculum 子树）；**③ 动态 quiz_gen = refill**（池见底再补，从 day-one 降级）。树靠上传有机生长（上传子 KC 挂科目节点下、经父链继承 domain，不违反 subject=view）。详见记忆 `project_cold_start_content_model`。

| # | 步骤 | 类型 | 现状（code-grounded 2026-06-21） | 交付 | Linear |
|---|---|---|---|---|---|
| S | 薄 seed：仅科目节点 + 接线 day-one | 接线/数据 | `seedKnowledge` 机制已存但**零调用者 + 只 KC 无题**；curriculum.json 现是 7 子主题 | 砍成每科 1 个 domain-root 节点 + fresh-install 跑（migrate/bootstrap，幂等）。给上传子 KC 挂靠锚 + 树非空 | YUK-477 |
| P0 | goal 入口直接声明 | 接线+UI | goal 只由 nightly proposal 反应式 materialize（ADR-0025），**无 at-entry 直写** | 直接 goal-create 写 `scope_knowledge_ids`（✅ 后端 PR #543） | YUK-472 |
| U | 上传为主 day-one + placement bridges | UI+接线 | ingestion 引擎 + `/record` 已建、抽题落 draft；**未入 onboarding、未接 placement** | `/record` 入 onboarding 主路 + 3 bridge（KC 挂科目节点下 / draft→placement-eligible / 判分锚） | YUK-478 |
| P1 | onboarding 流外壳 | UI (inc-C) | **完全不存在**，落地直撞冷 `/today` | welcome → 短自述 → **「上传材料 vs 从起始集开始」选择题** → goal → placement | YUK-473 |
| P3 | 翻 placement flag + 作答 UI | flip+UI (inc-B) | 引擎+API ✅、`PLACEMENT_PROBE_ENABLED=false`、**UI 不存在** | flag→true + start→题→submit→next→end 作答环 UI | YUK-475 |
| P4 | 露出起始档案 | UI | 先验**算得出、没露出**；`/today` 冷库全 0 | profile 视图 per-KC θ̂/p(L)/mastery **带可见不确定性** | YUK-476 |

**依赖序**：S（薄 seed，最先，树非空）→ P0 + U（goal 直写 / 上传抽题，都往科目节点下落 KC）→ P1（onboarding 串 upload/seed 选择 + goal + placement）→ P3（placement 作答）→ P4（档案）。S 是一切的前置（空树则 upload 无处挂、goal 无 scope、placement 落空）。

**降级**：~~P2 冷子图即时派题（YUK-474）~~ → **refill（act/later）**——`discoverSupplyTargets` 前沿=`learning_item` active 引用 KC，day-one 新用户无 learning_item → 前沿空 → 派零，结构上服务不了 day-one；动态派只当池见底 refill。

**不在关键路径**：inc-A 锚题（写+route ✅，先验靠 `effectiveB` fallback；录入 UI 后补）。

---

## 图二 · dark-ship 件按 [defer flip not build] 分类

| 件 | collect 状态 | act 翻转门 | harness 读数 | 处置 |
|---|---|---|---|---|
| A1 SRT | **半通**：solo 写 RT、**paper 丢 RT**（`paper-submit.ts:616` 漏传 responseTimeMs） | `SRT_ENABLED`=true（live） | ✅ `audit:calibration`/V-A1-fwd | 补 collect：paper 接 RT（YUK-464/448） |
| A2 分层 Elo | ✅ 每 attempt live | `HIERARCHICAL_ELO_ENABLED`=true（live） | ✅ 同上 | 完整 |
| B1 mastery_state / FSRS | ✅ live 写 | — | — | 完整 |
| mastery_change→note refine | **半通**：solo 发、**paper 不发** | WAVE6 flags 多 true | ❌ 无 | 补 collect：paper 也 emit（YUK-459） |
| A4 theta-grid | **暗**：写+读都 NO-OP、列恒 NULL | `THETA_GRID_ENABLED`=false | ❌ 无 grid-SE harness | collect 可廉价通电（attempt 写 grid）；act（grid 选题）等新建 grid-SE harness |
| A3 answer_class | cron backfill（非 write-time） | `MATCHER_ANSWER_CLASS_FILTER`=false，在没 caller 的 matcher 后 | ❌ 无 | 跟 matcher 绑死 |
| matcher (YUK-397) | **暗**：`matcher()` 零 live caller | 门=缺 caller（非 flag） | ❌ 无 | 决策点：practice/placement 选题要不要走 matcher |
| misconceptionRecurrence | 暗（算出→undefined） | `MISCONCEPTION_RECURRENCE_ENABLED`=false | ❌ 无 | 真精炼，等 |

**两条最尖发现：**
1. **只有 A1/A2 有 harness 读数。** A4 / matcher / profile-P2 / answer_class 全无"何时翻"仪表 → 违反原则（翻转条件=harness 读数）。**纪律补丁：每个推迟的翻转，要么补 harness 读数，要么写 owner 显式判据；"off 且无判据"不允许存在。**
2. **两个 collect-gap 在 live 路径漏信号**（paper 丢 RT；paper 不发 mastery_change）→ 卷题路径数据永缺一块。纯 collect 补全，顺手做。

### `*_ENABLED` dark-ship 清单（2026-06-21 实测）

LIVE（true）：`SRT_ENABLED` · `HIERARCHICAL_ELO_ENABLED` · `EARLY_KLP_ENABLED` · `WAVE6_TRIGGER_{MARK_WRONG,MASTERY,DREAMING}_ENABLED`
DARK（false / 无 caller）：`THETA_GRID_ENABLED` · `MISCONCEPTION_RECURRENCE_ENABLED` · `MATCHER_ANSWER_CLASS_FILTER`（+matcher 本身无 caller） · `PLACEMENT_PROBE_ENABLED` · `PREREQ_PROPAGATION_ENABLED` · `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED` · `WAVE6_TRIGGER_VERIFY_ENABLED`

---

## 图三 · 真该躺着的精炼尾（别碰）

A5-A15（YUK-440~450/447）：图-Laplacian 先验、prereq 传播、扩散区分"不会vs太谨慎"、DAD 摊销选题、置信度记录、LLM 自适应 elicitation——研究精炼，不在任何 openable 路径，Backlog 正确。inc-E（455）/inc-D/inc-F 同理，openable 之后。**这条尾占 18 Backlog 大半，是 35% 数字的主要稀释源——代表"健康往后排"，非"卡住"。** 打 `refinement-tail` 标签隔离视线。

---

## 收尾后的 sprint 定义

**交付物 = 图一 P0→P4 全通（接线+UI，零数据）+ 顺手补图二两个 collect-gap（paper RT / paper mastery_change）。** 一通，cold-start 项目从"满屏暗引擎 35%"变成"能打开的产品"。冲刺中两个小决策点（matcher 接不接、A4 collect 顺不顺手通电）届时 surface。
