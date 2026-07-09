# YUK-575 — copilot 默认即 agent（durable-by-default；本 lane = PR1 机制，PR2 翻默认）

**Status**: DRAFT v2 — owner 拍板重构后重写，等 coordinator 新对抗面板判词。判词前零测试零生产代码。
**Supersedes**: 本文 v1「显式后台跑 chip / opt-in durable」框架（已随 owner 判词作废，见 §0）。v1 的后端正确性 mustFix（MF1/MF2/S6/S9）+ durable 桥/SSE 路由/幂等分析 **carry-forward**（§7）。
**Lane**: H（独立 worktree，branch `yuk-575-copilot-durable-revival`）。**Base**：已 FF 到 `origin/main`（`cf1ae85d`，含 YUK-576）。
**撞车**: Lane I（YUK-577，proactive-open）同期动 CopilotDock；真共享面 = `ChatMessage` interface + 消息渲染循环（非 dwell）。

---

## 0. Owner 判词与重构（2026-07-07）

v1 把 OQ-6「后台跑 chip」递 owner，owner 推翻整个 opt-in 框架：

> 「以目标来讲毫无疑问这应该是默认。而且也不是『后台跑』，而是类似现在 agent（比如 Claude Code）的感觉。」

**新方向**：长时程 agent 是 copilot 的**默认姿态**，不是手动开关。说一句 → 当真 agent 干到完成（多轮 / 用工具 / works-until-done）→ 旁边实时看着它工作。**删掉「后台跑」toggle/chip 入口整个框架。**

**关键纠偏（v1 面板与我都踩错的前提）**：durable 预算是**上限不是预留**。两轮答完的问题就花两轮，只有真长任务吃长预算——跟 Claude Code 不为「你好」预留半小时一样。故「默认开」对短问话近乎零额外成本，v1 面板「怕烧钱所以要 opt-in」的论据不成立。

---

## 0.6 v2 对抗面板判词 folded — PR1 scope（2026-07-07，5 席 Opus，全 code-ground）

**总判：架构 (a) durable-from-the-start airtight（fork 不重开）；修完 4 MF 再实施。** 全部判词已逐条对代码核实（anchor 全过）。

### A2 PR 拆分 —— **本 lane 只交 PR1**
- **PR1（机制、非默认，本单）**：N2 流式 delta→job_events + N3 共享装配器 + budgetOverride（双天花板）+ carry-forward mustFix，**全藏在既有 durable opt-in flag（`api/chat.ts:64 parsed.durable`）后，默认仍走 inline**。PR1 证：byte-parity 回复 + 全 history + delta 流 + 重连 + **埋点延迟**（本地 burn-in 测量）。opt-in flag 复用为 OQ-F force-durable 逃生阀。
- **PR2（= YUK-596，blocked-by YUK-575，不在本 lane）**：flip default + N4 dock 202 分支 + stop 按钮 + poll 调优，用 PR1 的延迟数据做 go/no-go。

### 4 MUST-FIX（进实施前折进本 doc，已 code-verify）
- **MF-A 双天花板**（verified `budgets.ts:40` maxToolCalls=10 surface-keyed:82-97；durable+inline 同 surface='copilot'）：抬 `maxIterations` 而不抬 durable 的 tool-call ceiling 是死的——YUK-458 propose 流每 proposal ~2-4 次 tool call，10 在 ~7-10 回合就 soft-stop，真正 binding 是 10 不是 20-30 iterations。**修**：`DurableBudgetOverride` 一个对象带三旋钮 `{maxIterations, maxToolCalls(抬到~40-60), timeoutMs}`；inline fallback 保 `maxToolCalls=10`、bounded<100s。`copilot_run.ts:206-207` 原注释已预告此坑。**§6.3 明写两天花板联合数值（proposed，见 §6.3；exact number flagged for coordinator）。**
- **MF-B pickup-time 装配且排除本 run 自己的 user_ask**（verified inline `chat.ts:764-800` read-before-write 排除、`getRecentCopilotTurns(turns.ts:203-271)` 无 exclude cursor）：durable dispatch（`api/chat.ts:79`）先写 user_ask、worker 稍后拾取 → handler-time 装配把当前 ask 当最新 user 轮**双记 + 挤掉最老真轮**，durable-default 下腐蚀每回合。**修**：`getRecentCopilotTurns` 加 `excludeEventId` 参、handler 传 run_id；history/learner-state/proposal_feedback 一律 **pickup 重读**（不在 dispatch 侧冻结——§9 边跑打字入队 + batchSize:1 串行下冻结会丢前一轮 reply）。durable DB 测：非空 session 入一轮，断言 assembled history 不含当前 ask 且不丢最老真轮。
- **MF-C worker-liveness 兜底**（verified `runtime-env.ts:30-33` 零 liveness、`boss.send` 只 INSERT）：durable-default 下 worker 挂/crash-loop/漏 RW_WORKER → 每回合入队无人拾取 → dock 只见 QUEUED 永不 STARTED → 静默无限 spinner，**严格差于今天单回合报错**。**修**：enqueue→pickup 超时兜底（N 秒无 STARTED → 强制-inline 重试 or surface 可操作 error）；§4 措辞改诚实（该守卫只挡测试环境、不检测 worker 健康）。**（PR1 里 durable 是 opt-in，此兜底是 PR1 的机制正确性一部分，PR2 flip 才成主路依赖。）**
- **MF-D flip⇄N4 原子**（verified `CopilotDock.tsx:370-416`：拿 202 对 JSON body 跑 parseSseStream→无帧→finalReply=null→411-415「请求失败」）：flip 先于 N4 = 每个 free-form chat 回合直接报错。**修**：flip 藏反向 force-inline 旗标后默认仍 inline 直到 N4 落地，或同 PR 原子发布。**→ 全落 PR2；PR1 只需确保机制藏 opt-in flag 后、默认 inline 不受影响。**§12.3 承认 flip 正确性强依赖 N4。

