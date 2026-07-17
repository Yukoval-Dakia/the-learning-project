# YUK-576 — AI task registry 诚实化（decision note）

Status: DRAFT v3 — v2 对抗复核终判（符合性席 + 冷眼席双席）：fallbackChain 删除**已批准**；本版落 R1-R8 修订；等 coordinator delta 确认后进 TDD
Author: Lane F (ultrawork Wave 2)
Date: 2026-07-07
Scope issue: Linear YUK-576 (Medium) — registry 里的「声明性谎言」

**最大 delta（复核终判已批准）**：`fallbackChain` 的逐字段裁决从 v1 的「接线」翻转为「**删除 + `budget.transientRetries` 实装替代**」。推导链：判词 mustFix#2（same-lane 条目=retry 非 fallback，judges chain 保持 `[]`）+ mustFix#6（每路径唯一 transient 层：durable job 的 transient 层是 pg-boss 重投）+ mustFix#7（全量 chain 审计：4 条升级链、sensor 静默换模不可接受）联合作用后，**没有任何一条现存 chain 拥有合法的进程内消费场景**（§1.2.2 审计表实际收敛到空集）。复核双席独立确认空集收敛是**结构性而非巧合**：该字段唯一能装的东西（同 provider 换模条目）既非合法瞬时吸收（那是 same-target retry）也非合法端点冗余（那是跨 provider env 杆）；本仓真实跨 provider 仪器全是 env 杆（`AI_PROVIDER_OVERRIDE` / `VISION_JUDGE_PROVIDER`）。「wired-but-empty」是比「declared-but-unread」更糟的谎言形态；与 maxCost 裁决对称。替代闭环：同目标瞬时重试（judges）+ 队列显式重投（durable）+ 跨 provider 真 fallback 升 owner 决策（§8，重加路径文字随本 doc ship）。§1.2.4 备选分支留档。

---

## 0. 问题陈述（code-ground）

`audit:schema` 要求每个 schema 字段有 write path，但 **task registry 自己的元数据字段躺着没有 read path** —— 比「没功能」更糟，因为它给人「已覆盖」的错觉。三处：

1. **`budget.maxCost` 未接线** —— `src/ai/registry.ts:27-38` 自认「cost-cap not yet wired … declarative metadata only」。
2. **`fallbackChain` 未接线** —— `src/ai/registry.ts:45-52` 自认「not yet wired … runner resolves a single provider/model and does not auto-retry down this chain」。两个 vision judge（StepsJudgeTask / MultimodalDirectJudgeTask）chain 为空（`registry.ts:358, 385`），瞬时故障 → `'unsupported'`。
3. **结构化输出只有 3/42 任务启用**（registry 实数 42 个 task def，R8 修正；seam `src/server/ai/output-format.ts` 已建好；已迁移：variant_verify + induce 内两个 task）；其余任务跑 `indexOf('{')` 手扒 JSON。

外加两个 runner 自认的运维洞（checklist 级）：`task_run_stuck_in_running` reconcile sweeper、agent 队列显式 `retryLimit`。

---

## 1. 逐字段决策

### 1.1 `maxCost` → **删除**

> **YUK-590 更新（2026-07-17）**：本节记录的是 YUK-576 当时的裁决。其明确写下的
> 重新接线条件已经满足：Anthropic direct pay-as-you-go provider 可通过 runner override / 全局
> provider switch 进入现役，并提供 SDK USD cost 信号。`TaskBudget.maxCost` 因此已连同
> `Options.maxBudgetUsd` 条件消费一并恢复；mimo 与 flat OAuth lane 仍不写该 Options 字段。
> 下文的“删除动作”保留为历史决策链，不再代表当前运行态。

**决策：删除，不接线。**

**Read-path 反查（grep + serena find_referencing_symbols）：** 全部命中 = `registry.ts:34/36/65`（类型 + DEFAULT_BUDGET + INACTIVE docblock）、`budgets.ts:12`（注释指涉）。零消费者；无 per-task 覆盖；`registry.test.ts` 无断言。

**论证（判词修正后的版本）：** v1 稿的「无处施力」是**错误前提** —— SDK 原生就有 `Options.maxBudgetUsd`（sdk.d.ts:1608-1612，「The query will stop if this budget is exceeded, returning an `error_max_budget_usd` result」），把 `maxCost` 接到它是一行透传。**真实理由是：现役两条 lane 的成本上报都无效，使这个闸即使接上也永不触发**：
- mimo 端点不返回 `total_cost_usd`（`pricing.ts:3`；本地 `effectiveCostUsd` 回退是**事后** token×price 估算）——SDK 侧预算累计无 cost 信号可累；
- OAuth flat 订阅 lane 无 per-run 计费（`registry.ts:665-666` ResearchMeetingDirectorTask 自认「maxBudgetUsd is NOT wired on the flat OAuth lane」）。

即：接线 = 造出一个 **wired-but-inert** 的闸 —— 换一种形态的声明性谎言。删除是诚实解。**将来一行可接回**：当一条 cost-reporting lane（如 anthropic 直连 pay-as-you-go）进入现役时，`buildQueryOptions` 加 `maxBudgetUsd: def.budget.maxCost` 即成立（届时再把字段加回来，带真实消费者）。记入 §8 out-of-scope。

**删除动作：** `TaskBudget` 删 `maxCost` + docblock；`DEFAULT_BUDGET` 删 `maxCost: 0.5`；`budgets.ts:12` 注释改写（指向「future cost-reporting lane 时经 Options.maxBudgetUsd 接回」）；`satisfies` 仍成立（无 task 单独设 maxCost）。验收：`grep maxCost` 在 **code + normative docs** 归零（`docs/architecture.md:195/:203` 一并更新，见 §9）；历史快照 / audit 存档豁免。

### 1.2 `fallbackChain` → **删除**（v2 翻转；替代 = §1.3 transientRetries + §6 队列重投 + owner 决策项）

#### 1.2.1 judges 的「单点」问题 → 显式 retry 语义，不是 fallback（判词 mustFix#2）

v1 稿给两个 vision judge 配 `[{ provider:'xiaomi', model:'mimo-v2.5' }]` 被判**名不副实**：两个 judge 的 primary 就是 xiaomi/mimo-v2.5（`registry.ts:353/382`），该条目与已解析 primary **逐字节相同** —— 这是 **retry**，不是 fallback；端点级单点原封不动。诚实的编码：

