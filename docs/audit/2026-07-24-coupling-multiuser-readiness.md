# 耦合深度 × 多用户就绪度 — 架构综合裁定（2026-07-24）

> **输入**：owner 07-22 牌组（`docs/audit/2026-07-22-architecture-review.html`，8 张卡）+ 5 路扫描（metrics-refresh / schema-user-dimension / identity-isolation / locks-concurrency / card-deck-status）+ 对抗核验 pass。
> **基准树**：`origin/main = af2c95ab`（07-24 #1044 merge tip）；其后当日又合入 #1041（YUK-497，`2dda3d66`）/ #1045 / #1046，单独标注。
> **Owner 指令（07-24，落 YUK-767）**：「架构耦合过于深和为多用户准备也要考虑了」——耦合深度与多用户就绪度进入设计天平，非「现在重构」指令。

---

## 0 · 方法论勘误（先立此存照，再谈结论）

本地工作树 checkout 停在 `b6f0e084`（07-19），**落后 origin/main 123 个 commit**。五路扫描因此分裂成两个阵营（核验 pass ROOT-CAUSE finding）：

- **card-deck-status 读的是 `af2c95ab`（权威现行 main）**——其「LANDED」结论全部成立，本报告以它为准。
- **metrics-refresh 自标测的是 `b6f0e084`（stale）**——其「冻结 / 无 remediation / +50% 蔓延」类判词描述的是一棵 123-commit 旧树，**对现行 main 不成立**，本报告全部弃用或改写。
- schema / identity / locks 三路的 file:line 大多来自旧树；核验 pass 已对关键断言逐条在 `af2c95ab` 复测，本报告只引用**复测后**的数字。

**规程修复项**（进决策菜单 D9）：审计类扫描一律先 `git fetch` 并钉死 `origin/main` SHA，禁止默认信任本地 checkout。

---

## 1 · 一页摘要

**07-22 → 07-24 发生了什么**：牌组不是躺着的——48 小时内 Strong 档四张里**两张全落地**（Card 3 双表合一、Card 4 runner-fn），**两张半落地**（Card 1 events 腿、Card 2 机制+首包），Card 5 的 mastery-事件腿连同一整套 durable 事件订阅基建（`dispatch_seq` + 5 张新表）随 YUK-751/#1044 合入；跨包深 import 从牌面 ~190 收敛到 **65–76 区间**（约 1/3，其中既有真实下降也有口径修正，见 §2 Card 5）。同日 #1041 合入了**全局 learning-state G 锁**（G→supply→row 统一序），单用户 by-design、已在 YUK-767 记债。

**多用户一句话判词**：**全库 54 张表、0 张身份表、唯一的 user 维度是一根写死 `'self'` 的哨兵柱（`memory_reconciliation_log.user_id`，af2c95ab schema.ts:2114）——多用户今天不可上线、也不需要上线；真正随时间涨价的只有一件事：每一张不带 user 维度落地的新表。今天要买的是缝（新表 user 维度、锁名约定、订阅身份拍板），不是重构。**

**三条 commit-insensitive 的耐久事实**（核验 pass 在 af2c95ab 逐条 CONFIRMED）：

1. **零身份**：无 user/learner/account 表；`mastery_state` unique 只有 `(subject_kind, subject_id)`（schema.ts:1372）、`cost_ledger` 无 principal 列（schema.ts:800-820）、`editing_presence` PK = artifact_id 单列（schema.ts:2089-2095）。
2. **零 principal 贯穿**：auth 只有 `server/app.ts:41-47` 一个共享秘密中间件（`x-internal-token`），证明「持密」不证明「是谁」；route handler / runner / job handler 全链无身份参数（identity §1）。
3. **单用户闸门是局部而非统一的**（07-24 codex 勘误）：`actor_kind='user' && actor_ref!=='self'` 的硬拒仅存在于个别 event schema 的 superRefine（`known.ts:443`），而 `AttemptOnQuestion`/`ReviewOnQuestion` 等 6+ 个已入 `KnownEvent` union 的 kind 接受裸 `actor_ref: z.string()`——**不存在单一 fail-closed 闸门**；备份是单一全局 FK_ORDER wipe-then-restore，无 per-user 谓词可言（schema 扫描 ASSESSMENT-1）；28 只 cron 全部全局单例扫全库（核验修正 27→28）。

