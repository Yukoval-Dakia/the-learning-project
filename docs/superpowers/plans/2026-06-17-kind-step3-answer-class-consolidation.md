# kind Step 3（YUK-390 承重墙）— 三套词表 → 单一 answer-class 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.
>
> **依赖**：Step 1（YUK-388 / PR #442）必须先 merge（part-ness 已搬出 kind 列）。**前置勘察**：`docs/superpowers/research/2026-06-17-kind-system-recon-step3.md`（全 file:line 引用，本计划不重复）。
>
> **状态**：本计划在 owner 睡眠期自主 drive 中起草。**§0 的 3 个产品分叉已用 grounded 高信心决策定下（owner 已被知会，可随时 redirect）——非阻塞**。Step 3 实现的真实前置是 **#442（Step 1）merge**（codex 门）；该依赖满足 + API 稳定后即可落实施，逐行测试届时 flesh-out。

## ⚠️ 设计 PIVOT（owner 拍板 2026-06-17）— 不升格 judge_kind_override，新增独立 answer_class 列

careful-read 发现：`judge_kind_override` 是**完整 judge-ROUTE override**（8 值），`resolveQuestionJudgeRoute` 在所有 profile 路由**之前**直接返回它（route-resolve.ts:120-121）。按原 YUK-390「升格 judge_kind_override」backfill 它会 clobber profile 路由（physics `unit_dimension` / `multimodal_direct` / derivation `steps`-gating）= **A5 回归**。

**owner 决策**：**新增独立 `answer_class` 列**（4 值，`deriveAnswerClass` 算），`judge_kind_override` **原样不动**（仍是 dispatch route override）→ **judge 路由零改动，A5 by construction 保住**。原 Task 2「两孪生 rewiring」**整体作废**（不需要+高风险）。Phase 1 检索直接 SQL 过滤 `answer_class`。

**修订后 Step 3（纯 additive + 词表收敛，无路由改动）**：
1. `deriveAnswerClass` 纯结构 4 值分类器。
2. `answer_class` 列 + 迁移 + backfill + on-write 填充（audit:schema 要 write path）。
3. 三套词表收敛（question-kind.ts / profile-schema.ts → answer-class 标签 + 结构描述符）。
4. 脏 kind 清理（profile-vocab→canonical；多在 fixtures）。
5. fixture schema 收紧。

**PR 切分**：**PR A** = primitive + `answer_class` 列 + backfill + on-write（additive, A5-safe）；**PR B** = 词表收敛 + 脏数据清理 + fixture schema。

> 下方旧 Goal/Architecture/Task 2 描述按「升格 judge_kind_override」写的——**已被本 PIVOT 取代**，保留作 diff 背景，勿据其实现。

**~~原 Goal~~：** 把 question-kind 从「9 值闭集 + 三套漂移词表」收敛到正交两轴。

**~~原 Architecture~~（已废，见 PIVOT）：** `judge_kind_override` 升格为 answer-class 主存储 + 两孪生委托 `deriveAnswerClass`。

**Tech Stack:** Drizzle/pgvector Postgres、Zod schemas、Vitest（unit + db + migration）、TDD。

---

## §0 三个产品分叉（已 grounded 决策；owner 确认）

**Fork 1 — `derivation` 是 kind / answer-class / both？**
→ **决策**：`derivation` 是**结构描述符**（证明/推导步骤形态，归 Step 2 结构轴），其 answer-class = **`steps`**。`derivation` 从 answer-class 集中剔除（不是第 5 个 answer-class）。
→ 依据：spec §12 结构轴；route-resolve.ts:151-154 derivation→steps(math)/semantic 已是此形；steps 已是 4 值 answer-class 之一。

**Fork 2 — `judge_kind_override` 升主后 NULL 语义？**
→ **决策**：**NULL 保留 = "derive from structure" 的显式 fallback**，列升为「answer-class 主存储（set 时）」而非「强制非空」。Step 3 **不加 fail-closed CHECK**（避开 recon 风险#7 的 ordering hazard：CHECK 会对脏行失败）。CHECK 硬化留作独立后续 task（数据干净后）。
→ 依据：recon 风险#2/#7；增量、可回滚、向后兼容；legacy 行全 NULL 现状不破坏。