- judges 的 `fallbackChain` **保持 `[]`**（进而随字段一起删除）；
- 瞬时吸收改为 **`budget.transientRetries: 1`**（§1.3）——字段名如实描述行为：对**同一已解析目标**的一次瞬时重试；
- **真 fallback（端点级冗余）= anthropic-sub Opus vision lane，升级为 owner 决策项**（§8；判词裁定由 coordinator 回写 Linear）。排除它作默认的站得住理由只有**成本策略**（自动消耗 owner 的 Claude Max 订阅额度）——那正是 owner 决策；v1 稿的理由 (b)「token 缺失名存实亡」不成立（缺 token 只是 resolve 失败跳过该级 = 与今天同，skip-on-resolve-error 语义自洽）。mimo-v2.5-pro 仍然被硬排除（text-only，`registry.ts:509/822`——喂图 400 → permanent → 永不成功 = 新谎言）。
- 若将来 owner 批准跨 provider judge fallback，自然落点是既有 env 路由杆家族（`vision-judge-config.ts` 的 `VISION_JUDGE_PROVIDER` 先例，例如新增 `VISION_JUDGE_FALLBACK_PROVIDER`），而非 per-task registry chain —— 本仓真实的路由开关全部是 env 驱动（`AI_PROVIDER_OVERRIDE` / `VISION_JUDGE_PROVIDER`）。

#### 1.2.2 全量 chain 审计表（判词 mustFix#7；激活任何机制前先审计）

方向标注：primary → chain 条目的模型强弱（pro = mimo-v2.5-pro 文本推理强；v2.5 = mimo-v2.5 multimodal）。调用面按 registry 注释 + handler ground 标注，**best-effort**（v2 设计只有两个 vision judge opt-in 进程内 retry，其调用面已逐点核实：`src/capabilities/practice/api/submit.ts` 同步路由、`src/capabilities/agency/api/probe-answer.ts:180` invoker；其余行的标注不承重）。

| 组 | 任务 | chain 形态 | 方向 | 调用面 | 处置（v3） |
|---|---|---|---|---|---|
| **空链** | StepsJudgeTask, MultimodalDirectJudgeTask | `[]` | — | **同步路由内 sensor**（≥5 个同步 caller：submit / probe-answer / paper-submit / advice / solve-session） | `transientRetries: 1`（§1.3）；opt-in 置于 judge **模块级** defaultRunTaskFn，一处覆盖全部同步 caller，墙钟界由 per-attempt timeout + elapsed 门驱动、与 caller 数无关（R7）；跨 provider = owner 决策 |
| **空链** | VisionExtractTask, VisionExtractTaskHeavy | `[]` | — | manual rescue（用户手动触发） | 无变化（人在环，可手动重试） |
| **空链** | StructureTask | `[]` | — | durable（tencent_ocr_extract）+ handler 已有确定性回退（腾讯结构） | 无变化（已有非 LLM fallback） |
| **升级链 ×4** | TaggingTask(:727), ColdStartPlacementBridgeTask(:744), SelectionOrchestratorTask(:894), BlockAssemblyTask(:933) | `[{xiaomi, mimo-v2.5-pro}]` | **v2.5 → pro 升级** | durable（auto_enroll / composer）/ accept 路径 | **随字段删除**。裁决：作为 failure-fallback 它们在 provider 受压时**抬高成本**换更贵模型，且 Tagging/SelectionOrchestrator 的 confidence 输出被下游阈值消费（WorkflowJudge 高置信自动入库 / tempered-softmax 采样），静默换模 = 校准漂移。这 4 条的本意是「备选模型备忘」而非运行时故障策略——恰证明 chain 字段从未被当作 operational policy 编写 |
| **降级链（sensor）** | SemanticJudgeTask, UnitDimensionFallback | `[{xiaomi, mimo-v2.5}]` | pro → v2.5 降级 | **判分 sensor**（inline 判分路径） | **随字段删除**。裁决：sensor 任务瞬时抖动**静默换弱模型判分**不可接受（判分 provenance / 校准）。sensor 的瞬时吸收若将来需要，走与 vision judge 相同的 same-target `transientRetries`（v1 不开，范围收敛） |
| **降级链（durable 主体，~25 条）** | Attribution, AttributionRerank, MistakeEnroll, KnowledgeEdgePropose, FrontierPrerequisite, SessionSummary, NoteGenerate, NoteVerify, NoteRefine, VariantVerify, VariantGen, Dreaming, Coach, KnowledgeReview, GoalScope, MindModelInduction, ClaimGrouping, ResearchMeetingDirector, MemoryBrief, SolutionGenerate, QuizGen, QuizVerify, TeachingQuality, ItemPrior, Sourcing | `[{xiaomi, mimo-v2.5}]` | pro → v2.5 降级 | durable pg-boss job（nightly / 链式 / 按需） | **随字段删除**。裁决：mustFix#6 唯一-transient-层原则 —— 这些路径的 transient 层是 **pg-boss 重投**（§6 显式化），叠加进程内级联 = 最坏 2×3 相乘付费。且队列重投后仍解析 registry default（同 primary）——降级换模从未是这些 job 的既定语义 |
| **降级链（inline/其它）** | TeachingTurn, ReviewIntent, LearningIntentOutline, ProfileCritic, QuestionAuthor, Copilot | `[{xiaomi, mimo-v2.5}]` | pro → v2.5 降级 | inline 路由 / copilot 工具内 / CLI / stream | **随字段删除**。stream 路径（Copilot/KnowledgeReview stream 面）本就排除（byte-identical 红线）；其余 inline 面用户在环可重试，v1 不开自动重试（宁缺勿滥） |

**审计结论：零条现存 chain 有合法的进程内消费场景。** 判词 mustFix#7 的预判（「真正需要进程内级联的 chain 可能远比全量激活少」）实际收敛到空集 → 字段删除是与 maxCost 对称的诚实裁决。

#### 1.2.3 删除动作

- `TaskDef` 删 `fallbackChain` 字段 + INACTIVE docblock；40+ 个 task def 各删一行 chain 声明（纯机械，`satisfies` 保证漏删/多删都编译报错）。
- `registry.test.ts:141/162/191/218` 四处 chain 断言删除（它们 pin 的是「声明存在」，不是行为）。
- 两个 judge 的注释改写：`registry.ts:354-357/:383-384`（「MVP: no fallback…returns 'unsupported'」段）改为指向 `budget.transientRetries` + owner 决策项。
- `docs/architecture.md:195/:203` normative 文本同步更新（§9 变更清单）。
- **`docs/adr/0003-defer-ai-provider-abstraction.md:37` 追加 supersede 注（R4）**——该行显式登记 fallbackChain 为「保留的 schema 占位」，是在世决策记录、不落历史快照豁免；不改则「grep 归零」验收门自 fail（§9 有完整条目）。

#### 1.2.4 备选分支（留档；复核终判已批准删除主案，本分支不实施）

保留字段 + registry 启动期校验（拒绝与已解析 primary 相同的 chain 条目，防再犯 same-lane 名不副实）+ 全部现存条目清空 + runner 消费逻辑落地但 v1 无人口，待 owner 批准 anthropic-sub 后填 judges 条目。缺点：又造一个「已声明、零消费」字段（wired-but-empty）。复核裁定的正解：owner 将来批 judge failover 的自然落点是 `VISION_JUDGE_FALLBACK_PROVIDER` 式 env 配置 + 既有 retry 循环的有限扩展，不是 42 个 def 里的 per-task 数据。

