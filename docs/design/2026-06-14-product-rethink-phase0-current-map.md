# 整个产品重新想 · Phase 0｜现状地图

> **这是什么**：一次「整个产品重新想」的地基。9 路并行 opus readers 啃现状代码/文档 + 1 路 opus 综合，产出「**我们现在是什么**」的 grounded 地图——只描述现状 + 诚实标张力，**不给重设计方案**（那是 Phase 2）。
>
> **怎么读**：§1–§4 是现状（形态/算法/内核），§5 是已锁决策，**§6 跨块张力是「重新想」最该盯的承重墙**，§7 是 Phase 1 大调研该回答的靶子，§8 是诚实的校准与未覆盖，附录 A 是 9 路 readers 的 grounded 细节（可下钻 file:line）。
>
> **生成**：2026-06-14，workflow `product-rethink-phase0-map`（全 opus，10 agent，~1.4M tokens）。
>
> ⚠️ **分支校准（重要）**：本地图基于 `yuk-342-memory-p2-reconcile` 分支（= `main` + 5 个 memory 提交）。所有「现状」描述对本检出成立——本 main 的 `app/`、`middleware.ts` 已不存在，`server/`+`web/`+`src/capabilities/` 已就位，新形状是真的。**唯独** R9 引用的「M5 採石场单 commit 拆除 192 files」的具体提交（`e8e8ec94`/`8977e385`）经 git merge-base 验证活在另一条 `yuk-321-m5-copilot-teardown` 分支，尚未并入本 main——`status.md` 的 M5 shipped 行是「文档先于代码合入」的状态。

---

## §1 产品身份（我们现在是什么）

一个 **单用户的 AI 学习工具**。核心机制四条：

1. **唯一录入通道**：任何题目（拍照 / PDF / DOCX / 手输）→ 原图先落 R2（content-addressed）→ OCR-first / VLM-主导抽取 → draft → 人审 import。错题是题目的标记，不是独立通道（D11）。
2. **知识表示 = 树 + 网**：按认知结构生长的知识点树（`knowledge.parent_id` backbone）+ 5 类 typed-edge 横向关系网（`knowledge_edge`）。「树是骨架，网是肌肉」。
3. **调度 = 知识点级 FSRS**：`ts-fsrs` 按**知识点**（不是按题）调度复习，题只是测量探针。
4. **写入 = 事件溯源 + 提议/人审两段式**：所有结构性/破坏性动作（建节点、reparent、merge、建边、归档、出题入池）都是 AI 写一条 `propose` event，人在收件箱 accept 才落地真实 mutation；全程经 `tool_call_log` + `event` + `cost_ledger` + `ai_task_runs` 留痕，可追溯可回滚。

**AI 的形态**：单一对话式编排者 **Copilot（D14）**——一个横跨全应用的全局 Drawer，LLM 在 6 轮内自主调一组 read/propose 工具读学习信号、提议改动、生成 interactive artifact，**所有 mutation 一律 propose-only**。背后还有 3 个后台 cron agent（Dreaming / Coach / ReviewPlan）和一层 mem0 个性化记忆（attention prior，**非真相源**）。

**技术形态**（post-YUK-321）：Vite SPA（产品语言「Loom 织 · 学习编织台」）+ Hono API + pg-boss worker 三进程，Postgres + Drizzle + pgvector，经 **capability manifest 贡献制**装配。旧 Next.js / Redis 全栈已退场。

---

## §2 形态地图

### 学习闭环（日常一天怎么用）

```
录入 (/record 四 tab → R2+DB+ingestion pipeline)
  → 练习 (/practice 流，FSRS 按知识点排程)
  → 复习到期项回流 /today「今日之线·复习缕」
  → AI 夜间 Dreaming/Coach 跑出提议
  → /inbox 按 18 种 kind 分 lane 逐条裁决 (accept/dismiss 各写一条 event)
  → 知识图 (/knowledge 树+mesh 双视图) 沉淀节点/边
  → AI 观察 (/agent-notes) 旁观 agents 互留信号 (纯只读)
  → Coach (/coach) 周报回看
```

