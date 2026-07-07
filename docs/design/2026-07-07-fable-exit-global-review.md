# Fable 全局终审 — 离任备忘录（2026-07-07）

> **性质**：Claude Fable 5 在本项目的最后一个工作日产出的全局综合判断。不是又一轮审计——
> 全局 fan-out 审计本项目已做过三轮（deep sweep 258 agent / redline challenge 46 agent /
> brainstorm 47 agent），缺的不是发现，是**收敛**：把散在 20+ 文档里的全局判断压成一个
> 顶层锚，并把 Fable 在体系里担任的「终裁席位」工作方式成文，使模型可换、纪律不换。
>
> **方法**：单脑综合（非 fan-out），基于 PLAN.md 全量 + 三份全局文档
> （`docs/design/2026-07-02-project-logic-master-register.md`、
> `scratchpad/research/2026-07-07-redline-challenge-audit.md`、
> `docs/design/2026-07-06-agency-data-brainstorm-portfolio.md`）+ 本 session 记忆链。
> 所有承重断言标注来源；行号锚点落笔即漂移（redline audit critic 横切 #7 自指），
> 引用以语义锚为主。
>
> **效力**：§2/§3 是建议供 owner 拍板，不是决定；§4/§5 是纪律与事实交接，直接可用。
>
> **同日补记（2026-07-07 晚）**：本文档初稿落笔数小时内，红线条文波已执行 §3 排序的
> 第 3/4 项——merge 政策成文化（owner 拍选项 a，CLAUDE.md Code Review Workflow 已改）、
> P1/P9 措辞刷新、P2 cockpit 手术（PLAN.md ≤200 行看板化 + 头部滚存
> `docs/planning/2026-07-07-plan-header-log-archive.md`）、X6 与批③前两刀
> （audit:fold-writes / audit:flags）在飞（PR #724/#725/#726）。受影响段落已就地
> 标注【✅ 同日】；J4 的「临时票须回写成文层」判例被同日事件直接验证。§6 记录的
> sweep 溢出 2 条未审簇亦已收口 →
> `docs/audit/2026-07-07-redline-sweep-overflow-verdicts.md`（C-23 KEEP-WITH-COST /
> C-24 KEEP，均改文类落点，随 redline 菜单批③走）。

---

## 1. 项目态势一页

**产品**：单用户 AI-native 学习系统（loom），主线 = 方向 B「诊断档案 / 私人教研团」
（owner 拍定 2026-06-23）。机械基底（event-sourcing / θ̂ / FSRS / KG / placement）已按
「先浇筑脊柱再做露出」的顺序建成。

**当前位置（2026-07-07）**：

- **「可开始用」milestone：代码侧 100% 完成**。剩余全部是 owner 运维动作：
  YUK-571 flag 批①（`PLACEMENT_PROBE_ENABLED` + `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED`）
  + day-zero census + 生产部署（生产 compose 栈在 owner 侧机器）。
- **YUK-538 全项目逻辑打磨 program：14/14 收官**。全部走完整 misconception 待遇
  （独立调研 → code-ground → 对抗 → 设计 doc + Linear）。
- **agent 例会（YUK-572 PR-1/PR-2）已 merge，dark-ship**。翻
  `RESEARCH_MEETING_AGENT_ENABLED` 前置 = E-2/3/4 手动闸 + YUK-584。
- **Wave 2 在飞**：Lane E = YUK-573 judge 校准 MVP、Lane F = YUK-576 registry 诚实化
  （各自 worktree，撞 `src/ai/registry.ts` 后合者 rebase）。
- **红线体系刚过完整挑战审**：22 簇 0 DROP、2 REWRITE（P2 cockpit / X6 ADR-0025）、
  13 项 owner 拍板菜单分三批待拍。
- **数据零点**：owner 明示「把产品做完再开始用」——live 数据 ~65 个测试性质 scorable
  event，真实学习数据尚未开始积累。

