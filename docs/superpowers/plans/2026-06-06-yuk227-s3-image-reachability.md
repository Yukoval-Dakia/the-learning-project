# YUK-227 图片素材可达性 — Strategy D S3 实施计划

- **主线**：YUK-227 图片素材可达性（owner 拍板，同根因合并）
  - 子线 1：SourcingTask 图片型源接入（VLM 抽图）
  - 子线 2：ingestion 图题空间匹配（slice-2b 遗留，bbox/page_spans 空间信号 + VLM assignFigures）
- **副线**：YUK-228 Note 族 skill 迁移（owner 拍板：Note 塞、Attribution 缓）
- **作者**：planner（现场勘察后撰写，对着 fresh main）
- **日期**：2026-06-06
- **前置**：Strategy D S1+S2 全量已 merge

---

## 0. 现状锚点（实证）

> 所有锚点均来自 fresh main 现场 Read，逐行核实，不从上下文推断。

### 0.1 子线 1 — SourcingTask 当前形态

- **入口约束**：`src/core/schema/sourcing.ts:15-16` 显式注记 `OF-1 回填 (YUK-223 issue): the first cut extracts from HTML/TEXT sources only; image-type sources are out of the first version.`
- **LLM 输出形状**：`SourcedQuestion`（`sourcing.ts:30-58`），字段 `kind / prompt_md / reference_md / choices_md / judge_kind_override / rubric_json / difficulty / knowledge_ids / source_url / source_title / extraction_hash? / extract`。**全部是文本字段，没有任何图片/asset 通道**。
- **检索能力**：handler（`src/server/boss/handlers/sourcing.ts:317-325`）挂 Tavily MCP，但 `src/server/ai/mcp/tavily.ts:14-44` **只暴露 `tavily_search` + `tavily_extract`**，`crawl/map/research` 显式排除。`tavily_extract` 是 URL→content（文本），**不是图片提取**。
- **持久化**：handler `sourcing.ts:440-461` INSERT `question`，`source='web_sourced'`，`metadata.web_sourced`（`WebSourcedProvenanceT`），**没有写 `question.figures` / `question.image_refs`**。
- **gate**：`draft_status='draft'` → 链 `source_verify`（`sourcing.ts:494-502`）→ 通过才 draft→active + FSRS。`source_verify`（`source_verify.ts:124-192`）做 **确定性** prompt↔extract 词重叠（`maxNgramOverlap`），**从不 refetch 网络**（`source_verify.ts:140` 注记）。

**子线 1 的核心缺口**：图片型真题源（如 gaokao.eol.cn 把题干嵌在扫描图里）今天 100% 被 SourcingTask 丢弃——agent 即使搜到这种页面，`tavily_extract` 返回的文本里没有题目本体，`SourcedQuestion.prompt_md` 无从填充。

### 0.2 子线 2 — ingestion 图题空间匹配当前形态

- **空间信号 placeholder**：`src/server/ingestion/structure.ts:17-19` 注记「Figure↔question matching (replacing `assignFigures`) is DEFERRED to slice 2b」；`block-assembly.ts:13-20` 注记 `question_block.page_spans` 全是 placeholder（`page_index=0`，full-page bbox），path-B v1 是 **SEMANTIC-ONLY**。
- **handler 现状**：`tencent_ocr_extract.ts:213-230` —— VLM 树 **carries no per-question bbox**，于是每个 block 写死 `page_spans:[{page_index:0, bbox:{0,0,1,1}, role:'prompt'}]` placeholder；`figureRefs` 用 `assignFigures(allPreFigures, structure.questions)` 纯几何启发式。
- **`assignFigures` 失败模式**（`figure_attach.ts:12-72`，实证逐行）：
  1. **VLM happy path 全归 root**：VLM 树的 question **没有 bbox**（`page_index` 也无）→ `figure_attach.ts:50-58` `candidatesWithBbox.length===0` → **所有图都挂到 scope root（第一个 stem/standalone），confidence='low'**。一份多题卷子里所有图全堆到第一题。
  2. **腾讯 bbox 路径**：`assignFigures` 依赖腾讯 bbox（`figure_attach.ts:32` page-gate + `:36` 空间包含），但腾讯 bbox 命名空间 ≠ VLM question-id 命名空间——slice 2 让 VLM 拥有结构后，**腾讯 question 的 bbox 不再传到 `structure.questions`**，所以即使腾讯出了 bbox，VLM 树也用不上 → 退化到模式 1。
  3. **跨页**：page-gate（`figure_attach.ts:32`）按 `source_page_index` 过滤，但 VLM 跨页大题 block 的 `page_spans` 是 placeholder page 0，page-gate 失效。
- **ADR-0002 修订（2026-05-30）DEFER 原因**：VLM 给不出可靠像素 bbox（crop 仍需腾讯 bbox），「半成品会导致图错挂且难审计」。StructureTask output schema 已留扩展位（figures 块 + 串 id）。

**子线 2 的核心缺口**：图题归属在 VLM-owned 结构下退化为「全挂第一题」，多图卷子的图全错挂，且无空间证据可审计/回滚。

### 0.3 副线 — Note 族 skill 迁移当前形态

- **三处重复**：`src/ai/task-prompts.ts` `noteTemplateTable(profile)`（`:16-23`）被 `buildNoteGeneratePrompt`（`:204-217`）注入，`buildNoteVerifyPrompt`（`:226`）、`buildNoteRefinePrompt`（`:245`）各自重复 note 规范散文。三个 task 共享同一份「什么是合格的 atomic/long/hub 笔记」标准但今天靠 prompt 散文各写一遍。
- **profile.noteTemplate 形状**：`profile-schema.ts:49-55` `{ definition, mechanism, example, pitfall, check }`，5 个 string。这是 **per-subject** 数据。
- **S2-4 skill 基建**（可复用，实证）：
  - runner `Options.skills` 键控：`runner.ts:101-120` + `:362-380`，语义 **`skills: ctx.skills ?? []`**——OMITTED ⇒ CLI 加载全部已发现 skills；`[]` ⇒ **显式禁用一个都不启用**（S2 第三教训不变量）。
  - CONFIG_DIR 预置：`runner.ts:264-295` 进程启动一次性 mirror `src/subjects/<id>/skills/<skill>/` 到隔离 `CLAUDE_CONFIG_DIR/skills`。
  - 降级链先例：`quiz-gen-skills.ts:61-101` `resolveQuizGenSkills(subject,kind)` / `resolveQuizGenSkillsForSubject(subject)`——**on-disk 发现**，缺目录 → `undefined` → handler 不传 skills option → promptFragments 回退，**never throws**。
  - 既有 SKILL.md 形态：`src/subjects/wenyan/skills/quiz-gen-translation/SKILL.md`——frontmatter `name`（== 目录名）+ `description` + 正文规范，引用 `references/` `assets/`。