---

## 2 · 07-22 牌组现状刷新

数字口径：07-22 牌面值 → af2c95ab 实测值（card-deck-status 复测 + 核验 pass 修正）。

| 卡 | YUK | 状态 | 关键数字（旧→新） | 还剩什么 |
|---|---|---|---|---|
| 1 kernel facade | 747 | **半落地**（events✓ http✗ lint✗） | `kernel/events` 5 行壳 → 279 行真身；writeEvent **139 处全部走 `@/kernel/events`，直穿 0**（07-22：facade 2 文件 vs 直穿 82） | http/errors 本体未迁（kernel/http.ts 仍 113 行壳）；Biome 禁直 import 未加；`server/events/queries.ts` 剩 7 个 domain projection 待迁。S-M |
| 2 proposal 生命周期 | 748 | **在飞**（机制✓ 1/6 包） | `kernel/proposals/{registry,types}` 落地（applier load thunk = 牌面原设计）；仅 knowledge 2 kinds 迁出；**actions.ts 1839 → 1870（还在长）**，18-case switch 未删 | ~13 kinds × 5 包迁移，然后删 switch。L |
| 3 AI task 双表 | 749 | **落地** | task-prompts.ts **1098 → 25 行**；registry.ts 919 → 1914（吸收 builder）；17 个哨兵字符串 → 0 | 无。 |
| 4 runner-fn | 750/756 | **落地** | `Parameters<typeof runTask>` 强转 **33（旧树）→ 0**；`makeRunTaskFn` 22 个 caller 统一走 `src/server/ai/runner-fn.ts` | 无。（metrics-refresh 的「+50% 蔓延」测的是旧树，弃用） |
| 5 跨包 seam | 751 | **半落地**（事件腿✓ profile 上提✗） | 跨包深 import **~190 → 65–76 区间**（card-deck 逐包：practice 44→26 · ingestion 40→9 · knowledge 32→8 · notes 30→6 · agency 20→12 · copilot 16→4 · shell 7→11）；notes 订阅 mastery-progress 事件，对 practice 深 import 清零 | subject-profile / domain / tree-snapshot 读接口上提；knowledge↔agency、practice→knowledge 残余深 import。L |
| 6 typed client | — | **未动，恶化** | 手写 wire 文件 **12 → 15**（新增 teaching-brief-api 146 / teaching-brief-interaction-api 54 / effectiveness-trend-api 97）；practice-api.ts 700 → 802 行 | 整卡。M-L |
| 7 runner 三循环 | — | **未动** | runner.ts 1395 → **1419 行**（af2c95ab）；无 `withRunLifecycle` | 整卡（stream-cancel 测试锁定，风险门槛不变）。M |
| 8 Today 聚合 | — | **未动，且风险成真** | TodayPage.tsx 576 → **626 行**，仍深 import agency/onboarding UI；teaching-brief read model（YUK-706/567/710）**长成了平行第二套**而非吸收 Today——牌面警告的事发生了 | 整卡。M-L |

**Card 5 数字裁定**：牌面 ~190 大概率把跨包深 import 与 `@/server/**` 深 import 混在一口径里（metrics-refresh 复算 broader 口径得 practice 166 / knowledge 106 / agency 102…）。三种独立测法在 af2c95ab 收敛于 **65–76**（核验 pass 复测 65；card-deck 同树 ~76；口径对单个整数敏感，区间才是可辩护的）。**后续追踪固定两条独立指标**：跨包深 import（65–76 基线）与 `@/server/**` 深 import（旧树 820，af2c95ab 值待下次同口径复测）——见决策 D9。

**牌组窗口之外的当日新增**（不在 07-22 牌面上，但进多用户账本）：
- **全局 learning-state G 锁**（#1041 / YUK-497，`2dda3d66`）：G→supply→row 统一锁序，`withLearningStateLock` 5 处调用；全局串行化 FSRS/mastery 写，单用户 by-design（YUK-767 再审清单第 1 条已记债）。
- **durable 事件订阅基建**（#1044 / YUK-751）：`event.dispatch_seq bigint` 单调序（af2c95ab schema.ts:937-939）+ 唯一索引（:982-983）+ fold 复合 FK `[event.id, event.dispatch_seq]`（:1044,1074-1075）+ 5 张新表（`event_subscription_checkpoint/delivery/effect`、`artifact_edit_session`、`hub_sync_reconciliation`）→ 全库 **54 张 pgTable**。locks 扫描当作「假设性」分析的「全局流 + per-subscriber cursor」机器**已经物理存在**。
- **cascade-revert.ts**（YUK-497，754 行 / fan-in 1 / 跨 knowledge 包边界直写 4 张表）——metrics-refresh 提名的新卡候选，耦合深、复用低，挂账不立卡（等第二个 caller 出现再议，同 Card 7 门槛逻辑）。

