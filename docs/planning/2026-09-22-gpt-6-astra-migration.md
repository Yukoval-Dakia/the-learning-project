# GPT-6 Astra 迁移计划

日期：2026-09-22。状态：**计划已完成，实施未启动，范围与付费预算待 owner 决定**。

目标：让项目通过现有 PiAgentAdapter 使用 `openai/gpt-6-astra`，在真实业务质量、工具权限、恢复语义与成本可观测均达标后，切换获批任务。

## 1. 基线与本轮边界

- 代码基线：`03a4dd8a9947b685540a712b5419a8bf7d788b24`，已通过 GitHub connector 核实当时的 main。最初盘点的 `8c14cedf4` 到该 revision 仅涉及 UI/CI 文件，本文 AI 路径未变。
- 原工作树 main 有未合并冲突，保留原状；本文在独立工作树 `codex/yuk-1027-astra-migration-plan` 编写。
- YUK-921 / YUK-1025 已 Done，PiAgentAdapter 是主线唯一执行引擎。旧记忆中“SDK 退役尚未完成”已被本次源码和 Linear 状态更新。
- PLAN 记录最近生产镜像为 `c89079b68`、P4 尚未部署；这是版本化交付记录，**本轮未读取生产容器或验证当前生产版本**。
- 本轮只读检查源码、已安装依赖与官方资料，编写计划、登记 Backlog；未调用付费模型、运行应用、改 credential、修改产品代码或部署。
- GitHub CLI auth pre-flight 失败，改用已认证 connector 读取主线；不修改用户认证配置。计划只做本地 commit，不创建 PR 或 push。

## 2. 已确认的事实

| 位置（相对上述 revision） | 当前行为 | 对迁移的影响 |
| --- | --- | --- |
| `src/ai/task-catalog.ts:102`、`src/capabilities/*/tasks/` | 51 个 capability-owned TaskSpec；默认 provider 为 xiaomi，模型为 MiMo v2.5 / v2.5-pro | 初期沿用 per-run override；切换时只改获批 TaskSpec |
| `src/server/ai/providers.ts:155,280,441` | openai 是占位配置，IMPLEMENTED_KEY_PROVIDERS 不含 openai；override 优先于 task 默认 | 接通既有 openai lane，不新增 astra provider 名 |
| `src/server/env.ts:93` | 已有 OPENAI_API_KEY schema | 核对 API、worker 和实际 compose/env 透传；不重复造 credential 配置 |
| `src/server/ai/pi-models.ts:98` | 先加载 pi builtinModels，再覆盖 Xiaomi/Zhipu/Anthropic-sub custom provider | 优先使用已有 OpenAI builtin；不能放入硬编码 anthropic-messages 的 custom 表 |
| `src/server/ai/model-profiles.ts` | config-over-catalog，未知工具/图片能力 fail-closed；当前裁剪 catalog 不含 OpenAI | 给 Astra 显式完整 binding；不为了一个模型刷新全部第三方 catalog |
| `src/server/ai/pi-agent-adapter.ts:878` | root/child 共用 baseLoopConfig；effort 仅在 options.effort 存在时传入 | 核实有效 effort 与实际 wire；profile.defaultEffort 只是元数据，不能当执行接线 |
| `src/server/ai/attempt-cost.ts:62` | 非 Xiaomi 的正 reportedCostUsd 可能被标 reported | Astra 的 pi 估算需要单独归因，不能伪称 provider 账单 |
| `src/server/ai/pi-agent-adapter.ts:1153` | 每个 completed turn 达上限都会 capped，包括自然终止 | 已有 YUK-1026；属于迁移前置修复，不归咎于 Astra |
| `src/capabilities/copilot/jobs/copilot_run.ts:113`、`server/durable-dispatch.ts:33` | modelBinding 是 test/ops seam，生产 job_data 没有 durable model binding | 上线前补非敏感绑定快照；不能声称当前已经支持安全重投递/百分比灰度 |

已安装 `@earendil-works/pi-ai@0.85.1` 与锁定依赖一致，`dist/providers/data/openai.json` **已包含 Astra**：Responses 驱动、image input、low/medium/high/xhigh/max、cache-write 价格和 >272K 分层价格。`openai-responses-shared.js` 已处理 cached_tokens/cache_write_tokens，并从 input_tokens 中扣除二者。因此不预设升级 pi，也不重写传输栈；P1 用锁定安装复核这些事实。