- **Note task 调用现状**：`note_generate.ts:192` / `note_verify.ts:236` / `note-refine.ts:194` 三个 handler 都 `runTaskFn('NoteXxxTask', input, { subjectProfile: resolveSubjectProfile(...) })`，**今天都没传 `ctx.skills`** → 走 `?? []` 显式禁用，纯靠 prompt 散文。

---

## 1. 可复用面与关键裁决（实证驱动）

### 1.1 VLM 调用成本与授权语义（关键约束）

实证 `src/ai/registry.ts` 的 `invocation` 字段语义（`registry.ts:47-49`：`'auto'` = 后端自由调用；`'manual_rescue_only'` = 仅用户手动触发）：

- **`StructureTask`：`invocation:'auto'`**（`registry.ts:118-120` 注记）——它在 **已经付费的 OCR extraction job 内**被调用，不额外暴露付费点。OCR 录入本身就是用户主动上传图片触发的付费动作。
- **`VisionExtractTask` / `VisionExtractTaskHeavy`：`manual_rescue_only`**（`registry.ts:86,100`）——ADR-0002 修订注记 + `rescue.ts:27-28`：**「用户授权的、付费可见的、可选的救援，不是自动 fallback」**。
- **cost-cap 现状**：`registry.ts:14-22` `TaskBudget.maxCost` 与 `fallbackChain` **都是 INACTIVE（phase-deferred T-PD4）**，runner 只 enforce `maxIterations` + `timeout`，**没有 per-run USD 会计**。
- **cost 留痕**：`src/server/ai/log.ts:68` `writeCostLedger({ task_kind, provider, model, cost, tokens_in/out, outcome, pgboss_job_id })`——已有 ledger 表，按 task 写一行。`tencent_ocr_extract.ts:247-256` 是范例。

**裁决（成本守门）**：
- **子线 2（图题匹配）属于 `StructureTask` 同一付费上下文**——它在 OCR job 内，用户已经为这次录入付费。**不需要新增付费守门**，但因为它新增 VLM token（assignFigures task），必须 `writeCostLedger` 留痕（evidence-first）。
- **子线 1（SourcingTask 自动抽图片）触碰 ADR-0002 红线**：SourcingTask 是**后端自动触发**的检索线（`SOURCING_TRIGGERS` 含 `knowledge/learning_item/manual`，可由找题次序自动 enqueue）。把「检索到的图片 URL → VLM 抽题」做成 **自动** 路径，等于让一个 auto 路径无守门地烧 VLM 真金白银——**与 ADR-0002「VLM 抽图是用户授权的付费动作」直接冲突**。这是本计划最大的 OWNER-FORK（见 §6）。

### 1.2 `tencent_ocr_extract` 的输入形态能否吃「检索到的图片 URL」

实证 `runVisionExtract`（`vision.ts:39-70`）/ `runStructureTask`（`structure.ts:164-236`）的输入：

- `RunVisionExtractParams` 吃 `{ assetId, mimeType, imageBytes: ArrayBuffer, pageIndex, runTaskFn }`——**吃的是 bytes，不是 URL**。
- `tencent_ocr_extract.ts:135-151` 的 bytes 来自 `deps.r2.get(asset.storage_key)`——**图片必须先落 R2 成 `source_asset` 行**。
- 结论：**现有 VLM 管道能复用，但前提是检索到的图片 URL 必须先下载 → 落 R2 → 建 `source_asset`**。SourcingTask 今天没有这个下载/落盘步骤（它只产文本 question 行，不建 asset）。这是子线 1 的真实工作量所在，不是「复用现成管道」那么轻。

### 1.3 Note skill 激活键语义裁决

**问题**：quiz-gen skill 键是 `(subject, kind)`（`resolveQuizGenSkills(subjectId, kind)`）。Note task 的键是什么？

**裁决：Note skill 键 = `subject` 级（不带 kind）**。理由（实证）：
- Note 的「kind」是 `artifact_type`（atomic/long/hub），但 `task-prompts.ts:206` 注记 **「artifact_type 只能是 note_atomic/note_long/note_hub；这是同一个 NoteGenerateTask 内的 type switch」**——三种 artifact_type 共享同一份 note 规范（definition/mechanism/example/pitfall/check 模板对三者都适用），**不像 translation vs calculation 那样需要分目录**。
- 三个 Note **task**（Generate/Verify/Refine）也共享同一份规范（出 note 与质检 note 同源，与 quiz-gen 出题验题同源是同一哲学）。
- 所以一个 `src/subjects/<id>/skills/note/SKILL.md`，**subject 级**，三 task（NoteGenerate/NoteVerify/NoteRefine）共用。
- **实施修订（2026-06-06，PR #323 bot 轮发现）**：目录名 `note/` 在 CONFIG_DIR mirror 下跨科冲突——`populateIsolatedSkills` 全局扁平拷贝，skill 名跨科必须唯一（runner.ts 注释明示）。F2 三科补齐后三个 `note/` last-write-wins 互相覆盖。落地形态改为 **`note-<subjectId>/`**（note-wenyan / note-math / note-physics），resolver 返回 `['note-' + subjectId]`；激活键仍是 subject 级语义不变，mirror 零改动。S2 的 quiz-gen-<kind> 目录同样依赖该全局唯一不变量（当时各科 kind 不重名故未触发——潜在同病，跨科同 kind 出现时需同样处理）。
- **新增 resolver**：`resolveNoteSkill(subjectId)`（镜像 `resolveQuizGenSkillsForSubject` 的 on-disk 发现 + 降级链），返回 `['note']` 或 `undefined`。**复用同一 CONFIG_DIR mirror**（`runner.ts:264-295` 已 mirror `skills/` 下所有目录，`note` 目录自动被 mirror，无需改 runner mirror 逻辑）。
- **S2 第三教训不变量保持**：三个 Note handler 把 `ctx.skills = resolveNoteSkill(subject) ?? undefined` 传入；缺 skill → 不传 → `?? []` 显式禁用 → 回退现状 prompt 散文。runner 接线动作（`skills: ctx.skills ?? []`）**不动**。
- **缝隙防御（S2 第二教训）**：`note` 目录前缀必须与 `quiz-gen-` 前缀不冲突。`resolveQuizGenSkillsForSubject` 用 `startsWith('quiz-gen-')` 过滤（`quiz-gen-skills.ts:94`），所以 `note/` 不会被 quiz-gen resolver 误捞；反向 `resolveNoteSkill` 只认 `note` 精确目录名，不会捞到 `quiz-gen-*`。