---

## 3 · 多用户就绪度地图（新轴）

评级三档：
- **现在要动** = 改造成本随每张新表 / 每条新 lane 线性上涨，拖延有复利；
- **留缝即可** = 现在只买一个便宜的缝（约定 / 类型 / 一处契约），真身建设等多用户立项；
- **记债可等** = 改造成本基本固定、不随时间涨价，安全延后。

| 子系统 | 评级 | 依据（核验后数字） | 最小动作 |
|---|---|---|---|
| **Schema · 新表 user 维度** | **现在要动** | 54 表 0 身份表；07-22→24 一个窗口就 +5 张表（订阅三表等）全部无 user 维度落地；每张新表都在给未来迁移加息 | 决策 D1：学习者态/账本类新表自带 `user_id text not null default 'self'` 并入 unique key |
| Schema · 存量 54 表 | 记债可等 | 迁移成本已固定（26 张 per-user 表加列 + 索引加宽，schema 扫描三栏清单）；无 user 产品前动它是投机 | 无；D1 立缝即止血 |
| **Auth / principal 贯穿** | 留缝即可 | 唯一 choke-point `server/app.ts:41-47` 存在且干净；但 handler 签名 `(c.req.raw, c.req.param())`（:76）无身份贯穿，runner/job 同 | 定 principal 上下文类型约定（可空、默认 `'self'`），新 handler/job 签名预留；真身份系统等立项 |
| **锁空间** | 留缝即可 | 固定整数全局锁 2 把（597_001 control-plane / 4_064_403 probe-serve，CONFIRMED）+ #1041 新增全局 G 锁（已记债 YUK-767）；**排序纪律（namespace 内 string-sort）对加 user 前缀不变式成立**（locks §B）——多用户不需要锁序重设计，只需 key 加宽 | 决策 D2：新锁 key 命名约定预留 user 段 |
| **事件流 + 订阅 checkpoint** | 留缝即可 | `dispatch_seq` 全局单调流 + `event_subscription_checkpoint` per-subscriber cursor **就是正确的多租形态**（单表全局流 + user 列，schema 扫描 ASSESSMENT-2 推荐、基建已在）；缺的是订阅身份里的 user 轴 | 决策 D4：effect-slice 设计时把「订阅身份是否含 user」写进契约 |
| 备份 / restore | 记债可等（附标注缝） | 单一 FK_ORDER 全局 wipe-then-restore，per-user 谓词无从表达（ASSESSMENT-1）；但 per-user restore 在多用户上线前是伪需求。「backup contract 断言 throws」是脏 checkout 伪象（核验），不入账 | 决策 D6：新表进 FK_ORDER 时标注 corpus / learner 泳道（注释级，不改行为） |
| R2 blob | 记债可等 | key = `assets/${sha}` 内容寻址（identity §2 判 HOSTILE）；**综合裁定降级**：CAS 去重 + DB 行级 ownership（`source_asset` 行持 owner）是合法多租形态，跨用户共享同字节对象对私有工具无害——不必 per-user prefix，ownership 走 D1 的 schema 缝 | 无独立动作，归并 D1 |
| mem0 / memory | 留缝即可（最就绪） | mem0 全链本来就带 `userId` 参数，只是钉死 `'self'`（client.ts :224/:251/:305）；`memory_reconciliation_log.user_id` 是全库唯一真 user 列 | 无需现在动；翻真值即扩展点 |
| cost / ai_task_runs 账本 | 记债可等 | 两表均无 principal 列（CONFIRMED）；append-only 账本后补 nullable 列 + backfill `'self'` 便宜；write-side 依赖 principal 贯穿（留缝项） | 新账本类表归 D1；存量等 |
| pg-boss cron（28 只 + 5 housekeeping） | 记债可等（新 job 留缝） | 全部全局单例、handler 扫全库（frontier_fill / coach_daily 等实测无 user WHERE，locks §2）；多用户 = 逐 handler 改写为 scope-loop，成本固定但巨大 | 新 nightly handler 写成「枚举 scope → per-scope 工作」形状，未来 user fan-out 只是 loop 参数 |
| event `actor_ref` 校验（**非统一闸门**，勘误） | 现在要动（轻）：先补统一校验 | 'self' 硬拒仅个别 kind 有；多数 kind 收裸 string，已可解析非 self user ref | 决策 D7（修订）：逐 kind/writer 盘点 + 补统一 fail-closed 校验，然后才谈放宽 |
| 心理测量核心（θ̂ / p(L) / FSRS） | 记债可等（新 fold 表随 D1） | 最深轴（identity §7）：mastery_state / kc_typed_state / learner_axis_state 全部 `(subject_kind, subject_id)` 单学习者键；**多用户的真分叉是 learner-θ（per-user）与 item-b（population，跨用户共享后反而更可估）**——这是产品级设计课题不是加列 | 存量等设计；新 state/fold 表从 D1 起带 user 槽 |
| editing_presence | 记债可等 | PK = artifact_id 单列，单编辑者语义（「一 artifact 一行」docblock）；多编辑者是另一个模型不是加列；量级可忽略 | 等 |

