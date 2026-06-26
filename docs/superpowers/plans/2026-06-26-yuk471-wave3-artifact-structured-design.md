# YUK-471 Wave 3 — `artifact` + `question_block.structured` event-sourcing（合流 YUK-358 笔记域）

**Date**: 2026-06-26
**Status**: Design / ready-to-review（设计领先实施；本文不实施代码，落地按 §7 PR lane 序）
**Part of**: YUK-471（event-sourcing foundation redesign，parent YUK-203）。本文是该 epic 内部 **Wave 3** 的实施设计（末波、最难、合流面最大）。
**Decision source**:
- `docs/design/2026-06-15-event-sourcing-foundation-redesign.md`（ADR-0044 草案 + §A 重算引擎四路深挖 + §5 分 Wave + §2 补字段 #1-#7 + §3 reducer 模式 + §5.2 原子写契约）—— 本文 **不重复推导**，引用其结论。
- `docs/adr/0040-notes-domain-rethink-living-note-contract.md`（笔记域 9 决策：A/B 出手契约、user_verified 硬边界、统一撤销链、history 双轨合一、verify advisory、dwell 下线、embedded_check 真删）。
- `docs/design/2026-06-15-notes-domain-current-map.md`（笔记域六层现状 + 写点 + 遗留债，grounded file:line）。
- `docs/superpowers/plans/2026-06-15-unified-impl-wave-sequence.md`（跨线波次序：Wave 3 = unified W6，**必须在 checkpoint W7 前**）。
**Related ADR**: ADR-0044（event=SoT 大改造）· ADR-0040（笔记域 re-think）· ADR-0041（checkpoint 腿，被本改造 gated）· ADR-0006（event=SoT）· ADR-0034（KG 一致性闸，W1 已装）· ADR-0035（mastery_state 物化）· ADR-0020（note artifact 三约定）。

> 文中 file:line 均经 2026-06-26 code-ground 复核（post-W1）。旧设计 doc §6 的若干坐标已随 W1 落地漂移，本文用复核后的现行坐标。

---

## 0. 一句话结论

Wave 3 把两张「结构性 projection」切成 event-sourced：

- **(A) `question_block.structured`（ingestion 域，纯 event-sourcing）**——根因是它的编辑写 `job_events` 而非 canonical `event` 表，payload 只有 `{op, node_id}`（**完全不自足、不可重放**，全 epic 最大缺口）。工作 = 把编辑迁回 canonical event + payload 携编辑后全量 structured 快照 + 建 fold reducer。与笔记域**无关**。
- **(B) `artifact`（notes/copilot 域，合流 YUK-358）**——14 个写者跨 notes/copilot/ingestion 多 capability，事件留痕从「自足」到「无事件」横跨整个光谱。工作 = 补字段让创建/编辑自足 + 把所有写收口到**单一原子写闸** + 建 fold reducer。**这条与 ADR-0040 的笔记域 re-think 触同一张 `artifact` 写面，硬约束「不平行造两套 artifact 写契约」**——本文的核心净增内容就是把 event-sourcing 写闸与 ADR-0040 的 A/B 出手 + user_verified 硬边界 + 统一撤销 + 时间线合一**做成一条契约**。

真正的工程量不在重算引擎本身（W1 已立两个成熟 fold 范式可推广），而在 **补 event payload 自足 + 写点收口**。

---

## 1. 前置状态确认（code-grounded，2026-06-26）

| Wave（design doc §5 内部波次） | 内容 | 状态 |
|---|---|---|
| **W0** | mastery/FSRS 快照可逆 + cascade CTE 骨架 + 级联 revert 编排器 | ✅ 已落（`src/server/events/cascade.ts`、`corrections.ts`、cascade-revert capstone + 多轮 review fix） |
| **W1** | `knowledge` / `knowledge_edge` 真 fold + genesis backfill + SoT flip（flag） | ✅ 已落（`src/core/projections/knowledge.ts`/`knowledge_edge.ts` 纯 fold + `src/server/projections/*` IO 壳 + `materialized-id-index.ts` + `audit:projection` + `PROJECTION_IS_WRITER` flag + guarded 非删 keystone） |
| **W2** | `goal` / `mistake_variant` / `learning_item` fold | ⚠️ **未做**。无 fold reducer。但 `learning_item` 的 retract 半边已落（`RateEvent.payload` 已含 `materialized_learning_item_id` / `materialized_prior_status` / `materialized_prior_completed_at`，来自「retract reverses completion/relearn」commit） |
| **Wave 3** | `artifact` + `question_block.structured` + 补字段 #2-#7 | 🎯 **本文目标**。无 fold reducer，无独立实施设计文档 |

