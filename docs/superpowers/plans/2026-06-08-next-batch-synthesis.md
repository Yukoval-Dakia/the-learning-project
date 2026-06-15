# 2026-06-08 Next-batch 统合报告（6 issue）

> 统合 agent 产出，基于 6 份 lane plan + critic verdict 汇总。
> 目的：让 owner 一眼看清——先做哪些、哪些等 owner 拍、哪些能并行。
> 源 plan：`docs/superpowers/plans/2026-06-08-yuk-{296,249,288-s3,289,293,285}-plan.md`

---

## 1. 一句话结论

- **能立刻开工（零 owner gate、零跨 issue 阻塞）**：YUK-296（纯清理，FINAL）。
- **需先 fix critic REVISE 再开工、但无 owner ADR gate**：YUK-293（sourcing caused_by dangling ref 必须先纠正）。
- **L 级、是下游 blocker，应优先排上游**：YUK-249（wenyan→yuwen 改名，blocks 289/288）——但有 2 处 migration critic REVISE 必修。
- **依赖上游分支/上游 issue，且 critic REVISE**：YUK-289（按科浏览，依赖 288；nav ROUTE_MAP 漏项必修）、YUK-288-S3（编辑/删除接线，依赖 281+288 同处上游分支）。
- **owner ADR gate 卡死**：YUK-285（teaching 进 loop）——Commit 1 = ADR 草案，**owner 拍 5 个 ADR 决策前不写实现代码**。

---

## 2. 依赖图

### 2.1 声明的依赖（来自各 plan 的 depends_on / blocks）

```
                          已 Done / 已 merge（前置基建）
   YUK-284 (Done) ──┬──> YUK-285   (ADR gate, teaching loop)
                    ├──> YUK-293   (仅 MCP scope-A 受阻；确定性写端不受阻)
                    └──(refs)      YUK-296

   YUK-164 (在飞 PR) ─┐
   Security 审计 PR ──┼──> YUK-249 (wenyan→yuwen 改名, L)
   YUK-228 (Done) ────┘        │
                               ├──> YUK-289 (按科浏览, L)
                               └──> YUK-288-S3 (题库 edit/delete, M)

   YUK-281 (写端点) ─┐
   YUK-288 S1 ───────┴──> YUK-288-S3   （二者同处 origin/yuk-288-question-bank-ui-s1）

   YUK-288 (PR #357 merged origin/main) ──> YUK-289

   YUK-296  ── 独立，无 blocks / 无 blockedBy
```

### 2.2 可并行 vs 必串行

| 关系 | 判定 | 依据 |
|---|---|---|
| YUK-296 | **完全独立**，可与任何 issue 并行 | depends_on=[], blocks=[]；文件与其它 lane 零重叠（note/quiz resolver） |
| YUK-293 in-scope（确定性写端 + vocab） | **不受 YUK-284 阻塞，可并行**；只有 MCP scope-A defer | plan §0.1 明确：sourcing/tagging/block-assembly 是 code-invoked，不碰 prompt/allowlist |
| YUK-285 | **被 owner ADR gate 串行卡住**；ADR 拍板前只能产 Commit 1 | plan GATE：Commit 1 ADR → 停 → owner 拍 5 点 |
| YUK-249 → YUK-289 / YUK-288-S3 | **逻辑下游**：289/288 的 subject tab id / alias 依赖 249 的改名落地 | 249 plan §9 列 blocks；289 plan §7「实施时确认 origin/main alias 现状」 |
| YUK-289 与 YUK-288-S3 | **可并行**（彼此无交集，纯只读 vs 写交互，触及文件不重叠） | 288-S3 plan §10「YUK-289 parallel」；289 plan §7「YUK-281 无依赖」 |
| YUK-289 / YUK-288-S3 内部 commit | 各自链式 3 commit，图谱/删除单独 commit 便于 revert | 各 plan §5/§7 |

### 2.3 ⚠️ 一处需 owner 厘清的分支拓扑矛盾（load-bearing）

两份 plan 对 **YUK-288 当前在哪** 给出不一致的事实，会影响 289 与 288-S3 的切分基点：

