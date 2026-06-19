# Structured-Output / SDK `outputFormat` 迁移审计

> 日期：2026-06-08 ｜ 范围：全仓 37 个 AI task 的「模型输出 → 结构化」产出方式
> 方法：全枚举 + 逐项深评（脆弱点 / 收益 / 风险 / 工作量）
> 触发：评估哪些 task 值得迁到 SDK `ClaudeAgentOptions.outputFormat={type:'json_schema',schema}`（结果回 `ResultMessage.structured_output`，SDK 强制 schema + `error_max_structured_output_retries` 自动重试）

---

## 0. TL;DR（先读这段）

- **现状：全仓 `outputFormat` 用量为零**（`grep -rn outputFormat src/` → 0 命中，已实测）。所有结构化 task 都走「模型自由文本 → `text.indexOf('{')..lastIndexOf('}')` char-scan 裁剪 → `JSON.parse` →（多数）Zod parse」。`runner.ts` 的 `buildQueryOptions`（:339-382）从不传 `outputFormat`，`runTask`（:434）只读 `msg.result` 文本、丢弃 `SDKResultSuccess.structured_output`（sdk.d.ts:3371）。SDK 能力属实（sdk.d.ts:1516/861/3336/3371，版本 `^0.3.143`），**但 runner 一行接线都没有**。
- **两条硬阻塞挡在所有迁移之前**：
  1. **mimo endpoint 兼容性未验证（YUK-218，硬 gate）**：运行时是 xiaomi/mimo Anthropic-compatible 代理，非真 Anthropic；`outputFormat:json_schema` 是否被端点 honor 从未实测。审计 `docs/audit/2026-06-05-agent-sdk-alignment.md` §5 R5 / 矩阵 #2 明令「必须先 spike，不可盲迁；通过才迁，失败则 `json-sanitize.ts` 保留作防御层」。
  2. **runner 通用 `outputFormat` seam 尚未建**：需在 `buildQueryOptions` 透传 `outputFormat`、在 `runTask` 读 `msg.structured_output`、在 `RunTaskResult`/`TaskTextResult`/seam 函数签名上加 `structured_output` 字段。这是跨全部 ~20 个 task 的共享路径改动。
- **关键纠正（与本批 briefing 前提冲突，已核实）**：briefing 称「YUK-285 将给 teaching turn 首次接入 outputFormat，扩展 runner seam 后其它 task 可搭便车」。**核实 `docs/superpowers/plans/2026-06-08-yuk-285-plan.md` + Linear YUK-285：YUK-285 实际是把 teaching one-shot 重构成 free-form 工具调用 loop（引入 `set_teaching_state` DomainTool），并退役 `TeachingTurnTask`，根本不接 `outputFormat`，也不建 runner outputFormat seam。** 即：**当前没有任何已规划的工作会建出这条 seam。**「搭 YUK-285 便车」的假设不成立。
- **结论**：值得做，但**必须先开一个独立的「runner outputFormat seam 基建」issue**（YUK-218 spike 绿灯后），把它作为 epic，所有 migrate/defer 候选作为该 epic 的批量 follow-on。**不要逐文件改 handler**（会让每个 task 各自趟一遍 runner，重复且易漂移）。

---

## 1. 总览：枚举分类统计（37 项）

| 分类 | 数量 | 含义 |
|---|---:|---|
| `prompt-convention-json`（解析模型自由文本拿结构化） | **31** | char-scan + `JSON.parse` +（多数）Zod。**这 31 个是 outputFormat 的潜在受益面。** |
| `plain-text-ok`（纯文本 / tool-calling，无文本 JSON 解析） | **6** | SessionSummary / ReviewIntent / Copilot / Dreaming / KnowledgeReview / ReviewPlan。**保持现状。** |

在 31 个 `prompt-convention-json` 里，按深评裁决再分：