### 各面（14 条 SPA 路由，集中式 `web/src/router.tsx` 单一登记，默认落 `/today`）

侧栏 7 个真实入口分两段——**织造**=今日/练习/录入，**整理**=收件箱/知识/AI观察/Coach；admin 四面经侧栏底部按钮进，不在主 nav。

- **`/today` 是聚合枢纽不是起点**——把复习队列、AI 提议、AI 改动、周热力汇在一屏；三个 hero CTA（复习/录入/Copilot）才是动作起点。数据中枢 = `/api/workbench/summary`。
- **`/practice` 是视图状态机**（流 / 卷架 / 散题 / 卷 / 复盘）——用户只见 AI 一句理由，不见机制。
- **`/inbox`** 是 AI 编排者产出的**人审闸口**（需裁决）；**`/agent-notes`** 是 agents 信号的**纯旁观面**（read-only，唯一交互是本地「已读」）——构成「**读 vs 判**」两类 AI 输出面。
- **`/coach`** 与 `/agent-notes` 都 read-only never-mutate，请求时从事件流即时算。
- **CopilotDock** 是横跨所有面的常驻 Drawer，根挂（非 Today-scoped）。

### AI 角色 D14（单人格编排者）

Copilot 是全应用**唯一面向用户的对话式 agent**：单人格、第一人称署名「我」、统一记忆读取面。它「编排」= LLM 自主决定调哪些 DomainTool；工具面按触发方式动态切（自由对话=copilot surface 25 工具，点 chip=更宽的 mistake-action surface）。

各域以 **copilotTools 贡献制**登记工具：knowledge 6 / practice 8 / agency 5 / ingestion 2 / copilot 自己 5（notes/shell/observability 不贡献）。teaching 走确定性 behavior-pack 早返（不进 token 循环、不耗工具预算）。

> **「单人格」的真实语义**：指**面向用户的对话面唯一**。系统其实有 **4 个 agent 人格**（前台 Copilot + 后台 Dreaming/Coach/ReviewPlan），surface 严格隔离。

### 壳层不变量

capability UI **不 import 路由库**，导航靠 `(to:string)=>void` prop 注入，路由耦合只活在 RootShell 壳层；nav-config 只登记真实路由不 fabricate 死链；UI 不造假数字（inbox badge 仅 `total>0` 才渲，今日之线全零不渲）。

---

## §3 算法地图（事件流 `event` 表是贯穿所有块的统一脊柱）

### 知识表示（KG）

节点 = `knowledge` 表行（无独立 node 表，`parent_id` 是树 backbone）+ 边 = `knowledge_edge` 行（5 核心 `relation_type` + `experimental:*` + weight + created_by + reasoning）。掌握度 `knowledge_mastery` 是 **PG view** 从 event 流即时算（非存储字段）。subject 严格是**派生视角**——`getEffectiveDomain` 爬 parent 链到第一个非空 domain，`?subject=` 是派生 join，**永不给实体加 subject 列**。

### 掌握 / 调度（FSRS / 练习流）

掌握**被劈成两套不耦合表征**：
- **调度**只认 `material_fsrs_state.due_at`（FSRS 卡，YUK-203 后按知识点 keyed，一点一卡多题共用）；
- **展示/AI** 用 `knowledge_mastery` view（30 天半衰期加权 success，evidence<3 固定 0.5）。

两者**从不互相对账**。「复习什么」有**三套物理分离的实现**：确定性 due 队列（`due-list`）/ AI 战术卷（`review_plan` job，独立 paper channel，ADR-0029）/ 每日练习流（`practice_stream_item` 物化）。题 draft→active 经 Option B 验证闸（`quiz_verify`/`source_verify`）才 enroll 进池。

### 录入

唯一通道（D11）。OCR-first/VLM-fallback 的**实际形态**：GLM-OCR 永远先跑（每页，出文字 hint + 图区 bbox）→ VLM StructureTask（mimo-v2.5）**拥有最终结构**（跨页大题组装）→ VLM 挂了才回落 OCR 结构。第三层 VisionExtractTask/Heavy 是 **manual_rescue_only**，不进自动 cascade。auto-enroll 默认 **observe-only**（只写审计事件，零 domain 行）。原图同步留存是硬不变量。