**Fork 3 — generator 能 emit `steps` 吗？**
→ **决策**：**否，`steps` 保持 derived-only（route-resolve profile-gated）**。generator 三 Zod schema（quiz_gen.ts:153 / sourcing.ts:41 / question_author.ts:49）维持 `exact|keyword|semantic` 三值。
→ 依据：recon 风险#3；quiz_gen.ts:147-152 的 runner-存在性 + 防幻觉 guard；steps 需 vision runner，generator 误标会路由到不存在/错误 runner。

> 这 3 个决策都选「最小破坏 + 可回滚 + 保留现有安全 guard」，已按自主授权定下并知会 owner。owner 若对任一持异议（尤其 Fork 2 是否本步就做 fail-closed），落实施前 redirect 即可——它们改变 Task 4/6 的形状。

---

## File Structure（将 touch）

- **Modify** `src/subjects/question-kind.ts` — 新增 `deriveAnswerClass`/answer-class 词表；保留 SKILL_TO_CANONICAL 作 backfill 映射源；评估 `canonicalKindToPersistedForms` 消费者能否随脏数据清洗简化（recon 风险#9）。
- **Modify** `src/core/schema/business.ts` — answer-class enum（`exact|keyword|semantic|steps`）作为一等类型导出（与既有 JudgeKind 8 值对齐，answer-class 是其子集）。
- **Modify** `src/server/judge/route-resolve.ts` + `src/core/schema/judge-routing.ts` — 两孪生委托同一 `deriveAnswerClass`；**route-resolve 保留 profile-aware 上层包装**（steps/unit_dimension/multimodal_direct/image-gate :90/:133-139/:151-154/:166-172 不动）。
- **Modify** `src/core/schema/quiz_gen.ts` / `sourcing.ts` / `question_author.ts` — `judge_kind_override` enum 注释升级为「answer-class（set 时为真值）」，值集维持三值（Fork 3）。
- **Create** `drizzle/00NN_*.sql` — **仅** backfill 用迁移（见 Task 3 ordering）；**不加 kind CHECK 约束**（Fork 2）。**迁移号由落实施时 main 决定**（当前 main 已含 Phase 0 的 0039/0040；本步生成时跑 `pnpm db:generate` 取下一号）。
- **Modify** `src/subjects/{math,physics,wenyan}/fixtures/index.ts` — kind enum 收紧为 canonical（防再脏，recon 风险#6）。
- **Test** 新增 `question-kind.test.ts`（answer-class 派生）+ backfill db test + 孪生同步回归 + A5 客观位回归。

---

## Tasks（TDD，backfill-first 顺序破 ordering hazard）

### ⚠️ 实现前必读（adversarial review 2026-06-17 抓到 3 个 regression，已折进 Task 1/2）
1. **`deriveAnswerClass` 的 `choices>0→exact` 必须是显式可关入参**——`defaultJudgeKindForQuestion` 当前**从不看 choices**（只读 kind/override/keywords，judge-routing.ts:41-58；`JudgeRoutableQuestion` 连 `choices_md` 都没声明）。若核无条件先跑 choices→exact，生成的非 choice 题带 stray `choices_md` 会 semantic→exact 翻转 + 触发 quiz_gen.ts:178 / embedded_check_generate.ts:80 的 `route==='exact'` 断言 → 整批生成失败。→ 核签名 `deriveAnswerClass(q, { considerChoices })`，generation 路径传 `considerChoices:false`。
2. **`isExactQuestion` 对 `fill_blank` 必须无条件 exact**（保 `EXACT_KINDS` 成员，verify-framework.ts:155/168），**不是** `core==='exact'`——核里 fill_blank 带 keywords 时是 keyword，会把 keyworded fill_blank 从 exact normalize-compare 翻到 semantic 路径（verify gate 质量回归，且无现存测试覆盖→静默 ship）。→ wrapper：`core==='exact' || kind==='fill_blank'`。
3. **route-resolve interleave 不是「call core then patch」**——`multimodal_direct`(:166-172) 在 derivation 与 prose 子分支**之间**，`unit_dimension`(:133-139) 在核前，derivation 的 `keyword` fallback(:153) 覆盖核的无条件 steps。保 override→choices→physics-unit→derivation(profile-gated)→multimodal→prose(profile-gated)→fallback-exact 精确顺序。
4. **先写 3 条缺失回归测试再 refactor**（当前全无覆盖）：(a) keyworded `fill_blank` → `isExactQuestion===true`；(b) `defaultJudgeKindForQuestion({kind:'short_answer', choices_md:['A','B']})` → `'semantic'`；(c) derivation under profile 无 steps 无 semantic preferred → `keyword`。