**依赖现实**：按波次序，Wave 2 应在 Wave 3 *实施* 前落（同 fold 范式、写点更简单）。Wave 3 *设计* 可提前（本文）。Wave 3 是 unified-wave-sequence 的 **W6**，**必须落在 checkpoint（W7）之前**——copilot 的 `author_artifact`/`update_artifact`/`learning_item` 生命周期写面全落这些表，不 event-source 化它们，checkpoint 的级联 revert 撤不动命令式写（Codex P2）。

---

## 2. 现状写面审计（复核后坐标）

### 2.1 `artifact` — 14 写者，事件留痕光谱

| 写者 | file:line | 操作 | 写 canonical event? |
|---|---|---|---|
| `runNoteGenerate` | `src/capabilities/notes/jobs/note_generate.ts:207-226` | UPDATE body_blocks / generation_status / generated_by | ❌ 无（job_events 只记进度） |
| `editArtifactBodyBlocks` | `src/capabilities/notes/server/body-blocks-edit.ts:88-110` | UPDATE body_blocks / history / version | ✅ `experimental:artifact_body_blocks_edit`（:110）—— **但 payload 不含新 body_blocks**（旧 §A 缺洞 #2） |
| `persistNoteRefineApply` | `src/capabilities/notes/server/note-refine-apply.ts:155-205` | UPDATE body_blocks / version | ✅ `experimental:note_refine_apply`（:177）—— **唯一完全自足**（`ops` + `previous_body_blocks` + `reverse_patch`） |
| `editArtifactSection` | `src/capabilities/notes/server/sections.ts:133-170` | UPDATE body_blocks / history / version | ✅ `experimental:artifact_section_edit`（:156）—— payload 自足度待核 |
| `authorArtifactTool`（author_artifact） | `src/server/ai/tools/author-artifact.ts:108-131` | INSERT（interactive） | ❌ 无（DomainTool，靠 `mirrorEvent:'when_causal'` 异步补，非 tx 内） |
| `updateArtifactTool`（update_artifact） | `src/server/ai/tools/author-artifact.ts:200-260` | UPDATE（html 替换） | ❌ 无 |
| `writeToolQuizArtifact` | `src/server/ai/tools/tool-quiz-core.ts:48-74` | INSERT（tool_quiz） | ❌ 无 |
| `acceptLearningIntent` | `src/server/orchestrator/learning_intent.ts:673-753` | INSERT ×3（hub/atomic/long stub） | ❌ 无 artifact 事件（RATE event 在 :756，不重建 artifact 行） |
| `createIngestionPaper` | `src/capabilities/ingestion/server/make-paper.ts:324-349` | INSERT（tool_quiz from imported） | ❌ 无 |

**Schema**：`src/db/schema.ts:422-445`。不可派生列：`type, title, parent_artifact_id, knowledge_ids, intent_source, source, source_ref, body_blocks, attrs, tool_kind, tool_state, generation_status, verification_status, verification_summary, generated_by, verified_by, history, archived_at, version`。

### 2.2 `question_block.structured` — 整体在 job_events 层

- `persistStructured` `src/capabilities/ingestion/server/block-structured-edit.ts:123-150`：UPDATE `question_block.structured`（整树替换）+ figures + version，然后 `writeJobEvent`（:143，`business_table:'question_block'`, `event_type:'block.structured_edited'`），payload 只有 `{op, node_id}`。
- 六个 op 全经 `persistStructured`：`updatePrompt` / `addOption` / `setQuestionType` / `splitStem` / `mergeQuestions` / `reassignFigure`。
- `writeJobEvent` `src/server/events/writer.ts:22-46`（写 `job_events`，pg_notify，无 outbox、不在 KnownEvent union、不被任何重算覆盖）。
- `event.subject_kind` 枚举**无 `'question_block'`**（现含 `question/knowledge/knowledge_edge/artifact/source_document/event/chip/query`）。

### 2.3 现成 fold 范式（W1，直接推广）