### 6 SHOULD + 4 采纳备选（折进对应节）
- **A1 共享装配器**（= OQ-D，正确性强制非口味）：`assembleCopilotRunInput(db,{sessionId,userMessage,ambient,now,excludeUserAskEventId})` —— 5 条防循环不变量 + 当前-ask 排除 + learner-state header(YUK-574) + proposal_feedback digest + ambient 折叠的**单一执行点**。inline 改调它（省 exclude，仍 read-before-write）；durable 传 `excludeEventId=run_id`、pickup 时解析保 learner-state 新鲜。→ §5/§7。
- **S4 ambient 必须 ride job payload**：inline runInput（`chat.ts:1101-1122`）含 ambient，durable payload（`api/chat.ts:94-100`+`CopilotRunJobData:64-78`）零 ambient，ambient request-only 从不 persisted → widen `CopilotRunJobData` + `boss.send` payload 收 ambient。→ §5 N3。
- **S2 budgetOverride 是 net-new 且落 N2 run-fn**：runner 只有 provider/model ctx 覆盖（:536），budget 读 `def.budget`（maxIterations:466 / timeout:575|1164）。三旋钮一个 `DurableBudgetOverride` 到 buildQueryOptions maxTurns + streamTaskCollecting abort timer(1164) + ContextBudgetTracker maxToolCalls(MF-A)。断言 `timeoutMs < STUCK_RUN_THRESHOLD_MS(=3_600_000)`。→ §6.3。
- **S3 delta FIFO + terminal 前 drain**：streamTaskCollecting onDelta 同步(:1152)、writeJobEvent 异步自增 id；fire-and-forget → delta 无 FIFO、terminal 可能拿更低 id → 重放乱序。照 inline 的 promise chain(`api/chat.ts:145-148`)：delta 写维护 chain、terminal 前 await 排空。测断言 job_events id 单调、delta 严格早于 REPLY/DONE。→ §5 N2。
- **S5 §6.1 据 landed 结论纠偏**（verified `registry.ts:523-528`）：in-repo 权威注释说的是「GLM-5.2+10-turn 试过并 REVERTED；propose 失败是 **endurance gap**；durable 是 dead code」——即 landed 结论 = **endurance-gap / provider-agnostic**，「mimo 多步写不收敛」是**未确认假设**，v2 §6.1 把它抬成硬事实是错的。→ §6.1 改述、§6.3④ 监控改 disambiguate（ceiling 太低 vs 模型 loop vs tool 500ing）。
- **S1 「0.5s poll」非免费**（verified `register-capability-jobs.ts:57` 对 manifest job 硬编 `{pollingIntervalSeconds:2}`，copilot_run 走这条；echo 的 0.5s 是 handlers.ts bespoke）：要 0.5s 须给 JobDecl schema 加可选 `pollingIntervalSeconds` + 注册器透传，或挪 bespoke。**OQ-A 延迟论据据真实 ~2s poll 重算**；poll 调优本身落 PR2。→ §3.3 / touch 清单。
- **S6 串行语义 + stop 非纯 UI**（verified `hasCancelRequest` 只在 handler 入口查一次 `copilot_run.ts:130/155-177`，无 in-loop cancel）：batchSize:1 使 copilot_run 串行——follow-up 在长 run 期间入队会等到当前 run 结束（可达 ceiling），§9 文档化。stop 要 in-loop cancel（最省 = 扩 `budgetTracker.beforeExecute:227` 每次工具前查 DB cancel_requested 并 abort）——**落 PR2**（stop 是 PR2）。summarize-continue 保持 deferred。→ §9。
- **A3 OQ-A 本地测量（替代 staging 硬闸）**：拾取延迟由 poll + DB 往返主导、与 tunnel 无关；dev-local 已 spawn 真 worker（compose PG:5433）+ opt-in flag → 本地跑 ~30 真 chat 轮测 enqueue→pickup / enqueue→首delta 的 p50/p95；prod-only 变量 = cloudflared tunnel RTT，单独经 `GET /api/health` 测常量；prod 首字节估 = 本地首delta + 1×tunnel-RTT。**落进 PR1 埋点，commit 前完成。** → §3.3 / §13。
- **A4 durable 正当性论据迁移**：§3.2 加「rejected: keepalive-heartbeat-only」（keepalive 心跳能击穿 idle-100s 墙解 property 3，但解不了 property 4 重连 + 跨 API deploy 持久性）——durable forcing function 从「可被 keepalive 击穿的 100s 墙」迁到 **property 4（重连）+ owner 手感命令**；裁决 (a) 不变，防 re-litigation。→ §3.2/§3.4。

### 3 拒绝（存档）
- 拒「inline fallback 客户端不可达」框架（部分误伤）：inline fallback 返 200 SSE（`api/chat.ts:177`）正是 dock 今天唯一可消费路径；真正未处理的只有 202 durable=N4（已并入 MF-D）。
- 拒以 keepalive 重开 (b)：fork 拒 (b) 有多条独立腿，只做 A4 论据迁移。
- 拒 summarize-continue 入本单：自动续跑正在 loop 的 mimo run = YUK-458 收敛坑加倍。stop 只做 in-loop cancel（PR2）。

---

## 1. Grounded 现状（code + Linear 双 ground，全 code anchor 过一遍）

| 事实 | 锚 | 对本设计的意义 |
| --- | --- | --- |
| durable 桥后端完整 | `copilot_run.ts` handler + `chat.ts:63` durable 分流 + `copilot-run-status.ts` 派生 | 机制在，重用；只是入口/预算/进度呈现要改 |
| 泛化 SSE 消费路由已 ship | `observability/api/job-events.ts` `GET /api/jobs/[kind]/[id]/events`，`copilot_run` 已在 allowlist | dock 消费端复用，勿另建（YUK-310） |
| **inline copilot 靠事件重建会话，非 SDK session** | `runCopilotChatImpl`（chat.ts:713）→ `streamTaskCollecting`（runner.ts:1148）；`conversation_history` 由 `turns.ts` 从 `copilot_user_ask`+`copilot_reply` domain event 重建、作 runInput 传入；SDK `persistSession:false` 每 call 无状态 | **决定架构岔路**：跨 turn 连续性不依赖 SDK session → durable 面自带全历史（只要 handler 组装 runInput），无需跨进程 resume |
| delta 粒度已是 per-message-chunk（非 token 级） | `streamTaskCollecting` onDelta「one call per assistant-message text chunk，includePartialMessages 未设」（runner.ts:1116-1118） | (a) 的 job_events 写入量天然有界（chunk 级非 token 级）——化解 ADR-0041 §5.5「token 级高写入」担忧 |
| **cloudflared 是 IDLE ~100s 断连**（非总时长） | `agent-run-error.ts:48-51`「10s+90s=100s，aligned with cloudflared edge idle-disconnect」+ `docs/design/2026-07-07-yuk576-registry-honesty.md:228`「边缘**空闲**断连 ~100s」（docker-compose.yml:132-137） | 连续吐字节的 SSE 能撑过 100s；**危险是无字节的 idle gap**（工具执行 / 长思考）。多工具 agent turn 必有 gap → 长 turn 同步流物理留不住 → 必 durable |
| **prod app / worker 是分离容器** | docker-compose.yml app(:21) + worker(:62) 各自 `command: node dist/*.cjs`；Dockerfile WORKDIR `/app` | 即便 cwd 同为 `/app`，**分离容器 = 分离文件系统**（无共享 `~/.claude` volume）→ app 写的 SDK session `.jsonl` 不在 worker 文件系统上 → **跨进程 session resume 在 prod 物理不可能** |
| pg-boss 拾取延迟可调 | `boss.work(name,{pollingIntervalSeconds})`；echo 队列已用 **0.5s**（handlers.ts:59），prod 默认 2s；client.ts:14 `newJobCheckIntervalSeconds` per-worker | (a) 的拾取延迟地板不是固定 2s，可为 copilot_run 调到 ~0.5s |
| durable budget 已被 YUK-576 显式化 | `TaskBudget={maxIterations,transientRetries,timeout}`；CopilotTask `{maxIterations:6,timeout:60_000}`；queue retryLimit:2/delay:30s/backoff | budget 抬升的落点已 ground（§6） |
| YUK-458：mimo 多步写不收敛 | Linear YUK-458（Done）：6 too tight、6→10 **仍败**、GLM 换成 inline-abort「同一个病」；根因 = **endurance 缺口（inline 窗口）非 budget**；「mimo 在多步写编排上弱」；「若 mimo 真 loop，只是延后失败+多花 token」 | budget reconcile 的硬约束（§6）：durable 除掉 inline-abort 失效模式，但不治 mimo 收敛；ceiling 抬高不得回归收敛坑 |

