# Copilot 真正全能 · reach + endurance（另两腿）

**Date**: 2026-06-15
**Status**: **Design-in-progress**（模型已收敛；durable-run 形态 + run-handle/进度订阅 UI + intentSchema/prepare 契约落地 待续）
**Part of**: AI pipeline re-think · D14 编排轴 · copilot 真正全能。三腿合一：reach「够得着全部 task」+ endurance「异步长程不被 6 轮掐」（本文）+ write-safety「per-utterance checkpoint」（见 `2026-06-15-copilot-agentic-checkpoint-draft-layer.md`）。
**Decision source**: owner 2026-06-15「成本无所谓,copilot 真正全能(像我用 Claude Code)」→ 逐问压实:「通用原语怎么实现?写一题进题库、多题型怎么适配?」→「大部分功能是 copilot fanout agent 然后回报吧?哪些是直接写 schema?」→「按你的推荐走」。
**Grounded on**: registry/runner/budgets/copilotTools 五包 manifest/question-author/author-artifact 代码核验(file:line 见 §1)。
**Related**: checkpoint 草稿层(write-safety 腿) · AI-pipeline 现状地图 decision_inputs #5 · ADR-0039(单编排者+A/B/C 出手强度表) · ADR-0031/0032(author_question/propose_question_edit 现状路径)。

---

## 0. 问题

owner 要 copilot 像 Claude Code 一样长程多步自主、够得着一切。现状两堵墙顶在同一处:**copilot 被关在同步面,够重活靠 inline 阻塞、长程被 6 轮/60s 掐**。reach 和 endurance 其实是同一条轴——把 copilot 从「只在同步面」桥到「异步 durable 面」,并换上正确的 reach 原语。write-safety 腿(checkpoint)已收敛,且**正是它使能了通用 reach**(通用 dispatch 之所以敢放开,因为有 per-utterance PR + revert 兜底)。

## 1. Grounded 现状

**reach gap**: registry 共 **36 个 task kind**（`src/ai/registry.ts`），copilot 直接够得着 **~25 个 copilotTools**（`src/server/ai/tools/allowlists.ts:136` 五包 manifest union）。重活够不着或只能 inline 嵌套:`proposal-tools.ts:122-123`（`runTask` inline）、`runVariantGen`/`runQuestionAuthor`（1687/1776）。

**endurance ceiling**: CopilotTask `maxIterations:6`→SDK maxTurns=6、`timeout:60s`（`registry.ts:494`）；`maxCost` 未接线（`registry.ts:18-19` 自承无 USD accounting）。每消息 ContextBudget maxToolCalls **10**/nodes+edges **250**/eventRows **1000**（`budgets.ts:37-42`）。超轮 = `runner.ts:500/994` 对任何非 success subtype（含 `error_max_turns`）`throw`；streaming 路径已出文字则 graceful-degrade 残文（`runner.ts:1072`）——**无 summarize-continue/续跑 affordance**。

**两个面、无桥**: 同步面 `chat.ts:619` `streamTaskCollecting`；异步 durable 面 worker `boss.work` + `boss.send` 链（OCR/auto_enroll/quiz_gen/note_verify/coach_daily）。**copilot 无法 dispatch durable job**——proposal 路径唯一的 `enqueue*`（`actions.ts:168` enqueueVariantVerify）是人审 accept 触发,非 copilot 发起。

## 2. reach 不是一种原语,是两种

### 2.1 三种写入 flavor（sub-agent 从不直接写 schema）

无论内容来自哪,**schema 写入永远确定性,由 wrapper/applier 做,sub-agent 碰不到 DB**（`question-author.ts:82` Zod parse → 才 insert）。

| flavor | 内容哪来 | 谁写 schema | 例子 |
|---|---|---|---|
| **fanout-生成** | 专门 sub-agent（独立 prompt/预算/schema） | wrapper(parse→applier) | `author_question`→QuestionAuthorTask、`propose_variant`→VariantGenTask、`attribute_mistake`→AttributionTask |
| **inline-生成** | copilot 自己在上下文里生成 | 工具直接 insert | `author_artifact`/`update_artifact`（`author-artifact.ts:67/108`） |
| **直接结构化写** | copilot 的 args 即 payload（无生成） | 工具直接写 | knowledge 边/树 mutation、learning_item 生命周期四件套、`write_quiz`、`propose_question_edit` |

**数量真相与「大部分是 fanout」相反**: ~25 copilotTools 里 ~15 是读、fanout 写**只有 3**（且 variant/attribute 仅 chip surface）、直接结构化写 ~8、inline-生成写 2。fanout 是少数,只留给真正需要专门生成 pass 的（出题/变式/错因判断）。

### 2.2 生成型 reach = `run_task` dispatcher

题型多（`business.ts:16` 9 种 QuestionKind）**不归 copilot 管**——差异活在 QuestionAuthorTask 的 prompt + `QuestionAuthorDraft` Zod + verify 里。copilot 只给**意图级** seed（`QuestionAuthorSeed`: knowledge_ids + 可选 requested_kind hint + difficulty + material）。