---

## 2. 切片排程

> **排程裁决：子线 2 → 副线 → 子线 1（OWNER-FORK gate 后）**。
>
> 理由：子线 2 在 **已付费 OCR job 内**、风险与授权语义清晰、是纯改进（修「全挂第一题」），优先落地拿真值。副线（Note skill）零成本守门、纯 prompt 重构、与前两者无依赖，作为填充位插中间（独立 lane 可与子线 2 并行）。子线 1 触碰 ADR-0002 红线，**必须先过 OWNER-FORK（§6 F1）拿到成本策略拍板**才能进 impl，排最后。

```
Slice A (子线 2): VLM 图题空间匹配 ──┐
                                      ├─ 可并行（无共享文件）
Slice B (副线):   Note skill 迁移  ──┘
        │
        ▼ (A、B merge 后)
[OWNER-FORK F1 gate] ── owner 拍板子线 1 成本策略
        │
        ▼
Slice C (子线 1): SourcingTask 图片源接入（按 owner 裁决的边界实现）
```

### Slice A — 子线 2：VLM 图题空间匹配（替换 `assignFigures` 启发式）

**目标**：在 `StructureTask` output schema 里让 VLM 自报每题的 `figure_attach`（哪些 crop 图属哪道题 + page 信号），handler 用 VLM 归属替换纯几何 `assignFigures`，建立 bbox/page_spans 空间信号通道。保留腾讯 bbox 做 crop（VLM 不给像素 bbox），但**归属判定**交给 VLM（它能读图判断「这张电路图属于第 3 题」）。

> **设计预算约束**：本切片新增 VLM 输出字段 + 一次归属推理，仍在 StructureTask 单次调用内（不新增 task / 不新增付费点）。若 VLM 单次输出可靠承载 figure 归属，**优先零新增 task**；只有当 prompt 实测证明 figure 归属污染结构质量时，才 fork 出独立 task（届时回 owner，见 §6 F3）。

**文件级步骤**：

1. **`src/server/ingestion/structure.ts`**（修改）：
   - `StructureNode` schema 加可选 `figure_ids?: string[] | null`（VLM 自报本节点附带的 crop 图序号/id）。crop 图在调用 VLM 前已 `cropAndUploadFigures` 产出 `PreAttachFigure[]`（带 `asset_id` + `source_page_index` + `source_bbox`），把这批图的「序号 + 缩略信息」喂进 StructureTask input，让 VLM 按序号回填归属。
   - `RunStructureTaskParams` 加 `preFigures?: Array<{ index: number; page_index: number }>`（仅传 VLM 判归属所需的最小信息——序号 + 页码，不传 bytes 进 prompt，图本身已在 page images 里）。
   - `StructureResult` 加 `figureAssignments?: Array<{ figure_index: number; attached_to_question_id: string; confidence: 'high'|'low' }>`，由 VLM `figure_ids` 映射回 `nodeToStructured` 时记录的 question id。
2. **`src/ai/task-prompts.ts`**（修改 `buildStructurePrompt`）：prompt 增加 figure 归属指令——「输入含 figures 列表（序号 + 页码），在对应 question node 上回填 `figure_ids`；跨页大题的图归到 stem」。
3. **`src/server/ingestion/figure_attach.ts`**（修改）：新增 `assignFiguresFromVlm(preFigures, figureAssignments, questions)`——优先用 VLM 归属，VLM 未覆盖的图 fall back 到现有 `assignFigures` 几何启发式（regression safety——VLM 漏判不能丢图）。`attach_confidence` 来自 VLM（high/low）；fallback 图标 'low'。**保留 `assignFigures` 不删**（降级路径 + 腾讯单路径仍用）。
4. **`src/server/boss/handlers/tencent_ocr_extract.ts`**（修改）：
   - `:213-216` 把 `assignFigures` 调用换成 `assignFiguresFromVlm(allPreFigures, structure.figureAssignments, structure.questions)`，VLM 不可用/无归属时内部 fall back（不在 handler 写分支）。
   - `:227` 的 `page_spans` placeholder：当 VLM 归属带页信号时，用 `figureAssignment` 的 `page_index` 填真实 page_spans（仍用 full-bbox，VLM 不给像素 bbox——这是 ADR-0002 接受的边界），多页 block 写多 span。**这是 page_spans 从 placeholder 转真实空间信号的第一步**（block-assembly path-B 的 spatial 输入由此解锁）。
   - VLM 失败回落腾讯结构时（`:196-210`），figure 归属也回落 `assignFigures`（腾讯 bbox 路径），page_spans 保持 placeholder（无 VLM 页信号）。
   - `writeCostLedger` 不变（StructureTask 的 token 已计在 OCR job 内；figure 归属未新增 task）。
5. **`src/server/ingestion/block-assembly.ts`**（修改——**F4 owner 裁决：本章立即消费**，见 §6.4）：`:13-20` §0 注记解除——page_spans 在 VLM 路径有真实 page_index。path-B 从 semantic-only 升级为消费 spatial 信号：`projectBlock`（`:193-204`）附 `page_index` 给模型，且匹配逻辑利用页信号（页码不符的 block↔figure 候选降权/排除）。腾讯回落路径 page_spans 仍是 placeholder page 0——spatial 消费必须对 placeholder 安全降级（全 page 0 时退回 semantic-only 行为，零回归）。配套测试进 Slice A 测试矩阵。

