# YUK-471 Wave 3 — `artifact` + `question_block` event-sourcing（合流 YUK-358 笔记域，impl-ready CANONICAL）

**Date**: 2026-06-26
**Status**: Design / ready-to-review（设计领先实施；本文不实施代码，落地按 §7 PR-lane 序）
**Part of**: YUK-471（event-sourcing foundation redesign，parent YUK-203）。本文是该 epic 内部 **Wave 3** 的实施设计（末波、最难、合流面最大）。
**Decision source**:
- `docs/design/2026-06-15-event-sourcing-foundation-redesign.md`（ADR-0044 草案 + §A 重算引擎四路深挖 + §5 分 Wave + §2 补字段 #1–#7 + §3 reducer 模式 + §5.2 原子写契约）—— 本文引用其结论，不重复推导。
- `docs/adr/0040-notes-domain-rethink-living-note-contract.md`（笔记域 9 决策：A/B 出手契约、user_verified 硬边界、统一撤销链、history 双轨合一、verify advisory、dwell 下线、embedded_check 真删）。
- `docs/design/2026-06-25-yuk471-wave3-artifact-question-block-fold-CORRECTED.md`（5 条 critic BLOCKER 修正稿，本文的内容 spine）。
- `docs/design/2026-06-25-yuk471-wave3-readiness-and-prereqs.md`（re-critique F1–F8 + driver 5 裁定）。
- `docs/design/2026-06-25-yuk471-wave23-design-critic.md`（W2+W3 对抗审稿，A1–A4 / B1–B5 / C1–C5）。
**Related ADR**: ADR-0044（event=SoT 大改造）· ADR-0040（笔记域 re-think）· ADR-0041（checkpoint 腿，被本改造 gated）· ADR-0006（event=SoT）· ADR-0034（KG 一致性闸，W1 已装）· ADR-0020（note artifact 三约定）。

> **所有 file:line 已经 2026-06-26 对 main @ 27a0cf08 code-ground 复核（post-W2-merge）。** 凡引坐标均附符号名以抗未来漂移。W0/W1/W2 全部 merged；本文是 main 上 **唯一未启动**的剩余波次。

---

## 0. 一句话结论 + 锁定的 fork 决策

Wave 3 把两张「结构性 projection」切成 event-sourced：

- **(A) `artifact`（notes/copilot/ingestion 多域，合流 YUK-358）** —— 写者横跨 8 个 INSERT（6 文件）+ ~10 个 UPDATE 站点，事件留痕从「完全自足（`note_refine_apply`）」到「无事件（`note_generate` / `author_artifact`）」横跨整个光谱。工作 = 补 event payload 自足 + 把所有写收口到**单一原子写闸** + 建 fold reducer，**与 ADR-0040 的笔记域 re-think 收成一条契约**（不平行造两套 artifact 写面）。
- **(B) `question_block.structured`（ingestion 域，纯 event-sourcing）** —— 根因是它的编辑写 `job_events` 而非 canonical `event` 表，payload 只有 `{op, node_id}`（不自足、不可重放，全 epic 最大缺口）。工作 = 把编辑迁回 canonical event + payload 携编辑后全量 structured 快照 + 建 fold reducer。与笔记域无关。

真正的工程量不在重算引擎本身（W1+W2 已立 5 个成熟 fold 范式可推广），而在 **补 event payload 自足 + 写点收口**。

**Fork 决策（已锁，本稿一律遵循；现已由 W2 as-built 实证为正确路线 —— 见 §1）**

1. **artifact body fold = full-snapshot**（每次 edit 携 after 全树 + previous 供 revert），NOT op-replay。→ W2 的 BodyBlocks 类编辑同样走 full-snapshot；critic B4 的 guard-replay 冲突由此消解。
2. **运行时新建 = 专属 create 事件**（`experimental:artifact_create` / `experimental:question_block_create`），`experimental:genesis` 仅一次性 backfill。→ **W2 已实证此模式**：`experimental:mistake_variant_create`（`src/core/schema/event/mistake-variant-events.ts:48`）就是「genesis 仅 backfill、运行时走专属 create」的落地样板。
3. **per-entity SoT flag**（artifact / question_block 各自默认 OFF）。→ **W2 已实证**：`projectionIsWriter(entity?)`（`src/server/projections/sot-flag.ts`）已是 overloaded，`PER_ENTITY_FLAG_ENV` 含 goal/mistake_variant/learning_item，全局 flag 只 gate knowledge/edge。
4. **切换序 artifact-before-learning_item**。→ learning_item retract 同事务 archive artifact 行（`src/server/proposals/actions.ts:1275`，代码已带 `⚠️ W3 COUPLING (B2/C5)` 注释）。W2 已把 learning_item flip 留在 artifact 之后等 W3。
5. **复用 W1/W2 共享基建**（gather / parity-X / genesis 逐 subject_kind safeParse / per-entity-flag / backfill / audit:projection 脚手架），extend 不重造。

---

## 1. 前置状态确认（code-grounded, main @ 27a0cf08, post-W2-merge）

| Wave（design doc §5 内部波次） | 内容 | 状态 |
|---|---|---|
| **W0** | mastery/FSRS 快照可逆 + cascade CTE 骨架 + 级联 revert 编排器 | ✅ 已 merged（`src/server/events/cascade.ts`、`corrections.ts`、cascade-revert capstone + 多轮 review fix） |
| **W1** | `knowledge` / `knowledge_edge` 真 fold + genesis backfill + SoT flip（全局 flag，**LIVE=1**） | ✅ 已 merged（`src/core/projections/knowledge.ts` foldKnowledgeNode:101 / `knowledge_edge.ts` foldKnowledgeEdge:120 纯 fold + `src/server/projections/knowledge.ts` projectKnowledgeNode:77 / projectKnowledgeNodeGuarded:104 IO 壳 + `materialized-id-index.ts` + `audit:projection` + 全局 `PROJECTION_IS_WRITER` flag + guarded 非删 keystone） |
| **W2** | `goal`（#595）/ `mistake_variant`（#603）/ `learning_item`（#604）fold | ✅ **已全部 merged**。三个 `.strict()` RowSnapshot（`genesis.ts` GoalRowSnapshot:105 / MistakeVariantRowSnapshot:139 / LearningItemRowSnapshot:187）+ 专属 create 事件（`experimental:mistake_variant_create` 等，**非 genesis-as-create**）+ per-entity flag（`PROJECTION_IS_WRITER_GOAL` 等，默认 OFF）+ gather/parity/anchor 全 entity 扩齐 + `MaterializedSubjectKind` 已含 goal/mistake_variant/learning_item（5 kinds） |
| **Wave 3** | `artifact` + `question_block.structured` + 补字段 #2–#7 | 🎯 **本文目标，main 上唯一未启动**。`event` 表无 `subject_kind='artifact'` 的 create/edit/lifecycle 事件，无 `'question_block'` subject 事件；`MaterializedSubjectKind` 无 `'artifact'`；无 fold reducer，无 projection 壳 |