---

## 2. 需求：copilot 默认即 agent

「零开关、感觉不到、就是它在干活」拆成四条可验证属性：
1. **默认 works-until-done**：每个 chat 回合当真 agent 跑（多轮 + 用工具），不被 6 轮 / 60s / 100s 掐。
2. **实时可看**：旁边流式看它工作（delta + 工具步进），与今天内联流式手感等价或更好。
3. **跨 100s 墙无缝**：跑过 cloudflared idle-100s 墙的回合物理上留不住同步流 → 必须后台 durable，且用户感觉不到切换。
4. **可重连**：关页 / 刷新 / 回来 → 进度重放重建（同步内联流做不到）。

属性 3+4 = 透明升级——正是 v1 面板作为「v1 太重」推掉那块；owner 设成默认把它拉回来。

---

## 3. 核心架构岔路 — grounded 裁决：**(a) durable-from-the-start**

### 3.1 两方案
- **(a) durable-from-the-start**：每个 copilot 回合直接是 pg-boss job，dock 恒订阅 job_events SSE。会话从头就在 job 里 → 无 handoff、无跨进程 session resume。短回合 job 秒完、SSE 秒回显得内联；长回合 SSE 持续推进度、可重连。
- **(b) inline-then-transparent-handoff**：短回合内联 `streamTaskCollecting`（如今天、首字节最快），回合逼近 100s 时中途无缝转 durable 继续。

### 3.2 裁决 = (a)，六条 grounded 理由

1. **prod 拓扑令 (b)-via-resume 物理不可能**：app + worker 分离容器（docker-compose:21/62），无共享 `~/.claude` volume → app 写的 SDK session `.jsonl`（`~/.claude/projects/<cwd>/<id>.jsonl`）不在 worker 文件系统上。即便 cwd 同为 `/app` 也无用（分离 FS）。
2. **SDK 官方明确不建议跨进程 resume**（document-specialist 查官方 sessions doc）：session 文件 cwd-keyed 且 machine-local，SDK team 对 API→worker split 的推荐 robust pattern **就是「worker owns the whole conversation」= (a)**；「don't rely on session resume, pass results into a fresh prompt」。
3. **mid-query 内部态不在事件日志**：app 从 `copilot_user_ask`/`copilot_reply` 事件重建 conversation_history，但**进行中那次 query 的工具循环内部态**（中间 tool result / 半程推理）是 SDK 进程内态、未 evented。(b) 的 mid-turn handoff 要么丢这半程态（= turn-1 从头重跑，浪费 + 用户看到停顿/重启），要么靠 SDK resume（见 1/2 不可行）。
4. **(a) 零 session 机器**：会话历史事件重建 → worker 起一个带全 conversation_history 的 fresh run **就是整个回合**，无 handoff 无 resume。
5. **(a) 成本有界可调**：拾取延迟地板 = pollingIntervalSeconds。**⚠️ S1 纠偏**：copilot_run 是 manifest job（`manifest.ts:52 queue:'agent'`），走 `register-capability-jobs.ts:57` 硬编的 `{pollingIntervalSeconds:2}` → **实际 ~2s 不是 0.5s**（echo/ocr 的 0.5s 是 `handlers.ts` bespoke 另一路）。要 0.5s 须给 JobDecl schema 加可选 `pollingIntervalSeconds` + 注册器透传（或挪 bespoke）——**poll 调优本身落 PR2**，PR1 按真实 ~2s 埋点重算 OQ-A。delta 写入量粗（per-message-chunk 非 token 级，includePartialMessages 未设）→ 每回合 job_events 行数量级几十~几百，非上千（prune_job_events housekeeping 已在）。
6. **(a) 天然可重连**：job_events + Last-Event-ID 重放（属性 4 免费）。

**rejected: keepalive-heartbeat-only（A4，存档防 re-litigation）** —— 有人会问「既然危险是 idle-100s 墙，SSE 每 <100s 发个 keepalive 心跳撑住内联流不就免 durable 了？」。承认 keepalive 心跳**能击穿 idle-100s 墙、解 property 3**（跨墙无缝）——但**解不了 property 4（关页/刷新重连）与跨 API deploy 持久性**：内联 SSE 是进程内内存流，客户端断开或 app 重启即全丢，无重放。owner 的「像 agent 一样」命令 + property 4 是 durable 的真 forcing function（非可被 keepalive 击穿的 100s 墙）。裁决 (a) 不因 keepalive 动摇。

### 3.3 (a) 的命门（诚实）+ de-risk（A3 本地测量替代 staging 硬闸）
**每回合首字节 = enqueue + 拾取(~2s 真实 poll，S1) + SDK 首 token**，vs 内联的 SDK 首 token 直出。对「works-until-done 的 agent」，秒级启动 + 立刻的乐观「思考中」态可接受（Claude Code 本身也有启动延迟）。**关键：delta 粒度与今天内联同为 per-message-chunk（streamTaskCollecting 也不设 includePartialMessages）→ 流式手感零回归**，唯一差别是 ~2s 拾取 + SSE 间接。

**A3 —— OQ-A 从 staging 硬闸降为本地测量（可在 PR1 commit 前完成）**：拾取延迟由 `pollingIntervalSeconds` + DB 往返主导、**与 tunnel 无关**；dev-local 已 spawn 真 worker（compose PG:5433）+ 既有 opt-in flag（`parsed.durable` 今天就能从 client 触发）→ **本地跑约 30 真 durable chat 轮，测 enqueue→pickup / enqueue→首delta 的 p50/p95**，落进 PR1 埋点。prod-only 变量仅 cloudflared tunnel RTT，单独经 `GET /api/health` 测常量；**prod 首字节估值 = 本地首delta + 1×tunnel-RTT**。若本地 p95 明显超预期（如 pickup ≫2s），PR2 poll 调优（0.5s）是已知杠杆。de-risk：① dock 乐观 UI（立刻渲染用户消息 + 思考态，不等 202）；② opt-in 生产 burn-in（PR1 ship 后先 opt-in 用一阵再 PR2 翻默认）。