**一句话总判**：项目处于「建成待通电」的顶点——工程管线的产出速度（经过验证的
dark 能力）已持续数周高于通电速度（owner 翻 flag / 真实使用），且每一波新能力都在
加宽这条裂缝。下一阶段的瓶颈不在工程，在通电。

---

## 2. 五个全局判断（Fable 终审）

### J1 · 头号风险已从「工程质量」切换为「通电赤字」

数一下当前 dark 面（均已建成、已过独立 review、flag OFF）：

| flag / 闸 | 能力 | 通电前置 |
|---|---|---|
| `PLACEMENT_PROBE_ENABLED` + `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED` | 冷启 placement + 上传产题（=「可开始用」本体） | 无——纯 owner 运维（YUK-571 批①） |
| `RESEARCH_MEETING_AGENT_ENABLED` | agent 例会 director lane | E-2/3/4 手动闸 + YUK-584 |
| `MISCONCEPTION_PROMOTE_ENABLED` | 误区晋升 + confirmed 段 | YUK-532 + owner 拍 Tier（YUK-536） |
| `PROJECTION_IS_WRITER_{GOAL,MISTAKE_VARIANT,LEARNING_ITEM}` | 三实体 SoT flip | 逐实体 B3 gate + Q4b retained-golden（YUK-548 spec） |
| `THETA_GRID_ENABLED` / `DAY_ONE_PRIOR_ENABLED` / prereq 双 flag | θ-grid / day-one prior / 传播 | 各自独立小闸 |
| `/audit-drift` skill | 成文↔代码对齐 | 零前置——手动触发但没人跑（见 J3） |

「defer flip not build」原则（记忆 `feedback_defer_flip_not_build`）已完成历史使命：
它成功防止了乱翻 flag，但现在约束翻转了——**继续 build 的边际价值 < 通电存量的边际
价值**。redline audit 横切 #6 也从反面印证：五条红线从相互冲突的方向围堵「建成不
通电」，说明体系自己知道这是头号失效模式。

**建议**：把「通电」当一条主线工作对待，而非运维杂项。具体地：YUK-571 flag 批①是
全项目当前 ROI 最高的单一动作（一次部署动作兑现整个 milestone）；在批①落地前，
暂停开新的 dark 能力 lane（Wave 2 两条在飞的收完即止）。

### J2 · 数据零点是一次性资产，通电顺序要围绕它排

owner 的「做完再开始用」策略给了项目一个罕见的窗口：**在第一条真实数据落库之前，
把所有「必须在数据流上游就位」的东西排进去**。一旦开始用，冷启窗口永久关闭。
必须在窗口内就位的（按依赖序）：

1. **审题闸**（YUK-578，已 ship）——第一批题 day-one 干净，θ̂ 从头不被歧义题带偏；
2. **judge 校准 golden set**（YUK-573，在飞）——判分质量的信任地基先于判分量产；
3. **day-zero census**（YUK-571 内）——零点快照，之后所有漂移都有基线可比；
4. **运维看门狗**（YUK-580，已 ship）——~20 条夜间 cron 静默坏三周 = 数据飞轮断供。

这四件里两件已 ship、一件在飞、一件在 YUK-571。**窗口内不欠账**——这是当前工程
排序正确的证据，保持住即可。反之，所有「需要数据积累才有意义」的项
（misconception confirmed 段、教学督导 Part A、周期校准探针、Rust 算力兑现
tripwire）都不应在窗口内消耗火力。

### J3 · 体系层病灶的最小干预：给「成文对齐义务」找一个 owner，并给棘轮装反向齿

redline audit 的真正发现不是任何单条红线（22 簇 0 DROP），而是三个体系病灶
（横切 #1/#2/#5）：成文-现实分裂无对齐义务、执行强度与爆炸半径倒挂、登记面单向
棘轮。我的终审意见是：**不要用「再加一个登记面」治疗「登记面太多」**（audit 横切
#5 原话），最小干预是两条：