| 裁决 | 数量 | task |
|---|---:|---|
| **migrate**（迁移信号强，技术上成立，待 seam + spike 解锁后优先迁） | 7 | AttributionTask · TaggingTask · GoalScopeTask · TeachingTurnTask · StepsJudgeTask · MultimodalDirectJudgeTask · VariantVerifyTask |
| **defer**（迁移成立但被 spike/seam 阻塞，或收益被现状缓和，作为批量第二/三梯队） | 9 | MistakeEnrollTask · MemoryBriefTask · LearningIntentOutlineTask · NoteRefineTask · QuizVerifyTask · CoachTask · EmbeddedCheckGenerateTask · QuizGenTask ·（+ 下列未单独深评但同模式的长尾） |
| **同模式长尾（未单独深评，随批量迁）** | 15 | KnowledgeProposeTask · KnowledgeEdgeProposeTask · MistakeEnrollTask(列上) · BlockAssemblyTask · StructureTask · VisionExtractTask · VisionExtractTaskHeavy · NoteGenerateTask · NoteVerifyTask · EmbeddedCheckGenerateTask(列上) · SemanticJudgeTask · UnitDimensionFallback · VariantGenTask · SolutionGenerateTask · SourcingTask · ProfileCriticTask · QuizVerifyTask(verify-framework 裸 cast) · TeachingTurnTask(solve-skill 分支) |

> 注：上表分类有重叠（同一 task 在不同口径里出现），核心结论不依赖精确归桶——**31 个同模式 task 共享同一条 runner seam，迁移轴是「先建 seam，再批量」，不是「逐个分级」。**

**最脆的一个例外值得单独点名**：`EmbeddedCheckGenerateTask`（`embedded_check_generate.ts:87-109`）**不走 `json-sanitize`**（teaching/solve 走），裸 `JSON.parse` 无控制字符清理——模型在 string 内吐裸换行/裸 tab 直接抛。这是一个与 outputFormat 解耦的**短期防御缺口**，可立即补一层 sanitize（见 §5）。

---

## 2. 建议迁 outputFormat 的清单（按优先级排）

> 所有项的「工作量」均以「runner seam 已由独立 epic 建好」为前提估算。若 seam 未建，每项各自 +M 的 runner plumbing 成本——这正是要把 seam 抽成独立 epic 的原因。
> 所有项都**保留 Zod safeParse 作为纵深防御**（structured_output 类型是 `unknown`；且 cross-field / id-subset / 长度不变式 JSON Schema 表达不了，必须保留 app 层校验）。

### P0 — 第一批迁移候选（spike 绿灯后立即做，作为 seam 的首个真实消费者）

**1. AttributionTask** — 优先级 high / 工作量 S（seam 后）
- 脆在哪：free text → enum schema，零重试。observe 路径单次坏输出静默丢草稿。
- 收益：SDK 强制 enum + 自动重试，消 char-scan。
- 风险：低。纯领域知识任务、示范性最强（审计 §迁移顺序点名为 P0 首迁）。

**2. VariantVerifyTask** — 优先级 high / 工作量 M
- 脆在哪：char-scan + `JSON.parse` + Zod，零重试；坏 JSON = 整 pg-boss job 重投（重新付费 LLM）。这是会 flip `mistake_variant.status='broken'` 的质检任务，少误判直接提数据质量。
- 收益：verdict/cause_targeting 两 enum 钉死合法值 + SDK 重试。结构干净（`needsToolCall:false`/`isMultimodal:false`/`maxIterations:1`），是**教科书式单次结构化抽取**，适合作 runner outputFormat 的**首个非交互试点**。
- 风险：中低、非阻塞。测试需从「mock `{text}`」改「mock structured 通道」。**纠正初筛**：所谓「off_target→fail post-hoc 关联逻辑」核实后不存在（只是 prompt 软指令），outputFormat 真实收益是 enum 强制 + 重试。

### P1 — judge 链（grading-critical，保红线后迁）

**3. StepsJudgeTask** — 优先级 high / 工作量 M
- 脆在哪：char-scan 无视嵌套/转义；零重试；长度不变式（`signal_verdicts.length == expected_signals.length`，partial-credit 分母 N）靠 app 层事后补救，错配→评分静默作废。
- 收益：array/enum/`confidence∈[0,1]` 提前到生成约束层 + SDK 重试，把「单次格式抖动→整条 grading 作废」降为「重试后成功」。**长度相等 JSON Schema 表达不了**（需动态 minItems/maxItems），:271 运行期校验保留。
- 风险：中低。grading-critical，迁移收益高。