### 3.4 (b) 拒因（存档防 re-litigation）
跨进程/跨容器 resume 脆弱（SDK 官方劝退）+ prod 物理不可能；mid-query 态未 evented → handoff 退化为 turn-1 重跑（浪费 + 可见停顿，UX 差于 (a) 的 ~0.5s）；维护内联 + durable 两条会分叉的码路；且 100s 墙无论如何都逼长回合走 durable，(b) 只是在「本就要 (a) 的机器」上再叠一层脆弱 handoff。**rejected：inline→durable 超时自动升级**——真续跑 = 跨进程 session resume（见上不可行），廉价版全 turn-1 重启比显式更差。

---

## 4. 数据流（PR1 = 机制藏 opt-in flag 后，默认仍 inline；PR2 才翻默认）

**PR1（本 lane）**：durable 路只在 `parsed.durable===true` 时走（既有 opt-in flag，`api/chat.ts:64`），默认仍 inline。下图是 durable 路被 opt-in 触发时的机制（PR1 要证 byte-parity + 全 history + delta 流 + 重连 + 埋延迟）。**PR2** 才把默认从 inline 翻成 durable（N4 dock 202 分支 + stop + poll，MF-D 原子）。

```
durable 路（PR1 经 opt-in flag 触发；PR2 后成默认）：
POST /api/copilot/chat { user_message, triggered_by:'chat', durable:true }
  → writeCopilotUserAsk（= run_id = checkpoint_id）→ writeJobEvent queued → boss.send('copilot_run', {…, ambient})  ← S4 ambient ride payload
  → 202 { run_id, session_id }
  → (PR2 N4) dock 乐观渲染用户消息 + 思考态 → 立即 apiFetch GET /api/jobs/copilot_run/{run_id}/events（SSE）
  → worker 拾取(~2s poll) → assembleCopilotRunInput(db,{sessionId,userMessage:pickup 重读,ambient,now,excludeUserAskEventId:run_id})  ← A1/MF-B
       组装 conversation_history(不含当前 ask) + learner-state header(YUK-574) + proposal_feedback + ambient
  → streamTaskCollecting(CopilotTask, runInput, budgetOverride=DurableBudgetOverride, onDelta)：  ← N2/MF-A
       每 assistant chunk → writeJobEvent(delta)（FIFO promise-chain，terminal 前 drain，S3）；工具步 → writeJobEvent(step)
       → writeCopilotReply domain event → writeJobEvent(reply/done)
  → (PR2 N4) dock 消费 delta/step/reply/done → 实时渲染 + 终稿回填；关页刷新 → Last-Event-ID 重放重建

inline 路（PR1 默认；PR2 后仅 worker-down/测试环境 fallback）：
  → 内联 streamTaskCollecting（如今天，200 SSE，bounded < cloudflared 100s；maxToolCalls 保 10）——快路径不删（Product 纪律）
```

**MF-C 诚实措辞**：`shouldEnqueueBackgroundJobs()`（`runtime-env.ts:30-33`）**只挡测试环境（NODE_ENV==='test'||VITEST），零 worker-liveness 检测**；`boss.send` 只 INSERT job 行，无论有无 worker 消费都成功。故 PR2 翻默认后，worker 挂/crash-loop/漏 `RW_WORKER` → 每回合入队后无人拾取 → dock 只见 QUEUED 永不 STARTED = **静默全量停摆**（严格差于今天单回合报错）。**兜底（机制正确性，PR1 就位）**：enqueue→pickup 超时（N 秒无 STARTED job_event → 强制-inline 重试 or surface 可操作 error），见 §5 N6。

**dispatch 翻转（PR2）**：从「inline 除非 durable:true」翻成「durable 除非不能（测试环境 → inline fallback + MF-C worker-down 兜底）」。`durable` opt-in flag **PR1 保留为 client-触发 burn-in 入口 + PR2 后的 force-durable / 反向 force-inline 逃生阀**（OQ-F）。

---

## 5. net-new 工作，按 PR1 / PR2 拆（A2）

**PR1（本 lane，机制藏 opt-in flag 后，默认 inline 不受影响）**：

| # | 工作 | 现状 gap | 说明 |
| --- | --- | --- | --- |
| N2 | **durable handler 流式 delta 进 job_events** | handler 用 `runAgentTask`（非流式，只 STARTED/REPLY/DONE） | 换 `streamTaskCollecting`（复用其 onDelta seam）→ 每 chunk `writeJobEvent(delta)`；工具步 `writeJobEvent(step)`。**S3**：delta 写维护 promise chain（FIFO），terminal REPLY/DONE 前 await 排空（onDelta 同步 `runner.ts:1152`、writeJobEvent 异步自增 id，fire-and-forget 会乱序）。 |
| N3 | **durable handler 经共享装配器组装全 runInput** | handler 只投 `{run_id,session_id,user_message,triggered_by}`，**零 conversation_history / ambient / proposal_feedback / learner-state header** | 见 A1 装配器。**MF-B**：pickup 时重读（不在 dispatch 冻结）+ 排除本 run 自己的 user_ask。**S4**：ambient request-only、从不 persisted → 必须 ride job payload（widen `CopilotRunJobData` + `boss.send`）。 |
| N5 | **budget reconcile（DurableBudgetOverride 三旋钮）** | runner 只有 provider/model ctx 覆盖，budget 读 `def.budget` | 见 §6.3 + MF-A。 |
| N6 | **enqueue→pickup 超时兜底（MF-C）** | `shouldEnqueueBackgroundJobs` 零 worker-liveness，`boss.send` 只 INSERT | N 秒内无 `copilot_run.started` job_event → 强制-inline 重试 or surface 可操作 error（防 worker-down 静默停摆）。PR1 就位机制正确性；PR2 翻默认才成主路依赖。 |
| N7 | **carry-forward mustFix（§7）** | — | MF1/MF2 分诊 + 幂等 guard + S6 static 约束 + S9 注释，(a)/(b) 皆需，framework-independent。 |

