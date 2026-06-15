# ADR-0041 — Copilot 真正全能：reach（通用 task 调用）+ endurance（异步长程）+ checkpoint（per-utterance PR 写侧安全）

**Status**: Accepted (2026-06-15)
**Part of**: YUK-203 · AI pipeline re-think · D14 编排轴。主 rethink 重想了 AI 的「逻辑」（B1-B5 每个引擎算什么），但 AI 的「pipeline」（怎么被调用/编排）从没当一条轴拍过；本 ADR 是其中 owner 当前主攻的 copilot-全能子轴的决策固化。
**Decision source**: 三设计文档 —— `docs/design/2026-06-15-ai-pipeline-current-map.md`（understand 现状地图，workflow 7-agent / 942k tokens，含 file:line）、`docs/design/2026-06-15-copilot-agentic-checkpoint-draft-layer.md`（写侧 checkpoint，rev2）、`docs/design/2026-06-15-copilot-reach-endurance-design.md`（reach+endurance+durable-run §3.4）—— + owner 2026-06-15 逐问压实（「通用原语怎么实现 / 写一题多题型怎么适配 / 哪些直接写 schema / durable-run 长什么样」）后选定 ADR 化。
**Related**: **ADR-0039（单编排者 + A/B/C 出手强度表——本 ADR 把 A 档推到 turn 级）** · ADR-0025 ND-5（propose-only——本 ADR 把闸从 per-change 搬到 per-utterance，非抛弃）· ADR-0006（event=SoT，派生可重放——revert 地基）· ADR-0031/0032（author_question / DomainTool surface 重设计——reach 的实证样本）· ADR-0040（笔记 mutator apply+undo = per-event 版同款机制）。

---

## 背景

owner 要 copilot 像 Claude Code 一样长程多步自主、够得着一切（「成本无所谓,真正全能」）。grounding 后三堵墙:① 写侧 `propose→inbox→人审` 是逐改动同步人类闸,从根掐死多步;② reach——registry 36 task kind,copilot 直接够得着仅 ~25 个手包 copilotTools,重活靠 inline 嵌套 `runTask` 阻塞父预算;③ endurance——CopilotTask `maxIterations:6`/`timeout:60s`,超轮 `throw error_max_turns` 当 crash,且 copilot 被关在同步面、无桥到异步 durable 面。本 ADR 拍三腿合一的架构方向。

## 决定

### 1. 写侧安全 = per-utterance checkpoint（PR 模型；闸从逐改动搬到逐句话，amends ADR-0039 / ADR-0025）

- **闸搬位置**:`用户一句话 = 一个 checkpoint = 一个 PR`。copilot 每请求已写的 `user_ask` 事件即 PR 锚（`checkpoint_id = user_ask event id`），turn 内所有写 `caused_by` 链回它 = PR 的 commit 图 + 级联 revert 依赖序。
- **改动直接落 live**（不隔离）:copilot 读 live → 看见自己上一步 → 接着建（多步链条通）。撤一个 PR = 对其事件组追加补偿事件（`CorrectionKind=retract/supersede/restore`），派生态重算 = 非破坏删（ADR-0006 红利）;撤早期 PR 级联（按 caused_by 反依赖序）。
- **安全模型 approve-before → revert-after**:对 n=1 成立（你在看、窗口短、一句话一 diff）。这是 propose-only 的**进化**（闸搬到 turn 边界），非抛弃。
- **唯一保留 hard 的 = user_verified**:即便 live+revert,改 user_verified 块在 PR diff **强制高亮 + 默认不 included（要主动勾）**。承 ADR-0040 user_verified 硬边界。
- 这是 ADR-0039 **A 档「自动+撤销」推到 turn 级**;ADR-0040 笔记 mutator（apply+reverse_patch+undo）是 per-event 版同款。