- 纯 fold：`src/core/projections/knowledge.ts:101-350`（`foldKnowledgeNode(nodeId, events): Row|null`，两遍——pass1 accept-resolve index + pass2 ordered apply）；`knowledge_edge.ts:120-250`（`foldKnowledgeEdge(edgeId, events, liveMesh)`，含 ADR-0034 拓扑校验，reject 即 throw）。
- IO 壳：`src/server/projections/knowledge.ts:77-105`（`projectKnowledgeNode`：gather → 纯 fold → upsert/delete）+ **guarded 变体** `projectKnowledgeNodeGuarded`（genesis-anchor gate：fold-null 只在「有创世锚」时 DELETE，未 backfill 的旧行**永不删**——SoT-flip-before-backfill 的安全 keystone）。
- `FoldEvent` 扁平信封被 core + server 共用，按 event id 去重。
- 写入闸：`writeEvent` `src/server/events/queries.ts:1020-1065`（INSERT-only + parse barrier + outbox）。

---

## 3. 补字段清单（Wave 3 build list；引用 §A，复核坐标）

| # | 优先级 | 位置 | 补什么 | 原因 |
|---|---|---|---|---|
| 2 | P0 | `body-blocks-edit.ts:88-110` 的 event payload | 加 `body_blocks`（编辑后全量树）或 `ops` | `artifact_body_blocks_edit` 当前 payload 不含新 body，不可重放 |
| 3 | P0 | `note_generate.ts:207-226` | 成功后**同 tx** 写 artifact 创建/更新 event | AI 生成正文完全不进事件流 |
| 4 | P0 | `GenerateArtifact.payload` `src/core/schema/event/known.ts:222-237`（现 `{artifact_kind, title, body_md, referenced_event_ids?}`） | 扩为可重建行：加 `body_blocks?`, `type`, `intent_source`, `source`, `source_ref?`, `parent_artifact_id?`, `knowledge_ids?`, `tool_kind?`, `tool_state?`, `attrs?` | 创建事件不足以重建 artifact 行；现 payload 是 `body_md:string`，note 用 `body_blocks` 结构树 |
| 5 | P0 | 新 KnownEvent `EditQuestionBlockStructured` | `subject_kind:'question_block'`（新增）+ 编辑后**全量 structured 快照** | structured 编辑写 job_events 且 payload 不含值 |
| 6 | P0 | `block-structured-edit.ts:143` | `writeJobEvent` → `writeEvent`（canonical） | job_events 不在事件真相层 |
| 7 | P1 | artifact 生命周期状态转移（generation/verification status） | `experimental:artifact_status` event 或扩 GenerateArtifact outcome | status 转移无事件 |

> 补字段 #1（`RateEvent.materialized_ids`）**已在 W1 落**（`known.ts:244-292` 已含 `materialized_ids{knowledge, knowledge_edge}`）。Wave 3 创建 artifact 走 propose→accept 时若需锚定新 artifact id，沿用同机制扩 `materialized_ids.artifact`。

**两个 owner 待拍的形态选择**（§9）：#5 用「新 action `edit`」还是「`experimental:block_structured_edited`」；#6 是否真删 `job_events` 的 `block.structured_edited` 分支（落地后做删除验证）。

---

## 4. 合流 YUK-358：单一 artifact 写契约（核心净增）

**问题**：ADR-0040 的笔记域 9 决策与 Wave 3 的 event-sourcing 改造**触同一张 `artifact` 写面**。若各自落地 = 两套写契约（ADR-0040 走 `apply-note-patch` mutator/propose 路；Wave 3 走 `applyStructuralMutation` 重算路），正是 design doc 明令禁止的。本节把二者收成**一条**。

### 4.1 对齐矩阵：ADR-0040 决策 ←→ Wave 3 机制

