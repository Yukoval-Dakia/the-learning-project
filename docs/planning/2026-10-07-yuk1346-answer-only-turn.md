# YUK-1346 单轮内容用途控制

状态：2026-10-07，由父线程依持续自主交付授权确定的实施方案。只读架构咨询和验收咨询已完成；尚未实施、验收或发布。Linear 为 YUK-1346。

## 用户行为与边界

学习者有时只想讨论一个假设、试问一道题或了解一种思路，不希望这些内容改变系统对自己的长期判断。聊天输入框提供“本轮用途”，选项为“日常学习”和“仅用于本次回答”。默认日常学习，沿用现有行为。

选择“仅用于本次回答”时，发送前显示：

> 聊天和必要运行记录仍会保存。本轮不进入长期记忆、学情判断或后续安排，也不会自动带入下一轮。可读取已有学习资料并回答，不创建练习、笔记或计划。

本次回答结束指该轮进入持久终态。刷新、断线重连、排队、取消或失败不会改变已经受理的用途。聊天历史仍可回看，每条受限问答显示用途标记。回看不会把内容重新交给模型。

输入框保持用户选择，直至其主动修改，关闭抽屉、刷新或切换会话不静默恢复为日常学习。该偏好只是下一条新请求的默认值，每次受理独立冻结策略；重试使用原请求，而非当前选择。已有待恢复请求的策略由服务端和原始重试 body 决定。

受限内容不自动用于后续任何一轮，包括另一条受限请求。用户要让系统继续使用某段内容，须主动重新输入或粘贴所需内容，并选择该新轮用途。后续 correction 引用受限回复时拒绝自动读取，说明需要重新提交；不能借回复 ID 绕过限制。

本轮保留六个已有资料读取工具：`query_knowledge`、`get_subject_graph_overview`、`get_question_context`、`query_questions`、`query_memory_brief`、`search_memory_facts`。实施前核对其真实调用链；必须同时满足固定名单和 `effect=read`，不自动放行未来新增的 read 工具。允许读取既有长期记忆，不允许写入本轮内容。必要的搜索 embedding、运行审计仍按现有配置记录。

受限轮禁用提案、领域写入、控制工具、出题/组卷、教学物化、agent note、artifact、子研究与远程 Exa 工具。仍可用普通文字或 Markdown 解题；原始回答属于聊天历史。前端给出原因，后端和工具执行边界同时约束，不能只靠提示词。普通学习模式保持全部原授权能力和确定性功能。

自然语言“别记住”不是本票的可靠检测协议。明确选择是可信输入，不宣传自动识别所有口头限制。已有两条假设验收记忆保持原状。本票不宣称历史删除、受限多轮会话、到期清理、外部服务零保留或完整 §11 临时使用已经实现。

## UI pre-flight

组件形态：现有 Copilot drawer，修改输入区和问答回放，不新增 route、modal 或 page。沿用现有 tokens、primitives 和 design-system。

设计依据是 `docs/design/2026-10-06-continuous-learning-system-behavior.md` §11.1，第 356 行：

> 记录约定须让用户理解哪些内容会保存、哪些只用于本次帮助、哪些会进入长期学习判断。下面是待批准的完整产品行为，不代表当前实现已支持。

同节第 360 行：

> 临时使用：本次内容不进入长期学情与备课。若技术或外部服务有无法消除的保留，使用前明确说明，不能宣传成绝对不留痕。

同节第 362 行：

> 用户无需理解后台存储结构。产品在选择发生的位置说明实际影响，不用一个模糊的“隐私模式”承诺做不到的事。

§11.2 第 370 行：

> 停止用于判断时，原件可以保留用于用户自己查看，但须重建受影响的当前判断、推荐和后台工作。系统不能通过摘要、旧标签或既有判断间接继续使用被停用证据；历史展示标明它已停止参与判断。用户重新启用时按当前条件重新计算，不直接恢复旧安排。

这里采用事前冻结用途来避免新增受限派生，不声称提供历史证据撤销及重建。该产品取舍由 agent 在授权内作出，不标为 owner 逐项批准。

计划创建：

- 本实施文档；`src/core/schema/derivation-policy.ts` 及必要的同目录 scoped tests，作为事件、请求和工具共用的最小策略类型。
- `src/capabilities/copilot/server/derivation-policy.ts`，仅在需要集中既有工具名单与运行约束时创建；有实际消费者，不建通用框架。
- 对应用途控制 unit/DB tests，可优先扩展既有测试文件。

计划修改：