**依赖现实（已满足）**：W2 已落地，Wave 3 **直接复用 W2 立的真实共享基建形态**（不再是「builds on in-flight」的预测，而是 reconcile 后的实测形态）。Wave 3 是 unified-wave-sequence 的 **W6**，**必须落在 checkpoint（W7）之前**——copilot 的 `author_artifact`/`update_artifact` 与 learning_item 生命周期写面全落这些表，不 event-source 化它们，checkpoint 的级联 revert 撤不动命令式写（Codex P2）。

> W2 as-built **实证了本稿 5 条 fork 决策全部正确**：专属 create 事件（非 genesis-as-create，A3/A4）、per-entity flag（A1）、`.strict()` RowSnapshot + discriminating-column superRefine（B3）—— 这些当初是 critic 提出的 BLOCKER 修正，现已是 main 上的既成范式，Wave 3 照抄即可。

---

## 2. 现状写面审计（复核后坐标，main @ 27a0cf08）

### 2.1 `artifact` — 写者光谱（8 INSERT / 6 文件 + ~10 UPDATE）

**Schema**：`src/db/schema.ts:422-444` artifact pgTable。**22 列，无派生/embed 列 → 无排除列**（与 knowledge 不同，artifact 没有 embed_* 维护列）。非派生列（全部入 fold 真相）：
`id, type, title, parent_artifact_id, knowledge_ids, intent_source, source, source_ref, body_blocks, attrs, tool_kind, tool_state, generation_status, verification_status, verification_summary, generated_by, verified_by, history, archived_at, created_at, updated_at, version`。

**创建（INSERT）站点 —— 全部改为 `experimental:artifact_create`（F8 订正：8 INSERT / 6 文件，非原稿「6 站点」）**：

| # | 写者 | file:line | 备注 |
|---|---|---|---|
| 1 | `createIngestionPaper` | `make-paper.ts:324` | tool_quiz from imported |
| 2 | `authorArtifactTool`（author_artifact） | `author-artifact.ts:108` | copilot interactive INSERT |
| 3 | `writeToolQuizArtifact` | `tool-quiz-core.ts:53` | tool_quiz |
| 4 | quiz_gen boss handler | `quiz_gen.ts:683` | 后台 quiz 生成 |
| 5–7 | `acceptLearningIntent` ×3 | `learning_intent.ts:787` / `:822` / `:847` | hub / atomic / long stub |
| 8 | legacy record applier | `legacy-record-appliers.ts:450` | 历史路径 |

**编辑 / 生命周期（UPDATE）站点 —— 改为 `experimental:artifact_body_blocks_edit`（携全量 body）或 `experimental:artifact_lifecycle`**：

| 写者 | file:line | 操作 | 当前事件 |
|---|---|---|---|
| `runNoteGenerate`（body+status） | `note_generate.ts:209` / `:241` | body_blocks + `generation_status='ready'/'failed'` | ❌ 无（job_events 只记进度）**【F1：generation_status mutation 必须事件化】** |
| `persistNoteVerificationResult` | `note_verify.ts:161` / `:339` | `verification_status` + `verification_summary` | ❌ 无 **【F1：verification_status mutation 必须事件化】** |
| `editArtifactBodyBlocks` | `body-blocks-edit.ts:89`（UPDATE）→ `writeEvent` `:110`, action `experimental:artifact_body_blocks_edit` `:115` | UPDATE body_blocks / history / version | ✅ 事件已写，**但 payload 不含新 body_blocks**（补字段 #2 核心缺洞）**【F1：history push 不进 payload】** |
| `persistNoteRefineApply` | `note-refine-apply.ts:156`（UPDATE）→ action `experimental:note_refine_apply` `:182`；guard `:149`；undo `:366` | UPDATE body_blocks / version | ✅ **唯一完全自足**（`ops` + `previous_body_blocks` + reverse_patch） |
| `editArtifactSection` | `sections.ts:134` | UPDATE body_blocks / history / version | payload 自足度待核 |
| `updateArtifactTool` | `author-artifact.ts:247` | UPDATE（copilot） | ❌ 无 |
| `hub-dismiss`（attrs） | `hub-dismiss.ts:162` | UPDATE attrs.suppressed | 走既有 `SuppressArtifactLink`（known.ts:441） |
| retract archive（**跨 wave**） | `actions.ts:1275` | UPDATE `archived_at` where `source_ref=proposalId` | ❌ 无 artifact 事件；**代码已带 `⚠️ W3 COUPLING (B2/C5)` 注释，待 W3 改写为 artifact lifecycle 事件** |

> 既有 artifact-subject 事件（**保留不动**）：`CorrectArtifactEvent`（known.ts:387，block-grained correction）、`SuppressArtifactLink`（known.ts:441，dismiss auto-link）、`GenerateArtifact`（known.ts:222，AI 产出意图，见 §3 #4）。这些是正交业务事件，不是 fold-source。

### 2.2 `question_block.structured` — 整体在 job_events 层

**Schema**：`src/db/schema.ts:159-209` question_block pgTable。fold 真相列 = `structured`(StructuredQuestion 树, `:181`)、`figures`(`:184`)、`crop_refs`(`:184`)、`status`、`merged_from_block_ids`(`:191`)、`version`。**`merged_into` 列不存在**（A2 关键裁定）；`extracted_prompt_md`(`:180`)是 legacy deprecated（DROP 推迟到 Step 11.5）。