## 3. 官方兼容性约束

以下为 2026-09-22 实际打开的官方页面；实施时再次核对账户可用性和变更。

- `gpt-6-astra` 工具调用要求 **Responses API**；Chat Completions 的纯文本支持不能证明工具链可用。移除 temperature/top_p/top_logprobs；Responses include 不带 message.output_text.logprobs。模型支持 low/medium/high/xhigh/max；none/minimal 不应直接透传。[迁移指南](https://developers.openai.com/api/docs/guides/latest-model#migration-quickstart)、[模型页](https://developers.openai.com/api/docs/models/gpt-6-astra)
- 官方模型上限为总上下文 1,050,000、输入 922,000、输出 128,000 tokens。当前 pi builtin 的有效 contextWindow 为 272,000；首批维持此保守客户端窗口，并在文档区分“模型上限”与“本项目使用窗口”，不顺手放大 compaction 阈值。[模型页](https://developers.openai.com/api/docs/models/gpt-6-astra)
- Standard、非区域附加费下，每百万 token：普通输入 $10、缓存读取 $1、缓存写入 $12.5、输出 $50。输入超过 272K，整个请求按 $20/$2/$25/$75 计价。首批不用 Fast/Flex/Batch，预算计算固定服务层。[价格页](https://developers.openai.com/api/docs/pricing)
- 缓存配置使用 prompt_cache_options；迁移旧 retention 时采用 ttl="30m"。响应 input_tokens 包含 cached_tokens 与 cache_write_tokens；归一化后不得再次扣除或重复收费。[缓存文档](https://developers.openai.com/api/docs/guides/prompt-caching)
- Astra 更容易提出澄清问题且更敏感于 skill 指令；只调整实际注入的产品 prompt/skill，明确教学终态、可直接执行的 read、必须经过 proposal 的 write，保留简中与结构化输出契约。[提示指导](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices)

账户是否能调用 Astra、额度、限流、当前 API key 是否已配置均未验证；Codex 可选 Astra 不能代替项目 API 访问证明。

## 4. 迁移范围决策

| 方案 | 实施范围 | 成本与验收范围 |
| --- | --- | --- |
| **LIGHT（推荐）** | 首批候选 CopilotTask、SupplyPlanTask、SolutionGenerationTask；root 的 inherit 子代理随 root 验证。按实际收益再纳入 QuestionAuthor/QuizGen 等复杂任务 | 保持其余低成本路由；先证明交互、规划、解题三族价值 |
| FULL | 在 LIGHT 接线与验收基础上，按交互/规划/生成/判官/录入/笔记六族迁移所有获批且兼容的 central TaskSpec | 每族独立质量与预算门槛；另列外置 Mem0 LLM 调用，不能用全局 override 冒充覆盖 |

尚未收到范围选择时，本文将 LIGHT 作为建议，不把推荐当 owner 已批准。任何方案都保留确定性判分、FSRS、事务 owner、proposal/accept、工具 allowlist 和人工救援语义。Embedding、Tencent/GLM 专用 OCR、外部检索不是 Astra 文本模型的自动替代项。FULL 如要包括外置 Mem0，先出该调用面的实际兼容与预算表。

首批推理：显式已有合法 effort 保留；旧模型缺省 effort 的任务先以 medium 对照，低延迟单发候选可评 low，复杂解题候选可评 high。这些是实验起点，不批量强制 high/max。模型、effort 和 prompt 变更分轮评估，避免无法归因。

## 5. 执行阶段

### P0：冻结基线，排除引擎回归（前置：YUK-1026）

1. 从实施当时最新 main 建独立 worktree，确认 YUK-1026 状态和修复 revision；若仍未修复，先独立修复 root/child 的自然终止与继续请求的 turn-cap 区分。
2. 提取所有 TaskSpec 的 provider/model/effort/budget/tools/modalities，增加显式 override、nested-agent model 和外置模型调用清单。和仍在进行的 YUK-346 评估共用证据格式，不改其工作树、路由或结论。
3. 为获批候选冻结 prompt/skill/input digest、现有运行配置及质量基线。保留生产原 timeout/maxIterations，禁止用 budgetOverride=4 掩盖 maxIterations=1 失败。
4. 在不打印 key 的前提下检查 API/worker 的 OPENAI_API_KEY 配置，后续用获批小额真实 Responses 请求证明目标账户可用；文档与 mock 不能代替这个门。

出口：正常单 turn 成功、真正要求额外 turn 才封顶；旧 provider scoped 回归通过。未完成 P0 可并行准备代码和离线测试，但不能发布业务 canary。

### P1：接通 Responses 与能力绑定（YUK-1027）

- 修改 `providers.ts`：启用现有 openai key lane，为 gpt-6-astra 提供显式 ModelProfile；`meteredUsd` 不沿用旧 SDK 含义随意翻 true。
- 使用 pi 0.85.1 的 openai builtin 与 Responses 驱动；在 `pi-models.ts` / `pi-agent-adapter.ts` 仅补有证据的缺口。没有 SDK 类型/实际 wire 缺口不升级依赖。
- capability 声明区分“官方支持”与“应用已接通”；工具/图片先在隔离测试 binding 验证，再启用正式绑定。当前 JSON 文本 + Zod parser 保留；structuredOutput 只有真正透传 schema 并处理 refusal/incomplete 后才能宣称已接通。
- 在现有 effort seam 提供显式有效值，捕获 outbound request 验证，不把 profile.defaultEffort 元数据误当 wire。确认 root/child、run 元数据与实际 effort 一致。
- 核对 `max_output_tokens` 传输链；现有 adapter 不显式传 task 输出上限，必要时在 PreparedExecutionQuery/Options 增加最小内部字段，经 baseLoopConfig/streamOptions 消费，并包含 pi 驱动的最小值钳制语义。
- 确认工具 JSON Schema 与 Responses function 形状兼容、call_id 往返、图片载荷、Unicode/LaTeX、流式终态、取消、重试、durable replay、compaction、子代理继承。模型原生 reasoning/encrypted item 的保留按 driver 约定验证，不把原始思维链持久化到业务日志。
- 验证已有 MiMo 会话切入 Astra、Astra 会话回退原模型的下一轮：durable 用户/助手/工具语义保留，provider 专有签名不跨模型误传，历史工具结果不触发重复执行。不能仅测试全新会话。
- `.env.example` / README 记录参数；src/server/env.ts 已有 key，compose 先核查 env_file，不加重复入口。

出口：现有 runTask/runAgentTask/streamTask 在隔离环境可按 modelBinding 选 Astra，旧默认路由不变；contract tests 明确实际请求 `/v1/responses`。复用唯一 Pi 引擎，不恢复 Claude SDK。

### P2：成本与预算闭合（YUK-1028）

- 在 `attempt-cost.ts` / `pricing.ts` 归因 OpenAI 费用：公开价目表 × usage 为 estimated，附模型、价目表日期/版本和服务层 ref；缺 usage 为 unknown/null。pi 的 cost.total 不是发票。历史账本不重算。
- pi 已归一化的四桶为 ordinaryInput/cacheRead/cacheWrite/output；输出含 reasoning，不能额外再加 reasoning tokens。新路径不重新扣 cache 两桶。
- Standard 普通上下文费用：`(I*10 + R*1 + W*12.5 + O*50)/1e6`，I/R/W 为互斥输入桶。测试 272000/272001 分层边界；使用输入三桶之和决定阈值，而不是仅 ordinaryInput。
- 在既有 attempt/lifecycle/admission owner 上证明逐 wire 输入+输出预留、root/child 合并、重试费用和总预算拦截；费用不确定不自动返还预留。若现有控制只是 metadata，补最小执行点。已经发出的请求无法因本地超时证明未计费，验收须记录这项边界。
- 预算 reservation 必须由现有 Postgres owner 在事务/锁下原子执行，使 API/worker、root/child 和重投递共享本次获批额度及上线日上限；记录 reserve/settle/unknown，确定未发出或实际已结算后才释放差额。当前 pi Options 已无 maxBudgetUsd，必须增加实际拦截并用并发 DB 测试证明，不能仅翻 meteredUsd 或延用字段注释。
- 保持稳定 prompt/tool 前缀与顺序；验证新缓存配置和 usage 入账。首批不加 prewarm 或动态 effort 更新，避免新增付费路径与缓存状态复杂度。

出口：账本/run/attempt 聚合一致且无重复；预算用故障与超限测试证明。不得以 schema 有 maxCost 或 catalog 有价格作为完成证据。

### P3：真实业务对照与提示调整（YUK-1029）

复用 `pi-adapter-actual.db.test.ts`、`pi-tool-loop-actual.db.test.ts` 的隔离方式，必要时增加 `astra-actual.db.test.ts`；不构建新评测平台。

| 任务族/行为 | 至少覆盖 | Go 条件 |
| --- | --- | --- |
| Copilot + 工具/子代理 | 复杂中文指令、先读后提案、远程失败、继承模型、父取消、真实结果引用 | 无越权写、伪造成功、重复执行；嵌套结果和成本可追溯 |
| 规划/生成/解题 | 长题干、LaTeX、多个约束、歧义/无解、嵌套 JSON、错误参考答案 | 公共 rubric 下质量不低于同题基线，subject validator 全过 |
| 图片/录入（选中时） | 复杂试卷图片、图文联合、缺图/坏图 | 不丢图片，不幻造 OCR；现有 fallback/manual rescue 保留 |
| 生命周期 | 单轮自然结束、tool cap、refusal/incomplete、429/5xx、SSE断连、Stop、worker恢复、压缩后继续 | 终态诚实，无重复提交/晋级/扣账；真实业务链恢复可验证 |

每个获批任务族先至少 10 个困难案例；关键边界额外覆盖不受数量限制。同一输入和冻结 rubric 比较 baseline 与 Astra，记录配置差异。真实质量由独立审阅配合确定性判官判断，不只让 Astra 自评。

首轮先保持 prompt 不变。仅根据失败案例修实际 system prompt / piSkillDocs：已授权任务持续执行、澄清不应阻断独立工作、教学表达简洁、无内容时不伪造工具证据；修改后重跑相关案例并更新项目 prompt oracle。不得删除 proposal/accept 等产品权限边界来减少模型询问。

证据每次保存 exact revision、task kind/run ID、provider/model/effort、prompt/input/output digest、脱敏实际输出、TTFT、总耗时、token 四桶、费用来源/金额、tool/retry/终态；原始数据按既有安全存储方式保存，不提交密钥或用户隐私。

费用建议：首批 pilot 预算 **$30 上限（待批准，不是当前授权）**，分批预留，不足则提交结果与缩小/扩展方案。无缓存写入的 20K 普通输入+2K 输出约 $0.30；若全部输入需要写缓存约 $0.35；工具多轮和推理输出另计。不能按此示例承诺整轮评估够用。

出口：关键契约 100% 通过，越权/错误晋级/重复提交为 0，业务质量不低于基线。列出 p50/p95、TTFT、成功率、费用/成功任务；未达到原 timeout 或预算则 No-Go，不为迁移放宽。p95 在小样本中仅作方向信号。

### P4：按任务切换、观察与回滚（YUK-1029 后半，须部署授权）

1. 冻结 LIGHT/FULL 明确任务清单、日预算和生产目标；核对实际 app/worker image、env、队列与恢复点。新的部署授权不得由本次计划请求推断。
2. 先补最小 durable binding：以 Copilot 的 `server/durable-dispatch.ts` / `jobs/copilot_run.ts` 为首个 owner，在接受/入队时保存 resolved provider/model/effort（不存 key），worker 与重投递读同一快照；inherit 子代理沿用，显式子模型保持独立约束。其它选中 job owner 同样盘点。通过原模型→Astra→原模型及重投递 DB 测试后才能切生产。切换前先排空无快照的旧 job；无法排空或判明意图时停止切换，不猜绑定或重烧。
3. 隔离 canary 用既有 modelBinding/per-call override；此入口目前是 test/ops seam，不能宣称已经用于生产分流。正式切换只改选中 TaskSpec 的 defaultProvider/defaultModel，会切换该族的全部新请求；本计划不要求百分比路由平台。全局 AI_PROVIDER_OVERRIDE/AI_PROVIDER_MODEL 会覆盖全部任务，仅用于隔离进程，不能冒充按 task 灰度。P4 已删 AI_ADAPTER_PI_KINDS，禁止复活。
4. 先迁一个低流量任务族，再扩 Copilot/规划/解题；API 与 worker 同 revision/配置。每族至少观察 24 小时且完成 30 个样本，未达到则继续观察，不按日历自动通过。
5. 持续看实际失败率、schema/tool 错误、预算、费用/成功任务、p95 与原超时要求。任何权限/重复写/错误晋级/账务丢失立即停止新 Astra run；质量或预算不达标则回退该族。
6. 在同一 Pi runtime 上先回退该族到迁移前 provider/model（或撤销隔离 override）；不把回退模型绑定与跨版本回滚旧 Claude SDK 混为一谈。第2步快照使已启动/重投递 run 保留原 binding，原 receipts/attempt 继续结算；未知副作用不自动重试，历史 failed/DLQ 不批量重烧。
7. 完成一次真实回滚演练：新 run 使用原模型，旧 run 正常结束/取消，无重复 tool event/写入。若需要镜像级回滚，先单独验证 session/DB 兼容。

出口：有真实业务 canary 和回滚证据才可称迁移完成；PR 合并或 HTTP200 单独都不够。

## 6. 验证与交付顺序

- 单元：按改动选择 `providers.test.ts`、`model-profiles.test.ts`、`execution-adapter.test.ts`、`pi-agent-adapter.test.ts`、`runner.seam.test.ts`、`pricing.test.ts`、`attempt-cost.test.ts`，使用 `pnpm vitest run --config vitest.unit.config.ts <files>`。
- DB/actual：`pnpm vitest run --config vitest.db.config.ts <files>`；先 scoped DB mock/故障契约，再在预算获批后启用 opt-in actual harness。不把默认跳过 live case 的绿色当真实验收。
- 本机 gate：`pnpm typecheck`、`pnpm lint`、`pnpm build` 与受影响的 provider-attempt/provider-lanes/task-census/prompt audits。仅修改文档的本轮做路径、链接、差异与独立计划审阅，不运行产品构建。
- 独立 review 一轮初审，必要时一轮 P0/P1 验证审；push 后 exact-head CI Gate 执行完整测试。本机不运行完整 `pnpm test`。
- 不预设 DB migration/API route 变更；若确需改动则追加相应 migration smoke/Postman 生成要求。

```mermaid
flowchart LR
  A[冻结任务与账户前置] --> B[P1 OpenAI Responses]
  X[YUK-1026 引擎回归修复] --> D[P3 同题真实输出验收]
  B --> C[P2 费用与预算]
  C --> D
  D --> E[范围和上线决定]
  E --> F[P4 分族切换及回滚演练]
```

建议 4 个实施 PR：P1 接线、P2 成本/预算、P3 真实验收、P4 durable binding 与获批任务切换。P0 修复沿用原票。单人有效工程时间粗估 5–8 天（含回归/提示调整，不含账户等待、额外修复与至少 24h 的每族观察），以 P1 实证重估。

## 7. Tracker 与未决项

- [YUK-1026](https://linear.app/yukoval-studios/issue/YUK-1026)：已有引擎回归，Backlog；复用，不另建重复票。
- [YUK-1027](https://linear.app/yukoval-studios/issue/YUK-1027)：P1，Backlog。
- [YUK-1028](https://linear.app/yukoval-studios/issue/YUK-1028)：P2，Backlog，依赖 P1。
- [YUK-1029](https://linear.app/yukoval-studios/issue/YUK-1029)：P3/P4，Backlog + needs-info，依赖前三票；待范围、实际调用预算、上线目标决定。

此次计划的完成证据：代码/依赖与官方文档已核对；实施路径、门槛、回滚与 tracker 已落盘。尚未完成的事项是实施与真实验收，不是计划编制。

独立计划审阅：初审指出生产 durable binding 缺口；已补入 P4 和 YUK-1029，唯一验证审通过。17 条现有源码/测试路径、Markdown fence、PLAN ≤200 行和 git diff --check 已校验；本轮无产品测试或实际模型调用。
