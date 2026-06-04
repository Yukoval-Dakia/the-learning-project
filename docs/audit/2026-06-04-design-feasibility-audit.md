# 三份新设计文档可行性综合审计（2026-06-04）

> **范围**：审计 2026-06-03/04 提交的三份 design doc，评估其相对当前 `origin/main`
> 代码现实、已锁决策（`docs/design/2026-06-03-target-domain-model.md`，下称 **TDM**）、
> 已 Accepted ADR（0014/0025/0027）和在途分支（YUK-203 P3 / ADR-0028、YUK-169 redraw）的可行性。
> **方法**：9 份独立审计 + 6 份 critic + 1 份 cross-critic 的发现，全部经一轮对抗验证
> （adversarial verifier）逐条复核；本报告**只收 upheld 或未被驳回的内容**，每条判断带
> file:line 证据（路径相对 `/tmp/tlp-docs-sync` = origin/main HEAD `fac65397`）。
> 对抗验证对全部 30 条发现给出 **upheld=true**，无一被驳回（见附录 A）。

三份文档（简称）：
- **CO** = `docs/superpowers/specs/2026-06-03-coach-led-review-engine-design.md`
- **PS** = `docs/superpowers/specs/2026-06-03-editable-profile-studio-design.md`
- **AF** = `docs/superpowers/specs/2026-06-04-agent-framework-design.md`

---

## 1. TL;DR

| Doc | 可行性定级 | 最大风险 | 一句话建议 |
|---|---|---|---|
| **CO**（Coach-led Review Engine） | **需重新设计**（产品 intent 保留，数据模型重做） | 7 张新表里 2 张（`knowledge_review_state`、paper 容器栈）**正面违反同日已锁的 TDM §7 决策**并与在途 ADR-0028 抢同一所有权 | 砍到 0 必需新表 + 至多 1 张按需表；先把 FSRS-by-knowledge 归属（ADR-0028 vs 新表）作为 ADR 级裁决定下来，再动任何 migration。 |
| **PS**（Editable Profile Studio） | **改后可做**（裁到 MVP） | 为 3 个 `1.0.0` 纯数据 profile 造 4 张 DB 表 + 4 个 agent task + 7-tab UI，是典型的"第二个实例之前就抽象"；旗舰 due-queue 预览**无可模拟对象** | 用 git+`audit:profile`+1 个 `ProfileCriticTask`+1 个只读 admin page 即可覆盖产品环；DB 表无限期推迟。 |
| **AF**（Agent Framework） | **改后可做**（地基扎实，序列错） | 文档 6 个 slice 全部挂在一个**根本不存在的 chat composer**（前端是占位字符串）上；Slice 6 实为 CO 的子集，是 phantom slice | 先补一条文档没写的"Slice 0：上线 Copilot chat composer"（需与 YUK-169 协调），砍掉 Slice 6 改为交叉引用 CO。 |

**三 doc 共同的根因**：CO 与 TDM 同日（2026-06-03）写成，在两个最大数据问题上得出**相反结论**，且仓库正在实现 TDM 那版。三份文档各自独立列 slice，over-produce 容器与 task。统一序列见第 4 节。

---

## 2. 逐 doc 审计

### 2.1 CO — Coach-led Review Engine

产品 intent（知识点是排期对象、paper 是 UX、judge-now/show-later 缓冲反馈、Coach 主导编排）**正确且应保留**。问题全在数据模型与 slice 序列。

#### CRITICAL — 与已锁决策正面冲突

**[F1 / CD-1 / CR-1 / C1 / X1 / P1-no-knowledge-review-state-table] `knowledge_review_state` 新表重新裁决了一个已锁决策，并与在途 ADR-0028 抢所有权。**（置信 0.92–0.95，多审计独立证实）
- TDM `docs/design/2026-06-03-target-domain-model.md:124`（决策 #1，标注"已锁 2026-06-03"）锁定：`material_fsrs_state` 走 `subject_kind='knowledge'`，到期的是知识点，per-question 态退役为派生/历史信号。
- `src/db/schema.ts:627-644` 证实 `material_fsrs_state` 已是泛化 `(subject_kind, subject_id)` 唯一键；`schema.ts:631-632` 注释明言 `subject_kind` 是 `'question' for Phase 1c.1; other material kinds in later phases` 的泛化点。
- ADR-0028（commit `f85aca6d`，Status Accepted 2026-06-03，仅在未合并分支 `yuk-203-p3-knowledge-fsrs`）正是实现这条：re-key 到 `(subject_kind='knowledge', subject_id=knowledge_id)`，决策 #5 还前向迁移并 DELETE 旧 question 行，submit 事务里按 knowledge id 取 `pg_advisory_xact_lock`。`git show f85aca6d:src/server/fsrs/state.ts` 确认 `upsertFsrsState` 入参已放宽到 `'question'|'knowledge'`（`FsrsSubjectKind` type）。
- CO `:224-241`（§2.4）+ `:339-350`（§3 SQL）却定义全新表 `knowledge_review_state`，自带 `mastery_estimate`/`uncertainty`；CO `:766-768`（§9）反过来禁止旧 `material_fsrs_state` 充当"第二个 scheduler owner"——**文档制造了它自己警告的那个第二所有者**，且全程未引用 TDM 决策 #1、未引用 ADR-0028。
- 额外：`knowledge_mastery` PG view（`schema.ts:766`，ADR-0012）已从 events 派生 `mastery`/`evidence_count`/`last_evidence_at`，CO 存 `mastery_estimate` 会与"mastery 是派生不是存储"原则（ADR-0012）冲突。

