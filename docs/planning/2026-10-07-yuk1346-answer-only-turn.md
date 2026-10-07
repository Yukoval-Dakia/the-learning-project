# YUK-1346 单轮内容用途控制

状态：2026-10-07，YUK-1346 / PR1588 仍 In Progress。初审+唯一修复后验证审查预算已用完，不启动第三轮。本轮仅修复 clean f5709896dd 中受限 prompt 丢失最小校验协议的确认源码缺口。首个真实 R 执行成功、公开 learning_content blocked，精确原因未知；保护摘要未变，真实 restricted-ingest 已通过，A 未发送，新 exact-head CI/剩余验收和发布待父线程。

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
- `src/capabilities/copilot/ui/message-projection.ts`、`replay.ts`：将已受理用途传至 pending/live/replay 问答，不以当前 selector 覆盖历史。
- `src/capabilities/copilot/server/chat-contracts.ts`、`durable-dispatch.ts`、`conversation-writes.ts`、`turns.ts`、`copilot-run-input.ts`、`copilot-execution.ts`、`copilot-worker-session.ts` 和对应测试；`live-turn-context.ts` / `correction-contract.ts` 仅负责模型序列化与确定性引用防线。
- `src/capabilities/copilot/api/chat.ts`、`api/turns.ts`、`api/sessions.ts`、既有 `api/contracts.ts` response contracts、`jobs/copilot_run.ts` 以及必要的取消/终态恢复调用方。PR1588 P1 修复沿用 sessions GET 明示支持的用途；UI 每次受限发送及原 key 重试前重新读取，不使用旧缓存授权。受限 202 必须显式确认匹配用途，缺失/非法/不匹配时保留原 key/body 并说明不确定；未确认时不能显示已受理用途 badge。
- `src/core/schema/event/known.ts` 中 Copilot 和 tool_use payload 契约；`src/kernel/tools/types.ts`、`src/server/ai/tools/mcp-bridge.ts` 中冻结策略传递与镜像。
- `src/server/memory/triggers.ts`、`client.ts` 及必要的恢复入口、brief 读取防线；`src/capabilities/copilot/server/tools/query-events.ts`、`src/capabilities/practice/server/tools/get-attempt-context.ts` 等已证实会再次提供这些事件的证据读取者。
- `src/server/session/conversation.ts` 仅在现有 cursor 更新需要安全的条件写入时修改。
- `postman/api-endpoints.json` 与 `pnpm gen:postman` 生成物、`PLAN.md`、`.remember/now.md`。

实施若发现必须新增 UI 文件，先在本段补齐该文件和用途再编辑。后端可调整上述最小 helper 的位置以遵守 kernel/capability 依赖方向；不得因此扩大到 schema 迁移、全局事件血缘或所有评估引擎改造。

## 接纳与恢复协议

新增严格枚举 `derivation_policy: 'allow' | 'answer_only'`。旧数据和缺省请求解释为 allow，非法值拒绝。不得用 schema default 悄悄改变旧幂等 hash。hash 规范化时缺省和显式 allow 保持旧请求形状，answer_only 参与 hash。同 key 切换用途返回 409。

在既有接纳事务中冻结原始 ask、QUEUED/job_data 的最终策略。worker 以被接纳的源事件为真相，与 job_data 不一致时拒绝执行。沿用 advisory lock、first-write-wins 与 FIFO，不新建可变策略表。

202、公开 turns、重连存储与 pending UI 显示同一策略。不要让刷新恢复的手工 body 投影丢字段，也不要用用户当前开关重建旧请求。成功、失败、取消、reconcile 修复的回复都继承原 ask 策略。

PR1588 P1 修复补充：既有 `GET /api/copilot/sessions` 显式返回 `supported_derivation_policies: ['allow', 'answer_only']` 并禁用缓存。契约允许旧服务器缺省字段，仅供检测旧版本，不能默认支持。UI 在每次受限发送和原 key 重试前直接重新 GET，缺省、非法或失败时不 POST，保留原输入/重试 tuple。selector 显示检查中或当前不可用，保持已保存选择。受限请求的 202 只有显式匹配 `answer_only` ACK 才完成客户端接纳；缺失、非法、`allow` 或无法读取 JSON 时仍保留原 key/body，显示用途不确定，不显示受限已受理 badge。普通 allow 保持旧 202/Location 恢复协议，公开 turns 和 active_runs 的服务端策略仍是已接纳真相。

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