### 1.3 `budget.transientRetries` → **新增并实装**（judges = 1）

`TaskBudget` 新增**必填**字段 `transientRetries: number`（`DEFAULT_BUDGET` 设 0，全部 task 经 spread 继承 0）：runner `runTask` 在**瞬时**失败（§2 白名单）时对**同一已解析目标**重试至多 N 次。v1 仅两个 vision judge 设 1：

```ts
// StepsJudgeTask / MultimodalDirectJudgeTask
budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 90_000, transientRetries: 1 },
```

字段有真实消费者（runner 重试循环）+ 真实测试（§10）+ 如实命名（retry，不是 fallback）——通过 YUK-576 的诚实性标准。**必填而非可选**：可选 + 代码侧 `?? 0` 会把默认值藏进消费端；必填 + DEFAULT_BUDGET 显式 0 让 registry 保持单一事实源。

---

## 2. transient / permanent 分类（**§2.5 实证协议已执行；本节为证据冻结版 v3.1**，判词 mustFix#1）

### 2.1 SDK 错误面 ground（sdk.d.ts 实核 + 2026-07-07 强制失败探针实测）

**类型面（sdk.d.ts）**：
- `SDKResultError`（:3538-3556）没有 `api_error_status`；携带 `subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries'`、`errors: string[]`、usage/cost。runner.ts:578-582 现有 `'api_error_status' in msg` 防御在 error 结果上恒 false，`errors[]` 被丢弃。
- `api_error_status?: number | null` + `is_error: boolean` 在 **`SDKResultSuccess`**（:3571）上。
- CLI 内部自带 API 重试：`SDKAPIRetryMessage`（:2630，「error_status is null for connection errors」）。

**实测面（§2.5 探针，本地 HTTP server + 真实 sdkQuery，CLI 2.1.168 / SDK 0.3.168）**：

| 探针 | 终态形态 | 到达时间 | CLI 内部行为 |
|---|---|---|---|
| 立即 400 | **`subtype:'success' + is_error:true + api_error_status:400`**，`result`="API Error: 400 …" | **instant（1.3s 含 spawn）** | 不重试 |
| 500 恒错 | **`subtype:'success' + is_error:true + api_error_status:500`** | **177.7s** | api_retry ×10 指数退避（0.6s→1.1s→2.2s→5s→8.8s→17s→40s→33s→33s→36s），共 11 个 POST |
| mid-stream 断流 | **`subtype:'success' + is_error:true + api_error_status:null`**，`result`="API Error: The socket connection was closed unexpectedly…" | **1.5s** | 请求级重试 1 次（2 个 POST），二断即吐终态 |
| 连接拒绝 | 60s 内未吐终态（attempt 7/10，status:null），外推同 success+is_error+null | **>3min** | api_retry ×10 |

**两个被推翻的 v3 前提**：
1. **API 级错误（4xx/429/5xx/连接类）全部以 `success + is_error:true` 终态到达**——`error_during_execution` 对 API 故障从未出现（推定保留给 CLI 内部执行错误：工具崩溃等）。mustFix#1 担心的「瞬时故障主落点」实际是 success+is_error，不是 error_during_execution。
2. **runTask 今天把 API 错误记成 `status='success'`**（`result` 是错误文案，下游 Zod parse 失败才间接暴露）——观测面撒谎，正是 YUK-576 主题的又一实例。且 durable 路径上「500-耗尽文案 → parse 失败 → 被 YUK-379 类判 permanent 不重投」= 真 transient 被误判 permanent（记 §8 follow-up，本单不动全局）。

**附带发现**：`CLAUDE_CODE_MAX_RETRIES` 是 CLI 真实 env 开关（binary strings 实证）——v1 **不使用**（保 CLI 默认 10 次退避这层自吸收；我们的层只接 CLI 吸收不了的进程/流级故障），记为未来 lever。runTask 还存在「流结束无终态 → 静默记 success」的洞（streamTaskCollecting 有 sawTerminalResult guard、runTask 没有，runner.ts:1004-1012 对照）——随 runAttempt 重构以 `stream_no_terminal` 补上。

### 2.2 `AgentRunError`（结构化错误载体，v3.1）

runner 单发失败改抛 `AgentRunError extends Error`，字段：
- `subtype: SDKResultError['subtype'] | 'api_error_result' | 'stream_no_terminal'`——`'api_error_result'` = success+is_error 终态（YUK-590 起所有 `runTask` 路径都会抛出，§2.4）；`'stream_no_terminal'` = 流结束无终态消息；
- `apiErrorStatus?: number | null`（仅 api_error_result；null = 连接类）；
- `errors: string[]`（SDKResultError.errors 或 [result 错误文案]，**不再丢弃**，进 error_message 留痕）；
- `taskRunId`。

message 保持 `[kind] Agent SDK errored: subtype=…` 格式（api_error_result 附 ` http=<status|null>`），不破坏既有 `.rejects.toThrow(/subtype/)` 断言。

### 2.3 分类表（证据冻结版 v3.1）

| 信号 | 分类 | 证据 |
|---|---|---|
| `api_error_result` 且 `apiErrorStatus === null`（连接类：mid-stream 断流 / socket close） | **transient** | 实测 1.5s 快速到达 = 唯一能稳过 elapsed 门的真实瞬时形态；CLI 已内部重试过 1 次 |
| `api_error_result` 且 `apiErrorStatus === 429 或 5xx` | **transient** | 语义如此；实测到达需 ~3min（CLI 10 次退避耗尽）→ 对短预算任务会先被 budget-abort（permanent）或被 elapsed 门独立挡住——行保留是诚实 + 服务未来长预算 opt-in 任务 |
| `api_error_result` 且 `apiErrorStatus` 为其它 4xx | permanent | 实测 400 instant 到达；auth/config/validation 形 |
| `subtype === 'stream_no_terminal'`（流结束无终态） | **transient** | 进程级快速故障（CLI 死亡/流中断）；今天被静默记 success 的洞，随重构补 guard |
| `subtype === 'error_during_execution'` | **permanent（保守默认，v3.1 翻转）** | 探针证实 API 故障**从不**落这里 → 「主落点须可重试」的担忧已由 api_error_result 行承接；未观测形态按默认 permanent，errors[] 全量进 error_message 供未来再校准 |
| `error_max_turns` / `error_max_budget_usd` / `error_max_structured_output_retries` | permanent | 重试同目标不解决 |
| abort / timeout（`budget.timeout` 计时器） | **permanent（mustFix#3）** | §3.4 墙钟论证 |
| `resolveTaskProvider` config 错 | permanent（pre-row，不进分类器） | 与今天同 |
| 其余未识别 | permanent（默认保守） | 白名单外不重试 |