**A1 共享纯装配器（PR1 正确性核心，= OQ-D 从口味题升为强制题；placement/签名 coordinator 定稿 2026-07-07）**：
```ts
// src/capabilities/copilot/server/copilot-run-input.ts
assembleCopilotRunInput(db, {
  sessionId: string,
  userMessage: string,
  triggeredBy: 'chat' | 'chip',
  chipKind?: string,
  ambient?: AmbientContext,
  now: Date,
  excludeUserAskEventId?: string,   // durable pickup 传 run_id；inline 省略（靠既有 read-before-write 结构性排除）
}, deps?): Promise<CopilotRunInput>  // 返回 chat.ts:1101-1122 逐字节形状：{surface,triggered_by,user_message,chip_kind?,proposal_feedback,conversation_history,ambient_context?}
```
- **组装逻辑单一执行点**：resolve learner-state 一次（header + proposal_feedback digest）→ `getRecentCopilotTurns(db,{limit,now,excludeEventId})` → `assembleConversationHistory`（history budget + pinned header）→ 返回上述形状。`deps?` 注入缝（`resolveLearnerStateHeaderFn` / `loadHistoryFn`）保 chat.unit.test 既有注入存活。
- **⚠️ exclusion 边界（coordinator 裁决）**：**inline 保持 read-before-write，不切显式 exclude**。inline `runCopilotChatImpl` **在写 ask 之前**调装配器（省略 `excludeUserAskEventId`）→ 可观测行为与今天逐字节相同（PR1 = inline byte-parity 合同），只是组装逻辑改路由到共享函数。durable handler pickup 时调装配器传 `excludeUserAskEventId=run_id`（dispatch 已先写 ask，pickup 时它已在 history 里，必须 exclude）。**exclusion 机制不同 ≠ drift**——是对两种真实不同时序（inline read-before-write vs durable dispatch-写-then-pickup）的正确最小适配；A1 要防的 drift 在组装逻辑层（已被共享函数消除）。单路径 exclusion 对称性是干净 follow-up（或 YUK-596 durable 成默认时自然合并），不进 PR1。
- **`getRecentCopilotTurns`（`turns.ts:203`）加 `excludeEventId?` 参**——今天签名 `{limit,now}` 无 exclude cursor（MF-B verified）；给 param 写清文档（durable pickup 传 ask event id；inline 省略）。

**PR2（= YUK-596，blocked-by YUK-575，用 PR1 延迟数据 go/no-go）**：
| # | 工作 | 说明 |
| --- | --- | --- |
| N1 | dispatch 翻转 durable-default | teaching(skill_context) 仍强制 inline（`chat.ts:54-62` C3）；chip 轻活仍 inline |
| N4 | dock 恒消费 job_events SSE + 乐观 UI（202 分支） | MF-D：与 flip 原子（`CopilotDock.tsx:370-416` 拿 202 会落「请求失败」，flip 先于 N4 = 生产 chat 全断） |
| N8 | stop 按钮 + in-loop cancel（S6，§9） | poll 调优（S1 0.5s，改 JobDecl schema + 注册器透传） |

---

## 6. Budget reconcile with YUK-458（durable-by-default 的核心，面板必打）

### 6.1 YUK-458 landed 结论（S5 纠偏：据 in-repo 权威注释，非抬假设为事实）

**权威源 = `registry.ts:523-528` 的 landed 注释**（比 Linear 讨论更权威，是代码里的定论）：「GLM-5.2 + 10-turn 试过并 **REVERTED**；copilot propose 失败是 **endurance gap**（durable run 是 dead code，长 run 死在 inline 请求窗口）；**NOT a model-strength problem**——慢模型只是把 error_max_turns 变成 inline-request abort」。

- **landed 根因 = endurance-gap / provider-agnostic**（inline 请求窗口），GLM 已回退。
- **试过的档**：6（mimo，`error_max_turns`）、6→10（仍败）、10（GLM-5.2，变 inline-abort）。timeout 60→120s。
- **⚠️ S5 关键纠偏**：v2 前稿把「**mimo 多步写不收敛**」当硬事实——这是**未确认假设**，不是 landed 结论。landed 注释明说根因是 endurance-gap 且非模型强度问题。若真因是 tool-failure retry + inline 窗口，则 **durable + 健康 DB 下 mimo 或能收敛**——高 `error_max_turns` 率更可能是「ceiling 太低」→ 该 RAISE，而非「模型 loop」→ 该 CAP。二者对策相反，故绝不能预设 mimo 弱。
- **lasting rule（YUK-575 #4）**：ceiling 抬高的安全性依赖「移除 endurance-gap」这个 landed 根因（durable 做到了）；单在 inline 面抬 turn 是已知 regression（换汤不换药）。

### 6.2 durable-by-default 下的推理（据 landed 根因）
- **durable 除掉 landed 根因**（inline-window abort）——长/慢 run 不再死在请求窗口。**故 ceiling 可以抬**（这一步据 landed 结论安全）。
- **收敛性是开放实证问题**（非预设 mimo 弱）：durable + 健康 DB 下，多步 propose 流可能收敛（若原因是 endurance-gap），也可能 loop（若模型确实弱）——**这要靠 §6.3④ 的 disambiguation 监控在真数据里判**，不预设。
- **ceiling 是 SAFETY cap 非 target**：能收敛的任务 2-5 轮就停，高 ceiling 对它们「免费」（预算=上限非预留，owner 纠偏成立）；只有收敛不了的任务才把 ceiling 跑满，用 wall-clock timeout 封浪费上限。

### 6.3 裁决（budget shape + MF-A 双天花板 + 数值 + 护栏）
- **shape**：**registry 默认 bounded（inline fallback 安全）+ durable 面 per-call `DurableBudgetOverride` 覆盖**。内联 fallback 跑同步路由、受 cloudflared idle-100s 约束，CopilotTask registry `timeout` 必须留 ~90s（<100s）；durable 面经 override 抬。**替代（拒）**：直接抬 `CopilotTask.budget` 默认 → 会让 inline fallback 也试图跑超 100s 撞墙。narrow override 保 fallback 安全。
- **⚠️ MF-A 双天花板（verified `budgets.ts:40` maxToolCalls=10 surface-keyed:82-97）**：抬 `maxIterations` 而不抬 tool-call ceiling 是**死的**——durable 与 inline 同 `surface='copilot'`（`copilot_run.ts:208/227` ContextBudgetTracker），共用 `COPILOT_CONTEXT_BUDGET.maxToolCalls=10`；YUK-458 propose 流每 proposal ~2-4 次 tool call，10 在 ~7-10 回合就 soft-stop，**真正 binding 是 10 不是 20-30 iterations**。故 `DurableBudgetOverride` 必须**三旋钮联合**：
  ```ts
  interface DurableBudgetOverride {
    maxIterations: number;   // → SDK maxTurns（buildQueryOptions:466）
    maxToolCalls: number;    // → durable ContextBudgetTracker 覆盖（MF-A；inline 保 10）
    timeoutMs: number;       // → streamTaskCollecting abort timer（runner.ts:1164）；断言 < STUCK_RUN_THRESHOLD_MS(3_600_000)
  }
  ```
  `copilot_run.ts:206-207` 原注释已预告此坑（「若实测 endurance 多回合需要更高 ceiling，后续 lane 调专属 durable 预算」）。