**测试矩阵（Slice A）**：

| 测试 | 文件 | 分区 | 断言 |
|---|---|---|---|
| VLM figure_ids 解析 | `structure.test.ts` | unit | StructureNode 含 figure_ids 时 figureAssignments 正确映射到 question id |
| VLM 归属优先 | `figure_attach.test.ts` | unit | `assignFiguresFromVlm`：VLM 覆盖的图用 VLM 归属，未覆盖的 fall back 几何 |
| 多图正确分配（回归核心） | `figure_attach.test.ts` | unit | 3 题 3 图，VLM 各归各题 → 不再「全挂第一题」 |
| VLM 漏判保图 | `figure_attach.test.ts` | unit | VLM 只归 2/3 图 → 第 3 图几何 fallback 不丢 |
| handler 切换 | `tencent_ocr_extract.test.ts` | db | VLM 归属路径写真实 page_spans page_index；VLM 失败回落 assignFigures + placeholder span |
| OCR fixtures 回归守护 | 复用 `tests/fixtures/tencent_*` | db | 既有腾讯 fixture（cloze/split/nested）+ VLM stub 全绿（无 figure 归属回归） |
| path-B spatial 消费（F4） | `block-assembly.test.ts` | unit | 真实 page_index 时页信号参与匹配（跨页不符候选降权/排除）；全 placeholder page 0 时退回 semantic-only 行为（零回归） |

**验收线（Slice A）**：
- 多图多题卷子，VLM 归属下每图挂正确 question（不再全挂 root）。
- VLM 不可用 → 回落 `assignFigures` 几何，零图丢失，extraction 不硬失败（ADR-0002 regression safety 不变）。
- `page_spans` 在 VLM 路径携带真实 `page_index`（spatial 通道首次通）。
- 既有 `tencent_ocr_extract.test.ts` + `figure_attach.test.ts` + `structure.test.ts` 全绿；OCR fixtures 回归守护通过。
- `pnpm typecheck` / `pnpm lint` / `pnpm audit:schema`（figures/image_refs 已有 write path，本切片只改归属值不加字段——**零 migration**）/ `pnpm audit:partition` / `pnpm test`。

### Slice B — 副线：Note 族 skill 迁移（YUK-228 Note 部分）

**目标**：把 `task-prompts.ts` 三处 note 规范重复收编成一份 `src/subjects/<id>/skills/note/SKILL.md`，三个 Note task（Generate/Verify/Refine）共用；handler 按 §1.3 裁决传 `ctx.skills = resolveNoteSkill(subject)`，缺 skill 降级回现状 prompt 散文。

> **Attribution skill 缓**（owner 拍板）：本切片**只迁 Note 族**，不碰 Attribution。

**文件级步骤**：

1. **`src/subjects/<id>/skills/note/SKILL.md`**（创建——**F2 owner 裁决：本章补齐三科**，见 §6.4）：frontmatter `name: note` + `description`（subject 级 note 规范包，NoteGenerate/Verify/Refine 共用）+ 正文把 `noteTemplateTable` 的 5 维（definition/mechanism/example/pitfall/check）+ 三处散落的 note 规范散文收编成结构化规范。**wenyan + math + physics 三科一次落地**（physics 子目录是否存在由 impl lane 现场核实 `src/subjects/`；不存在则做存在的科目并回报 owner）。降级链语义不变：任何 subject 缺 note skill 仍回退现状散文，无回归。
2. **`src/subjects/note-skills.ts`**（创建，镜像 `quiz-gen-skills.ts`）：`resolveNoteSkill(subjectId, skillsRoot?)`——on-disk 发现 `src/subjects/<id>/skills/note/SKILL.md`，存在返回 `['note']`，否则 `undefined`。降级链同 quiz-gen。
3. **`src/server/boss/handlers/note_generate.ts`**（修改 `:192`）：`runTaskFn('NoteGenerateTask', input, { db, subjectProfile, skills: resolveNoteSkill(subjectProfile.id) })`。
4. **`src/server/boss/handlers/note_verify.ts`**（修改 `:236`）+ **`note-refine.ts`**（修改 `:194`）：同样传 `skills: resolveNoteSkill(...)`。
5. **`src/ai/task-prompts.ts`**（修改）：`buildNoteGeneratePrompt` / `buildNoteVerifyPrompt` / `buildNoteRefinePrompt` 把已迁进 SKILL.md 的规范散文**删薄**——保留 task-specific I/O 契约（输入/输出 JSON shape）+ profile.noteTemplate 注入（per-subject 数据仍走 profile，**不进 SKILL.md**——SKILL.md 是 subject 通用规范，noteTemplate 是 subject 具体值）。**关键不变量**：删薄后即使 skill 未加载（降级），prompt 仍能独立产出合格 note（散文删薄 ≠ 删空，留足 fallback 语义）。

> **owner 哲学对齐**（「代码只留任务描述/知识走 skill」）：SKILL.md 承载「什么是合格 note」的**领域知识**；task-prompt 留「输入是 X 输出 JSON shape Y」的**任务描述**。

**测试矩阵（Slice B）**：

| 测试 | 文件 | 分区 | 断言 |
|---|---|---|---|
| resolver 发现 | `note-skills.test.ts`（新建） | unit | wenyan 有 note skill → `['note']`；不存在的 subject → undefined |
| resolver 不误捞 quiz-gen | `note-skills.test.ts` | unit | `resolveNoteSkill` 不返回 `quiz-gen-*`；`resolveQuizGenSkillsForSubject` 不返回 `note` |
| 三 handler 传 skills | `note_generate.test.ts` / `note_verify.test.ts` / `note-refine.test.ts` | db/unit | runTaskFn 被调用时 ctx.skills === resolveNoteSkill(subject) |
| 降级链 | `note-skills.test.ts` | unit | 缺 note 目录 → undefined → handler 不传 → 现状 prompt（散文仍合格） |
| prompt 删薄不破契约 | `task-prompts.test.ts` | unit | 三个 buildNoteXxxPrompt 仍含 I/O JSON shape + noteTemplate 注入 |
| SKILL.md frontmatter | `note-skills.test.ts` | unit | `name === 'note'`（== 目录名，SDK 匹配键）|