独立初审确认的发布约束继续有效：客户端 preflight 无法使跨版本 rolling deploy 原子化，检查之后服务器仍可能换成旧版本。生产发布必须停止所有写入者，完成停写备份/恢复要求，并让新 worker 在新 app 恢复写入之前就绪；不得混用旧 worker。受限数据写入后禁止直接回退到旧 `f3bfff2cf` app/worker，因为旧版本会消费受限历史与派生。此约束不是源码修复的替代，也不是本子线程已执行的部署。


## 本地实施证据与父线程交接

实施只发生在 `/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1346-turn-retention`，基于 clean `0814062b3d529eb7a7841da035feb58e4087e020`。无新增表、迁移、cron、依赖或全局配置。`src/core/schema/derivation-policy.ts` 提供严格共享枚举；`src/kernel/events/derivation-policy.ts` 只处理既有 ask/直接因果回复与镜像；`src/kernel/tools/derivation-policy.ts` 同时用于挂载名单和执行时守卫。缺省与显式 allow 的 hash 保持旧形状，新 ask/QUEUED/job_data 显式冻结最终策略，worker 对源消息、session、trigger、策略及已冻结完整 job body 逐项核对。

六工具实际调用链已核对，未发现业务物化或学习状态更新：

| 工具 | 已核对实现链 | 允许的效果 |
| --- | --- | --- |
| query_knowledge / get_subject_graph_overview | knowledge/server/tools/knowledge-readers.ts → loadKnowledgeRows/loadEdges/loadMasteryMap/loadRecentFailureCounts | 本地 PG 读取 |
| get_question_context | practice/server/tools/question-context.ts → question/timeline/review/FSRS/variant/knowledge/asset/structure readers | 本地已有题目与证据读取 |
| query_questions | practice/server/tools/query-questions.ts → resolveSubjectKnowledgeIds/listQuestions | 本地题目列表读取 |
| query_memory_brief | copilot/server/tools/memory-brief.ts → memory_brief_note SELECT | 本地已有摘要读取 |
| search_memory_facts | copilot/server/tools/search-memory-facts.ts → readMemoryFacts/searchMemories/client.search | 已有记忆检索及既有 embedding/provider 审计；不写学习内容 |

受限模式同时要求固定工具名及 effect=read，generation 类型 read 工具仍拒绝。teaching worker 分支与独立物化提交各有服务器守卫；远程 Exa、原生子研究、技能包不挂载，受限父运行也不执行原生子研究恢复。根终稿 Markdown 仍按既有安全终稿协议保存。

受限 cursor 清理与 EXECUTION_STARTED fence 在同一事务；普通有效 cursor 与领域结果 marker 同事务提交，早于终态发布。失败清理在持有 settlement 的终态事务内完成，没有晚到 finally 写入或清理。未执行的受限排队轮被取消时不拥有旧 cursor，因而保留前一轮的合法 cursor。成功、失败、执行前/中取消、reconcile/ambiguous、直接重投及后继 cursor 已有 scoped DB 覆盖。

模型读取在 SQL LIMIT 前过滤受限 ask/回复；legacy missing-anchor fallback 也过滤。correction 只读取 policy/ID 位置元数据，确定性拒绝受限目标并要求重新输入；这些内部限制元数据不序列化到 cold/resume/compaction prompt。公开聊天回放保留原文和用途 badge。memory ingest 在构造客户端、lookup/provider-start/add、调和和 brief fan-out 前拒绝受限来源；客户端直接受限输入及 operator recovery 亦拒绝。brief 文本输入、scope 判定与 evidence IDs 都过滤。