### 2.4 success + `is_error` 分支（v3.1 证据后改判——原 breadcrumb-only 裁决的前提被推翻）

> **YUK-590 更新（2026-07-17）**：下面三点保留 YUK-576 的原始范围裁决。当前运行态已经
> 完成 follow-up：所有 `runTask` 调用都把 success+`is_error` 改判为失败；是否 opt-in 只决定
> runner 是否再试，不再决定错误能否伪装成 success。非 opt-in / caller-pinned / env-pinned 路径
> 均只运行一次、写 failure 并向 caller 抛出结构化 `AgentRunError`。

原 v3 裁决（「不参与重试，仅 breadcrumb」）基于「该形态罕见/边缘」的隐含假设；实测它是 **API 错误的唯一终态形态**。v3.1 改判（保零回归的最小改动）：

- **非 opt-in 路径（42 任务的绝大多数调用）**：行为 byte-identical——success+is_error 仍按今天记 success、返回错误文案；新增结构化 breadcrumb `console.warn({ event:'task_run_success_with_error_flag', task_run_id, api_error_status })`（原裁决保留）。
- **opt-in 路径（仅 retryEnabled(ctx)=true，即两个 vision judge）**：success+is_error 按 §2.3 分类为**尝试失败**（AgentRunError 'api_error_result'）——transient（null/429/5xx）且过门 → 重试；否则 throw。行为 delta（judge 内部）：4xx/耗尽从「错误文案 → Zod parse 失败 → unsupported('schema mismatch')」变为「throw → unsupported('LLM call failed: API Error …')」——同 coarse_outcome shape，reason 更诚实；这些尝试的 ai_task_runs 行从『假 success』变为诚实的 `status='failure'`（观测面改善，与 issue 主题同向）。
- 全局（42 任务）把 success+is_error 改判 failure 是更彻底的诚实化，但影响所有 caller 语义（含 YUK-379 类 permanent 误判路径的受益面）——**超本单范围**，记 §8 follow-up。

### 2.5 实证协议（已执行，2026-07-07；产证据不产生产代码）

1. **CLI 源码/二进制证据**：CLI 为 220MB bun 二进制（v2.1.168），minified sdk.mjs 无错误组装明文；binary strings 证实 `CLAUDE_CODE_MAX_RETRIES` env 开关与内嵌 Anthropic client `maxRetries ?? 2` 缺省。
2. **强制失败探针**：`/tmp/laneF-probe/probe.mjs` 四变体（400 / 500 恒错 / mid-stream 断流 / 连接拒绝），本地 HTTP server + 真实 sdkQuery，env 构造镜像 buildAgentEnv key-auth 分支。完整终态 JSON 已捕获（§2.1 表）。
3. **冻结产物**：§2.3 表 + 四个真实终态 JSON 作为 `runner.fallback.test.ts` fixture 依据（mock 按实测形态构造，不凭想象）。

---

## 3. 重试循环语义（anti-loop / 计费诚实 / 成功零差异）

### 3.1 骨架（R1 墙钟第六道门 + R2 失败留痕所有权外置）

```
RETRY_ELAPSED_CAP_MS = 10_000            // runner.ts 常量，论证见 §3.4

runTask(kind, input, ctx):
  assert known task
  actualInput = beforeRun(...)                     // 恰一次，循环外
  maxAttempts = 1 + (retryEnabled(ctx) ? def.budget.transientRetries : 0)
  firstAttemptStartedAt = now()                    // R1：elapsed 门的锚点
  for attempt in 1..maxAttempts:
    resolved = resolveTaskProvider(kind, ctx.override)   // 每次尝试解析恰一次（同目标）
    try:
      return runAttempt(kind, actualInput, ctx, resolved)
      // 成功 → 留痕(success) + ledger → afterRun 恰一次 → return
      // 失败 → runAttempt 不写终态，把一切 post-row 失败（SDK error 结果 /
      //        abort / 流中断）包成携带 taskRunId 的 AgentRunError 上抛（R2）
    catch err:
      willRetry = isTransient(err)
                  && attempt < maxAttempts
                  && (now() - firstAttemptStartedAt) < RETRY_ELAPSED_CAP_MS   // R1 第六道门
      writeAiTaskRunFinished({ id: err.taskRunId, status: 'failure',
        finish_reason: willRetry ? 'error_retried' : 'error', error_message: … })
      if willRetry: emit breadcrumb warn('task_run_transient_retry')          // R3，§5.3
      else: throw err
```

**失败留痕所有权（R2）**：**外层 catch 统一持有**——`finish_reason` 只能在**分类之后**决定（`willRetry = isTransient && 非末次 && elapsed 门`），runAttempt 自己没有分类知识，绝不按 isFinal 单键写。这排除了 v2 骨架的隐患：judge attempt-1 命中 permanent（如 `error_max_structured_output_retries`）时，若按 isFinal 写会误标 'error_retried'，而外层不重试直接抛 → 该真失败被 §5.3 watchdog 排除、凭空消失。`resolveTaskProvider` 的 config 错发生在 run 行创建之前（无行可收），照今天原样直接上抛，不经分类器也不写终态。

### 3.2 门控 `retryEnabled(ctx)`（判词 mustFix#6 唯一-transient-层原则）

```
retryEnabled(ctx):
  if ctx.enableTransientRetry !== true: return false     // 调用面显式 opt-in，默认 OFF
  if ctx.override?.provider || ctx.override?.model: return false   // 调用方钉死路由
  if hasGlobalProviderOverride(): return false           // env 钉死路由（委托 providers.ts）
  return true
```

- **`ctx.enableTransientRetry`（新 RunTaskCtx 字段，默认 undefined=OFF）**：进程内 transient 重试**只给无 durable backstop 的路径**。两个 vision judge 的调用点（`steps-judge.ts` / `multimodal-direct-judge.ts` 的 defaultRunTaskFn ctx）设 `true` —— 它们 catch 吞成 `'unsupported'`，pg-boss 永远看不到 throw，是判词点名的无-backstop 面。**durable job handler 一律不设** → 队列重投（§6）保持唯一 transient 层，杜绝 2×3 相乘付费（判词以 `src/capabilities/knowledge/jobs/attribution_followup.ts:15` YUK-379 transient-rethrow 为证）。默认 OFF = 全仓其余调用点 byte-identical 零回归。
- **`hasGlobalProviderOverride()`**：providers.ts 新增导出谓词，内部复用 `readEnvOverride()`（providers.ts:169）——不二写 `process.env.AI_PROVIDER_OVERRIDE` 真值检查（判词 should）。
- **门控矩阵**：

