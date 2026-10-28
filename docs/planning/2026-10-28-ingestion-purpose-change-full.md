# 上传后用途变更：命令、停止与派生修复

YUK-1522 / YUK-1408（第一天能用），YUK-1414（帮助靠谱）。
实施基线 `bcb793919ea06d06b07231fa9b449579d93a40b2`。Owner 已选择 FULL；
本片交付 Ingestion / Memory / brief 及已批准的两个 Practice 准入站点源码。
准入 fence 已接入，原来源无法证明的历史任务与副本仍 unknown；不声称所有 sink 已清理。

## 命令身份与 HTTP

- `POST /api/ingestion-sessions/:id/purpose`，200 原始安全提交回执。
  Body 为 `{request_id: UUID, source_document_id, expected_version, target}`；
  target 只接受 `allow | answer_only`，没有 UI crisis/actor 字段。
- `GET /api/ingestion-sessions/:id/purpose?request_id=<UUID>` 读取当前文档版本、
  原始 receipt、停止确认、逐来源 Mem0 修复、逐 scope brief 状态、队列回执与未知。
  省略 request_id 仅读当前 policy；缺 usage receipt 不伪造用量或 0。
- 组合根沿原 `/api/*` 的 internal-token 鉴权；actor 固定本人 `user/self`。
  两个真实 handler 都由 Ingestion manifest 贡献；route 只解析和返回，完整事务由
  `ingestion/server/purpose-change.ts` 拥有。
- 永久 ID 为 `ingestion-purpose:<sessionId>:<request_id>`。同输入重放原 receipt；
  即使后来 policy/version 改变，原结果仍可读。异输入同 ID 返回 409；
  没有可信原 receipt 时，绝不从当前恰同 policy 猜测旧命令已完成。
- CAS 检查本人 ingestion session、实际 source_document 和 expected_version。
  原 policy 是系统 crisis 或非法显式值时拒绝，不用用户放宽覆盖系统限制。

## 提交与锁顺序

命令先取既有全局预算 advisory lock，再按 ID 排序锁定绑定该文档的 ingestion sessions，再锁 source_document，最后取
`memory:purpose-brief` advisory lock。policy、自身 usage_epoch metadata、文档 version、
精确 execution_owner.stop_request_id、原始 receipt 和修复义务在同一提交中持久化。
source package、上游 provenance、原件、图片、题库、attempt 与有效学习事实不删除。

新 agent 派发仍是 **全局预算 → session**；新增 live policy 复核位于 session 行锁后、
queued/job 写入前。用途命令复用同一全局锁仅协调多 session 的锁序，不新增预算授权/清账。Memory 保持原 source advisory lock，
随后 SHARE 锁定实际因果来源文档再检查 policy；用途命令不取 Memory source 锁。
event owner 保持 correction global → target 锁序，再按文档 ID 获取来源 SHARE 锁。

命令事务内没有 Mem0、pg-boss 或 provider 调用。所有外部工作在提交后由原执行器和
已有 minute/hourly 恢复消费者驱动；本片没有新通用 registry、表、DDL、cron 或 harness。

## 放宽与冻结来源

真正的 policy 转换建立新 `source_document.provenance.usage_epoch`；同 policy 命令
不无故更换代际。事件原 payload 永不重写。kernel 唯一 event INSERT owner 在同一事务
写 `experimental:ingestion_usage_binding` companion fact，固定原文档、代际与当时严格 policy。
旧事件无 binding 时代表 `legacy`，已有事件重放不能补绑为今日代际。

公共派生读取在 LIMIT 前检查全部 causal ancestors、原 source binding 和 live document。
旧 allow 事件在撤回后的代际不再匹配，之后重新 allow 也不恢复旧来源；新授权只影响新的
来源事件。新 ingestion run 有真实 session 绑定的 source anchor，工具镜像以该 anchor
为因果来源；即使旧调用晚返回或文档已放宽，镜像也沿原代际限制。