- `src/capabilities/copilot/ui/CopilotDock.tsx`、`durable-reconnect-storage.ts` 及其相关 scoped tests。
- `src/capabilities/copilot/server/chat-contracts.ts`、`durable-dispatch.ts`、`conversation-writes.ts`、`turns.ts`、`copilot-run-input.ts`、`copilot-execution.ts`、`copilot-worker-session.ts` 和对应测试。
- `src/capabilities/copilot/api/chat.ts`、`api/turns.ts`、API response contracts、`jobs/copilot_run.ts` 以及必要的取消/终态恢复调用方。
- `src/core/schema/event/known.ts` 中 Copilot 和 tool_use payload 契约；`src/kernel/tools/types.ts`、`src/server/ai/tools/mcp-bridge.ts` 中冻结策略传递与镜像。
- `src/server/memory/triggers.ts`、`client.ts` 及必要的恢复入口、brief 读取防线；`src/capabilities/copilot/server/tools/query-events.ts`、`src/capabilities/practice/server/tools/get-attempt-context.ts` 等已证实会再次提供这些事件的证据读取者。
- `src/server/session/conversation.ts` 仅在现有 cursor 更新需要安全的条件写入时修改。
- `postman/api-endpoints.json` 与 `pnpm gen:postman` 生成物、`PLAN.md`、`.remember/now.md`。

实施若发现必须新增 UI 文件，先在本段补齐该文件和用途再编辑。后端可调整上述最小 helper 的位置以遵守 kernel/capability 依赖方向；不得因此扩大到 schema 迁移、全局事件血缘或所有评估引擎改造。

## 接纳与恢复协议

新增严格枚举 `derivation_policy: 'allow' | 'answer_only'`。旧数据和缺省请求解释为 allow，非法值拒绝。不得用 schema default 悄悄改变旧幂等 hash。hash 规范化时缺省和显式 allow 保持旧请求形状，answer_only 参与 hash。同 key 切换用途返回 409。

在既有接纳事务中冻结原始 ask、QUEUED/job_data 的最终策略。worker 以被接纳的源事件为真相，与 job_data 不一致时拒绝执行。沿用 advisory lock、first-write-wins 与 FIFO，不新建可变策略表。

202、公开 turns、重连存储与 pending UI 显示同一策略。不要让刷新恢复的手工 body 投影丢字段，也不要用用户当前开关重建旧请求。成功、失败、取消、reconcile 修复的回复都继承原 ask 策略。

## 派生与跨轮约束

受限 ask、全部回复、工具镜像在插入时具有显式策略、非空 `ingest_at` 和空 `affected_scopes`。这是 outbox opt-out，不代表已抽取。不能从最终 ingest_at 反推策略。工具镜像 session_id 可能为空，必须通过冻结上下文与因果根传递策略。

memory ingest 在 provider lookup、provider-start、add、reconcile 和 brief fan-out 之前检查策略。直接重投 job、operator recovery 或客户端直调也不能变相新增受限记忆；不创建新恢复 grant。brief 的内容和 evidence IDs 都排除受限事件。

用户 turns 回放保留原文，模型历史排除受限 ask 及其所有回复。覆盖 cold prompt、owned Pi replay、异进程恢复、validator context、correction fallback、compaction context。通用 AI 事件查询与因果邻接投影同样排除，不能下一轮经工具读回。

受限轮强制 cold，不提交可续用 SDK cursor。旧 cursor/worker ownership 的清理须在本轮仍持有执行权的事务/终态边界完成；晚到清理不能覆盖后继 cursor。过滤 durable history 是必要条件，仅清 cursor 不足。

## 验收与成本纪律

先运行相符 scoped unit/DB tests、typecheck、lint、完整 build 和 API/Postman 生成核对。禁止本机完整 pnpm test。新增测试覆盖真实接口行为，不只重复 helper 实现。

核心行为包括旧缺省兼容、同 key 同策略恢复及换策略冲突、丢失 202 后刷新、FIFO/redelivery、失败/取消/reconcile、镜像 outbox 排除、直接 ingest 重投、普通→受限→普通的上下文隔离、受限写工具与教学阻断、普通模式保留。

实际验收在隔离恢复副本上使用准确候选镜像、真实 API/DB 与真实 worker handlers，不挂生产 Mem0 卷。不启动会重放旧队列/outbox 的全量恢复任务。保留旧队列和源数据证据，仅处理本轮新 run/event IDs；受控 handler 验收不冒称完整 worker 启动验收。

父线程执行最多两条新 Copilot 消息，先受限 R，后普通 A，并执行必要的新事件 memory/reconcile/brief。普通 A 的实际模型输入须排除 R 与其回复；再以真实装配器离线核对 A 可用于后续而 R 不可用。两条消息不能证明第三轮实际模型调用。

要求 R 无长期记忆/调和/brief 证据及业务内容改写；A 的普通记忆链可回读。幂等重送不新增应用级 provider-start，不重付未知结果。封存 revision/image、request/input/output digests、task/event IDs、provider/model、usage/cost basis；未知费用保持未知。模型输出说“不知道”不能替代最终输入审计。

本轮暂按 $2 保守预算占用，仍受自主交付章程每次 $5 / 每日 $20 上限。未知 SDK 内部费用和 wire 数量不伪装精确，已有 YUK-1342 观测缺口不因本功能验收改称解决。

生产在独立审查、exact-head CI Gate、等待窗和真实验收后，按既有停写备份/恢复/兼容流程发布。此文不是验收记录。