| 场景 | override | 结果 |
|---|---|---|
| 默认 vision judge（`VISION_JUDGE_PROVIDER` 未设） | undefined | **retry ON**（硬要求满足） |
| `VISION_JUDGE_PROVIDER=anthropic-sub` + token 在场 | `{provider:'anthropic-sub'}` | retry OFF（operator 钉死） |
| **`VISION_JUDGE_PROVIDER=anthropic-sub` + token 缺失** | `visionJudgeProviderOverride()` 降级返回 **undefined** | **retry ON**（行为偏差，显式记录：operator 意图 Opus、实际落 mimo+retry —— vision-judge-config 的 degrade-before-call 语义既有如此，retry 顺着已降级的解析走，可接受） |
| induce.ts self-consistency（per-call 钉 anthropic-sub） | set | retry OFF（保 agreement 统计纯度；**该用例是 YUK-573 承重回归测试**，判词 should） |
| 全局 `AI_PROVIDER_OVERRIDE` | env set | retry OFF |
| durable handler（不设 enableTransientRetry） | — | retry OFF（第一道门就关） |

### 3.3 留痕与计费（判词 should 修正）

- 每次尝试各自 `taskRunId` + 各自 `writeAiTaskRunStarted`；**同一 `input_hash`**（actualInput 循环外定型）。
- **成功尝试** → `writeCostLedger` + `writeAiTaskRunFinished(success)`（与今天同）。
- **失败尝试今天本就不写 ledger**（`writeCostLedger` 只在 runTask 成功路径可达）——v1 稿「每级记 cost_ledger」**声明修正**为：「成功级留痕 ledger；失败级仅 `ai_task_runs` 行」。失败级 ledger 写入**已裁定超范围，不顺手实现**。
- **失败尝试 finish_reason 真值表（R2）**——由外层 catch 在分类后统一写（§3.1）：

| 情形 | finish_reason | 后续 |
|---|---|---|
| 瞬时 且 非末次 且 elapsed < cap | `'error_retried'` | 重试下一次 + breadcrumb warn（R3） |
| **非末次但 permanent**（如 judge attempt-1 命中 error_max_structured_output_retries） | `'error'` | **立即抛**——绝不误标 error_retried（否则真失败被 §5.3 watchdog 排除、凭空消失） |
| 瞬时 但 elapsed ≥ cap（慢瞬时，R1） | `'error'` | 立即抛（不重试） |
| 末次（无论分类） | `'error'`（与今天同） | 抛 |

- `beforeRun` 恰一次于循环前；`afterRun` 恰一次于终态成功后（失败 throw 不调，与今天同）。

### 3.4 墙钟论证（判词 mustFix#3，按调用面分开）

**同步路由面（两个 judge 的真实调用面）**：judge 从同步 HTTP 路由内调用（≥5 个同步 caller：submit / probe-answer:180 / paper-submit / advice / solve-session——opt-in 在 judge 模块级 defaultRunTaskFn，一处覆盖全部，墙钟界与 caller 数无关，R7），生产 ingress 是 cloudflared（docker-compose.yml:132-137），边缘空闲断连 ~100s。judge `budget.timeout=90s`：

- **timeout 若入白名单**：最坏 2×90s=180s，必然击穿边缘 —— 用户看到死连接而 origin 烧第二次 vision 调用。且超时主因常是输入过大（确定性，同目标重试恢复≈0）。→ **timeout/abort 移出 v1 白名单**。
- **「快失败」不是假设而是强制不变量（R1，堵慢 5xx 侧门）**：CLI 内部 api_retry 自带 `retry_delay_ms` 退避（sdk.d.ts:2630），耗尽前可吃掉数十秒才落 `error_during_execution`；504/慢 5xx 可在 30-89s 才到达且命中白名单——若无墙钟门，首试 60-89s 失败 + 满额 90s 重试 = 150-179s，恰是否决 timeout 入白名单时的击穿模式从侧门回归。所以重试加**第六道门** `elapsed < RETRY_ELAPSED_CAP_MS`（§3.1）：只有首试启动后 **10s** 内就失败的尝试才允许重试。
- **`RETRY_ELAPSED_CAP_MS = 10_000` 的取值论证**：最坏墙钟 = cap + 一次完整 timeout = 10s + 90s = **100s**，与 cloudflared 边缘对齐；典型快失败在个位秒 → 典型最坏 ≈95s。**固定常量而非 `budget.timeout/6` 比例**：比例会随未来 timeout 增长静默放宽墙钟（恰是 R1 打的失效模式），固定常量让不变量与预算解耦；若未来某长预算后台 opt-in 任务需要更宽的门，届时显式加参数（过 owner 眼睛），不预留。
- 有界性三重封顶：每次尝试独立 `budget.timeout` × 尝试次数 ≤ 1+transientRetries × elapsed 门。

**后台 job 面**：不适用 —— durable 路径 retry OFF（§3.2），墙钟由队列 `expireInSeconds` + 重投节奏管理（§6）。

### 3.5 实现精度（判词 should）

`buildQueryOptions` 现在内部**自行**调 `resolveTaskProvider(kind, ctx.override)`（runner.ts:430），与 runTask 顶部（:508）**两次独立解析** —— naive 循环透传 ctx 会让解析点分裂。重构：**每次尝试解析恰一次，`ResolvedProvider` 作为参数传入 `buildQueryOptions`**（签名加第四参 `resolved`），消除双解析。TDD 断言（SDK-mock 层）：重试的第二次 `query` 调用收到的 `options.env`（ANTHROPIC_BASE_URL/API_KEY）与 `options.model` 是正确解析目标（same-target：与第一次相同——断言精确到 env/model 值而非引用）。streamTask / streamTaskCollecting 同步改用传入式 resolved（各自单次解析，行为不变）。

### 3.6 红线复核

- **成功零差异**：首次尝试成功即 return——无第二次 SDK 调用、无额外行、`buildQueryOptions` 产出的 Options key 集不变（`runner.seam.test.ts` EXPECTED_KEYS guard 不破；resolved 传参是内部重构，不动 Options 形状）。
- **无限循环不可能**：`maxAttempts = 1 + transientRetries`，v1 全仓最大 = 2；无 while、无递归。
- **计费诚实**：真实发生 N 次调用就记 N 条 run 行；ledger 只记成功次（现状语义）。
- **误重试最小化**：默认 OFF 的 ctx 门 + override 门 + env 门 + 白名单分类 + 次数封顶 + elapsed 墙钟门（R1），六层都过才重试一次。

---

## 4. `'unsupported'` 现有依赖方清单（不变式确认）

两个 judge 在任何 catch 都返回 `JudgeResultV2 { coarse_outcome:'unsupported', score:null, confidence:0 }`。触发点：reference_solution 缺失 / image fetch 失败 / **LLM call 失败** / LLM 输出 schema 不匹配 / signal 长度不符。本设计只影响「LLM call 失败」一支（瞬时先重试一次再落 unsupported），其余触发点与返回 shape 完全不变。

