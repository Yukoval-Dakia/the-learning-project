# Copilot 兜底、复核与学习者数据审计

审计日期：2026-10-07。来源是用户对聊天审核、刚发送就出现不明确状态，以及学习者分析是否兑现的追问。

## 版本与证据

- 审计固定基线：`df08399ff179c5882b39da87e162237fd18246c7`，与构建树 `733e2485238dc7363cbce970da120f6712207376` 相同。下文源码行号以该构建树为准，另行标注候选改动。
- 审计期间 PR1594 已发布。最新 source `6e54da8dfb371887e5d6cd4076d1ff9cd7713beb`，build `765c61f2642c22ce2ed437bfc4260b738e474971`，镜像 `sha256:fd8c046b97fee59eab03e62151a26e700d290f51a82c070b04878d478324fe76`。父线程只读核验了更新后的 `current-release.json`，锁已释放；环境仍为 `agent-development-test`，`personalDailyUse=false`。
- 源码差异已核对：本次发布补 Hono LISTEN 启停，没有修改本文的 Copilot finalizer、正式评估或记忆机制。旧版本 10 秒 batching 已修，最新 provider 429 阻断真实正文/取消验收，YUK-1365 仍未完成全项验收。
- 本地 YUK-1367：`tlp-yuk-1367-structured-practice`，HEAD `2cc8e6e80be1b76639dec50e653fdc16dfc983d3` 加未提交的出题修改。其新增正式题目解题复核也纳入审计，不算已发布机制。
- 此轮只读调查源代码与已有证据，没有运行服务、操作队列、调用产品模型或修改线上数据。本文不是对所有任务和学科实际输出质量的验收。

## 刚发送时的状态从哪里来

普通发送路径会把传输状态写成 AI 回复正文：

1. `CopilotDock.tsx:1252-1287` 保存待受理请求，并在发 POST 前调用 `projectPendingCopilotMessagePair`。
2. `message-projection.ts:118-124` 创建 `role: 'ai'` 的消息，正文固定为“正在确认这次请求是否已受理。”。请求结果未知或恢复时 `dispatching=false`，正文改为“受理状态暂时无法确认。”。
3. 收到 202 后，`CopilotDock.tsx:904-909,1331-1340` 先创建 queued 状态，正文换成“正在等待处理这次请求。”。running 时换成“正在处理你的请求，结果会在这里显示。”。
4. `message-projection.ts:75-76` 在真实 `replyText` 为空时继续使用这些占位文字。它们没有经过模型，也不代表模型对用户意图的判断。
5. 正文之外又有独立状态栏。`CopilotDock.tsx:137-163,1674-1698` 显示准备、生成或证据审阅；“证据审阅”由 step/subtask 的 label 关键词正则推测，仍有独立的展示层语义猜测。

“受理未知”和“任务仍在排队”是两条不同路径。前者处理 POST 202 的结果未知；后者来自浏览器没有及时收到 worker 事件。不能把这两者都归因于模型慢。

### 已有真实浏览器记录

`/tmp/yuk1365-acceptance/browser-learning-before-listener.json` 的 `value.changes` 保存了真实页面变化。以首次受理占位的采样时间为零：

| 相对时间 | 页面变化 |
| --- | --- |
| 0 ms | AI 气泡出现“正在确认这次请求是否已受理。” |
| 35 ms | 气泡变为“正在等待处理这次请求。”，另有“准备中…” |
| 10,032 ms | 出现“任务还在等待开始，可能正在排队…”，并要求重新连接 |
| 10,764 ms | 重连后显示“正在处理你的请求，结果会在这里显示。” |
| 20,775 ms | 页面首次记录到本轮模型正文 |
| 40,788 ms | 本轮完整正文出现，状态栏消失 |

这些是页面采样时间，不是网络、首 token 或模型推理耗时。

旧基线 `server/index.ts:136-144` 没有调用 `startListenLoop`。worker 写入数据库并 NOTIFY，但 API 没有将通知接到进程内 SSE router。`src/capabilities/observability/api/job-events.ts:9,175-198` 的 10 秒 catch-up 成为实际推送路径。与此同时，`durable-pickup.ts:23,77-81` 的 10 秒未拾取检测、`subtask-events.ts:543-555` 的订阅中止先触发，`CopilotDock.tsx:114-117` 就展示排队推测。

YUK-1365 的旧版真实你好记录另证实数据库 delta 早于模型结束和 done；它不能证明浏览器已经逐段及时收到文字。

14:10Z 后重新读取最新 `deployment-yuk1365-listener-765c61f26/evidence/sse-timing.json`：queued 0.101 秒、dispatched 0.102 秒、started 0.833 秒、execution_started 0.917 秒、failed 3.534 秒。五个事件从 DB 到 HTTP 的延迟为 2.7–14.7 ms。监听补线已真实生效，不再把旧缺陷报告为现状。

本次模型因 `429 Go usage limit exceeded` 失败，供应商要求等待 1951 秒；发布 lane 观察到 UI 却显示“这次回复没有完成可验证的收口，暂不展示未封存的草稿。请重试。”。这段来自 `reply-finalization.ts:27` 的固定失败文案，不是聊天学习内容审核复活。当前缺陷是丢失了真实失败归因。没有为审计重新请求模型、重放新增 memory DLQ 或改变 runtime。

### 展示层机制清单

这些机制都不额外调用 AI。

| 机制 | 触发与结果 | 源码 |
| --- | --- | --- |
| 受理占位写进回复 | 每次正常发送就创建 AI 正文；异常受理结果又替换成不明确文案 | `src/capabilities/copilot/ui/message-projection.ts:106-126`；`CopilotDock.tsx:1341-1385` |
| queued/running/stop 的正文兜底 | 没有真实文字时用固定句子占据 AI 气泡 | `CopilotDock.tsx:898-917,1046-1057`；`message-projection.ts:61-90` |
| 进度标签的语义正则 | label 命中证据、审阅、验证、review 等词就显示“证据审阅中” | `CopilotDock.tsx:137-163` |
| 10 秒拾取判断 | 没收到 worker-touch 事件便中止订阅并提示可能排队；不检查此刻服务端真实状态 | `durable-pickup.ts:23-81`；`subtask-events.ts:543-555` |
| SSE 自动重连 | 默认最多重连 3 次，空闲窗口 45 秒，线性退避基数 500 ms；失败后暴露手动重连 | `subtask-events.ts:477-610`；`CopilotDock.tsx:943-981` |
| durable catch-up | 每 10 秒补读数据库，事件 ID 去重；733 版曾承担全部实时传递，6e54 版已恢复通知驱动 | `src/capabilities/observability/api/job-events.ts:150-198` |
| 正文终态替换 | done 以 `reply_md` 替换临时 delta；缺正文时显示“这次请求已结束，但回复暂时不可用。” | `message-projection.ts:66-90,211-225` |
| 工具/子任务终态兜底 | lost 显示结果未知，其他失败显示稍后再试；运行中的工具行在父终态被收口 | `CopilotDock.tsx:192-207`；`message-projection.ts:28-34,46-57` |
| learner brief 整段隐藏 | 命中内部 ID 正则，或拉丁字符数大于 `max(24, 汉字数×2)`，整段不显示；不评判学习意义 | `src/capabilities/copilot/ui/learner-global-brief.ts:1-9` |
| Coach 缺计划的假定 | 缺 `daily_focus` 就说“昨晚 Coach 还没出新计划，先按你昨天排的复习队列开始即可”，没有检查昨日队列 | `src/server/today/copilot-summary.ts:75,184-197` |
| 提案内容改为类别模板 | Dreaming 预览只按 kind 显示“有一项…建议待你查看”，不展示该建议实际摘要 | `src/server/today/copilot-summary.ts:77-102,218-223` |
| 固定在线徽标 | 无连接健康判断，始终显示在线 | `CopilotDock.tsx:1829-1832` |