**地图小结**：七轴里没有一根需要「现在重构」；「现在要动」只有一格——**新表 user 维度**，因为它是唯一有复利的债。identity 扫描的改造难度排序（mem0 最易 → 心理测量核心最难）在 af2c95ab 复测后全部维持。

---

## 4 · 决策菜单（owner 拍板项）

> 每项：通俗解释 → 选项 → ★ 推荐。

### D1 · 新表是否从现在带 user_id（全场最便宜的缝）
**通俗解释**：现在不需要多用户，但每张不带 user 列的新表都会让未来的迁移清单变长一行。加一列 `user_id text not null default 'self'` 今天零成本（所有代码照旧写 'self'），未来免一次 ALTER + backfill + 索引重建。
- (a) 全部新表一律带 —— 缺点：corpus/config 类表（题库、KG、subject 控制面）本来就该全局共享，带了反而是噪声语义。
- (b) **只对「学习者态 / 账本 / 会话」类新表带**（per-user 三栏清单 A 类 + 账本类），corpus / 全局 config 表明确不带并在 schema 注释标 `-- corpus/global` —— 一并解决 D6 的泳道标注。
- (c) 不带，等多用户设计整体拍 —— 债继续复利（本窗口 +5 表已示范）。
**★ 推荐 (b)**。落地形态：schema.ts 写作约定 + `audit:schema` 加一条 report-only 检查（新表无 user_id 且无 corpus 标注则报）。

### D2 · 锁空间命名约定
**通俗解释**：advisory lock 的 key 是字符串拼出来的（`fsrs:knowledge:${id}` 之类）。locks 扫描证明**加 user 前缀不破坏现有防死锁排序纪律**——所以现在约定格式几乎免费，未来免一次全库锁名迁移。
- (a) **立即约定**：新锁 key 统一 `{ns}:{scope...}` 且文档规定「user 维度未来插在 ns 之后」，写进 `src/server/advisory-locks.ts` 头注释；存量锁不动。
- (b) 不约定，等设计。
**★ 推荐 (a)**。附注：全局 G 锁（#1041）与 2 把固定整数锁维持全局 by-design，债已在 YUK-767；probe-serve 的全局配额（`MAX_CONCURRENT_ACTIVE_PROBES`）多用户下要 per-user 预算，同票记债即可。

### D3 · Card 1（kernel facade）现在收尾？
**通俗解释**：events 腿已经做完且效果惊人（139 处写事件全走 kernel、直穿归零）；剩 http/errors 本体迁移（约 1 个文件搬家 + re-export）、Biome 禁直 import 规则（几行配置）、7 个 domain projection 迁出 queries.ts（长尾）。
- (a) **现在做前两刀**（http 腿 + lint ban），projection 长尾按包顺路迁 —— S 级工作量，lint ban 能立刻止住 `@/server/**` 直穿继续增生，也给 Card 2/5 剩余迁移清出落点。
- (b) 整体等下一个架构窗口。
**★ 推荐 (a)**，排在 #1047（YUK-350）合并后，避免与在飞 PR 抢文件。