**验收线（Slice B）**：
- 三个 Note task 经 SKILL.md 共用一份规范，`task-prompts.ts` note 散文去重。
- 降级链验证：wenyan 走 skill，缺 skill 的 subject 回退现状 prompt，零回归。
- runner 接线不变量保持：`skills: ctx.skills ?? []`（runner.ts 不改）。
- S2 三教训不变量（kind 词表单一权威不涉及本切片 / 语义合并缝隙：note vs quiz-gen 前缀隔离已验 / 显式 `[]` 默认禁用：缺 skill 仍走 `?? []`）。
- `pnpm typecheck` / `pnpm lint` / `pnpm audit:profile`（noteTemplate 仍在 profile，profile 校验不变）/ `pnpm test`。**零 migration**（纯 prompt + 新文件）。

### Slice C — 子线 1：SourcingTask 图片源接入（**F1 已拍板：(a) 提案 + accept**，见 §6.4）

> ~~本切片在 §6 F1 owner 拍板成本策略之前不进 impl~~ **F1 gate 已过（2026-06-06）：owner 选 (a)**，按下述默认推荐边界实现。排程不变：A+B merge 后进场。

**默认推荐边界（owner 可调）**：SourcingTask 自动检索线**不自动抽图片**（守 ADR-0002）。改为：检索到图片型源时，agent 记录一条 **`image_candidate` 提案**（URL + 题目摘要 + 为何判定为图片型源），写进 proposal inbox（复用 YUK-202 proposal 基建），**由用户显式 accept 才触发 VLM 抽图**——把「VLM 抽图」保持为用户授权的付费动作，与 `rescue.ts` 的 ADR-0002 语义一致。

**文件级步骤（默认边界）**：

1. **`src/core/schema/sourcing.ts`**（修改）：`SourcingTaskOutput` 加可选 `image_candidates?: Array<{ source_url, source_title, summary_md }>`（agent 检索到但无法纯文本抽取的图片型源）。`OF-1` 注记更新：HTML/TEXT 直接入库；图片型源转 image_candidate 提案（不自动抽）。
2. **`src/server/ai/mcp/tavily.ts`**（评估，可能不改）：`tavily_search` 返回结果是否含 `images` 字段需实测——若 Tavily search response 已带 image URLs，agent 可直接判源类型；若不带，agent 靠 `tavily_extract` 文本为空/含图标记推断。**这是 F1 的一个子问题**（见 §6）。
3. **`src/server/boss/handlers/sourcing.ts`**（修改）：parseOutput 后，`image_candidates` 走 **`writeAiProposal`**（实证 API：`src/server/proposals/writer.ts`，handler 经 `src/server/knowledge/proposals.ts:23` import；plan 早稿误写 `writeProposal`，**不存在该函数**）而非 INSERT question；文本 question 走现有路径不变。
   - **⚠️ 枚举加值连锁成本（Cross-统合核实，plan 早稿严重低估）**：新增 `image_candidate` 到 `aiProposalKinds`（`src/core/schema/proposal.ts:5-31`）会触发**至少 4 处**强制同步：
     1. `AiProposalPayload` discriminated union（`proposal.ts`，`parseAiProposalPayload` 走 `.parse`）必须加一个 `image_candidate` payload variant（`{ source_url, source_title, summary_md }`）。
     2. `proposal.test.ts:146` / `:338` 的 **AC-2 审计守护**：`sampleByKind` map 必须覆盖**每个** `aiProposalKinds`——漏一个直接 fail，必须补 `image_candidate` 样本。
     3. `proposal.test.ts:389-407` 的 `correctivePossibleByKind` 映射必须补 `image_candidate` 条目。
     4. `acceptProposal`（`proposals.ts:486`）的 kind dispatch 必须加 `image_candidate` 兑现分支（accept → 落 asset → VLM）。
   - 这不是「一个 enum 加值」的轻量改动，是一条贯穿 schema/test-guard/accept-dispatch 的纵切。**owner 在 F1 裁 (a) 提案边界时必须连带知晓此成本**；若 owner 选 (b) 自动抽图，则**完全不需要这条枚举加值**（走 ledger 守门即可），成本反而更低——这改变了 F1 (a) vs (b) 的成本权衡，见 §6 F1 修订。
4. **图片抽取兑现路径**（accept 时）：新建 handler / 复用 rescue 模式——accept image_candidate → 下载 URL bytes → 落 R2 建 `source_asset`（§1.2 前提）→ 调 `VisionExtractTask`（manual_rescue_only，已是付费授权语义）→ 产 `SourcedQuestion` → 走 source_verify gate。**cost 守门**：每次 accept 是一次显式付费，`writeCostLedger` 留痕（task_kind='sourcing_image_extract'），per-accept 一次调用（天然 per-job 上限 = 1 张图/accept）。

**测试矩阵（Slice C，默认边界）**：

| 测试 | 文件 | 分区 | 断言 |
|---|---|---|---|
| image_candidate 不自动抽 | `sourcing.test.ts` | db | agent 返回 image_candidates → `writeAiProposal`，**不** INSERT question，**不** 调 VLM |
| 文本路径不变 | `sourcing.test.ts` | db | 既有 HTML/TEXT question 路径回归绿 |
| AC-2 枚举守护（仅 (a) 边界） | `proposal.test.ts` | unit | 新 `image_candidate` 枚举值 → `sampleByKind`/`correctivePossibleByKind` 已补全，AC-2（`:146`/`:338`/`:389`）全绿 |
| accept 兑现 | 新 handler test | db | accept → 落 asset → VLM stub → SourcedQuestion → source_verify enqueue |
| cost 留痕 | accept handler test | db | writeCostLedger 写一行 sourcing_image_extract |
| 成本守门 | accept handler test | db | per-accept 一次 VLM 调用，无批量自动烧钱路径 |