**更优替代（已验证 CD-1/C1/P1）**：删掉 `knowledge_review_state`，复用 `material_fsrs_state(subject_kind='knowledge')`（ADR-0028）。`scheduler_state jsonb` = 现有 `state jsonb`（`FsrsStateT`，schema.ts:635）；`last_evidence_event_id` = 现有 `last_review_event_id`（schema.ts:637）；`due_at` 已存在（schema.ts:636）。这是 write-path 改动，零 DDL/零 `audit:schema` 债。若日后真需非 FSRS policy（mastery bands / uncertainty sampling），届时再按"第二个实例"规则拆——这是文档自身的 §13 non-goal。

#### HIGH — 在已存在的机制上重造

**[F4 / CD-2 / CR-4 / C3 / X3 / P2-no-paper-judgement-evidence-tables] `paper_judgement` + `paper_evidence_result` 重建已存在的 event-sourcing judge/evidence 链。**（置信 0.85–0.92）
- `app/api/review/submit/route.ts:16-21` 头注释确认：judge 结果**内嵌**在 review event 的 `payload.judge`（"mirrors embedded-check pattern"），刻意**不**另开 `action='judge'` 事件。
- `schema.ts:201-204` 确认 Phase 1c.1（ADR-0006 v2）已 DROP 掉 `mistake` + `review_event` 专表，让 event 成为唯一 evidence ledger。`JudgeOnEvent`（`src/core/schema/event/known.ts:49-62`）payload 仅 `{cause, referenced_knowledge_ids}`；`AttemptOnQuestion`（known.ts:25-41）携带 outcome/answer/duration/referenced_knowledge_ids。
- CO `:493-516`（§5）新增 `paper_judgement`+`paper_evidence_result` 作为新持久表，**部分反转**了上述已落地决策。
- TDM `:55`（"做组卷里的题 = attempt event…喂同一套 FSRS/mastery，**不另记**"）进一步锁死"不另开记录"。

**更优替代（已验证 CR-4/F4/C3）**：judgement 建模为 `event(action='judge', subject_kind='event', caused_by_event_id=<attempt>)`，payload 带 `judge_route`/`score`/`coarse_outcome`/`feedback_md`；knowledge 级 evidence 走 event 流 + `knowledge_mastery` view。**唯一真正新需求**是 §1.5 的"隐藏判分 / 缓冲反馈"（`visible_to_user`）——events 今天无法表达 mutable visibility（doc:488/501）。这只需 judge event payload 上一个 `visible_to_user` boolean（或 `revealed_at timestamptz`），不是一张表。保留 `paper_answer`/`paper_question_assignment` 作为真正新的"答题卡 envelope"（当前模型只有一个 `response_md` string，submit route 确认）。

**[X2 / 经 coach-critic-simplicity Finding 2 验证] `review_paper_attempt` + `paper_question_assignment` 与刚 ship 的 `tool_quiz` artifact 重叠。**（置信 0.92）
- TDM `:125`（决策 #2，已锁）：组卷 → 复用 `tool_quiz`（artifact 带 `question_ids` 引用题池），不单立 `question_set`；daily/final/嵌入小测/试卷都用 tool_quiz。
- 已落地：`tool_quiz` 在 `ArtifactType` enum（`src/core/schema/business.ts:103`）；`src/server/boss/handlers/quiz_gen.ts:401` 插入 `type:'tool_quiz'` artifact，`:416` 带 `metadata.question_ids`。`embedded_check: {question_ids}` 引用形已存在（`business.ts:234`）。
- CO `:440-517`（§5）全程**零次**提及 `tool_quiz`/`question_set`/组卷，造了平行的 `review_plan`→`review_paper_attempt`→`paper_question_assignment` 容器栈，未与已锁的 `tool_quiz` 调和。

**更优替代（已验证 P3 / X2，置信 0.82）**：把 paper 建模为 `tool_quiz` artifact（section/assignment 结构进 `body_blocks`/`metadata` jsonb），plan 本身是 event（`experimental:review_plan`），运行中的 attempt 是 `learning_session(type='review')`（已存在）。复用 artifact+event+learning_session 三个现成机制，而非三张新表。一个可接受的产品切分：`tool_quiz` = 用户主动发起的按需测验（不被 FSRS 排期，TDM §4 line 93）；`review_plan`/paper = Coach 排期的自适应复习（新）——但这条区分必须**在两份文档里显式写出**，否则就是 TDM §2.4 要消灭的"两个容器装同一个概念"。

#### MEDIUM/feasible-with-changes — 可做但需改

**[CD-4] `question.metadata.review_profile` blob 方案正确，但 metadata 无任何写时校验。**（置信 0.9）`question.metadata` 是 `jsonb $type<JsonObject>`，无 Zod/CHECK（`schema.ts:183`）。`auto-enroll.ts:347-357` 写整个 metadata 对象字面量（含 `workflow_judge` 嵌套 blob），存在 clobber-on-write 风险。`audit-schema-writes.ts` 用 regex 解析 pgTable 列声明（`parseSchema` at 315+），**看不见 jsonb 内部 key**，所以 `metadata.review_profile` 的 provenance/confidence 会无声漂移、零 drift 保护。**建议**：在 profile-generation task 的输出 handler 加 `ReviewProfileSchema` Zod parse barrier（写点，非 DB 约束），匹配仓库"parse at boundary"纪律。