| ADR-0040 决策 | Wave 3 event-sourcing 机制 | 合流结论 |
|---|---|---|
| **§1 统一撤销链**（mutator + propose-accept → 一个 ai-changes undo；给 `retractAiProposal` 补 note_update `body_blocks` 回退分支，复用 `reverse_patch`） | 级联 revert（W0 `cascade-revert.ts`）+ artifact fold 重算自动复原 body_blocks | event-sourcing **就是**统一撤销的底座：artifact body 可从 event 流重算后，撤一条 artifact 编辑 event → fold 自动复原前态，撤销链天然单一。`reverse_patch` 从「手写回退分支」降级为「fold 的优化捷径」 |
| **§5 history 双轨合一**（人工编辑写 `artifact.history` jsonb / AI refine 走 event 表，reader timeline 只见前者） | 补字段 #2/#3/#4 让**所有** artifact 写（人工 + AI）都进 canonical event | 双轨分裂**由 event-sourcing 直接消解**：所有 mutation 进同一 event 流，reader timeline 读 event 流即单轨。`artifact.history` jsonb 降级为派生缓存（或退役） |
| **§1 user_verified 硬边界**（`apply-note-patch` 对 user_verified 块拒绝 mutator 直改，强制 propose；现 grep 零命中） | 单一原子写闸 `applyStructuralMutation`（§5.2）= 所有结构写的唯一入口 | user_verified guard + A/B 路由**钉在写闸里**：写闸是唯一 choke point，guard 放这里就**结构性不可绕**（不像散在各 mutator 里靠记得加） |
| **§1 A/B 出手分档**（小可逆改 + 不触 user_verified → A 自动 + 撤销窗口；大改或触 user_verified → B propose 人审） | `applyStructuralMutation` 在写 event 前做 tier 判定 | A 档 = 直接写 event + fold（带撤销窗口，撤销走级联 revert）；B 档 = 写 propose event 进收件箱，accept 时才走写闸。**同一写闸两条出口** |
| **§7 note_verify advisory**（不再产 patch-less note_update proposal；issues 落 `verification_summary` + 可选触发 refine） | verify 不写结构 event，只写 advisory（artifact `verification_summary` 列，补字段 #7 的生命周期 status 可选纳入） | verify 与写闸**解耦**：verify 是诊断（advisory），refine 才经写闸出手。死提议 bug 随之消除 |
| **§3 check 段 self-explanation + 真删 embedded_check**；**§6 dwell 下线** | 与 event-sourcing **正交**（删孤儿端点/列/boss.send/触发信号，不碰写闸） | **不在 Wave 3 实施范围**，但清债顺序上：dwell 下线 + embedded_check 真删应**先于或并行**写闸收口，避免给死路径补 event（给要删的 `embedded_check_*` 补 event payload 是浪费）。本文标依赖，不实施 |

### 4.2 合流的单一写闸（语义）

```
applyArtifactMutation(tx, intent):           // notes + copilot 所有 artifact 写的唯一入口
  1. tier = classifyTier(intent)             // ADR-0040 §1：可逆性 + user_verified → A | B
  2. if intent.touches_user_verified_block && tier !== 'B':
         → 强制 B（ADR-0040 §1 硬边界，结构性不可绕）
  3. if tier === 'B':
         writeEvent(tx, ProposeArtifactChange{...})   // 进收件箱，accept 时再调本闸
         return { proposed: true }
  4. // A 档：直接出手
     event = writeEvent(tx, <ArtifactCreate|EditArtifact|...>{ payload: 自足快照 })
     affected = deriveAffectedArtifactIds(event)
     for id in affected:
         rows = gather all events for (subject_kind='artifact', id)
         projectionRow = foldArtifact(id, rows)        // 纯 fold（§5）
         upsertArtifact(tx, projectionRow)             // 重算写回，同 tx
     return { applied: event.id }                      // 撤销 = 级联 revert 这个 event
```

`question_block.structured` 走**同构但独立**的 `applyQuestionBlockStructuredMutation`（ingestion 域，无 A/B tier、无 user_verified——纯 OCR 编辑，直接 A 档语义；只复用写闸的「写 event → fold → upsert」三步骨架）。

---

## 5. 重算引擎蓝图（镜像 W1）

每张表两件，签名对齐 W1：

| 件 | `artifact` | `question_block` |
|---|---|---|
| **纯 fold（core）** | `src/core/projections/artifact.ts` → `foldArtifact(id, events: FoldEvent[]): ArtifactRowSnapshot \| null` | `src/core/projections/question_block.ts` → `foldQuestionBlockStructured(blockId, events): StructuredSnapshot \| null` |
| **IO 壳（server）** | `src/server/projections/artifact.ts` → `projectArtifact` + `projectArtifactGuarded`（genesis-anchor gate，同 W1） | `src/server/projections/question_block.ts` → `projectQuestionBlockStructured`（+ guarded 变体） |

**fold 输入事件（按 `created_at, id` 排序）**：