### 记忆（双半边）

- **个性化半边** = mem0ai 3.0.6 in-process（GLM 5.2 抽取 + 百炼 v4 1024 维 embedding），**P1+P2 已 live**（自建调和层：reconcile job + GLM per-kind 决策 + jsonb 软取代 `superseded_by`/`invalid_at` + write-ahead log + 失败降级 KEEP_BOTH）；落自管 pgvector collection（不在 Drizzle）。
- **KG 知识半边**独立演进。

两半边边界硬：个性化记忆只携 `knowledge_ids` metadata 指向知识点，**绝不反向当知识存储**；FSRS/掌握度全留 PG 不进 mem0。记忆是 attention prior 不是 SoT（ADR-0017）。

### 编排 / 生成（AI 运行时）

静态 task registry（~27 TaskDef 声明语义）+ 统一 runner（3 入口 `runTask`/`streamTask`/`streamTaskCollecting`）送进 Claude Agent SDK `query()` 经 `ANTHROPIC_BASE_URL` 透明路由到 mimo。同步 = Copilot 流式对话 + 判分流内 vision judge；几乎所有重活推到 pg-boss worker（~25 队列）。DomainTool（~40 个 read/propose/write effect）经 mcp-bridge 包成 in-process MCP，每次调用 zod-parse→gate→预算截断→execute→写 `tool_call_log`→按 mirrorEvent 策略写 tool_use event 镜像。破坏性动作无直接 write tool，全 propose-only。三表留痕失败降级不阻断。

---

## §4 内核架构

后端是「贡献制装配层」（替代旧 Next.js `app/api/**` 壳文件仪式，D19）：每个 capability 包用 `defineCapability(...)` manifest 声明自己拥有什么——`name`/`events.actions`/`api.routes`(带 load thunk)/`jobs.handlers`/`proposals.kinds`/`copilotTools.tools`/`ui.pages`+`todayBlocks`。静态组合根 `src/capabilities/index.ts` 把 **8 个包**（agency/ingestion/practice/knowledge/notes/copilot/observability/shell）聚合成类型检查数组（反框架护栏：静态、无动态加载、无运行时插件总线）。

三个装配循环（全启动期静态循环，无运行时总线）：
1. **API 路由**——`buildHonoApp(capabilities)` 循环每条带 load 的 route 调 `app.on(...)`，首请求懒解析后缓存。**唯一真正完成迁移的面**，无 app/api 壳残留。
2. **jobs**——worker 经 `registerCapabilityJobs` 循环挂 manifest 声明的 **12 个**标准工厂 job。
3. **copilotTools**——启动期 fire-and-forget `registerCapabilityCopilotTools` 把 manifest 工具叠加注册进 DomainTool registry。

**六契约封顶**（kernel/CONTEXT.md，第二实例原则不预先抽象）：当前只立了 **2 个真身**——manifest/组合校验（`validateComposition` 6 循环守全局唯一）、事件存储（`events.ts` 薄 facade）。另 **4 个**（投影引擎 / 提议生命周期 / 能动性策略层 / AI 运行时）仍 ⏳ 未立。kernel 当前是**薄壳依赖倒置假象**——`events.ts`/`http.ts` 只 re-export `@/server/*`，依赖方向名义 capability→kernel 实际 kernel→server。

**auth**：`/api/*` 中间件 **fail-closed**——`tokenMatches` 用 SHA-256 摘要定长 + `timingSafeEqual` 常时比较，header 或 secret 任一缺失即拒（M5 review H1 修复），仅 `/api/health` 豁免。单用户工具无 per-user auth。

---

## §5 已锁设计决策