本地最终 scoped 验证：16 文件 **255 unit passed**；17 文件 **235 DB passed**，使用隔离 Testcontainers，含真实 Hono route owners、pg-boss FIFO 和 Postgres 事务。主要新增生命周期用例在 `src/capabilities/copilot/server/derivation-policy.db.test.ts`；真实 202/pending/同 key 重试/换用途 409 在 `durable-session-queue.db.test.ts`；selector 持续性、丢失 ACK 后原 body 重试及非法 202 策略恢复在 CopilotDock scoped UI tests。

`pnpm typecheck`、`CODEX_FULL_GATE=1 pnpm lint`、`CODEX_FULL_GATE=1 pnpm build` 均 exit 0；lint 0 errors / 297 warnings，未放宽 baseline。API client 和 Postman 已生成。13 项相关审计通过：schema、partition、api-contracts、api-client、api-client-usage、capability-boundaries、architecture-deepening、provider-lanes、provider-attempt-truth、learner-copy、profile、task-census、draft-status-reads --strict。

最终日志位于 `/tmp/yuk1346-unit-final.log`、`/tmp/yuk1346-db-final.log`、`/tmp/yuk1346-typecheck.log`、`/tmp/yuk1346-lint.log`、`/tmp/yuk1346-build.log`、`/tmp/yuk1346-api-generation.log`、`/tmp/yuk1346-postman.log` 和 `/tmp/yuk1346-audit-*.log`。咨询指针仍为 `/tmp/yuk1346-retention-consult.md`、`/tmp/yuk1346-acceptance-recipe.md`，不是运行验收证据。

未执行 paid model、生产库/凭据访问、真实最终浏览器/模型输入验收、外部 tracker 更新、PR/push/watch/merge/deploy。上述 unit 使用 provider/SDK substitutes，DB 使用实际持久 owners；不以它们冒称真实模型输出或发布验收。父线程继续按前述隔离副本和两条新消息预算验证准确镜像、实际模型输入排除、普通记忆链与无受限业务派生，然后完成独立 review、exact-head CI、等待窗和发布。无新发现的独立 material follow-up；本票剩余发布门槛属于既定验收，Linear capture/status 由父线程负责。

## PR1588 P1 与 CI fixture 修复的本地证据

本轮仅在同一隔离树从 clean `c9ab7e2993f4d9f63926622d1f1ea88192bc99f5` 修复 discussion `4202949273` 与 exact-c9 CI Gate `37569454148` 的 unit shard 3 失败。RED 重现 `pi-tools.test.ts` 原三例 `db.select is not a function`、10 项组件失败，以及 sessions 实际 GET 缺省能力字段的 DB 契约失败。离线 Pi fixture 只替换 `readEventDerivationPolicy` DB seam；生产 reader/守卫未修改。新增用例确认 caller 声明 allow 也不能绕过受限因果源。现有真实 Postgres 测试仍证明六工具名单/effect 双重限制和镜像 outbox 排除。

修复后 scoped GREEN 为 **7 文件 142 unit passed / 3 文件 29 DB passed**。组件覆盖初始旧服务器、先前缓存支持后 fresh 缺省/非法/失败、加载提示、选择持久性、原 key/body 重试、missing/mismatching/invalid/null/unreadable 202 ACK 无错误 badge，以及 legacy allow ACK。DB 覆盖严格 enum、旧缺省不默认支持、真实 sessions 响应与 no-store、既有持久队列/派生 guard。`pnpm typecheck`、`CODEX_FULL_GATE=1 pnpm lint` 和 `CODEX_FULL_GATE=1 pnpm build` 全部 exit 0；lint 297 warnings / 0 errors，baseline 未放宽。API client 与 Postman 已重新生成。14 项相关审计全通过：schema、partition、api-contracts、api-client（重新生成与 staged 生成物一致）、api-client-usage、capability-boundaries、architecture-deepening、provider-lanes、provider-attempt-truth、learner-copy、profile、task-census、draft-status、draft-status-reads --strict。