应先修正正常路径上的伪回复、按标签猜阶段和无依据的计划建议。受理恢复、事件重放、取消和终态处理仍需保留其确定性语义，不能靠删报错文字掩盖故障。跟进：[YUK-1368](https://linear.app/yukoval-studios/issue/YUK-1368/copilot-状态展示受理占位冒充-ai-回复缺失数据被补成事实)。

## AI 执行与工具机制

路径缩写：`C`＝`src/capabilities/copilot/`，`A`＝`src/server/ai/`，`K`＝`src/kernel/tools/`。以下以 733e24852 固定行号；最新 listener 发布没有修改这些主体。`execution_trace_bound` 只说明轨迹与最终字节绑定，不说明答案事实正确。“新增调用”不包含普通主任务本身。

**429 → finalizer → 错误正文的完整链：**

| 步骤／拥有位置 | 实际效果 |
|---|---|
| `A/pi-agent-adapter.ts:682` | Pi assistant 的 `stopReason=error` 转成 `error_during_execution`，保留 `errorMessage`；不是成功 terminal，也不产生回答 `result` |
| `A/runner.ts:687`；`A/agent-run-error.ts:95` | 抛出带 subtype、taskRunId、errors 的 `AgentRunError`；原 provider 文本仍在 error message 中 |
| `A/runner.ts:1302` | attempt失败成功落库后返回 `partial=true, error=原错误, text=已收集草稿`，**失败返回没有 `terminalText` 字段** |
| `C/server/copilot-execution.ts:472,482` | 将缺失的 `terminalText` 转为 `''`，仍调用 `finalizeTerminal('')` |
| `C/server/reply-finalization.ts:361,453` | 空正文被拒绝；catch丢掉拒绝原因，统一生成“这次回复没有完成可验证的收口，暂不展示未封存的草稿。请重试。”；不接收 provider 错误类别 |
| `C/jobs/copilot_run.ts:1016` | partial分支把原错误放入 `err`，却把 **finalizer替代文案**放入 `partialText` |
| `C/jobs/copilot_run.ts:1235` | 非空 `partialText` 优先成为持久化 `reply_md`；原错误进入 `durable_failure.error`，reason统一为 `exhausted` |
| `C/jobs/copilot_run.ts:533,403` | 同一marker投影成FAILED，包含替代 `reply_md` 与原始 `error`；恢复只重投影，不重新调用模型 |

这条路径新增模型调用 **0**。它也意味着普通非resume partial路径即使有真实半程草稿，终稿仍会被固定封存文案替代。resume partial另在 `copilot-execution.ts:476` 抛错，可能进入另一段通用预算提示。

还有一处分类漂移：`agent-run-error.ts:174` 只把 `api_error_result` 的429认作transient；当前Pi将provider错误归为 `error_during_execution`，该类别判永久。文件开头“API失败不会进入该类别”的说明来自旧SDK探针，已不能代表Pi路径。Copilot collecting本来就没有应用层重试循环，因此这不是要求重试该限额错误。owner看到的 `retry1951s` 未在这些层成为结构化retry-after字段，也不能据此声称应用实际等待或重试了1951秒。

**其余最强、具体的问题证据：**

- **proposal正则改写整篇回复。** 有proposal effect contract时，全局替换 `LIGHT`、`已更新／已删除／已执行` 等短语，未限定本次proposal。例如“昨天已更新记录”也会被改写；新增模型调用0。[reply-finalization.ts:236](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/capabilities/copilot/server/reply-finalization.ts:236)
- **无正文的其它异常统一归因为预算。** 配置、启动、工具等错误也可进入“预算内没收敛，可以换个更聚焦的问法”；原错误留后台，用户解释失真。与本次429的封存文案覆盖是两条相邻的替代路径。[copilot_run.ts:1200](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/capabilities/copilot/jobs/copilot_run.ts:1200)
- **正常成功回合的撤回资格存在条件性漏洞。** 工具已执行后，`tool_use` mirror失败被吞掉；成功projection和replay却依赖mirror判断是否调用物化工具。若单次mirror失败、后续DB恢复，空记录可使checkpoint被授予。成功路径没有持久化已观察到的materializing latch。这些工具的领域行并不能由该撤回链全部补偿。静态路径，未运行复现。`A/tools/mcp-bridge.ts:629`；`C/jobs/copilot_run.ts:305`；`C/server/turns.ts:448`
- **Exa正在执行的请求未接取消signal。** `execute`不接signal，`client.callTool()`不传signal或调用级timeout；只有connect使用显式startup timeout。可阻止下一次调用，不能据此证明在途Exa立即停止。[pi-tools.ts:220](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/server/ai/tools/pi-tools.ts:220)
- **确定性澄清仍付费依赖主模型。** 服务端已生成authoritative reply后，清空工具仍调用主模型；finalizer先要求模型terminal非空，失败时已知澄清也可能被替代。`C/server/copilot-execution.ts:197,392,463`；`reply-finalization.ts:361`
- **工具完成先于持久证据。** `onToolComplete`早于log/mirror；后两者失败不影响工具结果，刷新可能丢工具卡片。finalizer receipt用内存轨迹，不证明全部工具证据成功落库。`A/tools/mcp-bridge.ts:274,554,580,629`
- **embedding的15秒timeout只覆盖取得headers。** timer在`fetch`返回后清除，随后`res.text/json`不受该timer约束。`A/embed.ts:68,85,97`

实际主链是：

`Hono auth/epoch → POST chat → 原子受理 → session FIFO/pg-boss → copilot_run → teaching或Copilot execution → Pi/tools → finalizer → outcome marker → REPLY+DONE/FAILED`。

**授权、受理与数据正确性机制：**

| 拥有位置 | 触发 → 用户结果 | 活调用者／新增调用 |
|---|---|---|
| `server/app.ts:104,139` | token缺失/不匹配→401；SHA-256定长常时比较；实际豁免health、ready | 所有API；0。此处是单用户internal-token边界，没有逐learner RBAC |
| `server/app.ts:146` | contract epoch不可运行或读取失败→503，含读取/SSE | 全API；0，阻止不兼容版本操作数据 |
| `server/app.ts:30` | CSP、HSTS、frame/object、camera/mic/geolocation限制 | HTTP响应；0；interactive所需inline/eval仍允许 |
| `server/app.ts:118,124,214,228` | 组合校验拒启；异常隐藏为通用500；success status违约→500；未知API→404 | composition root；0，防残缺面、内部泄漏、SPA假成功 |
| `server/app.ts:174`；`src/server/http/provider-session-deadline.ts:27` | 同步HTTP共享90秒绝对provider deadline，嵌套只能收紧 | Hono AI调用；0；独立worker无HTTP scope |
| `C/server/chat-contracts.ts:75` | Zod、正文4000字符、引用长度；teaching不接受correction target→400 | `api/chat.ts:196`；0，结构校验而非内容审核 |
| `C/api/chat.ts:214,229`；`C/server/durable-dispatch.ts:102,173` | 必须≤200字符Idempotency-Key；同键同输入复用、异输入409；受理不明503并要求同键重试 | POST chat；0，避免第二个付费任务 |
| `C/api/chat.ts:270,277,290`；`C/server/durable-backlog.ts:10` | queue disabled→503，不inline降级；未终态上限5→429；进程rate limit默认30次/10秒 | 新受理；0；已有handle复用先于这些门控 |
| `C/api/chat.ts:41,303` | 观察到受理前断开→499；input＋QUEUED提交后才202 | POST chat；0；受理后浏览器断开不取消worker |

**后台、修复、重试与取消机制：**

| 拥有位置 | 触发 → 用户结果 | 活调用者／新增调用 |
|---|---|---|
| `C/server/durable-dispatch.ts:208,315,385` | session lock、稳定dispatch坐标，只派最早非终态head；后续等待 | chat/终态wake/reconciler；0；FIFO等待未启动pickup timeout |
| `C/server/durable-dispatch.ts:405,428` | physical job与DISPATCHED同事务；send空返回须验证已有job输入 | head dispatch；0，防漏派发/错绑定 |
| `C/api/chat.ts:92` | legacy dispatch失败先readback；unknown保QUEUED并503；证实不存在→enqueue_failed | 历史协议恢复；0 |
| `C/jobs/copilot_run.ts:200,733,765,833` | paid gateway前写EXECUTION_STARTED；重投先找outcome，再查fence | pg-boss handler；恢复0；未知已执行不再付费 |
| `C/jobs/copilot_run.ts:418,584,774` | 已有执行者250ms等待；12分钟＋30秒后未知结果→ambiguous | 重复投递/恢复；0，延迟而不猜成功 |
| `C/jobs/copilot_run.ts:438,509,1059` | Stop/恢复/outcome共用settlement lock；先保存结果再投影终态 | worker；0，晚到结果不覆盖终态赢家 |
| `C/jobs/copilot_run.ts:334,380` | REPLY＋DONE同事务；marker修缺suffix；只有legacy FAILED(error)可重试 | worker/redelivery；0次修复模型调用 |
| `C/jobs/copilot_run.ts:977,1149` | delta/step串行写；取消或已有outcome后丢弃；终态前drain；delta写失败不阻终态 | prose/tool activity；0；DB delta可早于DONE，草稿仍可被终稿替换 |
| `C/jobs/copilot_run.ts:1016,1200,1290` | partial/finalizer拒绝永久失败；provider错误可能被封存文案覆盖；未知执行专用ambiguity正文 | worker；0，不自动重跑半程paid work |
| `C/jobs/copilot_run_reconcile.ts:19,49,84`；`C/manifest.ts:235` | 每两分钟最多20条；修marker suffix、派head、修child；queue unknown仍unknown | fast cron；零LLM，活job不凭时钟判死 |
| `C/api/cancel-run.ts:41,121,152` | dispatch→settlement锁序；启动前取消原子终态，启动后只请求取消 | Stop API；0；requested不等于已停止 |
| `C/server/copilot-run-cancellation.ts:145,172,205` | 500ms非重叠探测；确认取消才abort；DB unknown不猜取消但阻断新DomainTool | poll/Pi/Domain gates；0 |
| `C/jobs/copilot_run.ts:870` | 取消后Domain effects最多drain30秒；未完成→ambiguous | cancellation settlement；0，不假称领域写入已安全停止 |
| `C/server/materializing-tools.ts:17`；`C/jobs/copilot_run.ts:305,399` | 物化工具、teaching question、ambiguous抑制checkpoint；探测异常也抑制 | terminal/replay；0；mirror空记录漏洞见前述 |
| `C/api/revert-checkpoint.ts:27,105,121` | 当前session、合法根、已终态及影子终态；学习状态锁/cascade；不可逆/legacy/conflict/truncated拒绝 | 撤回API；0；已撤回幂等 |

**工具权限、预算与执行结果控制：**

| 拥有位置 | 触发 → 用户结果 | 活调用者／新增调用 |
|---|---|---|
| `K/allowlists.ts:146,337` | 精确surface工具集合；基础Copilot/chip不同；draft edit仅ingestion surface | execution mounts；0 |
| `A/tools/registry.ts:16`；`register-capability-tools.ts:14` | 重名、缺output schema、非read safeHandoff、manifest/export不一致拒绝注册 | API/worker startup；0，fail-fast |
| `A/pi-agent-adapter.ts:1434,1469` | 按allowedTools精确过滤；needsToolCall却无工具拒绝启动；显式空集合允许 | Pi tasks；0，防静默tool-less降级 |
| `A/tools/pi-tools.ts:122`；`mcp-bridge.ts:351,406` | JSON Schema＋Zod输入；输出schema失败变工具error，失败原始输出不直接返回 | DomainTool；0；模型可自行占用后续回合修正 |
| `C/server/copilot-execution.ts:279` | 取消→finalizer→proposal-flow→budget，再cap input | Copilot DomainTools；0，非AI复核 |
| `K/budgets.ts:44`；`context-throttle.ts:212,225` | tool warn10/hard25；nodes250/1000、rows1000/4000；cap参数、耗尽不执行并返回notice | Copilot/coach/dreaming；0；请求量计数，不是任意输出全局字节硬限 |
| `C/server/proposal-flow-gate.ts:7` | proposal失败/skipped后阻断非read；成功read解锁 | root tools；0直接调用，可增加模型读取/重规划回合 |
| `A/tools/mcp-bridge.ts:115` | propose附FULL、非直接目标写入、accept前dismiss；保留draft另声明 | proposal tools；0；dismiss不等于删除draft |
| `A/tools/mcp-bridge.ts:492,525,554,580,629` | observer/summary/log/mirror失败分层吞掉；summary替代unavailable；执行错误返回JSON error | Domain pipeline；0，持久证据不是强成功条件 |
| `A/tools/pi-tools.ts:81,186` | custom/remote不走完整Domain pipeline；remote精确名字filter、isError转异常 | KnowledgeReview/agency custom、Exa；不能继承全部Domain budget/schema/effect barrier |
| `C/server/subagents.ts:58,126`；`A/spawn-contract.ts:59,105` | default-on kill switch；researcher只读、禁生成/写/递归/background/输入改模型等 | root Task；每个前台child各可6模型回合 |
| `A/spawn-contract.ts:18`；`C/server/reply-finalization.ts:24` | spawn budget report_only；共享trace最多60次 | root＋child；六root回合/25DomainTool不是总模型调用或美元上限 |
| `C/server/subagent-mailbox.ts:309,410,479` | task_id＋objective hash幂等投影；父终态阻止晚到成功；父权威终态才修lost/cancelled | Task lifecycle/reconciler；0；用户卡片只投影状态，不展示完整prompt/报告 |

**最终回复、证据声明与内容门控：**

| 拥有位置 | 触发 → 用户结果 | 活调用者／新增调用 |
|---|---|---|
| `C/server/reply-finalization.ts:310,357,453` | 空/>64k、未闭合/无hash、trace改变统一固定封存失败正文；catch不保留具体cause | root finalizer；0；provider failure无terminal也落入此门 |
| `C/server/reply-finalization.ts:271,374` | primary view只接受成功root control；tool result同ID/name/hash且实际执行；artifact须live | finalizer；0，错误引用drop，通常不挡正文 |
| `C/server/tool-result-snapshot.ts:31,214` | 注册schema、逐工具投影/限大小、去内部状态；unsupported→unavailable，不raw fallback | tool-result presentation；0 |
| `C/server/primary-view-reference.ts:8`；`notes-integration.ts:23` | question live、artifact类型匹配且未归档 | presentation resolution；0，引用正确性 |
| `C/server/reply-finalization.ts:54` | legacy marker解析/剥除；畸形尾截断；不授展示权限 | legacy清理；0 |
| `C/server/prose-stream.ts:2,65` | 状态机删除所有HTML comments，支持跨delta；未闭合comment吞余尾 | live/terminal清理；0，非内容分类 |
| `C/server/correction-contract.ts:53,80,112` | 正则识别纠错意图；有限历史ID绑定；歧义澄清；缺/错envelope替换，合法附changed/retained/uncertain | execution/finalizer；0直接复核；澄清仍依赖主模型运行 |
| `C/server/reply-finalization.ts:191,236` | 服务端proposal disclosure＋整篇正则改写 | finalizer；0，存在过宽改写 |
| `C/server/conversation-writes.ts:128` | prepared字节/receipt digest不一致拒绝提交；commit重新封存最终字节 | reply write；0，防展示/持久化错配 |
| `C/server/reply-finalization.ts:29,33` | ephemeral_html追加随对话保存、关闭不删、目前不支持完全不保存的系统说明 | commit；0，存储事实披露 |
| `C/server/tools/query-events.ts:168,220,319` | 精确AND、cursor同filters、时间＋dispatch高水位、分页/零结果/跨subject因果边界 | event readers；0；查询正确性确定，模型遵守claim boundaries没有通用终稿裁决 |
| `C/tasks/agent.ts:68` | prompt要求遵守evidence scope、ADVISORY_ONLY/OBSERVE等 | 主模型；prompt约束，不是事实正确性验证 |
| `C/server/copilot-execution.ts:210` | ToolContext仍可调QuizVerify/SolutionGenerate/SemanticJudge/TeachingQuality，共享取消/deadline | 活消费者如 `notes/server/tools/author-artifact.ts:171`；按正式内容工具增加AI调用，非聊天统一审核 |

`execution_trace_bound` receipt只证明轨迹/字节绑定。它既不能证明答案事实正确，也不能证明工具全部落库或内部provider wire完全可见。

**共享AI runtime的兜底、重试与付费控制：**

| 拥有位置 | 触发 → 用户结果 | 活调用者／新增调用 |
|---|---|---|
| `A/providers.ts:579`；`execution-adapter.ts:209` | env chat pin→explicit→DB global/task→default；凭证/模型/旧adapter错误拒绝 | runner；0，没有一般跨provider聊天fallback |
| `A/model-profiles.ts:420` | tool/vision需求必须明确true，unknown拒绝 | lifecycle构造；付费前0 |
| `A/vision-judge-config.ts:105` | OAuth缺token、override明确无vision→取消override走标准resolution | vision/source judges；0，不保证固定降到MiMo |
| `A/run-lifecycle.ts:326`；`provider-session-admission.ts:236,1547` | 并发/start-rate、等待、lease/heartbeat、父child借slot；enforce控制面/lease异常拒绝 | 中央tasks；0；默认off、缺lane off、observe部分失败放行；线上配置未读 |
| `A/run-lifecycle.ts:414,467,562,598` | startup不发prompt；先durable run身份；成功须terminal＋CAS；settlement失败不再付费 | 所有中央runner；0 |
| `A/run-lifecycle.ts:666`；`pi-agent-adapter.ts:182` | 较早deadline＋task timeout合作abort；turn ceiling仅继续要求工具时判失败 | Pi tasks；0，不等于所有外部请求硬杀 |
| `A/pi-agent-adapter.ts:107,1009` | transport maxRetries默认2传给Pi stream | 每模型回合配置允许额外2次尝试；实际SDK wire未验证 |
| `A/run-lifecycle.ts:743,757`；`agent-run-error.ts:174` | 应用重试须opt-in、无pin、快速白名单transient、10秒内、前次失败已落库 | runTask/runAgentTask；最多配置额外attempt；Pi error类别漂移见429链 |
| `A/runner-fn.ts:15` | bound runner剥db/retry覆盖，deadline只能收紧 | capability bound calls；0 |
| `A/runner.ts:1185,1302` | collecting失败返回partial；durable/identity/admission错误直接拒绝；失败无terminalText | Copilot；0；后续finalizer覆盖失败正文 |
| `A/runner.ts:971,1093` | text stream取消abort；普通失败追加`[streamTask] error.message`；settlement失败error stream | `knowledge/server/review.ts:695`；0，与Copilot替代路径不同 |
| `A/pi-agent-adapter.ts:909` | 超context估算阈值裁旧history、保system/tools、重注入sidecar、去孤立tool result；异常保原context | Copilot compaction；0次摘要模型调用，旧history会丢失 |
| `A/direct-provider-attempt.ts:179`；`provider-attempt-decisions.ts:31` | identity、start reservation、重复/终态/未知started fences；execute一次后结算 | embedding/reconcile/ingestion直连；不自动重试；off也持久化attempt |
| `A/opaque-provider-operation.ts:183` | Mem0整体reserve；内部wire_count/费用unknown；结算失败记录但保provider结果 | Mem0 add/search/restore；不能称完整wire可见 |
| `A/typed-primitive-runner.ts:176,224,309,415` | typed input、固定provider/model、禁fallback/redirect、响应schema/model一致；累计费用＋unknown预留；settled快速transient才重试 | Jev invokers；独立费用闸，最多配置额外attempt |
| `A/attempt-cost.ts:20`；`failure-ledger.ts:6,40` | reported/estimated/unknown区分；未知不当零；旧failure零值是legacy占位 | lifecycle/agency/practice；0，不证明免费或质量 |
| `A/laminar-tracing.ts:115,135,249`；`laminar-transcript.ts:19` | tracing失败不改业务；危险全局capture拒启；development＋flag才transcript；凭证/CoT/binary脱敏限长 | runner/Pi/tool spans；0；只覆盖已知secret语法 |

**解析、正式AI复核、上下文、教学与记忆读取：**

| 拥有位置 | 触发 → 用户结果 | 活调用者／新增调用 |
|---|---|---|
| `A/json-extract.ts:173,243` | strict失败→确定性repair ladder；默认risky repair、domain可收紧；repair等级；不可修snippet±120字符 | quiz/verify/intervention等；0；repair不等于正确性复核 |
| `A/sealed-validation.ts:43,93` | valid fail立停；PASS须每个slot valid pass；invalid不能被末次洗掉；run/input/prompt/result绑定 | `practice/server/intervention-author.ts:757`；至少两次、上限由caller指定的AI复核；不接管聊天 |
| `A/selection-orchestrator.ts:149,209` | advisory memory截断/转义；未知ref丢弃、重复取首、空拒绝 | softmax-selection；失败走确定性sampler，无repair模型 |
| `A/item-prior.ts:15,44` | JSON/schema或simulation/inversion覆盖失败→该题本轮skip | item_prior_backfill；不伪造prior，parser无重试 |
| `A/solution-generate.ts:64,88,111,144` | 已有解答skip；模型/解析错误logged-skip；rubric保留、并发guard、评分依据新版发布后重新准入 | reference_answer_backfill；一次生成任务 |
| `C/server/copilot-run-input.ts:154,183`；`turns.ts:695` | pickup固定session/run因果history；仅missing anchor走legacy fallback；其它读失败header-only；learner-state失败为空 | worker；0，分析上下文可减少 |
| `K/budgets.ts:219`；`C/server/copilot-run-input.ts:96` | 最近8条turn，每条800字符，总4000，先丢旧；header计入预算 | cold/resume；0，非完整会话记忆 |
| `C/server/copilot-worker-session.ts:6`；`live-turn-context.ts:19` | 256条进程ownership/cache；foreign/evicted冷启动；resume仍有限durable replay；只保成功且发布一致cursor | execution/worker；0，失效不自动再付费 |
| `C/server/skills/teaching-skill.ts:102` | 仅当前message＋学习资料，allowedTools=[]；取消前后检查、结构解析 | worker teaching分支；一次模型任务；无会话history/memory工具/root聊天finalizer |
| `C/server/teaching/materialize-ask-check.ts:63` | structured prompt缺失用本轮text；question/reply由caller事务提交；draft/session/source_ref | ask_check；0，container-only，不直接进一般题池 |
| `C/api/accept-chip.ts:134,138,174` | session active、同session agent anchor；latent proposal_id先accept后chip event | accept-chip；0；非原子accept＋event，存在少计窗口，当前UIcaller不发proposal_id |
| `C/server/tools/memory-brief.ts:21,66` | missing/stale明确标记、24小时阈值；stale仍返回并提示核源 | query_memory_brief；0，freshness是提示而非禁用 |
| `C/server/tools/search-memory-facts.ts:25,90` | topK≤20、caller/deadline必需、起始abort、稳定opaque anchor；subject scope可能漏学习facts | memory搜索；实际内部调用归memory lane；mirror=never |
| `A/embed-source.ts:14`；`embed.ts:55,108` | 输入6000字符/批≤10；数量、index重复、1024维finite校验；错误不造向量 | entity embedding/backfill；每批一次直连；body timeout缺口见前述 |
| `C/server/nudge-config.ts:24`；`nudge-triggers.ts:69,114,137` | 零LLM触发，真实失败streak、排除纠错/不支持评估；每日软上限、dismiss fuse、KC cooldown、练习静默窗 | nudge evaluator；0 |
| `C/server/nudge-read.ts:36`；`jobs/copilot_nudge_evaluate.ts:50` | 默认shadow仍写证据不展示；过期/opened/dismissed过滤；unique幂等；malformed跳过 | GET nudges/fast job；0 |
| `C/server/turns.ts:372,620` | retract/tombstone、越窗口父撤回、不可补偿anchor抑制；repeatable-read返回turns＋active_runs | GET turns/history；0，UI状态解释由parent负责 |

部署树 `C/server/chat-contracts.ts:75`、`C/server/durable-dispatch.ts:18`、`C/api/chat.ts:315` 没有可信的单回合 `answer_only/derivation_policy` 字段。这里不能声称一句自然语言“不记忆”已获得持久派生隔离；完整 memory/outbox/学习者数据机制见下文。

**旧版移除、历史恢复与无生产调用者分别如下：**

- 旧 `f3bfff2cf:C/server/content-validation.ts:79,115,191` 用题目标签、编号问句、`求/选择/判断`、方程/表格启发式要求learning marker；缺失、畸形、题目数/子串不匹配就整篇替换“未完成独立校验”。例如“请选择哪个方案？”可触发。门控本身0次AI，但发生于已付费主答之后。
- 旧 `reply-finalization.ts:537,578,606` 拒绝remote evidence捕获失败/溢出，调用内容验证，失败再复查替代文本并drop primary view；正文缓冲至复核完成。**YUK1365已经发布删除这些聊天审核链和整篇reviewed-delta。** 正式内容工具内验证保留；本次429封存文案来自保留的结构finalizer。
- `runSolveSkill`（`C/server/skills/solve-skill.ts:73`）、`planTeachingTurn`（`teaching.ts:155`）未找到生产caller，不能算当前聊天兜底。
- `conversation-writes.ts:79` 旧 `evidenceValidation`载体保留，但无生产caller传入，不是当前独立聊天复核证据。
- 部署树无生产DomainTool声明 `safeHandoff`。`K/tool-operations.ts` 的session ownership、30秒lease/10秒heartbeat、JSON限制、取消优先级、CAS、hard deadline/lost recovery仍实现；**新Copilot工具不经这条托管分支**。boot recovery及Stop/历史记录检查仍有活caller。
- 旧mailbox/continuation由 `C/server/legacy-drain-readiness.ts:7` 在migration拒绝带未完成工作升级；不偷偷删除或重跑。
- `piQueues` steering/follow-up仅声明和透传，未找到生产caller提供队列，不能算当前运行中插入消息能力。

## 正式题目与评估机制

以下按固定源码 `733e24852` 核对。`D` 指 `tlp-yuk-1365-copilot-stream` 的该版本；`U` 指本地未发布的 `tlp-yuk-1367-structured-practice`。6e54da8df 的 listener 发布没有修改这些模块。

“AI 次数”指本机制可证明的逻辑任务调用，不包括生成题目的原始调用，也不冒称完整 provider wire 次数。

| 机制 | 触发 | 谁判断 | 额外 AI 调用 | 后果、阈值与默认值 | 文件行号、真实 caller | 状态 |
|---|---|---|---|---|---|---|
| 来源分层检查集 | 题目复核 | 规则决定检查集，各检查再用规则/模型 | 本身 0 | tier1 真实题：结构、知识命中；tier2 外部题：来源一致性、解题、去重；tier3 据材题：素材命中、解题、题型、教学质量、知识命中；tier4 生成题：grounding、copy safety、知识命中、题型、解题、教学质量。**检查集声明本身不证明所有来源走同一流水线** | D [verify-framework.ts:97](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/capabilities/practice/server/quiz/verify-framework.ts:97)；实际消费者 `jobs/quiz_verify.ts:645`、`jobs/source_verify.ts:429` | 已部署 |
| 生成题结构与可判分合同 | `quiz_gen`、`author_question` 生成后 | 规则 | 0 | 重建结构节点 ID；要求非空题干/参考答案；keyword 缺关键词、semantic 缺采分点、路线与题型不相容等拒收。模型回显知识 ID 与合法集合相交；全部幻觉 ID 时可回落到请求的合法知识集合，属于**改写归属的兜底** | D [question-author.ts:253](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/capabilities/practice/server/tools/question-author.ts:253)、`quiz_gen.ts:987`；caller `proposal-tools.ts:396` → `runQuestionAuthor`，`quiz_gen` job | 已部署 |
| 生成来源/答案锚冻结 | material author 提供原文与答案锚 | 规则，锚来自调用方 | 0 | 生成前验证 locator 对应真实字节、content hash 与字节一致；持久化 anchor/plan，再生成、绑定题目。不能验证则先拒绝，不发生成调用。结构校验不等于独立证明答案正确 | D [question-generation-grounding.ts:67](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/server/questions/question-generation-grounding.ts:67)；唯一检出的生产调用 `question-author.ts:210` → `prepareQuestionGeneration`，`:315` → bind | 已部署 |
| `runQuestionContentValidation` / `QuizVerifyTask` | tier3/4 草稿；正式教学包诊断题；结构化学习内容 | 模型；规则消费各轴 | 每题 1 | closed-book，不自行重新联网；grounding、knowledge hit、copy safety、可选 material/kind 在一次输出中判断。`release_strict` 禁止作者 gloss 自证；启发式 jsonrepair 被拒绝。普通供应允许解析修复，但 `quiz_gen` 的 jsonrepair 标记使整批不得自动晋级 | D [verify-framework.ts:209](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/capabilities/practice/server/quiz/verify-framework.ts:209)；caller `quiz_verify.ts:492`、`intervention-author.ts:419`、`learning-content-validation.ts:152` | 已部署 |
| `copy_safety` | tier3/4 `quiz_verify` | 模型 + 确定性规则，取更严格结果 | 已包含在上述 1 次 | 对来源 snippet 做 CJK-aware **3-gram Jaccard**；最大重叠 **≥0.5** 或模型 `too_close` 阻止晋级；`unknown` 同样不能晋级。无 snippet 的确定性重叠返回 0，代表没有比较信号，不能推断原创。生成者自报一律标 `agent_self`，不能伪造为 verifier 已审 | D [quiz_verify.ts:523](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/capabilities/practice/jobs/quiz_verify.ts:523)、`:133`；`question-supply/sourced-dedup.ts:20`；`quiz_gen.ts:1333`。caller `runQuizVerify` | 已部署 |
| 普通 `runSolveCheck` | tier2 或 tier3/4 要复核答案 | 独立 solver；规则归一化；必要时 SemanticJudge | **0–2**：无参考答案 0；solver 1；开放题或 exact 不匹配再 +1 | 参考答案优先 `rubric.reference_solution.final_answer/answer_equivalents`，否则使用 reference 全文、首行、首句候选。归一化匹配直接 pass；语义 `incorrect` 且 confidence **≥0.8** 才 fail。普通开放题 partial/unsupported/低置信可保守 pass；exact 未能确认等价为 unsupported。solver 失败为 unsupported。普通路径还可传腾讯原答案/分析 hint，不能称严格盲解 | D [verify-framework.ts:496](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/capabilities/practice/server/quiz/verify-framework.ts:496)、`:988`、`:1024`、`:1208`；caller `quiz_verify.ts:645`、`source_verify.ts:457` | 已部署 |
| 教学质量独立检查 | tier3/4 前置内容检查已通过 | 模型 + 每轴 veto 规则 | +1 | 清晰度、唯一答案、选择题干扰项诊断力；三个 veto 默认 true。明确 fail 留草稿待复核；普通供应的异常/缺必需轴为 unsupported，**不阻断**。选择题缺 distractor 输出会 skipped。与 solve 并行，即使 solve veto，教学检查仍运行 | D [verify-framework.ts:1341](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/capabilities/practice/server/quiz/verify-framework.ts:1341)、`:1390`；caller `quiz_verify.ts:643–703` | 已部署 |
| `quiz_verify` 最终入池门 | `quiz_gen` 草稿后台/人工重验 | 规则合取模型结果 | 每题每次最多 **4**：内容 1 + solver 1 + semantic 1 + teaching 1 | 必须 overall pass、grounding/knowledge pass、copy 已解决且不过近、material/kind 无明确 fail、solve/teaching 无 veto、未 jsonrepair。**material/kind 的 unclear 或缺字段可放过；solve/teaching unsupported 可放过**。通过 active、general_pool、初始 FSRS；失败/待复核保持 draft，同时 suspended/withheld。终态事件使重投不重复审 | D [quiz_verify.ts:549](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/capabilities/practice/jobs/quiz_verify.ts:549)、`:747`、`:970`、`:1016`；真实 job 注册 `manifest.ts:898`，handler `quiz_verify.ts:1306`；人工入口 `verify-and-promote.ts:380` | 已部署 |
| tier2 来源一致性、去重 | `web_sourced` 草稿 | 规则 + solve 模型 | solve 最多 2；其余 0 | URL/provenance/extract 必须一致；题干+参考答案对 extract 重叠 **<0.15** 拒收；与同知识点已有池题重叠 **≥0.7** 判近重。不重新抓取来源。知识点消失/归档拒晋级；exact 未解决的不一致、题图不可读留待复核。其他 solver unsupported 仍可能不阻断 | D [source_verify.ts:162](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/capabilities/practice/jobs/source_verify.ts:162)、`:244`、`:406`、`:463`、`:474`；caller source job 注册 `manifest.ts:903`，handler `source_verify.ts:995`，人工入口 `verify-and-promote.ts:377` | 已部署 |
| 图片来源独立 grounding | image-candidate 接受后，标记 `single_source_grounding`，且其他检查可晋级 | 视觉模型；规则消费 grounded | 再 +1，每次 source 验证最多 3 | 重新读来源图片，判断题面是否真在图中。无来源 asset、not_grounded 阻断；获取/模型/解析异常先 demote、suspend/withhold，再抛错等待队列重试。confidence 被保存，但最终门消费 grounded 布尔值，没有额外 confidence 阈值 | D [source_verify.ts:480](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/capabilities/practice/jobs/source_verify.ts:480)；`judge/source-grounding-verify.ts:115,150`；caller `ingestion/server/image-candidate-accept.ts:1016` enqueue source job | 已部署 |
| 人工接受 / force enable | 用户接受 question/variant proposal，或强制启用草稿 | 人；规则验结构与生命周期 | 0；variant 接受后异步 +1 | 人工接受被记录为 `verifier:human`、manual marking provenance，并可清 verify_hold、入池、初始 FSRS。force enable 跳过模型验证但必须原因留痕，不能清 retraction_hold；conversion issue 仍可使 publisher withheld | D [proposal-appliers.ts:515](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/capabilities/practice/server/proposal-appliers.ts:515)、`:285`；`verify-and-promote.ts:278`；caller manifest proposal accept `1240–1244`，API `review-draft-force-enable.ts:39` | 已部署 |
| 变式接受后 `variant_verify` | 接受错因变式 | 模型 | 每次 +1 | 接受先铸题和 admitted publication；复核 pass 保持 active，fail 使 **mistake_variant broken**，主要是错因针对性检查，不等于再次解题。enqueue 失败不回滚已接受变式；运行/解析异常抛给队列，缺少独立 system-error verify 事件 | D [variant_verify.ts:270](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/capabilities/practice/jobs/variant_verify.ts:270)、`:318`、`:378`；真实 caller `proposal-appliers.ts:344`，注册 `manifest.ts:911` | 已部署 |
| 正式教学包复核 | `prepare_intervention` 生成 immediate/delayed/transfer 诊断题 | 盲解模型 + 内容模型 + 包审模型 + 规则封存 | 每包验证最多 **11**；整 delivery 准备上限 **25** | 三题各盲解最多2次，仅完整合同 miss 可重试；各内容验证1次；包审最多2次，**两次都 valid pass 才确认 pass**，任一 fail 停止，invalid 不能靠末次 pass 洗白。绑定精确 prompt/input/output digest 和成功 run；不完整、不一致、过期权威拒发布。成功常规验证为3解题+3内容+2包审=8次 | D [intervention-author.ts:260](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/capabilities/practice/server/intervention-author.ts:260)、`:419`、`:757`；`src/core/schema/intervention.ts:21–32`、`src/server/ai/sealed-validation.ts:43`。真实 caller `agency/jobs/prepare_intervention.ts:31` | 已部署 |
| 结构化学习内容 release 门 | 结构化产物要求验证题目 | 三模型检查 + 规则 | 每题最多4 | 内容 grounding basis 必须有实际依据，solve 与 teaching 必须明确 pass；异常/unsupported 拒绝。仅绑定闭卷、无比较材料且 closed-world/学科依据时，copy unknown 可明确标 `not_observed` 后通过。**不是已移除聊天 regex 门** | D [learning-content-validation.ts:149](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/capabilities/practice/server/learning-content-validation.ts:149)、`:223`、`:244`、`:280`；真实绑定 `copilot-execution.ts:246,272`，caller `notes/server/tools/author-artifact.ts:175` | 已部署 |
| OCR 结构失败降级 | OCR 后 VLM 结构化失败 | 规则 | fallback 本身0，不自动再付费 rescue | 使用已有 OCR 结果；GLM 降级为整页 standalone、不拆子题；Tencent 使用解析结构及几何配图。缺 extraction confidence 默认 **0**，转人工复核。rescue 是显式路径，不是自动层层升级 | D [tencent_ocr_extract.ts:467](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/capabilities/ingestion/jobs/tencent_ocr_extract.ts:467)、`:528`、`:619`；caller extraction job | 已部署 |
| OCR auto-enroll 路由 | 抽取完成后 auto_enroll job | 模型提供抽取/标签，**WorkflowJudge 本身是规则** | WorkflowJudge 0；标签/实际评分另计 | enroll、observe、student grading 三开关默认 off；每 run 最多10块。`min(extraction,tagging) ≥0.85` 且有知识建议才 auto；enroll 标签由匹配/新建结果合成，不应称双独立模型置信投票。标签失败转复核。有作答的原件先保存，再要求 publication admitted、有效评分才能收录；confidence 不授予评分准入 | D [workflow-judge.ts:53](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/capabilities/ingestion/server/workflow-judge.ts:53)；`workflow-judge-config.ts:29–81`；`auto-enroll.ts:363,405,414` → `assessment-capture.ts:205` | 已部署 |
| **新增 author_question 严格解题出版** | knowledge/material author 生成后 | solver + semantic 模型，规则准入 | **新增1–2** | 新调用 `runSolveCheck(validationMode:'release_strict')`，不用腾讯答案 hint，要求完整 solver 合同。只有 verdict pass、确有 solver run、所有验证 run 都有 ID 才 admitted；fail 为 verification_failed，unsupported/无 run ID 为 unverified_rules。题与 proposal仍保存为 draft，publication 为 **container_only**。未增加 QuizVerify/TeachingQuality 检查 | U [question-author.ts:284](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1367-structured-practice/src/capabilities/practice/server/tools/question-author.ts:284)、`:306`、`:361`；caller仍为 `proposal-tools.ts` → `runQuestionAuthor` | **未发布、未提交** |
| **新增 write_quiz publication 门** | 组卷写入前 | 规则 | 0 | 锁组根再锁题，复核当前 revision：必须 admitted、未 suspended/withdrawn，子题必须在出版 parts 内。不满足则整卷拒写。允许“已验证但未进公共池”的 author draft；保存 draft 不再等于可练习 | U [write-quiz.ts:287](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1367-structured-practice/src/capabilities/practice/server/tools/write-quiz.ts:287)、`:342–369`；tool注册的既有 caller `practice/manifest.ts:1363` | **未发布、未提交** |

正式评分与学习状态还存在以下门：

| 机制 | 触发 | 谁判断 | 额外 AI 调用 | 后果、阈值与默认值 | 文件行号、真实 caller | 状态 |
|---|---|---|---|---|---|---|
| 出版合同及内容变更失效 | 新出版、编辑、准入更新 | 规则 | 0 | 校验 structure/response/scoring/execution、digest、revision与admission generation CAS。admitted 必须结构通过，存在独立验证则必须 passed；转换未解决或保留旧准入但内容变更，折叠 withheld。**独立验证允许 null，不能把 publisher 说成强制每题模型复核** | D [assessment-publication.ts:198](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/kernel/records/assessment-publication.ts:198)、`:950–973`；caller上表各 promote/accept/author路径 | 已部署 |
| 发题资格 | solo、paper、placement、probe issuance | 规则 | 0 | 未出版、挂起、撤回拒绝；container_only 必须容器引用；默认 auto_score 要求 admitted。显式 manual 可以保留手动练习，不证明AI正确性；capture_existing 保存既有原件也不是曾经准入证明 | D [assessment-issuance.ts:334](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/kernel/records/assessment-issuance.ts:334)；真实 paper caller `paper-issuance.ts:159`，placement经 `placement-assessment.ts` | 已部署 |
| 缺作答、空白、缺证据、人工执行器 | 逐 scoring unit 评分 | 规则 | 被拒单元0 | 缺槽 pending；只有明确 `blank_scores_zero=true` 才空白零分，否则 needs_review。requires evidence未覆盖、确定性比较器无法读图片均不伪造分。normalizer 默认 blank_scores_zero=true；option/numeric/text用确定性比较器，其他判据默认 **human_review** | D [evaluation.ts:675](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/core/schema/assessment/evaluation.ts:675)、`:785–828`；`assessment-normalization.ts:517,576`；caller `evaluateAttempt` → `evaluateSubmission` → core | 已部署 |
| D17模型切片准入 | model_executor单元 | 规则；质量准入需要离线实测及裁决 | 未准入0；已准入逐单元执行 | admitted_slice_id=null时 withhold/人工复核。正式准入政策要求≥30 holdout、零严重错误、可用gold时agreement≥95%、pipeline coverage≥95%、Jev覆盖≥80%；这些是切片验收要求，**运行时主要检查出版的切片ID，不是每题现场再跑30例** | D [evaluation.ts:831](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/core/schema/assessment/evaluation.ts:831)；`execution.ts:154`；`docs/planning/2026-09-24-question-assessment-decisions.md:113` | 已部署政策/守卫；具体已准入数据未查 |
| Jev适用性、阈值与重试 | 已准入且task为JevScoringDecisionTask | 规则检查，Jev输出判断 | 每单元最多 **2次Jev请求**；可选advanced另1次，但默认正式caller未装配它 | 仅文本；缺可读原材料、内联图、附件证据、非适用判据转pending。rule_reference必须显式per-slice ruleThreshold，**没有全局默认**。live `createFormalModelExecutor`只传db/deadline/signal/task ID，未传ruleThreshold或advanced；不能宣称会自动切高级模型。共同deadline90s，typed任务15s、transientRetries=1 | D [jev-model-executor.ts:347](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/server/assessment/jev-model-executor.ts:347)、`:415`；真实装配 `evaluate-submission.ts:162–195`；`tasks/jev-typed.ts:34` | 已部署 |
| Pi原生评分证据/成本门 | 明确出版AssessmentRuleJudgeTask单元 | 模型 + 规则 | 每单元1任务，task transientRetries=0 | 要求admitted slice及正数caller/出版成本cap；交集预算与deadline，缺材料pending；引用必须属于冻结槽/证据，文字quote必须来自原件；输出pending、无效、越cap不变分数。未知成本按cap预留。不是Jev的隐式fallback | D [pi-model-executor.ts:95](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/server/assessment/pi-model-executor.ts:95)、`:181`、`:218`；caller `evaluate-submission.ts:172` | 已部署 |
| 低置信/伪造引用/聚合未决 | 模型输出后 | 规则 | 0 | 可解析引用ID必须真实；伪造转needs_review。低置信门仅在caller提供threshold且计划human_review时启用，**缺省不启用**；置信不是accuracy。pending、未映射等级、无分母投影为score=null/unsupported，不填0 | D [evaluation.ts:958](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/core/schema/assessment/evaluation.ts:958)、`:981`；`evaluation-authority.ts:154–218` | 已部署 |
| 原件先存、candidate与生效分离 | 八个正式评分入口 | 规则 | commit复用已有candidate可0 | 冻结issuance/submission后才评估；非completed或unsupported保存attempt并返回review_required，不写学习态。activation重新核对精确revision、服务器admission快照、generation和head CAS；过期拒绝。advice只预览；probe有独立结果写者，不做practice学习激活 | D [attempt.ts:28](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/capabilities/practice/server/assessment/attempt.ts:28)、`:284`；`activate.ts:423`。真实caller见下段 | 已部署 |
| 防重复付费及未知结果hold | 同group/submission/attempt/unit重投 | 规则 | 同操作重复0 | claim/result独立封存；已有结果重放；claim存在但结果丢失、输入不同、封存结果无效均held，**禁止自动再dispatch**。不是把队列重投当新付费许可 | D [recorded-model-executor.ts:29](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/capabilities/practice/server/judge/recorded-model-executor.ts:29)；真实caller `createFormalModelExecutor` → recorded wrapper | 已部署 |
| FSRS与掌握度分离 | candidate有效激活后 | 规则 | 0 | 归一化分数≤0 incorrect、≥**0.85** correct、中间partial；建议again/hard/good。显式用户评级优先；assisted自动结果无用户评级不写FSRS。manual/self-report/assisted不写θ/calibration；部分、混合或无局部证据abstain；非abstain KC必须同一位才做一次θ更新。冻结发题KC范围，合成root不作内容卡；重判保护用户评级并重放历史effect | D [settlement.ts:85](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/core/schema/assessment/settlement.ts:85)、`:301–405`；`src/server/assessment/settle.ts:373–424`。caller activation → learningSettlement | 已部署 |
| 帮助污染与学习流程hold | tutor提示/参考答案、提交、placement推进 | 服务器事件规则 | 本门0 | 帮助来源冻结在submission receipt；只有明确independent才可视作未帮助，历史缺snapshot也按assisted。solve待复核不揭示参考答案；有效后揭示冻结版本。solve错题阈值另为 **0.7**，与0.85 coarse verdict不同。placement未完成settlement仍held/pending，不直接继续下一题 | D [assistance.ts:83](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/capabilities/practice/server/assessment/assistance.ts:83)；`solve-session.ts:31,338,399`；`placement-assessment.ts:91` | 已部署 |
| KT画像证据筛选 | kt_estimate_nightly | 规则/BKT算法 | 0 | 只取objective judge锚定的二元attempt/review；排除手评、FSRS评级派生和LLM judge outcome。写入soft `kt_json`。当前查询仍直接消费legacy review/attempt，未见此job接入native assessment verdict；不能把它当完整当前学习者分析 | D [kt_estimate_nightly.ts:105](/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream/src/capabilities/practice/jobs/kt_estimate_nightly.ts:105)、`:124–156`；caller nightly job | 已部署 |

八个正式入口确有生产调用，未用 registry/export 代替可达证据：

| 入口 | 实际调用位置，相对D |
|---|---|
| solo_submit | `src/capabilities/practice/api/submit.ts:329` → commitFormalAttempt |
| durable_judge_run | `src/capabilities/practice/server/assessment/durable-attempt.ts:252` → commitFormalAttempt |
| paper_submit | `src/capabilities/practice/server/assessment/paper-attempt.ts:161` → commitFormalAttempt |
| solve_tutor | `src/capabilities/practice/server/solve-session.ts:338` → commitFormalAttempt |
| ingestion_grading | `src/capabilities/ingestion/server/assessment-capture.ts:212` → commitFormalAttempt |
| advice_preview | `src/capabilities/practice/api/advice.ts:64` → previewFormalAttempt |
| conjecture_probe | `src/capabilities/agency/api/probe-answer.ts:208` → previewFormalAttempt，独立probe结果 |
| appeal_rejudge | `src/capabilities/practice/server/assessment/appeal.ts:129` → evaluateAttempt |

队列重试另算一层。源码 `D/src/server/boss/queue-config.ts:62–92` 配置重试2次、延迟30秒并backoff、耗尽进DLQ。因此单题 `quiz_verify` 可出现最多3轮、最多12个逻辑验证任务；source最多9个；variant最多3个。终态幂等会减少实际调用。这个上限不涵盖新的人工重验、跨job重复触发或数据库当前队列配置，不能报成实际线上调用数。

最重要的产品问题：

1. **“已出题、已保存卷、可练习”目前存在断层，YUK-1367正在补。**
   D `question-author.ts:283–345`只保存draft+proposal；D `write-quiz.ts:160–190`允许这些draft组卷，却没有publication gate。正式开卷 `paper-issuance.ts:138–169`又要求已出版并成功issuance。U新增审核解决这层断裂，但它本身就是新增审核候选，不能从“想清除审核”讨论中隐去。

2. **未发布候选通过解题审核，也不代表能自动评分开放题。**
   normalizer的rule_reference默认human_review。U仍写`model_slice:null`，未建立已准入模型执行计划。因此可能“严格解题通过、组卷成功”，作答后仍review_required。这是正式练习交付需要明确的能力边界。

3. **普通题库复核的通过，证据强度比记录名称弱。**
   quiz_verify允许solve/teaching unsupported晋级，却在`:973–976`写`independent_verification.passed:true`。该字段不能单独证明独立解题或教学质量实际通过。source_verify的保守unsupported及`confidence:1`汇总也不等于模型质量置信100%。

4. **grounding和copy safety的比较语料有边界。**
   普通QuizVerify closed-book，source_verify不重新获取网页；来源snippet/extract可能来自生成/抓取流水线自己的持久化声明。图片候选额外重读图片是明确增强；其他题不能被概括成“独立查证全部事实与全网原创”。

5. **学习者分析当前更可靠的是证据资格控制，而非所有内容都已能分析。**
   已实现原件守恒、帮助排除、手评不冒充掌握度、部分证据abstain、有效评分才结算。这些保护有实质作用。代价是开放题/模型未准入/待复核时，学习状态可能不推进；混合KC也不能按当前one-bit updater精细更新。KT job还显示legacy查询边界，需要单独确认native迁移后的覆盖。

## 学习者记忆、分析与实际消费者

源码中确有记忆保存、结构化学习状态和规划消费者。当前完整学习者分析的主要缺口在于来源语义、原生评估迁移后的漏接，以及一些有表有写入但没有决策消费者的能力。

| 数据 | 写入与含义 | 实际消费者 | 证据位置 |
| --- | --- | --- | --- |
| 原始聊天 event | 分别保存 user 消息和 agent 回复；恢复、重放；不是评估结论 | 当前会话历史，用户事件进入异步记忆入口 | `copilot/server/conversation-writes.ts:32` |
| LearningRecord | 记录导入/笔记/部分解题的正文、来源、KC、题目、过程、整理状态；raw/actioned 不是掌握程度 | `query_records`、record context、接受后的关联/内容提升；普通聊天没有自动转 LearningRecord 的通用链 | `src/kernel/records/queries.ts:126`；`ingestion/server/tools/query-records.ts:131` |
| 原生作答与有效评估 | 原件保存答案、过程、自信、时长、帮助信息；有效评分、来源和结算另存 | 有效评估结算更新 mastery、FSRS、到期队列与选题 | `practice/server/assessment/attempt.ts:165-218`；`src/server/assessment/settle.ts:914` |
| Mem0 定性事实 | outbox → memory_event_ingest → infer；附来源事件、scope、时间与 kind | 摘要、Copilot/Coach/Dreaming 可读工具、B3 选题的定性先验 | `src/server/memory/client.ts:336`；`triggers.ts:247` |
| MemoryBrief | PG 事件与可选 Mem0 facts，经一次 MemoryBriefTask，保存近周/近月/长期文字与 evidence IDs | 首页摘要、query_memory_brief；其他 agent 可主动读 | `src/server/memory/brief-writer.ts:97-154`；`brief.ts:107-145` |
| Copilot 自动状态快照 | 约 400 字：到期数量、首个 active goal、两个主要错因、该 goal 的 mastery/mean theta、夜间摘要；失败可返回缓存或空值 | 冷启动上下文、续聊 sidecar、compaction；深层记忆和记录通常要模型主动调工具 | `copilot/server/learner-state.ts:268,514` |
| 练习规划记忆消费 | B3 softmax_mfi 路径自动检索最多 5 条 Mem0 定性先验，给非到期候选权重和顺序建议 | lazy compose、手动 recompose、nightly compose；不由 brief 直接改 mastery | `practice/server/softmax-selection.ts:561-660`；`practice/tasks/selection-orchestrator.ts:32` |
| 初始偏好与节奏 | onboarding leanings/pace 存在 placement session | 初轮题量和选题；不写 theta/p(L)/FSRS，不等于永久画像 | `practice/api/placement-next.ts:130` |
| Conjecture 与干预 | 有效失败、错因、reasoning trace → 归纳/复核/接受/诊断 probe/预测评分，必要时准备干预 | proposal inbox、诊断题、满足条件后的 learner-visible intervention | `src/server/conjectures/reconcile.ts:514`；`agency/server/intervention/store.ts:448` |

表中省略的 capability 前缀均为 `src/capabilities/`。这些是可达源码消费者；除下文明确的历史运行证据外，没有据此宣称当前实际输出质量通过。

### 已确认的学习者分析缺口

1. **已部署版本尚无单回合“不派生”契约。** `chat-contracts.ts:75-107` 没有 derivation_policy/answer_only，`triggers.ts:247-249` 仅判断 actor 是 user。自然语言“不记住”无法通过这个 gate 可靠执行。YUK-1346 的隔离候选及其证据不能算作 6e54 已部署能力。
2. **global brief 没有保留证据身份。** `scope-tagger.ts:38-80` 先加入 global，工具事件另加 meta scope 后仍留在 global；`brief.ts:107-129` 读最近事件；`brief-writer.ts:123-140` 丢掉 actor，facts 只传 id/memory。它能总结操作活动，却没有足够输入区分学习行为、用户陈述、模型生成与运行记录。引用 ID 存在不等于某句能力推断成立。跟进 YUK-1370，相关旧审计事件成本问题仍独立保留在 YUK-1176。
3. **原生正式作答没有完整进入旧画像消费者。** 新 producer `assessment/attempt.ts:184-212` 写 experimental:assessment_attempt，outcome=null，并把 response_md 等放在 payload；学科 brief 的 `active-subjects.ts:40,374` 仍只读 attempt/review/record_capture，速度/谨慎轴 `axis-writer.ts:291-306` 和 KT `kt_estimate_nightly.ts:105-119` 仍只读旧 attempt/review。部分 record_capture 可以补一段，不代表所有新作答已经被分析。不能把 outcome=null 改成猜测的对错修补；应消费有效评估真相源。跟进 YUK-1369。
4. **摘要正文投影也落后于新输入。** `brief-writer.ts:82-90` 支持 summary、answer_md、user_response_md 等旧字段，没有 response_md、user_message、reply_md。原生事件可能只贡献 action/时间/空结果，难以支持有内容的学习分析。
5. **留痕多于分析。** 自信、时长、提示和过程有保存；服务端 assistance 有独立作答资格控制。但不能从这些字段存在推断已经评估了提示依赖、独立迁移或重建能力。速度/谨慎轴至少需要 30 条合格观测；KT 的 kt_json 在源码明确是零下游消费者的软轨 sink（`kt_estimate_nightly.ts:123-124`）。
6. **typed 混淆分类目前不可达。** `typed-state.ts:13-21` 和实际 caller 表明 confused_with_kc_id 始终为 null；要求具名混淆 KC、区分性 probe、至少两次 recurrence 的分支无法满足，也不产出 mastered。这是 YUK-794 已记录能力，不以表存在算完成。
7. **记忆冲突成功整理不等于解决冲突。** `reconcile-decisions.ts:209-224` 将模型提出的所有非 KEEP_BOTH 操作强制降为 KEEP_BOTH。原模型意见留在日志，但不会自动完成偏好替换、合并或遗忘。学科 brief 又只读上次刷新后的新事件，然后替换三个窗口，旧 brief 不作为输入；长期延续依赖本次检索到的 facts，不能保证持续累计。

### 记忆与规划的保护、降级清单

| 机制 | 触发、判断者与影响 | AI 调用影响／限制 | 位置 |
| --- | --- | --- | --- |
| user 来源提取 gate | 规则仅允许 actor=user 推导事实；agent 不进 inferred extraction；题目冻结 gold reference 剔除；owner 编辑 conjecture 用 infer:false 原文保存 | Mem0 infer 含模型及 embedding；底层 wire 次数不可由一次 SDK 调用推定 | `src/server/memory/triggers.ts:247-273`；`client.ts:336` |
| 写入与付费幂等 | exact event lookup、provider-start fence、completion/reconcile handoff；未知结果阻止自动再次 add；只可显式单事件授权恢复 | 不把重投等同新付费许可；阻止重付不证明第一次已成功 | `src/server/memory/client.ts:336-372`；`src/server/memory/memory-ingest-recovery-store.ts:106`；`src/server/memory/triggers.ts` |
| outbox、队列与恢复 | transactional outbox、分钟 poll、小时 recovery、retry/DLQ/epoch；handoff 默认 observe | job 完成或 ingest_at 不足以证明整个记忆链完成 | `src/server/memory/triggers.ts:1075`；`src/server/boss/queue-config.ts` |
| 冲突置信/目标/kind/score 门 | 严格 parse；低置信、非法 target 或不适用 kind 降级；匹配分数不够也降级 | 在模型给出建议后继续确定性裁决，不是已校准的正确率 | `src/server/memory/reconcile-decisions.ts:174-224` |
| 冲突人工批准限制 | 任意非 KEEP_BOTH 的建议被覆盖为 KEEP_BOTH | 花费模型判断但自动效果只能“同时保留”；当前没有据此兑现自动遗忘 | `reconcile-decisions.ts:209-224` |
| 检索时间衰减 | 规则排除 legacy superseded；preference/habit 半衰期180天、weakness90天、event30天；缺时间当现在 | 只影响排序，不删除事实；普通聊天按 action 映射成 event，不自动变成长半衰期偏好 | `src/server/memory/search-memories.ts:38` |
| 摘要缺记忆降级 | Mem0/search 失败用 facts=[]；空事件直接空窗口；strict六字段、证据ID子集；scope失败保留旧brief | 非空正常生成1个逻辑任务；引用校验不是逐句事实复核 | `brief-writer.ts:108-154`；`brief.ts:132` |
| Copilot header 降级 | cache/watermark 分读；生成失败用旧 header 或空 header；写 cache 失败仍回新快照 | 失败时可能继续使用旧状态；深读有 deadline/预算 | `copilot/server/learner-state.ts:514` |
| 规划去除记忆建议 | Mem0 失败只移除 memoryPrior；LLM 编排失败退统计选题，再可退确定性 composer | 记忆搜索与 SelectionOrchestratorTask 分开；失败仍可能给出一份不含记忆的计划 | `practice/server/softmax-selection.ts:561-660` |
| 规划候选修补 | 非法 ref 拒绝，漏候选补统计权重 floor；到期和 recall 保留规则约束 | 不额外调用AI；避免漏掉的候选永不被抽中；floor不是能力估计 | `softmax-selection.ts:587-605` |
| 干预默认画像与审核 | 缺 theta 按 novice、缺 precision 按 low，kc_is_rule_based=false 为占位；方法不合法 abstain，盲解/内容/对照审核；source再验证；默认扩展关闭或shadow | 多次同模型调用不等于异源证据；生成成功不等于可见交付 | `agency/server/intervention/snapshot.ts:59`；`intervention/store.ts:448`；上文正式教学包清单 |

需区分默认值与测量结果：无 mastery 行是未知；theta=0/precision=1/evidence=0 是冷启动 prior；0.01 是候选抽样权重 floor；conjecture 的缺 baseline 0.5 是比较基准；brief freshness 衡量时间而非分析准确率。

已交叉核对的实际证据：[YUK-1348](https://linear.app/yukoval-studios/issue/YUK-1348/copilot-普通学习偏好被后台记住但回复误称没有记忆写入通道)。普通偏好请求经 `memory_event_ingest` / Mem0 `add_inferred` 保存成功，有来源事件和 1024 维向量；同一回合回复却说没有记忆写入通道。该验收源码是 `fea545aa1a853b1cc04da8e015bc3b40e61c4d1f`，不是本轮新跑。原证据明确没有完成 reconcile/global brief 验收，不能把一次存储成功称为学习者模型闭环。

当前测试环境浏览器展示的 global brief 描述了知识树、工具调用和回复失败等操作活动。它证明摘要有实际展示，不证明已经分析出某个知识点的掌握程度，也不证明真实个人数据受污染。

## 处理顺序与跟进记录

本轮已对照既有 Linear 事项去重。先处理直接歪曲用户看到的状态和回答的机制，再补学习证据消费者；没有把所有名为 gate、fallback 或 validation 的函数都判成应该删除。

| 次序 | 已确认的问题与处理目标 | 跟进 |
| --- | --- | --- |
| 1 | 受理/排队状态不再伪装为模型正文；状态来自结构化运行事件；429、配置错误、取消、预算耗尽分别保留真实原因；缺计划时不编造昨日队列 | [YUK-1368](https://linear.app/yukoval-studios/issue/YUK-1368) |
| 1 | 移除有提案时对整篇正文的语义正则替换，以现有工具结果表达“待接受/已应用”；保留真实的提案授权与写入事实 | [YUK-1371](https://linear.app/yukoval-studios/issue/YUK-1371) |
| 2 | 原生作答、有效评分与更正接入学科摘要、速度/谨慎轴等消费者；不拿 outcome=null 猜对错，不重复计算同一证据 | [YUK-1369](https://linear.app/yukoval-studios/issue/YUK-1369) |
| 2 | brief 保留 actor、来源类型和有效学习证据；工具活动与能力结论分开，修正正文投影；不再加一个模型复核或关键词规则替代来源契约 | [YUK-1370](https://linear.app/yukoval-studios/issue/YUK-1370) |
| 条件复现 | 工具执行后 mirror 缺失对撤回资格的影响、Exa 在途取消：先用本地故障注入和远程工具 fixture 复现，再定修复 | [YUK-1372](https://linear.app/yukoval-studios/issue/YUK-1372)，静态可达风险，尚非已观察事故 |

既有工作继续复用：

- [YUK-1346](https://linear.app/yukoval-studios/issue/YUK-1346)：单回合派生策略；此处不把隔离候选算作已部署。
- [YUK-1348](https://linear.app/yukoval-studios/issue/YUK-1348)：实际记忆写入与 Copilot 回复所说能力不一致。
- [YUK-1366](https://linear.app/yukoval-studios/issue/YUK-1366)：记忆初始化/检索/恢复。新增 recovery_required 与 DLQ1 保留，未重放。
- [YUK-1350](https://linear.app/yukoval-studios/issue/YUK-1350)：追加 embedding 的响应体超时缺口，避免另建重复事项。
- [YUK-1176](https://linear.app/yukoval-studios/issue/YUK-1176)：审计事件触发额外记忆摘要的成本；与来源混淆分开。
- [YUK-794](https://linear.app/yukoval-studios/issue/YUK-794)：typed 混淆分类的未接通条件。

正式题目和评分中的 unsupported 放行、重复模型复核，以及记忆冲突全部 KEEP_BOTH，已在本清单逐条说明，不作为本次静默新增或加严 gate 的理由。需要判断其价值时，应明确它保护的具体行为、漏判/误拦代价、调用量和真实效果，不能只用“安全”解释。鉴权、输入结构、幂等、原件守恒和已生效学习证据资格各有实际消费者，本轮没有删除这些契约。

## YUK-1367 候选与交接

- 工作树与分支：`/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1367-structured-practice`，`feat/yuk-1367-structured-practice`。审计前 HEAD `2cc8e6e80`；本轮只提交审计/看板/交接文档，已有六个未提交源码文件保持原样。
- 已有 UI 提交处理 `/practice?paper=id` 入口、返回与刷新；未提交候选处理 `write_quiz` 的真实入口，以及 `author_question` 未出版导致正式作答 409 的断点。没有新建出题工具或替代子系统。
- 必须明报新增成本：候选加入 `runSolveCheck(release_strict)`，通常新增 1–2 个模型任务；它没有为开放题建立模型评分准入。题可出版不等于用户提交后一定能自动评分，仍可能 review_required。该机制尚未发布。
- 已有针对性证据：41 个 DB 用例、38 个 UI 用例通过，日志分别为 `/tmp/yuk1367-native-chain-final-db.log` 与 `/tmp/yuk1367-ui-integration.log`。最后一次 lint 有四项错误，之后的局部修改未重新验证；typecheck/build 的历史日志不足以在本轮确认最终退出码。不得把候选写成全绿。
- 原独立初审指出的 publication 与 practice path 断点已有本地修改；剩余修复验证审、最终本地检查、exact-head CI、真实模型到作答链路均未完成。没有 PR、push、merge 或部署；YUK-1367 保持 In Progress。
- 本轮遵照配额失败后的指示，没有重新调用产品 provider，没有重放记忆任务，也没有取得部署锁。恢复实施时先核对最新 main 与实际发布指针；运行态验收仍需按部署锁协调。

## 覆盖与证据限度

清单从 Copilot 的 UI/受理/执行/工具/终态出发，继续检查共享 AI runtime、正式题目/评估、记忆写入/摘要/规划的可达消费者；另列已经删除、只供历史恢复、以及未找到生产调用者的路径。不是对全仓库所有字符串或所有运维脚本做关键词数量统计。

表中模型次数是代码层逻辑任务次数；SDK transport 重试、Mem0 内部 wire 与未知费用不能从该次数推定。源码证明调用路径，既有浏览器/SQL/发布材料证明各自那次观测；本轮没有新增真实模型质量验收。开发期独立代码审查与产品每回合的 AI 复核是不同开销，不能混算。当前结论不足以支持“完整学习者模型已交付”，也不支持“所有保护都无用”。