**[CD-5 / F3] `part_ref = StructuredQuestion.id` 前提成立，但有 re-extraction 悬挂风险。**（置信 0.88）`FigureRef.attached_to_index` 已是指向 `StructuredQuestion.id` 的既有约定（`structured_question.ts:29-30`）。但 id 由 `createId()` 在 parse 后铸造、每次抽取都重铸（structure.ts 注释 "VLM does NOT emit cuids — assign createId() after parse"），所以任何存下的 `part_ref` 在 question 被 re-extract 后会悬挂。CO 正确禁止用 array index/ordinal 做 `part_ref`（doc:157-161），但**未规定** re-extraction 时历史 coverage/assignment 行如何 invalidate/remap——是 gap，需补规则。

**[F8] §4 answer-slot 分类法完全是 greenfield，且对 structured-less 题池无解。**（置信 0.83，含主观工作量判断）`StructuredQuestion`（`structured_question.ts:85-116`）有 id/role/prompt_text/sub_questions 但**无** `answer_shape`/`inline_blank`/`cloze` 字段；`choices_md` 平铺在 question 行（`schema.ts:159`）。`quiz_gen`+`embedded_check` 写的 question **无 structured 字段**，所以 `review_profiles_by_part_ref`（键于 `StructuredQuestion.id`）**无法覆盖一大片 AI 生成题池**，而 §3 resolution rule（doc:307-315）对 structured-less 题只有 whole-question fallback。结论：Slice 2 是文档**最贵、近期价值最低**的 slice，应推迟到 Slice 3/5 证明 Coach 主导论点之后。

**[F9] Slice 4 dynamic paper UI 与在途 YUK-169 redraw 冲突，且与当前 card 页架构不兼容。**（置信 0.72，有 caveat）当前 `/review`（`app/(app)/review/page.tsx`）由 `/api/review/submit` + 单个 `response_md` string 驱动 + 即时 per-question judge——paper UI 需**全新 surface 而非演进**。YUK-169 redraw 已合 slices 1-3c（knowledge-focused），`/review` paper 重设计尚未开始。**Caveat（降置信）**：被引为 gate 的 `docs/design/2026-06-04-redraw-today-7a-preflight.md` 在本 origin/main worktree 里**不存在**（git status `??` 未追踪，"untracked"字面为真），且它针对 today surface 而非 /review，所以"the active UI gate"措辞略偏；但 Slice 4 应排在最后、过 design-doc pre-flight 的结论仍成立。

**[F11 / CR-2 / CR-3 / F6 经 coach-sequencing 验证] ReviewPlanTask 的 5-tool 边界完全可行，机制已现成；但 5 个工具里 3-4 个是 greenfield。**（置信 0.95）`DOMAIN_TOOL_ALLOWLISTS`（`allowlists.ts:155-163`）+ `resolveMcpAllowedTools`（:176-181）+ `buildMcpServerFromRegistry`（`mcp-bridge.ts:133-149`，遇未知 tool 在 :142 抛错）已是 battle-tested 的 per-surface 边界机制，加一个 `review_plan` surface 是一行改动。但 grep 证实 `ReviewPlanTask`=0、6 个命名工具各=0、`search_memory_facts`=0；`query_memory_brief` 存在（`context-readers.ts:1199`，在 4 个 surface 上）。所以边界免费，**工具本体才是 Slice 3 的活**，且 `search_memory_facts` 是 phantom 依赖，必须先实现或从契约里删。

#### CO 该 KEEP / 该 CUT 汇总（经验证）
- **KEEP**：知识点为排期对象（经 ADR-0028）；paper UX（section/分组/共享 stem）作为 `tool_quiz` artifact 上的渲染层；judge-now/缓冲反馈（一个 `visible_to_user` 字段）；Coach 主导 + 可审计 plan（registry `allowedTools` + plan event + 薄读工具）；`review_profile` 在 `question.metadata`（正确，无 migration）；"不先删旧队列"的兼容迁移。
- **CUT**：`knowledge_review_state`→`material_fsrs_state(knowledge)`；`review_plan`→plan event；`review_paper_attempt`→`tool_quiz` artifact+`learning_session(review)`；`paper_question_assignment`→artifact/plan 内 jsonb；`paper_answer`→`event(action='attempt')` payload；`paper_judgement`→`event(action='judge')` payload+`visible_to_user`；`paper_evidence_result`→event 流+`knowledge_mastery` view；`scheduler_policy`/`model_version` 列→延到第二 policy 实例。
- **KEEP-but-DEFER**：`question_knowledge_coverage`（7 张里最有道理的一张，因带 role/strength/part_ref 的真 m2m 在 jsonb array 里别扭）——但延到 Coach candidate-selection 真要它时再 materialize；若首个 Coach loop 靠 `knowledge_ids`+metadata 就能 rank，这表永不需存在。
- **净效果**：7 张新表 → MVP 0 张必需、1 张按需。

---

### 2.2 PS — Editable Profile Studio