下游消费者（`question-contract.ts`、`judge/invoker.ts`、`judge-rating.ts`、`rejudge.ts`、`JudgeResultPanel.tsx`、core judges）均只依赖 shape，无一依赖「瞬时故障必然立刻产 unsupported」→ 纯改善，向后兼容。

---

## 5. stuck-in-running reconcile sweeper

### 5.1 现状 ground（判词 should 修正后）

- `ai_task_runs.status` 的**封闭写入词表 = `{'running'(default), 'success', 'failure'}`**：schema default 'running'、`AiTaskRunFinishEntry.status: 'success' | 'failure'`（log.ts:124）。**没有任何 writer 写 'error'。**
- 结构化 `task_run_stuck_in_running` warn **只在 stream 路径**（runner.ts:836/894/1141/1191）；**runTask 的两个 finish-write 失败点（:597-603 / :647-653）只有 console.error，无结构化 warn** —— v1 稿声明有误，已修正。**sweeper 的主要价值恰是收敛这些静默的 judge-path 卡行**（judge 走 runTask）。随本单顺带给 runTask 两处补上同款结构化 warn（观测对齐，2 行级改动，unit 可测：logMock.finished.mockRejectedValue + warn spy）。
- run 寿命边界：`budget.timeout` 到点触发 **cooperative abort**（AbortController 信号，SDK 协作中止，非硬杀）+ 12× 阈值边际（最大 timeout 300s vs 1h）——卡 running > 1h 的行必然是进程崩溃在 finally 前或 finish-write 遇 DB outage，**绝无活 run**；措辞按判词从「强制中止」修正为「cooperative abort + 边际」。

### 5.2 语义（只做状态收敛，绝不重放业务副作用）

```
UPDATE ai_task_runs
SET status='failure', finish_reason='reconciled_stuck', finished_at=now(),
    error_message='reconciled by stuck-run sweeper: no terminal write within threshold'
WHERE status='running' AND started_at < now() - INTERVAL '1 hour'
```

**终态 = `status='failure'`（判词 mustFix#4，v1 稿的 'error' 被否）**：'error' 在封闭词表外，会让收敛行**对 admin 观测面不可见**（`ai-observability.ts:366` 失败面过滤 `eq(status,'failure')`；status 值直接作 UI label :299）。`finish_reason='reconciled_stuck'` 是收敛行的判别子。

**status 分类学声明（本 doc 即声明处）**：`ai_task_runs.status` 是**三值封闭枚举** `running → success | failure`，不得引入新值；一切子分类（'error' / 'timeout' / 'error_retried' / 'reconciled_stuck' / stop reasons）走 `finish_reason`。消费者按 status 过滤生死、按 finish_reason 细分原因。

### 5.3 watchdog 死过滤修复（判词 mustFix#4 落点指令：随本 PR 不可分离 ship）

`overnight-digest.ts:106` 的 YUK-580 watchdog 过滤 `eq(ai_task_runs.status, 'error')` 是**死过滤**——生产零 writer 写 'error'，watchdog 今天对真实失败**全盲**。修复（同 PR，因 sweeper 引入的正是会误触发它的行，二者不可分离）：
- `eq(status,'error')` → `eq(status,'failure')`；
- **排除** `finish_reason IN ('reconciled_stuck', 'error_retried')` —— sweeper 收敛行与 §3.3 非末次重试行都不是「逻辑失败」，不得触发 degraded 告警；
- **× DEGRADED_KIND_ERROR_THRESHOLD 交互裁决（判词 mustFix#5）**：阈值 =2（overnight-digest-summary.ts:146）。采**可区分 finish_reason + watchdog 只计末级逻辑失败**方案：一次逻辑请求两次尝试全挂 → 1 条 'error_retried'（被排除）+ 1 条 'error'（计数）= 计 1，阈值语义保持「2 个独立逻辑失败才标红」。不改阈值数值；`DEGRADED_KIND_ERROR_THRESHOLD` 注释补一行「计数排除 error_retried / reconciled_stuck（YUK-576）」。不许静默发生 → 本节即显式裁决。
- watchdog 修复的 Linear 记录由 coordinator 开（判词）。

**retry-rescue 慢性 flaky 的读面声明（R3/R5——防「用一个静默字段换一个新的静默信号」）**：
- **告警面排除 ≠ 全面致盲**。watchdog（**告警面**）排除 error_retried / reconciled_stuck，但 **admin 翻查面故意保留**：Failures 页按 `finish_reason` 聚类（`observability.tsx:552`「failure clusters」+ `:592` cluster badge，支撑查询 `ai-observability.ts:366` `eq(status,'failure')`）——**error_retried 会自然形成一个独立聚类**，慢性 flaky（连续抖动但每次 retry 救回、逻辑层面「全成功」）表现为持续增长的 'error_retried' cluster，肉眼可见。admin KPI（`observability.tsx:287` failed 计数按 `status==='failure'`）同样**故意不加 sub-filter**：它数的是真实失败尝试（retry-rescue 的第一跳与 sweeper 收敛的卡行都是真实发生的失败），诚实计数；这是 R5 二选一里的「显式声明保留」分支，与 R3 读面声明合并成一句纪律：**alerting 面排除、翻查面保留**。
- **retry-rate breadcrumb**：runner 在每次真实触发重试时发结构化 `console.warn({ event:'task_run_transient_retry', kind, task_run_id, elapsed_ms })`（§3.1 骨架内；与 §2.4 success+is_error breadcrumb 同量级，零新 schema）——慢性 flaky 在日志面呈连续 warn 流，可被日志监控拾取，不必等人翻 Failures 页。

### 5.4 触发面（判词 should：boot-time 为主，cron 为辅）

- **主触发 = worker 启动期一次 sweep**：`start-worker.ts` 在 `registerCapabilityJobs` 之后调用 reconcile 函数一次（stuck 的主因是进程崩溃 → 重启即秒级收敛；1h 阈值守护恰防「上一进程的临终 run 还没到寿」被误收）。
- **辅触发 = nightly fast-tier cron**：新 handler `src/server/boss/handlers/ai_task_run_reconcile.ts`（`(db) => (jobs) => Promise<void>` 工厂，与 boot sweep 共用同一 reconcile 函数）+ observability capability manifest 加 `{ name:'ai_task_run_reconcile_nightly', queue:'fast', schedule:{cron, tz:'Asia/Shanghai'} }` JobDecl，`register-capability-jobs.ts` 自动挂载。兜住 DB-outage 型卡行（进程没崩、写挂了，boot sweep 等不来）。
- **fast 档无 DLQ 的 sanctioned 依据**（判词 should）：sweeper 幂等（收敛过的行不再命中 WHERE），掉一拍下轮 cron 重收敛——正是 queue-config.ts:30-32 给 fast 档免 DLQ 的既定语义（「a dropped prune tick just re-runs on the next cron」）。
- 每次收敛发结构化 log（收敛条数 + task_run_id 列表截断），可观测。无 migration（复用现有列 + 现有 `ai_task_runs_status_idx`）。