### D4 · effect-slice 的门（绑 YUK-766 / YUK-767）
**通俗解释**：事件订阅系统目前唯一的订阅者是刻意 no-op 的；「真 handler」（effect-slice）上线前有三个语义决策必须先拍，否则以后每个决策都要在有生产数据的情况下改。
门 1 —— **灾备恢复语义**（YUK-766）：备份时刻未投递的增量,恢复后算 pending 还是 history？选项 (a) checkpoint/delivery 进备份 / (b) 只备 horizon / (c) 明文接受丢失。**★ 随 YUK-766 原票推荐 (a)**（YUK-767 注：多用户权重下 (a) 权重进一步上升）。
门 2 —— **订阅身份是否含 user 轴**：checkpoint 现在是「每订阅者一根全局 cursor」；多用户下要么 per-user cursor，要么 handler 内自分流。**★ 推荐：契约里把订阅身份定义为 `(subscription_id, principal)`，principal 现在恒 `'self'`**——纯类型层留缝，零运行时成本。
门 3 —— handler 幂等契约 + effect 表对账口径（YUK-766 处置要求原文）。
**执行形态**：三门写进 effect-slice 设计文档的「进入实现前置」清单，YUK-766/767 挂链接。

### D5 · Card 2（proposal applier 迁移）节奏
**通俗解释**：机制已落地、knowledge 首包已迁，但 actions.ts 这个 god switch 在等待期又长了 31 行（1839→1870）——不推进就会继续被当作「顺手加 case 的地方」。
- (a) **分批推进**：每 PR 迁 1-2 个包的 kinds，agency（6 kinds）优先；全部迁完删 switch。
- (b) 冻结等大窗口。
**★ 推荐 (a)**，与 D3 的 lint ban 呼应（迁一包锁一包）。

### D6 · 备份泳道标注（corpus vs learner）
**通俗解释**：多用户备份的真形态是两个泳道（全局 corpus 一套、per-user 数据一套），FK_ORDER 单一全局序表达不了。现在不需要改备份，但每张新表进 FK_ORDER 时顺手标注它属于哪个泳道，未来拆泳道就是照单执行而不是考古。
- (a) **随 D1 (b) 一并做**（同一个标注动作服务两处）。
- (b) 不标。
**★ 推荐 (a)**。存量 42 表的标注可以一次 doc-only PR 补齐（schema 扫描三栏清单已经把答案写好了）。

### D7 · event `actor_ref` 校验（07-24 codex 勘误后修订）
**通俗解释**：原稿声称「事件契约统一硬拒第二个人类用户、未来只改 known.ts 一处」——**该前提是错的**：'self' 硬拒仅存在于个别 event kind 的 superRefine（known.ts:443），AttemptOnQuestion/ReviewOnQuestion 等 6+ 个 kind 接受任意 actor_ref 字符串，今天就能写入非 'self' 的 user ref。所以 D7 不是「何时放宽」而是「先把闸门建起来」。
- (a) **先补统一校验**：union 级（或共享 base schema 级）加 fail-closed 规则 `actor_kind='user' ⇒ actor_ref='self'`，逐 kind/writer 盘点存量豁免；将来放宽时才真正「只改一处」。
- (b) 维持现状（无统一闸门），依赖 writer 侧纪律。
**★ 推荐 (a)**（轻量；也是 D1 缝的前置——principal 兑现日闸门若不统一，放宽就会漏 kind）。

### D8 · Card 6（typed client）tripwire
**通俗解释**：手写 wire 类型双写在恶化（12→15 文件，本窗口 +297 行），但 codegen 基建（openapi.ts）也确实还只是雏形。定一根引爆线，避免「每次 review 都惋惜一遍但永不动手」。
- (a) 现在启动 codegen —— M-L 工作量，挤占效果更高的 D3/D5。
- (b) **记债 + tripwire**：再新增 2 个手写 api 文件、或出现第一个 wire 类型漂移导致的真 bug，即启动。
**★ 推荐 (b)**，tripwire 写进 YUK-767 或独立票。