**4. MultimodalDirectJudgeTask** — 优先级 high / 工作量 M
- 脆在哪：char-scan 在 `feedback_md` 含 `}`/代码围栏时 `lastIndexOf('}')` 越界；零重试；失败塌成 `unsupported`，**浪费一次昂贵 vision 调用**且学生答案不评分。
- 收益：同 StepsJudge——enum + score range 钉死 + 重试，把「浪费昂贵 vision 调用→unsupported」变自纠正 loop。
- 风险：低-中。**必须保留** `composeJudgeResult` 的 outcome→score-band clamp（:88-118，是有意业务逻辑，不是 parse workaround）。与 StepsJudgeTask **同源同批迁**。

### P2 — ingestion / orchestrator 长尾（批量迁，单个收益中等）

**5. TaggingTask** — 优先级 med / 工作量 M（seam 后降 S）
- 脆在哪：三层脆解析 + 零重试；坏 token → block 进人工 review，丢一次自动化。
- 收益：消 char-scan + SDK 重试。**`knowledge_id` 不要做成 schema enum**，保留 server 端 grid-id 过滤作 belt（防幻觉）。
- 风险：低-中。

**6. GoalScopeTask** — 优先级 med / 工作量 M
- 脆在哪：brace-scan + `JSON.parse` + Zod，三 throw 点零重试；失败塌成 `EMPTY_RESULT`，**与「模型合法地提议了空」无法区分**（静默退化）。
- 收益：消 brace-scan + 重试 + 失败信号变锐。**MemoryBriefTask 是同源第二消费者**（显式「same archetype」），同批。保留 id-subset 过滤。
- 风险：低。

**7. TeachingTurnTask** — 优先级 med / 工作量 M ⚠️ **特殊**
- 脆在哪：3 层 band-aid（char-scan + 控制字符 sanitize-retry + `choices_md` string→array 强转 + kind 降级），每层都是真实生产故障的补丁。残留坏 JSON → 502 用户可见失败。
- 收益：schema 强制 + SDK 重试，直击 502 路径；可退役本 task 的控制字符 sanitizer。
- 风险 / ⚠️ **与 YUK-285 的冲突**：**YUK-285 实际要退役 TeachingTurnTask**（改 tool-loop + `set_teaching_state`），`parseTurnOutput` / `TeachingTurnOutput` schema **保留**用于 loop 内解析出题片段。所以：
  - 若 YUK-285 先落 → TeachingTurnTask 作为独立 task 消失，**本迁移目标转移到「loop 内出题片段的解析」**——届时 outputFormat 的适用面变窄（tool-loop 里的结构化片段 vs 单次结构化输出），需重新评估。
  - **建议：TeachingTurnTask 的 outputFormat 迁移与 YUK-285 互斥**——不要假设 YUK-285 会顺带建 seam（它不会）。若先做 outputFormat seam epic，可把 teaching 的 `structured_question` 解析作为 loop 内 outputFormat 的探索点；但 YUK-285 的 tool-loop 方向是 owner 已拍板的主线，outputFormat 在 teaching 上是次要。
  - 还须审 solve/hint 共消费者（`solve.ts:167` `parseHintTurn`、`solve-skill.ts:94`，共享同一 sanitize shim，只要 `text_md`）——superset schema 或 per-call-site gating。保留 `choices_md` 强转/降级作 post-validation normalization（strict schema 会 hard-fail 这些产品级 leniency）。

---

## 3. 保持现状的（为何 OK）

### 3a. `plain-text-ok` — 纯文本消费，无 JSON 解析（6 个，天然不需要 schema）
- **SessionSummaryTask**（`summary.ts:180`）：`result.text.trim().slice(0,240)`——散文摘要，软 cap，无解析。已核实。
- **ReviewIntentTask**（`review.ts:628-631`）：`.slice(0,80)` 单行 ribbon 散文。已核实。
- **CopilotTask**（`chat.ts:614,625`）：`result.text` 当 `reply_md` 散文；结构化副作用走 tool calls，不解析文本。**这正是「通用对话不该强制 schema」的典范**——强制 schema 会扼杀对话。
- **DreamingTask** / **KnowledgeReviewTask** / **ReviewPlanTask**：tool-calling agent，mutation 经 `propose_*` / `write_proposal` / `write_review_plan` DomainTool，无文本 JSON 解析。**tool 已是更强的结构化通道**——比 outputFormat 更适合 agentic 多步 mutation（留痕走 mirror event）。