- `persistStructured`（`block-structured-edit.ts:123`）：UPDATE `question_block.structured`+figures+version（`:134`，`updated_at: new Date()` `:138`），然后 `writeJobEvent`（`:143`，`event_type:'block.structured_edited'`），payload 只有 `{op, node_id}`。
- 5 个 structured 改写函数全经 `persistStructured`：`updatePrompt`(`:162`) / `addOption`(`:193`) / `setQuestionType`(`:224`) / `splitStem`(`:357`) / `mergeQuestions`(`:412`)（外加 `reassignFigure` 单独 re-point figures）。
- `mergeQuestions`（`:412`）：primary UPDATE（`:501`，`updated_at: new Date()` `:505`，`version: sql\`+1\`` `:507`）+ merge blocks UPDATE（`:511`，`.set({status:'ignored', updated_at: new Date()})` `:513`，**不 bump version**）。**【F3：两处独立 `new Date()`（:505/:513）+ merge 行不 bump version → fold 取 event.created_at、在线写须统一单 `now`，否则 updated_at parity 假失败】**
- `writeJobEvent`（`src/server/events/writer.ts:22`）写 `job_events`，pg_notify，**不在 KnownEvent union、不被任何重算覆盖**。
- `event.subject_kind` 是 bare `text` 列（`schema.ts:712`，**非 pgEnum**）→ 加 `'question_block'` 无 DDL；真正的 gate 是 `KnownEvent` Zod union（known.ts:682，**当前无 question_block-subject 成员**）+ `RESERVED_EXPERIMENTAL_ACTIONS`（experimental.ts:116）。

### 2.3 现成 fold 范式（W1+W2，直接推广）

- **纯 fold（core）**：`knowledge.ts:101` foldKnowledgeNode（两遍——pass1 accept-resolve index + pass2 ordered apply）；`knowledge_edge.ts:120` foldKnowledgeEdge（含 ADR-0034 拓扑校验，reject 即 throw）；W2 新增 `goal.ts` / `mistake_variant.ts` / `learning_item.ts` 三个成熟 reducer。
- **IO 壳（server）**：`projectKnowledgeNode`（`server/projections/knowledge.ts:77`：gather → 纯 fold → upsert/delete）+ **guarded 变体** `projectKnowledgeNodeGuarded`（`:104`，genesis-anchor gate：fold-null 只在「有创世锚」时 DELETE，未 backfill 旧行**永不删**）。
- **gather（IO，`server/projections/gather.ts`）**：`rowToFoldEvent:46` + 每 entity 一个 `gatherAndFoldX`（KnowledgeNode:89 / Goal:156 / MistakeVariant:205 / LearningItem:262 / KnowledgeEdge:318）。
- **parity（`server/projections/parity.ts`）**：每 entity 一对 `hasXGenesisAnchor`（事件表直查 anchor）+ `assertXParity`（KnowledgeNode:141/316 · Goal:237/451 · MistakeVariant:493/613 · LearningItem:654/792）。
- `FoldEvent` 扁平信封（`core/projections/fold-event.ts`）被 core+server 共用，按 event id 去重。
- **写入闸**：`writeEvent`（`src/server/events/queries.ts:1020`，INSERT-only + parseEvent barrier + outbox）。

---

## 3. 补字段清单 #2–#7（Wave 3 build list，含完整 Zod schema）

> 命名：fold-source 事件全部走 `experimental:` 命名空间 + reserved-action parse-barrier（镜 GenesisExperimental + W2 的 mistake_variant_create）。promote 出 experimental 由 owner 单独决策、不在本 wave。新建 schema 落 `src/core/schema/event/`，注册进 `index.ts` 的 KnownEvent 联合 + `RESERVED_EXPERIMENTAL_ACTIONS`（experimental.ts:116）。

### #2 — `BodyBlocksEdit`（full-snapshot）【P0】

消解 B4 核心。手编 + 人类 inbox-accept 两条路都收口到这一条；fold 做 last-write-wins，**不走 applyNotePatch、guard 无介入机会**。

```
action:       'experimental:body_blocks_edit'   // promote 出 artifact_body_blocks_edit
subject_kind: literal('artifact')
subject_id:   artifactId
actor_kind:   enum('user','agent')
actor_ref:    string.min(1)                       // 'artifact_block_tree_editor' | NOTE_REFINE_ACCEPT_ACTOR
outcome:      literal('success')
payload:
  previous_artifact_version: int().nonnegative()
  next_artifact_version:     int().nonnegative()
  body_blocks:               ArtifactBodyBlocks            // after 全量快照（src/core/schema/business.ts:301）
  previous_body_blocks:      ArtifactBodyBlocks.nullable() // before，供 revert；null=冷启首写
  history_after:             array(ArtifactHistoryEntry)   // 【F1】full-snapshot 携 after-history，否则 history 列 parity 假失败
```

写路径改：`body-blocks-edit.ts:89` UPDATE 后，`writeEvent`（`:110`）payload 扩为携 `body_blocks`（同 tx UPDATE 后的值）+ `previous_body_blocks` + `history_after`；action 改名。

### #3 — `ArtifactCreate`（运行时新建，归一 8 INSERT）【P0】

genesis 仅 backfill；运行时新建走专属 create 事件（**对照 W2 已落地的 `MistakeVariantCreateExperimental`，mistake-variant-events.ts:48**）。**全树快照入 payload**（full-snapshot 铁律：fold 不能从只携 ID 的事件重建行）。§2.1 的 8 个 INSERT 统一改为「mint event → fold(events) → INSERT」。

```
action:       'experimental:artifact_create'
subject_kind: literal('artifact')
subject_id:   artifactId
actor_kind:   enum('agent','user','system')
actor_ref:    string.min(1)
outcome:      literal('success').nullable().optional()
payload:
  row: ArtifactRowSnapshot   // 创建时全量行快照（§5.1），含 body_blocks/type/title/parent/knowledge_ids/tool_*/status/history 等
// superRefine: subject_id === payload.row.id（镜 MistakeVariantCreateExperimental 的 coherence 检查）
```