| # | 决策 | 依据 | 状态 |
|---|------|------|------|
| 1 | **七条产品红线**：单用户无多租户 / AI 可追溯可回滚 / 事件是唯一真实来源(correction 唯一撤回) / 科目是视角不是结构(派生轴禁 subject 列) / 原图必须同步留存 / 树是骨架网是肌肉 / 写入仅 propose | spec §6 + ADR-0006v2/0007/0010/0012 | locked |
| 2 | **D1-D20 应然功能逻辑**：D1 FSRS=知识点级幕后传感器 / D2 复习唯一入口=AI 今日练习 / D6 删笔记内嵌自测 / D7 agent-notes=AI 内部信道 / D11 删学习记录,录入=任何题目通道 / D12 流=日程·卷=节目·卷架是持久归宿 / D14 一个 AI 人格 / D15 申诉重判直接生效+correction 留痕 / D16 quiz 独立包不并入 practice | spec §1.9 REV2 | locked（形态落地未跟上） |
| 3 | **反框架护栏**：契约数封顶 6、静态类型检查组合根、无动态加载/无通用插件总线、内核钩子单使用方时降级回包(第二实例原则) | spec §2.1 + kernel/manifest.ts | locked |
| 4 | **抽取层**=确定性 OCR(GLM 默认)做字符 hint+图区 bbox，VLM StructureTask 拥有结构；VLM 失败才回落；rescue=manual 付费非自动 cascade；双引擎(GLM/Tencent)永久共存 | ADR-0002 + YUK-145 + owner 06-07 | locked |
| 5 | **调度单元=知识点非题目**；题是测量工具，选题 seam(variant-rotation by-kind)可被未来 AI scheduler 替换但记忆单元不动 | ADR-0028 + ADR-0030 | locked |
| 6 | **AI scheduler 是独立 paper channel**：确定性 due 队列与 AI review_plan 卷并行而非统一引擎 | ADR-0029 + owner Q2 | locked |
| 7 | **mutation 一律 propose-only**；DomainTool 无直接 mutation write tool | registry.ts + allowlists.ts | locked |
| 8 | **记忆是 attention prior 非 SoT**：search_memory_facts 只读、永不 mutate FSRS/mastery、永不偏置判分、mirrorEvent:never；只供 orchestrator 读 | ADR-0017 | locked |
| 9 | **两记忆半边边界硬**；个性化记忆至多以 knowledge_ids 指向知识点，FSRS/掌握度/知识结构全留 PG | memory-architecture.md §2/§3.7 | locked |
| 10 | **旧记忆从不物理删除**——矛盾/过时一律 metadata 软取代；mem0 公开 update() 封禁；只硬删本轮刚 add 的新条 | reconcile-store.ts + ADR-0017 | locked |
| 11 | **FSRS 数学单一真相 + 单一 writer**；掌握是派生 view 非存储；3 档评级(again/hard/good 无 easy) | ADR-0005 + ADR-0012 | locked |
| 12 | **破坏性 KG 动作只 propose**、软归档从不硬删、乐观锁 version 守突变、relation_type 闭集、边 UNIQUE | ADR-0010/0032 | locked |
| 13 | **REV2 前提变更**：D17 数据可丢 / D18 拆旧建新採石场 / D19 栈换 Next→Hono+Vite 删 Redis / D20 P1/P2a 产出保留 | spec REV2 + YUK-321 M5 | locked（拆除提交在 yuk-321 分支未并入本 main） |
| 14 | **auth fail-closed** | server/app.ts:20-25 | locked |
| 15 | **ARCHITECTURE.md 六契约表**：2 个 ✅、4 个 ⏳ 未立 | ARCHITECTURE.md:19-24 | **drifting**（停在 2026-06-10 P1 时点，M5 后未更新） |

---

## §6 跨块张力 ——「重新想」最该盯的承重墙

> 这是 Phase 0 最重要的产出。9 路 readers 散落的 tensions 汇总去重成 9 条跨块张力。**不给方案**，只说为什么这是重设计要解决的。

1. **提议生命周期契约最大缺口**（承重墙）。`dispatchAccept` 仍是 `src/server/proposals/actions.ts`（1003 行）里一个**中心 22-case switch**，`acceptAiProposal` 入口住旧 `src/server`，shell/copilot/ingestion 三包跨界 import 它。manifest 加了 `proposals.kinds` + 3 包各有 `proposal-appliers.ts`，但中心 dispatch **未真正下放**。
   *为什么重要*：提议/人审是整个产品的核心写入机制。落地器仍中心化 = capability 边界在最关键的写路径上是漏的。「重新想」若要各包真正自治，这是必须先解决的承重墙。