- **YUK-289 plan**（§开头 + §7）：YUK-288 = **PR #357，已 merged origin/main**（2026-06-08T02:31:23Z）。`resolveSubjectKnowledgeIds` / `app/api/questions/route.ts` / `app/(app)/questions/page.tsx` 已在 origin/main。
- **YUK-288-S3 plan**（§1.1, D0）：S1 + YUK-281 写端点 **不在 main**，同处 `origin/yuk-288-question-bank-ui-s1` 分支；本地 main 上 `app/(app)/questions/**` 与 write 端点不存在。

可能的真相：**S1（只读 UI + domain helper）已随 #357 进 origin/main，而 YUK-281 写端点（PATCH/DELETE）仍只在 `origin/yuk-288-question-bank-ui-s1` 未单独合并**。若如此：
- YUK-289 从 fresh **origin/main** 切分支正确（它只需 S1 的 helper + 范式，不需写端点）。
- YUK-288-S3 仍需从 **`origin/yuk-288-question-bank-ui-s1`** 切（它需要 PATCH/DELETE 端点）。

→ **决策点 D-TOPO（见 §5）**：开工前 owner/lead 必须 `git fetch` 后实测 origin/main 上是否已有 `app/api/questions/[id]/route.ts` 的 `PATCH`/`DELETE` export，据此定 288-S3 的切分基点；两 plan 的 Step-0 校验脚本都已要求此核验。

---

## 3. 建议实施顺序 / 批次

> 排序逻辑：① 无 gate + 无阻塞 + 已 FINAL 的先走（快速清债）；② REVISE 但无 owner gate 的紧随（fix 后即可开）；③ L 级下游 blocker（249）尽早，但等其 critic 必修项落实 + 上游 PR merge；④ 依赖 249 的 289/288-S3 并行跟进；⑤ owner ADR gate 的 285 单独排，拍板前只产 ADR。

### 批次 A（立即可开，并行）
1. **YUK-296**（S, FINAL）— skill resolver 同步 fs → async。零 gate、零阻塞、文件不与任何 lane 重叠。最快收口的债。
2. **YUK-293**（M, REVISE）— agent-notes 写端扩面 + copilot vocab。**先纠正 critic 必修项**（sourcing `caused_by_event_id=triggerEventId` 是 dangling ref，且「sourcing = 完整 evidence chain」论断为假——这会动摇 D4 排序），再开工。in-scope 不受 YUK-284 阻塞。

### 批次 B（上游 blocker，等必修项 + 前置 PR）
3. **YUK-249**（L, REVISE）— wenyan→yuwen。是 289/288-S3 的逻辑上游，应尽早排，但需：
   - **先落实 2 处 critic 必修**（M1：migration 漏迁 `goal.subject_id` 这条 domain 轴，有重复 goal 风险；M2：见 249 critic 第二条）；
   - **前置 PR 先 merge**：YUK-164 在飞 sweep PR + Security 审计 PR（避免大面积 fixtures 冲突，249 plan §9）。
   - 同一 PR 原子部署（migration + 注册表 + UI 数据字段），不可拆 deploy。

### 批次 C（依赖 249，可两 lane 并行）
4. **YUK-289**（L, REVISE）— 按科浏览（错题/笔记/图谱）。**先修 critic 必修**（nav-config.ts 漏 `ROUTE_MAP` 条目，否则 /notes 入口路由失效）。从 fresh origin/main 切。
5. **YUK-288-S3**（M, FINAL）— 题库 edit/delete 接线。从 `origin/yuk-288-question-bank-ui-s1` 切（待 D-TOPO 厘清）。与 289 无文件交集，可并行。

> 289 与 288-S3 都软依赖 249 的 alias/displayName 终值；若 249 尚未 merge，两 lane 须在 plan 里对齐「使用迁移后 subject id」，或排在 249 merge 之后启动以免返工。