> **与 `GenerateArtifact`（known.ts:222，#4）的关系**：`GenerateArtifact`（`action:'generate'`，payload `{artifact_kind,title,body_md,referenced_event_ids?}`，**无 body_blocks / 无生命周期字段**）是既存的「AI 产出意图」业务事件，**不是 fold-source，保留原样不动**。fold-source 是新的 `artifact_create`。一次 AI 生成既写 `generate`（意图/可观测/evidence，有 `outcome:'failure'` 分支）又写 `artifact_create`（fold 锚，仅成功落行时写），两者 `caused_by_event_id` 串联；孤儿补偿（generate 成功 / create 失败）由**同 tx 写**保证原子（driver 裁定 #5）。**不扩 GenerateArtifact 加 body_blocks**——避免业务事件与 fold-source 职责混淆。

### #4 — `ArtifactLifecycle`（archive / unarchive / status 变更）【P1】

`archived_at` / `generation_status` / `verification_status` / `version` 推进。**F1 必含 generation_status（note_generate.ts:209/241）+ verification_status（note_verify.ts:161/339）+ retract archive（actions.ts:1275）三类 mutation。** 对照 W2 的 `GoalStatusUpdateExperimental`（goal-events.ts:30）+ `LearningItemArchiveExperimental`（learning-item-events.ts:92）。

```
action:       'experimental:artifact_lifecycle'
subject_kind: literal('artifact')
subject_id:   artifactId
payload:
  op:                    enum('archive','unarchive','set_generation_status','set_verification_status')
  archived_at:           coerce.date().nullable().optional()
  generation_status:     string.optional()
  verification_status:   string.optional()
  verification_summary:  NoteVerificationResult.nullable().optional()
  next_version:          int().nonnegative()
```

### #5 — `EditQuestionBlockStructured`（单 canonical，含 affected_blocks 多行 after）【P0】

解 C4（mergeQuestions 1+N job_events → 单 canonical event）+ A2（merged_into 不存在 → 真实 after 建模）。`block-structured-edit.ts` 的 5 个 structured 改写函数（updatePrompt / addOption / setQuestionType / splitStem / mergeQuestions）全部收口到这一条。**job_events SSE 传输层维持 1+N 条不变**（与 canonical log 正交）。

```
action:       'experimental:edit_question_block_structured'
subject_kind: literal('question_block')
subject_id:   primaryBlockId        // 唯一 SoT 锚点（只有 primary 改了 structured）
actor_kind:   enum('agent','user')
actor_ref:    string.min(1)
outcome:      literal('success')
payload:
  op:              enum('update_prompt','add_option','set_question_type','split_stem','merge_questions')
  affected_blocks: array(AffectedBlockSnapshot).min(1)   // 单 block edit 长度=1
```

**`AffectedBlockSnapshot`（A2 修正版 —— 无 merged_into 物理列）**：

```
AffectedBlockSnapshot:
  block_id:   string.min(1)
  role:       enum('primary','merged_source')
  structured: StructuredQuestion.nullable()    // primary=合并后全树；merged_source=操作前原值(供 undo,可选)
  figures:    array(FigureRef).nullable().optional()  // 仅 primary 必带
  version:    int()
  status:     string                            // 'draft' | 'ignored'
  // ★ 不含 merged_into_block_id —— 该字段无物理列（schema.ts question_block 无此列）。
  //   「被合并进谁」反向关系由 primary.merged_from_block_ids 正向表达；
  //   UI 若需展示从本事件 payload 内存读取，绝不持久化进 row。
```

> **A2 关键裁定**：merge after-state 真相 = primary 行 `structured=mergedTree / figures=mergedFigures / merged_from_block_ids=[...prev,...absorbedIds] / version+1`（block-structured-edit.ts:501-507）；每个 absorbed 行 `status='ignored' / 其余列 unchanged`（`:511-513`）。reducer **绝不写 merged_into**。

### #6 — `QuestionBlockCreate`（OCR 新建块，A3 选项 B）【P1】

`applyExtractionResult`（OCR INSERT N 行，`ingestion.ts:195`）+ `applyRescue`（structured UPDATE，`ingestion.ts:378`）+ docx-ingestion 三条创建/覆写路径事件化（对照 `mistake_variant_create`）。当前 `ExtractSourceDocument` payload 只存 `structured_block_ids`（ID 列表，**无内容**，known.ts:471），无法 fold——故需专属 create 事件携全行快照。

```
action:       'experimental:question_block_create'
subject_kind: literal('question_block')
subject_id:   blockId
payload:
  row: QuestionBlockRowSnapshot   // 创建时全量行（§5.2），含 structured/figures/crop_refs/page_spans 等
  origin: enum('ocr','rescue','docx','import')   // rescue=对已有块的覆写，fold 当 full-snapshot 覆盖
```

> rescue 在 fold 模型下 = 对同一 blockId 的第二条 full-snapshot 事件（`origin:'rescue'`），reducer last-write-wins 覆盖 structured/figures。**F5 裁定（driver #3，选 b）**：C1 **同改 `applyRescue`（ingestion.ts:378）让在线也写 `crop_refs=figures.map(f=>f.asset_id)`**（一次性 data-fix + 在线修，对齐 `applyExtractionResult` 在 `:246` 的派生写），rescue 事件携正确值 → parity 过。**删 CORRECTED 旧稿「不改 applyRescue 还顺带修」的自相矛盾叙述**。

### #7 — `ArtifactLifecycle` 与 learning_item 跨 wave 耦合说明【可 defer】

#4 已涵盖 archive 语义本身。#7 的「defer」指：retract 路径里 learning_item 的 archive（W2，已 fold 化）与 artifact 的 archive（`actions.ts:1275`）是同一事务两个 fold-source 写。本 wave 保证 artifact 侧 `artifact_lifecycle` 事件写齐 + 切换序把 artifact flip 排在 learning_item flip 之前（§6）。两者都 flip 前，retract 走 imperative + parity assert，无功能缺口。**可 defer = 跨 wave 联合 flip 的端到端验证**，不是 artifact lifecycle 事件本身。

---

## 4. 合流 YUK-358：单一 artifact 写契约（核心净增）

**问题**：ADR-0040 的笔记域 9 决策与 Wave 3 的 event-sourcing 改造**触同一张 `artifact` 写面**。若各自落地 = 两套写契约（ADR-0040 走 `apply-note-patch` mutator/propose 路；Wave 3 走重算路），正是 design doc 明令禁止的。本节把二者收成**一条**。

### 4.1 对齐矩阵：ADR-0040 决策 ←→ Wave 3 机制