核心架构论点（profile 是纯数据、可端到端编辑、runtime 只解析 published snapshot）**成立且代码同意**。但对一个 3 subject / 全 `1.0.0` / 偶尔手改的单用户工具，整套 Studio（7-tab UI + 4 agent task + 4 DB 表 + taxonomy board + route matrix + fixture console）**严重超配**。

#### CRITICAL/HIGH — 抽象先于第二实例

**[SR-1 / S1 / P3] profile.ts 是纯数据，4 张 DB authoring 表是为单用户重造 git。**（置信 0.8–0.95）三个 `profile.ts` 都只 `import type { SubjectProfile }`、export 单个对象字面量（grep 无 function/=>/class/value-import；wenyan/math/physics 全文核对）；每个字段都是 JSON-serializable 原语/数组/对象。`SubjectProfile` 即 `z.infer<typeof SubjectProfileSchema>`（`profile-schema.ts:74`）。`git log -- 'src/subjects/*/profile.ts'` = 8 commits，全走普通 feature PR。**结论**：一个可版本化/可 diff/不可变/分支即 draft 的带 publish 记录的存储**就是 git**，这些 profile 已在 git 里且是 serializable data。

**更优替代（已验证 S1/S3，置信 0.8）**：profiles 保持纯数据 .ts；编辑环 = agent 改 `profile.ts`（纯数据，executor 直接 emit 字面量）→ `pnpm audit:profile`+`validateProfile` 是 gate → git 即 snapshot/draft/patch/history，`git revert` 即 rollback。**0 张 DB 表**。`subject_profile_*` 4 表无限期推迟（文档 §5/§11 自己也说 v1 file-backed、首 slice 不迁 DB）。

**[SR-3 / S2 / STUDIO-4 / P1] 历史可解释性不变量未达成：events 不 pin `profile_version`。**（置信 0.85–0.92，PS §0 把整个设计压在此不变量上）
- 无 `profile_version` 持久化（grep 在 `src/core/schema` + `src/db/schema.ts` 退出码 1，0 命中）。`JudgeOnEvent.payload` 仅 `{cause, referenced_knowledge_ids}`（`known.ts:56-59`）。
- **重要事实订正（S1 验证发现的过度断言）**：`JudgeInvocationTelemetry` **确实**被写进 review event。`app/api/review/submit/route.ts:235-246` 经 raw `writeEvent`（`queries.ts:1020+`）把 `judge.capability_ref` + `judge.telemetry` 嵌进 review event payload。所以 review 路径上 route+capability_ref+subject_id **已持久化**，唯独缺 `profile_version`，且 `capability_ref.version` 是硬编码 `'1.0.0'`（`question-contract.ts:92,239`；`steps-judge.ts:10`），不源自 registry manifest 或 `SubjectProfile.version`。
- "哪个 profile version 在判时生效"**今天不可重建**——这是真 gap。

**更优替代（已验证 S2，置信 0.85）**：给 `JudgeOnEvent.payload` 加 3 个可选字段 `judge_route`/`capability_ref`/`profile_version`（判时已在内存里，只是被丢弃）。profile body 在 git 里以 `profile.version`+SHA 为键不可变，则 event 的 `{profile_version, capability_ref}` 就是完整不可变回指针。这是该 doc 唯一真 correctness 前提的最便宜修法，**应作为第一个 slice**，排在 Studio UI 之前。注意：此 event-version stamping 是 PS 与 CO 共享的基础设施（CO 的 `paper_judgement` 也缺 profile_version），**只造一次**。

**[SR-4 / S3 / P3] admin 页路由不被 middleware server-gate；Studio 写操作必须走 `/api/*`。**（置信 0.83–0.92）`middleware.ts:43` matcher 只是 `/api/:path*`，`app/(admin)/**` PAGE 路由**服务端无鉴权**，靠客户端 `TokenGate`（`layout.tsx:33`，`TokenGate.tsx:15-17` 读 localStorage）。`(admin)` group 已存在（runs/cost/failures + `/api/admin/{runs,cost,failures}` 都已 middleware-gated）。**安全约束**：Studio 的 publish/patch 必须路由经 `/api/admin/subjects/*` 才能继承 token gate；page Server Action 会绕过 matcher。单用户单 token 模型对此工具足够，但需在文档写明"单 token 即唯一授权"。

#### MEDIUM — 可做的廉价价值点 / 该砍的预览

**[SR-7 / S6 / P4] 真正该修的 bug：`audit:profile` 应遍历 registry。**（置信 0.9）`pnpm audit:profile`→`scripts/audit-profile.ts:44-54` 调 `validateProfile()`（§9.3 大部分是这一个现成调用）。但 `audit-profile.ts:28-32` 把 `auditSubjectProfiles = {wenyan,math,physics}` 硬编码成 const，`runCli()`（:103）以它为默认入参驱动，**不**走 `SubjectRegistry`——第 4 个 subject/draft 没加进 const 会**静默通过**。`validateProfile`（`validate-profile.ts:136-178`）已实现 §8 七个 publish gate 里约 6 个。§8 引的 2026-05-30 drift gap（prompt-section refs / fallback-family / pipeline-schema 兼容）准确（drift doc §D-ii 正列这 3 个）。**建议**：~5 行改动让 audit iterate registry + 实现这 3 个 drift-flagged 不变量——最高价值/最低风险的首 slice。