- **通电 `/audit-drift`**（已建成的药，自己却是 dark lane——元层面违反 A5）。
  最便宜路径：排期跑一次 + 收尾 checklist 增加一条「若本 session 改了 ADR/design
  doc 所述行为，跑 /audit-drift 或显式豁免」。这恰是 owner 菜单批③第 13 项，
  我把它单独拎出来是因为它是唯一「零新建、纯通电」的体系级修复。
- **给登记面棘轮装反向齿**：任何净增登记面（新 audit / 新 allowlist / 新 hook）的
  PR，须同时提名一条候选 RETIRE 或显式声明「无可退役项」。P6 已实证 allowlist
  解除机制 98% 失灵（63/64 条 kind:manual 规避机器可检通道）——解药是退役义务，
  不是更严的登记。

【✅ 同日·部分】批③前两刀（audit:fold-writes / audit:flags）已在飞（PR #726）——
注意它们本身是净增登记面，恰好是给棘轮装反向齿提案的第一块试金石：该 PR 或其
后继应提名首条候选 RETIRE。/audit-drift 通电与 RETIRE 义务仍待拍。

### J4 · 仲裁判例三案三答：统一 doctrine 草案（供 owner 拍）

「owner 指令能否住 agent 可写载体」在三份仲裁里得到三个答案（P5 拒 PLAN.md 当权限
真相源 / P9 接受 PLAN.md+ctx-memory 当路由权威 / X1 容忍 AGENTS.md SPIKE 段住 owner
级不变量）。这是我出的裁决，矛盾我来收。统一判据草案：

> **权威载体分级**：① CLAUDE.md / AGENTS.md / ADR（成文红线层）＞ ② Linear issue /
> design doc（决策记录层）＞ ③ PLAN.md / ctx-memory / .remember（工作面镜像层）。
> **判据不在载体，在指令类型**：*权限授予类*指令（谁可以 merge / 谁可以花钱 / 谁可以
> 写结算层）只有落到①层才持续生效——口头或③层授予的权限是**临时票**，须在下一个
> 收尾 checkpoint 前回写①层，否则自动失效（这正是 owner-merged 悖论连续两 session
> 复现的机理：口头授权停留在③层，classifier 只认①层）。*事实与路由类*信息
> （模型路由、当前状态、判例）③层可作权威镜像，因为它们错了可自愈、不产生
> 不可逆动作。X1 的 SPIKE 段属于事实类，合法；P5 的 merge 授权属于权限类，
> 必须上①层或保持人工合。

这份草案直接给 owner 菜单批①第 1 项（owner-merged 句）提供了裁决框架：要么把
merge 授权写进 CLAUDE.md（权限落①层），要么维持人工合（临时票过期）。二选一，
没有第三态。

【✅ 同日】owner 已拍选项 a（全量 pre-PR gate + 独立 review + CI 绿 → 可自主 merge，
owner 可点名人工合），CLAUDE.md Code Review Workflow 已改——**权限落①层，正是
本判据预测的唯一稳定终态**。载体分级 doctrine 本身仍待作为通用规则采纳（本次只
解决了 merge 授权这一实例）。

### J5 · 模型断档的连续性：「终裁席位」是角色不是模型

Fable 在本体系的实际角色 = 数值终裁 + 对抗仲裁 + 红线辩护（softmax 逐位复核、
BKT 数学核、λ* 逃逸挖掘、redline 46-agent 环的辩护/终裁/critic 席）。今天之后
这个席位不空缺——**已有成功先例**：#704 revert-bracket 波 fable quota 归零时改
Opus xhigh 终裁，工作正常（resume 缓存回放零成本）。需要改的成文：