- **数值（coordinator 定稿 2026-07-07）**：`maxIterations: 24` + `maxToolCalls: 60` + `timeoutMs: 12*60_000`（12min）。
  - `maxToolCalls: 60` 论据：MF-A 全意义 = 让 iterations 成真正 binding，别让 tool-call 天花板意外先撞。propose 流 ~2-4 tool-call/round：24 轮在 tool-heavy 端（3/round）= 72 tool-call，50 会在 ~16-17 轮先撞、把 iterations 24 变死（正是 MF-A 要消灭的失效模式重演）；60 覆盖 24 轮 × 2.5/round 均值，把「谁先 bind」推回 iterations 侧；tool-heavy 极端由 12min timeout 终极兜底。
  - `timeoutMs 12min`：远 < EXPIRE_AGENT 2h，且 **< STUCK_RUN_THRESHOLD_MS 1h**（S6 承重约束）。三个都是 `DurableBudgetOverride` 常量，burn-in 后好调。**安全帽不是目标**——健康流靠模型返回 final reply 自然收，天花板只挡病态 loop。
- **护栏（不回归收敛坑）**：① ceiling 是 cap 非 target；② **summarize-continue 保持 deferred**（绝不自动续跑正在 loop 的 run = 收敛坑加倍）；③ `AI_PROVIDER_OVERRIDE=anthropic-sub`（Opus）lane 已在，供硬任务判别实验；④ **⚠️ S5 监控改 disambiguate**——durable run 频繁打满 ceiling **不能直接判「模型 loop」**，要三分：**(i) ceiling 太低**（每回合都在推进但回合不够 → RAISE）vs **(ii) 模型 loop**（重复同类 tool call 无进展 → CAP / 换 orchestrator）vs **(iii) tool 500ing**（工具反复失败重试 → 修工具）。监控埋点须能区分三者（如 tool-call 去重率 + 每回合是否有新 propose/read），非只数 error_max_turns。
- **诚实天花板**：durable ceiling 解「不被掐死 + 看得见」，**收敛质量是开放实证问题**（S5：不预设 mimo 弱，靠监控判）——若真弱，那是模型能力、基建买不来（Opus lane 兜硬任务）。

---

## 7. Carry-forward：后端正确性 mustFix（v1 面板已裁，框架无关，逐条保留）

这些是 durable 机制的正确性，**不 re-derive**：

- **⚠️ 失败模型 = single-shot（Fix 2，PR1 独立 Opus 对抗 review 后 coordinator 2026-07-07 裁定，取代 v1/v2 的 MF1/MF2 transient 分诊）**：durable copilot 用 `streamTaskCollecting`（N2 需要它流式 delta），而 `streamTaskCollecting` **graceful-degrades**——run 失败在内部 throw plain `Error`、被它自己 catch、resolve 成 `{partial:true, error}`，**从不把 `AgentRunError` throw 给 caller**（runner.ts:1297/1308 throw plain Error → 1374+ catch resolve partial）。故 `isTransientAgentFailure(plainError)` 恒 false，transient/redeliver 分诊在生产**不可达**。**关键一致性事实**：inline copilot **也**用 `streamTaskCollecting`、**从来没有** transient 自动重试（一直 graceful-degrade 成 partial reply）→ durable single-shot **匹配 inline，不是回归**。故 handler 对任何失败一律 `handleDurableFailure` → 写 terminal `FAILED(reason='exhausted')` + phantom-preventing `copilot_reply`（partial 有文本则持久化半程文本）+ **return（不 throw、pg-boss 不 redeliver）**。**保留且可达**：exhausted-terminal + phantom-reply + `reason='exhausted'` replay skip-guard（兜「写完 terminal 后 worker 崩溃在 pg-boss commit 前」的 EXPIRE_AGENT redeliver，不重烧 12-min run；因所有失败现都写 `reason='exhausted'`，此 guard 现覆盖 100% 失败 redeliver）。**删除（生产不可达 + no-fake-completion 纪律）**：`RETRYING` event/derive + `transient_exhausted` + `JOB_RETRY_LIMIT` 计数 + 2 个注入 `AgentRunError` 形状的 transient 测试。
  - **限定（critic pre-existing note）**：「durable 失败不 throw」指 **run 失败**（`streamTaskCollecting` 的 `{partial}` 或 SDK-run 期 throw，都进 `try`→`handleDurableFailure`→return）。**不覆盖** `try` **之前**的 infra throw（MCP mount / `resolveCopilotSkills` / `assembleCopilotRunInput`）——它们传出 `runCopilotRun` → pg-boss redeliver（STARTED 已写、无 terminal FAILED）。这是 pre-YUK-575 就有的 infra/config edge（assembler 内部对读失败已 degrade 不 throw；MCP mount/skills 与 inline 同结构），不在 single-shot 契约内，本 PR 不改。
  - **Fix 1（真 transient 自动重试）= YUK-596 显式 scope 腿**：把 `AgentFailureSubtype` 穿过 `StreamCollectResult` 让 durable partial 路按 subtype 分类 + pg-boss redeliver——那是更重的 runner 契约变更（`streamTaskCollecting` 被 inline 共享），在 YUK-596（durable 成默认、每回合都 durable、single-shot 失败才真正 load-bearing）才有正当性，**不塞进 PR1**（违 byte-parity + PR1/PR2 拆分的全部理由）。
  - **MINOR(4)（PR1 可接受，记此）**：exhausted-terminal 路径先写 FAILED job_event 再 best-effort 写 phantom-reply；若崩在两写之间，skip-guard 靠 FAILED 兜「不重烧」（首要），phantom-reply 缺失只在这一 sub-ms crash-window 残留（次要，与 DONE 路径对 crash-between 的既有容忍同构）。
- **S6**：durable wall-clock timeout 承重约束 `< STUCK_RUN_THRESHOLD_MS(1h)`，否则 stuck-in-running sweeper 误收敛 live run；更新 `ai_task_run_reconcile.ts` 注释（最大有效 timeout 从 300s→durable ceiling，margin 重算）；加 static 约束断言。
- **S9**：零新登记面（复用已 ship 的 `/api/jobs/[kind]/[id]/events`）；chat.ts route-literal 注释更正（`/api/copilot/runs/...`→`/api/jobs/copilot_run/...`）。

> 注意：single-shot 下 durable 失败（含 mimo 打满 ceiling 的 `error_max_turns`）都走 exhausted-terminal——其 phantom-reply（防 conversation_history phantom）+ 不 redeliver（不重烧 12-min run）语义是主力失败态的正确性核心。

---

## 8. 进度组件（S5，carry-forward + 重构）