2. **掌握建模的「双脑分裂」无对账**。调度只信 `material_fsrs_state.due_at`，`knowledge_mastery` view 只供展示/AI，两者各从不同信号算、**永不互相校准**；且 mastery 是粗粒度占位公式（evidence<3→0.5、≥180 天事件被丢）。
   *为什么重要*：「掌握程度」是学习工具的认知核心，现在它没有单一概念、是两套不耦合表征、展示侧是临时占位。重新想「我们怎么表征一个人会不会」时，这是最该统一的地方。

3. **「复习什么」三套近重复实现 + AI 与确定性调度两条隔离通道**。`due-list` / `review-session#planReviewSession` / `stream-store` 的 FSRS-due 选题几乎逐行手抄；AI `review_plan` 另开卷不接进 due 选题。`variant-rotation` 自称「未来 AI scheduler 唯一 seam」但 AI 实际没接进。
   *为什么重要*：调度是练习旅程的引擎，三套手抄漂移风险高、AI 调度始终旁路。重新想练习旅程时必须先决定：**统一引擎还是永久双通道**。

4. **capability manifest 贡献制是「归属台账 + 双轨/no-op」而非干净单一登记面**。jobs 双轨（manifest 仅迁 12 个，handlers.ts 渐缩簿仍持 18 个 `boss.work`）；copilotTools 实质 no-op（CORE_TOOLS bootstrap 全量 40+ 先到，贡献制几乎全被跳过）；ingestion jobs / memory pipeline 整体外挂不经 manifest；`validateComposition` 只被两个 unit.test 调用、**不在生产路径**。
   *为什么重要*：「manifest 是唯一登记面」是新架构的立身之本，但实际是过渡态双轨。这决定 capability 自治到底是真的还是名义上的，也决定唯一性校验是运行时护栏还是 CI gate。

5. **KG 侧 bi-temporal 完全未落地**（与代码漂移最大的设计稿计划态）。`knowledge_edge` 只有 `archived_at`（单轴写时间软删，已确认无 `valid_at`/`invalid_at`），无「事实何时为真 vs 记录何时写入」分离；写入期调和环未挂 `runProposeAndWrite`。`getEffectiveTruth`+`CorrectionKind` 实现完整但作用域在 **EVENT 层**（practice 包），不是知识节点/边的事实时效——节点「取代」只能经 merge+archive 表达。
   *为什么重要*：记忆架构设计稿把 KG 半边的时序模型（参考 Graphiti）列为核心方向，但代码侧零落地。**知识图谱要不要真做 bi-temporal、调和环挂哪**，是「重新想知识表示」的核心未决。

6. **mem0 P3 读路径完全未落地**（读写不闭合）。`searchMemories` wrapper（superseded 过滤 + recency 重排）全仓 grep 无果。后果：`search_memory_facts` 工具 + brief 的 `searchFacts` 两读点都**不过滤 P2 已软取代的 fact**——被取代的记忆仍会被检索到、甚至固化进 brief。
   *为什么重要*：P2 软取代写好了但读侧不消费它，软取代当前是「写了没人读」的半环。这直接影响 AI 看到什么记忆。

7. **大量设计意图是 phase-deferred 占位/死入口/僵尸字段**。Today 的 Copilot CTA 死占位（toast 指旧页但 RootShell 已接通真 dock）、今日之线缺「夜链交班缕」、CostRibbon 无预算数据源、Coach 砍掉 TodayPlan/strand/goal-strand、收件箱 defer/archive/judge_retraction accept 未实现只能 dismiss（YUK-44）、RecordPage 文案指向 SPA 不存在的 `/mistakes`、solve/quiz skill 死入口/空转 wire、`knowledge.approval_status` 僵尸 enum、`graph_version` 写死、auto-enroll「enroll」真入库分支生产从未跑过。
   *为什么重要*：设计稿形态（策展今日之线 / 预算护栏 / Coach 规划 / 收件箱全 kind accept / 自动入库）与跑出来的形态差距大。重新想「各面到底该呈现什么」时，要分清**哪些是真要的未做、哪些是该砍的占位**。

