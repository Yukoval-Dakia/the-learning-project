# Claude Agent SDK 原生能力对齐审计报告

- **日期**：2026-06-05
- **审计对象**：`@anthropic-ai/claude-agent-sdk` 在本仓库（`src/server/ai/**`）的接入面 vs SDK 原生能力面
- **安装版**：`0.3.143`（2026-05-15）｜**最新版**：`0.3.165`（2026-06-05，差 22 个 patch）
- **类型实证来源**：`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（5723 行，所有 SDK 断言均出自此文件，已核对签名）
- **Owner 三条哲学**（裁决标尺，全程对齐）：
  1. **哲学**：代码里只编码"任务描述"，行为/领域知识应**动态加载**而非编译期硬融进字符串；
  2. **反过度工程**：成熟问题用 OSS / SDK 原生机制，不自建；不为对齐而对齐；
  3. **留痕**：所有 AI 决策可追溯、可回滚（evidence-first）。
- **已定第一例对齐**（YUK-216 轨 1）：出题规范 = 标准 `SKILL.md` + `Options.skills` 键控。本报告以此为锚点，把"哪些 prompt 内容该迁 skill"系统化。

---

## 1. 执行摘要

本仓库对 Claude Agent SDK 的接入**总体健康**：`createSdkMcpServer` / `tool()` 是正统用法，`systemPrompt` 完全替换、`bypassPermissions` + `allowedTools` 静态白名单、`CLAUDE_CONFIG_DIR` tmpdir 隔离、`persistSession:false` 均与 headless 服务端嵌入最佳实践吻合。大多数"自研子系统 vs SDK 原生"对子经勘察是**语义不同、不可替代**（DB 产品级持久化 vs CLI 本地 session；Mem0 领域 fact 层 vs CLI auto-memory；per-tool 行数 budget vs 会话级 compaction）——这些自研有充分理由，符合反过度工程而非违背。真正的对齐机会高度集中在**一条主轴**：领域知识目前以 29 个 `build*Prompt(profile)` 函数在 Node 侧字符串插值进 `systemPrompt`（`src/ai/task-prompts.ts`，788 行），这与 owner"代码只留任务描述、行为动态加载"的哲学直接冲突，也正是 YUK-216 轨 1 已识别的 SKILL.md 迁移面。

**对齐机会 Top-3：**

1. **【A】prompt fragments → SKILL.md 动态加载（哲学主轴）**：`task-prompts.ts` 里 `promptFragments.*` / `causeCategories` / `noteTemplate` / `grounding.*` 等领域知识段，应外化为 `Options.skills` 键控的 `SKILL.md`，代码侧只留任务描述骨架。这是 owner 哲学的最大体量落点，YUK-216 轨 1 已立项，本报告给出**逐 task 迁移地图 + 优先级**（见 §3）。
2. **【B】`outputFormat: {type:'json_schema'}` 替代 `json-sanitize.ts` 状态机**：SDK 0.3.143 已原生支持结构化输出（`JsonSchemaOutputFormat`，实证 sdk.d.ts:861），理论上能让 SDK 子进程侧保证 JSON 合法、退役 83 行裸控制字符清理状态机。**但有硬阻塞**：mimo/xiaomi Anthropic-compatible endpoint 是否支持该协议未经验证；需先做 1 个 spike 任务实测，验证通过才动 —— 否则保留 sanitize 作为防御层（见 §2 裁决）。
3. **【C-保持，附监控】`tool_call_log` 留在 mcp-bridge handler 而非迁 `PostToolUse` hook**：这是语义差最小、最"诱人"的对齐对，但当前 handler 内联写库能在同一 DB 连接里原子完成 `writeToolCallLog` + mirror event，且能拿到 `effect`/`error_reason`；迁 hook 需把 DB 上下文闭包进 runner 且重建 `mirrorEvent` 因果链，迁移成本高、收益仅"代码中心化"，与留痕哲学无冲突 —— **保持自研，列入观察项**。

**SDK 升级裁决**：建议升级 `0.3.143 → 0.3.165`（22 个 patch，纯 bug fix，本仓库已用 API 面全在 0.3.143 内，无 breaking 预期）。**但**因走 mimo 第三方 endpoint，升级后必须跑全量 `pnpm test` + 一次真实 AI task 冒烟，确认 SDK 没有新增 spawn 前的本地 model-id 白名单校验（见 §4 R7）。低优先、低风险，单独落 issue。

---

## 2. 对齐矩阵

裁决四档：**A 立即对齐**（便宜且收益明确）｜**B 值得评估**（收益存在但有语义差/外部依赖要设计）｜**C 保持自研**（自研有理由）｜**D 不需要**。

| # | SDK 原生能力 | 我们现状（file:line ｜ 自研体量） | 语义差 | 裁决 + 对哲学说理 |
|---|---|---|---|---|
| 1 | `Options.skills: string[]｜'all'`（SKILL.md 动态加载，sdk.d.ts:1721） | 领域知识由 `getTaskSystemPrompt(kind,profile)` 大 switch + 29 个 `build*Prompt(profile)` 字符串插值（`src/ai/task-prompts.ts`，788 行）织入 `systemPrompt`（`runner.ts:253`）。`Options.skills` **完全未传**；`CLAUDE_CONFIG_DIR` 指向空 tmpdir，SDK skills 机制当前不可用（`runner.ts:211-220`） | 现状：领域知识编译期硬融字符串，每次 run 重组装。SDK skills：行为/知识作为磁盘 SKILL.md 按需加载，代码只留任务描述 | **A（哲学主轴，YUK-216 轨 1 已立项）**。这是 owner"代码只留任务描述"哲学的**最大体量违背点**。迁移后：①符合哲学（行为动态加载）；②留痕不变（skill 加载在 `SDKSystemMessage.skills` 可见，比字符串插值更可观测）；③非过度工程（用 SDK 原生机制替手搓字符串拼接）。落地要先解决 tmpdir 无 skills 的前置（见 §4 不动清单注）。逐 task 地图见 §3 |
| 2 | `Options.outputFormat: {type:'json_schema',schema}`（结构化输出，sdk.d.ts:1516/861） | `src/server/orchestrator/json-sanitize.ts`（83 行状态机，扫裸控制字符 U+0000–U+001F 转义）+ 各 handler 自行 `text.indexOf('{')` 裁剪 + Zod `safeParse`（如 `quiz_gen.ts:149-171`） | SDK 在子进程侧按 schema 约束输出、理论上免裸控制字符问题；现状是 prompt 要求 JSON + 应用层防御解析 | **B（外部依赖阻塞，需 spike）**。收益明确（退 83 行 + 各 handler 裁剪逻辑收口）、符合反过度工程。**但硬阻塞**：mimo endpoint 是否支持 `json_schema` 协议未验证；且各 task Zod schema 在 `core/schema/`、registry 只存元信息，两层要打通才能把 schema 喂 SDK。**行动**：开 1 个 spike issue 实测 mimo + `outputFormat`；通过才迁，否则 sanitize 保留作防御（留痕：解析失败可追溯，不能让 SDK 黑盒吞错） |
| 3 | `PreToolUse`/`PostToolUse` hook（`HOOK_EVENTS`，runner.ts:6 注释提及） | `tool_call_log` 落库在 `mcp-bridge.ts:243-260`（每 tool execute 后 `writeToolCallLog`，带 effect/error_reason/latency_ms）+ mirror `tool_use` event（`mcp-bridge.ts:269-312`）；`streamTask` 路径另在 `runner.ts:487-504` 内联写（无 output）。SDK hook events 在消息循环被 `continue` 掉 | hook：声明式 runner 级横切；现状：命令式 handler 内联，但能原子拿 effect/error_reason + 同 DB 连接写 mirror event | **C（保持自研，列观察项）**。语义差最小但**迁移成本 > 收益**：`PostToolUse` 回调签名拿不到 `ctx.db`（需闭包注入）、`mirrorEvent` 的 `callerActor/causedByEventId` 因果链要重建、原子性（log+mirror 同连接）会被打散。留痕哲学**已被现状满足**（甚至更强：handler 内联 = 原子）。仅当未来需要捕获非 MCP 工具（如内置 Read/Bash）的调用时才值得迁 hook。**观察项**：`runTask` 路径（非 stream 结构化 task）不写 tool_call_log——目前这些 task 不调工具，非 bug，但应加运行时断言 `def.needsToolCall && !ctx.mcpServers → warn` |
| 4 | `Options.canUseTool: CanUseTool`（逐 tool 运行时权限回调，sdk.d.ts:1216） | `allowlists.ts:205-214` `DOMAIN_TOOL_ALLOWLISTS` 按 surface 静态白名单 → `resolveMcpAllowedTools()` 返回 `mcp__loom__*` 字符串 → `Options.tools`（`runner.ts:251`）+ `permissionMode:'bypassPermissions'` | 静态白名单：未列工具**根本不呈现**给模型（context filter）；canUseTool：对**已可见工具**做运行时 allow/deny/ask | **D（不需要）**。静态 `allowedTools` 比 `canUseTool` 回调**更利于审计**（声明式、可 lint、无运行时分支）——直接服务留痕哲学。`canUseTool` 在无人值守 server 无对应优势（没有"ask"路径意义），反而引入运行时决策黑盒。注：SDK skills JSDoc 实证"context filter, not a sandbox"——未列项文件仍可经 Read/Bash 触达；本仓库 tmpdir 隔离 + tools 白名单双保险，无此暴露面 |
| 5 | compaction（`PreCompact`/`PostCompact` hook、`SDKCompactBoundaryMessage`）+ `maxTurns` | `budgets.ts:37-99`（surface keyed `maxToolCalls/maxNodesPlusEdges/maxEventRows/maxExcerptChars`）+ `context-throttle.ts:171-281` `ContextBudgetTracker`（`capInput` 在 execute 前降档 `limit` 参数，返回 `softStop` 让 agent 自终止，never hard reject）；`maxTurns` 已正确用（`runner.ts:256` ← `budget.maxIterations`） | compaction：长会话历史压缩；现状：per-tool-call **返回行数/token 量**降档，需知领域工具参数结构（`limitPath`），SDK 层无法表达 | **C（保持自研）**。SDK 无对应能力：`maxTurns` 只控轮次（已用），compaction 管历史不管单次返回量。`capInput` 的 soft-stop 语义（§6 spec：从不硬拒）是产品级需求。符合反过度工程（SDK 真没有这层），符合留痕（soft-stop 决策可观测） |
| 6 | Session 持久化（`persistSession:true` + `resume`/`forkSession`、`listSessions` 等 CRUD） | Copilot 会话持久化在 Postgres `event` 表（`chat.ts:290` find-or-create `learning_session`，turns 写 `event` 表）+ `turns.ts:150-215` 重建结构化 `CopilotTurn`（skill_turn/skill_context 反序列化）；`runner.ts:261` `persistSession:false`（SDK 本地 session 每次丢弃） | **本质差**：DB 持久化 = 产品级（跨容器/进程、结构化 replay、~24h 复用窗口、skill_turn 续载）；SDK session = CLI 本机 tmpdir jsonl 缓存，无产品复用逻辑 | **C（保持自研，本质不同）**。这不是"自研 vs SDK"的同类替代——DB 持久化是 NAS 容器多进程场景的硬需求，SDK session 文件会泄漏到 tmpdir 并与 `CLAUDE_CONFIG_DIR` 隔离逻辑冲突。`persistSession:false` 是**正确选择**。留痕哲学：DB `event` 表本身就是 evidence 主载体，远强于 CLI jsonl 黑盒 |
| 7 | `AgentDefinition` / subagents（`agents` 内联定义、Agent tool spawn 子进程） | teaching/solve orchestrator 是**单次 LLM invoke + 结构化解析**：`teaching.ts:253-271` `planTeachingTurn()` → 单次 `runTaskFn` → `parseTurnOutput`；`solve.ts:200-235` 同模式，无工具循环 | subagents：多 agent 协作、各自独立 tool loop + session；现状：单 turn，无 spawn 需求 | **D（不需要）**。用 subagents 会引入无谓 subprocess 开销。当前 task registry → 单次 query 完全匹配需求。反过度工程：不为"看起来更 agentic"而引入多 agent |
| 8 | `Options.systemPrompt`（string ｜ preset+append ｜ dynamic boundary 数组） | `runner.ts:253` `systemPrompt: getTaskSystemPrompt(...)`（完整 string，替换 claude_code preset） | SDK 提供 preset/append + `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` cache 切分；现状用纯 string 完全替换 | **C（保持 string 替换）+ 内含 A（内容迁 skill）**。"完全替换 preset"是服务端嵌入正确姿势（不要 claude_code 工具行为）。**但 string 的内容**——领域知识段——正是 #1 要迁 skill 的对象。结构（switch + 完整替换）保留，内容外化。可选优化：未来任务量大时加 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 提升 prompt cache 命中（低优先） |
| 9 | SDK auto-memory（`SDKMemoryRecallMessage`、`~/.claude/` memory 文件、`AgentDefinition.memory`） | Mem0 fact 层（ADR-0017）：`memory/client.ts` pgvector + 领域事件提炼 facts；`search-memory-facts.ts:71-110` 经 MCP 暴露（`mirrorEvent:'never'`，限 3 surface）；SDK auto-memory 因 `CLAUDE_CONFIG_DIR` tmpdir **被显式禁用** | Mem0：领域事件驱动（attempt/review/judgment）提炼用户学习 facts、事务一致、allowlist 管控；SDK auto-memory：对话历史摘要、CLI 全局无细粒度控制 | **C（保持自研，刻意禁用 SDK）**。Mem0 语义更丰富且受 allowlist + outbox（ADR-0021）管控，留痕强（pg-boss job 可追溯）；SDK auto-memory 在 NAS 容器 `~/.claude/` 不可靠且是黑盒。禁用是对的 |
| 10 | `createSdkMcpServer()` + `tool()`（in-process MCP，sdk.d.ts） | `mcp-bridge.ts:26,133-329` `buildMcpServerFromRegistry()` 正是调 `createSdkMcpServer({name,tools})`，在 handler 叠加 Zod re-parse + budget gate + `writeToolCallLog` + mirror event | 无差——这就是 SDK 原生 API，bridge 是 adapter 层叠加 audit/budget | **C（已正统使用，非自研替代）**。SDK 原生 handler 无审计/无 budget，不满足产品语义；wrapper 合理。这条本质是"已对齐"的正面样本 |
| 11 | `TaskMiddleware`（无 SDK 对应） | `runner.ts:66-77` `beforeRun/afterRun` 扩展点，目前外部无注入、空置 | SDK 无 middleware 机制 | **C（保持空置扩展点）**。正确的自研扩展点设计，待 memory module 等用例激活。不删（删了将来要重建），不强行填（YAGNI） |
| 12 | SDK 版本 `0.3.165` | 安装 `0.3.143`，差 22 patch | 纯 bug fix，无 breaking，已用 API 全在 0.3.143 | **B（做，低优先）**。升级获 bug fix、风险低。**但** mimo 第三方 endpoint 要求升级后跑全量 test + 真实 AI 冒烟，确认无新增 spawn 前 model-id 校验（R7）。单独落 issue，不阻塞 YUK-216 |

**裁决统计**：**A** 1 项（#1，主轴）｜**B** 3 项（#2 outputFormat spike、#8 内含、#12 升级）｜**C** 6 项（#3/#5/#6/#9/#10/#11）｜**D** 2 项（#4/#7）。
（#8 同时含 C 的结构判定与 A 的内容判定，统计计入 A 主体 + B 的 cache 优化；以"独立行动项"计：A=1、B=3、C=6、D=2。）

---

## 3.「代码只留任务描述」迁移地图

**原则**：一个 task 的 systemPrompt 拆成两层——
- **任务描述（留代码）**：你是什么角色、输入是什么、输出 JSON 结构/字段契约、硬约束（"必须 ≥1 source_ref"）。这是"代码编码任务"，应跟 Zod schema 同源、可类型校验。
- **领域知识（迁 SKILL.md）**：错因分类法、教学风格/检查问策略、笔记模板与范例、学科出题纪律、grounding 口径、语言风格。这是"行为/知识"，应随 SubjectProfile 动态加载、可不改代码切换学科。

判据：**该段是否随 `profile` 变化？** 随 profile 变 → 领域知识 → 迁 skill；对所有 subject 恒定 → 任务描述 → 留代码。

| 优先级 | Task（builder） | 留代码（任务描述） | 迁 SKILL.md（领域知识候选） | 备注 |
|---|---|---|---|---|
| **P0** | `AttributionTask` (`buildAttributionPrompt`) | 角色=错因归因器、输出 cause 字段契约 | `profile.causeCategories`（错因分类法全表）、`promptFragments.attribution*` | 错因分类是**最纯粹的领域知识**、跨学科差异最大，迁 skill 收益与示范性最高。**建议作 YUK-216 轨 1 首个落地样本** |
| **P0** | `NoteGenerateTask` / `NoteVerifyTask` / `NoteRefineTask` | 角色、Note artifact 输出结构、verify 检查项契约 | `profile.noteTemplate`、`promptFragments.note*`、范例策略 | 笔记模板是 owner 心智模型核心（知识图谱 + Note artifact），高价值；三 task 共享同一模板 → 一个 skill 服务三处 |
| **P0** | `QuizGenTask` / `QuizVerifyTask` | 角色、QuizGen 输出 schema、`generation_method='search_grounded'` + ≥1 source_ref 硬约束、三检门 | 学科出题纪律、题型模板、难度标定、`grounding.*` 口径 | **与 YUK-216 直接重叠**（spec 第 5 点"SubjectProfile 注入出题规范"+ U7 profile studio）。本 task 的领域段就是 YUK-216 的核心迁移对象 |
| **P1** | `SemanticJudgeTask` / `StepsJudgeTask` / `MultimodalDirectJudgeTask` | 判分角色、judgment 输出契约、R 红线（partial credit 语义） | `promptFragments.judge*`、学科判分口径、`languageStyle` | judge 链是 R1-R7 红线密集区，迁移**必须保留硬约束在代码侧**，仅迁"口径/风格"。中优先（风险高于 P0） |
| **P1** | `TeachingTurnTask` (`buildTeachingTurnPrompt`) | turn kind（explain/ask_check/end）输出契约、structured_question schema | `promptFragments.teachingStyle`、`checkQuestionPolicy`、`languageStyle` | YUK-213 提到的 teaching skill 成熟化与此相邻，但 YUK-213 是 cut-over 不是 prompt 迁移，**不要混并** |
| **P1** | `SolutionGenerateTask` | 解题输出结构 | 学科解题风格、grounding | |
| **P2** | `KnowledgeProposeTask` / `KnowledgeEdgeProposeTask` / `KnowledgeReviewTask` | 知识点/边提议输出契约、write_proposal 工具语义 | 学科知识组织口径、`promptFragments.knowledge*` | 知识图谱构建，领域段中等 |
| **P2** | `VariantGenTask` / `VariantVerifyTask` / `EmbeddedCheckGenerateTask` / `BlockAssemblyTask` / `StructureTask` / `TaggingTask` / `MistakeEnrollTask` / `SessionSummaryTask` / `LearningIntentOutlineTask` / `GoalScopeTask` / `UnitDimensionFallback` | 各自输出契约 | 各自 `promptFragments.*` 领域段 | 长尾，体量小，随主轴批量迁 |
| **不迁** | `VisionExtractTask` / `VisionExtractTaskHeavy` / `ReviewIntentTask` / `DreamingTask` / `CoachTask` / `CopilotTask` / `ReviewPlanTask` / `MemoryBriefTask` / `ProfileCriticTask` | 全部（registry-inline systemPrompt 即 SoT） | 无 | **9 个 subject-neutral pass-through**（`task-prompts.ts:762-787` 实证）：不走 profile builder，subject voice 由输入携带。**它们是 skills 路径的 MVP 验证起点**——本身无领域知识要迁，可先用其中一个验证"SDK skills 在 tmpdir 隔离下能否工作"的前置技术问题，再上 P0 |

**迁移顺序建议**：先解决前置技术问题（tmpdir 无 skills → 需在隔离 config dir 预置 SKILL.md，或确认 SDK 是否支持独立 skills 路径），用一个 pass-through task 做技术 spike → 再上 P0 `AttributionTask`（最纯领域知识、示范性最强）→ `Quiz*`（YUK-216 主体）→ `Note*` → P1 judge 链（保红线）→ P2 长尾批量。

---

## 4. 风险与不动清单（对齐过程绝不能破坏的不变量）

1. **【留痕】evidence 链不可断**：`ai_task_runs` / `cost_ledger` / `tool_call_log` / `event` mirror 四条落库路径（`log.ts` + `mcp-bridge.ts`）是 owner 留痕哲学的物理载体。迁 skill / 迁 outputFormat 时，**这些写库点位置/语义不得变**。尤其 #3 裁决：不要为了"代码中心化"把 `writeToolCallLog` 从 handler 迁 hook 而打散 log+mirror 的原子性。
2. **【单 session 语义】`persistSession:false` 不可改**：runner 每 task fresh session 是刻意设计（NAS 容器、`CLAUDE_CONFIG_DIR` 隔离）。引入 SDK session/sessionStore 会与 DB 持久化（#6）冲突且泄漏 tmpdir。Copilot 的"会话"语义永远在 DB `event` 表，不在 SDK session。
3. **【CLAUDE_CONFIG_DIR 隔离】tmpdir 隔离不可破**：`getIsolatedClaudeConfigDir()`（`runner.ts:211-220`）阻断开发机 `~/.claude/` 个人 hooks/MCP/skills 泄入 server 任务。**迁 skill 的前置坑**：当前 tmpdir 是空目录，SDK skills 不可用——落地 skills 时**不能**简单改成读 `~/.claude/`（会泄漏开发机配置），必须在隔离 config dir 内预置受控的 SKILL.md，或确认 SDK 是否支持 skills 路径与 config dir 分离。这是 §3 的头号技术前置。
4. **【R1-R7 红线】judge / KPI 分离不可碰**：P1 judge 链（`SemanticJudge`/`StepsJudge`/`MultimodalDirectJudge`）迁 skill 时，partial credit 语义、accept-chip KPI 分离 endpoint（YUK-213 标"永久保留"）等红线约束**必须留在代码侧**，只迁"口径/风格"软内容。红线是任务契约不是领域风格。
5. **【mimo endpoint 兼容】第三方 endpoint 不保证 SDK 高级特性**：mimo/xiaomi Anthropic-compatible endpoint 对 `outputFormat`(#2)、`betas:['context-1m-...']`、未来 SDK 在 spawn 前可能加的本地 model-id 校验**均无保证**。任何依赖 SDK 子进程侧高级协议的对齐（尤其 #2 outputFormat）**必须先 spike 实测**，不可盲迁。`json-sanitize.ts` 在 outputFormat 实测通过前是必须的防御层。
6. **【allowlist 审计性】静态白名单优于动态回调**：不要用 `canUseTool`(#4) 替 `allowedTools` 静态白名单——会把可审计的声明式权限变成运行时黑盒分支，违背留痕。
7. **【SDK 升级冒烟】#12 升级后必须验真实 AI 通路**：`tsc`/biome/vitest 都 bypass mimo 实际调用；升级 0.3.165 后必须跑一次真实 AI task 冒烟 + 全量 `pnpm test`，确认 mimo 通路未 break（非标准 model-id `mimo-v2.5-pro` 等仍被转发、无新增本地校验拦截）。

---

## 5. 建议落单

### 并入既有 issue（不新开）

- **prompt fragments → SKILL.md 主轴（矩阵 #1 / §3 全表）** → **并入 YUK-216 轨 1**。YUK-216 spec 第 5 点"SubjectProfile 注入出题规范"+ 关联 U7 profile studio 已是此轴的载体。建议把本报告 §3 迁移地图作为 YUK-216 拆 slice 时的 task 清单输入（评论附本报告路径）。
- **teaching skill 相关** → 注意 **不要并入 YUK-213**：YUK-213 是 legacy teaching/solve **cut-over 标准 + skills 成熟化（hintIndex/latency）**，不是 prompt→skill 迁移。两者相邻但正交，混并会污染 YUK-213 范围。

### 建议新开 Linear issue（标题草案）

1. **[spike] 验证 SDK `Options.skills` 在隔离 CLAUDE_CONFIG_DIR 下可用 —— prompt→skill 迁移前置技术验证**
   - 范围：用一个 subject-neutral pass-through task，在隔离 config dir 预置一个 SKILL.md，验证 `Options.skills` 能否在 tmpdir 隔离下加载 + `SDKSystemMessage.skills` 可观测。这是 §3/§4-3 的头号技术前置，YUK-216 轨 1 落地的卡点。建议链接 YUK-216。
2. **[spike] 验证 mimo endpoint 是否支持 `Options.outputFormat: json_schema`（矩阵 #2）**
   - 范围：实测 mimo + `outputFormat` 一个 task；通过则规划退役 `json-sanitize.ts`，不通过则记录并保留 sanitize 作防御。低/中优先。
3. **[chore] 升级 `@anthropic-ai/claude-agent-sdk` 0.3.143 → 0.3.165 + mimo 通路冒烟（矩阵 #12 / R7）**
   - 范围：`pnpm update` + 全量 `pnpm test` + 一次真实 AI task 冒烟，确认无新增 spawn 前 model-id 校验。低优先、低风险。
4. **[chore] runTask 路径加运行时断言：`def.needsToolCall && !ctx.mcpServers → warn`（矩阵 #3 观察项）**
   - 范围：防止 agentic task 误走 runTask 导致 tool call 静默不记录。小改动，护栏性质。

---

## 附：核实记录（本报告 SDK 断言均经签名核对）

- 安装版 `0.3.143` / 最新 `0.3.165` —— `package.json` + `npm view` 实测。
- `skills?: string[]｜'all'`（sdk.d.ts:1721）；JSDoc 实证"context filter, not a sandbox：未列 skill 文件仍可经 Read/Bash 触达"——支撑 #4 裁决。
- `outputFormat?: OutputFormat` / `JsonSchemaOutputFormat = {type:'json_schema',schema:Record<string,unknown>}`（sdk.d.ts:1516/861）——#2 SDK 侧能力属实，endpoint 支持性是独立未知量。
- `canUseTool?: CanUseTool`（sdk.d.ts:1216）；`settingSources?: SettingSource[]`（sdk.d.ts:1698）。
- `buildQueryOptions` 实传字段 / 未传 `skills`·`settingSources` / `persistSession:false` / `CLAUDE_CONFIG_DIR` tmpdir —— `runner.ts:211-264` 实读核对。
- `getTaskSystemPrompt` switch + 9 个 pass-through —— `task-prompts.ts:702-787` 实读核对。
- YUK-216 spec 第 5 点含"SubjectProfile 注入出题规范"+ 关联 U7；YUK-213 是 cut-over/skills 成熟化（非 prompt 迁移）—— Linear `get_issue` 实读核对。