> 判据④（通用文本对话不该强制 schema）只对这 6 个成立。其余 31 个输出纯机器消费，强制 schema 语义正当。

### 3b. 已被现状部分缓和、但仍 defer（收益真实但被 Zod + 降级路径吸收）
- **MemoryBriefTask** / **NoteRefineTask** / **CoachTask**：已有 required-key Zod / `TodayPlan.parse` / `NotePatch.parse` + 非破坏性失败路径（保留旧数据 / 降级 placeholder）。outputFormat 的净增量只剩「消脆解析 + 重试」，非「防脏数据落库」。且若干「初筛卖点」核实后 **outputFormat 表达不了**：
  - NoteRefine 的 ghost `block_id` 是**引用完整性**（id 必须存在于本 note body_blocks），JSON Schema 表达不了——必须靠下游 pre-apply 存在性检查，与 outputFormat 解耦。
  - MemoryBrief 的 invented evidence id 由 D3 subset 过滤防住，JSON Schema 表达不了 cross-field membership。
  - QuizVerify 的 `overall == sub-verdict rollup` 由 handler 独立重算防住（不信任模型 overall），且 conditional 必填（material 存在才必填）JSON Schema 表达不了。

---

## 4. 与 YUK-285 的关系（重要纠正）

**briefing 前提**：「teaching 是首个接入 outputFormat 的，streamTask 扩展后其它流式 task 可复用同机制——指出哪些能搭便车」。

**核实后结论（与前提冲突）**：

1. **YUK-285 不接 outputFormat。** `docs/superpowers/plans/2026-06-08-yuk-285-plan.md` + Linear YUK-285 实际方案 = teaching one-shot → free-form **工具调用 loop**，模型经 `set_teaching_state({phase, question_id?})` DomainTool **显式写会话状态**（`teaching_idle/explaining/awaiting_answer/digression` 四态状态机），判分由系统触发。**末步（commit 7）退役 TeachingTurnTask**（schema + `parseTurnOutput` 保留作 loop 内解析 + eval 基线）。
2. **YUK-285 不建 runner outputFormat seam**，也不碰 `streamTask`/`buildQueryOptions` 的 outputFormat。它走的是 tool-calling 路线（与 §3a 的 tool-calling task 同范式），**与 outputFormat 是两条正交的结构化通道**。
3. **没有「搭便车」可言**——当前没有任何已规划工作会建出 runner outputFormat seam。本批所有 migrate/defer 候选若想迁，**得有人先建 seam**。
4. **teaching 与 outputFormat 的真实关系**：YUK-285 落地后，teaching 的结构化需求由「显式状态工具 + loop 内出题片段解析」承载；TeachingTurnTask 作为独立单次 task 消失。**所以 teaching 不再是 outputFormat 的好首发场景**——它正在往 tool-loop 走。**更干净的 outputFormat 首发试点是 VariantVerifyTask 或 AttributionTask**（单次、非流式、非交互、纯结构化抽取）。

> 一句话：briefing 把「YUK-285 会铺 outputFormat seam」当既定事实，实际 YUK-285 走的是 tool-loop，seam 仍是空白。**outputFormat 迁移需要自己的基建 issue，不能寄生在 YUK-285 上。**

---

## 5. 系统性建议：基建 epic + 批量迁移，而非逐个迁

**强烈建议：做一个「runner outputFormat 基建 + 批量迁移」epic，不要逐个 handler 改。** 理由：

1. **31 个同模式 task 共享同一条 runner 路径**（`buildQueryOptions` / `runTask` / `RunTaskResult`）。逐个改 = 每个 task 各自趟一遍 runner plumbing，重复劳动 + 易引入不一致 + 多次回归全 ~20 个不传 outputFormat 的 task 的默认行为。
2. **char-scan + `json-sanitize.ts`（83 行状态机）是全仓共享脏活**，一次性收口的 ROI 远高于零散退役。
3. **解锁顺序是确定的链**，逐个迁会让每个 task 都重复走一遍这条链：