8. **九个 ⚖️ 争议行尚未裁决**（spec §3 末，按阶段推迟）：① 自动入库自动模式 ② 复习申诉补完或砍 ③ 五段笔记 check 段落地形态 ④ dwell 遥测去留 ⑤ B 档补深程度 ⑥ goal sequence_hint 展示 ⑦ 记忆简报补深程度 ⑧ agent-notes 观察窗去留 ⑨ learning_item 直接做还是提议分界。
   *为什么重要*：这些是 owner 明确标记「重新想」要落地的悬而未决产品决策——**Phase 2 设计的直接靶子**。

9. **文档↔代码多处漂移与历史包袱**。ARCHITECTURE.md 六契约表停在 P1 时点；docs/architecture.md 概念段仍按旧 Mistake/Question + embedded_check（D6 已裁删）；CLAUDE.md/README 说有「browser-side caller」实际 `src/ai/` 无 `caller.ts`；ingestion job/handler/文件名仍叫 `tencent_*`（默认引擎早是 GLM，`actor_ref` 硬编码 `'tencent_ocr'` 误导可观测性）；注释里大量 Next.js `app/api` 旧栈引用；registry `fallbackChain`/`maxCost`/多数 systemPrompt 是死装饰元数据；`cost_ledger` 对 mimo 端点恒记 `cost_usd=0`（成本可观测性失效）。
   *为什么重要*：漂移让「我们现在是什么」难以从文档读出，新读者（含 AI）易被旧概念误导。重新想前需要一次**诚实的文档↔代码对齐**，否则会在错误地图上设计。

---

## §7 Phase 1 大调研该回答的核心问题

> 形态层 4 条 + 算法层 5 条，作为大调研（文献/产品/数据 × 形态/算法）的靶子。

**形态层**
1. `/today` 该是聚合仪表盘还是动作起点？设计稿的策展「今日之线」（夜链交班缕）缺位——**一天的入口形态到底是什么**？
2. 练习旅程（D 系 P2）的完整形态——流/卷架/散题/卷/复盘五状态机怎么串成连贯的「练习一天」？**AI 调度与确定性 due 队列要统一成一个引擎还是永久双通道**？
3. AI 输出的「读 vs 判」两面（agent-notes 旁观 vs inbox 裁决）边界对吗？收件箱 18 种 kind 该收敛到哪些真正需要裁决的？**九个 ⚖️ 争议行各怎么裁**？
4. Copilot（D14 单人格）与各面的关系——常驻 Drawer 横跨所有面，但 Today CTA 死占位、solve/quiz inline 入口悬空。**对话式编排者与各 surface 的内联入口该怎么协作**？记忆/上下文读取面要不要升级成正式契约？

**算法层**
5. **「掌握程度」要不要统一成单一概念**？现在 FSRS due（调度）与 knowledge_mastery view（展示）双脑分裂、永不对账，且 mastery 是占位公式——真正的掌握建模长什么样？
6. **知识表示要不要做 bi-temporal**（valid_at/invalid_at，参考 Graphiti）？当前 KG 只有 archived_at 单轴 + EVENT 层 correction，节点「取代」只能 merge+archive。知识的事实时效与写入期调和环是核心未决。
7. **记忆层读写闭环**——个性化记忆该喂什么信号（全 event vs 选择性喂 copilot 轮/练习总结）、读侧怎么消费软取代？
8. **capability 贡献制要不要真正收口成单一登记面**？「manifest 是唯一登记面」是真目标还是名义？
9. **提议生命周期契约怎么立**？dispatchAccept 22-case 中心 switch 未下放、4 个内核契约仍 ⏳——六契约里这 4 个该立成什么形状？

---

## §8 校准与未覆盖（诚实）