**验收线（Slice C，默认边界）**：
- 图片型真题源可达（经 image_candidate 提案 + 用户 accept 进入检索池）。
- **没有任何后端自动路径无守门地调 VLM 抽图**（ADR-0002 守住）。
- 每次 VLM 抽图 cost 留痕（evidence-first）。
- 文本 sourcing 路径零回归。
- `pnpm typecheck` / `pnpm lint` / `pnpm audit:schema` / `pnpm test`。migration 评估（Cross-统合修订）：`image_candidate` 是 Zod 枚举值（`aiProposalKinds`），proposal 走 `experimental:proposal` event path，**预期零 DB migration**；但 impl lane **第一动作必须** Read `src/server/proposals/writer.ts` 确认 proposal kind 未落 DB enum 列（若落了则一个 enum 加值 migration）。同时必跑 `pnpm test` 让 `proposal.test.ts` 的 AC-2 守护（`:146`/`:338`/`:389`）全绿——这三处守护强制覆盖每个枚举值，是枚举加值的回归网。

---

## 3. Note skill 激活键语义裁决（汇总）

| 维度 | quiz-gen（先例） | Note（本计划裁决） |
|---|---|---|
| 键 | `(subject, kind)` | **`subject`**（不带 kind/artifact_type）|
| 目录 | `quiz-gen-<kind>/` | `note/`（单目录）|
| 共享范围 | 出题 + 验题同 kind | NoteGenerate + Verify + Refine 三 task |
| resolver | `resolveQuizGenSkills(s,k)` | `resolveNoteSkill(s)` |
| 降级 | 缺目录 → undefined → promptFragments | 同 |
| runner mirror | 复用 `runner.ts:264-295`（自动 mirror `skills/*`，含 `note/`，**不改 runner**）|

**裁决依据**：artifact_type（atomic/long/hub）是 NoteGenerateTask 内的 type switch（`task-prompts.ts:206`），三种共享同一规范，不构成分目录维度；三个 task 也同源。故 subject 级单 skill 是最小正确粒度。

---

## 4. 成本守门设计（汇总，对齐 owner evidence 偏好）

| 路径 | 触发 | 付费语义 | 守门 | 留痕 |
|---|---|---|---|---|
| 子线 2 figure 归属 | OCR job 内（StructureTask） | 已付费上下文（用户上传触发） | 无需新增（同 StructureTask） | StructureTask 已计 ledger；归属无新 task |
| 副线 Note skill | runTask（Note tasks） | 零新增 token（skill 只是 prompt 替换） | N/A | N/A |
| 子线 1 文本 sourcing | 后端自动/手动 | 现有（无图） | 现有 source_verify gate | 现有 event + ledger |
| 子线 1 图片抽取 | **用户 accept image_candidate** | **用户授权付费**（ADR-0002 对齐） | per-accept = 1 张图，无批量自动 | `writeCostLedger(sourcing_image_extract)` per-accept |

**全局原则**：
- 任何 **后端自动** 路径不得无守门调 VLM（ADR-0002）。子线 1 的图片抽取靠「提案 + 用户 accept」把付费决策交还用户。
- cost-cap（`maxCost`）仍是 phase-deferred（T-PD4）——本计划**不实装全局 cost meter**（反过度工程），但每个新 VLM 调用点必 `writeCostLedger` 留 per-call 痕（owner evidence 偏好的最小满足）。

---

## 5. 测试分区 / 守护汇总

- **unit 分区**（无 DB）：`structure.test.ts`、`figure_attach.test.ts`、`note-skills.test.ts`、`task-prompts.test.ts`。不得 import `tests/helpers/db` / `@/db/client` / `postgres` / `drizzle` / `PgBoss`。
- **db 分区**：`tencent_ocr_extract.test.ts`、`sourcing.test.ts`、Note handler tests、accept handler test。
- **OCR fixtures 回归守护**：复用 `tests/fixtures/tencent_mark_agent_cloze_sample.json` / `tencent_question_split_sample.json` / `tencent_question_split_nested_sample.json` + VLM stub（`runStructureFn` deps override，`tencent_ocr_extract.ts:46`）。Slice A 改 figure 归属路径**必须**让这三个 fixture 的既有断言全绿（无结构回归）。
- 每 slice 收尾跑 `pnpm audit:partition`（防 unit/db 误分）+ 对应 watch loop。
- PR 前：`pnpm typecheck` / `pnpm lint` / `pnpm audit:schema` / `pnpm audit:partition` / `pnpm audit:profile` / `pnpm test` / `pnpm build`。

---

## 6. 风险 / 回滚 / OWNER-FORK

### 6.1 风险

| 风险 | 切片 | 缓解 |
|---|---|---|
| VLM figure 归属污染结构质量 | A | prompt 实测；若污染则 fork 独立 task（F3）。fallback `assignFigures` 始终保留 |
| VLM 跨页归属不可靠 | A | page_spans 仍可降级 placeholder；几何 fallback 兜底 |
| 删薄 note prompt 破坏降级合格性 | B | 删薄≠删空，留 fallback 语义；测试断言 prompt 仍含契约 |
| Tavily search 不返回 image URLs | C | F1 子问题，需实测；agent 可靠 extract 空文本推断 |
| 图片抽取自动化烧钱 | C | 默认边界改提案+accept（ADR-0002）|

### 6.2 回滚

- **Slice A**：`assignFigures` 不删 → handler 一行回切 `assignFigures(allPreFigures, structure.questions)` 即回 slice-2 行为；StructureNode `figure_ids` 是可选字段（VLM 不报则空）。
- **Slice B**：handler 不传 `skills` 即回现状（降级链天然回滚）；删 `note/SKILL.md` → resolver 返 undefined → prompt 散文路径。task-prompt 删薄需保 git 可还原（不删散文备份在 commit history）。
- **Slice C**：image_candidate 是 additive 字段；不写提案则纯文本路径，与今天等价。

### 6.3 OWNER-FORK 清单