放宽不会恢复已删 Mem0、旧事件、旧 unknown attempt 或旧 executor，也不自动重放。
原用户内容及有效学习事实的原始读取/判分真相保持；用途限制不是证据 retract 或 K1 重发布。

## 合作停止与费用

停止复用 `agent_budget.execution_owner`，不建立第二 run/cancellation registry。
新 owner 带授权代际和 durable segment_state；queued/未领取或已明确暂停的 idle executor
可由原 ingestion ask sweep 确认停止。正在执行的原 worker 用非重叠 policy poll、
beforeProviderQuery、DomainTool gate 与同一 AbortController 合作中止。
真实 draft save、submit、presentation 与 custom asset 的原事务入口复核绑定 run；
放宽后的旧 owner 仍受 stop_request/原代际 fence，resume/continue 也不能借新授权。

本地停止确认等待已开始 DomainTool 的 execute/log/mirror barrier。只有原 executor
确实结束，或持久 idle 证据可证明未在执行时，才沿原结算 owner 关闭执行权。
失联 running、旧 owner 缺证据、job 消失均不等同 closed。原 operation/grant/task/attempt
身份、reserved/started fence、paid/unknown 和原结算规则保留；没有“免费”“未发送”或盲重试声明。
已发外部请求的可撤回性始终 `unknown_or_irreversible`。

## Mem0 与迟到出生

来源扫描只用实际 event.session_id → 原文档和 causal chain/immutable binding。
`client.findByEventId` 使用完整 `getAll({filters:{user_id:'self',event_id},topK:100})`，
逐项核对 exact event_id/self；达到完整性上限、坏形状或未知来源时 fail closed。
删除只走现有 `hardDelete` → 官方 `memory.delete(id)`；不直接写 vector 表、不按时间、
文本或模型猜测删除，也不遍历删除全部用户记忆。