---

## 6. 队列显式 `retryLimit`（判词判点②裁决：queue-level，llm+agent 两档）

**Ground：** `copilot_run.ts:138-165` 自述 agent 档无显式 retryLimit + transient→permanent 前科；全仓唯一显式 = memory 队列 send-time `{retryLimit:3, retryDelay:30, retryBackoff:true}`（triggers.ts:294）。pg-boss v12 队列 options 持久化 retryLimit，缺省 `COALESCE(...,2)`（migrationStore.js / plans.js）——**默认已重投 2 次**；`createQueue`/`updateQueue` 接受 queue-level `retryLimit`/`retryDelay`/`retryBackoff`（types.d.ts:96-108）。

**决策（判词支持）：** `queue-config.ts` 的 `jobQueueOpts()`（llm+agent 两档共享的 DLQ-backed 配方）加 `{ retryLimit: 2, retryDelay: 30, retryBackoff: true }`；`createOrUpdateQueue` opts 内联类型补三个可选字段。只配 agent 档反而给 llm 档留隐式依赖——两档同配方（判词裁定）。

- **非新增重试**：显式 2 = 与 pg-boss 隐式默认零次数变化；增量是 `retryDelay:30`+`retryBackoff:true`（缺省 0/false → 立即重投），给瞬时条件恢复时间。
- **用户可见行为变更（判词 should，显式记录）**：失败恢复延迟从「立即重投」变为「~30s → ~60s 退避重投」——durable job（如 durable copilot run）失败后的恢复时间线拉长 30-90s。单用户自托管场景可接受；换来瞬时 outage 时不打爆同一端点。
- **transient→permanent 语义**：handler re-throw（copilot_run 对普通 FAILED、attribution_followup 对 retryable）→ pg-boss 按 retryLimit 延迟+退避重投 → 耗尽 → `<queue>_dlq`（permanent，可检查）。
- **与 §3 的相乘防护 = mustFix#6 唯一-transient-层原则**：durable 路径不 opt-in 进程内 retry（§3.2 第一道门），队列重投是其唯一 transient 层 → 每逻辑 job 最坏付费次数 = 1+retryLimit = 3（不变），不是 2×3=6。
- 幂等前提：默认已 redeliver，本改动不引入新的双执行面；copilot_run 有终态守卫。不逐一审计全部 handler 幂等性（超范围，§8）。

---

## 7. 结构化输出迁移策略（判词 mustFix#8/#9 修正版）

**Ground：** seam `output-format.ts` 已建好；**已 ship 的三个迁移范例 = variant_verify.ts（VariantVerifyTask）+ induce.ts ×2（MindModelInductionTask、ClaimGroupingTask）**。其余任务跑 char-scan 手扒（`extractJsonObject` 之类，e.g. steps-judge.ts:98），parse 失败靠整 job 重投重付。

**策略（本单交付物 = 本节策略文本；不含任何示范迁移）：**

1. **新任务默认启用**：任何新增的单发结构化任务（`needsToolCall:false` + JSON 产物）handler 必须 threads `ctx.outputFormat: zodToJsonSchemaOutputFormat(<Zod>)`，解析走双态 dispatch：**A 支优先** `result.structured_output`（端点 honoured；Zod `.safeParse` 仍必过——outputFormat 只保证 JSON shape 不保证 Zod 语义，variant_verify.ts:118-125 约束⑥）→ **B 支回退** 文本 char-scan + `.safeParse`。**禁止新写「裸 char-scan 作为唯一解析路径」**。
2. **旧任务机会主义迁移（碰到哪个改哪个）**：每当因别的原因 touch 某任务 handler，顺手迁移 = **新增 A 支**（threads outputFormat + structured_output 优先读）。**char-scan 降级为 B 支兜底，永不删除**（mimo 端点可能 ignore outputFormat 回落文本；B 支从 prose 抠 JSON 依赖 char-scan——variant_verify.ts `parseVariantVerifyOutput` 实核范式）。v1 稿「迁移删手扒代码」与「保留 B 支」的自相矛盾在此修正：**删除的是『手扒作为唯一路径』的状态，不是 char-scan 代码本身**。
3. **可观测**：`error_max_structured_output_retries`（runner.ts:573 已 warn）是「该任务在此端点结构化产出不稳」的监控点；注意它是**迁移引入的新硬失败模式**（端点重试耗尽 → 整 run error），评估每个迁移时须权衡（正是 mustFix#9 拆分 judge 迁移的理由之一）。
4. **enforcement（判词 should 二选一，选 b）**：本单**诚实注明本策略为 aspirational 约定**——暂无机器 gate（不 ship 无人执行也无人观测的策略假象）；「是否建 audit-lint（禁新增裸 char-scan + 现存 ~32 站点 allowlist + resolves_when，仿 audit:draft-status 配方）」拆 follow-up 决策，记 §8。

**两个 vision judge 的示范迁移 → 拆 follow-up（判词 mustFix#9 裁决，本单不做）**：(a) 同 PR 对传感器路径叠双行为变更（transientRetries + outputFormat）判分漂移无法归因，破坏成功路径零差异红线；(b) judge seam 契约只回 `{ text: string }`（steps-judge.ts `StepsRunTaskFn` 实核），迁移须拓宽 seam + 全部测试替身，非顺手体量；(c) outputFormat 的新硬失败模式可能推高 unsupported 率。follow-up Linear 由 coordinator 开。附带：两 judge 的 registry description（:350-351/:377-378「with structured output (StepsLlmOutput)」）现指「JSON 产物」而非「SDK structured output」，本单在 description 处加一行澄清注记，措辞收紧随该 follow-up 一并解决。

---

## 8. out-of-scope / owner 决策 / Linear 项

| 项 | 处置 |
|---|---|
| **anthropic-sub Opus 跨 provider vision judge 真 fallback**（端点级冗余） | **owner 决策项**（成本策略：自动消耗 Claude Max 订阅额度）。落点建议 env 杆（VISION_JUDGE_* 家族）。coordinator 回写 Linear |
| 两个 vision judge 的结构化输出迁移 | follow-up（mustFix#9），coordinator 开 Linear |
| watchdog 死过滤（error→failure）Linear 记录 | coordinator 开（修复本身随本 PR ship，§5.3） |
| §7 enforcement audit-lint 建否 | follow-up 决策，coordinator 落 Linear |
| 真 per-run cost meter / cost-reporting lane 时经 `Options.maxBudgetUsd` 接回 maxCost | YUK-590 已完成（仅 Anthropic direct；§1.1 更新） |
| success+`is_error` 的**全局**改判 failure（42 任务） | YUK-590 已完成：所有 `runTask` 路径诚实写 failure + throw；仅 opt-in 路径允许 runner 再试（§2.4 更新） |
| `CLAUDE_CODE_MAX_RETRIES`（CLI 内部重试次数 env 开关，binary strings 实证存在） | YUK-590 已完成：runner 子进程默认设 2（共 3 次 CLI 尝试），保留运维显式覆盖（含 0） |
| agent handler 幂等性逐一审计 | 超范围（§6） |
| streamTask / streamTaskCollecting 的进程内重试 | 故意不接（§1.2.2 表；byte-identical 红线） |
| 失败尝试写 cost_ledger | 已裁定超范围（§3.3） |
| YUK-374（FUTURE_JUDGE_ROUTES） | 同主题不同面，不顺手实现 |