### D9 · 耦合度量口径 + 审计规程钉死
**通俗解释**：这次审计一半的「恶化」结论是量错了树（本地 checkout 落后 123 commits）；同时 07-22 牌面的 190 与真实跨包耦合 65–76 差了 3 倍口径。
- **口径**：跨包深 import（65–76 @ af2c95ab 基线）与 `@/server/**` 深 import 分列两条指标追踪，不再合并报一个数。
- **规程**：审计扫描先 `git fetch` + 钉 `origin/main` SHA，报告头写明测量树。
**★ 推荐照此执行**（doc-only，本文档即基线载体）。

---

## 5 · 与在飞工作的关系

- **YUK-350（PR #1047，在飞，w1 已 APPROVE）**：持 0077 迁移号。D3（Card 1 收尾）排它合并后启动；本报告不动其范围。
- **YUK-589（judge 校准二期，In Progress，0078 号位）**：迁移列车 0077→0078 顺序依赖 #1047；若该 lane 新增表/列（如 run-summary 写侧唯一化），**是 D1 (b) 的第一个适用对象**——账本/观测类新表按新约定带 principal 槽或标注 corpus。
- **effect-slice（YUK-751 尾巴，rebase-ready）**：被 D4 三门直接 gate——YUK-766 灾备语义、订阅身份 principal 轴、handler 幂等契约拍完才进实现。现在拍最便宜：唯一在生产的订阅者是 no-op，零生产数据迁移成本。
- **YUK-763（placement schema↔migration 漂移）**：与本报告同一片 schema.ts 表面；placement_starter_* 四表已在 origin/main（核验 CONFIRMED，「uncommitted WIP / 断言 throws」是脏树伪象）且属 per-user A 类——漂移修复迁移落地时**不**顺手加 user 列（D1 只管新表，避免范围蠕变），但泳道标注（D6）可顺手带上。排序在 350/589 重编号之后。
- **YUK-767（owner 方向信号票）**：本报告即其「中选项：专项审计 lane 出报告 + 决策菜单」的交付物；D1/D2/D4/D8 的拍板结果应回写该票；07-22 牌组 HTML 可按票内备注挂附件。

---

## 6 · 证据索引（关键断言 → 出处）

| 断言 | 出处 |
|---|---|
| dispatch_seq / 订阅基建已在 main | af2c95ab schema.ts:937-939, :982-983, :1044, :1074-1075（核验 pass CORRECTED-最高位） |
| 54 pgTable / 5 张新表 | `git show af2c95ab:src/db/schema.ts` rg 计数（核验 pass） |
| 唯一 user 列 = memory_reconciliation_log | af2c95ab schema.ts:2114（三路扫描一致，核验 CONFIRMED） |
| mastery_state 无 user 轴 | af2c95ab schema.ts:1372 |
| cost_ledger / editing_presence 无 principal | af2c95ab schema.ts:800-820 / :2089-2095 |
| auth 单中间件、无 principal 贯穿 | server/app.ts:41-47, :76（identity §1） |
| 固定整数全局锁 ×2 | control-plane-lock.ts:13 / probe-lifecycle.ts:82,149（核验 CONFIRMED） |
| 锁排序纪律对 user 前缀不变 | advisory-locks.ts:26 + locks §B 结论 |
| 全局 G 锁（#1041 后） | YUK-767 再审清单第 1 条；`.remember/today-2026-07-24.md`（G→supply→row 统一序 / withLearningStateLock×5） |
| 28 cron 全局单例 | `git grep af2c95ab -- src/capabilities/*/manifest.ts`（核验修正 27→28）+ handlers.ts:77-116 housekeeping ×5 |
| event actor_ref 校验现状（非统一闸门，07-24 勘误） | src/core/schema/event/known.ts:443（superRefine 仅个别 kind）+ 6+ kind 裸 z.string()（codex 勘误核验） |
| 备份全局 wipe-then-restore | archive.ts:620/:626 + constants.ts FK_ORDER（schema 扫描 ASSESSMENT-1） |
| 跨包耦合 65–76 | 核验 pass 复测 65 + card-deck ~76 @ af2c95ab；牌面 190 判为口径混入 `@/server/**` |
| 牌组各卡数字 | card-deck-status（af2c95ab 权威）；metrics-refresh stale 判词全部弃用 |

---

*报告：核心综合席（Fable），2026-07-24。评级与推荐不推翻 07-22 牌组任何 Strong/Worth-exploring 定级；Card 5 的 190 数字按核验证据改写为 65–76 区间口径。*

---