| ADR-0040 决策 | Wave 3 event-sourcing 机制 | 合流结论 |
|---|---|---|
| **§1 统一撤销链**（mutator + propose-accept → 一个 ai-changes undo；给 `retractAiProposal` 补 note_update `body_blocks` 回退分支，复用 `reverse_patch`） | 级联 revert（W0 `cascade.ts`）+ artifact fold 重算自动复原 body_blocks | event-sourcing **就是**统一撤销的底座：artifact body 可从 event 流重算后，撤一条 artifact 编辑 event → fold 自动复原前态，撤销链天然单一。`reverse_patch` 从「手写回退分支」降级为「fold 的优化捷径」 |
| **§5 history 双轨合一**（人工编辑写 `artifact.history` jsonb / AI refine 走 event 表，reader timeline 只见前者） | 补字段 #2/#3/#4 让**所有** artifact 写（人工 + AI）都进 canonical event；BodyBlocksEdit 携 `history_after`（F1） | 双轨分裂**由 event-sourcing 直接消解**：所有 mutation 进同一 event 流，reader timeline 读 event 流即单轨。`artifact.history` jsonb 降级为派生缓存（fold 回填）或退役 |
| **§1 user_verified 硬边界**（`apply-note-patch` 对 user_verified 块拒绝 mutator 直改，强制 propose；`is-verified-block.ts:11` isVerifiedBlock + `apply-note-patch.ts:125/145` guard 点） | 单一原子写闸 `applyArtifactMutation`（§4.2）= 所有结构写的唯一入口 | user_verified guard + A/B 路由**钉在写闸里**：写闸是唯一 choke point，guard 放这里就**结构性不可绕**（不像散在 8 INSERT / 10 UPDATE 站点里靠记得加） |
| **§1 A/B 出手分档**（小可逆改 + 不触 user_verified → A 自动 + 撤销窗口；大改或触 user_verified → B propose 人审） | `applyArtifactMutation` 在写 event 前做 tier 判定 | A 档 = 直接写 event + fold（带撤销窗口，撤销走级联 revert）；B 档 = 写 propose event 进收件箱，accept 时才走写闸。**同一写闸两条出口** |
| **§7 note_verify advisory**（不再产 patch-less note_update proposal；issues 落 `verification_summary` + 可选触发 refine） | verify 不写结构 event，只写 advisory（artifact `verification_summary` 列 + #4 的 `set_verification_status` lifecycle 事件，note_verify.ts:161/339） | verify 与写闸**解耦**：verify 是诊断（advisory），refine 才经写闸出手。死提议 bug 随之消除 |
| **§3 check 段 self-explanation + 真删 embedded_check**；**§6 dwell 下线** | 与 event-sourcing **正交**（删孤儿端点/列/boss.send/触发信号，不碰写闸） | **不在 Wave 3 实施范围**；清债顺序上 dwell 下线 + embedded_check 真删应**先于或并行**写闸收口，避免给死路径补 event。本文标依赖，不实施 |

### 4.2 合流的单一写闸（语义）

```
applyArtifactMutation(tx, intent):           // notes + copilot 所有 artifact 写的唯一入口
  1. tier = classifyTier(intent)             // ADR-0040 §1：可逆性 + user_verified → A | B
  2. if intent.touches_user_verified_block && tier !== 'B':
         → 强制 B（ADR-0040 §1 硬边界，结构性不可绕）   // user_verified = 既成事实，挡在 A 档之外
  3. if tier === 'B':
         writeEvent(tx, ProposeArtifactChange{...})   // 进收件箱，accept 时再调本闸
         return { proposed: true }
  4. // A 档：直接出手
     event = writeEvent(tx, <ArtifactCreate | BodyBlocksEdit | ArtifactLifecycle>{ payload: 自足快照 })
     affected = deriveAffectedArtifactIds(event)
     for id in affected:
         rows = gatherAndFoldArtifact(tx, id)          // gather → 纯 fold（§5）
         if projectionIsWriter('artifact'):            // per-entity flag（§6），默认 OFF
             upsertArtifact(tx, rows.row)              // ON：projection write-through 是行写者
         // OFF：imperative INSERT/UPDATE 仍是行写者；assertArtifactParity 校验 fold==row
     return { applied: event.id }                      // 撤销 = 级联 revert 这个 event
```

**user_verified 硬边界（A/B tier hard boundary）**：step 2 是结构性不可绕的 choke——任何触 user_verified 块的 intent 一律强制 B 档（propose 人审），撤的是「提议」不是「既成」。这把 `apply-note-patch.ts:125/145` 当前散在 mutator 里的 guard 上提到唯一写闸（ADR-0040 §1 现 grep 零此在线断言，是 B lane 必补的回归测试）。

`question_block.structured` 走**同构但独立**的 `applyQuestionBlockStructuredMutation`（ingestion 域，无 A/B tier、无 user_verified——纯 OCR 编辑，直接 A 档语义；只复用写闸的「写 event → fold → upsert」三步骨架）。

---

## 5. 重算引擎蓝图（镜像 W1+W2）

每张表两件，签名对齐 W1/W2：

| 件 | `artifact` | `question_block` |
|---|---|---|
| **纯 fold（core）** | `src/core/projections/artifact.ts` → `foldArtifact(id, events: FoldEvent[]): ArtifactRowSnapshot \| null` | `src/core/projections/question_block.ts` → `foldQuestionBlock(blockId, events): QuestionBlockRowSnapshot \| null` |
| **IO 壳（server）** | `src/server/projections/artifact.ts` → `projectArtifact` + `projectArtifactGuarded`（genesis-anchor gate，同 W1 projectKnowledgeNodeGuarded:104） | `src/server/projections/question_block.ts` → `projectQuestionBlock`（+ guarded 变体） |

### 5.1 `ArtifactRowSnapshot`（`src/core/projections/artifact.ts`，`.strict()`）

**入快照（fold 真相）= artifact 表全 22 列**（§2.1 列表）。**无排除列**——artifact 无 embed_* 派生列，`body_blocks` 是真相，`history` 进快照（append 日志但属行状态，create/edit 事件携当时全量 + `history_after`）。

