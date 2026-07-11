# YUK-476 · 诊断起始档案露出 — UI 设计草稿

- **状态**：设计已定（owner 2026-07-11 判词 · §10）· 实施待 YUK-475（P3 placement）后收尾 · 设计 lane 不越界进实施
- **Issue**：[YUK-476](https://linear.app/yukoval-studios/issue/YUK-476)（P4 · 起始档案露出 — per-KC θ̂/p(L)/mastery 带可见不确定性渲染）· 父 YUK-452 · project「学习者全面档案 — n=1 firm-up」
- **日期**：2026-07-11
- **分支 / worktree**：`yuk-476-diagnostic-surface-design` @ `tlp-yuk476`（off origin/main 08f03ed1）
- **产出方式**：3 席对抗设计 workflow（原型保真席 / 后端真相席）+ Opus 终裁（Fable 不可用回落）+ 逐字源码复核。溯源见 §12。

> **一句话**：诊断起始档案的**数据、端点、渲染组件都已上线**（`ScreenProfile` @ `/profile` ← `GET /api/placement/profile`）。YUK-476 不是「从零建档案视图」，而是**把一个已建但成孤儿的面诚实地露出来 + 填满空的 `/today` 冷启屏**。范围因此收窄、风险因此降低。

---

## 1. 背景与范围

### 1.1 Issue 前提的一处（好的）修正

Issue 写于 2026-06-20，称「`web/src` 无 profile/mastery/θ̂ 视图」。**这条已过时**：`ScreenProfile`（`src/capabilities/onboarding/ui/ScreenProfile.tsx`，YUK-473 Slice 4）已上线，读 `GET /api/placement/profile?goal=<id>`，按 per-KC 珊瑚带渲染 θ̂/p(L)/mastery 区间，且已挂 #41 复算校验层。它当前**只作为 placement 流的终点可达**（`ScreenPlacement.tsx:127` probe 结束 → `/profile?goal=<id>`），不在任何导航里（`nav-config.ts` 无 `/profile` 项），无 `?goal` 时落 `EmptyState`。

所以真正的缺口是**可达性 + 冷启入口**，不是渲染。

### 1.2 真正要填的洞：`/today` 的「有目标、零活动」态

Issue 描述的「空屏」需精确化（`TodayPage.tsx`）：

- `kpi.goal_count === 0`（空库）**已被拦截**：`TodayPage.tsx:370-372` 早返回 `<ColdStart>`（YUK-473 冷启拦截）。这一态**不是** YUK-476 的问题。
- 真正的洞是 **`goal_count > 0` 但 due/pending/proposals 全 0**：`LoomHero` 恒渲染，`KpiRow` 渲 4 张 0 卡，`今日之线` 因 `deriveThreads`（`TodayPage.tsx:58-87`）无输出而整段消失（`TodayPage.tsx:401` gate `threads.length > 0`）。这是刚 onboard 完、还没到期复习的单用户 day-one 的真实处境。页面不是字面全白（`OvernightDigestBand` 静默空态、`WeekHeat`、`AgentNotesBoard` 仍在），但**最该出现的诊断价值——「你的起始画像」——不在**。

### 1.3 YUK-476 做什么 / 不做什么

**做**：把已上线的 profile 数据在 `/today` 冷启态露出一张诚实的「起始画像」band 卡片；把 `/profile` 深读面从孤儿变持久可达；把冷启/薄证据/未测各态设计成一等诚实空态。**后端仅一处增量字段**（`/api/workbench/summary` 加 `active_goal{id,title}`——实现期发现 `/today` 无 goal id 可用，卡片必须有 goal id 才能取 profile；详见 §5 更正）。

**不做**：不重建 `ScreenProfile`；不重建 #41 复算层（已上线）；不引入新的 mastery 可视化系统；不动死掉的 `.mastery-*` 孤儿原语；不做多目标聚合；不做 dark mode。详见 §8。

---

## 2. 已核实的后端契约（本文档的权威）

> 全部逐字源码复核于 `tlp-yuk476`（origin/main）。这是实现者应信的契约，**不是原型 mock**。

### 2.1 估计器 = PFA-logit（不是原型的 Beta-binomial）

真实 mastery 推导链：`state.ts:495` `pointLogit = pfaLogit(beta, PFA_GAMMA, PFA_RHO, success, fail)` → `state.ts:498` `band = pLearnedBand(pointLogit, se)` → `state.ts:502-505` 产出 `mastery / mastery_lo / mastery_hi / low_confidence`。参数 `PFA_GAMMA=0.5, PFA_RHO=−0.25`（`pfa.ts:64-65`，YUK-539 retune）。

**原型 `recompute-profile.jsx:12-43` 的 `Beta(κ·b+s, κ·(1−b)+f)`（κ=2, z=1.5）是原型 mock，与线上不符。** 任何按 Beta-binomial 客户端重算的东西会与服务端 mismatch。（线上复算层已用真 `pfaLogit` 重写——见 §3.2。）

### 2.2 `low_confidence` 阈值 = `theta_se ≥ 1.0` → 冷启即低置信

`pfa.ts:144` `LOW_CONFIDENCE_SE_THRESHOLD = 1.0`；`pfa.ts:163` `lowConfidence: se >= LOW_CONFIDENCE_SE_THRESHOLD`。因 `theta_se = 1/√precision`（`theta.ts`）且冷启先验 `precision=1 → SE=1.0`，**刚生成的 KC 一律 `low_confidence: true`**。这不是边角 case——**低置信是 day-one 的常态**，「不确定性前置」由真实阈值背书，不是设计口号。

### 2.3 `theta_hat` 是 logit 尺度，`p_l` 才是 [0,1] 带标记

`state.ts:506` `theta_hat: row.theta_hat`（原始 ability，未过 σ，可为负或 >1）；`state.ts:502` `mastery = band.point = σ(...)` ∈ [0,1]，序列化为 `p_l`（`placement-profile.ts:163` `p_l: m.mastery`）。**珊瑚带的点标记必须落在 `p_l`，不是 `theta_hat`**（原型把二者混了——已在线上修正，见 §3.1）。

### 2.4 权威字段集（`GET /api/placement/profile`）

客户端类型 `profile-api.ts:8-42`（= UI 实际能拿到的）：

**profile 级**（`PlacementProfile`）：
| 字段 | 语义 | 源 |
|---|---|---|
| `goalId`, `title` | 目标 | `placement-profile.ts:197-198` |
| `kcs[]` | per-KC 列表（已按 tested-first 排序、封顶 `PROFILE_KC_LIMIT=20`） | `:189-199` |
| `testedCount` | 有证据（有 `mastery_state` 行）的 KC 数 | `:184` |
| `totalKcs` | scope 内 KC 总数（封顶前，用于披露截断） | `:185` |
| `evidenceCount` | **KC 加权覆盖信号，非「答题数」**——一题标 N 个 KC 计 N | `:177-181`（注释明文） |
| `sigma_mode?` | `'poly'\|'libm'`，σ 引擎标志（**空 scope 分支省略此字段** → 客户端 optional） | `:206`, 空态 `:103-110` |

**per-KC，`tested: true`**（`ProfileKc`，`profile-api.ts:8-26`）：`id, name, evidence_count, theta_hat, theta_precision, theta_se, p_l（带标记）, mastery_lo, mastery_hi, low_confidence, success_count, fail_count, beta`（`placement-profile.ts:155-172`）。

**per-KC，`tested: false`**（未测）：`id, name, tested:false, evidence_count:0`（`:150-153`）。

### 2.5 客户端拿不到的字段（渲染 = 不可能，别提）

服务端 `ProfileKc`（`placement-profile.ts:50-66`）带 `axis`（A11 谨慎/速度轴，`drift_v` 在自适应流为 NULL、多数 KC 无行）和 `day_one_prior`（inc-E，DARK，`DAY_ONE_PRIOR_ENABLED` + native binding 才在，PR-3 前无 UI 消费）。但**客户端 `profile-api.ts` 的 `ProfileKc` 根本没声明这两个字段**——它们是 server-only，永远到不了 UI。任何 axis/day-one-prior 可视化在 v1 都是空盒子/vaporware，**硬性排除**。

---

## 3. 已上线的地面真相（防「照抄旧原型」陷阱）

三条极易踩空的事实——原型稿子里是坑，线上已经填了：

### 3.1 珊瑚带标记已经是 `p_l`（原型的 scale-mix bug 已修）

`ScreenProfile.tsx:7-9` 注释明文：「band MARK sits at `p_l` … NOT `theta_hat` — real theta_hat is a logit … The prototype's mock conflated them」；`:300` `const point = clamp01(kc.p_l, lo)`；`:326` `ob-band-mark left: pct(point)`。**这个 bug 只在原型 JSX 里活着**（`screen-onboarding.jsx:657` `pct(server.theta_hat)`）。含义：新建 `/today` 卡片时若照抄原型 JSX 会**重新引入**这个 bug——列为实现期硬 build-note（§9）。

### 3.2 #41 复算校验层已建、已用真数学、已启用（别砍、别重建）

`recompute-core.ts:23` `RECOMPUTE_BADGE_ENABLED = true`；`derive-profile-kc.ts:26` `import { PFA_GAMMA, PFA_RHO, pfaLogit } from '../pfa'`，`:72` `pfaLogit(kc.beta, PFA_GAMMA, PFA_RHO, kc.success_count, kc.fail_count)`——即用真 PFA-logit 客户端逐位重导，比对服务端。`ProfileKc` 已带 `success_count/fail_count/beta`（`profile-api.ts:22-25`）供重导。

- **后端真相席「估计器错、砍掉」= 陈旧**（数学早已换成真的）。
- **原型保真席「ledger {s,f,b} 没露出、无法复算」= 事实错误**（`success_count/fail_count/beta` 就在类型里）。

当前跑在诚实的 `'libm'` 预览态（`poly-exp.ts:152` `POLY_SIGMOID_ENABLED = false`）：badge 说「预览 · 待 σ 对齐」而非「逐位校验 ✓」。**bit-exact 校验 gate 在 YUK-508**（`POLY_SIGMOID_ENABLED` 翻转）。本设计**不承诺**逐位校验，`'libm'` 预览标是当前正确态。

### 3.3 `sigma_mode` 不是成熟度档（原型保真席的一处误接）

`sigma_mode ∈ {'poly','libm'}` 是 σ 引擎选择器（决定复算能否 bit-exact），今天全局恒 `'libm'`（`poly-exp.ts:152`）。它**不是** blind/warming/firm 证据成熟度——那来自另一个端点 `calibration-maturity.ts`（adr-0035）。用 `sigma_mode` 驱动「这份档案该信几分」的成熟度 chip 会显示一个无意义的全局标志值。**放弃这个 chip 想法**；若要「信任度」提示，用 `testedCount`/`low_confidence` 派生或接 calibration-maturity 端点（超出 v1 范围）。

### 3.4 YUK-516 已闭（冷启不再返回空档案）

`placement-profile.ts:93` `resolveGoalPlacementScope(...)` 已接入读路径，与 placement-start 共用同一三层解析器（`placement-scope.ts` 头注：「single source of truth … kills the drift class」）。Linear YUK-516 = **Done**（2026-07-05，PR #709，fix commit `0ce30a0c`）。**本设计对齐已修行为，不把它当开放 bug。** 唯一残留的合法空态：tier-3 也解析出零 KC → 端点返回 `kcs:[]`（`:101-111`），这是「空知识树」态、不是 YUK-516 漂移。

---

## 4. 原型对照 + design↔backend 分歧（pre-flight）

> **权威原型 = `docs/design/loom-refresh/project/`**（git 2026-06-28，claude.ai/design 全量导出，`NOTES.md`「全应用视觉基准」）。`loom-prototype/` 是更早 2026-06-05 子集快照，**勿用**。

原型的中心承诺是**不确定性优先**（不是「太自信」）。逐字契约：

> `handoff-band.jsx:6`：「硬契约(烤进组件)：mastery 三态(档条/方向/织线)一律无裸数字 + 区间 + 来源二态 + 低置信」

冷启起始档案是原型里**唯一**露数字的例外，且明确框成「初步信念 / 可能区间（不是分数）」：

> `screen-onboarding.jsx:581-583`：「基于 {answered} 道答题的**初步信念** · 多数还需更多练习确认，下面把不确定一并摆出来」
> `screen-onboarding.jsx:681-685`（图例）：「珊瑚带 = 可能掌握区间（不是分数） · 标记 = 当前最可能值 θ̂ · 灰带 = 低置信，区间很宽」

来源二态（软轨先验 / 硬轨校准）语义：

> `screen-today-handoff.jsx:31-32`：「软轨：LLM 先验回吐 prior-echo，未经真实作答校准」/「硬轨：真实作答校准过 firm-up」

### 分歧表（供 owner pre-flight 判断）

| # | 原型 | 本设计取舍 | 性质 |
|---|---|---|---|
| P1 | 珊瑚带标记落 `pct(theta_hat)`（`screen-onboarding.jsx:657`） | 标记落 `p_l` | **原型 bug，线上已修**（§3.1）；新卡片须复刻修法 |
| P2 | 图例称标记为「当前最可能值 θ̂」 | 文案改「当前最可能值 p(L)」；`theta_hat` 仅作次要 logit 数字（若露） | 语义校正（θ̂ 是 logit，非 [0,1]） |
| P3 | `SE = 1/√precision` eyebrow、露 SE 小数 | 保留但仅深读面 hover/expand；`/today` 卡片不露裸 SE | 诚实降噪（见 OQ5） |
| P4 | 复算 Beta-binomial（κ=2,z=1.5） | 不动——线上已是真 `pfaLogit`；`/today` 卡片不带复算 | 原型 mock 陈旧（§3.2） |
| P5 | `low_confidence = n<3 \|\| se>0.20` | 用线上 `theta_se ≥ 1.0`（§2.2） | 契约校正 |
| P6 | 稳态用离散 4 档 `[萌芽/成长/稳固/精熟]` | 冷启面用**连续 `[lo,hi]` 带 + `p_l` 标记**（= 线上 `ob-band`） | 见 §6 / OQ4 |
| P7 | axis / day_one_prior 富面（eff-viz 等） | 冷启面全部略去 | vaporware（§2.5） |

原型 `handoff-band.jsx:6` 的「一律无裸数字」硬契约与冷启起始档案露数字之间的张力，是一个**真实的内部不一致**，需 owner 拍（OQ5）：起始档案是否是那「唯一一次露数学」的例外。

---

## 5. 组件决策

**决定：`/today` band 卡片为主（填冷启洞）+ 复用已建 `/profile` 深读路由。**

- **`/today` 卡片（新建）**：一个 block，`LoomCard + SectionLabel + 连续 band 原语` 组合，挂在 `TodayPage` 的 `KpiRow`（`:393-399`）与 `今日之线`（`:401`）之间，gate 在 `active_goal`——**完全复刻 `OvernightDigestBand` 模式**（`TodayPage.tsx:234-311`）。**⚠️ 实现期更正**：两席都以为 `active.goalId` 已在 `TodayPage` scope 内——**是错的**（`active` 是动画 boolean；`WorkbenchSummary.kpi` 仅计数、无 goal id；也无 `GET /api/goals` list，只有 POST）。故给 `/api/workbench/summary` 增量返回 `active_goal{id,title}`（复用既有 goal 查询、无 migration），卡片据此 `getPlacementProfile(active_goal.id)`。是**摘要条**（testedCount/totalKcs + 最弱 2–3 个 KC 迷你带 + CTA），非 `/profile` 的复制。
- **`/profile` 深读路由（复用，不重建）**：已建、已正确（标记=`p_l`）、已挂启用的 #41 校验层。卡片 CTA「查看完整画像」→ 之。

**导航持久性**（OQ1，真 fork）：后端真相席主张「只留 deep-link、不进导航」，但卡片一旦 gate 掉（回到有活动的日子），这个有价值的已建面就**重新变孤儿**——而它的价值（看区间随证据收窄）恰恰**活过**那个 gate。原型保真席主张进导航。折中推荐：**给 `/profile` 一个轻量持久入口（卡片 CTA + 知识/练习面的一个入口），不是顶层 NAV tab**（顶层 tab 对一个 per-goal 诊断过重）。

### 触及文件（实现期，供参考）

- **创建**：`src/capabilities/shell/ui/blocks/ProfileBand.tsx`（新 `/today` block）
- **修改**：`src/capabilities/shell/ui/TodayPage.tsx`（挂载点 `KpiRow`↔`今日之线` 之间）；`nav-config.ts` / 知识或练习面（OQ1 的持久入口，取决于判词）
- **复用（零改）**：`src/capabilities/onboarding/ui/profile-api.ts`（`getPlacementProfile`/`ProfileKc`）、`onboarding.css` 的 `.ob-band` 样式、`ScreenProfile.tsx`
- **后端**：一处增量字段——`/api/workbench/summary` 返回 `active_goal{id,title}`（`workbench-summary.ts` 既有 goal 查询扩一列取最近 active goal；无 migration、无新端点、live 消费=本卡片）。原稿「零后端改动」有误

> UI Design Compliance pre-flight（供实现单）：组件类型 = `/today` panel/block（新建）+ 复用现有 route；逐字原型引用见 §4；触及文件如上（创建 vs 修改已标）。

---

## 6. mastery 原语 + 不确定性渲染

**canonical 原语 = 连续 `[mastery_lo, mastery_hi]` 珊瑚带 + `p_l` 点标记**（线上 `ob-band`，`ScreenProfile.tsx:321-326`）。**不用**离散 4 档轨。

理由：后端返回的是连续概率区间，不是档位索引；冷启多数 KC 宽且低置信，**带宽本身就是信息**。桶到 4 档会（a）丢掉带宽信号、（b）需要武断的桶阈、（c）给一条跨多个桶的带贴一个误导的单标签。4 档轨是**稳态**惯用法（`handoff-band.jsx` MasteryViz、`eff-viz.jsx:15`「仅作相对参照,非精确分」），YUK-476 冷启面之外。（OQ4：是否允许 4 档 label 作粗读次级信息。）

**只用后端真出的字段**渲染不确定性：

| 信号 | 后端字段 | 渲染 |
|---|---|---|
| 可能掌握区间 | `mastery_lo`, `mastery_hi` | 珊瑚带填充——**主视觉**，带宽 = 不确定性 |
| 点估计 | `p_l` | 带内细标记，刻意次于带 |
| 低置信 | `low_confidence`（`theta_se≥1.0`） | 低置信 pill + 带转灰宽处理（day-one 常态，故灰宽是**默认视觉权重**，firm 窄带是挣来的例外） |
| 无证据 | `tested:false` / `evidence_count:0` | 「未测 · 暂无证据」chip，不画带 |
| 来源 | *（派生，见 OQ3）* | 软轨先验 / 硬轨校准 pill |

**无假精度**：`/today` 卡片 band-only，不露裸点 %；裸点 `p_l` + `SE` 仅在深读面 hover/expand（把 34–84% 的带印成「61%」是舍入撒谎）。深读面静息态露**区间** %（「可能区间 X–Y」，= 线上 `ScreenProfile.tsx:331`），点作视觉标记。

---

## 7. 状态分类（永不空屏）

| 态 | 判定（一次 GET） | 渲染 |
|---|---|---|
| **A 空库** | `kpi.goal_count === 0` | 不变——`TodayPage.tsx:370-372` 早返回 `ColdStart`；卡片不渲染（gate 需 goal）。`/profile` 无 goal → `EmptyState`，CTA 改指「去设定目标」→ `/welcome`（现为死胡同） |
| **B 未定位** | goal 有、`testedCount===0` 且全 `tested:false` | 卡片/路由出 **CTA 态**：「先做定位，把先验换成证据」→ `/placement`；不倾倒 20 行未测 |
| **C 薄证据（day-one 常态）** | `0 < testedCount < totalKcs`，多数 `low_confidence` | lead banner「这还只是先验起点 — 练几轮，区间会收窄」；tested-first（服务端已排）；宽灰软轨带；未测折叠计数「{totalKcs−testedCount} 未测」；`totalKcs>20` 页脚披露「显示 20 / {totalKcs}」 |
| **D 空知识树** | `scope.length===0` → `kcs:[], totalKcs:0`（`placement-profile.ts:101-111`） | 「还没有可评估的知识点 — 先录入材料」→ `/record`。**绝不回落 `ColdStart`**（守 YUK-520 红线，同 `OvernightDigestBand`） |
| **E 已锐化（练后，愿景）** | 同组件，字段收窄驱动 | 带变窄+饱和，硬轨校准 chip 出现 |

YUK-516 已闭（§3.4），故卡片**信任端点 `kcs` 为权威、绝不客户端重解析 scope**：同一 goal 无论从 probe 终点还是 `/today` 卡片进入，必须长得一样（`placement-profile.db.test.ts` tier-2 测试是锁）。

---

## 8. 明确的裁剪与非目标

**建（v1）**：1 个 `ProfileBand.tsx` block + 复用 `.ob-band` + 挂 `TodayPage`（gate active goal）+ 5 态（A–E）+ 连续带（宽=不确定）+ `p_l` 标记 + 软/硬 pill + low-confidence 饱和 + 截断页脚。后端仅 `active_goal` 一处增量字段（非零、但最小；见 §5 更正）。

**明确不建**：
- ❌ 不重建 `ScreenProfile` / #41 复算层（已上线，§3.2）；卡片不复制复算面
- ❌ 不做 4 档桶化（§6）
- ❌ 不渲染 `axis` / `day_one_prior`（客户端类型都没有，§2.5）
- ❌ 不做多目标聚合（端点严格 per-goalId，无 live 消费，OQ2）
- ❌ 不复活死掉的 `.mastery-*` / `MasteryBadge` / `MasteryRing` 孤儿原语（`globals.css:5213-5279,8098-8106`，无 live 消费）；也不引入第三套 mastery 可视化
- ❌ 不做 dark mode（原型无、`tokens.css` 仅 light；与既有面一致）

---

## 9. 实现期正确性 build-notes

1. **标记 = `p_l`，绝不 `theta_hat`**：新 `ProfileBand.tsx` 若照抄原型 JSX 会重引入 scale-mix bug（§3.1）。加一条单测断言标记读 `p_l`。
2. **聚合 `evidenceCount` 标签 ≠「N 题」**：它是 KC 加权覆盖（`:177-181`），标「覆盖信号 / N 处证据」。per-KC 的「N 题」（`ScreenProfile.tsx:342`）可接受；聚合是陷阱。
3. **clamp 带坐标**：`mastery_lo/hi/p_l` 渲染前 `clamp01`（`ScreenProfile.tsx:52,296-300` 先例），仅护渲染位置、不改驱动字段。
4. **容忍 `sigma_mode` undefined**：空 scope 分支省略此字段（`:103-110`）；任何 `summarizeRecompute` 调用须容忍 undefined（现有实现 → 全 `na`，OK）。
5. **不承诺 bit-exact 校验**：`'libm'` 预览标是当前正确态，逐位校验 gate 在 YUK-508。

---

## 10. 设计决策（owner 2026-07-11 判词）

四个真分叉 owner 已拍，三个默认接受（未推翻）。全部 LOCKED：

1. **`/profile` 持久机制 → 轻量持久入口**（卡片「查看完整画像」CTA + 知识/练习面一个入口；**非顶层 NAV tab**）。卡片 gate 掉后 `/profile` 不重新变孤儿，「区间随证据收窄」的价值活过冷启期，又不给单用户工具增导航杂乱。
2. **多目标 → v1 仅 active goal**（默认接受）。端点严格 per-goalId；roll-up 需新后端且无 live 消费，不做。
3. **来源 pill → v1 派生规则**：`软轨先验 iff low_confidence || evidence_count < 3`，否则 `硬轨校准`。provenance 成载重再请后端加 per-KC `calibrated`/`source`（§11 条件性，暂不填）。
4. **4 档 label → 仅宽度**（默认接受）。连续带宽即信息，不叠粗档 label，避免重引入假精度。
5. **深读面裸点 % → 静息区间 %，点 + SE 仅 hover**。静息只印「可能区间 X–Y」（= 线上 `ScreenProfile.tsx:331`），裸点 `p_l` + `SE` 放 hover/expand；`/today` 卡片 band-only。这消解了原型「一律无裸数字」硬契约与起始档案露数字的内部张力——线上本就印区间、不印裸点。
6. **#41 校验 badge → 保留可见（诚实预览）**。深读面留 badge，标「预览 · 待 σ 对齐」；**不承诺 YUK-508 前 bit-exact 逐位校验**。强化 evidence-first / 可复现原则。
7. **`evidenceCount` 文案 → 「覆盖信号 / N 处证据」**（默认接受）；聚合绝不渲成「N 题」（§9-2）。

---

## 11. 后续 Linear（条件性，不预填）

按两席克制惯例，以下仅在判词选择保留对应面时由 driver 落单，避免投机性 issue：

- **来源 provenance 后端字段**（gate OQ3）：若软轨/硬轨 pill 须权威而非派生，开后端 issue 给 `mastery_state`/序列化器加 per-KC `calibrated`/`source`。
- **新卡片 scale-mix 回归防护**（§9-1）：`theta_hat`→`p_l` 修法只在 `ScreenProfile.tsx`；新 `ProfileBand.tsx` 需 build-note + 单测，避免回归。
- **#41 bit-exact gate = YUK-508**（`POLY_SIGMOID_ENABLED` 翻转）：文档引用即可，无需新 issue。
- **空 scope 分支省略 `sigma_mode`**（`:103-110`）：仅记录，现有 `na` 兜底已 OK。

---

## 12. 附：产出溯源

本草稿经 3 席对抗设计 workflow + Opus 终裁产出，全部读干净 worktree（origin/main）而非 stale 主树：

- **Scout**（并行）：当前 UI（发现 `ScreenProfile` 已存但成孤儿）· 原型（定位 `loom-refresh` 为最新、抽逐字）· 后端契约。
- **Design 席 1（原型保真）/ 席 2（后端真相）**：故意对撞「原型精确感 vs 后端只 moderate 先验」张力；席 2 越读进 `placement-profile.ts`/`placement-scope.ts` 拿到 YUK-516-已闭、PFA-logit、vaporware 字段等真相。
- **Opus 终裁**（Fable 不可用回落 Opus）：逐字源码复核，改正**两席各自的后端事实错误**——席 1「ledger 没露出」= 假（`success_count/fail_count/beta` 在类型里）、席 1 `sigma_mode`→成熟度 chip = 误接；席 2「复算估计器错」= 陈旧（已换真 `pfaLogit`）。driver 再逐字复核 §2/§3 全部载重事实。

已知 workflow 缺陷（记忆 `project_workflow_structuredoutput_dropout`）：backend scout 因大数组 schema 撞 StructuredOutput 重试上限、sprint scout 返回「test」占位——两者内容由席 2 的直读源码 + 终裁复核补齐，故不影响契约准确性。

---

*设计已定（owner 判词见 §10）。实施待 YUK-475（P3 placement）；设计 lane 到此为止，不越界进实施。*