## 附：部署形态裁定（owner 对话定调，2026-07-24）

**问**：微服务 + 消息总线是否是本项目的目标形态？

**裁定**：**modular monolith + 进程内事件总线（microservice-ready，不预拆）**。

- **总线侧成立且已在建**：YUK-751 事件订阅系统即总线内核（事实经事件、查询经接口）；跑在 Postgres 内在当前规模是优点——投递状态与业务数据同库，崩溃语义靠事务原子性白拿。后续按 Card 1/5 继续加码。
- **微服务侧否决**：它解决的是多团队独立发版与组件独立伸缩，本项目两者皆无；而当前全部难得的正确性保证（G→supply→row 锁序、级联撤回的原子多表事务、fence 断言、单事务快照 bootstrap）都站在单 Postgres 事务上，预拆 = 以 saga/outbox 十倍复杂度重买。
- **逃生舱已存在**：worker 是无状态队列消费者，`compose scale worker=N` 即水平扩容；seam 磨到位后按边界拆分是机械活。
- **拆分触发信号（三选一出现再议）**：独立伸缩曲线需求 / 安全隔离（如多租户 AI 沙箱）/ 异构技术栈。
- **推论**：多用户 ≠ 微服务；数百学习者在单 Postgres 内无压力。D1/D2/D3/D4 是为「多用户的模块化单体」铺路。

**随裁定生效的开发守则（owner：「接下来的开发也要避免深度耦合了」）**：新增代码禁跨包深 import（查询走 kernel/manifest 接口、事实走事件）；不向 god file 添肉；新锁 key 预留租户维度；「单用户 by-design」处置一律记债留痕（YUK-767 台账）。守则随 agent 派单附带执行。

---

## 附 2：量化重测 @ f9af38e8（D9 口径首跑，owner 点名执行，2026-07-24）

正文中被弃用的 metrics-refresh 判词由本节取代。全部数字在干净 worktree、钉死 `f9af38e8`、每项带复现命令测得（命令存 session 记录，此处存结论）。

| 指标 | 07-22 牌面 | 现值 @f9af38e8 | 判词 |
|---|---|---|---|
| `@/server/**` 直穿 import（非测试） | ~735 | **882**（另测试 298） | **恶化** |
| writeEvent facade | 2 走 facade / 82 直穿 | **141 走 kernel / 0 直穿** | **改善**（Card 1 events 腿坐实） |
| kernel http facade | 55 / 124 直穿 | 71 / **154 直穿**（2.2×） | 停滞（Card 1 http 腿未动 → D3） |
| 跨包深 import（X≠Y 非测试） | ~190（口径虚高） | **65 行 / 48 文件**（practice 19/16 居首） | 口径修正 |
| actions.ts | 1839 | 1870（switch 18 case） | 持平（D5 待动） |
| registry.ts | 919 | **1914** | **恶化（翻倍）**——YUK-591 结构化输出所致，**新 god file** |
| task-prompts.ts | 1098 | **25** | **改善**（Card 3 坐实） |
| runner.ts | 1395 | 1419 | 微恶化（Card 7 未动） |
| runTask DI 强转 | 22+ 文件 | **0**（守卫测试锁死；makeRunTaskFn 22 文件） | **改善**（Card 4 坐实） |
| ui/*-api.ts | 12 文件 ~1947 行 | **15 文件 2368 行** | **恶化**（D8 tripwire 已到 +3 文件——引爆条件满足） |
| event-subscriptions | —（新） | 1066 行非测试；fan-in **1** / fan-out **3** | 新热点但**耦合健康**：体积风险非耦合风险 |
| cron/singleton | 28 | 28 capability 声明 + 10 infra schedule = **38** | 口径修正（多用户债台账按 38 计） |

**对决策菜单的影响**：
- **D8 tripwire 已触发**（12→15 文件，超过「再 +2 即启动」线）——typed client codegen 从「记债」升级为「可启动」，仍待 owner 确认时点。
- **D3（Card 1 http 腿）紧迫性上调**：`@/server` 直穿总量在涨（735→882），facade 停滞期每个新 PR 都在加债；lint ban 越早落越省。
- **新增观察项：registry.ts 治理**——1914 行已超 actions.ts，成为头号 god file；其膨胀源（per-task 结构化输出 schema 内联）应评估外置（可并入 D5 的分批盘子或单开小票）。