官方依据：[Mem0 OSS delete](https://github.com/mem0ai/mem0/blob/main/docs/core-concepts/memory-operations/delete.mdx)、
[官方 Node OSS getAll/history 契约](https://github.com/mem0ai/mem0/blob/main/skills/mem0/client/node.md)。
本机仅静态阅读已安装 SDK；没有实例化/调用 Mem0。

add 的原 source lock 和 provider start fence 保持。原 post-reserve callback 重新读取
live/冻结来源后才能写 started。返回后，completion 与受限来源的新 repair pending 同事务提交；
旧 Mem0 返回不会重新进入 reconcile/brief fan-out。查询在 SDK 返回后按实际当前 event policy
过滤，撤回后无法归因的 legacy memory 也不向公共读面暴露。reconcile 还在实际请求前与
结果应用前复核；不能把 lookup 失败变成 add fallback。

恢复由已有 hourly `memory_ingest_outbox_recover` 的独立 purpose leg 消费：每次轮转一个
永久命令、最多 50 个精确来源，cursor wrap 覆盖迟到出生；不借 TTL job_events。
先持久化 exact target IDs，再锁外逐个官方删除，之后完整 lookup 确认当前 absence。
未决 started/legacy 外部调用仍为 unknown，失败/不完整 lookup 仍未完成；scan 永不表示
withdrawn_all。backup、trace、SDK SQLite tombstone/history 与其它外部副本始终 unknown。

## 简报、横幅与付费恢复

旧 brief 的 fact 输入没有完整 evidence provenance，故保守失效所有既有 scope，
并把 scope/version 义务写入原命令。公共 `query_memory_brief` 拒绝失效版本；
`loadCopilotSummary` 经同一 reader 取 brief_global_md，因此旧横幅段落也不返回。
原 brief 行保留；不是删除学习事实。

重算复用现有 Memory freshness、writer 与 `memory_brief_regen`。永久 dispatch reservation
先于外部 send；job ID 回读或实际 send 证实才记录 queued，null 不冒称完成。
丢失/unknown reservation 只恢复原 job ID 的精确读回，不自动重发；每轮最多派发 10 个未保留的 scope。
实际 writer 也有 once-only reservation，使用确定性 purpose task_run_id 进入原
MemoryBriefTask/cost 路径，未知后不被普通 sweep 重新付费。

生成前读取当前允许事件；生成后若任何输入已限制，丢弃整段 prose，不只删 evidence IDs。
原 writer 的 upsert 与 purpose watermark 在 brief lock 下同事务提交；生成期间发生
撤回则拒绝旧结果。当前 watermark 已覆盖全部撤回的 scope 可直接履行义务，不再调用模型。
完成/failed/unknown、queue/task 引用分别可读；运行没有发生时不宣称重算成功。

## 两个真实入口场景（源码约定，均 NOT_RUN）

| 场景 | 实际入口/consumer | 源码结果与证据边界 |
| --- | --- | --- |
| 活跃录入 allow → answer_only | POST purpose → 私有 command owner；原 agent worker / ask sweep；GET purpose | policy/version/原 receipt/stop+repair intent 同 commit；运行中 stop pending，worker 合作结束后 confirmed；paid unknown 保留。Mem0 精确来源删除、brief 重算状态分别返回。admission fence active，历史归属 unknown。没有业务 HTTP、DB、队列或 provider 实测。 |
| 已撤回文档 answer_only → allow | 新 UUID + 当前文档版本 POST；event writer/派生 SQL、Memory search、brief reader | 新 epoch 仅授权新事件；原命令 GET 仍返回旧 receipt；旧 event/旧 run/已删 memory/旧 unknown 不复活。没有执行旧 run 重放或 provider。 |

## 独立题目准入：真实来源与 paid 边界

Owner 对两个站点的精确批准见 1522 评论 `6531b062-050d-479c-8fe0-db7ca35fbd11`。
`server/admission/enqueue.ts` 在新 job data 写本次 delivery 的精确 publisher event ID，
以及唯一、成功且首次 published 的不可变 submit receipt ID；receipt 内 revision_id / group_id
必须与 publisher 和原 revision 完全一致，publisher actor 还须匹配该 receipt 的原 server actor。
重复、no-op、歧义与旧空 envelope 不用 latest、时间、文本或今日 question.source_ref 补证。

job data 来源字段不进入 FrozenAdmissionInput、版本、digest、paid unit 或 deterministic job ID。
首次成功 transactional send 与永久 `experimental:question_admission_purpose` 来源事实同 commit；
null send 不为既有 job 补造绑定。该事实只保原 delivery / source / revision 关系，沿现有 event log
保存，队列 TTL 后仍可读取，不是第二 paid registry。原 receipt.ts、paid 核心与 schema 零改。

`jobs/question_admission_run.ts` 在原 family → delivery → root → lifecycle 顺序内复核来源，
随后仍用原 claim owner。实际每个 solve/crosscheck 的 Task wrapper 在原
`beforeProviderQuery`（durable attempt 已建、prepared query 发 prompt 前）再次检查原 paid
state / fence / delivery 及冻结 source 的 current policy/epoch。来源文档 SHARE 锁将该检查与
用途 commit 串行；外部 query 在事务外。授权发送检查先于撤回 commit 的请求仍可能已发或无法召回，
本地非重叠 poll 只通过原 Task AbortController 合作停止，绝不把 abort 或 job 消失当作 provider 已取消。
已撤回 commit 先发生时不能越过该 query gate；后续付费调用、结果 preview 与最终应用均重新复核。

付费结果仍先独立持久化原 receipt；应用前重新检查原 delivery 的永久来源事实。
复用其它 delivery 的 receipt 时只取 paid_effect 原 delivery_id，绝不借当前新 job 的授权。
最终应用事务持原 group/lifecycle 与来源 SHARE 锁直至 publish/application commit；用途变更不能
在检查后、应用提交前穿过。所有异常沿原 paid unknown / application failure owner 保存，未发也不伪称免费。

真实非 Ingestion session 的不可变来源证据可正常通过同一检查；未把所有非 Ingestion 来源视为受限。
但只有一个空 session/cause 的 publisher ID 无法证明非 Ingestion 归属；这类历史来源保持 pending，
需要原责任方核对原证据/人工处置，不能自动填新来源、重新授权或重新付款。

impact 的 admission 字段为 `fence:active`、`state:pending|unknown`、
`effect:unknown` 与 `unattributed_history:unknown`；同一原命令持久化未完义务。
逐条返回可精确归因该文档的永久 delivery 绑定、原 paid state / application_error。
applied 只是既有 paid 事实，不能把整体用途撤回标成完成。

| 原状态 | 实际处理 |
| --- | --- |
| queued | 已知受限来源不新入队；已入队任务在付费 claim/send 前检查来源。旧任务无永久原绑定为 pending，不创建新 paid identity。 |
| receipt_ready | 只复用原 receipt，不再 solve；preview 与应用前核原 delivery 来源。受限/未知保 receipt_ready 和 application_error/未完义务。 |
| applied | 原 terminal 只读返回 already_verified，不删除题库、attempt 或学习事实，不重发布。impact 原样列 applied，整体历史清理仍 unknown。 |
| unknown / sending | 原 attempt/fence/unknown 与结算保留；执行中仅合作 abort，不清 unknown、不 authorize/reissue、不自动重放。 |

### 新 submit receipt 的真实来源生产

Owner 已在原 1522 评论 `ea267494-9c13-4bd0-8b0b-4313bd972947` 批准三字段 hunk，
现已写入 `shared-submit.ts::writeSubmitReceiptEvent`：仅新回执 envelope 加
`session_id: ctx.sessionId ?? null`、`task_run_id: ctx.taskRunId ?? null`、
`caused_by_event_id: ctx.causedByEventId ?? null`，直接取既有受信 server ctx。
payload={request_id,fingerprint,receipt}、request fingerprint、receipt/status、paid identity 不变；
旧事件不回填，callerActor / mergeActorRef 与 logTaskRunId / canonical taskRunId 仍沿原映射。

新 Ingestion submit 的 ctx.causedByEventId 指向本次 run 的 source anchor；ctx.sessionId 指向
实际原文档。唯一 event INSERT owner 在该 submit 同一 commit 固定 document/epoch companion。
enqueue 仅按成功 receipt 的精确 revision_id / group_id 和原 publisher actor 选取该事实；
重复、跨身份或空来源不选。原 publisher payload 无需扩展，也没有把来源塞进 paid input。
至此新源生产 → 原 publisher → transactional queue → 实际 query → 原 receipt 应用的用途 fence
已在源码连接；三个站点均未做业务或 provider 实测，来源不明的旧 queued/receipt 仍 pending。

## 验证与未运行边界

允许门的 exact exit/log、owned files 与 fixed base/head 随本片外部 handoff 清单交付。
本地 typecheck/lint/build/生成器和现行 API/schema/boundary/architecture audit 只证明源码与编译；
不代表 HTTP、事务并发、停止、SDK、队列恢复、删除、费用或产品验收通过。
tests/fixtures/断言/probe/driver、业务 HTTP、DB/SQL 执行、容器、浏览器、provider/Mem0、
paid、旧 run 重放、部署、资源/配置操作全部 NOT_RUN。没有新增/修改测试、DDL、依赖或 UI。
首次独立 R1 由父另派；本线不 review/watch/merge。

最终 source 静态门：typecheck、lint（166 warnings）、build、API/Postman 生成、
API contracts/client/usage、schema、capability boundaries、architecture deepening、
provider lanes/attempt truth 均 exit 0。boundary 实测新增 15 个 kernel 边，原债务
237/0/36、SCC 与尺寸上限保持；仅 append 实际边/尺寸，未自签 stable/compat。
固定候选、逐门命令/exit/log、47 个 owned 完整文件与完整 diff：
`/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/yuk1522-purpose-change-full-20261028/delivery.md`。
早期失败日志原样保留；旧检查不冒称覆盖新增三字段之前/之后的其它候选。