日志 `/tmp/yuk1346-p1-{pi-red,ui-red,contract-red,unit-final,db-final,typecheck,lint,build,api-generation,postman}.log`；相关审计日志 `/tmp/yuk1346-p1-audit-*.log`。这些是本地源码/组件/API/DB 证据，不是新的 exact-head CI、独立验证审查、真实浏览器/模型验收或发布证据。父线程独占 push、discussion 回复/resolve、唯一 P1 修复后 verification review、真实隔离验收、Linear capture/status 与发布。没有新增独立 actionable follow-up，两条修复均属既有 YUK-1346/PR1588。未触及 `/tmp/yuk1346-acceptance-driver`。源码 commit 完成后本子线程无继续写入授权。

## f570 真实隔离观察与最小协议修复

以下运行证据由父线程提供，本源码子线程未重跑 driver、访问生产或发起新 paid/model 调用。首个真实受限 R 执行成功，费用 $0.0019227，但公开 reply 的 learning_content 仍为 blocked。原始最终候选不可取得、仅有 hash，精确拦截原因未知；不能据此声称 detector heuristic 是根因，也不能把本次源码修复称为该候选已通过验证。

父线程只读确认 `/tmp/yuk1346-acceptance-driver/run-f570-03/observed-R-after-stop.json`：所有受保护业务表、旧事件、vector、reconcile 与保留队列内容摘要未变。确定性 learner header 是既有状态的系统投影，无 R marker/causation，ingest opt-out。原 f570 driver restricted-ingest 阶段已使用真实 handler 对 R ask+reply 通过，provider_delta=0、queue_delta=0、memory_count=0，保护快照仍未变。A 尚未发送；R 不重发、不增加付费，发布仍待完成。

已确认的独立源码缺口是 `copilot-execution.ts` 在 answer_only 下完全省略 piSkillDocs，连带删除共享 `src/subjects/_shared/skills/copilot/SKILL.md` 的“新学习题的独立校验标记”协议。现有产品允许 Markdown 解答已有题目，服务端仍要求对应 manifest。本轮在 `src/subjects/copilot-skills.ts` 从既有共享 SKILL.md 中只提取该节，并经受限 piSkillDocs 注入实际 system prompt，压缩时随 system 消息保留；不另抄一份协议。缺失文件/协议时失败，不回退至完整 skill 或绕过验证。普通模式解析链、六工具 allowlist、完整 skill/写入/提案/agent note/子研究/Exa 禁用边界不变，detector 与服务端内容验证未修改。

focused seam tests 从实际 answer_only system prompt 注入正文提取 marker 并经真实 schema/parser 核对 subject_id、questions、id/kind/prompt_md/reference_md/choices_md/rubric_json。测试核对用户题干与最终答案规则、唯一尾标、5题/12000字符限制及纯概念讲解例外；无标记 prose 直接收口且不调用验证。已存在题目解答缺标记仍拦截；带标记时真实服务端校验链接收完整题干和答案，离线 validator 不可用时仍拦截。六读名单、读效果限制、提案/agent note 写入拒绝、无 full skill/Exa/子研究/cursor 继续覆盖，普通 mode skill 注入也保持。

本轮最终 gates 使用 PATH 中 Node 24.19.0：5 文件 **120 unit passed**（copilot-skills、skill-namespace、copilot-execution、content-validation、pi-agent-adapter）；`pnpm typecheck`、`CODEX_FULL_GATE=1 pnpm lint`、`CODEX_FULL_GATE=1 pnpm build` 均 exit 0。lint 297 warnings / 0 errors，baseline 未放宽；完整 build 覆盖 web/server/worker/migrate，bundle size 警告保留。四项相关静态审计 partition、capability-boundaries、provider-lanes、provider-attempt-truth 均 exit 0。日志 `/tmp/yuk1346-validation-protocol-{unit,typecheck,lint,build}.log` 和 `/tmp/yuk1346-validation-protocol-audit-*.log`。无 API/schema/migration/依赖变化，不运行完整本机 pnpm test，不运行 DB/容器/真实 provider 验收。父线程负责实际整合、PR/Linear 状态、新 exact-head CI 和剩余验收/发布；review 预算已用完，不开第三轮。无新增独立 actionable follow-up，本次确认缺口归现有 YUK-1346。源码 commit 后本子线程无继续写授权，terminal 通知不构成授权。