### 批次 D（owner ADR gate）
6. **YUK-285**（L, FINAL + 2 处 lane 内 over-claim 待修）— teaching 进 loop。**Commit 1 = ADR 草案后停，等 owner 拍 5 个 ADR 决策**。拍板前不写实现。可与上面任一批并行产 ADR，但实现段被 gate 卡住。

### recommended_order
`YUK-296` → `YUK-293` → `YUK-249` → `YUK-289` → `YUK-288-S3` → `YUK-285`

（296/293 可同时起；285 的 ADR 草案可在任意时点并行起草，但其实现排最后因 owner gate。）

---

## 4. 每 issue 一行计划摘要 + 风险 + critic

| Issue | Sz | critic | 一行计划 | 最高风险 | owner gate |
|---|---|---|---|---|---|
| **YUK-296** | S | **FINAL** | 两 resolver（note-skills / quiz-gen-skills）全部同步 fs（5×existsSync+1×readdirSync）改 async，5 handler 加 await，2 单测改 async。issue 描述的 `copilot-skills.ts`/`resolveCopilotSkills`/DI 改异步均不存在，scope 已校正 | `quiz_gen.ts:454` filter 异步谓词——改 async 后 `resolveQuizGenSkills()` 返 Promise（恒 truthy），必须 `Promise.all` 预算 bool，否则静默 bug（tsc 抓不到） | 无 |
| **YUK-293** | M | **REVISE** | agent-notes 从 quiz_verify 单 writer 扩到 sourcing/tagging/block-assembly 三确定性写端 + `AgentNoteTarget` 加 `'copilot'` vocab。MCP 化 + copilot reader defer 到 YUK-284 后 | **critic 必修**：sourcing `caused_by_event_id=triggerEventId` 是 dangling ref，「sourcing=完整 evidence chain」论断为假——动摇 D4「sourcing 最干净」排序，须纠正 caused_by 取法 | 无（in-scope 不受 284 阻塞；D1-D4 是方向确认非硬 gate） |
| **YUK-249** | L | **REVISE** | wenyan→yuwen：①migration 0029 迁 domain 值（不改节点 ID）②注册表/profile/目录 git mv + alias 兼容 ③graph 工具过滤核实+回归测试 ④UI 默认 profile 数据字段。零树重构、零 subject 列 | **critic 必修 M1**：migration 漏迁 `goal.subject_id` 这条 domain 轴（数据完整性 + 重复 goal 风险）；M2 见 critic。R1 seed 重复插入（ID 前缀须与 domain 解耦） | D1-D4（见 §5；D2b displayName 语文 vs 文言文 须拍） |
| **YUK-289** | L | **REVISE** | 错题/笔记/图谱三只读面加 subject 派生轴过滤，零 schema 变更。复用 288 的 `resolveSubjectKnowledgeIds` + 空集 `sql\`false\`` 语义 + SUBJECT_TABS 范式。新建 /notes list API+页 | **critic 必修**：nav-config.ts 改动清单漏 `ROUTE_MAP` 条目，/notes 入口路由失效会返工。最高功能风险=图谱 props 接口变更 + `passesFilter` alias-aware 语义升级（触 exported 单测） | D-1~D-5（见 §5；D-2 列表面默认 __all vs 按科、D-5 passesFilter 语义升级须拍） |
| **YUK-288-S3** | M | **FINAL** | 在 S1 只读详情页解除 disabled 编辑/删除，接通 YUK-281 PATCH（乐观锁编辑）+ DELETE（两段式：409 取关联计数→confirm 软删）。新建 DeleteModal | DELETE 首段不能走 apiFetch（丢 associations body）须裸 fetch；编辑/删除 CSS 未随 S1 ported，须从设计 questions.css port（transform-only 动画红线）；分支拓扑（见 §2.3） | D0 切分基点 / D1 Closes 关键字 / D2 children 计数端点改 / D3 知识点 add defer（见 §5） |
| **YUK-285** | L | **FINAL**（+2 lane 内 over-claim） | teaching 从 one-shot 短路迁进 free-form loop，模型用 `set_teaching_state` 显式写四态状态机（idle/explaining/awaiting_answer/digression）；awaiting_answer+active question 确定触发判分。**先出 ADR** | R5 ask_check 物化原子性（推荐：物化仍在 chat.ts tx 内，工具只声明状态）；判分 race（连出两题判最新）；over-claim 须 lane 内修正 | **5 个 ADR DECISION（硬 gate，拍前不实现）**（见 §5） |