- **同一 in-chat 组件 = YUK-310 将来原地丰富的 general tracker card**（加 ToolUseCard + status pill + cost/latency ribbon），**不另建 RunCard**（by-construction 让 owner「别建两个」；同钉 YUK-575+YUK-310）。
- **live 进度二元起步**（S2）：STEP/delta 驱动「运行中 + 流式文本」；6-态 `deriveCopilotRunStatus` 留 reopen/terminal replay。**N2 的 delta 事件让 live 进度不再是二元冻结**（v1 因 STEP-never-emit 才退二元）——default-durable 下 handler 主动 emit delta，进度是真实流式。
- **消费传输层 `event: error` 帧**（job-events.ts:155，区别业务 failed）→ error 态，别静默吞。
- **可重连**：完成态经 `copilot_reply` domain event replay 免费可见；in-flight 刷新 → Last-Event-ID 重放（default-durable 下这是主力路径，值得做扎实，非 v1 的可选 polish）。

---

## 9. Interrupt / cancel / 串行（S6；stop 落 PR2）

- n=1 单会话 + `batchSize:1` → 天然单线程一次一 run（ADR-0041）。**S6 串行语义文档化**：copilot_run `batchSize:1` 使 run 串行——follow-up 在长 run 期间入队会**等到当前 run 结束**（可达 ceiling ~12-15min）才拾取。边跑打字 → 入队下一 checkpoint（等当前 run 完）。
- **⚠️ S6 stop 非纯 UI（verified `hasCancelRequest` 只在 handler 入口查一次 `copilot_run.ts:130/155-177`）**：现有 `hasCancelRequest` **无 in-loop cancel** → 对进行中 run 按 stop **打不断当前 SDK loop**（只在下一 run 启动前生效）。真 stop 要 in-loop cancel——最省 = 扩 `budgetTracker.beforeExecute`（`copilot_run.ts:227`，已 per-tool-call）每次工具调用前查 DB `cancel_requested` 并 abort。**这落 PR2（N8）**——PR1 不引 stop UI，只文档化机制缺口。
- summarize-continue 保持 deferred（拒：自动续跑正在 loop 的 run = 收敛坑加倍）。live-steer defer。

---

## 10. 与 YUK-310 / YUK-594 边界
- **YUK-310**：消费其已 ship 的泛化 SSE 路由；general tracker card 全量（ToolUseCard 全解剖）+ `ai_task_run` 家族 + one-shot 快照仍归它。本单做最小 in-chat 进度（YUK-310 原地丰富的前身）。
- **YUK-594**（judge durable lane，Backlog）**依赖本单的 durable 基建**——(a) 把 durable 做成 copilot 默认主路，YUK-594 复用同套 pg-boss + job_events + SSE 给 vision judge 脱离 cloudflared 墙。设计时保持 durable 机制通用（不 copilot-锁死），利 YUK-594 复用。

---

## 11. 开放问题 — 面板判词已裁（2026-07-07 v2 panel）
- **OQ-A（拾取延迟）** — ✅ A3：staging 硬闸降为**本地测量**（dev-local 真 worker ~30 轮 p50/p95 + `/api/health` tunnel RTT 常量），落 PR1 埋点，commit 前完成。真实 poll ~2s（S1，非 0.5s）。
- **OQ-B（budget 数值）** — ⏳ proposed maxIterations 20-30 / maxToolCalls 40-60 / timeout 12-15min，**架构级数值回传 coordinator 定稿**（§6.3）。
- **OQ-C（budget shape）** — ✅ registry 默认 bounded + durable `DurableBudgetOverride` 覆盖；拒直接抬 registry 默认（撞 inline-fallback 100s 墙）。
- **OQ-D（runInput 装配）** — ✅ A1：抽共享纯装配器 `assembleCopilotRunInput`（正确性强制，非口味）。
- **OQ-E（delta 写入量）** — ✅ per-message-chunk（非 token 级）每回合几十~百行，接受；节流留 follow-up 若实测过量。
- **OQ-F（force-inline 逃生阀）** — ✅ 既有 `durable` opt-in flag 复用为 force-durable（PR1 burn-in）+ 反向 force-inline（PR2 后）。
- **OQ-G（停止按钮）** — ✅ S6：stop 要 in-loop cancel，落 **PR2（N8）**；PR1 只文档化 §9。

---

## 12. UI design pre-flight（CLAUDE.md 硬纪律；owner 签字前 UI 零代码）

**重构**：入口不再是 chip，而是「默认就这样」——pre-flight 材料改成「**默认 agent 姿态的进度呈现**」。

### 12.1 ① 逐字引用 design doc
- **进度呈现（COVERED）** `docs/design/2026-06-28-form-axis-A3-handoff.md`：
  - L121：「**durable 异步态** | `durable:true` 走后台 job | 返回 202 不开流；对话需呈现「这条在后台跑，回头看结果」的态（durable 形态当前**前端无承载**，见缺口）。」
  - L265：「**durable 异步态的前端承载**…需建 durable run 状态的对话侧消费（读 `job_events` `copilot_run` → 在对话流呈现进行中 / 完成）。」
  - L7：「复用 Copilot Drawer 既有 chat token（`.copilot-loom` / `.msg` / `.chip` / `.copilot-hero`），不引入新视觉系统」。
- **works-until-done / 默认 agent 姿态**：A3 未逐字 spec「默认 agent」措辞（A3 早于 owner 判词）——诚实声明**无逐字覆盖段落**，这是 owner 2026-07-07 判词的新姿态；进度呈现套 A3 L121/L265/L7，但「默认长跑 + 流式看它工作」的呈现形态（工具步 chips？思考态？）待 owner UI pre-flight 定。
- **run card 概念（背景）** reach-endurance §3.4 L88（run card 概念，全量卡 = YUK-310）。

### 12.2 ② 组件类型
既有 `CopilotDrawer` 内局部增补：进度呈现 = chat-stream 里 durable-run **消息态**（复用 `.msg`/`.copilot-loom` + 流式文本 + 工具步进），**非独立 RunCard**（YUK-310）。**无 chip 入口**（入口=默认）。

### 12.3 ③ touch 文件

**⚠️ MF-D：UI（dock 202 消费）全落 PR2，且与 flip 原子**（verified `CopilotDock.tsx:370-416`：拿 202 对 JSON body 跑 parseSseStream→无帧→finalReply=null→411-415「请求失败」）。flip 先于 N4 dock consumer = 每个 free-form chat 回合直接报错。**故 PR1 零 UI 代码改动**——PR1 机制全藏 opt-in flag 后，dock 消费端（N4）+ flip（N1）+ stop（N8）打包 PR2 原子发布。**本 lane（PR1）不进 UI pre-flight**——UI 属 PR2。

