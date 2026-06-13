# ADR-0031 — Copilot 内联出题：`search` + `write_question_draft` 取代后台 QuizGen workflow（quiz C→A 形态）

**Status**: Accepted（2026-06-09）— owner go + D1–D5 已逐条拍板（见 §后果，标 RULED）。实现前提：本地 main 需先与 origin/main 对齐。
**Part of**: YUK-203（领域模型重构）。落地 quiz 的 **A 形态终局**，YUK-275 自标"不在本期"的那一步。
**Decision source**: 2026-06-09 grill 会话（owner 逐条澄清：copilot 当 orchestrator / inline 不抛后台 / 给 copilot search + write_question_draft 原语 / 重申 copilot 全工具读写）。
**Related**: `docs/superpowers/specs/2026-06-04-agent-framework-design.md`（**full safe capability** 原则 L67/L278/L292，本 ADR 的上位依据）· ADR-0025 ND-5（proposal-only 正主，只管破坏性改动）· ADR-0028（知识级 FSRS）· ADR-0029（tool_quiz 唯一容器 / 记忆治理 §3）· ADR-0011（tool_use 事件 + 卡片）· `.omc/research/copilot-implementation-audit-2026-06-07.md`（AP-1~4 / GZ-1）· YUK-262/272/275/284（quiz 现状 C 形态）· YUK-302（材料+小题 结构，被本 ADR 吸收为工具 schema）。

> **实现后注（2026-06-13，YUK-203）**：决定 1-7 **全部落地**——copilot 在自己 loop 内 `query_questions → author_question → write_quiz` 出题；`detectQuizIntent/resolveQuizIntent/runQuizSkill` pre-dispatch 已下线；方法论住 `src/subjects/_shared/skills/quiz-gen/SKILL.md`；结构由 `QuestionAuthorDraft` schema 兜（吸收 YUK-302）；draft+proposal 同事务 + user-accept gate；重 QuizGenTask/SourcingTask 降级夜间 pg-boss only。**工具命名以 ADR-0032 D8 为准**：标题与决定里的 `search` → `query_questions`（题池查重）+ Tavily MCP（联网，折进 copilot run）、`write_question_draft` → `author_question`（写）+ `write_quiz`（组卷）。D5（实现期任务）：U6 防循环红线原在 `quiz-skill.ts:51`，已随 C 形态拆除被删（文件不存在）→ 红线物理消失，无残留注待标。

---

## 背景

### 已锁的上位原则：Copilot 是全工具 agent

`agent-framework-design` 已定：**Copilot 始终持有 full safe capability set**——所有 read/propose 工具 + 路由已自带 scope 守卫的 user-triggered 直写工具；**proposal-only 仅约束破坏性 domain 改动**（ADR-0025 ND-5）。即"copilot 对用户应感觉完全有能力"，安全靠"破坏性改动走提案 + 全程 event 留痕可回滚"，**不靠削减它的工具面**。

### quiz 被特批排除，退化成 C 形态 workflow

与上位原则相悖，quiz 当前被**特意挡在 copilot 工具面之外**：
- **U6 防循环红线**：`COPILOT_TOOLS` **不含**任何出题工具（`quiz-skill.ts:51` 注释）。
- **YUK-272**：quiz 意图**拒绝 LLM 分类**，沿 teaching/solve 先例。

后果是 quiz 成了 Anthropic 分类里的 **workflow（routing 模式）**、而非 agent：
```
detectQuizIntent（关键词粗筛）→ resolveQuizIntent（独立小 LLM 解析参数）→ runQuizSkill（确定性执行：读池→assemble；池空→enqueue QuizGenTask/SourcingTask 后台 job）
```
**判断权和编排权都不在模型**（在 pre-dispatch TS）；真正的题目生成是 `QuizGenTask`/`SourcingTask` 两个**独立重 LLM agent**（~120s，pg-boss 后台）。owner 的原始抱怨（"出文言文阅读题 → QuizGenTask 启动三次 / 没正确切小题 / 离开对话"）正是这条解耦管线的症状，**不是 quiz bug**。

### owner 的目标形态

Copilot 当 **orchestrator（agent）**：它判断本次是"出整卷 / 出题组 / 出单题"，**在自己 loop 内动态编排**——用原语工具 `search` + `write_question_draft` 自己把题做出来。**不抛后台、不 spawn subagent**（worker = loop 内的 in-process 工具体，不是独立 agent）。这是 orchestrator-workers 模式的**最简实现**，零新基建（复用既有 MCP 工具面 PC-1/PC-2）。

---

## 决定

1. **给 Copilot 两个出题原语工具**（挂 `COPILOT_TOOLS`，**reverse U6**）：
   - **`search`**：题池查询 + 联网检索（联网复用既有 `TAVILY_MCP_ALLOWED_TOOLS`）。找现有题 / 找一篇文言原文素材。
   - **`write_question_draft`**：把 copilot 自拟的题**写成草稿**。入参是结构化的题（含题组形态）。