- **artifact**：`<ArtifactCreate>`（补 #4）、`artifact_body_blocks_edit`（补 #2 全量 body）、`note_refine_apply`（已自足）、`artifact_section_edit`、生命周期 status（补 #7）。起始 = 创建事件；每个 edit → 取 payload 全量 body_blocks 替换，bump version + 追 history。
- **question_block**：起始 = OCR extract 时的 structured（**注意**：extract 本身也需进 event 或当 genesis 锚，见 §9 开放点）；每个 `EditQuestionBlockStructured`（补 #5）→ 取 payload 全量 structured 快照替换树。

**跨实体一致性**（§A 警告）：knowledge merge / artifact `mergeQuestions` 一个事件影响多行，reducer 必须**以整批 events 为单位**（非 per-entity 独立 fold），否则跨实体一致性断。W1 的 `foldKnowledgeNode` 已用 Q1+Q2+Q3 gather 解决「merged-into」的多源问题——artifact/question_block 的 merge 沿用同 gather 思路。

**物化策略**：materialized write-through（同 W1、同 `upsertFsrsState`），projection 表降级为 event 流缓存，真相在 event。读时 fold 不可接受（KG/note reader 高频读 + 大量 join）。

**audit gate**：`pnpm audit:projection` 扩两张表的全量 fold diff（W1 已建该命令），非空 diff = drift fail。

---

## 6. 迁移顺序（避免 big-bang，沿 W1 双写期 + flag 模式）

1. **补 payload（P0 #2-#6）**：事件先变自足，旧写点照旧（双写期），新增 `subject_kind:'question_block'`。
2. **影子重算 + audit:projection 只读对账**：跑出现有不一致清单（预期 `note_generate` / structured 大面积 drift，因事件本就缺）。先建 reducer + audit，**不翻 SoT flag**。
3. **逐写者收口到写闸**：按自足度从右向左——`note_refine_apply`（已自足，最先）→ `body_blocks_edit` / `section_edit` → `author_artifact` / `update_artifact`（copilot）→ 创建散点（`note_generate` / `tool-quiz` / `learning_intent` / `make-paper`）→ `question_block.structured`（最重，整体迁 canonical event）。每写者经 `PROJECTION_IS_WRITER`-style flag + guarded 非删 keystone 保护。
4. **删 `job_events` 的 `block.structured_edited` 分支**（#6 落地、SoT flip 后）+ 删除验证。

---

## 7. PR lane 序（镜像 W1 的 PR-A/B 切法，建议）

| Lane | 内容 | 独立可验证判据 | 依赖 |
|---|---|---|---|
| **W3-A1** | `foldArtifact` 纯 reducer（core）+ `FoldArtifact` 事件 typed schema + 补字段 #4（GenerateArtifact 扩展）+ #2（body_blocks_edit payload 携全量） | `foldArtifact(events)==命令式写结果` 黄金断言（core 单测，无 DB） | 无 |
| **W3-A2** | artifact projection IO 壳（`projectArtifact` + guarded）+ genesis backfill 脚本 + `audit:projection` 扩 artifact（只读对账，flag OFF） | shadow 重算 vs 现表 drift 清单；backfill 幂等 | A1 |
| **W3-B** | 合流写闸 `applyArtifactMutation`（A/B tier + user_verified 硬边界 §4.2）+ 逐写者收口（note_refine → body_blocks → section → copilot author/update）behind flag；ADR-0040 §1/§5 配套（统一撤销 + 时间线读 event） | user_verified 块强制 B 档回归断言（ADR-0040 现零此断言）；撤销链单一；reader timeline 见 AI refine | A2 |
| **W3-B2** | 创建散点收口（`note_generate` 同 tx 写 event #3、`tool-quiz`、`learning_intent` ×3、`make-paper`）；copilot `mirrorEvent` 旁路改 tx 内写 | 五创建源 fold 黄金断言；mirror 旁路退役 | B |
| **W3-C1** | `question_block.structured`：新 `EditQuestionBlockStructured`（#5）+ `subject_kind:'question_block'`（#6）+ `persistStructured` 写 canonical event + `foldQuestionBlockStructured` 纯 reducer | structured 编辑 fold 黄金断言（六 op 全覆盖）；payload 携全量 structured 快照 | 独立于 A/B（可并行） |
| **W3-C2** | question_block projection IO 壳 + SoT flip + 删 `job_events` `block.structured_edited` 分支 + 删除验证 | `job_events` 结构编辑分支删除验证；audit:projection 零 drift | C1 |
| **W3-Z** | closeout：`audit:projection` 两表零 drift + 更新 ADR-0044/0040 落地注 + status.md + Linear 对齐 | 全 wave gate 绿 | A/B/B2/C2 |