通用原语 = registry 声明式契约,每个 copilot-invocable 生成任务声明三样:

```
registry[Kind].copilot = {
  intentSchema: <题型无关的意图 Zod>,   // 如 QuestionAuthorSeed（已存在，搬进 registry）
  prepare: (seed, ctx) => runInput,     // 任务专属预处理（如 runQuestionAuthor 116-167:
                                        //   id 校验/effective-domain profile 解析/kind 归一）
  invocable: true,                       // opt-in flag；不声明 copilot 够不着
}
```

原语四步: 校验意图 against intentSchema → 跑 prepare（承载专属预处理，**不可省**——naive run_task 会 bypass id 校验/profile/归一）→ dispatch task → typed 输出 → applier。加新任务进可达范围 = 声明 3 字段,**不是**今天的五处手接线（bootstrap CORE_TOOLS 顺序 + allowlists + 包 manifest + copilot-tools.unit.test.ts 计数 + 工具文件）。prepare 平凡的 ≈ identity，近零仪式；prepare 承重的就老实搬进去。

### 2.3 结构型 reach = typed apply（不 schemaless）

直接结构化写（边/树/生命周期/拼卷/题字段编辑）**payload schema 是承重的**——一条边缺 target 即废,schemaless 原语反而更糟。这类**保持 typed mutation surface**,或一个 keyed-to-applier 的 `apply(kind, payload)` dispatcher（payload 仍按 applier 的 Zod 校验）。**不走通用 run_task。**

### 2.4 单 applier choke point

两条 reach（生成型/结构型）+ 三种 flavor,**最后都汇进同一个确定性 applier 层**。这是 checkpoint 的黄金:per-utterance PR 的事件戳 + diff 构造**只挂这一层**,完全不关心上游是 fanout/inline/args。reach 多形态、checkpoint 单点 instrument,在此收束。

## 3. endurance: durable async + summarize-continue + 抬 caps

三层叠加:
1. **短重活仍 inline**——低延迟,不值得 job 往返（阈值见 §3 末）。
2. **长程搬 durable pg-boss job**——抗断线/抗重启、不被单次 SDK call 的 6 轮掐、复用现成异步面。chat turn 立即返回 **run handle**;job 在 worker 边跑边写事件（事件经 caused_by 落进 per-utterance PR）;UI 订阅进度。copilot「聊天」与「干活」解耦——但**形态 ~90% 是现成基建**(详见 §3.4),非从零造。
3. **summarize-continue**——逼近预算时不 `throw error_max_turns`,而是压缩进度 + 续跑新上下文窗口（CC 的 context 压缩续跑）。配合把交互回合 caps 抬高（6→数十级）。

**sync/async 阈值**（实现细节,作者定）: 按任务的预估时长/budget（registry 已有 `timeout`/`maxIterations`）+ 是否 needsToolCall 路由——短单步走 inline,长程/多步走 durable job。

### 3.4 durable-run 形态（grounded：~90% 现成基建）

durable run 不从零造,是把 copilot run 接到 **ingestion 管线已验证、echo golden E2E 已证**的 job_events 进度流上。现成链:

```
worker: writeJobEvent(tx, {business_table, business_id, event_type, payload})
        └─ INSERT job_events + pg_notify('job_status') 同事务(commit 才发)   [server/events/writer.ts:22-45]
app:    listen_loop(LISTEN job_status, max:1) → sse_router.broadcast        [server/events/sse_router.ts:6 worker 不订自己的 NOTIFY]
SSE:    GET /…/events  Last-Event-ID → computeReplay(补漏) → subscribe(live) [capabilities/ingestion/api/events.ts:41-67]
client: src/ui/lib/sse.ts（fetch-based，带 x-internal-token）
GC:     prune_job_events cron 每日 04:00                                     [server/boss/handlers.ts:75]
```

`job_events`（`schema.ts:513`）append-only、按 `(business_table, business_id, id)` 索引、`id` 即 SSE 游标。贴法:

- **run handle = checkpoint_id,不发明新标识**: `run_id = user_ask event id`（一句话=一 checkpoint=一 PR=一 run）。进度 = `job_events` with `business_table='copilot_run', business_id=run_id`;run 状态从 replay 末事件派生（如 `ui/lib/ingestion-phase.ts:50` 从 replay 派生 phase）。**几乎不用新表**——要的话加 echo_jobs 式瘦 handle（id/status/updated）只为「列活跃 run」+ 重连,event log 仍是 SoT。
- **run card（用户在 chat 里看到的）**: 长任务路由 durable 时,chat 在该 utterance 下渲染 run card,订阅 `/api/copilot/runs/<run_id>/events`（复刻 ingestion replay+subscribe）。worker 边跑边 `writeJobEvent`:`step`/`tool_call`/`reply_delta`/`done`(终稿+PR ready)/`failed`。**durability 红利**:关页/刷新/回来 → Last-Event-ID 重放重建（同步 SSE 的内存流断了就没）。done → 终稿 + per-utterance PR（keep/revert/cherry-pick）。
- **delta 统一**: 今天 delta 直接从 in-request `streamTaskCollecting` 流（`chat.ts` `writeFrame('delta')`）。durable 的 delta 过 job_events（可重放）。**短回合同步直流(低延迟)/长回合 job_events 订阅**;client `sse.ts` 统一,同套 `delta/step/done` 帧两个源,UI 不关心来源。
- **interrupt/queue 串行化（拍定）**: n=1 单会话照 Claude Code,**单线程一次一 run,不并发**——并发 durable run 同时 live 写同图 = 乐观锁 409 地狱（两 run 抢 reparent 同节点）。边跑**打字→入队**(当前 run 关后作下一 checkpoint);显式**停止→打断**(cancel job,已 live 部分留着,partial PR 进 keep/revert,不自动撤);中途纠偏 v1 当 打断+新句覆盖,live-steer(往飞行中 SDK 子进程注入)defer。
- **混合回合**: 一句话既做快 inline 读写又派长 job——即时回复同步流 + 长的出 run card,两批写都 caused_by 同一 user_ask → 同一 PR,PR 等 durable run 落完才关。

## 4. checkpoint 耦合

- **PR 何时关**: per-utterance PR 要等「该句话派出的所有 durable job 落完事件」才关闭可审。这回答了 checkpoint 文档悬着的「异步时 PR 何时关」。
- **`propose_*` 命名债**: 8 个直接结构化写今天叫 `propose_knowledge_edge` 等,语义是 propose-then-accept。checkpoint live+revert 下它们已是「live 写 + 可撤」,`propose_*` 成误名。**记为命名债 + follow-up rename**——不在设计阶段做这种触及五处的机械改名,实施波次统一改（连同 allowlists/manifest/bootstrap/测试计数）。
- `author_question` 今天走 `draft_status='draft'` + question_draft proposal + 人审 accept→promote。checkpoint 下题直接 live（draft→active 或直接 active）进 PR、可整撤;`draft_status`「accept 前不可见」是 checkpoint 前身,实施时复用或退役（收口项）。

## 5. 诚实标天花板（成本买不动的有效性边界）

1. **mimo 长程连贯性**: copilot 跑 mimo-v2.5 非 Claude（`registry.ts:493`）。无限轮买不来连贯——endurance 基建 ≠ endurance 质量,模型本身漂移是天花板。
2. **通用原语放大注入面**: 五防注入从锦上添花变承重墙（dispatch 范围由 prompt/意图决定）。
3. **worker 面 copilotTools 只半接线**（已知 half-wired gap——worker 仍靠 bootstrap 全量注册,manifest 贡献制未覆盖 worker 进程）。durable copilot job 跑在 worker 里、要全套 copilotTools surface,worker 注册必须先补全,否则桥过去工具够不着——**endurance 第 2 层的硬前置,且 durable-run 双重承重**。
4. **sync/async 阈值**: 切错（短活误判长程）= 平白多一次 job 往返延迟;阈值要按真实 timeout 分布调,非拍脑袋。
5. **reply_delta 体量**: token 级 delta 落 job_events = 高写入 + 表膨胀,可能盖过 ingestion。**真分叉**:批量写(每 N token/200ms)或只持久化粗 `step`、细 delta in-request best-effort(重连重放 step 不重放每 token)。prune cron 在(`handlers.ts:75`),但量级要重估。
6. **打断要 cancellation-aware**: cancel 卡在 Agent SDK 子进程里的 job,handler 须在回合间查 abort 协作停,不白给。

## 6. 与 ADR / doc 的关系

- ADR-0039 单编排者 + A/B/C 出手强度表: reach 的两形态 + 三 flavor 落在「单编排者」之下;直接结构化写多为 A 档（自动+撤销），fanout-生成依可逆性分 A/B。
- checkpoint 草稿层（write-safety 腿）: §2.4 单 applier choke point = checkpoint 戳事件的唯一点;§4 是两腿的接缝。
- ADR-0031/0032: author_question/propose_question_edit 现状路径 = §2.2/§2.3 的实证样本。
- 三腿待一起 ADR 化（copilot 真正全能 = reach + endurance + checkpoint）。

## 7. 状态 / 待续

模型收敛:reach=生成型(run_task dispatcher)/结构型(typed apply) 双汇单 applier;endurance=短 inline/长 durable job/summarize-continue,durable-run 形态已 grounded 落 §3.4(run handle=checkpoint_id、复用 job_events 进度流、run card、interrupt/queue 串行化);checkpoint 在单 applier 点戳事件。**三腿已 ADR 化 → ADR-0041（决策方向 ratified）**。实施细节 deferred(不阻 ADR):intentSchema/prepare 契约的 registry 落地形、worker copilotTools 接线补全前置、reply_delta 持久化粒度分叉(§5.5)、sync/async 阈值实测——见 ADR-0041「实施细节 deferred」节。