**PR2 UI touch（供全景，非本 lane）**：
| 文件 | 修改 | 内容 |
| --- | --- | --- |
| `CopilotDock.tsx` | PR2 | `send` 认 202→乐观渲染→`subscribeDurableRun`（apiFetch GET jobs SSE + 复用 parseSseStream + 处理 `event:error` 帧）；durable-run 消息态渲染。真共享面 = ChatMessage interface(~112-134) + 渲染循环(~716-805)，Lane I 后合者 rebase |
| `replay.ts` | PR2 | reopen 认 in-flight durable run → pending/流式态 |
| `web/src/globals.css`（**非** `app/globals.css`） | PR2 可能 | 工具步 chips / 流式态微调，复用既有 token（A3 L7） |

**PR1 后端 touch（本 lane，不含 UI）**：
| 文件 | 内容 |
| --- | --- |
| `src/capabilities/copilot/server/copilot-run-input.ts`（新，或并入 chat.ts） | **A1 共享装配器** `assembleCopilotRunInput`（N3） |
| `src/capabilities/copilot/server/chat.ts` | inline `runCopilotChatImpl` 改调共享装配器；durable 分流 `boss.send` payload widen 收 ambient（S4）；route-literal 注释更正（S9） |
| `src/capabilities/copilot/server/turns.ts` | `getRecentCopilotTurns` 加 `excludeEventId` 参（MF-B） |
| `src/server/boss/handlers/copilot_run.ts` | 换 `streamTaskCollecting`（N2）+ delta/step→writeJobEvent（FIFO chain，S3）+ `DurableBudgetOverride`（N5/MF-A）+ 调共享装配器（N3）+ MF1/MF2 分诊 + guard + pickup 兜底触发点（N6）+ 注释更新 |
| `src/server/ai/runner.ts` | `DurableBudgetOverride` seam（maxTurns:466 + streamTaskCollecting timer:1164 + ctx 透传）（N5/S2） |
| `src/capabilities/copilot/server/copilot-run-status.ts` | `RETRYING` event + derive case（MF2） |
| `src/capabilities/copilot/api/chat.ts` | N6 pickup 超时兜底 + MF-C 诚实措辞 + `CopilotRunJobData` widen ambient（S4） |
| `src/server/boss/handlers/ai_task_run_reconcile.ts` | S6 注释（最大有效 timeout→durable ceiling，margin 重算）+ static 约束断言点 |
| `register-capability-jobs.ts` | **仅注记**：0.5s poll 需 JobDecl schema 加 `pollingIntervalSeconds` + 透传（**S1，落 PR2**，PR1 按 ~2s 埋点，不改此文件） |

---

## 13. Phase 2 — PR1 TDD 计划（RED-first）

**PR1 scope**：机制藏 opt-in flag 后，默认 inline 不受影响。**零 UI 代码**（UI = PR2）。证 byte-parity + 全 history + delta 流 + 重连 + 埋延迟。

1. 确认在 `origin/main`（已 FF `cf1ae85d`）。branch `yuk-575-durable-lane-revival`。
2. **TDD RED（关键测，每条 MF/S 直接派生）**：
   - **① 共享装配器 durable DB 测（MF-B）**：非空 session 已有一轮真对话，durable 入新一轮 → 断言 `assembleCopilotRunInput(…,{excludeUserAskEventId:run_id})` assembled history **不含当前 ask 事件**、**不丢最老真轮**、learner-state header(YUK-574) + proposal_feedback 在场。
   - **② byte-parity 装配测**：同 session 同输入下，inline 路（省 exclude，read-before-write）与 durable 路（exclude=run_id）assembled runInput 等价（防 A1 重构漂移）。
   - **③ budget ceiling 测（S2/MF-A）**：durable run 经 `DurableBudgetOverride` → runner built maxTurns == ceiling maxIterations、abort timer == timeoutMs、ContextBudgetTracker maxToolCalls == override；inline fallback 仍 `maxTurns=6/timeout<100s/maxToolCalls=10`（byte-identical）。static 断言 `timeoutMs < STUCK_RUN_THRESHOLD_MS`。
   - **④ job_events FIFO/单调测（S3）**：durable handler 流式跑 → 断言 job_events id 严格单调、所有 `delta` 事件 id **严格早于** `reply`/`done`（promise-chain drain 生效）。
   - **⑤ ambient payload 往返测（S4）**：`boss.send` payload + `CopilotRunJobData` 携带 ambient → handler 装配 runInput 时 ambient 不丢。
   - **⑥ pickup-timeout 兜底测（MF-C/N6）**：enqueue 后无 worker（no STARTED job_event within N s）→ 兜底触发（强制-inline 重试 or 可操作 error），不留无限 QUEUED。
   - **⑦ carry-forward（N7）**：MF1 分诊（`isTransientAgentFailure` 分桶）、MF2 幂等（RETRYING 非终态 + exhausted guard + transient_exhausted→DLQ）、derive RETRYING→running。
3. GREEN 后端实现（全 PR1 backend，零 UI）。
4. 全 gate（`typecheck` / `lint` / `audit:schema` / `audit:partition` / `audit:profile` / `audit:draft-status` / `audit:draft-status-reads` / `test` / `build`）。
5. **本地延迟 burn-in（A3）**：dev-local 真 worker + opt-in flag 跑 ~30 durable 轮，测 enqueue→pickup / enqueue→首delta p50/p95 + `/api/health` tunnel RTT 常量，落进 PR 描述（PR2 go/no-go 依据）。
6. 独立 Opus 对抗审（子代理带 Bash 取 diff）。
7. 逐文件 `git add`（绝不 -A；node_modules symlink 核实不在 diff）→ commit（`YUK-575`；PR1 **不** `Closes`——YUK-575 待 PR2 才闭）→ push → 开 PR（**open，绝不自 merge**）→ 回传 coordinator。

---

## 附：grounding provenance（v2 新增）
- inline copilot 路径：`chat.ts` runCopilotChatImpl:713 / streamTaskCollecting runner.ts:1148-（delta 粒度 1116-1118）
- 会话重建：`turns.ts` + `conversation.ts` findOrCreateCopilotConversation:159 + learner-state.ts（YUK-574）
- cloudflared idle-100s：agent-run-error.ts:48-51 + yuk576-registry-honesty.md:228 + docker-compose.yml:132-137
- prod 容器分离：docker-compose.yml app:21 / worker:62 + Dockerfile WORKDIR:8
- pg-boss poll：handlers.ts:59（echo 0.5s）+ client.ts:14（newJobCheckIntervalSeconds）
- SDK session：官方 sessions doc（document-specialist scout）——跨进程 resume cwd-keyed + machine-local，官方劝退，推荐 worker-owns-conversation
- YUK-458：Linear（6/10/GLM 实验链 + mimo 多步写不收敛 + 根因 endurance 缺口 + ceiling 不得回归收敛坑）
- durable 桥/SSE/幂等：v1 draft grounding（copilot_run.ts / job-events.ts / registry.ts / queue-config.ts / agent-run-error.ts，全 carry-forward）