A/B 线（artifact，合流 YUK-358）与 C 线（question_block，纯 ingestion）**可并行双 worktree**——它们触不同 capability、不同表、不同写闸。

---

## 8. 诚实天花板（撤不掉的下游，引 §7）

| 类别 | 例子 | 可撤? |
|---|---|---|
| 纯派生 projection | artifact 内容、structured 树 | ✅ 干净撤（fold 重算复原） |
| 实体行（带乐观锁） | artifact row | ✅ 软删（`archived_at`，`schema.ts:445` 已有列） |
| 既成事实（不可撤） | 用户已 `user_verified` 的块、真 attempt/review 引用的 artifact | ❌ 撤它 = 篡改用户真实历史 |

撤一个 artifact 编辑若级联触及已被真 attempt/review 引用的下游，遍历器（W0 `cascade.ts`）**停下告知**边界，不静默半撤。`user_verified` 块的 refine 在写闸即被硬边界挡在 A 档之外（§4.2 step 2）——撤的是「提议」不是「既成」。

---

## 9. Owner 待拍（开工前定）

1. **#5 action 命名**：新 `action:'edit'` + `subject_kind:'question_block'` vs `experimental:block_structured_edited`（松守 escape hatch，照 `question_structure_edit` 先例，少写专用 Zod）。**建议后者**（最小改面，与既有 experimental 结构编辑同路）。
2. **#6 job_events 删分支**：structured 编辑迁 canonical event 后，`job_events` 的 `block.structured_edited` 是否真删（SSE 进度面是否还有别的消费）。**建议真删 + 删除验证**（design doc 判据）。
3. **question_block genesis 锚**：OCR `extract` 当前是否进 canonical event？若否，fold 起始态从哪来——把 extract 当 genesis event 写，还是 fold 以「现 structured 为基线 + 只重算 edit 增量」。**影响 C1 范围**。
4. **`artifact.history` jsonb 去留**：双轨合一后是降级为派生缓存（reader 仍读它，但由 fold 回填）还是退役（reader 改读 event 流）。**ADR-0040 §5 倾向合一，本文倾向降级为派生**（reader 改造面小）。
5. **A/B tier 判定阈值**：ADR-0040 §1 的「小改 = `ops≤3 且 new_blocks≤2`」沿用，还是借 event-sourcing 重定。**建议沿用现 gate**，避免双变量。
6. **Wave 2 先后**：Wave 3 *实施* 是否 gate 在 Wave 2（goal/mistake_variant/learning_item fold）落地后。波次序建议「是」；但 C 线（question_block）与 Wave 2 无耦合，**可先行**。

---

## 10. 验证 gate（落地前）

```bash
pnpm typecheck && pnpm lint
pnpm audit:schema && pnpm audit:partition && pnpm audit:profile && pnpm audit:draft-status
pnpm audit:projection      # Wave 3 扩 artifact + question_block 两表，零 drift
pnpm test                  # fold 黄金断言（core 单测）+ 写闸 DB 测试 + structured 六 op 覆盖
pnpm build
```

外加：每写者收口独立 Opus reviewer 审 diff；`job_events` 结构编辑分支删除验证（C2）；user_verified 硬边界回归断言（B，ADR-0040 现零此断言）。

---

## 11. Linear 捕获

- 本文是 **YUK-471 epic 内 Wave 3 的实施设计**，归档进 YUK-471（贴评论或转 ADR-0044 落地注），**无需新建顶层 issue**。
- **建议在 YUK-471 下拆 Wave 3 子任务**对应 §7 七条 lane（W3-A1/A2/B/B2/C1/C2/Z）。
- **合流登记**：YUK-358（笔记域 re-think / ADR-0040）的 §1 统一撤销 + §5 history 合一**由本 Wave 3 的 event-sourcing 兑现**——应在 YUK-358 标注「实施合流进 YUK-471 Wave 3，不单独造 artifact 写契约」，避免两 epic 平行造写面。
- **既有相关 follow-up 票**（design doc §7 列）：`runNoteGenerate`/`author-artifact` 创建不写 event（P0）、structured 写 job_events（P0）、body_blocks_edit payload 不含 body（P1）——全收进上述 Wave 3 lane，不另立。
- **Wave 2 缺口**：goal/mistake_variant/learning_item fold 未做，建议在 YUK-471 下显式建 Wave 2 子任务（Wave 3 实施的软前置）。