---

## 5. 全部 owner 决策点汇总

> 按「硬 gate（拍前不实现）」与「方向确认（可带推荐默认推进）」分层。

### 5.1 硬 gate — YUK-285（ADR，拍板前不写实现代码）
- **285-D1**：`set_teaching_state` 是 DomainTool 还是结构化输出字段？（推荐 tool——free-form 已 streaming 文本，塞 JSON 字段打架；tool 天然留痕，与 293 写工具同向）
- **285-D2**：ask_check 物化原子性方案？（推荐 A：工具只声明状态，物化仍由 chat.ts 在单 tx 内做，完全保留 PR #305 原子性；B 工具内物化破坏原子性，不推荐）
- **285-D3**：awaiting_answer→判分触发语义 + digression 回 awaiting_answer 转移条件？（推荐：判分=上条 reply.teaching_phase==='awaiting_answer' 且 active_question_id 非空，确定性触发；digression 答完以模型下轮声明为准 + active-question 兜底）
- **285-D4**：`set_teaching_state` 进 COPILOT_TOOLS 还是单独 teaching surface？（推荐进 COPILOT_TOOLS，靠 SKILL.md 约束——单独 surface 与「skill≠surface」R5 硬约束张力大）
- **285-D5**：`CopilotTask.budget.maxIterations`（当前 6）是否上调容纳 teaching loop？（一轮 teaching≈2-3 iter；与 YUK-290 context budget 关联，不够建议上调 8-10）

### 5.2 方向确认 — YUK-249（可带推荐默认推进，但 D2b 建议明确拍）
- **249-D1**：migration 策略——纯 data-only UPDATE，用 `drizzle-kit generate --custom` 产空壳手填 SQL（避免 journal 漂移）。确认接受 custom data migration 形态。
- **249-D2a**：合成根 id `'wenyan'`→`'yuwen'`（推荐 yuwen，与 math/physics 拼音体系一致）。
- **249-D2b**：displayName `'文言文'`→`'语文'`（扩科，为现代文/作文留位，与 issue 标题一致）还是保 `'文言文'`？倾向 `语文`，**待 owner 拍板**。
- **249-D2c**：seed 节点 ID 前缀——强烈推荐保持 `seed:wenyan:*`（解耦 ID 与 domain，规避 knowledge_edge FK 无 cascade + 多张表 jsonb 数组 + view 级联重写高风险）；反方案连 ID 迁高风险。
- **249-D3**：effective_domain 派生方式——维持查询期祖先 walk（推荐，无性能问题；物化列判定过早优化不做）。
- **249-D4**：memory_brief_note scope_key unique 冲突——撞 unique 时 migration fail-loud（推荐，单用户冷启动不会撞 + 测试覆盖冲突）vs ON CONFLICT DO NOTHING。

### 5.3 方向确认 — YUK-289
- **289-D-1**：三面同批一个 wave（3 commits 单 PR）vs 分批？图谱风险最高，最适合单拆独立 PR——owner 定要不要拆。
- **289-D-2**：默认视图——列表面（错题/笔记）默认 `__all` 全部科目 vs 默认第一个 subject？图谱默认第一个 subject（避免 hairball）。owner 确认列表面是否也默认按科。
- **289-D-3**：笔记面过滤轴范围——仅列表 + 科目 tab（不加 note type/verification 状态等额外轴）。owner 若想更丰富需扩 scope。
- **289-D-4**：笔记 subject OR 语义——跨科笔记按「至少一个 knowledge_id 命中」(OR) 归入该 subject，与题库一致（已定，知情确认）。
- **289-D-5**：图谱 `passesFilter` 语义升级——从「raw domain 等值」升级为「alias-aware subject 等值」(resolveKnownSubjectId)，口径统一但触 exported 单测。owner 若想最小改动可保留 raw 等值 + 仅 displayName 映射（alias 场景可能漏匹配）。