- **分支级 drift**（见顶部 ⚠️）：现状描述对 `yuk-342` 检出成立；唯独「M5 单 commit 拆除 192 files」的提交归属是分支级 drift，readers 默认它在 main 是不准的。
- **包数**：组合根实为 **8 个包**（R3 准确），R9 称「10 个包」不准（agent-notes 已并入 agency，无独立 quiz 包——与 D16「quiz 独立包」决策存在张力）。
- **TaskDef 数**：readers 称 27 个，未独立结构化核对（采信 readers）。
- **未深入勘察的域**（采信 readers grounded 引用）：notes 域（artifact/TipTap PM schema/living note）、observability 四面查询实现、agency 域（learning_item/goal/dreaming）细节、ingestion 若干具体代码点（figure crop 无 DB 行回显、DOCX 双线、PDF render 超时不真取消）。
- **未跑任何测试/构建**：纯静态 grep + git 验证。行为正确性采信 readers 代码引用 + 关键文件存在性抽查（已确认：validateComposition 仅 test 调用、dispatchAccept 1003 行中心 switch、18 个 boss.work、registerMemoryHandlers 在 handlers.ts、KG 无 bi-temporal 列、mem0 用 invalid_at/superseded_by、CORE_TOOLS bootstrap latch、searchMemories 缺失、8 包、3 个 proposal-appliers）。
- **外部依赖待查**：CopilotTask `defaultModel='mimo-v2.5-pro'` vs 项目记忆记「vision 是 mimo-v2.5 非 -pro」；GLM-5.2 是否 GA。

---

## 附录 A｜9 路 readers grounded 细节

> 每路保留 area + 角色 + 关键文件，供下钻。完整 key_components/tensions 见 workflow 输出。

### R1 形态轴｜学习闭环 & 各面
14 条 SPA 路由集中登记于 `web/src/router.tsx`，nav 真相源 `src/ui/shell/nav-config.ts`。Today=聚合枢纽（`src/capabilities/shell/ui/TodayPage.tsx`，数据中枢 `workbench-summary.ts` 仍靠构造 internal Request 调 `handleReviewDue`）。练习视图状态机 `PracticeFacePage.tsx`。收件箱 18 kind 分 lane `InboxPage.tsx`。
- 张力：练习 solve 链注释漂移 / Today Copilot CTA 死占位 / 今日之线阉割（缺夜链交班缕）/ CostRibbon 无预算源 / Coach 砍 TodayPlan / 收件箱 3 kind 只能 dismiss / RecordPage 文案指向不存在的 /mistakes。

### R2 形态轴｜AI 角色 D14
Copilot = 唯一对话 agent（`src/ai/registry.ts:488` CopilotTask）。编排主循环 `src/capabilities/copilot/server/chat.ts:611`。工具经 `mcp-bridge.ts` + `allowlists.ts`（COPILOT_TOOLS 25）+ `register-capability-tools.ts` 贡献制。evidence 三表 `src/server/ai/log.ts`。
- 张力：CORE_TOOLS 兜底未退役（双轨）/ worker 不走贡献制 / 归属真相源双写 / author_artifact 归属错位（应属 notes 实由 copilot 贡献）/ solve+quiz skill 死入口 / 4 个 agent 人格非 1 个。

### R3 架构骨架｜内核 & 组合根
契约 `src/kernel/manifest.ts`，`validateComposition` 6 循环（只 test 调用）。`server/app.ts:27` buildHonoApp + `toHonoPath` + fail-closed auth。静态组合根 `src/capabilities/index.ts`（8 包）。
- 张力：validateComposition 不在生产路径 / jobs 双轨未收口 / copilotTools 实质 no-op / kernel 薄壳依赖倒置假象（kernel→server）/ ui.pages+todayBlocks 是死元数据无消费点。

### R4 算法轴｜知识表示 KG
节点 `knowledge`（schema.ts:50）+ 边 `knowledge_edge`（schema.ts:688）+ mastery view（schema.ts:806）。提议环 `knowledge/server/proposals.ts`、边 `edges.ts`、rubric `rubric-validator.ts`、派生 `domain.ts`（subject-as-view）。
- 张力：bi-temporal 未落地 / getEffectiveTruth 作用域在 EVENT 层非节点层 / 部分 proposal kind 无 accept applier / 节点层 provenance 薄 / loadTreeSnapshot 5000 行 OOM cap / approval_status 僵尸 enum / 根级 reparent 不支持 / memory pipeline 外挂于 manifest。