```
YUK-218 spike 绿灯（mimo 支持 json_schema？）
   ├─ 失败 → json-sanitize 永久保留作防御层；本审计所有 migrate 候选转 keep（记录归档）
   └─ 通过
        └─ [新 epic] runner outputFormat seam 基建
             ├─ buildQueryOptions 透传 ctx.outputFormat（默认 undefined = 旧行为，零回归）
             ├─ runTask 读 msg.structured_output → 挂上 RunTaskResult / TaskTextResult / seam 函数签名
             ├─ error_max_structured_output_retries 错误分支处理（sdk.d.ts:3336）
             ├─ Zod → JSON Schema 转换（仓内无 zod-to-json-schema；Zod v3 无原生 toJSONSchema，需引依赖或手写）
             └─ 留痕红线：ai_task_runs / cost_ledger / tool_call_log / event 四条落库点语义不得变
                  └─ [批量迁移] P0(Attribution/VariantVerify) → P1(Steps/MultimodalDirect judges) → P2(Tagging/GoalScope/MemoryBrief/长尾)
                       每个 task：传 schema + 读 structured_output + 保留 Zod 二次校验 + 保留 cross-field/id-subset/长度 app 层校验 + 改测试
```

4. **与 YUK-219（SDK 升级 0.3.143→0.3.165）协同**：升级动机本就含 outputFormat 能力线 bugfix 跟进，seam 基建应在升级后的 SDK 上做。

**判据④反向**：6 个 `plain-text-ok` + DreamingTask/KnowledgeReview/ReviewPlan 这类 tool-calling agent **不进 epic**——它们要么是对话散文，要么 tool 已是更强结构化通道。

---

## 6. 证据锚点（关键文件 / 行号）

- runner 无 outputFormat 接线：`src/server/ai/runner.ts:56-64`（RunTaskResult 无 structured_output）、`:339-382`（buildQueryOptions 不传 outputFormat）、`:434`（只读 msg.result）
- SDK 能力：`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:861`（JsonSchemaOutputFormat）、`:1516`（outputFormat）、`:3336`（error_max_structured_output_retries）、`:3371`（structured_output）；版本 `package.json` `^0.3.143`
- 全仓零用量：`grep -rn outputFormat src/` → 0
- 审计裁决（硬阻塞）：`docs/audit/2026-06-05-agent-sdk-alignment.md` 矩阵 #2（裁决 B）、§5 R5（mimo endpoint 红线）、§下一步行动 #2（spike，:100-101）
- YUK-285 实为 tool-loop（非 outputFormat）：`docs/superpowers/plans/2026-06-08-yuk-285-plan.md`（:34 现状 one-shot、:46-51 loop+set_teaching_state、:89 TeachingTurnTask 退役注释、:116 parseTurnOutput 保留）
- 最脆例外（无 sanitize 裸 JSON.parse）：`src/server/boss/handlers/embedded_check_generate.ts:87-109`（对比 teaching.ts:20 走 sanitizeJsonStringLiterals）
- plain-text-ok 已核实：`src/server/session/summary.ts:180`、`src/server/orchestrator/review.ts:628-631`

---

## 7. Linear 捕获门

**已存在、覆盖前置阻塞的 issue（无需新建）**：
- **YUK-218**（Backlog/Medium）— `[spike] 验证 mimo endpoint 是否支持 Options.outputFormat: json_schema`。**这是所有迁移的硬 gate。**
- **YUK-219**（Backlog/Medium）— SDK 升级 0.3.143→0.3.165 + mimo 通路冒烟（含 outputFormat 能力线）。
- **YUK-285**（Backlog/Medium）— teaching tool-loop（**不是 outputFormat**，本审计已澄清二者正交）。

**建议新建的 issue（见 issue_recommendation）**：
1. **runner outputFormat seam 基建 epic**（当前无 issue 覆盖，YUK-285 不建此 seam）——依赖 YUK-218 绿灯。所有 migrate 候选挂为其 follow-on。
2. **`embedded_check_generate.parseOutput` 补 json-sanitize**（短期防御小 issue，effort S，与 outputFormat 解耦）——本 handler 是唯一不走 sanitize 的裸 JSON.parse，独立可立即修。
3.（可选）**NoteRefine ghost `block_id` 下游 pre-apply 存在性检查**——引用完整性 outputFormat 治不了，是独立健壮性 gap，需自己的设计 call。