**[SR-8 / S4 / P2] ProfileImpactTask 的 due-queue 预览**无可模拟对象**。**（置信 0.85–0.9）`src/server/review/` 内 grep `simulate|dryRun|preview|forecast|getRetrievability|projectDue` 退出码 1（0 命中）；真实排期（`fsrs.ts:35 scheduleReview`）在写事务里 mutate。三个 profile 全 `default_policy:'fsrs'`（wenyan:113/math:106/physics:106），default registry 只注册 `fsrsSchedulerCapability`（`judges/index.ts:31`），所以"改 scheduler policy"**没有第二 policy 可切**、due-queue delta 结构上恒空。**更优替代（已验证 S4，置信 0.83）**：砍掉 due-queue 模拟，改展示 route-resolution diff——`resolveQuestionJudgeRoute()`（`question-contract.ts:117`，纯函数无 DB）对样本题跑 old-vs-draft，是今天**唯一真会变**的 impact（judge routing）。

**[P5] cause-id 改名的隐藏耦合需 lint 守护。**（置信 0.85）`rating-advisor.ts` 的 `causeLean()` 硬编码 cause-id 字符串（`careless`/`carelessness`→+1，`concept`/`conceptual*`→-1），与 `causeCategories` 在不同模块且 `validateProfile` 无交叉检查；`variant_gen.ts:209-213` 用 `causeCategories.find(c=>c.id===cause.primary_category)`，找不到就 `skipped:cause_not_targetable`。一次过 §8 gate 的 cause-id 改名会**静默杀死 rating nudge 并破坏 variant targeting**。**建议**：加 lint/validate 守护，比 taxonomy-board UI 更便宜。

#### PS 该 KEEP / 该 CUT
- **KEEP（MVP）**：`SubjectProfileDraft`+`ProfileImpactReport` Zod schema（S）；draft-JSON→validate→diff compile 脚本（S，CLI-first）；profile→TS 字面量 serializer（S，roundtrip 缺的那半，今天无 codegen helper）；`ProfileCriticTask`（单发、无工具、无 DB，最高价值）；只读 `/admin/subjects` page（复用 `(admin)` layout+TokenGate）。
- **DEFER**：`ProfileAuthorTask`（executor 直接 emit 即可）；route-diff 预览（有用但可延）；event `profile_version` stamping（除非真要历史可解释性，否则连同 §0 断言一起延）。
- **CUT**：`ProfileImpactTask` due-queue 模拟（最罕见的编辑、无 harness）；cause-taxonomy board + subject_id rename/alias/fork classifier（MVP 改为**屏蔽**这两类编辑，正好对 §0"无字段锁定"做精准反转）；`subject_profile_*` 4 张 DB 表（git 即存储，无限期延）。
- **净效果**：建表 0（vs 4）；新 agent task 1（vs 4）；新 event 字段 3；UI 1 页（vs 7-tab + 4 个 bespoke editor）。

---

### 2.3 AF — Agent Framework

文档**地基扎实**（正确点名了真 substrate：`learning_session(type='conversation')`、DomainTool allowlists、experimental-event 逃生口；non-goal 清醒）。风险全在**序列**。

#### HIGH — 序列缺口

**[AF-3 / agentfw-critic-product 验证] Copilot chat composer 根本不存在；文档从未把它列为 slice。**（置信 0.85）chat **后端完整**（`runCopilotChat`，`src/server/copilot/chat.ts:172-333`，含 MCP bridge、双 surface 路由、ask/chip 事件写入、可选 Tavily）；chat **前端是占位**——`src/ui/today/TodayCopilotDrawer.tsx:107-109` 字面是 `<p>Wave 5 / T-D3/C 上线后这里会接入 chat…</p>`，无 composer/message list/streaming；文件头注（:1-8）自称 "A placeholder chat surface"。grep 确认无任何 UI 调 `/api/copilot/chat`。§6"Known gaps"列了 Today-shaped/工具面窄/teaching 分离等，**唯独没列"chat 是 stub"**，而 §1.1/§1.5 + Slices 2/3/4 全假设"一条连续 chat"已存在。**建议**：插入显式"Slice 0 — 上线 Copilot chat composer"，排在 Slice 2/3 前，且 gate 在 YUK-169 today-7A redraw 上（该 redraw 正改这个 drawer 的 mount，否则 markup 被改两次）。

**[AF-5（teardown）/ AF-4] 把 Active Teaching 并入 Copilot 是真拆解（两 UI / 两后端 / 两 session 入口）。**（置信 0.85–0.88）七处引用全核对：page-local `<TeachingDrawer/>` mount 在 `learning-items/[id]/page.tsx:460`；独立后端 `/api/teaching-sessions/[id]/turn`→`planTeachingTurn`（route 88-93）；`TeachingTurnTask` 是 `needsToolCall:false`+`allowedTools:[]`（`registry.ts:398-414`）的 3-way 判别联合（`teaching.ts:42-51`），与 Copilot 的 tool-loop 执行形不同；`ask_check` 在 route 110-128 做 raw `tx.insert(question)`；5-state 机在 `conversation.ts:54-92`，`goal_id` 持 `learningItemId`。**关键**：`ask_check` 的 raw question INSERT 正是 §1.2 line 63 禁止 Copilot 做的直接 DB mutation——并入时应把它留作窄服务路径而非 Copilot 工具。**建议**：作为**最后**一个 user-facing slice，迁移期保留 teaching route 并行；并保留 corrective-chip 的独立 endpoint（它刻意分离以免污染 chat-turn KPI）。另：Solve（`app/api/questions/[id]/solve/route.ts:4-5`，`learning_session(type='tutor')`）是被 Slice 4 遗漏的**第三个** surface。