### Task 1: `deriveAnswerClass` 纯结构核函数（additive，零 caller 改动）
- [ ] **Step 0** — 先写上面 ⚠️#4 的 3 条锁现状回归测试（snapshot 现行为，全绿）。
- [ ] 写失败测试：`deriveAnswerClass(q, {considerChoices})` 对 9 kind × {有/无 choices, 有/无 keywords} 矩阵返回 recon §1 的 4 值（considerChoices:true 时 choices>0→exact 短路；fill_blank+keywords→keyword；computation→keyword/semantic；prose→semantic；derivation→steps）。
- [ ] 实现 `deriveAnswerClass`，复刻 route-resolve.ts:145-176 的**纯结构**判定（**不含** profile-aware unit_dimension/multimodal_direct/steps-gating——那些留 route-resolve 包装）。**此步不改任何 caller**，纯 additive 函数 + 测试。
- [ ] 跑 targeted unit 绿；commit（Refs YUK-390）。

### Task 2: 两孪生 + isExactQuestion 委托 `deriveAnswerClass`（零行为变更，消重）

**⚠️ A5-critical 不对称（读真码 2026-06-17 后精化）**：两孪生**不是**"都套一个函数"那么简单。`deriveAnswerClass` 只能是 **4 值 structural 核**（choices>0→exact；choice/true_false→exact；fill_blank→keyword?:exact；computation→keyword?:semantic；derivation→steps；prose→semantic）——**纯结构、无 profile**。每个 twin 在核**外面**各自包自己的 load-bearing 部分，核不能吞掉它们：

- **`resolveQuestionJudgeRoute`（route-resolve.ts:116-177，runtime profile-aware）** 的包装层**必须保留且顺序不变**：① override 短路(:120-121) → ② choices>0→exact 短路(:130-131) → ③ physics `unit_dimension`(:133-139) → ④【core】→ 但 derivation 在此是 **profile-gated**：steps-if-preferred / semantic-if-preferred / else keyword(:151-154)，**不是核的无条件 steps** → ⑤ `multimodal_direct`(image_refs+profile+no reference_solution，:166-172) → ⑥ prose **profile-gated** semantic-else-keyword(:173-174)。`unit_dimension`/`multimodal_direct` **不属 answer-class 4 值**，是 route 级 extra——核**不返回**它们，由 route-resolve 包装注入。
- **`defaultJudgeKindForQuestion`（judge-routing.ts:41-58，gen-time pure）**：core 之上 **derivation→semantic 折叠**（生成永不 steps，:50-56 防幻觉）+ prose→semantic（无 profile）。= `deriveAnswerClass` 后接 `steps→semantic` 映射。
- **`isExactQuestion`（verify-framework.ts:157-169）**：= `deriveAnswerClass(q)==='exact'`（+ 既有 judge_kind_override==='exact' 短路 + choices_md 长度检查）。

**因此**：抽取的共享面 = kind→{exact/keyword/semantic/steps} 结构核 + choices/keyword 结构判定；**profile-aware 路由（unit_dimension/multimodal_direct/steps-gating/prose-gating）留在 route-resolve 包装层不动**。去重收益是**部分的**（核共享，profile 包装各留）——这是正确的，不要为"完全收敛"牺牲 A5 路由。