> **⚠️ 2026-06-15 AMENDMENT（ADR-0044 / YUK-363 证伪并修正本节，劈成两半非推翻）**：本节原假设「系统已 event-sourced → 撤事件即派生自动重算（纯 ADR-0006 红利）」。`copilot-omnipotent-map` + `event-sourcing-foundation-redesign` 对着代码证伪：**系统是 event-logged，projection 是命令式写，撤事件 projection 纹丝不动**。修正四点（详见 ADR-0044）：
> 1. **「派生重算红利」劈成两半**：结构性派生（知识树/边/artifact/structured/mistake/goal/learning_item）走 **fold 重算**自动复原（ADR-0006 红利**成立**）；θ̂(mastery_state)/FSRS(material_fsrs_state)走 **before/after 快照恢复**（命令式覆盖写，撤事件不自动重算，红利**不成立**），revert=恢复快照 + 级联倒带。
> 2. **级联遍历器是硬前置非既有能力**：现有 `getEventChain` 只单跳，recursive CTE 仓库从未落地。`collectCascadeFromCheckpoint`（`src/server/events/cascade.ts`，首个 WITH RECURSIVE + cycle guard + depth 64 熔断）由 YUK-363 Wave 0 引入。
> 3. **~~worker `ctx.causedByEventId` 透传 = 头号硬前置~~ → 已闭环（2026-06-15 grounding 修正）**：对着 M5 后代码证伪——`ToolContext.causedByEventId`（`types.ts:38`）存在，同步面（`chat.ts:929`）+ 所有现有 durable job（`quiz_gen.ts:418` / `sourcing.ts:329` / `coach_daily.ts:323` / `dreaming_nightly.ts:325`）已全透传 `causedByEventId: triggerEventId`，mirror writer（`mcp-bridge.ts:289`）已从 ctx 读。未来新建 copilot durable run handler 照 quiz_gen 模式填即满足，**非独立前置、不高于 rename**。真·残留缺口仅 worker manifest 接线（`start-worker.ts` 漏调 `registerCapabilityCopilotTools`，功能不缺工具的真相源对齐），折进 #47 首发 lane。详见 ADR-0044 §5 修正。
> 4. **诚实天花板**：per-utterance 窗口内（刚说完未练）级联几乎总干净（下游全是 projection + 可软删实体）；**跨 turn 撤旧 PR 触及已练 attempt/已入册 FSRS 时部分不可逆**（retract 真 attempt = 篡改用户行为历史）；θ̂/FSRS 快照只能倒带到 attempt 前、不能「抽掉中间保留后续」（owner 否决重放）。遍历器 `reversibility` 标记如实展示，触及 irreversible 整体拒绝 + 告知边界。**checkpoint 腿 gated 在 ADR-0044 改造之后；reach/endurance 两腿不依赖、可并行先做。**

### 2. reach 通用化 = 两种原语，不是一种（取代逐个手包 + 五处手接线）

- **三种写入 flavor,sub-agent 从不直接写 schema**:fanout-生成（专门 sub-agent，如 `author_question`→QuestionAuthorTask）/ inline-生成（copilot 自吐内容直写，如 `author_artifact`）/ 直接结构化写（args 即 payload，如 knowledge 边/树、learning_item 生命周期、write_quiz）。写入永远确定性,由 wrapper/applier 做。
- **生成型 reach = `run_task` dispatcher**:每个 copilot-invocable 生成任务在 registry 声明 `{ intentSchema（题型/形态无关的意图）, prepare（任务专属预处理：id 校验/profile 解析/归一，不可被 bypass）, invocable flag }`。类型复杂度（如 9 种 QuestionKind）被 typed task + Zod 吸收,**copilot 只给意图**。加新任务进可达范围 = 声明 3 字段,非今天五处手接线（bootstrap CORE_TOOLS 顺序 + allowlists + 包 manifest + 测试计数 + 工具文件）。
- **结构型 reach = typed apply**:边/树/生命周期/拼卷/题字段编辑的 payload schema 是**承重的**（缺 target 即废），保持 typed mutation surface 或 keyed-to-applier 的 `apply(kind, payload)`，**不走 schemaless 通用 run_task**。
- **单 applier choke point**:两种 reach + 三 flavor 最后都汇进同一确定性 applier 层 = checkpoint 戳 PR 事件的**唯一点**,完全不关心上游 fanout/inline/args。

### 3. endurance = 异步 durable + summarize-continue + 抬交互 caps

- **三层**:短重活仍 inline（低延迟）/ 长程搬 **durable pg-boss job**（抗断线/重启、不被单次 SDK call 的 6 轮掐、复用现成异步面）/ **summarize-continue**（逼近预算压缩进度续跑新窗口,**不再 `throw error_max_turns` 当 crash**）。交互回合 caps 从 6 抬到数十级。
- **durable-run 形态 ~90% 现成基建**（ingestion 管线 + echo golden E2E 已证）:`writeJobEvent`（INSERT job_events + pg_notify 同事务）→ listen_loop → sse_router → SSE `Last-Event-ID` replay+subscribe → client `sse.ts`。贴法:**run handle = checkpoint_id**（`business_table='copilot_run', business_id=user_ask event id`，状态从 replay 派生，几乎不用新表）;chat 渲 **run card** 订阅进度（关页/刷新可经 Last-Event-ID 重放重建——同步 SSE 内存流做不到）;done → 终稿 + per-utterance PR。
- **interrupt/queue 单线程串行化**:n=1 照 Claude Code,**一次一 run、不并发**（并发 durable run 同时 live 写同图 = 乐观锁 409 地狱）。边跑打字→入队;显式停止→打断（cancel job + partial 留 live + partial PR 进 keep/revert，不自动撤）。
- **delta 统一**:短回合同步直流 / 长回合 delta 过 job_events,client 同套帧两源。