**F1（必须，blocking Slice C）— 子线 1 图片源自动抽取的成本策略**
- 背景：SourcingTask 是后端自动可触发的检索线；ADR-0002 定 VLM 抽图为「用户授权的付费动作」。把检索到的图片 URL 自动 VLM 抽题会让 auto 路径无守门烧钱。
- 默认推荐（本计划）：**不自动抽**，转 image_candidate 提案 + 用户 accept 才 VLM 抽（守 ADR-0002，付费决策交还用户）。
- Owner 需裁：
  - (a) 接受「提案 + accept」边界？**成本核实（Cross-统合）**：守 ADR-0002 最干净，但**需新增 `image_candidate` proposal 枚举值**，连带 payload variant + AC-2 sample 守护 + corrective 映射 + accept dispatch（4 处纵切，见 §2 Slice C step 3）。**非零 migration 风险**：proposal 走 `experimental:proposal` event path（枚举是 Zod，非 DB enum 列），所以**预期零 DB migration**，但需 Cross-统合在 impl 前 Read `src/server/proposals/writer.ts` 确认 proposal kind 未落 DB enum 列（若落了则需 migration——impl lane 第一动作核实）。
  - (b) 允许 SourcingTask **自动** VLM 抽图，但加 per-job 图片数上限（如每 sourcing job ≤ N 张）+ ledger 守门？（这会松动 ADR-0002，需同步修 ADR）。**成本核实（Cross-统合）**：反直觉地，(b) **不需要 image_candidate 枚举加值**（不走 proposal inbox），代码连锁更少；代价是松动 ADR-0002 红线 + 失去「用户授权付费」语义。**(a) 守纪律但代码量大、(b) 代码省但破授权语义——这是真实的 trade-off 反转，owner 须知情后裁。**
  - (c) 子问题：Tavily `tavily_search` 响应是否需开启/解析 image 字段（决定 agent 如何识别图片型源）。**实证（Cross-统合）**：`src/server/ai/mcp/tavily.ts:14-44` 只暴露 `tavily_search` + `tavily_extract`，`crawl/map/research` 显式排除；search response 的 image 字段需 impl lane 实测 Tavily 真实返回形状（plan 早稿假设，未核实），若不带则靠 extract 空文本推断（已在 §6.1 风险表登记）。

**F2（建议，可异步）— Note skill 覆盖范围**
- 本计划 Slice B 只做 wenyan note skill（math/physics 缺 → 降级回现状，无回归）。
- Owner 需确认：math/physics 的 note SKILL.md 是本章补还是下一章？（降级链保证不补也安全。）

**F3（条件触发）— 子线 2 figure 归属是否独立成 task**
- 默认：figure 归属塞进 StructureTask 单次输出（零新增付费点）。
- 若 prompt 实测证明 figure 归属字段污染结构质量 → fork 独立 figure-assign task（新增一次 VLM 调用，仍在 OCR 付费上下文内）。届时回 owner 确认接受额外 token。

**F4（建议）— page_spans 真实化范围**
- Slice A 让 VLM 路径 page_spans 带真实 page_index（full-bbox，无像素 bbox——ADR-0002 边界）。
- Owner 需确认：本章是否要 block-assembly path-B **立即消费** spatial 信号（从 semantic-only 升级），还是仅打通通道、消费留下一章？（默认：仅打通，消费留后——反过度工程。）

### 6.4 Owner 裁决记录（2026-06-06）

四个 fork 已由 owner 拍板（AskUserQuestion，当日）：

| Fork | 裁决 | 对 plan 的影响 |
|---|---|---|
| **F1** | **(a) 提案 + accept**（守 ADR-0002） | Slice C 解锁，按默认推荐边界实现：image_candidate 提案 + 用户 accept 兑现。枚举纵切 4 处照付（§2 Slice C step 3）；impl 第一动作核实 proposal kind 未落 DB enum 列。 |
| **F2** | **本章补齐三科**（偏离推荐） | Slice B 扩容：wenyan + math + physics 三个 note SKILL.md 一次落地（physics 子目录是否存在由 impl lane 现场核实；不存在则做存在的科目并回报）。降级链语义不变。 |
| **F3** | **届时回来找我**（默认） | figure 归属塞 StructureTask 单次输出；实测污染时停下上交 owner，不预授权 fork 独立 task。 |
| **F4** | **本章立即消费**（偏离推荐） | Slice A 扩容：block-assembly path-B 从 semantic-only 升级为消费 spatial 信号——`projectBlock` 附 `page_index` 给模型且 path-B 匹配逻辑利用页信号，配套测试。§2 Slice A step 5 的「不强制消费」改为「本章消费」。 |

---

## 7. Linear 捕获

- 主线 YUK-227（图片素材可达性）：本计划覆盖子线 1（Slice C）+ 子线 2（Slice A）。
- 副线 YUK-228（Note 族 skill 迁移）：本计划覆盖 Note 部分（Slice B）；Attribution 部分按 owner 拍板**缓**，应在 YUK-228 留 comment 标注 Attribution 延后 + 解除条件。
- 落 issue 动作（实施时）：为 F1 owner 裁决结果建/更新 YUK-227 子 issue；F2/F4 若延后，在对应 issue 留可检查的 deferred 注记。

---

## 8. Cross-统合修订记录（2026-06-06，有否决权 agent）

> 全部锚点对 fresh main 逐行 Read 复核。逐条裁决；BLOCKER 必须解决后才 SHIP。

### 8.1 逐条裁决