---

## 9. 变更清单（文件级）

| 文件 | 变更 |
|---|---|
| `src/ai/registry.ts` | TaskBudget 删 maxCost / 增 transientRetries（必填）；TaskDef 删 fallbackChain；DEFAULT_BUDGET 改 `{maxIterations:6, transientRetries:0, timeout:60_000}`；40+ task def 删 chain 行；两 judge budget 加 `transientRetries:1` + 注释改写 + description 注记 |
| `src/ai/registry.test.ts` | 删 4 处 fallbackChain 断言；增 judges transientRetries pin |
| `src/server/ai/runner.ts` | AgentRunError（subtype+errors[] 捕获）；runTask 重试循环 + retryEnabled 门控 + `RETRY_ELAPSED_CAP_MS` elapsed 门（R1）；失败留痕所有权外置到循环 catch、按 §3.3 真值表写 finish_reason（R2）；resolved 传参重构（buildQueryOptions 第四参）；retry breadcrumb warn（R3）；runTask 两处补结构化 stuck warn；success+is_error breadcrumb warn |
| `src/server/ai/providers.ts` | 导出 `hasGlobalProviderOverride()`（复用 readEnvOverride） |
| `src/server/ai/judges/steps-judge.ts` / `multimodal-direct-judge.ts` | defaultRunTaskFn ctx 增 `enableTransientRetry: true` |
| `src/server/ai/tools/budgets.ts` | :12 注释改写 |
| `src/server/boss/queue-config.ts` | jobQueueOpts 增 retryLimit/retryDelay/retryBackoff + opts 类型 |
| `src/server/boss/handlers/ai_task_run_reconcile.ts`（新） | reconcile 函数 + handler 工厂 |
| `src/server/boss/start-worker.ts` | boot-time reconcile 调用 |
| `src/capabilities/observability/manifest.ts` | 增 ai_task_run_reconcile_nightly JobDecl（fast） |
| `src/capabilities/shell/server/overnight-digest.ts` | watchdog 过滤 error→failure + 排除 reconciled_stuck/error_retried |
| `src/capabilities/shell/server/overnight-digest-summary.ts` | THRESHOLD 注释补排除说明 |
| `src/capabilities/observability/ui/observability.tsx` | **无代码变更（deliberate）**——:287 KPI 与 :552/592 Failures 聚类面故意保留 error_retried / reconciled_stuck 行作读面（R3/R5 声明，§5.3） |
| `docs/adr/0003-defer-ai-provider-abstraction.md` | **:37 追加 2026-07-07 supersede 注（R4）**：fallbackChain schema 占位已随 YUK-576 删除；「未来 retry/降级」场景由 same-target `budget.transientRetries`（已落）+ 跨 provider env 杆（owner 决策项）承接。该 ADR 是在世决策记录、不落历史快照豁免——不改则「grep 归零（code + normative docs）」验收门自 fail |
| `docs/architecture.md` | :195（maxCost/fallbackChain metadata 句）+ :203（尚未实现列表）normative 更新 |
| 新测试 | `runner.fallback.test.ts`（unit，SDK-mock + §2.5 实证 fixture）；judge retry 消费测试；**retry opt-in enforcement（R6）**：grep 级 unit 断言全仓 `enableTransientRetry: true` 恰两处 = 两 judge 文件（防未来 durable handler 误设破唯一-transient-层原则）；queue-config 测试；reconcile DB 测试；watchdog 过滤 DB 测试 |

---

## 10. TDD 计划（复核绿灯后执行，全部失败先行）

0. **实证探针（§2.5）——已执行 ✅（2026-07-07）**：四变体探针（400 / 500 / mid-drop / refused）+ CLI binary strings；§2.1 实测表 + §2.3 冻结表即产物。fixture 按实测终态形态构造（success+is_error 家族为主）。
1. **分类器**（unit）：isTransient 表驱动测试（fixture 按 §2.1 实测形态）：api_error_result null/429/5xx=transient、其它 4xx=permanent、stream_no_terminal=transient、error_during_execution=permanent（v3.1 翻转）、abort/timeout=permanent、error_max_*=permanent、未识别=permanent。
2. **重试循环**（`runner.fallback.test.ts`，no-DB，复用 seam-test SDK-mock 模式，per-attempt message 队列）：成功→零重试零额外留痕 + EXPECTED_KEYS 不变；transient+opt-in→重试一次成功（断言 query 调用 2 次、第二次 env/model 正确、两条 started、第一条 finished(failure,'error_retried')、恰一条 ledger、breadcrumb warn 发出）；**慢瞬时失败（R1）：mock 首试延迟 > RETRY_ELAPSED_CAP_MS 后才吐 transient 错 → 不重试直接抛，finish_reason='error'**；**非末次 permanent（R2）：attempt-1 命中 error_max_structured_output_retries → 不重试 + finish_reason='error'（绝不误标 error_retried）**；permanent→立即抛不重试；transient+未 opt-in→不重试；override 钉死→不重试（YUK-573 承重）；AI_PROVIDER_OVERRIDE→不重试；beforeRun/afterRun 各恰一次；同 input_hash。
3. **judge 消费**（judge 层）：defaultRunTaskFn ctx 带 enableTransientRetry:true；注入 runTaskFn 断言 override 透传不变（成功路径零差异）。**retry opt-in enforcement（R6）**：grep 级 unit 断言全仓 `enableTransientRetry: true` 恰两处（steps-judge.ts / multimodal-direct-judge.ts）。
4. **registry**：transientRetries pin（judges=1、DEFAULT=0）；maxCost/fallbackChain grep 归零（code+normative docs）；tsc 过。
5. **sweeper**（DB）：>1h running 收敛为 failure/'reconciled_stuck'；<1h 不动；幂等（二跑零收敛）；boot 调用点。
6. **watchdog**（DB）：'failure' 计入、'error_retried'/'reconciled_stuck' 排除、阈值语义（单逻辑失败不标红）。
7. **queue-config**（unit）：jobQueueOpts 含三 retry 字段；createOrUpdateQueue 透传。
8. 全量 gate（typecheck/lint/audit×4/test/build）+ fake-completion 自查 + 独立对抗 code review（喂全量 diff）。