`.strict()` 安全（镜 GoalRowSnapshot 的 critic B3 理由）：artifact **无 live-row `.parse()` 携额外列的 caller**（不像 KnowledgeRowSnapshot 因 embed_* 必须 NON-strict）。新建 schema 加入 `genesis.ts` 的 `SNAPSHOT_BY_SUBJECT_KIND`（:246）+ `DISCRIMINATING_COLUMNS`（:258，artifact 的 discriminating 列 = `intent_source` + `body_blocks`，无 sibling entity 同时有）+ subject_kind enum（:274）+ payload union（:288）。

**fold reducer `foldArtifact` 分支表**：

| action | reducer 行为 |
|---|---|
| `experimental:genesis`(subject='artifact') | genesis seed：payload.row verbatim 为 base，version 取 row.version |
| `experimental:artifact_create` | base state：payload.row verbatim（运行时新建首事件，镜 mistake_variant_create reducer） |
| `experimental:body_blocks_edit` | **full-snapshot**：`row.body_blocks=payload.body_blocks`，`row.history=payload.history_after`，`version=next_artifact_version`，`updated_at=event.created_at`。**不 replay、guard 无关** |
| `experimental:note_refine_apply` | replay ops：`applyNotePatch(row.body_blocks, ops, {enforceUserVerifiedGuard:false})`，`previous_body_blocks` 仅供 revert 不参与正向 fold |
| `experimental:artifact_lifecycle` | 按 op 改 `archived_at`/`generation_status`/`verification_status`/`verification_summary`，`version=next_version` |

### 5.2 `QuestionBlockRowSnapshot`（`src/core/projections/question_block.ts`，`.strict()` + 排除 legacy）

**入快照**：`id, ingestion_session_id, source_document_id, source_asset_ids, page_spans, structured, figures, layout_quality, reference_md, wrong_answer_md, image_refs, crop_refs, visual_complexity, extraction_confidence, status, knowledge_hint, merged_from_block_ids, imported_question_id, imported_attempt_event_id, created_at, updated_at, version`。

**A3 crop_refs 最终裁定 —— 纳入快照，不排除**（与 F5 driver 裁定 #3 一致）：把 `crop_refs` 当独立真相列入快照，create/rescue 事件携当时值；C1 同改 `applyRescue` 让在线 crop_refs 也保持 `figures.map(...)`，故 backfill 种的值与在线一致、rescue 事件重写正确值，parity 一律过。

**排除列**：`extracted_prompt_md`（schema.ts:180，legacy deprecated，DROP 推迟 Step 11.5）。**`.strict()` 与排除的协调（W1/W2 strict 张力的解法）**：`question_block` 的 live-row 携 `extracted_prompt_md`，若 snapshot `.strict()` 且 live-row 直接 `.parse()` 会 `unrecognized_keys` 抛错（同 KnowledgeRowSnapshot 的 embed_* 困境）。故 parity 的 `questionBlockLiveRowToSnapshot` helper **先 omit `extracted_prompt_md` 再 parse**（镜 genesis.ts:48-50 的指引：「live-row callers 先 migrate 去 derived 列后才能 .strict()」）—— 这样 `.strict()` 在 genesis/create 写路径保护真相、parity 比对 omit legacy 列，两不矛盾。

**fold reducer `foldQuestionBlock` 分支表（解 C4 多行聚合）**：

| action | reducer 行为 |
|---|---|
| `experimental:genesis`(subject='question_block') | genesis seed：payload.row verbatim |
| `experimental:question_block_create` | base / rescue 覆写：payload.row verbatim（last-write-wins，rescue 是同 blockId 第二条） |
| `experimental:edit_question_block_structured` | 在 `affected_blocks[]` 找 `block_id===blockId`：<br>• `primary` → `structured=snap.structured / figures=snap.figures??row.figures / version=snap.version / status=snap.status / updated_at=event.created_at`<br>• `merged_source` → `status='ignored' / version=snap.version / updated_at=event.created_at`（structured 保持 before，**不写 merged_into**）<br>• not found → skip |

**C4 gather 双查（IO shell `gather.ts` extend，镜 W1 merge Q3）**：
- Q1：`subject_kind='question_block' AND subject_id=blockId`（直接命中：create / primary-side edit）。
- Q2：`action='experimental:edit_question_block_structured' AND payload->'affected_blocks' @> '[{"block_id":"<blockId>"}]'::jsonb`（jsonb containment，找 blockId 作为 merged_source 出现的事件）。
- 合并去重、按 `(created_at asc, id asc)` 排序后 fold。

> **【F4 / driver 裁定 #2 —— Q2 需 GIN 索引，这是一条 DDL】**：`event` 表当前只有 B-tree `event_subject_idx`（schema.ts:739）+ `event_affected_scopes_idx`（GIN on `affected_scopes`，:741）—— **`payload` 列无 GIN**。Q2 的 jsonb `@>` 反查若无 GIN 会全表扫。故 W3 加 `event_payload_gin_idx`（`.using('gin', t.payload, jsonb_path_ops)`），W1 的 knowledge merge Q3 同坑顺带补（或独立 follow-up）。**这推翻 CORRECTED 旧稿「无 DDL / 5 处登记不触发」**——见 §6 迁移 + §10 gate。

### 5.3 flip-guard anchor 路径 + artifact 入 index

artifact 与 question_block 的「该行有无 genesis anchor」判定 = **直查 event 表**（镜 W2 的 `hasGoalGenesisAnchor`，parity.ts:237，走 `event_subject_idx` 复合索引 O(log n)）：

```
hasArtifactGenesisAnchor(db, artifactId):       // parity.ts，镜 hasGoalGenesisAnchor
  SELECT 1 FROM event
  WHERE subject_kind='artifact' AND subject_id=artifactId
    AND action IN ('experimental:genesis','experimental:artifact_create')
  LIMIT 1

hasQuestionBlockGenesisAnchor(db, blockId):
  SELECT 1 FROM event
  WHERE subject_kind='question_block' AND subject_id=blockId
    AND action IN ('experimental:genesis','experimental:question_block_create')
  LIMIT 1
```

> 注意 OR `*_create`：运行时新建块/artifact 从无 genesis seed（genesis 只 backfill 老行），其 anchor 是 create 事件（同 W2 mistake_variant 的 `hasMistakeVariantGenesisAnchor` 含 create-action 的理由）。