2. **判断+编排权交回模型**（**reverse YUK-272**）：copilot 在自己 loop 内 `search → 组「材料+一组小题」→ write_question_draft → 出卡`。出整卷 vs 出单题 = 模型自己决定 search/write 调几次、怎么组。`detectQuizIntent`/`resolveQuizIntent`/pre-dispatch 拦截下线。
3. **方法论 → SKILL.md**：copilot 出题时加载 **quiz-gen SKILL.md**（Step 1 已把 `ctx.skills` 接进 `CopilotTask`）。"怎么出好题"是知识，不焊进代码。
4. **结构保证 → 工具 schema（吸收 YUK-302）**：原 `QuizGenOutput` 的 Zod 结构守卫**搬到 `write_question_draft` 的入参契约**——其形状 = **StructuredQuestion 的「材料 stem + sub_questions[] 小题」树（Axis A）**，落库写一行 + `structured` jsonb（与 OCR 题组、/practice、判分同构）。**YUK-302 由"修 QuizGen handler"改为"定义 write_question_draft 入参 + 落库"**，长进本路。
5. **可逆即安全（对齐全工具原则）**：`write_question_draft` 写的是 **draft（非破坏性）**，surface 成提案卡；用户 accept → 升 active + 入 FSRS。符合 proposal-only（只管破坏性）+ full-capability 原则——**这是"安全写"，本就在 copilot 能力范围内**。
6. **重 agent 降级**：`QuizGenTask`/`SourcingTask` 保留**仅作夜间无人值守批量补库**（cron），**copilot 出题路完全不碰**。
7. **不引入 subagent 系统**：worker = loop 内 in-process 工具体；无 spawn、无第二上下文、无 pending 卡。

---

## 后果

**正面**
- Copilot 真正成为 inline agent（owner 的 OpenClaw 愿景）；"3x / 离开对话 / 不切小题"三症状随架构**自然消解**（无后台 fan-out、无 pre-dispatch、结构由工具 schema 兜）。
- **零新基建**：复用既有 MCP 工具面（PC-1/PC-2）；审计称此为"正确形态"。
- methodology=SKILL.md / 结构=工具 schema / 生成者=copilot，三者归位；quiz 重新对齐已锁的 full-capability 原则。
- 与 YUK-302 合流：结构修复不再单列，成为 `write_question_draft` 契约的一部分。

**代价 / 风险 / 开放决策 — 2026-06-09 owner 已逐条拍板**
- **D1 · 记忆治理 carve-out** — **【RULED = feature】**：copilot-as-generator 读记忆出个性化题是 **intended**（"专挑你常错的知识点出题"是想要的；Dreaming 等本就是记忆消费者**且**产出者，copilot 同理）。**为 ADR-0029 §3 显式开 copilot carve-out，不在 write 路径前隔离记忆。** 后台 QuizGen/Sourcing 的记忆隔离不变（另议）。
- **D2 · verify gate 去留** — **【RULED = A，交用户】**：verify gate **直接交用户**（user-accept = gate）；copilot 内联路**不设**独立 `verify` 步，信任 SKILL.md + `write_question_draft` schema。（后台批量补库路是否保留 QuizVerify，另议。）
- **D3 · 生成质量 eval** — **【RULED = 不配（copilot 路）】**：copilot 内联生成**不设** eval harness；后台 QuizGen/Sourcing 的 eval **另开议题**，不属本 ADR。
- **D4 · 重活延迟** — **【RULED = inline + streaming，不抛后台】**：联网 sourcing 慢时用 streaming 显示进度（"正在检索/出第 N 题…"），**不**退化为 pending 卡、**不**抛后台。`search` 的超时与失败降级文案为实现细节。
- **D5 · 显式 reverse 记录**（实现期任务）：U6（防循环红线对 quiz）与 YUK-272（quiz 不走 LLM 分类）被本 ADR 推翻，实现时在 `agent-framework-design` / 对应 issue 注 superseded-by ADR-0031，避免后人误引旧红线。

---

## 备注：这是"全工具 copilot"原则的一个实例

owner 重申的"copilot 应全工具、读写都有权限"**已是 `agent-framework-design` 锁定原则**（L67/L278/L292），本 ADR 只是把被 U6/YUK-272 特批排除的 quiz **拉回该原则**。若后续要把同样逻辑推广到其它被特批排除的能力（如 ingestion 编辑工具、D7 记忆写），宜各自走 ADR 或在 `agent-framework-design` 增补，而非在本 ADR 扩面。

**前提**：实现须建在 origin/main（本地 main 落后 85，需先 `git pull`）。