### 4. 三腿收束于一处（架构闭环）

reach 多形态写入 → **单 applier** → checkpoint 在 `user_ask` 锚处戳事件 → durable run 进度经同一套 **job_events** 流回 chat → **PR 等该句话派出的所有 async job 落完才关闭可审**。reach（够得着）/ endurance（跑得久）/ checkpoint（撤得回）在单 applier + user_ask 锚 + job_events 流三个共享点自洽闭环。

---

## 后果

**正面**
- copilot 获得 Claude Code 式长程多步自主:reach 覆盖全部 registry task（含未来，声明 3 字段即达）;endurance 抗断线/重启、不被 6 轮掐;写侧多步不再被逐改动闸掐死。
- **de-risk**:endurance 第 2 层（durable 长程）原以为最大新工程,grounding 后发现 ingestion 已把「长 async job + 可重放 live 进度」整链跑通,新工程仅四块且有界。
- **单 applier choke point** 让 checkpoint 的事件戳/diff 构造集中一点,reach 多形态对它透明。

**代价 / 风险**
- 安全模型 approve-before → revert-after:有「改了才撤」的窗口（n=1 可接受，非多用户安全模型）。
- **mimo 长程连贯性是天花板**:copilot 跑 mimo-v2.5 非 Claude,endurance 基建 ≠ endurance 质量,无限轮买不来连贯。
- **通用原语放大注入面**:五防注入从锦上添花变承重墙（dispatch 范围由 prompt/意图定）。
- **worker 面 copilotTools 只半接线（half-wired gap）= 真相源对齐缺口（非功能阻断，2026-06-15 grounding 修正）**:worker 进程靠 `bootstrap.ts` CORE_TOOLS（41 superset）兜底，未调 `registerCapabilityCopilotTools`。**功能上 worker 不缺工具**（superset 含全部 26 manifest 工具），是 manifest 归属真相源在 worker 未接线，非 reach 阻断；fix = `start-worker.ts` 一行对齐 app，折进 #47 首发 lane。`causedByEventId` 透传见上方 §1 amendment 第 3 点——**已闭环**，原「头号硬前置」框定已撤。
- `propose_*` 命名债:8 个直接结构化写在 live+revert 下已是「live 写+可撤」,`propose_*` 成误名,实施波次统一 rename（连同 allowlists/manifest/bootstrap/测试计数）。
- reply_delta 持久化体量分叉（token 级落 job_events 高写入）+ 打断须 cancellation-aware + sync/async 阈值实测——实施细节,留落地阶段定。

## 实施细节 deferred（决策方向已 ratify，不阻 ADR）

intentSchema/prepare 契约在 registry 的落地形 · durable-run 瘦 handle 是否需新表 + run-card UI · reply_delta 持久化粒度 · summarize-continue 触发与压缩策略 · sync/async 阈值 · `propose_*` rename 波次。三腿 ADR 化时一并批量建 Linear 票（承 YUK-203）。

## 备选（已否决）
- **reach = 一个裸 schemaless `run_task`**——否决:结构化写 payload schema 承重（缺 target 即废）,且 naive dispatch 丢 prepare 预处理（id 校验/profile/归一）。
- **reach = 继续逐个手包工具**——否决:永远不全能,每个新工具五处手接线 ceremony。
- **endurance = 只抬 caps 不搬 durable**——否决:同步 SSE 分钟级脆,断线丢全程,不抗重启。
- **endurance = 并发多 run**——否决:同时 live 写同图 = 乐观锁 409 地狱。
- **写侧 = 保留 propose 逐改动 gate**——否决:从根掐死多步（owner 原始诉求）。
- **写侧 = LIVE/PREVIEW 隔离 overlay（checkpoint v1）**——否决:over-engineering,「落库+事后撤」自动满足「copilot 看得见自己草稿」,可见性 filter 不需要。