**[AF-7] Slice 6"Coach owns review planning"不可独立构建——它就是 CO 文档本身。**（置信 0.92，全集最高）`coach.ts:20-24` `ReviewSessionProposal = {count, estimated_minutes}`（纯标量，无 knowledge focus/候选选择）；`coach.ts:58-60` `TodayPlan.review_session_proposal` 引的正是该标量；`coach_daily.ts:178-180` output_schema 只提示 `review_session_proposal`。grep 确认 `review_plan`/`knowledge_review_state` 表、`get_review_knowledge_snapshot`/`select_review_question_candidates`/`write_review_plan`/`ReviewPlanTask` **全部不存在**。Slice 6 是对 CO 自己 Slices 1-3 的 1:1 依赖，留在本文档就是 phantom slice。**建议**：从 AF **砍掉** Slice 6，改为交叉引用——"Coach 复习编排归 CO spec 所有；本框架只提供 agent-purpose 框定（Coach=planner）与 `leave_agent_note` 通道"。

#### MEDIUM/feasible — 其余 slice 的真实成本

**[AF-2] Copilot drawer 已全局 mount；文档"Today-shaped surface"框定夸大了 gap。**（置信 0.9）drawer mount 在 shell layout（`app/(app)/layout.tsx`）而非 today 页，sidebar+topbar 按钮从每个 `(app)` 路由驱动。真正 Today-shaped 的只是 summary payload + drawer title + 文案。`CurrentUserContext` envelope 是 greenfield：grep `CurrentUserContext` across src/+app/ 零命中，只存在于 AF §5（:285-311）；`CopilotChatRequest`（`chat.ts:55-63`）只带 `{user_message, triggered_by, chip_kind}`，无 route/surface/active_refs 上下文 envelope。**建议**：拆 Slice 2 为 2a（改文案，S）+ 2b（context envelope，L）；context envelope 先落 v0（route + 单 active_ref），延后 `selection.*` + 多 active_refs。

#### AF 推荐序列（经 agentfw-sequencing 验证）
Slice 1（文档 + agent-objective docs + 标 ADR-0004 superseded，S）→ **新 Slice 0**（chat composer，M，gate 在 YUK-169）→ Slice 5（`leave_agent_note`，S，零 schema，独立，可与 Slice 0 并行）→ Slice 2a（去 Today 文案，S）→ Slice 3 拆（turn 持久化 + replay-last-N，M，跳过 summarizer）→ Slice 2b（`CurrentUserContext` v0，L）→ Slice 3b（rolling summary/压缩，L，YAGNI gate）→ Slice 4（并 teaching，XL，最后）；~~Slice 6~~ **砍掉**。

---

## 3. 跨设计一致性（三 doc 互相 + 与已锁决策史）

经 cross-critic 详版 + 对抗验证（X1–X6 全 upheld）：

| ID | 冲突 | 证据 | 裁决方向 |
|---|---|---|---|
| **X1**（critical） | CO `knowledge_review_state` ⟂ TDM §决策1 + ADR-0028 同一决策的两个互斥实现容器 | TDM:124 锁定 / schema.ts:631 泛化点 / ADR-0028 在 `f85aca6d` re-key | 选一个所有者；若选 CO 新表 = **显式 reversal**（supersede ADR-0028 + 修订 TDM），并携带 advisory-lock 并发约束 |
| **X2**（critical） | `tool_quiz` 组卷容器（TDM §决策2 已锁）⟂ CO `review_plan`/`paper_*` 容器 | TDM:125 / business.ts:234 / quiz_gen 全文 grep 零 tool_quiz | 显式切分：tool_quiz=按需测验（非 FSRS 排期）；review_plan/paper=Coach 排期复习。或合并。**不可留两个无文档的重叠容器** |
| **X3**（critical） | "谁规划复习"身份分裂：CO 把 `ReviewPlanTask` 当独立注册 task（§6.1 + §10）；AF 把它当 Coach 的输出 mode（§2.2 + Slice 6） | CO:591/812-813 vs AF:163-164/374；registry 里 `ReviewPlanTask`=0 | 收敛为**单个 Coach agent**，ReviewPlan 是 Coach 输出 artifact/mode（AF 框架），CO §6.1 forbidden-writes 降为 `coach` surface allowlist 约束 |
| **X4**（high） | 答案/判分持久化三向冲突：CO `paper_answer`/`paper_judgement` ⟂ TDM "attempt=event 不另记" ⟂ 既有 inert `answer` 表 | known.ts:49-61 judge payload 无 profile_version；answer 表全列在 allowlist:179-212 inert | 选一个答案模型；若 CO 表胜出，需退役/显式 scope `answer` 表防三模型共存，并让 judge 记录承载 profile_version 审计 |
| **X5**（high） | Mem0/memory governance 分裂：CO §10 写了完整 allow/deny 清单（且依赖**不存在的** `search_memory_facts`），AF（§3 工具权限所有者）零 memory 治理内容 | allowlists.ts:115/62-70 `query_memory_brief` 不在 `knowledge_review` surface；search_memory_facts grep 零命中 | memory 治理统一进 AF §3；先修码：`search_memory_facts` 不存在；勿在不重审"判分/抽取不读用户记忆"规则下给 `KnowledgeReviewTask`/`QuizGenTask` 授 Mem0 |
| **X6**（high） | session 概念三重未指定：CO `review_paper_attempt.session_id`（无声明 type）⟂ `learning_session(type='review')`（已实现）⟂ AF 的 `type='conversation'` Copilot envelope，且 AF §5 把 `review_paper` 当 active_ref | AF:111/298 vs CO:456；learning_session.type 已有 review+conversation | 在 AF Slice 3 决定 paper attempt 是否骑 `type='review'` session、新 type、还是无 session |