### 5.4 方向确认 — YUK-288-S3
- **288-S3-D0**：分支拓扑/切分基点——S3 从 `origin/yuk-288-question-bank-ui-s1` 切（需 PATCH/DELETE 端点）；与本报告 §2.3 的 **D-TOPO** 同源，开工前实测 origin/main 是否已含写端点 export。
- **288-S3-D1**：Linear——无独立 YUK-288-S3 issue（S3 是 S1 phase-deferred 项）。(a) 建 sub-issue/S3 标识 还是 (b) 复用 YUK-288 收尾——决定末 commit 的 Closes 关键字。
- **288-S3-D2**：删除关联计数 children——端点 `countQuestionAssociations` 只返 4 字段，设计稿 DeleteModal 要第 5 行「N 道小题挂此大题下」。方案 A（推荐）端点补 children SQL；方案 B UI 降级不渲染。附 D2b：children 是否计入 `has_associations` 语义。
- **288-S3-D3**：知识点 add——全仓无现成 autocomplete。方案 A（推荐，范围内）只做 remove，add 按钮 disabled+tooltip+开 follow-up；方案 B 自建 autocomplete（超范围 +1~2h）。

### 5.5 方向确认 — YUK-293
- **293-D1**：MCP wrapper 做不做？默认 DEFER（copilot 无 reader 消费 for_agent='copilot'，MCP writer 会写 dead notes；且 MCP 化触 copilot allowlist/systemPrompt 受 YUK-284 阻塞）。owner 确认 vocab-first，还是要本 lane 就做（须同批落 copilot reader）。
- **293-D2**：tagging signal_kind——新 `tagging_gap` vs 复用既有 `coverage_thin`？推荐复用（vocab 收敛）。
- **293-D3**：copilot reader 消费方位置——唯一候选 `src/server/copilot/chat.ts`，plan defer 到 YUK-284 后。owner 接受 vocab-first / reader-with-284 还是本 lane 接 reader。
- **293-D4**：确定性写端优先级——sourcing > tagging > block-assembly（按干净度）。**注意 critic：sourcing 的「完整 evidence chain」论断为假，此排序依据须随 caused_by 纠正后复核**。owner 可砍任一低价值写端。

### 5.6 跨 issue 协调点（非单 issue 决策，统合补充）
- **D-TOPO**（§2.3）：开工前实测 origin/main 上 `app/api/questions/[id]/route.ts` 是否已含 PATCH/DELETE export，定 288-S3 切分基点；YUK-289 一律从 fresh origin/main 切（rev-list HEAD..origin/main 必须为 0）。
- **D-249-FIRST**：289/288-S3 软依赖 249 的 alias/displayName 终值。owner 定：289/288-S3 是排在 249 merge 之后启动，还是并行但 lane 内对齐迁移后 subject id（避免 fixtures/alias 返工）。

---

## 6. critic verdict 速查

| Issue | verdict | 必修项（REVISE）/ 待修 over-claim（FINAL） |
|---|---|---|
| YUK-296 | FINAL | 无返工项 |
| YUK-288-S3 | FINAL | 无返工项（9 项 load-bearing 断言实测坐实） |
| YUK-285 | FINAL | 2 处 lane 内 over-claim（已落 ADR/GATE 边界内，实施 lane 修正，不强制重构 plan） |
| YUK-293 | **REVISE** | sourcing `caused_by_event_id` dangling ref + 「sourcing=完整 evidence chain」假论断（动摇 D4 排序） |
| YUK-289 | **REVISE** | nav-config.ts 漏 `ROUTE_MAP` 条目（/notes 入口路由失效会返工） |
| YUK-249 | **REVISE** | M1 migration 漏迁 `goal.subject_id` domain 轴（重复 goal 风险）+ M2 第二处返工项 |

> 3 个 REVISE 的必修项都应在各 lane **开工前**吸收进 per-lane plan（lane 现场对 fresh main 重写时落实），不要带病开工。