- 模型路由记忆里「fable 复活 = 顶档稀缺」应改为「**顶档席位 = 当前可用的最强模型
  （opus xhigh 起）**」——席位纪律（见 §4）不随模型变。【注意】同日条文波刚把
  三档路由（含「fable 为顶档稀缺」）成文进 CLAUDE.md 头部——fable 下线后该句应按
  本节读作「顶档席位」，下次触碰 CLAUDE.md 时顺手勘误（memory
  `project_fable_offline_top_seat` 已立可查）；
- Workflow/subagent 编排里所有硬编码 `fable` 的调用位，fallback 到 `opus` + `effort:
  xhigh`（多数编排本就带 Opus fallback，redline workflow 已实证双轨可跑）。

---

## 3. 优先级裁决（接下来 2-4 周的顺序建议）

1. **owner 运维批（最高 ROI，一个下午）**：YUK-571 flag 批① + day-zero census +
   部署；顺手清 Linear stale 状态批（YUK-519/531/476/407 等终裁建议已在案）。
2. **Wave 2 收尾**：Lane E（YUK-573）/ Lane F（YUK-576）在飞，收完即止。
3. **owner 拍板批（全是拍字不是工程）**：YUK-579 三决策点（preflight 已备）、
   redline 菜单批①三项【✅ 同日执行：merge 政策选项 a / P1 分层 / P9 路由，见头部
   补记】、YUK-536 misconception Tier（仍待拍）。
4. **redline 菜单批②**：P2 cockpit 滚存归档【✅ 同日执行，锚点原文保真进
   `docs/planning/2026-07-07-plan-header-log-archive.md`】+ X6 ADR-0025 改写 +
   northstar fixture 修复【在飞 PR #725】。
5. **数据开闸后**：按 J2 的「需要数据」清单自然解锁（misconception confirmed、
   教学督导、校准探针、Rust tripwire 重测）。

**明确降级**（不是现在）：Rust Phase 3-4（tripwire 未触发：单学习者 scorable
> ~5,000 或数值引擎进 recurring job）、native app（YUK-563）、misconception
Tier 2/3（n=1 warrant 不成立）、YUK-575 durable lane 复活（等 agent 例会通电后
再看是否仍是 dead code）。

---

## 4. 终裁席位 doctrine（交接给后继模型的裁决纪律）

这些不是新规则，是从数十次对抗环里提炼的已验证工作方式。后继坐终裁席的模型
（Opus xhigh 起）照此执行：

- **D1 数值主张必须亲手复算，不信 finder 的方向**。判例：#702 softmax 波终裁纠正
  finder 的方向转置、并挖出 finder 没找的 λ* FP 逃逸既存缺陷；#701 BKT 波对 3PL
  Fisher 对标 Lord 恒等式逐项验算。finder 报数值问题时，终裁的工作是重跑数值，
  不是评估论证的说服力。
- **D2 REFUTE 与 CONFIRM 同等留档**。被驳回的 finding 进 spec 附录 doctrine
  ledger（含机理），防止下一轮 review 复查复挑。redline audit §4 判例段同理。
- **D3 对抗环的价值在「实读击倒」，不在投票**。redline 环 12 个非 KEEP 初裁被终裁
  实读证据击倒 10 个——如果只数票，结论会反转。debate-as-vote ≈ chance
  （anti-swarm 记忆）；席位的职责是拿证据，不是聚合意见。
- **D4 fail-closed + typed refusal 优先**；fail-open 只在有穷尽证明时（判例：#699
  WAL prev_text 守卫 throw 附零误杀穷尽证明；X4 红线「不伪造中性值」）。
- **D5 producer+consumer 一体交付**，否则就是在制造下一条 dark lane（brainstorm
  portfolio 对校准探针的强制条款；J1 的通电赤字正是此病的存量形态）。
- **D6 承重引用配语义锚**。行号锚点落笔即漂移；`audit:relations` 的 `file:marker`
  反查模式是正确形态——registry 声明消费关系、脚本源码反查、marker 失配报 STALE。