**另有跨 doc 一致性观察（cross-critic C 节，验证支持）**：
- 三 doc 各自用不同措辞复述"proposal-only safety"（CO §11 / PS §4+§11 / AF §1.2），零交叉引用——应统一引 ADR-0025 ND-5 / ADR-0004。
- AI-authored-policy 准入模型不一致：CO §1.6 review metadata **auto-active**，PS §4 subject profile **publish-gated**。可辩护的区分（per-item 测量元数据低 blast radius auto-active；全局 policy 高 blast radius gated）**两 doc 都没写成共享规则**。
- CO 各新表存 `subject_id` 为裸 text，但 PS/ADR-0014 让 `subject_id` 成可 rename/alias/fork 的身份；`resolveSubjectProfile(unknownDomain)` 静默 fallback 到 wenyan（judge-subjects 事实），故 CO 表里的 stale/renamed `subject_id` 会静默误路由。

---

## 4. 推荐实施序列（与 YUK-203 P2-P5 / YUK-169 整合）

统一顺序，尊重 TDM §6 脊柱优先（脊柱 read-model → 题目/组卷 → 练习单元 → UI），融合 cross-critic 的 U0–U8：

| 阶段 | 内容 | 来源 | 先做/推迟/砍 | 依赖 |
|---|---|---|---|---|
| **U0（GATE）** | **解决三个被埋的 locked-decision reversal**：(a) knowledge-scheduler 表归属（X1）；(b) part 排期退役（cross A2，与 a 一起裁）；(c) paper-vs-tool_quiz 容器（X2）。写/修 ADR（supersede ADR-0028 或修订 TDM §7） | CO 隐式 | **先做，且是 gate** | — |
| **U1** | 脊柱 read-model（TDM §6 step1，已随 ADR-0027 P1/P2 合入）——确认 coverage seeding 骑在已合的 note-decouple + 题池上 | YUK-203 P1/P2 | 已完成，仅确认 | — |
| **U2** | 知识 scheduler + coverage 层：`question_knowledge_coverage`（按需）+ 选定的 scheduler 表；从 `question.knowledge_ids` seed；旧 question-FSRS 保留为兼容压力**而非第二所有者** | CO Slice1+5 | 先做 | U0a |
| **U3** | 统一 agent 形：单 Copilot + **chat composer（AF 新 Slice 0）** + `CurrentUserContext` v0 + `learning_session` envelope + Coach-owns-planning；在此解决 paper attempt 的 session 归属（X6）。**gate 在 YUK-169 redraw** | AF Slice1-3 | 先做（composer 最优先，文档没写需补） | YUK-169 |
| **U4** | Coach 复习规划工具（作为 **Coach mode 而非新 task**，收敛 X3）：snapshot/candidate/plan-write；`search_memory_facts` 先实现或从契约删；profile_version event stamping（PS+CO 共享，只造一次） | CO Slice3 + PS S2 | 先做 | U2,U3 |
| **U5** | paper 答案/判分模型 + dynamic paper UI：在此 settle 答案模型（X4）；新 paper surface（card UI 不兼容） | CO Slice2+4 | **推迟**（最贵、近期价值最低，F8/F9） | U2,U4,YUK-169 到达 /review |
| **U6** | Active Teaching → Copilot skill | AF Slice4 | **推迟**（XL 真拆解，AF-5），保留 corrective-chip KPI 分离 | U3,U4 |
| **U7** | Editable Profile Studio MVP（git+`audit:profile`+`ProfileCriticTask`+只读 admin page）；DB 表无限期延 | PS（裁后） | **推迟到 scheduler 模型 settle 后**（其 due-queue 预览靠 U2 产物）；ProfileCritic-first 独立可先 | U2 |
| **U8** | `leave_agent_note`（骑现有 ExperimentalEvent catch-all）；与 CO 的 `needs[]`/`request_question_profile_refresh` 调和成一条 hint 通道（cross B8） | AF Slice5 | 低风险，可早做/并行 | — |

**净裁决**：U0 是 load-bearing gate——三个 reversal 必须先以显式 ADR amendment 浮出，再动任何新表/新 task。三 doc 各自的 slice 列被这条统一依赖链取代。

---

## 5. 需要用户拍板的开放问题

1. **知识级 FSRS 归属（X1，gate）**：复用 `material_fsrs_state(subject_kind='knowledge')`（ADR-0028，半成品在 P3 分支）还是 CO 新 `knowledge_review_state` 表？
   - **推荐**：复用 `material_fsrs_state`（MVP 零 DDL、并发锁已实现）；仅当真出现非 FSRS policy 时再按第二实例规则拆出 `knowledge_review_state`，且写成显式 supersede ADR-0028。