**artifact 入 `materialized_id_index`（裁定：YES）**：`MaterializedSubjectKind`（`materialized-id-index.ts:25`）加 `'artifact'`（第 6 个 kind）。**这与 W2 as-built 一致**——W2 已把 goal/mistake_variant/learning_item 全部纳入该 index（实测 5 kinds），故 artifact 照此惯例纳入，anchor 写 index 行成本低、保持与 W1/W2 entity 统一的 O(1) PK anchor 路径。**此处解决 CORRECTED §3（入）与 readiness 裁定 #4（不入）的旧矛盾：选 YES（artifact 入 index），与 W2 as-built 对齐。** question_block **不入** index（无 propose→mint，行 id 恒等于 subject_id；走上面的 event-表直查 anchor）—— 这是 artifact/question_block 间唯一有意的非对称，留 §9 owner 可选统一。

---

## 6. 迁移顺序（double-write + per-entity flag）

**backfill（复用 W1/W2 `backfill-genesis` 脚手架）**：为每个 pre-W3 的 artifact / question_block 行写一条 `experimental:genesis`（payload.row = 当前全量 RowSnapshot），使 `fold(events)==row` 自首事件起可检验。artifact 同时写 `materialized_id_index` 行（subject_kind='artifact'）；question_block 不写 index。

**双写期**：补 payload（#2–#6）让事件先变自足，旧写点照旧；建 reducer + `audit:projection` 只读对账（预期 `note_generate` / structured 大面积 drift，因事件本就缺），**不翻任何 flag**。逐写者按自足度从右向左收口到写闸：`note_refine_apply`（已自足）→ `body_blocks_edit` / `section_edit` → copilot `author/update` → 8 创建散点 → `question_block.structured`（最重）。

**切换序（per-entity flag，复用 `sot-flag.ts` 的 `PER_ENTITY_FLAG_ENV`）**：
```
knowledge / knowledge_edge   —— 已 LIVE=1（全局 PROJECTION_IS_WRITER，不动）
goal / mistake_variant / learning_item —— W2 已接线，各自 PROJECTION_IS_WRITER_<E>（默认 OFF，待各自 B3 gate）
  ↓
artifact                     —— 新增 PROJECTION_IS_WRITER_ARTIFACT，先于 learning_item flip
  ↓
question_block               —— 新增 PROJECTION_IS_WRITER_QUESTION_BLOCK（与 artifact 独立，无序约束）
  ↓
learning_item flip           —— W2 entity，排在 artifact flip 之后（跨 wave 耦合）
```

**理由（B2/C5 跨 wave 耦合）**：retract 在同一事务 archive learning_item 行（W2，已 fold）+ artifact 行（`actions.ts:1275`）。若 learning_item 先 flip 而 artifact 未 flip，retract 的 artifact-archive 仍走 imperative、learning_item-archive 走 projection——两半 SoT 不一致期内 parity 口径错位。**artifact 先 flip 消除该错位。** `sot-flag.ts` 扩两条：`PER_ENTITY_FLAG_ENV` 加 `artifact: 'PROJECTION_IS_WRITER_ARTIFACT'` + `question_block: 'PROJECTION_IS_WRITER_QUESTION_BLOCK'`（`ProjectionEntity` union 自动扩）。每个 entity 各自 GATED-not-timed cutover（rebuild prod-clone → `audit:projection` per-entity CLEAN → set flag → restart）。

---

## 7. PR-lane 序（CORRECTED 切片，经 readiness 裁定微调；全 `Refs YUK-471`）

| PR | 内容 | 依赖 | 独立性 |
|---|---|---|---|
| **W3-A1** | #2 BodyBlocksEdit + #3 ArtifactCreate + #4 ArtifactLifecycle 三 schema（含 `history_after`、F1 三类 mutation）+ parse-barrier 测试 + RESERVED_ACTIONS/KnownEvent 注册 | 复用 W2 genesis superRefine 脚手架（已 merged） | 可与 A2 并行 |
| **W3-A2** | #5 EditQuestionBlockStructured + #6 QuestionBlockCreate 两 schema（含 AffectedBlockSnapshot，**无 merged_into**）+ parse-barrier 测试 | — | 可与 A1 并行 |
| **W3-B1** | `foldArtifact` reducer + ArtifactRowSnapshot(`.strict()`) + B4 note_refine_apply guard-off 分支（注释铁律：fold-only、禁复用到在线写）+ unit | A1 | 串 A1 |
| **W3-B2** | `foldQuestionBlock` reducer + QuestionBlockRowSnapshot(`.strict()` + omit extracted_prompt_md)+ merge 多行聚合（C4）+ unit | A2 | 串 A2，与 B1 并行 |
| **W3-C0**（migration）| **`event_payload_gin_idx`（GIN jsonb_path_ops）+ 新表登记 5 处对账**（F4/裁定 #2，触发 reference_new_pgtable_registration_surfaces）；W1 Q3 同坑顺带或独立 | — | 可先行 |
| **W3-C1** | 写路径事件化：body-blocks-edit payload 扩 + 8 artifact INSERT 改 create-event（含 quiz_gen / legacy-record-appliers）+ note_generate/note_verify status 事件化（F1）+ retract artifact archive 改 lifecycle 事件（actions.ts:1275，B2/C5）+ ingestion/rescue/docx 改 question_block_create + **applyRescue 同写 crop_refs（F5）** | B1+B2+C0 | 串 |
| **W3-C2** | gather.ts extend（artifact Q1 / question_block Q1+Q2 jsonb @>）+ `MaterializedSubjectKind` 加 'artifact' + backfill-genesis 扩两 entity | C1 | 串 |
| **W3-C3** | parity assert（assertArtifactParity / assertQuestionBlockParity + hasXGenesisAnchor 含 create-action）+ B4 交错收敛（fold 链 version 单调断言 + version-gap fail-loud + 交错序列 fold==row，F7）+ per-entity flag 两条 + audit:projection 扩 + db 测试 | C2 | 串 |
| **W3-D**（flip，非代码）| GATED cutover：rebuild prod-clone → audit per-entity CLEAN → `PROJECTION_IS_WRITER_ARTIFACT=1`（先）→ restart → 验证 → 再 question_block；**跨 wave：learning_item flip 在 artifact 之后** | C3 | owner-gated |