- **D7 执行强度对齐爆炸半径**。机器 gate 优先给高爆炸半径不变量（结算层单写者、
  fold-owned 表），而不是数据卫生（redline 横切 #2 的倒挂是现状，方向要反过来）。
- **D8 单脑综合 + 条件派 scout ＞ 大 fan-out 投票**。fan-out 用于覆盖（找），
  综合与裁决收回单脑（判）。本文档自身即按此纪律产出。
- **D9 席位输出永远给出裁决 + 机理 + 可执行修法**，不给「两案并呈」——除非该
  fork 是 owner 的判断型取舍（价值观分歧），那才上呈（P1 分层措辞的精神）。

## 5. 全局陷阱 register（散档收拢，一处查全）

工程事实类，散在十几份 PR 实录 / spec 附录里，收拢到一处（各条均有实证判例）：

| 陷阱 | 事实 |
|---|---|
| pg-boss v12 裸 `singletonKey` | 是 no-op，必须配 `singletonSeconds`（YUK-486/491 两次踩） |
| `sendAfter` | 全仓零先例，触发化提案先查（cron 审计通用坑） |
| `writeEvent` 默认扇出 | 进 memory outbox → brief-regen；取证/巡检类事件必须 `ingest_at` opt-out |
| tsgo | 非确定、有 gap（#644 CI 抓本地漏），可疑处用真 tsc 交叉验 |
| stacked PR | 父 PR 合后子 PR base 必须手动 retarget main，否则合进 dead 分支静默丢改动（#644 事故） |
| branch protection | 拒 merge-commit 且 force-push 被 git-guard 拦 → squash，或 rebuild 到新分支名 |
| flag 字面量三形态 | `'true'` / `'1'` / 两者兼收并存，写错静默 no-op；统一提案在 redline 菜单批③ `audit:flags` |
| flag 命名抢注 | 设计 doc 钦定的 flag 名会被并行 PR 抢注（`PREREQ_PROPAGATION_ENABLED` 三方撞名），跨 PR 需协调 |
| drizzle `db:migrate` CLI | 本地静默崩（journal 无 pending 仍 exit 1）；`scripts/migrate.ts` 程序化路径正常 |
| claude-context `get_indexing_status` | 索引未完成时早报 completed；结果偏靶查 snapshot totalChunks（本仓健康 ~13k） |
| OCR bot | 13-min cap；CodeRabbit/PR-Agent 会 rate-limit 空 pass（check 绿零内容），覆盖靠独立 review 补 |
| macOS `date` | 无 `%3N`，毫秒时间戳用 python |
| grep 找不到 ≠ 不存在 | SQL/migration/view 只有语义检索能命中，先 claude-context 二次验证 |

## 6. 交接清单（下个 session 从哪接）

- **在飞**：Wave 2 Lane E（YUK-573）/ Lane F（YUK-576），各自 worktree off
  `dba3f77d`，撞 registry 后合者 rebase。
- **待 owner**：YUK-571 flag 批① + census + 部署；YUK-579 三决策点
  （`scratchpad/research/2026-07-06-yuk579-preflight.md`）；redline 13 项拍板菜单
  （`scratchpad/research/2026-07-07-redline-challenge-audit.md` §5）；YUK-567
  design pass 时机；Linear stale 状态批。
- **未审尾巴**：~~redline sweep 溢出 2 条~~【✅ 已收口 → 本 PR 附
  `docs/audit/2026-07-07-redline-sweep-overflow-verdicts.md`：C-23 KEEP-WITH-COST
  （ADR-0011 勘误 + 直写 lane 触发器）/ C-24 KEEP（RT2 前置机检 + phase1_5 旧稿拆弹）】；
  portfolio §5 红线挑战组 3 条（已有对抗记录在案，只等拍板）。
- **本文档的后续**：§2 J3/J4 的两个提案（棘轮反向齿 / 权威载体分级）若 owner
  认可，落地路径都是改 CLAUDE.md + redline 菜单对应项，无新工程。