### R5 算法轴｜掌握 + 调度 FSRS
FSRS 数学 `practice/server/fsrs.ts`（唯一 import ts-fsrs）、投影 owner `server/fsrs/state.ts`、submit `practice/api/submit.ts`、三套「复习什么」`due-list.ts`/`review-session.ts`/`stream-store.ts`、AI 卷 `jobs/review_plan.ts`、mastery view `drizzle/0005`。
- 张力：掌握双脑分裂无对账 / mastery 粗粒度占位 / 三套近重复实现 / material_fsrs_state 双 keying 历史包袱 / AI 与确定性两隔离通道 / 练习流 AI 化未落地 / 路径命名漂移（src/server/review/ 不存在）。

### R6 算法轴｜录入
manifest 14 路由、`jobs/tencent_ocr_extract.ts`（抽取编排核心）、`glm_ocr.ts`（默认引擎）、`structure.ts`（VLM 拥有结构）、`rescue.ts`（manual）、`auto-enroll.ts`（observe-only）、`server/r2.ts`、session owner `src/server/session/ingestion.ts`。
- 张力：命名漂移（tencent_* 实跑 GLM，actor_ref 硬编码误导）/ manifest 不声明 jobs / figure crop 无 DB 行回显 / Tier3 未实现 / DOCX text 线绕过结构层 / auto-enroll enroll 分支生产从未跑 / PDF render 超时不真取消 / cost_ledger 混 USD/RMB。

### R7 算法轴｜记忆层
client `src/server/memory/client.ts`、调和 `reconcile-llm.ts`/`reconcile-store.ts`/`triggers.ts`、log 表 `schema.ts:886`、读工具 `search-memory-facts.ts`、设计稿 `docs/design/2026-06-13-memory-architecture.md`。
- 张力：设计稿 §1-§7 按 greenfield 写实为 in-place 重构（§8 才对账）/ P3 读路径未落地（软取代写了没人读）/ P4 KG bi-temporal 未启动 / memory pipeline 外挂于 manifest / mem0 collection 不在 Drizzle（audit:schema 看不到）/ 双 worker reconcile 并发 / disableHistory:false 引入 better-sqlite3 脆性 / kind 分类法待校准。

### R8 算法轴｜AI 编排 & 生成
registry `src/ai/registry.ts`、runner `src/server/ai/runner.ts`（3 入口）、providers（只 anthropic+xiaomi 真通）、DomainTool bootstrap `tools/bootstrap.ts`（40+）、worker `scripts/worker.ts`、生成 job 代表 `handlers/quiz_gen.ts`。
- 张力：registry fallbackChain/maxCost/systemPrompt 死装饰 / 文档说有 browser-side caller 实无 / handlers.ts 渐缩簿 18 job / copilotTools no-op / YUK-299 structured-output 几乎未采用 / model id 漂移 / cost_ledger 对 mimo 恒记 0 / 生成→入库闭环未通。

### R9 元层｜已锁决策 & ADR & D1-D20
权威源 `docs/superpowers/specs/2026-06-10-architecture-redesign-design.md`（D1-D20 + 六契约 + M0-M5）、33 篇 ADR（`docs/adr/`）、`ARCHITECTURE.md`、`status.md`、中心收费站 `src/server/proposals/actions.ts:585`。
- 张力：提议生命周期契约最大缺口（dispatchAccept 22-case 中心 switch 未下放）/ ARCHITECTURE.md 六契约表停在 P1 时点 / docs/architecture.md 概念段漂移（旧 Mistake/Question+embedded_check）/ D14 编号语义被压缩 / 九个 ⚖️ 争议行未裁 / status.md M0-M4 shipped 行缺失 / quiz 包定位悬而未决 / 部分 ADR 缺 Status 行。