| # | 条目 | 裁决 | 依据（实证） |
|---|---|---|---|
| 1 | §0.1 子线 1 现状（sourcing.ts:15-16 OUT 注记、SourcedQuestion 全文本、tavily 仅 search+extract） | **ACCEPT** | `sourcing.ts:15-16` / `:30-58` / `tavily.ts:14-44` 全部逐行核实属实 |
| 2 | §0.2 子线 2 现状（VLM 树无 bbox → assignFigures 全挂 root） | **ACCEPT** | `figure_attach.ts:50-58` `candidatesWithBbox.length===0`→`scopeRoot` 'low' 实证；`PreAttachFigure` 有 `asset_id/source_page_index/source_bbox`（`crop.ts:10-14`），figure_index 映射可行 |
| 3 | §1.1 VLM 授权语义（StructureTask=auto / VisionExtract=manual_rescue_only） | **ACCEPT** | `registry.ts:49`（语义）/`:86,100`（rescue manual）/`:118-120`（StructureTask 默认 auto，注释实证）。核心裁决成立 |
| 4 | §1.3 Note skill 键=subject 级单目录三 task 共用 | **ACCEPT** | `runner.ts:101-120,362-369` skills 接线 `?? []` 不变量实证；`quiz-gen-skills.ts:94` `startsWith('quiz-gen-')` 前缀隔离实证；note 目录不冲突。键裁决正确 |
| 5 | §2 Slice A figure 归属塞 StructureTask 单次输出 + assignFigures 保留 fallback | **ACCEPT** | regression-safe，零 migration（只改归属值不加字段）；ADR-0002「VLM 不给像素 bbox」边界守住 |
| 6 | §2 Slice B Note handler 接线（note_generate.ts:192 等三处传 skills） | **ACCEPT** | `note_generate.ts:192` 第三参数 `{db, subjectProfile}` 无 skills 实证；`note_verify.ts:236`/`note-refine.ts:194` 同形态。接线方案精确 |
| 7 | §2 Slice C step 3 `writeProposal(image_candidate)` | **REVISE（BLOCKER）** | **不存在 `writeProposal`**；实证 API 是 `writeAiProposal`（`src/server/proposals/writer.ts`，`proposals.ts:23` import）。已修正 |
| 8 | §2/§6 image_candidate「一个 enum 加值」成本评估 | **REVISE（BLOCKER）** | 严重低估。`aiProposalKinds`（`proposal.ts:5-31`）加值连锁 ≥4 处：payload variant + AC-2 守护（`proposal.test.ts:146/338`）+ corrective 映射（`:389`）+ acceptProposal dispatch。已在 §2 Slice C step 3 + §6 F1 + 测试矩阵补全 |
| 9 | §6 F1 (a) vs (b) 成本权衡 | **REVISE** | 反转发现：(a) 守纪律但代码量大（枚举纵切），(b) 代码省但破 ADR-0002。owner 须知情此 trade-off 反转后裁。已在 §6 F1 补全 |
| 10 | §6.1 风险表「Tavily search 不返回 image URLs」 | **ACCEPT（标 impl 实测）** | `tavily.ts:35` 仅 search+extract；image 字段 plan 早稿假设未核实，已在 §6 F1(c) 标 impl lane 实测 |
| 11 | §2 排程 A‖B → F1 gate → C | **ACCEPT** | A（OCR 付费上下文内）、B（零成本 prompt 重构）无共享文件可并行；C 触 ADR-0002 红线须 F1 gate 后。排程合理 |

### 8.2 BLOCKER 解决状态

- **BLOCKER-1（错误 API 名 `writeProposal`）**：已修正为 `writeAiProposal`（§2 Slice C step 3）。**RESOLVED**。
- **BLOCKER-2（枚举加值成本低估）**：已补全 4 处纵切 + 测试矩阵 AC-2 守护行 + 验收线 migration 评估。**RESOLVED**。

两个 BLOCKER 均在 schema/test-guard 层、不影响 Slice A/B 进场，且仅当 owner 在 F1 选 (a) 边界时才落地。Slice A/B 无 BLOCKER。

### 8.3 全局一致性核查

- **S2 刚 merge 面交互**：runner skills `?? []` 不变量（S2 第三教训）— Slice B 不改 runner mirror/接线，仅 handler 传 `resolveNoteSkill(subject) ?? undefined`，不变量保持。**PASS**。
- **kind 词表单一权威**（S2 第一教训，`src/subjects/question-kind.ts`）：本计划三切片均不触 question-kind 词表（Note 的 artifact_type 是独立维度，figure 归属不涉 kind）。**PASS**。
- **语义合并缝隙**（S2 第二教训）：note vs quiz-gen 前缀隔离已实证（`startsWith('quiz-gen-')` vs note 精确名）。**PASS**。
- **ADR-0002 OCR 决策**：Slice A 守「VLM 不给像素 bbox，crop 仍用腾讯 bbox」边界；Slice C 默认边界 (a) 守「VLM 抽图=用户授权付费」。**PASS（F1 (b) 若选则需同步修 ADR-0002，已在 F1 登记）**。
- **YUK-221 等已知缺口**：本计划不与 YUK-221 冲突（不同模块）；Slice A page_spans 真实化是 block-assembly path-B（YUK-202）spatial 输入的前置打通，F4 已登记「消费留下一章」防过度工程。**PASS**。
- **OCR fixtures 回归守护**：三个 tencent fixtures（cloze/split/nested）实证存在于 `tests/fixtures/`；§5 已要求 Slice A 改归属路径后三 fixture 断言全绿。**PASS**。

### 8.4 OWNER-FORK（不擅自拍板，显式上交）

- **F1（blocking Slice C）**：子线 1 图片源成本策略 (a) 提案+accept（守 ADR-0002，代码纵切 ≥4 处）vs (b) 自动抽+ledger 守门（代码省，破 ADR-0002）。**trade-off 已澄清，owner 裁。**
- **F2（可异步）**：Note skill 覆盖范围（本章仅 wenyan，math/physics 降级安全）。
- **F3（条件触发）**：figure 归属是否独立成 task（默认塞 StructureTask 单次）。
- **F4（建议）**：page_spans 真实化后 block-assembly 是否本章立即消费（默认仅打通，消费留后）。

### 8.5 裁决统计

- ACCEPT：8（§0.1/§0.2/§1.1/§1.3/Slice A/Slice B/F1(c) 实测标注/排程）
- REVISE：3（其中 2 个 BLOCKER 已 RESOLVED：错误 API 名、枚举成本；1 个 F1 trade-off 澄清）
- REJECT：0
- BLOCKER：2，均 RESOLVED
- 全局一致性：6/6 PASS

### 8.6 SHIP/HOLD

**SHIP**（Slice A + Slice B 可立即进 impl；Slice C 待 OWNER-FORK F1 gate）。两个 BLOCKER 在文档层已解决，无 REJECT；Slice C 进场受 F1 显式 gate 保护，owner 拍板前不落地。