- [ ] 写回归测试：route-resolve / judge-routing / isExactQuestion 对**全 kind × {choices/无, keywords/无, image_refs/无, profile×{wenyan,math,physics}, reference_solution/无}** 矩阵的输出在重构前后**逐项 byte 相等**（先 snapshot 现行为，再改实现验等价）。这是本步最重的回归网。
- [ ] route-resolve 仅把 ④ 的 4 值核部分委托 `deriveAnswerClass`，①②③⑤⑥ 包装原样保留；judge-routing 委托核 + steps→semantic 折叠；isExactQuestion 委托核 + 既有短路。
- [ ] 跑 submit / paper-submit / verify-framework 全测绿；**派独立 Opus reviewer 专审 A5 路由等价**（unit_dimension/multimodal_direct/steps-gating 无丢失、choices 短路顺序不变）；commit。

### Task 3: 历史脏 `kind` 数据幂等 backfill（**先于任何 CHECK/约束**）
- [ ] 写 db 测试：seed 含脏值的 question 行（single_choice/calculation/reading_comprehension 等，见 recon §6 census），跑 backfill 后 `kind` 全为 canonical（profile→canonical via SKILL_TO_CANONICAL），neither-vocab 值 fail-closed（记录 + 不静默改，留 NULL-route fallback）。幂等：重跑不变。
- [ ] 实现 backfill（脚本或 job）：读 `kind`，`normalizeToCanonicalKind`，UPDATE 到 canonical。**同时**（可选）材化 `judge_kind_override` answer-class（读 choices_md+rubric_json 跑 `deriveAnswerClass`）——但 NULL 保留为合法 fallback（Fork 2），仅对需显式 answer-class 的行写。
- [ ] 跑 db 测试绿；commit。**注意**：迁移文件只在确需 DDL 时生成；纯数据 backfill 走 job/脚本不占迁移号。

### Task 4: fixture schema 收紧（防再脏）
- [ ] 改 math/physics/wenyan fixtures `kind` enum → canonical 值；修受影响 fixture 数据。
- [ ] 跑 `pnpm audit:profile` + fixture 加载测试；commit。

### Task 5: `judge_kind_override` 升「answer-class 主存储」语义（读侧统一）
- [ ] 写测试：消费者读 answer-class 时优先 `judge_kind_override`（set 时），NULL 时 `deriveAnswerClass`。
- [ ] 更新 quiz_gen/sourcing/question_author 三 schema 的字段注释为 answer-class 语义（值集仍三值，Fork 3）；确认 rejudge.ts:91 / solve-check forced-semantic 路径存活（recon 风险#10）。
- [ ] commit。

### Task 6: 全量 gate + A5 客观位回归
- [ ] **专项 A5 回归**：R3 calibration（target-discovery）+ active-PPI（personalized-difficulty）对 `choice`→`exact` 结构保证、`OBJECTIVE_JUDGE_ROUTES={exact,keyword}` SQL filter 不回归（recon 风险#8）；图片答案 route gate（IMAGE_CONSUMING_JUDGE_ROUTES）不误路由到纯文本确定性 route。
- [ ] 全 gate：typecheck/lint/audit×4/test/build 全绿（raw 证据）。
- [ ] **不**碰 `isRecallKind`/`rotationClassForKind`（recon 风险#5，独立 recall-vs-application 轴）。

---

## Self-Review checklist（落实施时）
- Step 3 **不**塞进 Step 4（5 处镜像收敛）/ Step 5（生成端塌缩）——本步只到「answer-class 派生单一化 + 脏数据清洗 + 列升格语义」，镜像 if-链删除是 Step 4。
- 迁移号落实施时取 `pnpm db:generate` 当时号（不预填）。
- 每个 Task 完成派独立 Opus reviewer（承重墙，重活用 Opus）。
- backfill 必须先于任何未来的 CHECK 硬化（ordering hazard）。