2. **paper vs tool_quiz 容器（X2）**：一个容器还是两个？
   - **推荐**：显式两分——`tool_quiz`=用户按需测验（非 FSRS 排期）；`review_plan`/paper=Coach 排期自适应复习。在 CO 与 TDM 都写明，否则违反 TDM §2.4。
3. **答案/判分模型（X4）**：paper 答案是 event（TDM"不另记"）还是 `paper_answer`/`paper_judgement` 表？
   - **推荐**：答案走 `event(action='attempt')` payload；judgement 走 `event(action='judge')` payload + `visible_to_user` 字段；仅 `paper_question_assignment`（assignment intent）+ 答题卡 envelope 作为真新结构按需保留；退役 inert `answer` 表防三模型共存。
4. **谁规划复习（X3）**：`ReviewPlanTask` 独立注册 task 还是 Coach 的输出 mode？
   - **推荐**：单 Coach agent，ReviewPlan 是 Coach 输出 mode；§6.1 forbidden-writes 降为 `coach` surface allowlist。
5. **历史可解释性优先级（PS §0 / SR-3）**：是否现在就 stamp `profile_version` 到 events？
   - **推荐**：做，作为 PS+CO 共享的第一块基础设施（3 个可选 payload 字段，判时已在内存）；若决定不做，则把 PS §0 不变量断言一并删掉，别留空头承诺。
6. **memory governance 落点（X5）**：Mem0 allow/deny 清单放哪、`search_memory_facts` 建不建？
   - **推荐**：治理统一进 AF §3；MVP 不建 `search_memory_facts`（`query_memory_brief` 已给 attention prior）；勿在不重审"判分/抽取不读用户记忆"前给 `KnowledgeReviewTask`/`QuizGenTask` 授 Mem0。
7. **AI-authored-policy 准入规则（cross A3/C3）**：review_profile/coverage auto-active 而 subject profile publish-gated，是否定为共享 blast-radius 规则？
   - **推荐**：是，明文写为共享规则，两 doc 都引。

---

## 6. 附录

### 附录 A — 被驳回的发现（防再提）

**本轮无被驳回（upheld=false）的发现。** 对抗验证对全部 30 条 finding（CD-1..5、CR-1..4、F1/F4/F8/F9/F11、C1..3、P1..5、S1..4、SR-1/3/4/7/8、STUDIO-4、PS S1..4、AF-2..5/7、X1..6）给出 **upheld=true**，置信区间 0.72–0.95。

需在引用时**保留的事实订正/降置信项**（防止把过度断言当事实再提）：
- **telemetry 已持久化**（S1 订正，置信 0.82）：声称"`JudgeInvocationTelemetry` 从不写入 event 行"为**假**——`submit/route.ts:235-246` 确实把 `judge.capability_ref`+`judge.telemetry` 嵌入 review event payload。真 gap 仅是缺 `profile_version` 且 `capability_ref.version` 硬编码 `'1.0.0'`。
- **F9 的 gate doc 关联弱**（置信 0.72）：`2026-06-04-redraw-today-7a-preflight.md` 不在 origin/main、且针对 today 而非 /review；"the active UI gate"措辞偏，但 Slice 4 排最后的结论仍立。
- **state.ts 在 worktree HEAD 仍硬类 'question'**（CD-1 注）：rekey 只在 `f85aca6d` 分支；CD-1 正确地把该断言 scope 到 ADR-0028 而非 main。
- **P3 的 `embedded_check_stores question_ids` 引用 file:line 错位**（置信 0.82）：实际在 `business.ts:234` 而非 body-blocks.ts:385；底层事实（embedded_check 引用题池）为真。
- **X4/X5 的 action 标签与 intent 推断略过**：X4 复习答案实存于 `event(action='review')` payload（attempt 标签用于组卷/capture）；X5 称 knowledge_review 排除 Mem0 为"故意"是推断（代码无注释陈述 intent），但事实排除与工具不存在是实的。
- **subjective 工作量估算**（F8/F11/SR-8 的 S/M/L/XL）天然主观，结构逻辑经验证、尺寸为判断。

### 附录 B — 原料文件清单

**三 doc 原文**（`/tmp/tlp-docs-sync/docs/superpowers/specs/`）：`2026-06-03-coach-led-review-engine-design.md`、`2026-06-03-editable-profile-studio-design.md`、`2026-06-04-agent-framework-design.md`。

**审计 + critic + cross-critic**（`/tmp/tlp-audit/findings/`）：
coach-data.md、coach-runtime.md、coach-sequencing.md、coach-critic-product.md、coach-critic-simplicity.md、coach-review-verifier-summary.txt；
studio-data.md、studio-runtime.md、studio-sequencing.md、studio-critic-product.md、studio-critic-product-2.md、studio-critic-simplicity.md；
agentfw-data.md、agentfw-runtime.md、agentfw-sequencing.md（+ .prev.md）、agentfw-critic-product.md、agentfw-critic-simplicity.md；
cross-critic.md。

**地图**（`/tmp/tlp-audit/maps/`）：agents-runtime.md、ai-infra.md、inflight.md、judge-subjects.md、memory.md、question-structured.md、review.md、schema.md。

**对抗验证结论**：本报告任务输入提供的 finding_id→upheld/confidence/note JSON（30 条，全 upheld）。