全 scope 完才 `Closes YUK-471` 对应 W3 子单；各增量 PR 用 `Refs`。

---

## 8. 诚实天花板（撤不掉的下游）

| 类别 | 例子 | 可撤? |
|---|---|---|
| 纯派生 projection | artifact body_blocks 内容、question_block structured 树 | ✅ 干净撤（fold 重算复原前态） |
| 实体行（带乐观锁） | artifact row、question_block row | ✅ 软删（`archived_at` / `status='ignored'`，物理列已在） |
| 既成事实（不可撤） | 用户已 `user_verified` 的块、真 attempt/review 引用的 artifact/question | ❌ 撤它 = 篡改用户真实历史 |

撤一个 artifact 编辑若级联触及已被真 attempt/review 引用的下游，遍历器（W0 `cascade.ts`）**停下告知**边界，不静默半撤。`user_verified` 块的 refine 在写闸即被硬边界挡在 A 档之外（§4.2 step 2）——撤的是「提议」不是「既成」。`crop_refs` 历史 stale 行（F5）backfill 后 fold==row 一致地 stale，是数据修复决策（§9.3），与 fold 正确性正交。

---

## 9. Owner 待拍（仅 STILL-OPEN 决策）

> **driver 已裁定的 5 个技术分叉（DECIDED，不再 open，全技术层）**：① Wave 2↔3 排序 = Wave 2 先（**已满足**，W2 全 merged）；② event.payload GIN 索引 = **加**（W3-C0）；③ crop_refs = 选 (b)，C1 同改 applyRescue + 在线写 crop_refs；④ artifact 入 index = **YES（与 W2 as-built 一致，推翻早期 readiness 裁定 #4「不入」）**；⑤ GenerateArtifact 双事件 = 保留 generate + 新 artifact_create、caused_by 串联、同 tx 保原子。以上不需 owner 再拍。

仍需 owner 决策：

1. **`GenerateArtifact` 是否最终也吸收 body_blocks 收口为单事件**？本稿保留 `generate`（业务意图/markdown）与 `artifact_create`（fold-source/body_blocks）**双事件并存**。单事件收口需合并 `generate` 的 `failure` 分支与 create 的「仅成功落行」语义，schema 复杂度上升——本 wave 不做，标 owner。
2. **`extracted_prompt_md` 何时 DROP**？parity 当前 omit 该 legacy 列（schema.ts:180）。DROP 由 legacy ingestion route 迁移完成驱动（Step 11.5），独立于 W3 的 follow-up，建议落 Linear 单。
3. **`applyRescue` crop_refs 历史 stale 数据是否一次性修复**？事件化 + applyRescue 在线改后新数据自动正确；backfill genesis 种的是当前（可能仍 stale）值，fold==row 仍成立。是否在 backfill PR 附带「重算 crop_refs 写回」是与 fold 正确性正交的 data-fix 决策。
4. **question_block 是否也入 materialized_id_index**？本稿为最小化让 question_block 走 event-表直查 anchor（与 artifact 入 index 形成唯一非对称）。若 owner 倾向全 entity 一致，可让 question_block 也入 index——纯一致性取舍，不影响正确性。

---

## 10. 验证 gate（落地前）

```bash
pnpm typecheck && pnpm lint
pnpm audit:schema && pnpm audit:partition && pnpm audit:profile && pnpm audit:draft-status
pnpm audit:projection      # Wave 3 扩 artifact + question_block 两表，零 drift
pnpm test                  # fold 黄金断言（core 单测）+ 写闸 DB 测试 + structured 5-op 覆盖
pnpm build
```

外加（非自动 gate，散文清单）：
- **新表登记 5 处对账（W3-C0）**：GIN 索引 = 写既有 `event` 表新 index，须过 `audit:schema` + migration smoke + `reference_new_pgtable_registration_surfaces` 5 处（schema / migration / audit:schema / export-constants FK_ORDER+SCHEMA_VERSION / db.ts ALL_TABLES——GIN 不新增表，但 migration DDL 须登记）。
- **parse-barrier honest-reject（B5）**：每新增 subject_kind（artifact / question_block）×3 reject 用例——错 subject_kind / 错 row shape / subject_id≠row.id。
- **B4 user_verified 硬边界回归断言**（ADR-0040 现零此断言，W3-B lane 必补）。
- **每写者收口独立 Opus reviewer 审 diff**；`job_events` 的 `block.structured_edited` 分支是否真删 = owner 决策（SSE 进度面消费核实后做删除验证，C2 范畴）。
- pre-flight：所有 edit（含委派 agent + biome --write）后跑全量 `pnpm typecheck` + biome + targeted（import 受影响文件的全部测试）；CI 是权威闸。

---

## 11. Linear 捕获

- 本文是 **YUK-471 epic 内 Wave 3 的实施设计**，归档进 YUK-471（贴评论或转 ADR-0044 落地注），**无需新建顶层 issue**。
- **建议在 YUK-471 下拆 Wave 3 子任务**对应 §7 lane（W3-A1/A2/B1/B2/C0/C1/C2/C3/D），全 `Refs YUK-471`，全 scope 完才 `Closes`。
- **合流登记**：YUK-358（笔记域 re-think / ADR-0040）的 §1 统一撤销 + §5 history 合一 **由本 Wave 3 的 event-sourcing 兑现**——应在 YUK-358 标注「实施合流进 YUK-471 Wave 3，不单独造 artifact 写契约」，避免两 epic 平行造写面。
- **owner-决策 follow-up（§9.2 / §9.3）**：`extracted_prompt_md` DROP + `crop_refs` 历史数据修复，若 owner 确认要做，各开一条 `Refs YUK-471` 子单。
- **~~Wave 2 缺口~~**（旧稿条目，**已删除**）：goal/mistake_variant/learning_item fold 已于 W2（#595/#603/#604）全部 merged，不再是缺口。

---

> **本稿是 YUK-471 Wave 3 的 CANONICAL 设计，OVERRIDE 全部前序 W3 草稿**（`2026-06-25-yuk471-wave3-artifact-question-block-fold.md` / `-CORRECTED.md` / PR #602 body）。所有坐标已对 main @ 27a0cf08 复核（post-W2-merge），5 条 fork 决策已由 W2 as-built 实证。
